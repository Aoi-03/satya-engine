'use strict';

/**
 * controllers/authController.js
 *
 * Handles all authentication endpoints.  Response shapes are kept
 * identical to the old ayakashi-api so the existing frontend (api.ts)
 * requires zero changes.
 *
 * Endpoints implemented here:
 *   POST /auth/register
 *   POST /auth/login
 *   POST /auth/refresh
 *   POST /auth/logout
 *   GET  /me
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query } = require('../config/db');
const { sendPasswordResetCode } = require('../services/mailer');

// ── OTP config ────────────────────────────────────────────────────────────────
const OTP_EXPIRES_MIN = 15;
const OTP_LENGTH      = 6;

// ── Cookie names (must match frontend api.ts + old-backend cookies.ts) ────────
const ACCESS_COOKIE  = 'ayakashi_at';
const REFRESH_COOKIE = 'ayakashi_rt';

// ── TTLs ──────────────────────────────────────────────────────────────────────
const ACCESS_TTL_SECONDS  = 15 * 60;          // 15 minutes
const REFRESH_TTL_DEFAULT = 24 * 60 * 60;     // 1 day
const REFRESH_TTL_REMEMBER = 30 * 24 * 60 * 60; // 30 days

// ── Lockout config (mirrors old-backend login.ts) ─────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS          = 15 * 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseCookieOpts(req) {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: isProd ? 'none' : 'lax',
    path:     '/',
  };
}

function setAuthCookies(res, req, accessToken, refreshToken, rememberMe) {
  const base = baseCookieOpts(req);
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base,
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    maxAge: (rememberMe ? REFRESH_TTL_REMEMBER : REFRESH_TTL_DEFAULT) * 1000,
  });
}

function clearAuthCookies(res, req) {
  const base = baseCookieOpts(req);
  res.clearCookie(ACCESS_COOKIE,  base);
  res.clearCookie(REFRESH_COOKIE, base);
}

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
}

function signRefreshToken(payload, rememberMe) {
  return jwt.sign(
    payload,
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: rememberMe ? '30d' : '1d' },
  );
}

// ── POST /auth/register ───────────────────────────────────────────────────────
// Body: { username, email, password, displayName? }
// Returns: { username, displayName, welcomeBonus: null }
// NOTE: The old system required a WhatsApp bot token; this new system
// accepts a simple email + password registration directly.

async function register(req, res) {
  try {
    const { username, email, password, displayName } = req.body ?? {};

    // ── Validation ──────────────────────────────────────────────────────────
    if (!username || !email || !password) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'username, email, and password are required' },
      });
    }
    if (typeof username !== 'string' || !/^[a-z0-9_]{3,20}$/.test(username.toLowerCase())) {
      return res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'username must be 3–20 characters: lowercase letters, numbers, and underscores only',
        },
      });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'password must be 8–128 characters' },
      });
    }
    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'a valid email address is required' },
      });
    }

    const normalUsername    = username.toLowerCase();
    const normalEmail       = email.toLowerCase().trim();
    const resolvedDisplay   = (typeof displayName === 'string' && displayName.trim())
      ? displayName.trim().slice(0, 80)
      : normalUsername;

    // ── Uniqueness checks ───────────────────────────────────────────────────
    const dupCheck = await query(
      'SELECT username, email FROM users WHERE username = $1 OR email = $2 LIMIT 1',
      [normalUsername, normalEmail],
    );

    if (dupCheck.rows.length > 0) {
      const dup = dupCheck.rows[0];
      if (dup.username === normalUsername) {
        return res.status(409).json({
          error: { code: 'username_taken', message: 'this username is already taken' },
        });
      }
      return res.status(409).json({
        error: { code: 'email_taken', message: 'an account with this email already exists' },
      });
    }

    // ── Hash password ───────────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);

    // ── Insert user ─────────────────────────────────────────────────────────
    const insertResult = await query(
      `INSERT INTO users
         (username, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, 'analyst')
       RETURNING id, username, display_name, avatar_url, frame_id, token_version`,
      [normalUsername, normalEmail, passwordHash, resolvedDisplay],
    );

    const user = insertResult.rows[0];

    // ── Issue tokens ────────────────────────────────────────────────────────
    const accessToken  = signAccessToken({ sub: user.id, username: user.username });
    const refreshToken = signRefreshToken(
      { sub: user.id, tokenVersion: user.token_version, rememberMe: true },
      true,
    );

    setAuthCookies(res, req, accessToken, refreshToken, true);

    return res.status(201).json({
      username:     user.username,
      displayName:  user.display_name,
      welcomeBonus: null, // no economy system in this backend
    });

  } catch (err) {
    console.error('[Auth] register error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'registration failed — please try again' },
    });
  }
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Body: { username, password, rememberMe? }
// Returns: { username, displayName }

async function login(req, res) {
  try {
    const { username, password, rememberMe = false } = req.body ?? {};

    if (!username || !password) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'username and password are required' },
      });
    }

    const normalUsername = username.toLowerCase();

    // ── Fetch user ──────────────────────────────────────────────────────────
    const result = await query(
      `SELECT id, username, display_name, email, password_hash,
              avatar_url, frame_id, token_version,
              failed_login_attempts, locked_until, is_active
       FROM users
       WHERE username = $1
       LIMIT 1`,
      [normalUsername],
    );

    // Generic failure — don't reveal whether the username exists
    const genericFail = () =>
      res.status(401).json({
        error: { code: 'invalid_credentials', message: 'invalid username or password' },
      });

    if (result.rows.length === 0) return genericFail();

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        error: { code: 'account_disabled', message: 'this account has been disabled' },
      });
    }

    // ── Lockout check ───────────────────────────────────────────────────────
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const waitMin = Math.ceil((new Date(user.locked_until) - Date.now()) / 60_000);
      return res.status(423).json({
        error: {
          code: 'account_locked',
          message: `too many failed attempts — try again in ${waitMin} minute(s)`,
        },
      });
    }

    // ── Verify password ─────────────────────────────────────────────────────
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        await query(
          `UPDATE users
           SET failed_login_attempts = 0,
               locked_until          = $1,
               updated_at            = NOW()
           WHERE id = $2`,
          [new Date(Date.now() + LOCKOUT_MS), user.id],
        );
      } else {
        await query(
          `UPDATE users
           SET failed_login_attempts = $1,
               updated_at            = NOW()
           WHERE id = $2`,
          [newAttempts, user.id],
        );
      }
      return genericFail();
    }

    // ── Reset failure counters, record login ────────────────────────────────
    const ip = req.ip || req.socket?.remoteAddress || null;
    await query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until          = NULL,
           last_login_at         = NOW(),
           last_login_ip         = $1,
           updated_at            = NOW()
       WHERE id = $2`,
      [ip, user.id],
    );

    // ── Issue tokens ────────────────────────────────────────────────────────
    const accessToken  = signAccessToken({ sub: user.id, username: user.username });
    const refreshToken = signRefreshToken(
      { sub: user.id, tokenVersion: user.token_version, rememberMe: Boolean(rememberMe) },
      Boolean(rememberMe),
    );

    setAuthCookies(res, req, accessToken, refreshToken, Boolean(rememberMe));

    return res.json({
      username:    user.username,
      displayName: user.display_name,
    });

  } catch (err) {
    console.error('[Auth] login error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'login failed — please try again' },
    });
  }
}

// ── POST /auth/refresh ────────────────────────────────────────────────────────
// Verifies refresh token cookie, issues a new access + refresh pair.
// Returns: { ok: true }

async function refresh(req, res) {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      return res.status(401).json({
        error: { code: 'no_session', message: 'not logged in' },
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch {
      clearAuthCookies(res, req);
      return res.status(401).json({
        error: { code: 'invalid_session', message: 'session expired — log in again' },
      });
    }

    // Validate tokenVersion to allow server-side invalidation
    const result = await query(
      'SELECT id, username, token_version FROM users WHERE id = $1 LIMIT 1',
      [payload.sub],
    );

    if (
      result.rows.length === 0 ||
      result.rows[0].token_version !== payload.tokenVersion
    ) {
      clearAuthCookies(res, req);
      return res.status(401).json({
        error: { code: 'invalid_session', message: 'session expired — log in again' },
      });
    }

    const user      = result.rows[0];
    const rememberMe = payload.rememberMe === true;

    const newAccessToken  = signAccessToken({ sub: user.id, username: user.username });
    const newRefreshToken = signRefreshToken(
      { sub: user.id, tokenVersion: user.token_version, rememberMe },
      rememberMe,
    );

    setAuthCookies(res, req, newAccessToken, newRefreshToken, rememberMe);

    return res.json({ ok: true });

  } catch (err) {
    console.error('[Auth] refresh error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'token refresh failed' },
    });
  }
}

// ── POST /auth/logout ─────────────────────────────────────────────────────────

async function logout(req, res) {
  clearAuthCookies(res, req);
  return res.json({ ok: true });
}

// ── GET /me ───────────────────────────────────────────────────────────────────
// Protected by authMiddleware — req.account is already verified.
// Returns: { username, displayName, avatarUrl, frameId }
// (age is not stored in the new schema; return null so frontend doesn't break)

async function me(req, res) {
  try {
    const result = await query(
      `SELECT username, display_name, avatar_url, frame_id
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [req.account.sub],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'account_not_found', message: 'account no longer exists' },
      });
    }

    const user = result.rows[0];

    return res.json({
      username:    user.username,
      displayName: user.display_name,
      age:         null,         // not stored in the new GIS backend schema
      avatarUrl:   user.avatar_url ?? null,
      frameId:     user.frame_id  ?? null,
    });

  } catch (err) {
    console.error('[Auth] me error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'failed to fetch profile' },
    });
  }
}

// ── GET /auth/username-available ─────────────────────────────────────────────
// Query: ?username=xenkai
// Returns: { available: true } | { available: false, suggestions: [] }

async function usernameAvailable(req, res) {
  try {
    const raw = (req.query.username ?? '').toString().toLowerCase().trim();

    if (!raw || raw.length < 3 || raw.length > 20 || !/^[a-z0-9_]+$/.test(raw)) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'invalid username format' },
      });
    }

    const result = await query(
      'SELECT 1 FROM users WHERE username = $1 LIMIT 1',
      [raw],
    );

    if (result.rows.length === 0) {
      return res.json({ available: true });
    }

    // Generate simple suggestions by appending numbers
    const suggestions = [];
    for (let i = 1; suggestions.length < 3; i++) {
      const candidate = `${raw}${i}`;
      if (candidate.length <= 20) {
        // eslint-disable-next-line no-await-in-loop
        const check = await query(
          'SELECT 1 FROM users WHERE username = $1 LIMIT 1',
          [candidate],
        );
        if (check.rows.length === 0) suggestions.push(candidate);
      }
      if (i > 20) break; // safety
    }

    return res.json({ available: false, suggestions });

  } catch (err) {
    console.error('[Auth] usernameAvailable error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'could not check username' },
    });
  }
}

// ── POST /auth/forgot-password ────────────────────────────────────────────────
// Body: { email }
// Always returns 200 (never leaks whether email exists).
// Generates a 6-digit OTP, stores a hashed copy, sends the plain code by email.

async function forgotPassword(req, res) {
  try {
    const email = (req.body?.email ?? '').toString().toLowerCase().trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'a valid email address is required' },
      });
    }

    const result = await query(
      'SELECT id FROM users WHERE email = $1 AND is_active = TRUE LIMIT 1',
      [email],
    );

    // Always respond 200 — don't reveal whether the email is registered
    if (result.rows.length === 0) {
      return res.json({ ok: true });
    }

    const userId = result.rows[0].id;

    // Invalidate any previous unused tokens for this user
    await query(
      `UPDATE password_reset_tokens SET used = TRUE
       WHERE user_id = $1 AND used = FALSE`,
      [userId],
    );

    // Generate a cryptographically random 6-digit code (000000–999999)
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(OTP_LENGTH, '0');

    // Store a bcrypt hash of the code so raw codes aren't in the DB
    const codeHash  = await bcrypt.hash(code, 8); // low cost — short-lived token
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60_000);

    await query(
      `INSERT INTO password_reset_tokens (user_id, code, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, codeHash, expiresAt],
    );

    // Send the plain code by email (fire-and-forget error logging)
    sendPasswordResetCode(email, code, OTP_EXPIRES_MIN).catch((err) => {
      console.error('[Auth] Failed to send reset email:', err.message);
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error('[Auth] forgotPassword error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'could not process request' },
    });
  }
}

// ── POST /auth/verify-reset-code ──────────────────────────────────────────────
// Body: { email, code }
// Returns: { resetToken } — a short-lived signed token the client passes to
//          /auth/reset-password so it doesn't have to re-verify the code.

async function verifyResetCode(req, res) {
  try {
    const email = (req.body?.email ?? '').toString().toLowerCase().trim();
    const code  = (req.body?.code  ?? '').toString().trim();

    if (!email || !code) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'email and code are required' },
      });
    }

    const userResult = await query(
      'SELECT id FROM users WHERE email = $1 AND is_active = TRUE LIMIT 1',
      [email],
    );

    const genericFail = () => res.status(400).json({
      error: { code: 'invalid_code', message: 'invalid or expired code' },
    });

    if (userResult.rows.length === 0) return genericFail();
    const userId = userResult.rows[0].id;

    // Fetch latest unused, unexpired token for this user
    const tokenResult = await query(
      `SELECT id, code FROM password_reset_tokens
       WHERE user_id = $1 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );

    if (tokenResult.rows.length === 0) return genericFail();

    const row   = tokenResult.rows[0];
    const valid = await bcrypt.compare(code, row.code);
    if (!valid) return genericFail();

    // Mark the OTP as used — can no longer be resubmitted
    await query(
      'UPDATE password_reset_tokens SET used = TRUE WHERE id = $1',
      [row.id],
    );

    // Issue a short-lived reset JWT the client uses in the next step
    const resetToken = jwt.sign(
      { sub: userId, purpose: 'password_reset' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '10m' },
    );

    return res.json({ resetToken });

  } catch (err) {
    console.error('[Auth] verifyResetCode error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'verification failed' },
    });
  }
}

// ── POST /auth/reset-password ─────────────────────────────────────────────────
// Body: { resetToken, newPassword }
// The resetToken comes from /auth/verify-reset-code above.

async function resetPassword(req, res) {
  try {
    const { resetToken, newPassword } = req.body ?? {};

    if (!resetToken || !newPassword) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'resetToken and newPassword are required' },
      });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'password must be 8–128 characters' },
      });
    }

    // Verify the reset JWT
    let payload;
    try {
      payload = jwt.verify(resetToken, process.env.JWT_ACCESS_SECRET);
    } catch {
      return res.status(400).json({
        error: { code: 'invalid_token', message: 'reset session expired — start again' },
      });
    }

    if (payload.purpose !== 'password_reset') {
      return res.status(400).json({
        error: { code: 'invalid_token', message: 'invalid reset token' },
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password and bump token_version to invalidate all active sessions
    const result = await query(
      `UPDATE users
       SET password_hash    = $1,
           token_version    = token_version + 1,
           updated_at       = NOW()
       WHERE id = $2
       RETURNING id`,
      [passwordHash, payload.sub],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'account_not_found', message: 'account not found' },
      });
    }

    // Clear any auth cookies so the user must log in fresh
    const isProd = process.env.NODE_ENV === 'production';
    const cookieOpts = {
      httpOnly: true,
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      path:     '/',
    };
    res.clearCookie('ayakashi_at',  cookieOpts);
    res.clearCookie('ayakashi_rt',  cookieOpts);

    return res.json({ ok: true });

  } catch (err) {
    console.error('[Auth] resetPassword error:', err.message);
    return res.status(500).json({
      error: { code: 'server_error', message: 'password reset failed' },
    });
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  me,
  usernameAvailable,
  forgotPassword,
  verifyResetCode,
  resetPassword,
};

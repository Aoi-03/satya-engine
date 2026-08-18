'use strict';

/**
 * middleware/authMiddleware.js
 *
 * Verifies the ayakashi_at access token from the httpOnly cookie.
 * Mirrors the behaviour of the old-backend's authGuard.ts exactly:
 *   - missing cookie  → 401 unauthenticated
 *   - bad/expired JWT → 401 invalid_token  (frontend auto-refreshes on this code)
 *
 * Attaches decoded payload to req.account: { sub, username }
 */

const jwt = require('jsonwebtoken');

const ACCESS_COOKIE = 'ayakashi_at';

function authMiddleware(req, res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];

  if (!token) {
    return res.status(401).json({
      error: { code: 'unauthenticated', message: 'log in required' },
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.account = payload; // { sub, username, iat, exp }
    next();
  } catch {
    return res.status(401).json({
      error: { code: 'invalid_token', message: 'session expired — refresh or log in again' },
    });
  }
}

module.exports = { authMiddleware };

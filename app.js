'use strict';

/**
 * app.js
 * Express application setup.
 * Configures middleware, mounts routes, and handles errors.
 */

require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const helmet         = require('helmet');
const morgan         = require('morgan');
const cookieParser   = require('cookie-parser');

const analyticsRoutes = require('./routes/analyticsRoutes');
const alertsRoutes    = require('./routes/alertsRoutes');
const authRoutes      = require('./routes/authRoutes');
const regionsRoutes   = require('./routes/regionsRoutes');
const researchRoutes  = require('./routes/researchRoutes');

const app = express();

// ─── Security Middleware ──────────────────────────────────────────────────────

app.use(helmet());

// trust first proxy so req.ip resolves correctly behind nginx / Supabase edge
app.set('trust proxy', 1);

// CORS — supports multiple comma-separated origins in CORS_ORIGIN env var,
// e.g. "https://my-app.vercel.app,https://my-app.railway.app"
// When CORS_ORIGIN is not set (local dev without .env), allow any origin.
const CORS_ORIGINS = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : true;

console.log('[CORS] Allowed origins:', CORS_ORIGINS === true ? '*' : CORS_ORIGINS);

app.use(cors({
  origin(requestOrigin, callback) {
    // Allow requests with no origin (server-to-server, Postman, curl)
    if (!requestOrigin) return callback(null, true);
    // If CORS_ORIGINS is true (wildcard) allow everything
    if (CORS_ORIGINS === true) return callback(null, true);
    if (CORS_ORIGINS.includes(requestOrigin)) return callback(null, true);
    callback(new Error(`CORS: origin '${requestOrigin}' not allowed`));
  },
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    true,
}));

// ─── Cookie Parser ────────────────────────────────────────────────────────────
// Must come BEFORE any route handler that reads req.cookies

app.use(cookieParser());

// ─── Request Parsing ──────────────────────────────────────────────────────────

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ─── HTTP Request Logging ─────────────────────────────────────────────────────

const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat));

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.status(200).json({
    status:    'ok',
    service:   'Satellite Environmental Analytics API',
    timestamp: new Date().toISOString(),
    version:   process.env.npm_package_version || '1.0.0',
  });
});

// ─── Compatibility stubs (called by legacy frontend pages) ────────────────────

// Landing page & login page fetch this for the player-count stat bar.
// Return the count of registered users from the users table.
app.get('/home/stats', async (_req, res) => {
  try {
    const { query } = require('./config/db');
    const result = await query('SELECT COUNT(*) AS total FROM users WHERE is_active = TRUE');
    const total  = parseInt(result.rows[0].total, 10) || 0;
    res.json({
      totalPlayers:       total,
      totalCardsClaimed:  0,
      totalCardsInCatalog: 0,
    });
  } catch {
    res.json({ totalPlayers: 0, totalCardsClaimed: 0, totalCardsInCatalog: 0 });
  }
});

// CurrencyContext + upgrade page call GET /dashboard. The new backend
// has no economy system — return a minimal shape so callers don't crash.
app.get('/dashboard', (req, res) => {
  res.json({
    identity:   null,
    currency:   { ryo: 0, kitsu: 0, bank: 0, bankCap: 0, bankVaultTier: 0 },
    vault:      null,
    progression: { xp: 0, level: 1 },
    dailyClaim: { available: false, remainingMs: 0, currentStreak: 0, streakWillContinueIfClaimedNow: false },
    cardsOwned: 0,
    recentTransactions: [],
    pendingFriendRequests: { count: 0, requests: [] },
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// Auth routes are registered at two prefixes:
//   /api/auth/register, /api/auth/login, /api/auth/refresh, /api/auth/logout
//   /me  (GET — used by frontend's getMe())
app.use('/api',  authRoutes);   // covers /api/auth/* and /api/me (unused — see below)
app.use('/',     authRoutes);   // covers top-level /me and /auth/* (legacy path)

app.use('/api/analytics', analyticsRoutes);
app.use('/api/alerts',    alertsRoutes);
app.use('/api/regions',   regionsRoutes);
app.use('/api/research',  researchRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;

  console.error(`[ERROR] ${req.method} ${req.originalUrl} → ${status}: ${err.message}`);
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  res.status(status).json({
    success: false,
    error: {
      code:    err.code    || 'server_error',
      message: err.message || 'An unexpected error occurred',
    },
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;

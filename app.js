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

const analyticsRoutes = require('./routes/analyticsRoutes');
const alertsRoutes    = require('./routes/alertsRoutes');

const app = express();

// ─── Security Middleware ──────────────────────────────────────────────────────

app.use(helmet()); // Sets secure HTTP headers

app.use(cors({
  origin:      process.env.CORS_ORIGIN || '*',
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

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

// ─── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/analytics', analyticsRoutes);
app.use('/api/alerts',    alertsRoutes);

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
    message: err.message || 'An unexpected error occurred',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;

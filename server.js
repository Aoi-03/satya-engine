'use strict';

/**
 * server.js
 * Application entry point.
 * Boots the Express server and connects to the database.
 *
 * Start with: npm run start
 * Dev mode:   npm run dev
 */

require('dotenv').config();

const app   = require('./app');
const { pool } = require('./config/db');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  try {
    // ── Start HTTP server first — don't block on DB ───────────
    // DB connection is verified lazily on first request.
    // This prevents hostel/firewall network timeouts from crashing startup.
    const server = app.listen(PORT, HOST, () => {
      console.log('\n╔════════════════════════════════════════════╗');
      console.log('║  Satellite Environmental Analytics API     ║');
      console.log('╠════════════════════════════════════════════╣');
      console.log(`║  Server  : http://${HOST}:${PORT.toString().padEnd(17)}║`);
      console.log(`║  Env     : ${(process.env.NODE_ENV || 'development').padEnd(32)}║`);
      console.log('╠════════════════════════════════════════════╣');
      console.log('║  Endpoints:                                ║');
      console.log('║  GET  /health                              ║');
      console.log('║  POST /api/analytics/process               ║');
      console.log('║  GET  /api/analytics/region/:id/timeseries ║');
      console.log('║  GET  /api/alerts/active                   ║');
      console.log('║  GET  /api/alerts/:id                      ║');
      console.log('╚════════════════════════════════════════════╝\n');
    });

    // ── DB connects lazily on first query — no startup ping needed ──
    console.log('[Server] Database pool initialized (connects on first query).');

    // ── Graceful shutdown ─────────────────────────────────────
    const shutdown = (signal) => {
      console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
      server.close(async () => {
        await pool.end();
        console.log('[Server] Database pool closed. Bye.');
        process.exit(0);
      });

      // Force-kill if graceful shutdown takes too long
      setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      console.error('[Server] Unhandled Promise Rejection:', reason);
    });

    process.on('uncaughtException', (err) => {
      console.error('[Server] Uncaught Exception:', err.message);
      process.exit(1);
    });

  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
}

startServer();

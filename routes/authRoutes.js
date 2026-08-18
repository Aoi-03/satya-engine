'use strict';

/**
 * routes/authRoutes.js
 *
 * Mounts all authentication endpoints.
 * Route prefix is applied in app.js:
 *   app.use('/api', authRoutes)   → /api/auth/...
 *   app.use('/me',  authRoutes)   → /me
 */

const { Router } = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  register,
  login,
  refresh,
  logout,
  me,
  usernameAvailable,
  forgotPassword,
  verifyResetCode,
  resetPassword,
} = require('../controllers/authController');

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.post('/auth/register',           register);
router.post('/auth/login',              login);
router.post('/auth/refresh',            refresh);
router.post('/auth/logout',             logout);
router.get( '/auth/username-available', usernameAvailable);
router.post('/auth/forgot-password',    forgotPassword);
router.post('/auth/verify-reset-code',  verifyResetCode);
router.post('/auth/reset-password',     resetPassword);

// ── Protected ─────────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, me);

module.exports = router;

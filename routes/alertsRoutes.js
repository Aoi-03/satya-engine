'use strict';

/**
 * alertsRoutes.js
 * Mounts all alert endpoints under /api/alerts
 */

const { Router }     = require('express');
const { param, query } = require('express-validator');
const {
  getActiveAlerts,
  getAlertById,
} = require('../controllers/alertsController');

const router = Router();

// ─── Validation schemas ───────────────────────────────────────────────────────

const activeAlertsValidation = [
  query('severity')
    .optional()
    .isIn(['low', 'medium', 'critical'])
    .withMessage('severity must be one of: low, medium, critical'),
  query('state')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage('state must be a non-empty string (max 120 chars)'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('limit must be between 1 and 200'),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('offset must be >= 0'),
];

const alertByIdValidation = [
  param('id')
    .isUUID()
    .withMessage('Alert id must be a valid UUID'),
];

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/alerts/active
 * @desc    Returns all regions where an anomaly was detected (most recent per region)
 *          Optional filters: ?severity=critical&state=Maharashtra
 * @access  Public
 */
router.get('/active', activeAlertsValidation, getActiveAlerts);

/**
 * @route   GET /api/alerts/:id
 * @desc    Full detail for a single analytics log alert entry
 * @access  Public
 */
router.get('/:id', alertByIdValidation, getAlertById);

module.exports = router;

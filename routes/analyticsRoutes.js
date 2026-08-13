'use strict';

/**
 * analyticsRoutes.js
 * Mounts all analytics endpoints under /api/analytics
 */

const { Router }            = require('express');
const { body, param, query } = require('express-validator');
const {
  processAnalytics,
  getTimeseries,
} = require('../controllers/analyticsController');

const router = Router();

// ─── Validation schemas ───────────────────────────────────────────────────────

const bandSchema = (prefix) => [
  body(`${prefix}.nir`)
    .isFloat({ min: 0, max: 1 })
    .withMessage(`${prefix}.nir must be a float between 0 and 1`),
  body(`${prefix}.red`)
    .isFloat({ min: 0, max: 1 })
    .withMessage(`${prefix}.red must be a float between 0 and 1`),
  body(`${prefix}.swir`)
    .isFloat({ min: 0, max: 1 })
    .withMessage(`${prefix}.swir must be a float between 0 and 1`),
  body(`${prefix}.sarIntensity`)
    .isFloat({ min: 0 })
    .withMessage(`${prefix}.sarIntensity must be a non-negative float`),
];

const processValidation = [
  body('region_id')
    .isUUID()
    .withMessage('region_id must be a valid UUID'),
  body('t1')
    .isISO8601()
    .withMessage('t1 must be a valid ISO 8601 timestamp'),
  body('t2')
    .isISO8601()
    .withMessage('t2 must be a valid ISO 8601 timestamp')
    .custom((t2, { req }) => {
      if (new Date(t2) <= new Date(req.body.t1)) {
        throw new Error('t2 must be after t1');
      }
      return true;
    }),
  ...bandSchema('t1_bands'),
  ...bandSchema('t2_bands'),

  // Optional bounding box
  body('bounding_box.minLng').optional().isFloat({ min: -180, max: 180 }),
  body('bounding_box.maxLng').optional().isFloat({ min: -180, max: 180 }),
  body('bounding_box.minLat').optional().isFloat({ min: -90,  max: 90 }),
  body('bounding_box.maxLat').optional().isFloat({ min: -90,  max: 90 }),
];

const timeseriesValidation = [
  param('id')
    .isUUID()
    .withMessage('Region id must be a valid UUID'),
  query('from_month')
    .optional()
    .isInt({ min: 1, max: 12 })
    .withMessage('from_month must be between 1 and 12'),
  query('from_year')
    .optional()
    .isInt({ min: 2000, max: 2100 })
    .withMessage('from_year must be a valid 4-digit year'),
  query('to_month')
    .optional()
    .isInt({ min: 1, max: 12 })
    .withMessage('to_month must be between 1 and 12'),
  query('to_year')
    .optional()
    .isInt({ min: 2000, max: 2100 })
    .withMessage('to_year must be a valid 4-digit year'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 500 })
    .withMessage('limit must be between 1 and 500'),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('offset must be >= 0'),
];

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @route   POST /api/analytics/process
 * @desc    Process satellite band data between T1 and T2, save to analytics_log
 * @access  Public (add auth middleware when ready)
 */
router.post('/process', processValidation, processAnalytics);

/**
 * @route   GET /api/analytics/region/:id/timeseries
 * @desc    Fetch historical NDVI/NDWI trends for a region over a date range
 * @access  Public
 */
router.get('/region/:id/timeseries', timeseriesValidation, getTimeseries);

module.exports = router;

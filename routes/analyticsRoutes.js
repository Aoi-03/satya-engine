'use strict';

/**
 * analyticsRoutes.js
 * Mounts all analytics endpoints under /api/analytics
 *
 * POST /process — t1_bands / t2_bands are now OPTIONAL.
 *   If omitted AND GEE is configured, the controller will call Google Earth
 *   Engine to fetch real Sentinel-2 median composite band values for the
 *   supplied geojson_polygon.
 *   If not omitted, the manually supplied values are used as-is (useful for
 *   testing or when GEE is not configured).
 */

const { Router }             = require('express');
const { body, param, query } = require('express-validator');
const {
  processAnalytics,
  getTimeseries,
} = require('../controllers/analyticsController');

const router = Router();

// ─── Reusable band schema (now optional) ──────────────────────────────────────

const bandSchema = (prefix) => [
  body(`${prefix}.nir`)
    .optional()
    .isFloat({ min: 0, max: 1 })
    .withMessage(`${prefix}.nir must be a float between 0 and 1`),
  body(`${prefix}.red`)
    .optional()
    .isFloat({ min: 0, max: 1 })
    .withMessage(`${prefix}.red must be a float between 0 and 1`),
  body(`${prefix}.swir`)
    .optional()
    .isFloat({ min: 0, max: 1 })
    .withMessage(`${prefix}.swir must be a float between 0 and 1`),
  body(`${prefix}.sarIntensity`)
    .optional()
    .isFloat({ min: 0 })
    .withMessage(`${prefix}.sarIntensity must be a non-negative float`),
];

// ─── Process validation ───────────────────────────────────────────────────────

const processValidation = [
  // Required: which region to record the result against
  body('region_id')
    .isUUID()
    .withMessage('region_id must be a valid UUID'),

  // Required: time window
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

  // Optional: GeoJSON polygon OR raw coordinate ring [[lng,lat],...]
  // Used for GEE band extraction when t1_bands/t2_bands are not supplied.
  body('geojson_polygon')
    .optional()
    .custom((val) => {
      if (typeof val !== 'object' && !Array.isArray(val)) {
        throw new Error('geojson_polygon must be a GeoJSON geometry object or coordinate array');
      }
      return true;
    }),

  // Optional manual band overrides (skips GEE when both are present)
  ...bandSchema('t1_bands'),
  ...bandSchema('t2_bands'),

  // Optional bounding box (used for PostGIS intersection check only)
  body('bounding_box.minLng').optional().isFloat({ min: -180, max: 180 }),
  body('bounding_box.maxLng').optional().isFloat({ min: -180, max: 180 }),
  body('bounding_box.minLat').optional().isFloat({ min: -90,  max: 90  }),
  body('bounding_box.maxLat').optional().isFloat({ min: -90,  max: 90  }),
];

// ─── Timeseries validation (unchanged) ───────────────────────────────────────

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
 * @desc    Process satellite analysis for a region.
 *          Band values are fetched from GEE if not supplied manually.
 * @access  Public (add authMiddleware when ready)
 */
router.post('/process', processValidation, processAnalytics);

/**
 * @route   GET /api/analytics/region/:id/timeseries
 * @desc    Historical NDVI/NDWI trends for a region
 * @access  Public
 */
router.get('/region/:id/timeseries', timeseriesValidation, getTimeseries);

module.exports = router;

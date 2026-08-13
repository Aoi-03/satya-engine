'use strict';

/**
 * analyticsController.js
 *
 * Handles all analytics-related API logic:
 *   POST /api/analytics/process         — run analysis between T1 and T2 for a bounding box
 *   GET  /api/analytics/region/:id/timeseries — historical trends for a region
 */

const { query }          = require('../config/db');
const { runCombinedAnalysis } = require('../services/geoEngine');
const { validationResult }   = require('express-validator');

// ─── POST /api/analytics/process ─────────────────────────────────────────────

/**
 * Process satellite analytics for a geographic bounding box between two timestamps.
 *
 * Request body:
 * {
 *   "region_id": "uuid",
 *   "t1": "2024-01-01T00:00:00Z",
 *   "t2": "2024-06-01T00:00:00Z",
 *   "t1_bands": { "nir": 0.6, "red": 0.1, "swir": 0.2, "sarIntensity": 0.05 },
 *   "t2_bands": { "nir": 0.3, "red": 0.2, "swir": 0.4, "sarIntensity": 0.02 },
 *   "bounding_box": {
 *     "minLng": 72.0, "minLat": 18.0, "maxLng": 73.0, "maxLat": 19.0
 *   }
 * }
 */
async function processAnalytics(req, res) {
  // ── Validation errors ──────────────────────────────────────
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors:  errors.array(),
    });
  }

  const { region_id, t1, t2, t1_bands, t2_bands, bounding_box } = req.body;

  try {
    // ── Verify region exists ─────────────────────────────────
    const regionCheck = await query(
      `SELECT id, region_name, state FROM regions_of_interest WHERE id = $1`,
      [region_id]
    );

    if (regionCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: `Region with id "${region_id}" not found`,
      });
    }

    const region = regionCheck.rows[0];

    // ── Validate bounding box intersects region ──────────────
    if (bounding_box) {
      const { minLng, minLat, maxLng, maxLat } = bounding_box;
      const intersectResult = await query(
        `SELECT ST_Intersects(
            coordinates,
            ST_MakeEnvelope($1, $2, $3, $4, 4326)
          ) AS intersects
          FROM regions_of_interest
          WHERE id = $5`,
        [minLng, minLat, maxLng, maxLat, region_id]
      );

      if (!intersectResult.rows[0]?.intersects) {
        return res.status(400).json({
          success: false,
          message: 'Provided bounding box does not intersect the specified region',
        });
      }
    }

    // ── Run combined geo analysis ────────────────────────────
    const analysis = runCombinedAnalysis(t1_bands, t2_bands);

    // ── Persist to analytics_log ─────────────────────────────
    const insertSQL = `
      INSERT INTO analytics_log (
        region_id,
        timestamp,
        ndvi_score,
        ndvi_delta,
        ndwi_score,
        ndwi_delta,
        sar_backscatter,
        sar_delta_db,
        anomaly_detected,
        alert_severity,
        flags,
        raw_bands
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;

    const insertValues = [
      region_id,
      t2,                                        // log at T2 (the "current" snapshot)
      analysis.indices.ndvi.t2.value,
      analysis.indices.ndvi.delta,
      analysis.indices.ndwi.t2.value,
      analysis.indices.ndwi.delta,
      analysis.indices.sar.t2_db,
      analysis.indices.sar.delta_db,
      analysis.anomalyDetected,
      analysis.alertSeverity,
      JSON.stringify(analysis.flags),
      JSON.stringify({ t1: t1_bands, t2: t2_bands }),
    ];

    const insertResult = await query(insertSQL, insertValues);
    const savedLog     = insertResult.rows[0];

    // ── Award contribution points if anomaly found ───────────
    if (analysis.anomalyDetected && req.user?.id) {
      await query(
        `UPDATE users SET contribution_points = contribution_points + 10 WHERE id = $1`,
        [req.user.id]
      );
    }

    // ── Response ─────────────────────────────────────────────
    return res.status(201).json({
      success:  true,
      message:  'Analytics processed and saved successfully',
      log_id:   savedLog.id,
      region: {
        id:          region.id,
        region_name: region.region_name,
        state:       region.state,
      },
      period: { t1, t2 },
      analysis,
    });
  } catch (err) {
    console.error('[analyticsController] processAnalytics error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while processing analytics',
      ...(process.env.NODE_ENV === 'development' && { detail: err.message }),
    });
  }
}

// ─── GET /api/analytics/region/:id/timeseries ─────────────────────────────────

/**
 * Fetch historical vegetation and humidity time-series for a region.
 *
 * Query params:
 *   from_month: "01"   (1–12)
 *   from_year:  "2023"
 *   to_month:   "12"
 *   to_year:    "2024"
 *   limit:      100    (default)
 *   offset:     0      (default)
 */
async function getTimeseries(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors:  errors.array(),
    });
  }

  const { id } = req.params;
  const {
    from_month = '01',
    from_year  = String(new Date().getFullYear() - 1),
    to_month   = '12',
    to_year    = String(new Date().getFullYear()),
    limit      = 100,
    offset     = 0,
  } = req.query;

  try {
    // ── Verify region exists ─────────────────────────────────
    const regionCheck = await query(
      `SELECT id, region_name, state,
              ST_AsGeoJSON(coordinates)::json AS geojson
       FROM regions_of_interest WHERE id = $1`,
      [id]
    );

    if (regionCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: `Region with id "${id}" not found`,
      });
    }

    const region = regionCheck.rows[0];

    // ── Build date range ─────────────────────────────────────
    const fromDate = new Date(`${from_year}-${from_month.padStart(2, '0')}-01T00:00:00Z`);
    const toDate   = new Date(`${to_year}-${to_month.padStart(2, '0')}-01T00:00:00Z`);

    // Move to end of to_month
    toDate.setMonth(toDate.getMonth() + 1);

    // ── Query timeseries ─────────────────────────────────────
    const timeseriesSQL = `
      SELECT
        id,
        region_id,
        timestamp,
        ndvi_score,
        ndvi_delta,
        ndwi_score,
        ndwi_delta,
        sar_backscatter,
        sar_delta_db,
        anomaly_detected,
        alert_severity,
        flags,
        created_at
      FROM analytics_log
      WHERE region_id = $1
        AND timestamp >= $2
        AND timestamp < $3
      ORDER BY timestamp ASC
      LIMIT  $4
      OFFSET $5;
    `;

    const countSQL = `
      SELECT COUNT(*) AS total
      FROM analytics_log
      WHERE region_id = $1
        AND timestamp >= $2
        AND timestamp < $3;
    `;

    const [dataResult, countResult] = await Promise.all([
      query(timeseriesSQL, [id, fromDate.toISOString(), toDate.toISOString(), parseInt(limit), parseInt(offset)]),
      query(countSQL,      [id, fromDate.toISOString(), toDate.toISOString()]),
    ]);

    const total   = parseInt(countResult.rows[0].total, 10);
    const records = dataResult.rows;

    // ── Compute aggregate stats ──────────────────────────────
    const stats = _computeTimeseriesStats(records);

    return res.status(200).json({
      success: true,
      region: {
        id:          region.id,
        region_name: region.region_name,
        state:       region.state,
        geojson:     region.geojson,
      },
      period: {
        from: fromDate.toISOString(),
        to:   new Date(`${to_year}-${to_month.padStart(2, '0')}-01T00:00:00Z`).toISOString(),
      },
      pagination: {
        total,
        limit:   parseInt(limit),
        offset:  parseInt(offset),
        pages:   Math.ceil(total / parseInt(limit)),
      },
      stats,
      timeseries: records,
    });
  } catch (err) {
    console.error('[analyticsController] getTimeseries error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching timeseries',
      ...(process.env.NODE_ENV === 'development' && { detail: err.message }),
    });
  }
}

/**
 * Compute summary statistics over a timeseries dataset.
 * @param {object[]} records
 * @returns {object}
 */
function _computeTimeseriesStats(records) {
  if (records.length === 0) {
    return { count: 0, ndvi: null, ndwi: null, anomalies: 0 };
  }

  const ndviValues = records.map(r => r.ndvi_score).filter(v => v !== null);
  const ndwiValues = records.map(r => r.ndwi_score).filter(v => v !== null);
  const anomalyCount = records.filter(r => r.anomaly_detected).length;

  return {
    count:     records.length,
    anomalies: anomalyCount,
    ndvi: ndviValues.length > 0 ? {
      min:  Math.min(...ndviValues).toFixed(4),
      max:  Math.max(...ndviValues).toFixed(4),
      avg:  (ndviValues.reduce((a, b) => a + b, 0) / ndviValues.length).toFixed(4),
    } : null,
    ndwi: ndwiValues.length > 0 ? {
      min:  Math.min(...ndwiValues).toFixed(4),
      max:  Math.max(...ndwiValues).toFixed(4),
      avg:  (ndwiValues.reduce((a, b) => a + b, 0) / ndwiValues.length).toFixed(4),
    } : null,
  };
}

module.exports = { processAnalytics, getTimeseries };

'use strict';

/**
 * alertsController.js
 *
 * Handles alert-related API logic:
 *   GET /api/alerts/active   — all regions with active anomaly flags
 *   GET /api/alerts/:id      — detail for a single alert log entry
 */

const { query }          = require('../config/db');
const { validationResult } = require('express-validator');

// ─── GET /api/alerts/active ───────────────────────────────────────────────────

/**
 * Returns all regions where at least one anomaly was detected.
 * Groups by region and returns the most recent alert per region,
 * with a count of total anomaly events.
 *
 * Query params:
 *   severity  : filter by 'low' | 'medium' | 'critical'  (optional)
 *   state     : filter by region state name              (optional)
 *   limit     : default 50
 *   offset    : default 0
 */
async function getActiveAlerts(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors:  errors.array(),
    });
  }

  const {
    severity,
    state,
    limit  = 50,
    offset = 0,
  } = req.query;

  try {
    // ── Build dynamic WHERE conditions ──────────────────────
    const conditions = [`al.anomaly_detected = TRUE`];
    const params     = [];

    if (severity) {
      params.push(severity.toLowerCase());
      conditions.push(`al.alert_severity = $${params.length}`);
    }

    if (state) {
      params.push(`%${state}%`);
      conditions.push(`roi.state ILIKE $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');

    // ── Main alerts query ────────────────────────────────────
    // Uses DISTINCT ON to get most recent alert per region
    const alertsSQL = `
      SELECT DISTINCT ON (roi.id)
        roi.id              AS region_id,
        roi.region_name,
        roi.state,
        ST_AsGeoJSON(roi.coordinates)::json AS geojson,
        ST_AsText(ST_Centroid(roi.coordinates)) AS centroid,
        al.id               AS latest_log_id,
        al.timestamp        AS latest_alert_time,
        al.ndvi_score,
        al.ndvi_delta,
        al.ndwi_score,
        al.ndwi_delta,
        al.sar_delta_db,
        al.alert_severity,
        al.flags,
        (
          SELECT COUNT(*)
          FROM analytics_log sub
          WHERE sub.region_id = roi.id
            AND sub.anomaly_detected = TRUE
        ) AS total_anomaly_count
      FROM analytics_log al
      JOIN regions_of_interest roi ON roi.id = al.region_id
      WHERE ${whereClause}
      ORDER BY roi.id, al.timestamp DESC
      LIMIT  $${params.length + 1}
      OFFSET $${params.length + 2};
    `;

    // ── Count query for pagination ───────────────────────────
    const countSQL = `
      SELECT COUNT(DISTINCT roi.id) AS total
      FROM analytics_log al
      JOIN regions_of_interest roi ON roi.id = al.region_id
      WHERE ${whereClause};
    `;

    params.push(parseInt(limit), parseInt(offset));
    const countParams = params.slice(0, params.length - 2); // exclude limit/offset

    const [alertsResult, countResult] = await Promise.all([
      query(alertsSQL, params),
      query(countSQL,  countParams),
    ]);

    const total  = parseInt(countResult.rows[0].total, 10);
    const alerts = alertsResult.rows;

    // ── Severity breakdown summary ───────────────────────────
    const severitySummary = _buildSeveritySummary(alerts);

    return res.status(200).json({
      success: true,
      message: total > 0
        ? `${total} region(s) with active anomaly alerts`
        : 'No active anomaly alerts found',
      pagination: {
        total,
        limit:  parseInt(limit),
        offset: parseInt(offset),
        pages:  Math.ceil(total / parseInt(limit)),
      },
      filters: {
        severity: severity || null,
        state:    state    || null,
      },
      severity_summary: severitySummary,
      alerts,
    });
  } catch (err) {
    console.error('[alertsController] getActiveAlerts error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching active alerts',
      ...(process.env.NODE_ENV === 'development' && { detail: err.message }),
    });
  }
}

// ─── GET /api/alerts/:id ──────────────────────────────────────────────────────

/**
 * Get full details for a single analytics log entry (alert detail view).
 */
async function getAlertById(req, res) {
  const { id } = req.params;

  try {
    const result = await query(
      `SELECT
         al.*,
         roi.region_name,
         roi.state,
         ST_AsGeoJSON(roi.coordinates)::json AS geojson,
         ST_AsText(ST_Centroid(roi.coordinates)) AS centroid,
         u.username AS created_by_username
       FROM analytics_log al
       JOIN regions_of_interest roi ON roi.id = al.region_id
       LEFT JOIN users u ON u.id = roi.user_id
       WHERE al.id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: `Alert log with id "${id}" not found`,
      });
    }

    return res.status(200).json({
      success: true,
      alert:   result.rows[0],
    });
  } catch (err) {
    console.error('[alertsController] getAlertById error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching alert detail',
      ...(process.env.NODE_ENV === 'development' && { detail: err.message }),
    });
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build a quick count breakdown by severity level.
 * @param {object[]} alerts
 * @returns {object}
 */
function _buildSeveritySummary(alerts) {
  return alerts.reduce((acc, alert) => {
    const sev = alert.alert_severity || 'none';
    acc[sev] = (acc[sev] || 0) + 1;
    return acc;
  }, { critical: 0, medium: 0, low: 0, none: 0 });
}

module.exports = { getActiveAlerts, getAlertById };

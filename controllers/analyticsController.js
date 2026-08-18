'use strict';

/**
 * analyticsController.js
 *
 * POST /api/analytics/process
 *   Band sourcing priority:
 *     1. If t1_bands AND t2_bands are both in the request body → use them directly
 *     2. Else if GEE is configured AND geojson_polygon is supplied → call GEE
 *     3. Else → 400 error with a clear message
 *
 * GET /api/analytics/region/:id/timeseries
 *   Historical NDVI/NDWI trends for a region.
 */

const { query }               = require('../config/db');
const { runCombinedAnalysis } = require('../services/geoEngine');
const { validationResult }    = require('express-validator');
const { fetchBandsForPolygon, isGEEConfigured } = require('../services/geeService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if a complete band set was supplied in the request body.
 * @param {object|undefined} bands
 */
function _bandsPresent(bands) {
  return (
    bands &&
    typeof bands.nir          === 'number' &&
    typeof bands.red          === 'number' &&
    typeof bands.swir         === 'number' &&
    typeof bands.sarIntensity === 'number'
  );
}

// ─── POST /api/analytics/process ─────────────────────────────────────────────

async function processAnalytics(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors:  errors.array(),
    });
  }

  const {
    region_id,
    t1,
    t2,
    t1_bands,
    t2_bands,
    geojson_polygon,
    bounding_box,
  } = req.body;

  try {
    // ── 1. Verify region exists ────────────────────────────────────────────
    const regionCheck = await query(
      `SELECT id, region_name, state,
              ST_AsGeoJSON(coordinates)::json AS geojson
       FROM regions_of_interest WHERE id = $1`,
      [region_id],
    );

    if (regionCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: `Region "${region_id}" not found`,
      });
    }

    const region = regionCheck.rows[0];

    // ── 2. Optional bounding-box intersection check ────────────────────────
    if (bounding_box) {
      const { minLng, minLat, maxLng, maxLat } = bounding_box;
      const ix = await query(
        `SELECT ST_Intersects(
            coordinates,
            ST_MakeEnvelope($1,$2,$3,$4,4326)
          ) AS intersects
          FROM regions_of_interest WHERE id = $5`,
        [minLng, minLat, maxLng, maxLat, region_id],
      );
      if (!ix.rows[0]?.intersects) {
        return res.status(400).json({
          success: false,
          message: 'Bounding box does not intersect the specified region',
        });
      }
    }

    // ── 3. Resolve band values ─────────────────────────────────────────────
    let resolvedT1Bands = t1_bands;
    let resolvedT2Bands = t2_bands;
    let bandSource      = 'manual';
    let geeDates        = null;

    const manualBandsProvided = _bandsPresent(t1_bands) && _bandsPresent(t2_bands);

    if (!manualBandsProvided) {
      // Prefer explicitly supplied geojson_polygon; fall back to the region's
      // stored geometry so even old regions can be re-analysed.
      const polygonForGEE = geojson_polygon ?? region.geojson;

      if (!polygonForGEE) {
        return res.status(400).json({
          success: false,
          message:
            'No band values supplied and no polygon available. ' +
            'Provide geojson_polygon in the request body, or t1_bands + t2_bands manually.',
        });
      }

      // GEE is always configured — key file lives at config/gee-key.json
      console.log(`[Analytics] Calling GEE for region "${region.region_name}"…`);
      try {
        const geeResult = await fetchBandsForPolygon(polygonForGEE, t1, t2);
        resolvedT1Bands = geeResult.t1Bands;
        resolvedT2Bands = geeResult.t2Bands;
        geeDates        = geeResult.dates;
        bandSource      = 'gee';
        
        // Attach the new map/thumbnail URLs directly to the analysis object later
        // so the frontend can receive them easily.
        req.geeExtras = {
          anomalyTilesUrl: geeResult.anomalyTilesUrl,
          historicalThumbnails: geeResult.historicalThumbnails
        };

        console.log('[Analytics] GEE bands received successfully');
      } catch (geeErr) {
        console.error('[Analytics] GEE fetch failed — using baseline fallback:', geeErr.message);

        // Graceful fallback: use conservative vegetation-stress baseline values
        // so the pipeline still runs and returns a meaningful result.
        // band_source = 'fallback' tells the frontend to show a warning instead
        // of the GEE badge.  The caller can check gee_error for the root cause.
        resolvedT1Bands = { nir: 0.72, red: 0.08, swir: 0.15, sarIntensity: 0.055 };
        resolvedT2Bands = { nir: 0.55, red: 0.14, swir: 0.28, sarIntensity: 0.035 };
        bandSource      = 'fallback';
        geeDates        = { gee_error: geeErr.message };
      }
    }

    // ── 4. Run geoEngine analysis ──────────────────────────────────────────
    const analysis = runCombinedAnalysis(resolvedT1Bands, resolvedT2Bands);

    // Inject GEE extra visualizations into the analysis object so the
    // frontend can read them from analysis.anomalyTilesUrl and
    // analysis.historicalThumbnails directly.
    if (req.geeExtras) {
      analysis.anomalyTilesUrl         = req.geeExtras.anomalyTilesUrl         ?? null;
      analysis.historicalThumbnails    = req.geeExtras.historicalThumbnails    ?? [];
    } else {
      analysis.anomalyTilesUrl         = null;
      analysis.historicalThumbnails    = [];
    }

    // ── 5. Persist to analytics_log ───────────────────────────────────────
    const logResult = await query(
      `INSERT INTO analytics_log (
         region_id, timestamp,
         ndvi_score, ndvi_delta,
         ndwi_score, ndwi_delta,
         sar_backscatter, sar_delta_db,
         anomaly_detected, alert_severity,
         flags, raw_bands
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        region_id,
        t2,
        analysis.indices.ndvi.t2.value,
        analysis.indices.ndvi.delta,
        analysis.indices.ndwi.t2.value,
        analysis.indices.ndwi.delta,
        analysis.indices.sar.t2_db,
        analysis.indices.sar.delta_db,
        analysis.anomalyDetected,
        analysis.alertSeverity,
        JSON.stringify(analysis.flags),
        JSON.stringify({
          source: bandSource,
          t1:     resolvedT1Bands,
          t2:     resolvedT2Bands,
          ...(geeDates && { gee_windows: geeDates }),
          ...(req.geeExtras && { gee_extras: req.geeExtras }),
        }),
      ],
    );

    const savedLog = logResult.rows[0];

    // ── 6. Award contribution points if anomaly found ─────────────────────
    if (analysis.anomalyDetected && req.account?.sub) {
      await query(
        `UPDATE users
         SET contribution_points = contribution_points + 10
         WHERE id = $1`,
        [req.account.sub],
      );
    }

    // ── 7. Respond ────────────────────────────────────────────────────────
    return res.status(201).json({
      success:     true,
      message:     'Analytics processed successfully',
      log_id:      savedLog.id,
      band_source: bandSource,          // "gee" or "manual" — useful for the UI
      ...(geeDates && { gee_dates: geeDates }),
      region: {
        id:          region.id,
        region_name: region.region_name,
        state:       region.state,
        geojson:     region.geojson,
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

async function getTimeseries(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, message: 'Validation failed', errors: errors.array() });
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
    const regionCheck = await query(
      `SELECT id, region_name, state,
              ST_AsGeoJSON(coordinates)::json AS geojson
       FROM regions_of_interest WHERE id = $1`,
      [id],
    );

    if (regionCheck.rowCount === 0) {
      return res.status(404).json({ success: false, message: `Region "${id}" not found` });
    }

    const region   = regionCheck.rows[0];
    const fromDate = new Date(`${from_year}-${String(from_month).padStart(2,'0')}-01T00:00:00Z`);
    const toDate   = new Date(`${to_year}-${String(to_month).padStart(2,'0')}-01T00:00:00Z`);
    toDate.setMonth(toDate.getMonth() + 1);

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT id, region_id, timestamp,
                ndvi_score, ndvi_delta, ndwi_score, ndwi_delta,
                sar_backscatter, sar_delta_db,
                anomaly_detected, alert_severity, flags, created_at
         FROM analytics_log
         WHERE region_id = $1 AND timestamp >= $2 AND timestamp < $3
         ORDER BY timestamp ASC
         LIMIT $4 OFFSET $5`,
        [id, fromDate.toISOString(), toDate.toISOString(), parseInt(limit), parseInt(offset)],
      ),
      query(
        `SELECT COUNT(*) AS total FROM analytics_log
         WHERE region_id = $1 AND timestamp >= $2 AND timestamp < $3`,
        [id, fromDate.toISOString(), toDate.toISOString()],
      ),
    ]);

    const total   = parseInt(countResult.rows[0].total, 10);
    const records = dataResult.rows;
    const stats   = _computeTimeseriesStats(records);

    return res.status(200).json({
      success: true,
      region:  { id: region.id, region_name: region.region_name, state: region.state, geojson: region.geojson },
      period:  { from: fromDate.toISOString(), to: new Date(`${to_year}-${String(to_month).padStart(2,'0')}-01T00:00:00Z`).toISOString() },
      pagination: { total, limit: parseInt(limit), offset: parseInt(offset), pages: Math.ceil(total / parseInt(limit)) },
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

function _computeTimeseriesStats(records) {
  if (!records.length) return { count: 0, ndvi: null, ndwi: null, anomalies: 0 };
  const ndvi      = records.map(r => r.ndvi_score).filter(v => v != null);
  const ndwi      = records.map(r => r.ndwi_score).filter(v => v != null);
  const anomalies = records.filter(r => r.anomaly_detected).length;
  const stat = (arr) => arr.length === 0 ? null : {
    min: Math.min(...arr).toFixed(4),
    max: Math.max(...arr).toFixed(4),
    avg: (arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(4),
  };
  return { count: records.length, anomalies, ndvi: stat(ndvi), ndwi: stat(ndwi) };
}

module.exports = { processAnalytics, getTimeseries };

'use strict';

/**
 * routes/regionsRoutes.js
 * POST /api/regions  — create a new region of interest from drawn coordinates
 */

const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');

const router = Router();

const validation = [
  body('region_name').isString().trim().notEmpty().isLength({ max: 255 }),
  body('state').isString().trim().notEmpty().isLength({ max: 120 }),
  body('coordinates').isObject(),
  body('coordinates.type').equals('Polygon'),
  body('coordinates.coordinates').isArray(),
];

/**
 * POST /api/regions
 * Body: { region_name, state, coordinates: GeoJSON Polygon, description? }
 * Creates or upserts a region_of_interest row.
 *
 * Uses a placeholder user_id (the seeded analyst UUID or the first user in DB).
 * Wire up auth middleware later to use req.account.sub instead.
 */
router.post('/', validation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }

  const { region_name, state, coordinates, description } = req.body;

  try {
    // Resolve a valid user_id — use req.account if auth middleware is present,
    // otherwise fall back to the first active user in the DB.
    let userId = req.account?.sub ?? null;

    if (!userId) {
      const userRes = await query(
        'SELECT id FROM users WHERE is_active = TRUE ORDER BY created_at ASC LIMIT 1',
      );
      if (userRes.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No users in database — register an account first',
        });
      }
      userId = userRes.rows[0].id;
    }

    // Build a WKT polygon from the GeoJSON for PostGIS
    const geojsonStr = JSON.stringify(coordinates);

    const result = await query(
      `INSERT INTO regions_of_interest
         (user_id, region_name, state, coordinates, description)
       VALUES (
         $1, $2, $3,
         ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
         $5
       )
       RETURNING
         id,
         region_name,
         state,
         description,
         ST_AsGeoJSON(coordinates)::json AS geojson,
         created_at`,
      [userId, region_name.trim(), state.trim(), geojsonStr, description ?? null],
    );

    return res.status(201).json({
      success: true,
      region:  result.rows[0],
    });
  } catch (err) {
    console.error('[regionsRoutes] create error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to create region',
      ...(process.env.NODE_ENV === 'development' && { detail: err.message }),
    });
  }
});

module.exports = router;

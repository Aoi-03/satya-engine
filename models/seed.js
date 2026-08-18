'use strict';

/**
 * seed.js
 * Inserts one test user, one region of interest, and one analytics log entry.
 *
 * Run with: npm run seed
 */

require('dotenv').config();
const { query, pool } = require('../config/db');

async function seed() {
  console.log('\n========================================');
  console.log('  Satellite Analytics — Seed Data');
  console.log('========================================\n');

  try {
    // ── 1. Insert test user ──────────────────────────────────
    const userResult = await query(
      `INSERT INTO users (username, email, password_hash, role, contribution_points)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username
       RETURNING id, username, email, role`,
      [
        'test_analyst',
        'analyst@satenv.dev',
        '$2b$10$placeholderhashedpassword',   // placeholder — not used for auth yet
        'analyst',
        0,
      ]
    );
    const user = userResult.rows[0];
    console.log(`  ✅  User inserted       → id: ${user.id} | ${user.username}`);

    // ── 2. Insert test region (Western Ghats, Maharashtra) ───
    // Polygon covers a representative area using WGS84 (SRID 4326)
    const regionResult = await query(
      `INSERT INTO regions_of_interest (user_id, region_name, state, coordinates, description)
       VALUES (
         $1, $2, $3,
         ST_GeomFromText(
           'POLYGON((73.5 17.0, 74.5 17.0, 74.5 18.0, 73.5 18.0, 73.5 17.0))',
           4326
         ),
         $4
       )
       ON CONFLICT DO NOTHING
       RETURNING id, region_name, state`,
      [
        user.id,
        'Western Ghats Test Zone',
        'Maharashtra',
        'Test region covering a section of the Western Ghats for vegetation and moisture monitoring',
      ]
    );

    let region;
    if (regionResult.rowCount === 0) {
      // Already exists — fetch it
      const existing = await query(
        `SELECT id, region_name, state FROM regions_of_interest WHERE region_name = $1`,
        ['Western Ghats Test Zone']
      );
      region = existing.rows[0];
      console.log(`  ℹ️   Region already exists → id: ${region.id} | ${region.region_name}`);
    } else {
      region = regionResult.rows[0];
      console.log(`  ✅  Region inserted     → id: ${region.id} | ${region.region_name}, ${region.state}`);
    }

    // ── 3. Insert sample analytics log (anomaly scenario) ────
    // T1 bands (healthy): high NIR, low RED, low SWIR
    // T2 bands (stressed): dropped NIR, higher RED/SWIR → triggers NDVI + NDWI anomaly
    const logResult = await query(
      `INSERT INTO analytics_log (
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
       RETURNING id, alert_severity, anomaly_detected`,
      [
        region.id,
        new Date().toISOString(),
        0.28,                                           // ndvi_score at T2
        -0.22,                                          // ndvi_delta (T2 - T1): dropped 0.22 → > 0.15 threshold
        0.05,                                           // ndwi_score at T2
        -0.25,                                          // ndwi_delta: dropped 0.25 → > 0.20 threshold
        -12.4,                                          // sar_backscatter (dB at T2)
        -4.1,                                           // sar_delta_db: < -3.0 → SAR anomaly
        true,                                           // anomaly_detected
        'critical',                                     // alert_severity: NDVI + NDWI both flagged
        JSON.stringify(['DEFORESTATION', 'HUMIDITY_DEPLETION', 'SAR_STRUCTURAL_CHANGE']),
        JSON.stringify({
          t1: { nir: 0.65, red: 0.08, swir: 0.12, sarIntensity: 0.08 },
          t2: { nir: 0.35, red: 0.22, swir: 0.42, sarIntensity: 0.03 },
        }),
      ]
    );
    const log = logResult.rows[0];
    console.log(`  ✅  Analytics log inserted → id: ${log.id} | severity: ${log.alert_severity} | anomaly: ${log.anomaly_detected}`);

    console.log('\n========================================');
    console.log('  Seed complete. Test IDs to use:');
    console.log(`  User ID   : ${user.id}`);
    console.log(`  Region ID : ${region.id}`);
    console.log(`  Log ID    : ${log.id}`);
    console.log('========================================\n');

    console.log('  Postman test commands:');
    console.log(`  GET  /api/alerts/active`);
    console.log(`  GET  /api/analytics/region/${region.id}/timeseries`);
    console.log(`  GET  /api/alerts/${log.id}`);
    console.log('');

  } catch (err) {
    console.error('\n  ❌ Seed failed:', err.message);
    if (process.env.NODE_ENV === 'development') console.error(err.stack);
  } finally {
    await pool.end();
  }
}

seed();

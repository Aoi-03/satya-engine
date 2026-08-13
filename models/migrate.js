'use strict';

/**
 * Database Migration Script
 * Runs once to create all tables for the Satellite Environmental Analytics System.
 * Requires PostGIS extension to be installed on the target database.
 *
 * Run with: node models/migrate.js
 */

require('dotenv').config();
const { query, connectDB, pool } = require('../config/db');

const migrations = [
  // ─── Enable PostGIS ──────────────────────────────────────────────────────────
  {
    name: 'Enable PostGIS extension',
    sql: `CREATE EXTENSION IF NOT EXISTS postgis;`,
  },

  // ─── Users ───────────────────────────────────────────────────────────────────
  {
    name: 'Create users table',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        username            VARCHAR(80)   NOT NULL UNIQUE,
        email               VARCHAR(255)  NOT NULL UNIQUE,
        password_hash       VARCHAR(255)  NOT NULL,
        role                VARCHAR(20)   NOT NULL DEFAULT 'analyst'
                                          CHECK (role IN ('admin', 'analyst', 'viewer')),
        contribution_points INTEGER       NOT NULL DEFAULT 0 CHECK (contribution_points >= 0),
        is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `,
  },

  // ─── Regions of Interest ─────────────────────────────────────────────────────
  {
    name: 'Create regions_of_interest table',
    sql: `
      CREATE TABLE IF NOT EXISTS regions_of_interest (
        id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        region_name  VARCHAR(255) NOT NULL,
        state        VARCHAR(120) NOT NULL,
        coordinates  GEOMETRY(Polygon, 4326) NOT NULL,
        description  TEXT,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: 'Create spatial index on regions_of_interest.coordinates',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_roi_coordinates
        ON regions_of_interest USING GIST (coordinates);
    `,
  },
  {
    name: 'Create index on regions_of_interest.user_id',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_roi_user_id
        ON regions_of_interest (user_id);
    `,
  },

  // ─── Analytics Log ───────────────────────────────────────────────────────────
  {
    name: 'Create analytics_log table',
    sql: `
      CREATE TABLE IF NOT EXISTS analytics_log (
        id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        region_id         UUID          NOT NULL REFERENCES regions_of_interest(id) ON DELETE CASCADE,
        timestamp         TIMESTAMPTZ   NOT NULL,
        ndvi_score        DOUBLE PRECISION,
        ndvi_delta        DOUBLE PRECISION,
        ndwi_score        DOUBLE PRECISION,
        ndwi_delta        DOUBLE PRECISION,
        sar_backscatter   DOUBLE PRECISION,
        sar_delta_db      DOUBLE PRECISION,
        anomaly_detected  BOOLEAN       NOT NULL DEFAULT FALSE,
        alert_severity    VARCHAR(10)   NOT NULL DEFAULT 'none'
                                        CHECK (alert_severity IN ('none', 'low', 'medium', 'critical')),
        flags             JSONB         NOT NULL DEFAULT '[]',
        raw_bands         JSONB,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: 'Create index on analytics_log.region_id',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_analytics_region_id
        ON analytics_log (region_id);
    `,
  },
  {
    name: 'Create index on analytics_log.timestamp',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_analytics_timestamp
        ON analytics_log (timestamp DESC);
    `,
  },
  {
    name: 'Create composite index for timeseries queries',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_analytics_region_timestamp
        ON analytics_log (region_id, timestamp DESC);
    `,
  },
  {
    name: 'Create index on anomaly_detected for alerts',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_analytics_anomaly
        ON analytics_log (anomaly_detected)
        WHERE anomaly_detected = TRUE;
    `,
  },

  // ─── Auto-update updated_at trigger ──────────────────────────────────────────
  {
    name: 'Create updated_at trigger function',
    sql: `
      CREATE OR REPLACE FUNCTION trigger_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
  },
  {
    name: 'Attach updated_at trigger to users',
    sql: `
      DROP TRIGGER IF EXISTS set_users_updated_at ON users;
      CREATE TRIGGER set_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
    `,
  },
  {
    name: 'Attach updated_at trigger to regions_of_interest',
    sql: `
      DROP TRIGGER IF EXISTS set_roi_updated_at ON regions_of_interest;
      CREATE TRIGGER set_roi_updated_at
        BEFORE UPDATE ON regions_of_interest
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
    `,
  },
];

async function runMigrations() {
  console.log('\n========================================');
  console.log('  Satellite Analytics — DB Migration');
  console.log('========================================\n');

  await connectDB();

  let passed = 0;
  let failed = 0;

  for (const migration of migrations) {
    try {
      await query(migration.sql);
      console.log(`  ✅  ${migration.name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌  ${migration.name}`);
      console.error(`      Error: ${err.message}\n`);
      failed++;
    }
  }

  console.log('\n----------------------------------------');
  console.log(`  Done: ${passed} passed, ${failed} failed`);
  console.log('----------------------------------------\n');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

runMigrations();

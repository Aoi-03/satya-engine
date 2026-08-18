'use strict';

/**
 * Database Migration Script
 * Runs once to create all tables for the Satellite Environmental Analytics System.
 * Requires PostGIS extension to be installed on the target database.
 *
 * Run with: node models/migrate.js
 */

require('dotenv').config();
const { query, pool } = require('../config/db');

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
        id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        username              VARCHAR(80)   NOT NULL UNIQUE,
        email                 VARCHAR(255)  NOT NULL UNIQUE,
        password_hash         VARCHAR(255)  NOT NULL,
        display_name          VARCHAR(80)   NOT NULL,
        role                  VARCHAR(20)   NOT NULL DEFAULT 'analyst'
                                            CHECK (role IN ('admin', 'analyst', 'viewer')),
        contribution_points   INTEGER       NOT NULL DEFAULT 0 CHECK (contribution_points >= 0),
        avatar_url            TEXT,
        frame_id              VARCHAR(80),
        token_version         INTEGER       NOT NULL DEFAULT 0,
        failed_login_attempts INTEGER       NOT NULL DEFAULT 0,
        locked_until          TIMESTAMPTZ,
        last_login_at         TIMESTAMPTZ,
        last_login_ip         VARCHAR(64),
        is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `,
  },
  // ─── Add auth columns to pre-existing users table (idempotent) ───────────────
  {
    name: 'Add display_name column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(80) NOT NULL DEFAULT '';`,
  },
  {
    name: 'Add avatar_url column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`,
  },
  {
    name: 'Add frame_id column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS frame_id VARCHAR(80);`,
  },
  {
    name: 'Add token_version column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    name: 'Add failed_login_attempts column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    name: 'Add locked_until column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;`,
  },
  {
    name: 'Add last_login_at column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;`,
  },
  {
    name: 'Add last_login_ip column if missing',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64);`,
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

  // ─── Password Reset Tokens ────────────────────────────────────────────────────
  {
    name: 'Create password_reset_tokens table',
    sql: `
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code       CHAR(6)     NOT NULL,
        used       BOOLEAN     NOT NULL DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: 'Create index on password_reset_tokens.user_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_prt_user_id ON password_reset_tokens (user_id);`,
  },
  {
    name: 'Create index on password_reset_tokens.expires_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_prt_expires ON password_reset_tokens (expires_at);`,
  },

  // ─── Research Posts (Research Hub) ───────────────────────────────────────────
  {
    name: 'Create research_posts table',
    sql: `
      CREATE TABLE IF NOT EXISTS research_posts (
        id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        analytics_log_id  UUID          NOT NULL REFERENCES analytics_log(id) ON DELETE CASCADE,
        content           TEXT          NOT NULL,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: 'Create index on research_posts.user_id',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_research_posts_user_id
        ON research_posts (user_id);
    `,
  },
  {
    name: 'Create index on research_posts.analytics_log_id',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_research_posts_analytics_log_id
        ON research_posts (analytics_log_id);
    `,
  },
  {
    name: 'Create index on research_posts.created_at',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_research_posts_created_at
        ON research_posts (created_at DESC);
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
  {
    name: 'Attach updated_at trigger to research_posts',
    sql: `
      DROP TRIGGER IF EXISTS set_rp_updated_at ON research_posts;
      CREATE TRIGGER set_rp_updated_at
        BEFORE UPDATE ON research_posts
        FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
    `,
  },
];

async function runMigrations() {
  console.log('\n========================================');
  console.log('  Satellite Analytics — DB Migration');
  console.log('========================================\n');

  // Fire a simple ping to verify the pool can reach Supabase
  try {
    await query('SELECT 1');
    console.log('  [DB] Connection verified via pool.\n');
  } catch (err) {
    console.error('  [DB] Cannot reach database:', err.message);
    await pool.end();
    process.exit(1);
  }

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

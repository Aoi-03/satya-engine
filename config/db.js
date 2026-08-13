'use strict';

const { Pool } = require('pg');

/**
 * PostgreSQL connection pool with PostGIS support.
 * All spatial queries use ST_* functions available via the PostGIS extension.
 */
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME     || 'satellite_analytics',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max:      parseInt(process.env.DB_POOL_MAX, 10) || 10,   // max pool connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Log pool errors to prevent silent crashes
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
  process.exit(1);
});

/**
 * Test the database connection and verify PostGIS is installed.
 */
async function connectDB() {
  let client;
  try {
    client = await pool.connect();

    // Verify PostGIS extension
    const result = await client.query(`SELECT PostGIS_Version() AS version;`);
    console.log(`[DB] Connected to PostgreSQL`);
    console.log(`[DB] PostGIS version: ${result.rows[0].version.trim()}`);
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    throw err;
  } finally {
    if (client) client.release();
  }
}

/**
 * Execute a parameterized query using the pool.
 * @param {string} text   - SQL query string
 * @param {Array}  params - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DB] Query executed in ${duration}ms | rows: ${result.rowCount}`);
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    console.error('[DB] Query:', text);
    throw err;
  }
}

/**
 * Get a dedicated client from the pool (for transactions).
 * Remember to call client.release() when done.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, connectDB, query, getClient };

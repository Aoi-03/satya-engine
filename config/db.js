'use strict';

const { Pool } = require('pg');
require('dotenv').config();

/**
 * PostgreSQL connection pool for Supabase.
 *
 * Uses individual params instead of a connection string URL to avoid
 * URL-parsing issues with special characters (e.g. '@') in the password.
 */
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false, // Required for Supabase external connections
  },
  max:                     10,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis:       30_000,
});

// Log pool-level errors to prevent silent crashes
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Execute a parameterized query using the pool.
 * @param {string} text   - SQL query string
 * @param {Array}  params - Query parameters
 */
const query = async (text, params = []) => {
  const start = Date.now();
  try {
    const res      = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`[DB] Executed query in ${duration}ms | rows: ${res.rowCount}`);
    return res;
  } catch (err) {
    console.error(`[DB] Query error: ${err.message}`);
    throw err;
  }
};

/**
 * Get a dedicated client from the pool (for transactions).
 * Remember to call client.release() when done.
 */
async function getClient() {
  return pool.connect();
}

module.exports = { query, pool, getClient };

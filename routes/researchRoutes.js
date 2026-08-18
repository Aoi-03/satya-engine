'use strict';

const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authMiddleware } = require('../middleware/authMiddleware');

const router = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const postValidation = [
  body('analytics_log_id').isUUID().withMessage('analytics_log_id must be a valid UUID'),
  body('content').isString().notEmpty().withMessage('Content cannot be empty'),
];

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/research
 * @desc    Fetch recent community research posts with anomaly details
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const sql = `
      SELECT
        rp.id,
        rp.content,
        rp.created_at,
        u.id AS author_id,
        u.username AS author_username,
        u.display_name AS author_name,
        u.avatar_url AS author_avatar,
        al.id AS analytics_log_id,
        al.ndvi_score,
        al.ndvi_delta,
        al.ndwi_score,
        al.ndwi_delta,
        al.sar_delta_db,
        al.alert_severity,
        roi.region_name
      FROM research_posts rp
      JOIN users u ON rp.user_id = u.id
      JOIN analytics_log al ON rp.analytics_log_id = al.id
      JOIN regions_of_interest roi ON al.region_id = roi.id
      ORDER BY rp.created_at DESC
      LIMIT 50;
    `;
    const result = await query(sql);
    res.json({ success: true, posts: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/research/my-anomalies
 * @desc    Fetch the logged-in user's recent detected anomalies for linking in a post
 * @access  Private
 */
router.get('/my-anomalies', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.account.sub;
    const sql = `
      SELECT
        al.id,
        al.timestamp,
        al.alert_severity,
        al.ndvi_delta,
        al.ndwi_delta,
        al.sar_delta_db,
        roi.region_name
      FROM analytics_log al
      JOIN regions_of_interest roi ON al.region_id = roi.id
      WHERE roi.user_id = $1 AND al.anomaly_detected = TRUE
      ORDER BY al.timestamp DESC
      LIMIT 50;
    `;
    const result = await query(sql, [userId]);
    res.json({ success: true, anomalies: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/research
 * @desc    Create a new research post linking an anomaly
 * @access  Private
 */
router.post('/', authMiddleware, postValidation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { analytics_log_id, content } = req.body;
    const userId = req.account.sub;

    const sql = `
      INSERT INTO research_posts (user_id, analytics_log_id, content)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const result = await query(sql, [userId, analytics_log_id, content]);
    
    res.status(201).json({ success: true, post: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

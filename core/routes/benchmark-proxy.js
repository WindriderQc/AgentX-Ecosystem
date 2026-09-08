/**
 * Benchmark Proxy Routes
 *
 * Exposes benchmark recommendation data to core UI.
 * Core reads from benchmark via HTTP — benchmark owns the data.
 *
 * Endpoints:
 *   GET /api/benchmark-proxy/recommend?category=coding[&host=...][&min_quality=...]
 *   GET /api/benchmark-proxy/recommend/all
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getBenchmarkServiceClient } = require('../src/services/benchmarkServiceClient');

const VALID_CATEGORIES = new Set([
  'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
]);

/**
 * GET /api/benchmark-proxy/recommend
 * Proxy a single-category recommendation query.
 */
router.get('/recommend', async (req, res) => {
  const { category, host, min_quality } = req.query;
  const trustScope = String(req.query.trustScope || '').trim().toLowerCase();

  if (!category) {
    return res.status(400).json({ status: 'error', message: 'category query parameter is required' });
  }

  if (!VALID_CATEGORIES.has(category)) {
    return res.status(400).json({
      status: 'error',
      message: `Invalid category. Valid: ${[...VALID_CATEGORIES].join(', ')}`
    });
  }
  if (!['trusted', 'exploratory'].includes(trustScope)) {
    return res.status(400).json({
      status: 'error',
      code: 'TRUST_SCOPE_REQUIRED',
      message: 'trustScope must be explicitly set to trusted or exploratory'
    });
  }

  try {
    const client = getBenchmarkServiceClient();
    const view = await client.getRecommendationView(category, {
      host,
      min_quality,
      trustScope
    });

    res.json({
      status: 'success',
      data: {
        ...view,
        source: 'benchmark'
      }
    });
  } catch (err) {
    logger.error('Benchmark proxy recommend failed', { error: err.message });
    res.status(502).json({ status: 'error', message: 'Benchmark service unavailable' });
  }
});

/**
 * GET /api/benchmark-proxy/recommend/all
 * Return top recommendations for every category (summary view).
 */
router.get('/recommend/all', async (req, res) => {
  const trustScope = String(req.query.trustScope || '').trim().toLowerCase();
  if (!['trusted', 'exploratory'].includes(trustScope)) {
    return res.status(400).json({
      status: 'error',
      code: 'TRUST_SCOPE_REQUIRED',
      message: 'trustScope must be explicitly set to trusted or exploratory'
    });
  }
  try {
    const client = getBenchmarkServiceClient();
    const allRecs = await client.getAllCategoryRecommendations({ trustScope });

    res.json({
      status: 'success',
      data: {
        categories: allRecs,
        trustScope,
        source: 'benchmark'
      }
    });
  } catch (err) {
    logger.error('Benchmark proxy recommend/all failed', { error: err.message });
    res.status(502).json({ status: 'error', message: 'Benchmark service unavailable' });
  }
});

module.exports = router;

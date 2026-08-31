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
const { Readable } = require('stream');
const router = express.Router();
const logger = require('../config/logger');
const { getBenchmarkServiceClient } = require('../src/services/benchmarkServiceClient');

const BENCHMARK_BASE = process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081';

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

// Generic passthrough — forwards any other /api/benchmark-proxy/* to the
// benchmark service at /api/benchmark/* (same mapping the specialized /recommend
// routes above use via the client). Without this, every non-recommend path
// (leaderboard, batches, drift, courthouse, …) fell through to core's 404
// handler even though benchmark serves it (task 0358). Declared LAST so the
// specific routes above still match first.
router.all('/*', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const url = `${BENCHMARK_BASE}/api/benchmark${req.path}${qs ? '?' + qs : ''}`;
  try {
    const opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = JSON.stringify(req.body);
    const response = await fetch(url, opts);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const upstream = Readable.fromWeb(response.body);
      upstream.pipe(res);
      req.on('close', () => upstream.destroy());
      return;
    }

    if (contentType.includes('json')) {
      const data = await response.json();
      res.status(response.status).json(data);
    } else {
      const text = await response.text();
      res.status(response.status).type(contentType || 'text/plain').send(text);
    }
  } catch (err) {
    logger.warn('Benchmark proxy passthrough error', { path: req.path, error: err.message });
    res.status(502).json({ status: 'error', message: 'Benchmark service unreachable', detail: err.message });
  }
});

module.exports = router;

/**
 * On-demand + status API for the Nestor fallback-chain prewarm (0454).
 *
 *   POST /api/nestor/prewarm       — run a warm-up cycle now
 *   GET  /api/nestor/prewarm       — last run's results
 *
 * Intended for a maintenance scheduler after the route has been deployed and
 * verified. The service follows the effective local fallback route and pins.
 */

const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const { prewarmFallbackModels, getLastRun } = require('../src/services/nestorPrewarmService');

const router = express.Router();

router.post('/', async (_req, res) => {
  try {
    const result = await prewarmFallbackModels();
    return envelope.success(res, result);
  } catch (err) {
    logger.error('Nestor prewarm failed', { error: err.message });
    return envelope.error(res, 500, err.message || 'Prewarm failed', 'NESTOR_PREWARM_ERROR');
  }
});

router.get('/', (_req, res) => {
  return envelope.success(res, getLastRun() || { at: null, results: [] });
});

module.exports = router;

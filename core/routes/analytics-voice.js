const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const voiceObservability = require('../src/services/voiceObservabilityService');

const router = express.Router();

router.get('/slos', (_req, res) => envelope.success(res, voiceObservability.SLOS));

router.get('/summary', async (req, res) => {
  try {
    return envelope.success(res, await voiceObservability.getSummary({
      window: req.query.window,
      surface: req.query.surface
    }));
  } catch (error) {
    logger.error('Voice observability summary failed', { error: error.message });
    return envelope.error(res, 500, error.message, 'VOICE_OBSERVABILITY_SUMMARY_ERROR');
  }
});

router.post('/trace', async (req, res) => {
  try {
    const result = await voiceObservability.ingestTrace(req.body || {});
    return envelope.success(res, {
      traceId: result.trace.traceId,
      status: result.trace.status,
      sloViolations: result.trace.sloViolations,
      alert: result.alert
    }, null, 201);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) logger.error('Voice observability ingest failed', { error: error.message });
    return envelope.error(res, status, error.message, error.code || 'VOICE_OBSERVABILITY_INGEST_ERROR');
  }
});

module.exports = router;

'use strict';

const express = require('express');
const logger = require('../config/logger');
const {
  readEffectivenessSnapshot,
  upsertOutcome,
} = require('../src/services/llmEffectivenessService');
const { RUNTIMES } = require('../src/helpers/llmTelemetryContext');

const router = express.Router();

router.get('/effectiveness', async (req, res) => {
  const runtime = req.query.runtime ? String(req.query.runtime).toLowerCase() : null;
  if (runtime && !RUNTIMES.has(runtime)) {
    return res.status(400).json({ status: 'error', message: 'runtime is invalid' });
  }
  try {
    const snapshot = await readEffectivenessSnapshot({
      window: req.query.window,
      from: req.query.from,
      to: req.query.to,
      runtime,
      consumerContract: req.query.consumerContract,
    });
    return res.json(snapshot);
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({
        status: 'error',
        code: error.code || 'INVALID_EFFECTIVENESS_WINDOW',
        message: error.message,
      });
    }
    logger.error('LLM effectiveness snapshot failed', { error: error.message });
    return res.status(500).json({ status: 'error', message: 'Effectiveness telemetry is temporarily unavailable.' });
  }
});

router.post('/effectiveness/outcomes', async (req, res) => {
  try {
    const outcome = await upsertOutcome(req.body || {});
    return res.status(201).json({ ok: true, outcome });
  } catch (error) {
    logger.warn('LLM outcome report rejected', { error: error.message, code: error.code });
    return res.status(error.status || 400).json({
      ok: false,
      error: error.message,
      code: error.code || 'INVALID_OUTCOME',
    });
  }
});

module.exports = router;

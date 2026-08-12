'use strict';
/**
 * Host Capacity Routes
 *
 * GET /api/host-capacity            → capacity report + verdict for every configured Ollama host
 * GET /api/host-capacity/:host      → capacity report + verdict for one host
 *                                     (:host = configured id / name / IP / URL, e.g. 'secondary',
 *                                      'local-gpu', '192.0.2.10')
 * Query: ?hours=24 (lookback window, capped at 168)
 *
 * Read-only: aggregates Mongo telemetry + a best-effort allowlist-gated live
 * Ollama /api/ps probe. No mutations.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { computeHostCapacity } = require('../src/services/hostCapacityService');
const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');

// GET /api/host-capacity — all configured hosts
router.get('/', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const hosts = getConfiguredHosts();
    const reports = await Promise.all(
      hosts.map((h) => computeHostCapacity(h.id, hours).catch((err) => ({
        error: 'compute_failed', input: h.id, message: err.message,
      })))
    );
    res.json({ status: 'success', data: reports });
  } catch (err) {
    logger.error('[host-capacity] fleet report failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/host-capacity/:host — single host
router.get('/:host', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const report = await computeHostCapacity(req.params.host, hours);
    if (report.error === 'unresolved_host') {
      return res.status(404).json({ status: 'error', message: report.message || 'host not found', data: report });
    }
    res.json({ status: 'success', data: report });
  } catch (err) {
    logger.error('[host-capacity] report failed', { host: req.params.host, error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;

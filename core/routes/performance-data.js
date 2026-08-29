'use strict';
/**
 * Performance Data Routes — Load Tests & Baselines
 *
 * CRUD for load test imports and baseline management.
 * Extracted from performance.js — mounted via router.use() in performance.js.
 *
 * Routes:
 *   GET  /load-tests
 *   POST /load-tests
 *   GET  /baselines
 *   POST /baselines
 *   GET  /baseline-compare
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const PerformanceLoadTest = require('../models/PerformanceLoadTest');
const PerformanceBaseline = require('../models/PerformanceBaseline');
const PerformanceSnapshot = require('../models/PerformanceSnapshot');
const artilleryParser = require('../src/services/artilleryParser');
const { calculateDiff } = require('./performance-helpers');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

// ── Load Tests ──────────────────────────────────────────────────────────────

/**
 * GET /api/performance/load-tests
 *
 * List load test history with optional filtering.
 * Query params: limit (default: 20), scenario
 */
router.get('/load-tests', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const scenario = req.query.scenario;

    logger.info('Fetching load test history', { limit, scenario });

    const tests = await PerformanceLoadTest.findRecentByScenario(scenario, limit);

    res.json({
      status: 'success',
      data: {
        tests,
        count: tests.length
      }
    });
  } catch (err) {
    logger.error('Load test fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/performance/load-tests
 *
 * Import Artillery JSON report and create load test record.
 * Body: { name, scenario, raw_report, timestamp }
 */
router.post('/load-tests', async (req, res) => {
  try {
    const { name, scenario, raw_report, timestamp } = req.body;

    if (!name) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: name'
      });
    }

    if (!raw_report) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: raw_report'
      });
    }

    logger.info('Importing Artillery report', { name, scenario });

    const validation = artilleryParser.validateReport(raw_report);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid Artillery report',
        errors: validation.errors
      });
    }

    const parsed = artilleryParser.parseArtilleryReport(raw_report);

    const loadTest = new PerformanceLoadTest({
      name,
      scenario: scenario || 'unknown',
      config: parsed.config,
      summary: parsed.summary,
      latency: parsed.latency,
      codes: parsed.codes,
      error_counts: parsed.error_counts,
      raw_report,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    });

    await loadTest.save();

    logger.info('Load test imported successfully', {
      id: loadTest._id,
      name: loadTest.name,
      requests: parsed.summary.requests_completed
    });

    res.status(201).json({
      status: 'success',
      data: {
        id: loadTest._id,
        name: loadTest.name,
        scenario: loadTest.scenario,
        summary: loadTest.summary,
        latency: loadTest.latency
      }
    });
  } catch (err) {
    logger.error('Load test import failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

// ── Baselines ────────────────────────────────────────────────────────────────

/**
 * GET /api/performance/baselines
 *
 * List all performance baselines.
 */
router.get('/baselines', async (req, res) => {
  try {
    logger.info('Fetching performance baselines');

    const baselines = await PerformanceBaseline.listAll();

    res.json({
      status: 'success',
      data: {
        baselines,
        count: baselines.length
      }
    });
  } catch (err) {
    logger.error('Baselines fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/performance/baselines/:id/activate
 *
 * Make one baseline the active comparison target. The UI has always had
 * this button; the route did not exist, so it 404'd. Activation was only
 * reachable via the `activate` flag at creation time.
 */
router.post('/baselines/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await PerformanceBaseline.findById(id).lean();
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Baseline not found' });
    }

    // setActive deactivates every other baseline in the same operation.
    await PerformanceBaseline.setActive(id);
    const baseline = await PerformanceBaseline.findById(id).lean();

    logger.info('Baseline activated', { id, name: baseline?.name });
    res.json({ status: 'success', data: { baseline } });
  } catch (err) {
    logger.error('Baseline activation failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/performance/baselines/:id
 *
 * Remove a baseline. Also previously a 404 from the UI.
 */
router.delete('/baselines/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!requireTypedConfirmation(req, res, 'DELETE PERFORMANCE BASELINE', id)) return;
    const deleted = await PerformanceBaseline.findByIdAndDelete(id).lean();
    if (!deleted) {
      return res.status(404).json({ status: 'error', message: 'Baseline not found' });
    }

    logger.info('Baseline deleted', { id, name: deleted.name, wasActive: !!deleted.active });
    res.json({ status: 'success', data: { id, name: deleted.name, was_active: !!deleted.active } });
  } catch (err) {
    logger.error('Baseline deletion failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/performance/baselines
 *
 * Create new performance baseline.
 * Body: { name, description, metrics, endpoints, source, source_test_id, activate, loadTestId }
 */
router.post('/baselines', async (req, res) => {
  try {
    const { name, description, metrics, endpoints, source, source_test_id, activate, loadTestId } = req.body;

    if (!name) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: name'
      });
    }

    let resolvedMetrics = metrics;
    let resolvedSourceTestId = source_test_id || loadTestId;

    if (!resolvedMetrics) {
      if (resolvedSourceTestId) {
        const loadTest = await PerformanceLoadTest.findById(resolvedSourceTestId);
        if (!loadTest) {
          return res.status(404).json({
            status: 'error',
            message: 'Load test not found'
          });
        }
        resolvedMetrics = {
          avg_response_time: loadTest.latency?.median || 0,
          p95_latency: loadTest.latency?.p95 || 0,
          error_rate: loadTest.summary?.error_rate || 0,
          throughput_rps: loadTest.summary?.rps_mean || 0
        };
      } else {
        return res.status(400).json({
          status: 'error',
          message: 'Missing required metrics or loadTestId'
        });
      }
    }

    if (
      resolvedMetrics.avg_response_time === undefined ||
      resolvedMetrics.p95_latency === undefined ||
      resolvedMetrics.error_rate === undefined ||
      resolvedMetrics.throughput_rps === undefined
    ) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required metrics: avg_response_time, p95_latency, error_rate, throughput_rps'
      });
    }

    logger.info('Creating performance baseline', { name, source });

    const baseline = new PerformanceBaseline({
      name,
      description,
      metrics: resolvedMetrics,
      endpoints: endpoints || [],
      source: source || (resolvedSourceTestId ? 'load_test' : 'manual'),
      source_test_id: resolvedSourceTestId
    });

    await baseline.save();

    if (activate) {
      await PerformanceBaseline.setActive(baseline._id);
      baseline.active = true;
    }

    logger.info('Baseline created successfully', {
      id: baseline._id,
      name: baseline.name,
      active: baseline.active
    });

    res.status(201).json({
      status: 'success',
      data: baseline
    });
  } catch (err) {
    logger.error('Baseline creation failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

// ── Baseline Compare ─────────────────────────────────────────────────────────

/**
 * GET /api/performance/baseline-compare
 *
 * Compare current metrics against a baseline.
 * Query params: baseline_id (optional), hours (default: 24)
 */
router.get('/baseline-compare', async (req, res) => {
  try {
    const baselineId = req.query.baseline_id;
    const hours = parseInt(req.query.hours, 10) || 24;

    logger.info('Comparing against baseline', { baselineId, hours });

    let baseline;
    if (baselineId) {
      baseline = await PerformanceBaseline.findById(baselineId);
    } else {
      baseline = await PerformanceBaseline.getActive();
    }

    if (!baseline) {
      return res.status(404).json({
        status: 'error',
        message: 'No baseline found'
      });
    }

    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    const currentMetrics = await PerformanceSnapshot.getAggregatedMetrics(startDate, new Date());

    if (!currentMetrics) {
      return res.status(404).json({
        status: 'error',
        message: 'No current metrics available'
      });
    }

    const comparison = {
      baseline: {
        name: baseline.name,
        metrics: baseline.metrics
      },
      current: {
        avg_response_time: currentMetrics.avg_latency,
        p95_latency: currentMetrics.avg_p95,
        error_rate: currentMetrics.error_rate,
        throughput_rps: (currentMetrics.total_requests / (hours * 3600)).toFixed(2)
      },
      diff_percentage: {
        avg_response_time: calculateDiff(currentMetrics.avg_latency, baseline.metrics.avg_response_time),
        p95_latency: calculateDiff(currentMetrics.avg_p95, baseline.metrics.p95_latency),
        error_rate: calculateDiff(currentMetrics.error_rate, baseline.metrics.error_rate),
        throughput_rps: calculateDiff(
          currentMetrics.total_requests / (hours * 3600),
          baseline.metrics.throughput_rps
        )
      }
    };

    const regressions = [];

    if (currentMetrics.avg_p95 > baseline.metrics.p95_latency * 1.2) {
      regressions.push({
        metric: 'p95_latency',
        threshold: '20% increase',
        current: currentMetrics.avg_p95,
        baseline: baseline.metrics.p95_latency
      });
    }

    if (currentMetrics.error_rate > baseline.metrics.error_rate * 2) {
      regressions.push({
        metric: 'error_rate',
        threshold: '2x increase',
        current: currentMetrics.error_rate,
        baseline: baseline.metrics.error_rate
      });
    }

    comparison.regression_detected = regressions.length > 0;
    comparison.regressions = regressions;

    res.json({
      status: 'success',
      data: comparison
    });
  } catch (err) {
    logger.error('Baseline comparison failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

module.exports = router;

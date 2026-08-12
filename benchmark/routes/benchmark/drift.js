/**
 * 0129 — Drift routes
 *
 * GET  /api/benchmark/drift              — current per-category drift status
 * POST /api/benchmark/drift/compute      — recompute + optionally emit AppEvents
 * GET  /api/benchmark/drift/baseline     — currently active baseline
 * POST /api/benchmark/drift/baseline     — ratify a new baseline from a sprint
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const {
    computeDrift,
    ratifyBaseline
} = require('../../src/services/benchmark/judgeDriftService');
const CalibrationBaseline = require('../../models/CalibrationBaseline');

/**
 * GET /api/benchmark/drift
 * Returns current per-category ρ vs baseline with drift classification.
 * Query: per_category (default 30)
 */
router.get('/drift', async (req, res) => {
    try {
        const perCategory = Math.max(2, parseInt(req.query.per_category, 10) || 30);
        const payload = await computeDrift({ perCategory, emitEvents: false });
        res.json({ status: 'success', data: payload });
    } catch (err) {
        logger.error('drift compute failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/drift/compute
 * Same as GET but also emits AppEvents when triggered. Intended to be called
 * from cron / quarterly boundary, not from UI.
 * Body: { per_category?: number, emit?: boolean }
 */
router.post('/drift/compute', async (req, res) => {
    try {
        const perCategory = Math.max(2, parseInt(req.body?.per_category, 10) || 30);
        const emit = req.body?.emit !== false;
        const payload = await computeDrift({ perCategory, emitEvents: emit });
        res.json({ status: 'success', data: payload });
    } catch (err) {
        logger.error('drift compute POST failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/drift/baseline
 * Returns the currently active baseline (if any).
 */
router.get('/drift/baseline', async (req, res) => {
    try {
        const active = await CalibrationBaseline.getActive();
        res.json({ status: 'success', data: active });
    } catch (err) {
        logger.error('baseline fetch failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/drift/baseline
 * Ratify a new baseline. Body: {
 *   label, source_sprint?, categories:[{category, rho, sample_size, mae?, bias?}],
 *   overall_rho?, overall_sample_size?, notes?
 * }
 */
router.post('/drift/baseline', async (req, res) => {
    try {
        const doc = await ratifyBaseline(req.body || {});
        res.status(201).json({ status: 'success', data: doc });
    } catch (err) {
        logger.error('baseline ratify failed', { error: err.message });
        res.status(400).json({ status: 'error', error: err.message });
    }
});

module.exports = router;

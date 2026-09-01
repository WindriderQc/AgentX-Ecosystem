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
    ratifyBaseline,
    requireJudgeIdentityFingerprint
} = require('../../src/services/benchmark/judgeDriftService');
const CalibrationBaseline = require('../../models/CalibrationBaseline');

/**
 * GET /api/benchmark/drift
 * Returns current per-category ρ vs baseline with drift classification.
 * Query: judge_identity_fingerprint (required), per_category (default 30)
 */
router.get('/drift', async (req, res) => {
    try {
        const perCategory = Math.min(1000, Math.max(5, parseInt(req.query.per_category, 10) || 30));
        const judgeIdentityFingerprint = requireJudgeIdentityFingerprint(
            req.query.judge_identity_fingerprint
        );
        const payload = await computeDrift({
            perCategory,
            emitEvents: false,
            judge_identity_fingerprint: judgeIdentityFingerprint
        });
        res.json({ status: 'success', data: payload });
    } catch (err) {
        logger.error('drift compute failed', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/drift/compute
 * Same as GET but also emits AppEvents when triggered. Intended to be called
 * from cron / quarterly boundary, not from UI.
 * Body: { judge_identity_fingerprint: string, per_category?: number, emit?: boolean }
 */
router.post('/drift/compute', async (req, res) => {
    try {
        const perCategory = Math.min(1000, Math.max(5, parseInt(req.body?.per_category, 10) || 30));
        const emit = req.body?.emit !== false;
        const judgeIdentityFingerprint = requireJudgeIdentityFingerprint(
            req.body?.judge_identity_fingerprint
        );
        const payload = await computeDrift({
            perCategory,
            emitEvents: emit,
            judge_identity_fingerprint: judgeIdentityFingerprint
        });
        res.json({ status: 'success', data: payload });
    } catch (err) {
        logger.error('drift compute POST failed', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * GET /api/benchmark/drift/baseline
 * Returns the active baseline for the required exact judge identity (if any).
 */
router.get('/drift/baseline', async (req, res) => {
    try {
        const judgeIdentityFingerprint = requireJudgeIdentityFingerprint(
            req.query.judge_identity_fingerprint
        );
        const active = await CalibrationBaseline.getActive(judgeIdentityFingerprint);
        res.json({ status: 'success', data: active });
    } catch (err) {
        logger.error('baseline fetch failed', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/drift/baseline
 * Ratify a new baseline. Body: {
 *   label, judge_identity_fingerprint, source_sprint?,
 *   categories:[{category, rho, sample_size, mae?, bias?}],
 *   overall_rho?, overall_sample_size?, notes?
 * }
 */
router.post('/drift/baseline', async (req, res) => {
    try {
        const body = req.body || {};
        const judgeIdentityFingerprint = requireJudgeIdentityFingerprint(
            body.judge_identity_fingerprint
        );
        const doc = await ratifyBaseline({
            ...body,
            judge_identity_fingerprint: judgeIdentityFingerprint
        });
        res.status(201).json({ status: 'success', data: doc });
    } catch (err) {
        logger.error('baseline ratify failed', { error: err.message });
        res.status(err.statusCode || 400).json({ status: 'error', code: err.code, error: err.message });
    }
});

module.exports = router;

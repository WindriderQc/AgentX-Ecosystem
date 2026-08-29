/**
 * Benchmark Routes - Scoring Profile
 * GET  /api/benchmark/scoring-profile         — read current profile + defaults
 * PUT  /api/benchmark/scoring-profile         — update with partial overrides
 * POST /api/benchmark/scoring-profile/reset   — remove overrides, restore defaults
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const {
    getScoringProfile,
    getDefaultScoringProfile,
    updateScoringProfile,
    resetScoringProfile
} = require('../../src/services/benchmark/scoringProfile');
const { requireExactConfirmation } = require('../../src/helpers/exactConfirmation');

const SCORING_PROFILE_RESET_CONFIRMATION = 'RESET SCORING PROFILE';

/**
 * GET /api/benchmark/scoring-profile
 * Returns current merged profile and defaults for comparison
 */
router.get('/scoring-profile', async (req, res) => {
    try {
        const [current, defaults] = await Promise.all([
            getScoringProfile(),
            Promise.resolve(getDefaultScoringProfile())
        ]);
        res.json({
            status: 'success',
            data: {
                ...current,
                _defaults: defaults
            }
        });
    } catch (err) {
        logger.error('Failed to fetch scoring profile', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * PUT /api/benchmark/scoring-profile
 * Accepts partial overrides, validates, stores. Returns merged profile.
 */
router.put('/scoring-profile', async (req, res) => {
    try {
        const overrides = req.body;
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
            return res.status(400).json({ status: 'error', error: 'Request body must be a JSON object' });
        }

        const profile = await updateScoringProfile(overrides);
        res.json({
            status: 'success',
            data: profile,
            message: 'Scoring profile updated. Changes apply to future leaderboard calculations.'
        });
    } catch (err) {
        if (err.message && err.message.startsWith('Validation failed')) {
            return res.status(400).json({ status: 'error', error: err.message });
        }
        logger.error('Failed to update scoring profile', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/scoring-profile/reset
 * Deletes stored overrides; returns default profile.
 */
router.post('/scoring-profile/reset', async (req, res) => {
    try {
        if (!requireExactConfirmation(req, res, SCORING_PROFILE_RESET_CONFIRMATION)) return;

        const defaults = await resetScoringProfile();
        res.json({
            status: 'success',
            data: defaults,
            message: 'Scoring profile reset to defaults.'
        });
    } catch (err) {
        logger.error('Failed to reset scoring profile', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;

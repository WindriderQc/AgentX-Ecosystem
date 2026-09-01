// routes/benchmark/efficiency.js
const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { buildConsumerTrustVerdict } = require('../../src/services/benchmark/trustedEvidenceCohort');

router.get('/efficiency-map', async (req, res) => {
    try {
        const data = await benchmarkService.getEfficiencyMap();
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        const trustVerdict = buildConsumerTrustVerdict({
            trustScope: 'exploratory',
            rows: entries.map((entry) => ({
                model: entry.model,
                host: entry.host,
                quality_score: entry.efficiencyScore
            }))
        });
        res.json({ status: 'success', data: { ...(data || {}), entries, trustVerdict } });
    } catch (err) {
        logger.error('Failed to fetch efficiency map', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;

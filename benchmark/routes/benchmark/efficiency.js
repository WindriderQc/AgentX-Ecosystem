// routes/benchmark/efficiency.js
const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');

router.get('/efficiency-map', async (req, res) => {
    try {
        const data = await benchmarkService.getEfficiencyMap();
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch efficiency map', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;

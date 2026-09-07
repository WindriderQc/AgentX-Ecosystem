'use strict';

const express = require('express');
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');

const router = express.Router();


router.post('/trust-batches/:specId/start', async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            status: 'error',
            code: 'BENCHMARK_TRUST_RAW_CONTEXT_FORBIDDEN',
            error: 'Strict Trust launch accepts only an immutable server-side campaign spec reference'
        });
    }
    try {
        const data = await benchmarkService.startTrustBatch(String(req.params.specId || ''));
        return res.status(202).json({ status: 'success', data });
    } catch (error) {
        logger.error('Failed to start strict Benchmark Trust campaign', {
            code: error.code || 'BENCHMARK_TRUST_CAMPAIGN_START_FAILED',
            error: error.message
        });
        return res.status(error.statusCode || 500).json({
            status: 'error',
            code: error.code || 'BENCHMARK_TRUST_CAMPAIGN_START_FAILED',
            error: error.message
        });
    }
});

module.exports = router;

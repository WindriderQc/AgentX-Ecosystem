'use strict';

const express = require('express');
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { safeTokenMatch } = require('../../../shared/apiHostGuard');

const router = express.Router();

function operatorLaunchAuthorized(req, env = process.env) {
    const authorization = String(req.get?.('authorization') || '');
    const bearer = authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : '';
    const presented = bearer || req.get?.('x-agentx-operator-token') || '';
    return safeTokenMatch(env.AGENTX_OPERATOR_TOKEN || env.AGENTX_ADMIN_TOKEN, presented);
}

router.post('/trust-batches/:specId/start', async (req, res) => {
    if (!operatorLaunchAuthorized(req)) {
        return res.status(403).json({
            status: 'error',
            code: 'BENCHMARK_TRUST_OPERATOR_AUTH_REQUIRED',
            error: 'Strict Trust launch requires the configured Product operator token'
        });
    }
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

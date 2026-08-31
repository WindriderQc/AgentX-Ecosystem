'use strict';

const express = require('express');
const logger = require('../../config/logger');
const {
    DEFAULT_BATCH_READ_LIMIT,
    getBenchmarkTrustReceiptById,
    listBenchmarkTrustReceiptsBySourceBatch
} = require('../../src/services/benchmark/benchmarkTrustReceiptStore');

const router = express.Router();

function sendReceiptError(res, error, operation) {
    logger.error(`Failed to ${operation} benchmark trust receipt`, {
        code: error.code,
        error: error.message
    });
    return res.status(error.statusCode || 500).json({
        status: 'error',
        code: error.code || 'BENCHMARK_TRUST_RECEIPT_READ_FAILED',
        error: error.message
    });
}

router.get('/trust-receipts', async (req, res) => {
    try {
        const sourceBatchId = req.query.source_batch_id;
        if (typeof sourceBatchId !== 'string' || sourceBatchId.length === 0) {
            return res.status(400).json({
                status: 'error',
                code: 'SOURCE_BATCH_ID_REQUIRED',
                error: 'source_batch_id is required'
            });
        }
        const limit = req.query.limit === undefined
            ? DEFAULT_BATCH_READ_LIMIT
            : Number(req.query.limit);
        const receipts = await listBenchmarkTrustReceiptsBySourceBatch(sourceBatchId, { limit });
        return res.json({
            status: 'success',
            data: {
                receipts,
                count: receipts.length
            }
        });
    } catch (error) {
        return sendReceiptError(res, error, 'list');
    }
});

router.get('/trust-receipts/:receiptId', async (req, res) => {
    try {
        const receipt = await getBenchmarkTrustReceiptById(req.params.receiptId);
        if (!receipt) {
            return res.status(404).json({
                status: 'error',
                code: 'BENCHMARK_TRUST_RECEIPT_NOT_FOUND',
                error: 'Benchmark trust receipt not found'
            });
        }
        return res.json({ status: 'success', data: receipt });
    } catch (error) {
        return sendReceiptError(res, error, 'read');
    }
});

module.exports = router;

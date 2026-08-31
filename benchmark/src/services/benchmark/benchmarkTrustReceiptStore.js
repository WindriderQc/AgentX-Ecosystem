'use strict';

const BenchmarkTrustReceipt = require('../../../models/BenchmarkTrustReceipt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;
const MAX_BATCH_READ_LIMIT = 100;
const DEFAULT_BATCH_READ_LIMIT = 20;

function storeError(code, message, statusCode = 400, cause = null) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    if (cause) error.cause = cause;
    return error;
}

function isDuplicateKey(error) {
    return error?.code === 11000 || error?.name === 'MongoServerError' && error?.code === 11000;
}

function requireReceiptId(receiptId) {
    if (typeof receiptId !== 'string' || !RECEIPT_ID_PATTERN.test(receiptId)) {
        throw storeError(
            'INVALID_RECEIPT_ID',
            'receiptId must be a 64-character lowercase SHA-256 fingerprint'
        );
    }
    return receiptId;
}

function requireSourceBatchId(sourceBatchId) {
    if (typeof sourceBatchId !== 'string' || !SOURCE_BATCH_ID_PATTERN.test(sourceBatchId)) {
        throw storeError(
            'INVALID_SOURCE_BATCH_ID',
            'sourceBatchId must be batch_<32 lowercase hex>'
        );
    }
    return sourceBatchId;
}

function requireReadLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_READ_LIMIT) {
        throw storeError(
            'INVALID_READ_LIMIT',
            `limit must be an integer between 1 and ${MAX_BATCH_READ_LIMIT}`
        );
    }
    return limit;
}

/**
 * Insert one verified content-addressed receipt.
 *
 * The unique receiptId index arbitrates concurrent creators. A loser performs
 * an exact read-and-compare; it is idempotent only when the already stored row
 * is intact and byte-for-byte canonical-equivalent. No upsert or update path
 * exists for this collection.
 */
async function storeBenchmarkTrustReceipt(rawReceipt) {
    const record = BenchmarkTrustReceipt.buildStoredRecord(rawReceipt);
    const linkedBatchExists = await BenchmarkBatch.exists({
        trust_batch_id: record.sourceBatchId
    });
    if (!linkedBatchExists) {
        throw storeError(
            'BENCHMARK_TRUST_SOURCE_BATCH_NOT_FOUND',
            'receipt sourceBatchId is not linked to a durable Benchmark batch',
            409
        );
    }
    await BenchmarkTrustReceipt.init();

    try {
        const created = await BenchmarkTrustReceipt.create(record);
        return {
            created: true,
            receipt: BenchmarkTrustReceipt.verifyStoredRecord(created)
        };
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;

        const existing = await BenchmarkTrustReceipt.findOne({ receiptId: record.receiptId }).lean();
        if (!existing) {
            throw storeError(
                'BENCHMARK_TRUST_RECEIPT_CONFLICT',
                'receiptId collided but the existing receipt could not be read',
                409,
                error
            );
        }

        const verifiedExisting = BenchmarkTrustReceipt.verifyStoredRecord(existing);
        if (existing.canonicalPayload !== record.canonicalPayload) {
            throw storeError(
                'BENCHMARK_TRUST_RECEIPT_CONFLICT',
                'receiptId already exists with different canonical content',
                409
            );
        }
        return { created: false, receipt: verifiedExisting };
    }
}

async function getBenchmarkTrustReceiptById(receiptId) {
    const id = requireReceiptId(receiptId);
    const stored = await BenchmarkTrustReceipt.findOne({ receiptId: id }).lean();
    return stored ? BenchmarkTrustReceipt.verifyStoredRecord(stored) : null;
}

async function listBenchmarkTrustReceiptsBySourceBatch(
    sourceBatchId,
    { limit = DEFAULT_BATCH_READ_LIMIT } = {}
) {
    const exactSourceBatchId = requireSourceBatchId(sourceBatchId);
    const boundedLimit = requireReadLimit(limit);
    const stored = await BenchmarkTrustReceipt.find({ sourceBatchId: exactSourceBatchId })
        .sort({ issuedAt: -1, receiptId: 1 })
        .limit(boundedLimit)
        .lean();
    return stored.map((record) => BenchmarkTrustReceipt.verifyStoredRecord(record));
}

module.exports = {
    DEFAULT_BATCH_READ_LIMIT,
    MAX_BATCH_READ_LIMIT,
    storeBenchmarkTrustReceipt,
    getBenchmarkTrustReceiptById,
    listBenchmarkTrustReceiptsBySourceBatch
};

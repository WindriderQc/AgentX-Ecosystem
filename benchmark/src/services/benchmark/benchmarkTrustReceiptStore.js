'use strict';

const BenchmarkTrustReceipt = require('../../../models/BenchmarkTrustReceipt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { withBenchmarkTrustEvidenceLock } = require('./benchmarkTrustEvidenceLock');
const { verifyBenchmarkTrustSourceEvidence } = require('./benchmarkTrustSourceEvidence');

const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;
const MAX_BATCH_READ_LIMIT = 100;
const DEFAULT_BATCH_READ_LIMIT = 20;
const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

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
async function storeBenchmarkTrustReceipt(rawReceipt, options = {}) {
    const record = BenchmarkTrustReceipt.buildStoredRecord(rawReceipt);
    if (Object.prototype.hasOwnProperty.call(options || {}, 'verifySourceEvidence')) {
        throw storeError(
            'BENCHMARK_TRUST_LEGACY_SOURCE_VERIFIER_FORBIDDEN',
            'caller-supplied source verification cannot replace Product canonical verification',
            409
        );
    }
    const verifyExternalSourceEvidence = options?.verifyExternalSourceEvidence;
    if (verifyExternalSourceEvidence != null && typeof verifyExternalSourceEvidence !== 'function') {
        throw storeError(
            'BENCHMARK_TRUST_EXTERNAL_SOURCE_VERIFIER_INVALID',
            'verifyExternalSourceEvidence must be a function when supplied',
            409
        );
    }
    return withBenchmarkTrustEvidenceLock('store-benchmark-trust-receipt', async () => {
        const linkedBatch = await BenchmarkBatch.findOne({
            trust_batch_id: record.sourceBatchId
        }).select('_id status started_at execution_started_at completed_at updated_at trust_evidence_sealed trust_batch_id +trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at').lean();
        if (!linkedBatch) {
            throw storeError(
                'BENCHMARK_TRUST_SOURCE_BATCH_NOT_FOUND',
                'receipt sourceBatchId is not linked to a durable Benchmark batch',
                409
            );
        }
        if (!TERMINAL_BATCH_STATUSES.has(linkedBatch.status)) {
            throw storeError(
                'BENCHMARK_TRUST_SOURCE_BATCH_NOT_TERMINAL',
                'receipt source batch must be terminal before evidence can be sealed',
                409
            );
        }
        if (
            record.payload.axes.evidenceStatus === 'complete'
            && linkedBatch.status !== 'completed'
        ) {
            throw storeError(
                'BENCHMARK_TRUST_COMPLETE_SOURCE_BATCH_NOT_COMPLETED',
                'complete receipt evidence requires a completed source batch',
                409
            );
        }

        const sourceResultCount = await BenchmarkResult.countDocuments({ batch_id: linkedBatch._id });
        // Excluded rows remain bound evidence. The durable source must retain
        // the complete preregistered inventory, not only decision-included rows.
        const expectedResultCount = record.payload.execution.expectedResultCount;
        if (sourceResultCount !== expectedResultCount) {
            throw storeError(
                'BENCHMARK_TRUST_SOURCE_RESULTS_MISMATCH',
                'receipt source batch does not contain the exact declared complete result inventory',
                409
            );
        }
        await BenchmarkTrustReceipt.init();

        const sealedResultCount = await BenchmarkResult.countDocuments({
            batch_id: linkedBatch._id,
            trust_evidence_sealed: true
        });
        if (sealedResultCount !== 0 && sealedResultCount !== sourceResultCount) {
            throw storeError(
                'BENCHMARK_TRUST_SOURCE_EVIDENCE_PARTIALLY_SEALED',
                'receipt source batch has a partially sealed result inventory',
                409
            );
        }
        const batchAlreadySealed = linkedBatch.trust_evidence_sealed === true;
        if (batchAlreadySealed !== (sealedResultCount === sourceResultCount)) {
            throw storeError(
                'BENCHMARK_TRUST_SOURCE_EVIDENCE_PARTIALLY_SEALED',
                'receipt source batch and result inventory disagree on seal state',
                409
            );
        }
        let sealedByThisCall = false;
        if (!batchAlreadySealed) {
            const batchSealResult = await BenchmarkBatch.collection.updateOne(
                {
                    _id: linkedBatch._id,
                    status: linkedBatch.status,
                    trust_batch_id: record.sourceBatchId,
                    started_at: linkedBatch.started_at ?? null,
                    execution_started_at: linkedBatch.execution_started_at ?? null,
                    completed_at: linkedBatch.completed_at ?? null,
                    updated_at: linkedBatch.updated_at ?? null,
                    trust_evidence_finalized_at: linkedBatch.trust_evidence_finalized_at ?? null,
                    trust_evidence_sealed: { $ne: true }
                },
                { $set: { trust_evidence_sealed: true } }
            );
            if (batchSealResult.matchedCount !== 1) {
                throw storeError(
                    'BENCHMARK_TRUST_SOURCE_EVIDENCE_SEAL_MISMATCH',
                    'receipt source batch changed while it was being sealed',
                    409
                );
            }
            const sealResult = await BenchmarkResult.collection.updateMany(
                { batch_id: linkedBatch._id },
                { $set: { trust_evidence_sealed: true } }
            );
            if (sealResult.matchedCount !== sourceResultCount) {
                await BenchmarkBatch.collection.updateOne(
                    { _id: linkedBatch._id, trust_evidence_sealed: true },
                    { $set: { trust_evidence_sealed: false } }
                );
                await BenchmarkResult.collection.updateMany(
                    { batch_id: linkedBatch._id, trust_evidence_sealed: true },
                    { $set: { trust_evidence_sealed: false } }
                );
                throw storeError(
                    'BENCHMARK_TRUST_SOURCE_EVIDENCE_SEAL_MISMATCH',
                    'receipt source result inventory changed while it was being sealed',
                    409
                );
            }
            sealedByThisCall = true;
        }

        async function rollbackSealIfUnreferenced() {
            if (!sealedByThisCall) return;
            const sourceReceiptCount = await BenchmarkTrustReceipt.countDocuments({
                sourceBatchId: record.sourceBatchId
            });
            if (sourceReceiptCount === 0) {
                await BenchmarkBatch.collection.updateOne(
                    { _id: linkedBatch._id, trust_evidence_sealed: true },
                    { $set: { trust_evidence_sealed: false } }
                );
                await BenchmarkResult.collection.updateMany(
                    { batch_id: linkedBatch._id, trust_evidence_sealed: true },
                    { $set: { trust_evidence_sealed: false } }
                );
            }
        }

        // Verify only after sealing. Query mutations carry a fail-closed
        // `trust_evidence_sealed != true` predicate, so an update that wins
        // before the seal is observed here and an update that loses cannot
        // match after it. This closes verifier-to-insert TOCTOU.
        const finalResultCount = await BenchmarkResult.countDocuments({ batch_id: linkedBatch._id });
        const finalSealedCount = await BenchmarkResult.countDocuments({
            batch_id: linkedBatch._id,
            trust_evidence_sealed: true
        });
        const finalBatchSealed = await BenchmarkBatch.exists({
            _id: linkedBatch._id,
            status: linkedBatch.status,
            trust_batch_id: record.sourceBatchId,
            started_at: linkedBatch.started_at ?? null,
            execution_started_at: linkedBatch.execution_started_at ?? null,
            completed_at: linkedBatch.completed_at ?? null,
            updated_at: linkedBatch.updated_at ?? null,
            trust_evidence_finalized_at: linkedBatch.trust_evidence_finalized_at ?? null,
            trust_evidence_sealed: true
        });
        if (
            !finalBatchSealed
            || finalResultCount !== sourceResultCount
            || finalSealedCount !== sourceResultCount
        ) {
            await rollbackSealIfUnreferenced();
            throw storeError(
                'BENCHMARK_TRUST_SOURCE_EVIDENCE_SEAL_MISMATCH',
                'receipt source result inventory changed while it was being sealed',
                409
            );
        }

        let canonicalEvidence;
        try {
            canonicalEvidence = await verifyBenchmarkTrustSourceEvidence({
                receipt: record.payload,
                batch: { ...linkedBatch, trust_evidence_sealed: true },
                now: new Date()
            });
        } catch (error) {
            await rollbackSealIfUnreferenced();
            throw error;
        }

        // Environment-specific verification may strengthen Product evidence,
        // but it can never replace the canonical Mongo/context recomputation.
        if (verifyExternalSourceEvidence) {
            let externalVerified = false;
            try {
                externalVerified = await verifyExternalSourceEvidence({
                    receipt: record.payload,
                    batch: { ...linkedBatch, trust_evidence_sealed: true },
                    sourceResultCount: finalResultCount,
                    canonicalEvidence
                }) === true;
            } catch (_error) {
                externalVerified = false;
            }
            if (!externalVerified) {
                await rollbackSealIfUnreferenced();
                throw storeError(
                    'BENCHMARK_TRUST_EXTERNAL_SOURCE_EVIDENCE_NOT_VERIFIED',
                    'external source evidence verification failed after canonical verification',
                    409
                );
            }
        }

        try {
            const created = await BenchmarkTrustReceipt.create(record);
            return {
                created: true,
                receipt: BenchmarkTrustReceipt.verifyStoredRecord(created)
            };
        } catch (error) {
            if (!isDuplicateKey(error)) {
                await rollbackSealIfUnreferenced();
                throw error;
            }

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
    });
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

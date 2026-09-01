'use strict';

const mongoose = require('mongoose');
const {
    CLAIM_SCOPES,
    DECISION_OUTCOMES,
    EVIDENCE_STATUSES,
    FRESHNESS_STATUSES,
    assertBenchmarkTrustReceipt,
    serializeBenchmarkTrustReceipt
} = require('../../shared/benchmarkTrustReceipt');

const RECEIPT_ID_PATTERN = /^[0-9a-f]{64}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;
const IMMUTABLE_ERROR_CODE = 'BENCHMARK_TRUST_RECEIPT_IMMUTABLE';
const TAMPER_ERROR_CODE = 'BENCHMARK_TRUST_RECEIPT_TAMPERED';

function receiptModelError(code, message, statusCode = 409, cause = null) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    if (cause) error.cause = cause;
    return error;
}

function immutableOperationError(operation) {
    return receiptModelError(
        IMMUTABLE_ERROR_CODE,
        `Benchmark trust receipts are append-only; ${operation} is forbidden`,
        405
    );
}

function tamperError(message, cause = null) {
    return receiptModelError(TAMPER_ERROR_CODE, message, 409, cause);
}

function buildStoredRecord(rawReceipt) {
    const receipt = assertBenchmarkTrustReceipt(rawReceipt);
    const canonicalPayload = serializeBenchmarkTrustReceipt(receipt);
    return {
        receiptId: receipt.receiptId,
        campaignId: receipt.execution.campaignId,
        sourceBatchId: receipt.execution.sourceBatchId,
        evidenceStatus: receipt.axes.evidenceStatus,
        decisionOutcome: receipt.axes.decisionOutcome,
        freshnessStatus: receipt.axes.freshnessStatus,
        claimScope: receipt.claimScope,
        decisionFingerprint: receipt.statistics.decisionFingerprint,
        judgeQualificationReceiptId: receipt.judge.qualificationReceiptId,
        issuedAt: new Date(receipt.createdAt),
        validUntil: new Date(receipt.validUntil),
        payload: JSON.parse(canonicalPayload),
        canonicalPayload
    };
}

function verifyStoredRecord(rawRecord) {
    const record = rawRecord && typeof rawRecord.toObject === 'function'
        ? rawRecord.toObject({ depopulate: true, flattenMaps: true, versionKey: false })
        : rawRecord;
    if (!record || typeof record !== 'object') {
        throw tamperError('Stored benchmark trust receipt is not an object');
    }

    let receipt;
    let expected;
    try {
        receipt = assertBenchmarkTrustReceipt(record.payload);
        expected = buildStoredRecord(receipt);
    } catch (error) {
        throw tamperError('Stored benchmark trust receipt payload failed verification', error);
    }

    const issuedAtMillis = record.issuedAt instanceof Date
        ? record.issuedAt.getTime()
        : new Date(record.issuedAt).getTime();
    const validUntilMillis = record.validUntil instanceof Date
        ? record.validUntil.getTime()
        : new Date(record.validUntil).getTime();
    const projectionMatches = record.receiptId === expected.receiptId
        && record.campaignId === expected.campaignId
        && record.sourceBatchId === expected.sourceBatchId
        && record.evidenceStatus === expected.evidenceStatus
        && record.decisionOutcome === expected.decisionOutcome
        && record.freshnessStatus === expected.freshnessStatus
        && record.claimScope === expected.claimScope
        && record.decisionFingerprint === expected.decisionFingerprint
        && record.judgeQualificationReceiptId === expected.judgeQualificationReceiptId
        && issuedAtMillis === expected.issuedAt.getTime()
        && validUntilMillis === expected.validUntil.getTime();

    if (!projectionMatches) {
        throw tamperError('Stored benchmark trust receipt projections do not match the verified payload');
    }
    if (record.canonicalPayload !== expected.canonicalPayload) {
        throw tamperError('Stored benchmark trust receipt canonical payload does not match the verified payload');
    }
    return receipt;
}

const immutableString = (options = {}) => ({
    type: String,
    required: true,
    immutable: true,
    ...options
});

const BenchmarkTrustReceiptSchema = new mongoose.Schema({
    receiptId: immutableString({ match: RECEIPT_ID_PATTERN }),
    campaignId: immutableString(),
    sourceBatchId: immutableString({ match: SOURCE_BATCH_ID_PATTERN }),
    evidenceStatus: immutableString({ enum: EVIDENCE_STATUSES }),
    decisionOutcome: immutableString({ enum: DECISION_OUTCOMES }),
    freshnessStatus: immutableString({ enum: FRESHNESS_STATUSES }),
    claimScope: immutableString({ enum: CLAIM_SCOPES }),
    decisionFingerprint: immutableString({ match: FINGERPRINT_PATTERN }),
    judgeQualificationReceiptId: immutableString({ match: FINGERPRINT_PATTERN }),
    issuedAt: { type: Date, required: true, immutable: true },
    validUntil: { type: Date, required: true, immutable: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    canonicalPayload: immutableString(),
    storedAt: { type: Date, required: true, immutable: true, default: Date.now }
}, {
    strict: 'throw',
    minimize: false,
    versionKey: false
});

BenchmarkTrustReceiptSchema.index(
    { receiptId: 1 },
    { unique: true, name: 'uniq_benchmark_trust_receipt_id' }
);
BenchmarkTrustReceiptSchema.index(
    { sourceBatchId: 1, issuedAt: -1, receiptId: 1 },
    { name: 'benchmark_trust_receipt_source_batch_read' }
);
BenchmarkTrustReceiptSchema.index(
    { decisionFingerprint: 1, issuedAt: -1 },
    { name: 'benchmark_trust_receipt_decision_read' }
);
BenchmarkTrustReceiptSchema.index(
    { evidenceStatus: 1, freshnessStatus: 1, decisionOutcome: 1, issuedAt: -1 },
    { name: 'benchmark_trust_receipt_status_read' }
);

BenchmarkTrustReceiptSchema.pre('validate', function verifyReceiptBeforeInsert(next) {
    try {
        verifyStoredRecord(this);
        next();
    } catch (error) {
        next(error);
    }
});

BenchmarkTrustReceiptSchema.pre('save', function blockExistingDocumentSave(next) {
    if (!this.isNew) return next(immutableOperationError('save'));
    return next();
});

for (const operation of [
    'update',
    'updateOne',
    'updateMany',
    'replaceOne',
    'findOneAndUpdate',
    'findOneAndReplace',
    'findOneAndDelete',
    'findOneAndRemove',
    'deleteOne',
    'deleteMany'
]) {
    BenchmarkTrustReceiptSchema.pre(operation, function blockReceiptMutation(next) {
        next(immutableOperationError(operation));
    });
}

BenchmarkTrustReceiptSchema.pre('deleteOne', { document: true, query: false }, function blockDocumentDelete(next) {
    next(immutableOperationError('document.deleteOne'));
});

BenchmarkTrustReceiptSchema.statics.buildStoredRecord = buildStoredRecord;
BenchmarkTrustReceiptSchema.statics.verifyStoredRecord = verifyStoredRecord;

const BenchmarkTrustReceipt = mongoose.models.BenchmarkTrustReceipt
    || mongoose.model('BenchmarkTrustReceipt', BenchmarkTrustReceiptSchema);

// Mongoose 7 bulkWrite bypasses query and save middleware. Reject it at the
// model boundary so a mixed bulk operation cannot mutate an append-only row.
BenchmarkTrustReceipt.bulkWrite = async function blockedBenchmarkTrustReceiptBulkWrite() {
    throw immutableOperationError('bulkWrite');
};

BenchmarkTrustReceipt.IMMUTABLE_ERROR_CODE = IMMUTABLE_ERROR_CODE;
BenchmarkTrustReceipt.TAMPER_ERROR_CODE = TAMPER_ERROR_CODE;

module.exports = BenchmarkTrustReceipt;

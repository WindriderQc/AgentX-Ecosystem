'use strict';

const crypto = require('crypto');
const BenchmarkTrustEvidenceLock = require('../../../models/BenchmarkTrustEvidenceLock');

const LOCK_ID = 'benchmark-trust-evidence-mutation-v1';
const DEFAULT_WAIT_MS = 5000;
const RETRY_MS = 10;

function lockError(code, message, cause = null) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 409;
    if (cause) error.cause = cause;
    return error;
}

function isDuplicateKey(error) {
    return error?.code === 11000
        || (error?.name === 'MongoServerError' && error?.code === 11000);
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquireBenchmarkTrustEvidenceLock(operation, { waitMs = DEFAULT_WAIT_MS } = {}) {
    if (typeof operation !== 'string' || operation.length < 1 || operation.length > 80) {
        throw lockError('BENCHMARK_TRUST_LOCK_OPERATION_INVALID', 'Benchmark trust lock operation is invalid');
    }
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
        throw lockError('BENCHMARK_TRUST_LOCK_WAIT_INVALID', 'Benchmark trust lock wait must be between 0 and 30000ms');
    }

    const ownerToken = crypto.randomBytes(32).toString('hex');
    const deadline = Date.now() + waitMs;
    while (true) {
        try {
            await BenchmarkTrustEvidenceLock.create({
                _id: LOCK_ID,
                ownerToken,
                operation,
                acquiredAt: new Date()
            });
            return ownerToken;
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            if (Date.now() >= deadline) {
                throw lockError(
                    'BENCHMARK_TRUST_EVIDENCE_MUTATION_BUSY',
                    'Benchmark trust evidence mutation is already in progress',
                    error
                );
            }
            await wait(Math.min(RETRY_MS, Math.max(1, deadline - Date.now())));
        }
    }
}

async function releaseBenchmarkTrustEvidenceLock(ownerToken) {
    const released = await BenchmarkTrustEvidenceLock.deleteOne({ _id: LOCK_ID, ownerToken });
    if (released.deletedCount !== 1) {
        throw lockError(
            'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST',
            'Benchmark trust evidence lock ownership was lost; manual integrity review is required'
        );
    }
}

/**
 * Serialize receipt creation with every destructive mutation of its source
 * evidence. The lock deliberately has no automatic expiry: after a process
 * crash, blocking future mutation is safer than silently overlapping an owner
 * that may still be active. Recovery therefore requires explicit inspection.
 */
async function withBenchmarkTrustEvidenceLock(operation, task, options = {}) {
    if (typeof task !== 'function') {
        throw lockError('BENCHMARK_TRUST_LOCK_TASK_INVALID', 'Benchmark trust lock task must be a function');
    }
    const ownerToken = await acquireBenchmarkTrustEvidenceLock(operation, options);
    let result;
    let taskError = null;
    try {
        result = await task();
    } catch (error) {
        taskError = error;
    }

    try {
        await releaseBenchmarkTrustEvidenceLock(ownerToken);
    } catch (releaseError) {
        if (!taskError) throw releaseError;
        taskError.lockReleaseError = releaseError;
    }
    if (taskError) throw taskError;
    return result;
}

module.exports = {
    DEFAULT_WAIT_MS,
    LOCK_ID,
    acquireBenchmarkTrustEvidenceLock,
    releaseBenchmarkTrustEvidenceLock,
    withBenchmarkTrustEvidenceLock
};

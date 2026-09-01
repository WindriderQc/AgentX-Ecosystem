'use strict';

const crypto = require('crypto');
const BenchmarkTrustEvidenceLock = require('../../../models/BenchmarkTrustEvidenceLock');

const LOCK_ID = 'benchmark-trust-evidence-mutation-v1';
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_LEASE_MS = 20_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 300_000;
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

function validateLeaseMs(leaseMs) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
        throw lockError(
            'BENCHMARK_TRUST_LOCK_LEASE_INVALID',
            `Benchmark trust lock lease must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}ms`
        );
    }
    return leaseMs;
}

async function acquireBenchmarkTrustEvidenceLock(operation, {
    waitMs = DEFAULT_WAIT_MS
} = {}) {
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

/**
 * Explicit recovery for a lock whose owner has been independently confirmed
 * dead. Automatic lease stealing is deliberately forbidden: a paused owner
 * could otherwise resume an unfenced multi-document mutation. Exact token and
 * acquisition-time matching also prevents deleting a lease renewed between
 * inspection and recovery.
 */
async function recoverExpiredBenchmarkTrustEvidenceLock({
    ownerToken,
    acquiredAt,
    leaseMs = DEFAULT_LEASE_MS,
    confirmAbandoned = false,
    now = new Date()
} = {}) {
    if (confirmAbandoned !== true) {
        throw lockError(
            'BENCHMARK_TRUST_LOCK_RECOVERY_CONFIRMATION_REQUIRED',
            'Benchmark trust lock recovery requires explicit abandoned-owner confirmation'
        );
    }
    if (!/^[0-9a-f]{64}$/.test(String(ownerToken || ''))) {
        throw lockError('BENCHMARK_TRUST_LOCK_OWNER_INVALID', 'Benchmark trust lock owner token is invalid');
    }
    validateLeaseMs(leaseMs);
    const observedAcquiredAt = new Date(acquiredAt);
    const recoveryTime = new Date(now);
    if (Number.isNaN(observedAcquiredAt.getTime()) || Number.isNaN(recoveryTime.getTime())) {
        throw lockError('BENCHMARK_TRUST_LOCK_RECOVERY_TIME_INVALID', 'Benchmark trust lock recovery time is invalid');
    }
    if (observedAcquiredAt.getTime() > recoveryTime.getTime() - leaseMs) {
        throw lockError('BENCHMARK_TRUST_LOCK_NOT_EXPIRED', 'Benchmark trust lock lease has not expired');
    }
    const recovered = await BenchmarkTrustEvidenceLock.deleteOne({
        _id: LOCK_ID,
        ownerToken,
        acquiredAt: observedAcquiredAt
    });
    if (recovered.deletedCount !== 1) {
        throw lockError(
            'BENCHMARK_TRUST_LOCK_RECOVERY_STALE',
            'Benchmark trust lock changed after inspection; recovery was refused'
        );
    }
    return { recovered: true };
}

async function renewBenchmarkTrustEvidenceLock(ownerToken) {
    const renewed = await BenchmarkTrustEvidenceLock.updateOne(
        { _id: LOCK_ID, ownerToken },
        { $set: { acquiredAt: new Date() } }
    );
    if (renewed.matchedCount !== 1) {
        throw lockError(
            'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST',
            'Benchmark trust evidence lock ownership was lost during lease renewal'
        );
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
 * evidence. The lease is renewable and explicitly recoverable, but is never
 * stolen automatically: ownerToken does not fence the protected multi-document
 * mutations themselves, so silent takeover after an event-loop pause would be
 * unsafe. Recovery requires an exact inspected snapshot and operator-level
 * confirmation that the old process is dead.
 */
async function withBenchmarkTrustEvidenceLock(operation, task, options = {}) {
    if (typeof task !== 'function') {
        throw lockError('BENCHMARK_TRUST_LOCK_TASK_INVALID', 'Benchmark trust lock task must be a function');
    }
    const leaseMs = validateLeaseMs(options.leaseMs ?? DEFAULT_LEASE_MS);
    const ownerToken = await acquireBenchmarkTrustEvidenceLock(operation, options);
    let renewalError = null;
    let renewalInFlight = false;
    const renewalInterval = setInterval(async () => {
        if (renewalInFlight || renewalError) return;
        renewalInFlight = true;
        try {
            await renewBenchmarkTrustEvidenceLock(ownerToken);
        } catch (error) {
            renewalError = error;
        } finally {
            renewalInFlight = false;
        }
    }, Math.max(250, Math.floor(leaseMs / 3)));
    renewalInterval.unref?.();
    let result;
    let taskError = null;
    try {
        result = await task();
    } catch (error) {
        taskError = error;
    }

    clearInterval(renewalInterval);
    if (!taskError && renewalError) taskError = renewalError;

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
    DEFAULT_LEASE_MS,
    DEFAULT_WAIT_MS,
    LOCK_ID,
    acquireBenchmarkTrustEvidenceLock,
    recoverExpiredBenchmarkTrustEvidenceLock,
    releaseBenchmarkTrustEvidenceLock,
    renewBenchmarkTrustEvidenceLock,
    withBenchmarkTrustEvidenceLock
};

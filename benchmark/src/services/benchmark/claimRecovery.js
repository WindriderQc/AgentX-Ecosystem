'use strict';

/**
 * Claim Recovery
 *
 * On benchmark service startup, reconcile benchmark claims on core with the
 * actual BenchmarkBatch state. The normal release path runs in a `finally {}`
 * at the end of `runBatchOrchestrator` — but a `pm2 restart`, process crash,
 * or SIGKILL mid-batch skips that `finally`, leaving claims that can hold
 * hosts hostage for up to 2h (the reaper's hard cap).
 *
 * This module runs once on startup and releases two categories of claims:
 *   1. Dead batches: batchId in claim maps to a batch with status in
 *      {completed, failed, stopped}. The batch is done; the claim is a leak.
 *   2. Ghost batches: batchId in claim maps to a batch with status in
 *      {running, judging} but with no `last_activity_at` within the last
 *      10 min (heartbeat should fire every 10s). Mark the batch as
 *      `stopped` and release the claim.
 *
 * Also releases claims whose batchId has no matching batch at all (the batch
 * was deleted but the claim wasn't).
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { getBenchmarkClaims, releaseBenchmarkClaim } = require('../../clients/coreApiClient');
const { acquireBenchmarkClaims, estimateBenchmarkClaimDurationMs } = require('./benchmarkClaimLifecycle');
const { resolveJudgeHost } = require('./judgeHostResolution');
const { groupModelsByHost } = require('./batchHelpers');

const GHOST_BATCH_INACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min
const PRIOR_TRUST_RECOVERY_RETRY_MS = 5_000;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const PROFILER_CLAIM_PATTERN = /^profile-[a-f0-9]{16}$/i;

function normalizeRecoveryCutoff(recoveryStartedAt) {
    const cutoff = new Date(recoveryStartedAt);
    if (Number.isNaN(cutoff.getTime())) {
        throw new Error('Prior Trust runtime recovery cutoff is invalid');
    }
    return cutoff;
}

async function sweepPriorRuntimeTrustBatches(recoveryStartedAt) {
    const cutoff = normalizeRecoveryCutoff(recoveryStartedAt);
    const priorTrustBatches = await BenchmarkBatch.find({
        status: { $in: ['running', 'judging'] },
        trust_evidence_context: { $ne: null },
        started_at: { $lt: cutoff }
    }).select('_id status +trust_evidence_context').lean();

    const interrupted = [];
    const failed = [];
    for (const batch of priorTrustBatches) {
        try {
            await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
                status: 'interrupted',
                failureReason: 'process_restart',
                allowUnstarted: true
            });
            interrupted.push(String(batch._id));
        } catch (error) {
            failed.push(String(batch._id));
            logger.warn('[ClaimRecovery] Failed to finalize prior Trust runtime', {
                batchId: String(batch._id),
                error: error.message
            });
        }
    }
    return { matched: priorTrustBatches.length, interrupted, failed };
}

async function interruptPriorRuntimeTrustBatches(recoveryStartedAt = new Date()) {
    const result = await sweepPriorRuntimeTrustBatches(recoveryStartedAt);
    return result.interrupted;
}

async function releaseFinalizedPriorTrustClaims(recoveryStartedAt) {
    const cutoff = normalizeRecoveryCutoff(recoveryStartedAt);
    let claims;
    try {
        claims = await getBenchmarkClaims();
    } catch (error) {
        logger.warn('[ClaimRecovery] Deferred Trust claim reconciliation could not fetch claims', {
            cutoff: cutoff.toISOString(),
            error: error.message
        });
        return { fetched: false, matched: 0, released: [], failed: ['claims-fetch'] };
    }

    const released = [];
    const failed = [];
    let matched = 0;
    for (const claim of Array.isArray(claims) ? claims : []) {
        const batchId = String(claim?.batchId || '');
        const hostUrl = String(claim?.hostUrl || '');
        if (!batchId || !hostUrl) continue;
        if (!OBJECT_ID_PATTERN.test(batchId)) continue;
        try {
            const batch = await BenchmarkBatch.findById(batchId)
                .select('status started_at +trust_evidence_context')
                .lean();
            const startedAt = batch?.started_at ? new Date(batch.started_at) : null;
            const isPriorTrustBatch = Boolean(batch?.trust_evidence_context)
                && startedAt
                && !Number.isNaN(startedAt.getTime())
                && startedAt < cutoff;
            if (!isPriorTrustBatch
                || !['completed', 'failed', 'stopped', 'interrupted'].includes(batch.status)) {
                continue;
            }
            matched++;
            const result = await releaseBenchmarkClaim(hostUrl, batchId);
            if (result?.released !== true) {
                failed.push(batchId);
                logger.warn('[ClaimRecovery] Deferred Trust claim release was refused', {
                    batchId,
                    hostUrl,
                    reason: result?.reason || 'release_not_confirmed'
                });
                continue;
            }
            released.push({ hostUrl, batchId });
        } catch (error) {
            failed.push(batchId);
            logger.warn('[ClaimRecovery] Deferred Trust claim release failed', {
                batchId,
                hostUrl,
                error: error.message
            });
        }
    }
    return { fetched: true, matched, released, failed };
}

function startPriorRuntimeTrustBatchRecoverySweep({
    recoveryStartedAt = new Date(),
    retryMs = PRIOR_TRUST_RECOVERY_RETRY_MS
} = {}) {
    const cutoff = normalizeRecoveryCutoff(recoveryStartedAt);
    if (!Number.isSafeInteger(retryMs) || retryMs < 50 || retryMs > 60_000) {
        throw new Error('Prior Trust runtime recovery retry interval is invalid');
    }
    let stopped = false;
    let running = false;
    let interval = null;
    const stop = () => {
        stopped = true;
        if (interval) clearInterval(interval);
        interval = null;
    };
    const run = async () => {
        if (stopped || running) return;
        running = true;
        try {
            const finalization = await sweepPriorRuntimeTrustBatches(cutoff);
            const claims = await releaseFinalizedPriorTrustClaims(cutoff);
            if (finalization.failed.length === 0 && claims.fetched && claims.failed.length === 0) {
                stop();
            }
        } catch (error) {
            logger.warn('[ClaimRecovery] Deferred Trust runtime finalization sweep failed', {
                cutoff: cutoff.toISOString(),
                error: error.message
            });
        } finally {
            running = false;
        }
    };
    interval = setInterval(run, retryMs);
    interval.unref?.();
    return { cutoff, run, stop };
}

async function recoverLeakedClaims({ recoveryStartedAt = new Date() } = {}) {
    // Every active strict Trust batch predating this process belongs to a dead
    // runner. A fresh persisted heartbeat describes the old process and must
    // not cause the new process to re-claim a batch it cannot resume.
    const interruptedTrustBatches = await interruptPriorRuntimeTrustBatches(recoveryStartedAt);
    let claims;
    try {
        claims = await getBenchmarkClaims();
    } catch (err) {
        logger.warn('[ClaimRecovery] Could not fetch claims from core — skipping', { error: err.message });
        return { fetched: false, released: 0, interruptedTrustBatches };
    }

    if (!Array.isArray(claims) || claims.length === 0) {
        logger.info('[ClaimRecovery] No active claims to reconcile');
        return { fetched: true, released: 0, interruptedTrustBatches };
    }

    const now = Date.now();
    const released = [];
    const failed = [];

    const recordRelease = (claim, result, reason, extra = {}) => {
        const detail = {
            hostUrl: claim.hostUrl,
            batchId: claim.batchId,
            reason,
            ...extra
        };
        if (result?.released === true) {
            released.push(detail);
        } else {
            failed.push({
                ...detail,
                releaseReason: result?.reason || 'core_refused_release'
            });
        }
    };

    for (const claim of claims) {
        const { batchId, hostUrl } = claim;
        if (!batchId || !hostUrl) continue;

        try {
            // Profiler jobs live only in this process. After a Benchmark
            // restart, a profile-* claim cannot still have a worker capable
            // of completing or heartbeating it, so release that exact
            // generation-bound claim before trying to interpret batch ids.
            if (PROFILER_CLAIM_PATTERN.test(batchId)) {
                const result = await releaseBenchmarkClaim(hostUrl, batchId);
                recordRelease(claim, result, 'orphaned-profiler-runtime');
                continue;
            }
            // Manual/external claim ids are not BenchmarkBatch ObjectIds and
            // may still be owned by a live wrapper outside this container.
            // Leave them untouched rather than casting or stealing them.
            if (!OBJECT_ID_PATTERN.test(batchId)) continue;
            const batch = await BenchmarkBatch.findById(batchId)
                .select('status last_activity_at +trust_evidence_context')
                .lean();

            // Category 1: batch no longer exists
            if (!batch) {
                const result = await releaseBenchmarkClaim(hostUrl, batchId);
                recordRelease(claim, result, 'batch-not-found');
                continue;
            }

            // Category 2: dead batch (terminal status but claim leaked)
            if (['completed', 'failed', 'stopped', 'interrupted'].includes(batch.status)) {
                const result = await releaseBenchmarkClaim(hostUrl, batchId);
                recordRelease(claim, result, `batch-${batch.status}`);
                continue;
            }

            // Category 3: ghost batch (claims to be running but heartbeat is stale)
            if (['running', 'judging'].includes(batch.status)) {
                const lastActivity = batch.last_activity_at ? new Date(batch.last_activity_at).getTime() : 0;
                const inactiveMs = now - lastActivity;
                if (lastActivity > 0 && inactiveMs > GHOST_BATCH_INACTIVE_THRESHOLD_MS) {
                    // The current process can't own a batch that was running before
                    // this startup — that's a definitional crash-recovery. Mark as
                    // stopped so operators see it, then release the claim.
                    if (batch.trust_evidence_context) {
                        await BenchmarkBatch.finalizeTrustEvidenceBatch(batchId, {
                            status: 'interrupted',
                            failureReason: 'stale_runtime_heartbeat',
                            allowUnstarted: true
                        });
                    } else {
                        await BenchmarkBatch.updateOne(
                            { _id: batchId, status: { $in: ['running', 'judging'] } },
                            { $set: { status: 'stopped', completed_at: new Date() } }
                        );
                    }
                    const result = await releaseBenchmarkClaim(hostUrl, batchId);
                    recordRelease(claim, result, 'ghost-batch', { inactiveMs });
                }
            }
        } catch (err) {
            failed.push({ hostUrl, batchId, reason: 'reconciliation_error', error: err.message });
            logger.warn('[ClaimRecovery] Error reconciling claim', { hostUrl, batchId, error: err.message });
        }
    }

    if (released.length > 0) {
        logger.warn('[ClaimRecovery] Released leaked claims on startup', { count: released.length, details: released });
    } else if (failed.length === 0) {
        logger.info('[ClaimRecovery] All claims reconciled, none required release', { checked: claims.length });
    }
    if (failed.length > 0) {
        logger.warn('[ClaimRecovery] Some leaked claims remain active after startup reconciliation', {
            count: failed.length,
            details: failed
        });
    }

    return {
        fetched: true,
        released: released.length,
        failed: failed.length,
        details: [...released, ...failed],
        interruptedTrustBatches
    };
}

/**
 * Re-acquire benchmark claims for any batches that are still `running` or
 * `judging` with fresh heartbeats. A service restart mid-batch skips the
 * `runBatchOrchestrator` path that acquires claims at batch start — so unless
 * we re-claim here, core's reaper eventually drops the claim, and pinned-model
 * auto-restore takes over the host, stealing VRAM from the live benchmark's
 * judge calls. claimHostForBenchmark is idempotent for same-batch reclaims,
 * so calling this on every startup is safe.
 */
async function reacquireActiveBatchClaims() {
    const now = Date.now();
    const active = await BenchmarkBatch.find({
        status: { $in: ['running', 'judging'] }
    }).select('_id host models judge_config last_activity_at total_tests +trust_evidence_context').lean();

    if (active.length === 0) {
        logger.info('[ClaimRecovery] No active batches to re-claim');
        return { checked: 0, reacquired: 0 };
    }

    let reacquired = 0;
    for (const batch of active) {
        // Strict Trust execution has no resume path. If its startup finalizer
        // failed, re-claiming hosts would manufacture a zombie owner with no
        // worker capable of finishing the immutable campaign.
        if (batch.trust_evidence_context) {
            logger.warn('[ClaimRecovery] Refusing to re-claim an interrupted Trust runtime', {
                batchId: String(batch._id)
            });
            continue;
        }
        const lastActivity = batch.last_activity_at ? new Date(batch.last_activity_at).getTime() : 0;
        if (lastActivity > 0 && (now - lastActivity) > GHOST_BATCH_INACTIVE_THRESHOLD_MS) {
            // Ghost batch — handled by recoverLeakedClaims, skip here.
            continue;
        }

        try {
            const execHosts = Object.keys(groupModelsByHost(batch.host, batch.models || []));
            const judgeHosts = execHosts
                .map(url => resolveJudgeHost(url, batch.judge_config || {}).judgeHost)
                .filter(Boolean);
            const allHosts = [...new Set([...execHosts, ...judgeHosts])];
            if (allHosts.length === 0) continue;

            const estimateMs = estimateBenchmarkClaimDurationMs({
                hostCount: execHosts.length,
                modelCount: (batch.models || []).length,
                promptCount: batch.total_tests && (batch.models || []).length
                    ? Math.ceil(batch.total_tests / (batch.models || []).length)
                    : 0,
                executionConfig: {},
                executionMode: 'latency',
                judgeConfig: batch.judge_config || {}
            });

            const claimed = await acquireBenchmarkClaims(allHosts, String(batch._id), estimateMs);
            if (claimed.length > 0) {
                reacquired += claimed.length;
                logger.info('[ClaimRecovery] Re-acquired claims for active batch', {
                    batchId: String(batch._id), hosts: claimed
                });
            }
        } catch (err) {
            logger.warn('[ClaimRecovery] Error re-acquiring claim for batch', {
                batchId: String(batch._id), error: err.message
            });
        }
    }

    return { checked: active.length, reacquired };
}

module.exports = {
    PRIOR_TRUST_RECOVERY_RETRY_MS,
    OBJECT_ID_PATTERN,
    PROFILER_CLAIM_PATTERN,
    interruptPriorRuntimeTrustBatches,
    recoverLeakedClaims,
    reacquireActiveBatchClaims,
    releaseFinalizedPriorTrustClaims,
    startPriorRuntimeTrustBatchRecoverySweep
};

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

async function recoverLeakedClaims() {
    let claims;
    try {
        claims = await getBenchmarkClaims();
    } catch (err) {
        logger.warn('[ClaimRecovery] Could not fetch claims from core — skipping', { error: err.message });
        return { fetched: false, released: 0 };
    }

    if (!Array.isArray(claims) || claims.length === 0) {
        logger.info('[ClaimRecovery] No active claims to reconcile');
        return { fetched: true, released: 0 };
    }

    const now = Date.now();
    const released = [];

    for (const claim of claims) {
        const { batchId, hostUrl } = claim;
        if (!batchId || !hostUrl) continue;

        try {
            const batch = await BenchmarkBatch.findById(batchId).select('status last_activity_at').lean();

            // Category 1: batch no longer exists
            if (!batch) {
                const result = await releaseBenchmarkClaim(hostUrl, batchId);
                released.push({ hostUrl, batchId, reason: 'batch-not-found', released: !!result?.released });
                continue;
            }

            // Category 2: dead batch (terminal status but claim leaked)
            if (['completed', 'failed', 'stopped'].includes(batch.status)) {
                const result = await releaseBenchmarkClaim(hostUrl, batchId);
                released.push({ hostUrl, batchId, reason: `batch-${batch.status}`, released: !!result?.released });
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
                    await BenchmarkBatch.updateOne(
                        { _id: batchId, status: { $in: ['running', 'judging'] } },
                        { $set: { status: 'stopped', completed_at: new Date() } }
                    );
                    const result = await releaseBenchmarkClaim(hostUrl, batchId);
                    released.push({ hostUrl, batchId, reason: 'ghost-batch', inactiveMs, released: !!result?.released });
                }
            }
        } catch (err) {
            logger.warn('[ClaimRecovery] Error reconciling claim', { hostUrl, batchId, error: err.message });
        }
    }

    if (released.length > 0) {
        logger.warn('[ClaimRecovery] Released leaked claims on startup', { count: released.length, details: released });
    } else {
        logger.info('[ClaimRecovery] All claims reconciled, none required release', { checked: claims.length });
    }

    return { fetched: true, released: released.length, details: released };
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
    }).select('_id host models judge_config last_activity_at total_tests').lean();

    if (active.length === 0) {
        logger.info('[ClaimRecovery] No active batches to re-claim');
        return { checked: 0, reacquired: 0 };
    }

    let reacquired = 0;
    for (const batch of active) {
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

module.exports = { recoverLeakedClaims, reacquireActiveBatchClaims };

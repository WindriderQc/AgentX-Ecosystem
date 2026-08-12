'use strict';
/**
 * Judge Monitor
 *
 * Active judging job state and status/lifecycle helpers, extracted from judging.js
 * to keep the core judging module within the 600-line service limit.
 *
 * Owns the single source of truth for the activeJudgingJobs map so that
 * judging.js can import the same reference without creating circular deps.
 *
 * Consumed by: src/services/benchmark/judging.js
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

// Track active judging jobs (batchId -> { queue, stopped })
const activeJudgingJobs = new Map();

// ── Persistence ────────────────────────────────────────────────────────────────

async function persistJudgeCounters(batchId, fields = {}) {
    await BenchmarkBatch.updateOne(
        { _id: batchId },
        {
            $set: {
                ...fields,
                last_activity_at: new Date()
            }
        }
    );
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

/**
 * Stop active judging for a batch.
 * @param {string} batchId
 * @returns {boolean} true if judging was active and stopped
 */
function stopJudging(batchId) {
    const job = activeJudgingJobs.get(batchId);
    if (!job) return false;

    job.stopped = true;
    persistJudgeCounters(batchId, { judge_status: 'stopped' }).catch((err) => {
        logger.warn('Failed to persist stop request for judging job', {
            batchId,
            error: err.message
        });
    });
    logger.info('Judging stop requested', { batchId });
    return true;
}

async function stopPersistedJudging(batchId) {
    const batch = await BenchmarkBatch.findById(batchId);
    if (!batch) {
        throw new Error(`Batch not found: ${batchId}`);
    }

    const liveStopped = stopJudging(batchId);
    if (liveStopped) {
        return { stopped: true, repaired: false };
    }

    const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'interrupted']);
    if (batch.judge_status !== 'running' || !terminalStatuses.has(batch.status)) {
        return { stopped: false, repaired: false };
    }

    const repairedStatus = batch.status === 'stopped' ? 'stopped' : 'failed';
    await batch.reconcileFromResults({
        status: batch.status,
        judgeStatus: repairedStatus,
        timelineEvent: 'judge_stop_reconciled',
        timelineError: 'Persisted judge_status was running without an active in-memory judge job'
    });

    logger.warn('Reconciled stale persisted judging state', {
        batchId,
        batchStatus: batch.status,
        judgeStatus: repairedStatus
    });

    return { stopped: false, repaired: true, judge_status: repairedStatus };
}

/**
 * Stop all active judging jobs (for graceful shutdown).
 */
function stopAllJudging() {
    for (const [batchId, job] of activeJudgingJobs) {
        job.stopped = true;
        logger.info('Stopping judging on shutdown', { batchId });
    }
}

// ── Status / Counters ──────────────────────────────────────────────────────────

async function getAuthoritativeJudgeCounters(batchId) {
    const [totalResults, judgeTotal, judgeCompleted, judgeFailed] = await Promise.all([
        BenchmarkResult.countDocuments({ batch_id: batchId }),
        BenchmarkResult.countDocuments({
            batch_id: batchId,
            success: true,
            response: { $type: 'string', $nin: ['', null] }
        }),
        BenchmarkResult.countDocuments({
            batch_id: batchId,
            success: true,
            response: { $type: 'string', $nin: ['', null] },
            scoring_method: { $ne: 'pending' }
        }),
        BenchmarkResult.countDocuments({
            batch_id: batchId,
            success: true,
            response: { $type: 'string', $nin: ['', null] },
            scoring_method: 'llm_failed'
        })
    ]);

    return {
        hasResults: totalResults > 0,
        judge_total: judgeTotal,
        judge_completed: judgeCompleted,
        judge_failed: judgeFailed
    };
}

/**
 * Get judging status for a batch.
 * Returns live queue stats if active, else batch counters with self-healing drift fix.
 * @param {string} batchId
 * @returns {Promise<Object>}
 */
async function getJudgingStatus(batchId) {
    const job = activeJudgingJobs.get(batchId);
    if (job) {
        return {
            active: true,
            stopped: job.stopped,
            ...job.queue.getStatus()
        };
    }

    const batch = await BenchmarkBatch.findById(batchId)
        .select('status judge_status judge_total judge_completed judge_failed')
        .lean();

    if (!batch) {
        throw new Error(`Batch not found: ${batchId}`);
    }

    // While execution or judging is actively running, $inc operations are in flight.
    // Self-healing $set would race with those and roll back progress.
    const isActive = batch.status === 'running' || batch.judge_status === 'running';

    if (isActive) {
        return {
            active: false,
            judge_status: batch.judge_status || 'none',
            judge_total: batch.judge_total,
            judge_completed: batch.judge_completed,
            judge_failed: batch.judge_failed
        };
    }

    const authoritative = await getAuthoritativeJudgeCounters(batchId);

    if (!authoritative.hasResults) {
        return {
            active: false,
            judge_status: batch.judge_status || 'none',
            judge_total: batch.judge_total,
            judge_completed: batch.judge_completed,
            judge_failed: batch.judge_failed
        };
    }

    const countersDrifted =
        Number(batch.judge_total || 0) !== authoritative.judge_total ||
        Number(batch.judge_completed || 0) !== authoritative.judge_completed ||
        Number(batch.judge_failed || 0) !== authoritative.judge_failed;

    if (countersDrifted) {
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    judge_total: authoritative.judge_total,
                    judge_completed: authoritative.judge_completed,
                    judge_failed: authoritative.judge_failed,
                    last_activity_at: new Date()
                }
            }
        );
    }

    return {
        active: false,
        judge_status: batch.judge_status || 'none',
        judge_total: authoritative.judge_total,
        judge_completed: authoritative.judge_completed,
        judge_failed: authoritative.judge_failed
    };
}

module.exports = {
    activeJudgingJobs,
    persistJudgeCounters,
    stopJudging,
    stopPersistedJudging,
    stopAllJudging,
    getAuthoritativeJudgeCounters,
    getJudgingStatus
};

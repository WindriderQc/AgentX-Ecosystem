/**
 * Judge queue recovery — re-enqueues orphaned judge tasks on startup.
 *
 * On process crash, judge tasks that were 'pending' or 'running' in the
 * JudgeQueueEntry collection never completed.  This module finds them
 * and invokes `judgeResult()` directly for each one.
 */

const logger = require('../../../config/logger');
const JudgeQueueEntry = require('../../../models/JudgeQueueEntry');
const { judgeResult } = require('./judging');
const { runManagedWorkload } = require('./workloadAdmissionLifecycle');

/**
 * Recover orphaned judge queue entries.
 * Called once during server startup (after DB connection is ready).
 */
async function recoverJudgeQueue() {
    const orphaned = await JudgeQueueEntry.find({ status: { $in: ['pending', 'running'] } }).lean();
    if (!orphaned.length) return [];

    logger.info(`Judge queue recovery: ${orphaned.length} orphaned entries found`);
    const outcomes = [];

    for (const entry of orphaned) {
        const entryId = String(entry._id);
        const batchId = String(entry.batchId);
        const resultId = String(entry.resultId);
        const workloadId = `judge-recovery:${entryId}`;
        try {
            const outcome = await runManagedWorkload(workloadId, {
                requestId: workloadId,
                kind: 'judge-recovery',
                batchId,
                hosts: entry.judgeConfig?.host ? [entry.judgeConfig.host] : []
            }, async ({ signal, assertActive }) => {
                try {
                    assertActive();
                    await JudgeQueueEntry.updateOne(
                        { _id: entry._id },
                        { $set: { status: 'running', startedAt: new Date() } },
                        { signal }
                    );
                    assertActive();
                    await judgeResult(resultId, {
                        ...(entry.judgeConfig || {}),
                        cancelSignal: signal
                    });
                    assertActive();
                    await JudgeQueueEntry.updateOne(
                        { _id: entry._id },
                        { $set: { status: 'completed', completedAt: new Date(), error: null } },
                        { signal }
                    );
                    assertActive();
                    return { recovered: true, resultId, batchId };
                } catch (error) {
                    // Persist a terminal failure only while the same Core
                    // admission is still live. If the lease was lost, make no
                    // further write and leave the admission/fence to TTL
                    // recovery so maintenance cannot overlap a stale worker.
                    assertActive();
                    await JudgeQueueEntry.updateOne(
                        { _id: entry._id },
                        { $set: { status: 'failed', completedAt: new Date(), error: error.message } },
                        { signal }
                    );
                    assertActive();
                    return { recovered: false, resultId, batchId, error: error.message };
                }
            });
            outcomes.push(outcome);
            if (outcome.recovered) {
                logger.info('Recovered judge task', { resultId: entry.resultId, batchId: entry.batchId });
            } else {
                logger.warn('Judge queue recovery failed for entry', { resultId: entry.resultId, error: outcome.error });
            }
        } catch (err) {
            outcomes.push({ recovered: false, resultId, batchId, error: err.message, admissionLost: true });
            logger.warn('Judge queue recovery failed for entry', { resultId: entry.resultId, error: err.message });
        }
    }

    logger.info('Judge queue recovery complete');
    return outcomes;
}

module.exports = { recoverJudgeQueue };

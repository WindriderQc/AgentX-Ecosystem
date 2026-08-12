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

/**
 * Recover orphaned judge queue entries.
 * Called once during server startup (after DB connection is ready).
 */
async function recoverJudgeQueue() {
    const orphaned = await JudgeQueueEntry.find({ status: { $in: ['pending', 'running'] } }).lean();
    if (!orphaned.length) return;

    logger.info(`Judge queue recovery: ${orphaned.length} orphaned entries found`);

    for (const entry of orphaned) {
        try {
            await JudgeQueueEntry.updateOne({ _id: entry._id }, { $set: { status: 'running', startedAt: new Date() } });
            await judgeResult(entry.resultId.toString(), entry.judgeConfig || {});
            await JudgeQueueEntry.updateOne({ _id: entry._id }, { $set: { status: 'completed', completedAt: new Date() } });
            logger.info('Recovered judge task', { resultId: entry.resultId, batchId: entry.batchId });
        } catch (err) {
            await JudgeQueueEntry.updateOne({ _id: entry._id }, { $set: { status: 'failed', completedAt: new Date(), error: err.message } }).catch(() => {});
            logger.warn('Judge queue recovery failed for entry', { resultId: entry.resultId, error: err.message });
        }
    }

    logger.info('Judge queue recovery complete');
}

module.exports = { recoverJudgeQueue };

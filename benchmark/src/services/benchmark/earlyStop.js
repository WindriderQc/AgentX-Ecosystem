/**
 * Per-model early-stop check for benchmark batches.
 *
 * Once a model has produced at least MIN_JUDGED scored results in this batch,
 * if the running average quality_score is below THRESHOLD the model is marked
 * early-stopped on BenchmarkBatch.model_timings and a timeline event is
 * emitted. Other models in the batch keep running.
 *
 * Kept separate from batchOrchestrator.js so the orchestration path remains
 * focused.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

const MIN_JUDGED = 5;
const THRESHOLD = 2.0; // quality_score is 0–10; <2 = clearly broken

async function evaluateAndPersistEarlyStop({ batchId, model, hostUrl, recordBatchTimelineEvent }) {
    const judgedResults = await BenchmarkResult.find({
        batch_id: batchId,
        model,
        quality_score: { $ne: null }
    }).select('quality_score').lean().catch(() => []);

    if (judgedResults.length < MIN_JUDGED) return false;

    const avgScore = judgedResults.reduce((s, r) => s + r.quality_score, 0) / judgedResults.length;
    if (avgScore >= THRESHOLD) return false;

    const reason = `avg quality_score ${avgScore.toFixed(2)}/10 below threshold ${THRESHOLD} after ${judgedResults.length} judged prompts`;
    logger.warn(`Early-stop: ${model} on ${hostUrl} — ${reason}`, {
        batchId, model, host: hostUrl,
        avgScore: Number(avgScore.toFixed(2)),
        judgedCount: judgedResults.length,
        threshold: THRESHOLD
    });

    await BenchmarkBatch.updateOne(
        { _id: batchId, 'model_timings.model': model },
        { $set: {
            'model_timings.$.early_stopped': true,
            'model_timings.$.early_stop_reason': reason,
            'model_timings.$.early_stop_avg_score': Number(avgScore.toFixed(2)),
            'model_timings.$.early_stop_judged_count': judgedResults.length
        } }
    ).catch((err) => logger.warn('Failed to persist early-stop marker', { batchId, model, error: err.message }));

    if (recordBatchTimelineEvent) {
        await recordBatchTimelineEvent('model_early_stopped', {
            model, host: hostUrl,
            avg_score: Number(avgScore.toFixed(2)),
            judged_count: judgedResults.length,
            threshold: THRESHOLD
        }).catch(() => {});
    }

    return true;
}

module.exports = {
    evaluateAndPersistEarlyStop,
    EARLY_STOP_MIN_JUDGED: MIN_JUDGED,
    EARLY_STOP_THRESHOLD: THRESHOLD
};

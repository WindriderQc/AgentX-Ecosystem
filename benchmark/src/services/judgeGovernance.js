/**
 * Judge Governance Loop
 *
 * Orchestrates the post-batch judge-validation loop into one explicit service.
 * Composes:
 *   1. feedback stats snapshot      (judgeFeedbackLoop.getJudgeFeedbackStats)
 *   2. auto-promote ground truth    (judgeFeedbackLoop.autoPromoteGroundTruth)
 *   3. retro-calibration (optional) (benchmark/retroCalibration.runRetroCalibration)
 *   4. matrix calibration (optional) (benchmark/calibrationRunner)
 *   5. drift detection              (benchmark/driftDetector.detectDrift)
 *
 * Design rules (per TODO 0125):
 *   - governance observes; it never mutates the scoring pipeline
 *   - partial failures are captured, not hidden: a failed sub-step leaves the
 *     rest of the summary intact and flips the aggregate status to `partial`
 *   - the summary artifact (JudgeGovernanceRun) persists so a single API read
 *     replaces five manual diagnostics endpoint calls
 *
 * Sub-steps are gated by the inputs present in the options:
 *   - retro-calibration runs only when { runRetroCalibration: true, batchId,
 *     referenceModel, referenceHost } are supplied
 *   - matrix calibration runs only when { judgeModel, judgeHost,
 *     referenceModel, referenceHost } are supplied
 *   - drift detection uses the provided batchId or the most recent
 *     judge-completed batch
 */

const mongoose = require('mongoose');
const logger = require('../../config/logger');
const JudgeGovernanceRun = require('../../models/JudgeGovernanceRun');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');

const { getJudgeFeedbackStats, autoPromoteGroundTruth } = require('./judgeFeedbackLoop');
const { runRetroCalibration } = require('./benchmark/retroCalibration');
const { runCalibrationBatch, buildAccuracyMatrix } = require('./benchmark/calibrationRunner');
const { detectDrift } = require('./benchmark/driftDetector');
const { buildStrictTrustResultExclusion } = require('./benchmark/publicReadPrivacy');

/**
 * Execute one sub-step, capturing timing + errors without throwing upward.
 */
async function runSubStep(name, fn) {
    const started = Date.now();
    const startedAt = new Date(started);
    try {
        const output = await fn();
        const finished = Date.now();
        return {
            name,
            status: output && output.__skipped ? 'skipped' : 'ok',
            started_at: startedAt,
            finished_at: new Date(finished),
            duration_ms: finished - started,
            error: null,
            output: output && output.__skipped
                ? { reason: output.reason || 'skipped' }
                : output
        };
    } catch (err) {
        const finished = Date.now();
        logger.warn(`Governance sub-step failed: ${name}`, { error: err.message });
        return {
            name,
            status: 'failed',
            started_at: startedAt,
            finished_at: new Date(finished),
            duration_ms: finished - started,
            error: err.message || String(err),
            output: null
        };
    }
}

function skipped(reason) {
    return { __skipped: true, reason };
}

/**
 * Find the most recent judge-completed batch id when caller does not supply
 * one. Returns null when nothing is available.
 */
async function resolveBatchId(explicitBatchId) {
    if (explicitBatchId) {
        const explicit = await BenchmarkBatch.findById(explicitBatchId)
            .select('_id trust_campaign_spec_id +trust_evidence_context')
            .lean();
        if (!explicit) return null;
        if (explicit.trust_evidence_context
            || /^[a-f0-9]{64}$/i.test(String(explicit.trust_campaign_spec_id || ''))) {
            const error = new Error('Strict Benchmark Trust evidence cannot be consumed by legacy judge governance');
            error.code = 'BENCHMARK_TRUST_GOVERNANCE_BATCH_FORBIDDEN';
            error.statusCode = 409;
            throw error;
        }
        return explicit._id.toString();
    }
    const latest = await BenchmarkBatch
        .findOne({
            judge_status: 'completed',
            trust_campaign_spec_id: null,
            trust_evidence_context: null
        })
        .sort({ updatedAt: -1 })
        .select('_id')
        .lean();
    return latest ? latest._id.toString() : null;
}

/**
 * Compute current-batch vs historical drift without reimplementing the
 * query logic in diagnostics.js — same aggregation, different wrapper.
 */
async function computeDrift({ batchId, judgeModel }) {
    if (!batchId) return skipped('no batch_id available');

    const normalizedBatchId = String(batchId);
    if (!/^[0-9a-f]{24}$/i.test(normalizedBatchId)) {
        const error = new Error('batch_id must resolve to a canonical Mongo ObjectId');
        error.code = 'BENCHMARK_GOVERNANCE_BATCH_ID_INVALID';
        throw error;
    }
    const resultBatchId = new mongoose.Types.ObjectId(normalizedBatchId);

    const match = { quality_score: { $ne: null } };
    if (judgeModel) match.judge_model = judgeModel;

    // Mongoose does not cast aggregation pipelines. BenchmarkResult.batch_id is
    // an ObjectId, so use the exact storage type for both cohort boundaries.
    const [currentStats, historicalStats] = await Promise.all([
        BenchmarkResult.aggregate([
            { $match: { ...match, batch_id: resultBatchId, ...buildStrictTrustResultExclusion() } },
            { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
        ]),
        BenchmarkResult.aggregate([
            { $match: { ...match, batch_id: { $ne: resultBatchId }, ...buildStrictTrustResultExclusion() } },
            { $sort: { timestamp: -1 } },
            { $limit: 500 },
            { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
        ])
    ]);

    if (!currentStats.length || !historicalStats.length) {
        return { drifted: null, insufficient_data: true, batch_id: batchId };
    }

    const current = {
        mean: currentStats[0].mean,
        variance: (currentStats[0].stddev || 0) ** 2,
        count: currentStats[0].count
    };
    const historical = {
        mean: historicalStats[0].mean,
        variance: (historicalStats[0].stddev || 0) ** 2,
        count: historicalStats[0].count
    };

    return { ...detectDrift(current, historical), batch_id: batchId };
}

/**
 * Run matrix calibration against the active ground-truth set, persist to
 * JudgeAccuracyMatrix, and return the saved doc.
 */
async function computeMatrixCalibration({
    judgeModel, judgeHost, referenceModel, referenceHost, passThreshold = 1.5
}) {
    if (!judgeModel || !judgeHost || !referenceModel || !referenceHost) {
        return skipped('missing judge/reference model or host');
    }

    const entries = await JudgeGroundTruth.getForValidation();
    if (!entries || entries.length === 0) {
        return skipped('no ground-truth entries available');
    }

    const referenceScores = await runCalibrationBatch(entries, {
        model: referenceModel,
        host: referenceHost
    });
    const challengerScores = await runCalibrationBatch(entries, {
        model: judgeModel,
        host: judgeHost
    });

    const matrix = buildAccuracyMatrix(referenceScores, challengerScores, passThreshold);

    const saved = await JudgeAccuracyMatrix.create({
        judge_model: judgeModel,
        judge_host: judgeHost,
        reference_model: referenceModel,
        reference_host: referenceHost,
        pass_threshold: passThreshold,
        ground_truth_count: entries.length,
        cells: matrix.cells,
        overall_avg_deviation: matrix.overall_avg_deviation,
        pass_rate: matrix.pass_rate
    });

    return {
        matrix_id: saved._id.toString(),
        ground_truth_count: entries.length,
        overall_avg_deviation: matrix.overall_avg_deviation,
        pass_rate: matrix.pass_rate,
        cells: matrix.cells
    };
}

/**
 * Build the `headline` block from sub-step outputs. Failed or skipped
 * sub-steps contribute nulls / defaults rather than throwing.
 */
function buildHeadline(subStepsByName) {
    const feedback = subStepsByName.feedback_stats;
    const promote = subStepsByName.auto_promote;
    const retro = subStepsByName.retro_calibration;
    const matrix = subStepsByName.matrix_calibration;
    const drift = subStepsByName.drift_detection;
    let driftStatus = 'unknown';
    if (drift?.status === 'skipped' || drift?.status === 'failed') {
        driftStatus = drift.status;
    } else if (drift?.status === 'ok') {
        const reportedStatus = drift.output?.overall_status;
        if (['ok', 'alert', 'insufficient_data', 'no_baseline'].includes(reportedStatus)) {
            driftStatus = reportedStatus;
        } else if (drift.output?.insufficient_data === true) {
            driftStatus = 'insufficient_data';
        } else if (drift.output?.no_baseline === true) {
            driftStatus = 'no_baseline';
        } else if (drift.output?.drifted === true) {
            driftStatus = 'alert';
        } else if (drift.output?.drifted === false && drift.output?.insufficient_data === false) {
            driftStatus = 'ok';
        }
    }

    return {
        feedback_overall_count:
            feedback?.status === 'ok' ? (feedback.output?.overall?.count || 0) : 0,
        feedback_high_divergence_rate:
            feedback?.status === 'ok' ? (feedback.output?.overall?.highDivergenceRate || 0) : 0,
        auto_promoted:
            promote?.status === 'ok' ? (promote.output?.promoted || 0) : 0,
        retro_created:
            retro?.status === 'ok' ? (retro.output?.results?.created || 0) : 0,
        matrix_pass_rate:
            matrix?.status === 'ok' ? (matrix.output?.pass_rate ?? null) : null,
        matrix_overall_deviation:
            matrix?.status === 'ok' ? (matrix.output?.overall_avg_deviation ?? null) : null,
        drift_status: driftStatus,
        drift_detected: driftStatus === 'alert'
            ? true
            : driftStatus === 'ok' ? false : null,
        drift_reasons:
            drift?.status === 'ok' ? (drift.output?.reasons || []) : []
    };
}

/**
 * Main entry point.
 *
 * @param {Object} options
 * @param {string}  [options.batchId]          - batch to analyze (defaults to
 *                                               most recent judge-completed batch)
 * @param {string}  [options.judgeModel]       - challenger judge for matrix calibration
 * @param {string}  [options.judgeHost]
 * @param {string}  [options.referenceModel]   - reference judge
 * @param {string}  [options.referenceHost]
 * @param {number}  [options.passThreshold=1.5]
 * @param {boolean} [options.runRetroCalibration=false]
 * @param {number}  [options.retroPerCell=3]
 * @param {boolean} [options.retroDryRun=false]
 * @param {boolean} [options.persist=true]     - persist summary doc; tests set false
 * @param {string}  [options.triggeredBy='manual']
 * @returns {Promise<Object>} saved governance-run doc (plain object)
 */
async function runJudgeGovernanceLoop(options = {}) {
    const {
        batchId: explicitBatchId = null,
        judgeModel = null,
        judgeHost = null,
        referenceModel = null,
        referenceHost = null,
        passThreshold = 1.5,
        runRetroCalibration: shouldRunRetro = false,
        retroPerCell = 3,
        retroDryRun = false,
        persist = true,
        triggeredBy = 'manual'
    } = options;

    const startedAt = new Date();
    const t0 = Date.now();

    logger.info('Governance loop starting', {
        batch_id: explicitBatchId,
        judge_model: judgeModel,
        reference_model: referenceModel,
        run_retro: shouldRunRetro
    });

    // Resolve batch id once — cheap and used by multiple sub-steps.
    let batchId = null;
    try {
        batchId = await resolveBatchId(explicitBatchId);
    } catch (err) {
        if (explicitBatchId || err?.code === 'BENCHMARK_TRUST_GOVERNANCE_BATCH_FORBIDDEN') {
            throw err;
        }
        logger.warn('Failed to resolve batch id', { error: err.message });
    }

    const subSteps = [];

    subSteps.push(await runSubStep('feedback_stats', () => getJudgeFeedbackStats()));
    subSteps.push(await runSubStep('auto_promote', () => autoPromoteGroundTruth()));

    subSteps.push(await runSubStep('retro_calibration', async () => {
        if (!shouldRunRetro) return skipped('retro calibration not requested');
        if (!batchId) return skipped('no batch_id available');
        if (!referenceModel || !referenceHost) {
            return skipped('missing reference model/host');
        }
        return runRetroCalibration(
            batchId,
            { model: referenceModel, host: referenceHost },
            { perCell: retroPerCell, dryRun: retroDryRun }
        );
    }));

    subSteps.push(await runSubStep('matrix_calibration', () =>
        computeMatrixCalibration({
            judgeModel, judgeHost, referenceModel, referenceHost, passThreshold
        })
    ));

    subSteps.push(await runSubStep('drift_detection', () =>
        computeDrift({ batchId, judgeModel })
    ));

    const finishedAt = new Date();
    const duration_ms = Date.now() - t0;

    const byName = Object.fromEntries(subSteps.map(s => [s.name, s]));
    const headline = buildHeadline(byName);

    const anyFailed = subSteps.some(s => s.status === 'failed');
    const driftEvidenceIncomplete = !['ok', 'alert'].includes(headline.drift_status);
    const status = anyFailed || driftEvidenceIncomplete ? 'partial' : 'ok';

    const doc = {
        batch_id: batchId,
        judge_model: judgeModel,
        judge_host: judgeHost,
        reference_model: referenceModel,
        reference_host: referenceHost,
        triggered_by: triggeredBy,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms,
        status,
        sub_steps: subSteps,
        headline,
        notes: null
    };

    if (!persist) return doc;

    const saved = await JudgeGovernanceRun.create(doc);

    logger.info('Governance loop complete', {
        run_id: saved._id.toString(),
        status,
        duration_ms,
        auto_promoted: headline.auto_promoted,
        retro_created: headline.retro_created,
        drift_detected: headline.drift_detected
    });

    return saved.toObject();
}

/**
 * Convenience: fetch the latest persisted governance summary.
 */
async function getLatestGovernanceRun(judgeModel = null) {
    const doc = await JudgeGovernanceRun.getLatest(judgeModel);
    return doc ? doc.toObject() : null;
}

module.exports = {
    runJudgeGovernanceLoop,
    getLatestGovernanceRun,
    // exported for tests
    _internal: { runSubStep, buildHeadline, computeDrift, computeMatrixCalibration }
};

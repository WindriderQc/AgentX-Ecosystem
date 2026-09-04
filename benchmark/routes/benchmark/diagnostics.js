/**
 * Benchmark Routes - Diagnostics
 * Judge validation + ground truth management
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const logger = require('../../config/logger');
const judgeValidation = require('../../src/services/judgeValidation');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { isValidObjectId } = require('../../src/helpers/objectIdValidator');
const { runCalibrationBatch, buildAccuracyMatrix } = require('../../src/services/benchmark/calibrationRunner');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');
const { detectDrift } = require('../../src/services/benchmark/driftDetector');
const { runRetroCalibration, getCoverageStats } = require('../../src/services/benchmark/retroCalibration');
const { getJudgeFeedbackStats, autoPromoteGroundTruth } = require('../../src/services/judgeFeedbackLoop');
const {
    runJudgeGovernanceLoop,
    getLatestGovernanceRun
} = require('../../src/services/judgeGovernance');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const { requireExactConfirmation } = require('../../src/helpers/exactConfirmation');
const {
    buildStrictTrustResultExclusion,
    withPublicBenchmarkResultReadPrivacy
} = require('../../src/services/benchmark/publicReadPrivacy');
const { withManagedWorkloadRoute } = require('../../src/services/benchmark/workloadAdmissionLifecycle');

const diagnosticWorkloadOptions = req => ({
    batchId: req.body?.batch_id || null,
    hosts: [
        req.body?.judge_host,
        req.body?.reference_host,
        req.query?.judge_host,
        req.query?.reference_host
    ].filter(Boolean)
});

function isStrictTrustBatch(batch) {
    return Boolean(batch?.trust_evidence_context)
        || /^[a-f0-9]{64}$/i.test(String(batch?.trust_campaign_spec_id || ''));
}

function strictTrustOperationError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 409;
    return error;
}

function calibrationTargetKey(target) {
    const host = String(target?.host || '').trim().replace(/\/+$/, '').toLowerCase();
    const model = String(target?.model || '').trim().toLowerCase();
    return `${host}@@${model}`;
}

async function persistCalibrationUnderAdmission(payload, req) {
    const id = new mongoose.Types.ObjectId();
    req.assertWorkloadAdmissionActive?.();
    try {
        const created = await JudgeAccuracyMatrix.create(
            [{ _id: id, ...payload }],
            req.workloadAdmissionSignal ? { signal: req.workloadAdmissionSignal } : undefined
        );
        req.assertWorkloadAdmissionActive?.();
        return Array.isArray(created) ? created[0] : created;
    } catch (error) {
        if (req.workloadAdmissionSignal?.aborted
            || error?.code === 'BENCHMARK_CLAIM_LOST'
            || error?.code === 'BENCHMARK_CLAIM_STOPPED') {
            try {
                await JudgeAccuracyMatrix.updateOne(
                    { _id: id },
                    {
                        $set: {
                            authority_state: 'authority_invalidated',
                            authority_reconciliation_reason: 'diagnostic calibration raced workload admission loss'
                        }
                    },
                    { upsert: true }
                );
                error.authorityCompensated = true;
            } catch (compensationError) {
                error.compensationError = compensationError;
                error.retainAdmission = true;
                error.code = 'JUDGE_MATRIX_RECONCILIATION_PENDING';
            }
        }
        throw error;
    }
}

// ============ Judge Validation Endpoints ============

/**
 * POST /api/benchmark/judge/health
 * Run comprehensive judge health check
 */
router.post('/judge/health', withPublicBenchmarkResultReadPrivacy, withManagedWorkloadRoute('judge-health', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const { days } = req.query;
        const options = {};
        if (days) options.days = parseInt(days, 10);
        const readiness = await resolveReadyJudgeTarget({
            host: req.query.judge_host,
            model: req.query.judge_model
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Live judge health check'));
        }
        options.judgeConfig = {
            host: readiness.target.host,
            model: readiness.target.model,
            cancelSignal: req.workloadAdmissionSignal
        };

        const health = await judgeValidation.runHealthCheck(options);

        res.json({
            status: 'success',
            data: health
        });
    } catch (err) {
        logger.error('Failed to run judge health check', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
}));

/**
 * POST /api/benchmark/judge/validate/consistency
 * Run consistency test on judge
 */
router.post('/judge/validate/consistency', withPublicBenchmarkResultReadPrivacy, withManagedWorkloadRoute('judge-consistency', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const { sampleSize, repeats, category, judge_model, judge_host } = req.body;
        const readiness = await resolveReadyJudgeTarget({ host: judge_host, model: judge_model });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge consistency test'));
        }

        const result = await judgeValidation.runConsistencyTest({
            sampleSize: sampleSize || 10,
            repeats: repeats || 3,
            category: category || null,
            judgeConfig: {
                host: readiness.target.host,
                model: readiness.target.model,
                cancelSignal: req.workloadAdmissionSignal
            }
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run consistency test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
}));

/**
 * POST /api/benchmark/judge/validate/ground-truth
 * Run ground truth evaluation
 */
router.post('/judge/validate/ground-truth', withManagedWorkloadRoute('judge-ground-truth-validation', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const { category, limit, judge_model, judge_host } = req.body;
        const readiness = await resolveReadyJudgeTarget({ host: judge_host, model: judge_model });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Ground-truth judge evaluation'));
        }

        const result = await judgeValidation.runGroundTruthEvaluation({
            category: category || null,
            limit: limit || 50,
            judgeConfig: {
                host: readiness.target.host,
                model: readiness.target.model,
                cancelSignal: req.workloadAdmissionSignal
            }
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run ground truth evaluation', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
}));

/**
 * GET /api/benchmark/judge/validate/bias
 * Run bias detection analysis
 */
router.get('/judge/validate/bias', async (req, res) => {
    try {
        const { sampleSize } = req.query;

        const result = await judgeValidation.runBiasDetection({
            sampleSize: sampleSize ? parseInt(sampleSize, 10) : 100
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run bias detection', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/validate/calibration
 * Run calibration analysis
 */
router.get('/judge/validate/calibration', async (req, res) => {
    try {
        const { days } = req.query;

        const result = await judgeValidation.runCalibrationAnalysis({
            days: days ? parseInt(days, 10) : 30
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run calibration analysis', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/validate/failures
 * Run failure mode analysis
 */
router.get('/judge/validate/failures', async (req, res) => {
    try {
        const { days } = req.query;

        const result = await judgeValidation.runFailureModeAnalysis({
            days: days ? parseInt(days, 10) : 30
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to run failure mode analysis', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============ Ground Truth Management Endpoints ============

/**
 * GET /api/benchmark/judge/ground-truth
 * Get all ground truth entries
 */
router.get('/judge/ground-truth', async (req, res) => {
    try {
        const { category, active, limit } = req.query;

        const query = {
            ...JudgeGroundTruth.buildLegacyGroundTruthVisibilityFilter()
        };
        if (category) query.category = category;
        if (active !== undefined) query.active = active === 'true';

        const entries = await JudgeGroundTruth.find(query)
            .select('-reviewer -source_result_id -human_attestation_issuer_id -human_attestation_key_id -human_attestation_nonce -human_attestation_source_fingerprint')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit, 10) || 100);

        const total = await JudgeGroundTruth.countDocuments(query);

        res.json({
            status: 'success',
            data: {
                entries,
                total,
                filters: { category, active, limit }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch ground truth entries', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/ground-truth
 * Create a new ground truth entry
 */
router.post('/judge/ground-truth', async (req, res) => {
    try {
        const {
            name,
            prompt,
            response,
            category,
            expected_answer,
            expert_scores,
            expert_rationale,
            difficulty,
            tags
        } = req.body;

        // Validate required fields
        if (!name || !prompt || !response || !category || !expert_scores || !expert_rationale) {
            return res.status(400).json({
                status: 'error',
                error: 'Missing required fields: name, prompt, response, category, expert_scores, expert_rationale'
            });
        }

        if (expert_scores.overall === undefined || expert_scores.overall === null) {
            return res.status(400).json({
                status: 'error',
                error: 'expert_scores.overall is required'
            });
        }

        const entry = new JudgeGroundTruth({
            name,
            prompt,
            response,
            category,
            expected_answer: expected_answer || null,
            expert_scores: {
                overall: expert_scores.overall,
                dimensions: expert_scores.dimensions || {}
            },
            expert_rationale,
            difficulty: difficulty || 5,
            tags: tags || [],
            active: true
        });

        await entry.save();

        res.status(201).json({
            status: 'success',
            data: entry
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({
                status: 'error',
                error: 'Ground truth entry with this name already exists'
            });
        }
        logger.error('Failed to create ground truth entry', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/ground-truth/summary
 * Get accuracy summary across all ground truth entries
 */
router.get('/judge/ground-truth/summary', async (req, res) => {
    try {
        const summary = await JudgeGroundTruth.getAccuracySummary();

        res.json({
            status: 'success',
            data: summary
        });
    } catch (err) {
        logger.error('Failed to fetch ground truth summary', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/ground-truth/problematic
 * Get ground truth entries with high deviation
 */
router.get('/judge/ground-truth/problematic', async (req, res) => {
    try {
        const { threshold, limit } = req.query;

        const entries = await JudgeGroundTruth.find({
            active: true,
            ...JudgeGroundTruth.buildLegacyGroundTruthVisibilityFilter(),
            'validation_stats.avg_deviation': {
                $gte: threshold ? parseFloat(threshold) : 2.0
            }
        })
            .sort({ 'validation_stats.avg_deviation': -1 })
            .limit(limit ? parseInt(limit, 10) : 20);
        const publicEntries = entries.map(entry => {
            const value = typeof entry.toObject === 'function' ? entry.toObject() : { ...entry };
            delete value.reviewer;
            delete value.source_result_id;
            delete value.human_attestation_issuer_id;
            delete value.human_attestation_key_id;
            delete value.human_attestation_nonce;
            delete value.human_attestation_source_fingerprint;
            return value;
        });

        res.json({
            status: 'success',
            data: {
                entries: publicEntries,
                threshold: threshold || 2.0
            }
        });
    } catch (err) {
        logger.error('Failed to fetch problematic ground truth', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/ground-truth/gaps
 * Coverage grid: how many ground truth entries per category × difficulty
 */
router.get('/judge/ground-truth/gaps', async (req, res) => {
    try {
        const coverage = await getCoverageStats();
        const coverageByCell = new Map(coverage.cells.map(cell => [
            `${cell.category}\u0000${Number(cell.difficulty)}`,
            cell
        ]));

        const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
        const difficulties = [1, 2, 3, 4, 5];
        const grid = [];
        let totalEntries = 0;
        let totalAllEntries = 0;
        let retroEntries = 0;
        let emptyCount = 0;
        const targetPerCell = 5;
        let cellsMeetingTarget = 0;
        let hardEntries = 0;
        let hardOccupiedCells = 0;
        let hardCellsMeetingTarget = 0;
        const hardGaps = [];

        // Coverage is measured only from currently verified human attestations
        // returned by getCoverageStats. Raw and retro-calibration rows remain
        // visible as audit context but cannot make a cell occupied or ready.
        for (const cat of categories) {
            for (const diff of difficulties) {
                const found = coverageByCell.get(`${cat}\u0000${diff}`);
                const allCount = Number(found?.all_count) || 0;
                const retro = Number(found?.retro) || 0;
                const count = Number(found?.count) || 0;
                totalEntries += count;
                totalAllEntries += allCount;
                retroEntries += retro;
                if (count === 0) emptyCount++;
                if (count >= targetPerCell) cellsMeetingTarget++;
                if (diff >= 4) {
                    hardEntries += count;
                    if (count > 0) hardOccupiedCells++;
                    if (count >= targetPerCell) hardCellsMeetingTarget++;
                    else hardGaps.push({
                        category: cat,
                        difficulty: diff,
                        count,
                        needed: targetPerCell - count
                    });
                }
                grid.push({ category: cat, difficulty: diff, count, all_count: allCount, retro });
            }
        }

        const totalCells = categories.length * difficulties.length;
        const hardTotalCells = categories.length * 2;

        res.json({
            status: 'success',
            data: {
                grid,
                total_entries: totalEntries,
                total_all_entries: totalAllEntries,
                retro_entries: retroEntries,
                total_cells: totalCells,
                empty_cells: emptyCount,
                // Compatibility field: this measures merely whether a cell has
                // at least one human entry. It is not calibration sufficiency.
                coverage_pct: Math.round(((totalCells - emptyCount) / totalCells) * 100),
                coverage_basis: 'occupied_cells',
                target_per_cell: targetPerCell,
                cells_meeting_target: cellsMeetingTarget,
                target_coverage_pct: Math.round((cellsMeetingTarget / totalCells) * 100),
                hard_scope: {
                    levels: [4, 5],
                    total_cells: hardTotalCells,
                    entries: hardEntries,
                    occupied_cells: hardOccupiedCells,
                    empty_cells: hardTotalCells - hardOccupiedCells,
                    cells_meeting_target: hardCellsMeetingTarget,
                    target_coverage_pct: Math.round((hardCellsMeetingTarget / hardTotalCells) * 100),
                    target_per_cell: targetPerCell,
                    ready: hardCellsMeetingTarget === hardTotalCells,
                    gaps: hardGaps
                }
            }
        });
    } catch (err) {
        logger.error('Failed to compute ground truth gaps', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * PATCH /api/benchmark/judge/ground-truth/:id
 * Update a ground truth entry (e.g. toggle active status)
 */
router.patch('/judge/ground-truth/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                status: 'error',
                error: 'Invalid ground truth ID'
            });
        }

        const allowedFields = ['active', 'expert_scores', 'expert_rationale', 'difficulty', 'tags'];
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'No valid fields to update'
            });
        }

        const entry = await JudgeGroundTruth.findByIdAndUpdate(id, { $set: updates }, { new: true });

        if (!entry) {
            return res.status(404).json({
                status: 'error',
                error: 'Ground truth entry not found'
            });
        }

        res.json({
            status: 'success',
            data: entry
        });
    } catch (err) {
        logger.error('Failed to update ground truth entry', { error: err.message });
        res.status(err.statusCode || 500).json({
            status: 'error',
            code: err.code,
            error: err.message
        });
    }
});

/**
 * DELETE /api/benchmark/judge/ground-truth/:id
 * Delete a ground truth entry
 */
router.delete('/judge/ground-truth/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                status: 'error',
                error: 'Invalid ground truth ID'
            });
        }

        const expectedConfirmation = `DELETE GROUND TRUTH ${id}`;
        if (!requireExactConfirmation(req, res, expectedConfirmation)) return;

        const entry = await JudgeGroundTruth.findByIdAndDelete(id);

        if (!entry) {
            return res.status(404).json({
                status: 'error',
                error: 'Ground truth entry not found'
            });
        }

        res.json({
            status: 'success',
            message: 'Ground truth entry deleted'
        });
    } catch (err) {
        logger.error('Failed to delete ground truth entry', { error: err.message });
        res.status(err.statusCode || 500).json({
            status: 'error',
            code: err.code,
            error: err.message
        });
    }
});

// ============ Calibration Endpoints ============

/**
 * POST /api/benchmark/judge/matrix-calibrate
 * Run a judge-agreement check: score curated corpus entries with a distinct
 * reference + candidate judge, build an agreement matrix, and save it.
 */
router.post('/judge/matrix-calibrate', withManagedWorkloadRoute('judge-matrix-calibration', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const { judge_model, judge_host, reference_model, reference_host, pass_threshold } = req.body;

        if (!judge_model || !reference_model || !judge_host || !reference_host) {
            return res.status(400).json({
                status: 'error',
                error: 'Missing required fields: judge_model, judge_host, reference_model, reference_host'
            });
        }

        const entries = await JudgeGroundTruth.getForValidation();
        if (!entries || entries.length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'No ground truth entries found. Add ground truth entries before calibrating.'
            });
        }

        const [judgeReadiness, referenceReadiness] = await Promise.all([
            resolveReadyJudgeTarget({ host: judge_host, model: judge_model }),
            resolveReadyJudgeTarget({ host: reference_host, model: reference_model })
        ]);
        if (!judgeReadiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(judgeReadiness, 'Judge calibration'));
        }
        if (!referenceReadiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(referenceReadiness, 'Reference judging'));
        }
        if (calibrationTargetKey(judgeReadiness.target) === calibrationTargetKey(referenceReadiness.target)) {
            return res.status(400).json({
                status: 'error',
                code: 'CALIBRATION_TARGETS_IDENTICAL',
                error: 'Judge and reference judge must be different host/model targets.'
            });
        }

        const threshold = pass_threshold !== undefined ? pass_threshold : 1.5;

        const referenceScores = await runCalibrationBatch(entries, {
            model: referenceReadiness.target.model,
            host: referenceReadiness.target.host,
            cancelSignal: req.workloadAdmissionSignal
        });

        const challengerScores = await runCalibrationBatch(entries, {
            model: judgeReadiness.target.model,
            host: judgeReadiness.target.host,
            cancelSignal: req.workloadAdmissionSignal
        });

        const matrix = buildAccuracyMatrix(referenceScores, challengerScores, threshold);

        const saved = await persistCalibrationUnderAdmission({
            judge_model: judgeReadiness.target.model,
            judge_host: String(judgeReadiness.target.host || judge_host).trim().replace(/\/+$/, ''),
            reference_model: referenceReadiness.target.model,
            reference_host: String(referenceReadiness.target.host || reference_host).trim().replace(/\/+$/, ''),
            pass_threshold: threshold,
            ground_truth_count: entries.length,
            cells: matrix.cells,
            overall_avg_deviation: matrix.overall_avg_deviation,
            pass_rate: matrix.pass_rate,
            cell_pass_rate: matrix.cell_pass_rate,
            scored_entry_count: matrix.scored_entry_count,
            comparison_kind: 'reference_judge_agreement'
        }, req);

        logger.info('Calibration complete', {
            judge_model,
            reference_model,
            ground_truth_count: entries.length,
            overall_avg_deviation: matrix.overall_avg_deviation,
            pass_rate: matrix.pass_rate
        });

        res.json({
            status: 'success',
            data: saved
        });
    } catch (err) {
        logger.error('Failed to run calibration', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
}));

/**
 * GET /api/benchmark/judge/calibration-status
 * Returns latest calibration matrices for all judges, or a specific judge.
 * Query params: judge_model (optional)
 */
router.get('/judge/calibration-status', async (req, res) => {
    try {
        const { judge_model, judge_host } = req.query;

        let matrices;
        if (judge_model) {
            if (!judge_host) {
                return res.status(400).json({
                    status: 'error',
                    code: 'JUDGE_HOST_REQUIRED',
                    error: 'judge_host is required when requesting one judge calibration target.'
                });
            }
            const latest = await JudgeAccuracyMatrix.getLatest(judge_model, judge_host);
            matrices = latest ? [latest] : [];
        } else {
            // Aggregate to get the latest matrix per judge_model
            matrices = await JudgeAccuracyMatrix.aggregate([
                { $sort: { calibrated_at: -1 } },
                {
                    $group: {
                        _id: {
                            judge_model: '$judge_model',
                            judge_host: '$judge_host'
                        },
                        doc: { $first: '$$ROOT' }
                    }
                },
                { $replaceRoot: { newRoot: '$doc' } },
                { $sort: { calibrated_at: -1 } }
            ]);
        }

        res.json({
            status: 'success',
            data: {
                matrices: matrices.map((matrix) => {
                    const value = typeof matrix?.toObject === 'function' ? matrix.toObject() : matrix;
                    return {
                        ...value,
                        comparison_kind: value?.comparison_kind || 'reference_judge_agreement'
                    };
                })
            }
        });
    } catch (err) {
        logger.error('Failed to fetch calibration status', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============ Drift Detection Endpoints ============

/**
 * GET /api/benchmark/judge/drift
 * Check score distribution drift on the most recent (or specified) batch vs historical.
 * Query params: judge_model (optional), batch_id (optional)
 */
router.get('/judge/drift', async (req, res) => {
    try {
        const { judge_model, batch_id } = req.query;

        const match = { quality_score: { $ne: null } };
        if (judge_model) match.judge_model = judge_model;

        const latestBatch = batch_id
            ? null
            : await BenchmarkBatch
                .findOne({
                    judge_status: 'completed',
                    trust_campaign_spec_id: null,
                    trust_evidence_context: null
                })
                .sort({ updatedAt: -1 })
                .lean();

        const effectiveBatchId = batch_id || latestBatch?._id?.toString();
        if (!effectiveBatchId) {
            return res.json({ status: 'success', data: { drifted: null, insufficient_data: true } });
        }
        const normalizedBatchId = String(effectiveBatchId);
        if (!/^[0-9a-f]{24}$/i.test(normalizedBatchId)) {
            return res.status(400).json({
                status: 'error',
                code: 'BENCHMARK_DRIFT_BATCH_ID_INVALID',
                error: 'batch_id must be a canonical Mongo ObjectId'
            });
        }
        // Aggregation pipelines do not apply Mongoose query casting. Use the
        // stored ObjectId type for both sides so the current batch is selected
        // and excluded from the historical cohort exactly.
        const batchObjectId = new mongoose.Types.ObjectId(normalizedBatchId);
        const trustExclusion = buildStrictTrustResultExclusion();

        const [currentStats, historicalStats] = await Promise.all([
            BenchmarkResult.aggregate([
                { $match: { ...match, batch_id: batchObjectId, ...trustExclusion } },
                { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
            ]),
            BenchmarkResult.aggregate([
                { $match: { ...match, batch_id: { $ne: batchObjectId }, ...trustExclusion } },
                { $sort: { timestamp: -1 } },
                { $limit: 500 },
                { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
            ])
        ]);

        if (!currentStats.length || !historicalStats.length) {
            return res.json({ status: 'success', data: { drifted: null, insufficient_data: true } });
        }

        const current = { mean: currentStats[0].mean, variance: (currentStats[0].stddev || 0) ** 2, count: currentStats[0].count };
        const historical = { mean: historicalStats[0].mean, variance: (historicalStats[0].stddev || 0) ** 2, count: historicalStats[0].count };

        const drift = detectDrift(current, historical);
        res.json({ status: 'success', data: { ...drift, batch_id: normalizedBatchId } });
    } catch (err) {
        logger.error('Drift check failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============ Retro-Calibration Endpoints ============

/**
 * POST /api/benchmark/judge/retro-calibrate
 * Expand ground truth by sampling a batch, re-scoring with a reference judge,
 * and creating JudgeGroundTruth entries with stratified coverage.
 */
router.post('/judge/retro-calibrate', withManagedWorkloadRoute('judge-retro-calibration', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const { batch_id, reference_model, reference_host, per_cell, dry_run } = req.body;

        if (!batch_id || !reference_model || !reference_host) {
            return res.status(400).json({
                status: 'error',
                error: 'Missing required fields: batch_id, reference_model, reference_host'
            });
        }

        const batch = await BenchmarkBatch.findById(batch_id)
            .select('trust_campaign_spec_id +trust_evidence_context');
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }
        if (isStrictTrustBatch(batch)) {
            throw strictTrustOperationError(
                'BENCHMARK_TRUST_RETRO_CALIBRATION_FORBIDDEN',
                'Strict Benchmark Trust evidence cannot be consumed by legacy retro-calibration'
            );
        }

        const readiness = await resolveReadyJudgeTarget({
            host: reference_host,
            model: reference_model
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Retro-calibration'));
        }

        const result = await runRetroCalibration(batch_id, {
            model: readiness.target.model,
            host: readiness.target.host
        }, {
            perCell: per_cell || 3,
            dryRun: dry_run || false,
            cancelSignal: req.workloadAdmissionSignal,
            assertAuthorityActive: req.assertWorkloadAdmissionActive
        });

        res.json({ status: 'success', data: result });
    } catch (err) {
        if (err.retainAdmission === true) req.workloadAdmissionReconciliationError = err;
        logger.error('Retro-calibration failed', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
}));

/**
 * GET /api/benchmark/judge/ground-truth/coverage
 * Returns coverage matrix showing ground truth counts per category x difficulty cell.
 */
router.get('/judge/ground-truth/coverage', async (req, res) => {
    try {
        const coverage = await getCoverageStats();
        res.json({ status: 'success', data: coverage });
    } catch (err) {
        logger.error('Coverage stats failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/feedback-stats
 * Per-category accuracy stats: human review vs judge score divergence
 */
router.get('/judge/feedback-stats', async (req, res) => {
    try {
        const stats = await getJudgeFeedbackStats();
        res.json({ status: 'success', data: stats });
    } catch (err) {
        logger.error('Judge feedback stats failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/auto-promote
 * Auto-promote high-divergence human-reviewed results to ground truth
 */
router.post('/judge/auto-promote', withManagedWorkloadRoute('judge-auto-promote', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const result = await autoPromoteGroundTruth({
            cancelSignal: req.workloadAdmissionSignal,
            assertAuthorityActive: req.assertWorkloadAdmissionActive
        });
        res.json({ status: 'success', data: result });
    } catch (err) {
        if (err.retainAdmission === true) req.workloadAdmissionReconciliationError = err;
        logger.error('Auto-promote failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
}));

// ============ Governance Loop Endpoints (TODO 0125) ============

/**
 * POST /api/benchmark/judge/governance-run
 *
 * Trigger one full governance loop and return the saved summary.
 * Body: {
 *   batch_id?, judge_model?, judge_host?, reference_model?, reference_host?,
 *   pass_threshold?, run_retro_calibration?, retro_per_cell?, retro_dry_run?,
 *   triggered_by?
 * }
 *
 * All fields are optional. Sub-steps that are missing prerequisite inputs
 * are marked `skipped` in the summary instead of failing the whole run.
 */
router.post('/judge/governance-run', withManagedWorkloadRoute('judge-governance', diagnosticWorkloadOptions, async (req, res) => {
    try {
        const {
            batch_id, judge_model, judge_host, reference_model, reference_host,
            pass_threshold, run_retro_calibration, retro_per_cell, retro_dry_run,
            triggered_by
        } = req.body || {};

        if (batch_id) {
            const batch = await BenchmarkBatch.findById(batch_id)
                .select('trust_campaign_spec_id +trust_evidence_context');
            if (!batch) {
                return res.status(404).json({ status: 'error', error: 'Batch not found' });
            }
            if (isStrictTrustBatch(batch)) {
                throw strictTrustOperationError(
                    'BENCHMARK_TRUST_GOVERNANCE_BATCH_FORBIDDEN',
                    'Strict Benchmark Trust evidence cannot be consumed by legacy judge governance'
                );
            }
        }

        if (judge_model || judge_host) {
            const readiness = await resolveReadyJudgeTarget({ host: judge_host, model: judge_model });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge governance'));
            }
        }
        if (run_retro_calibration || reference_model || reference_host) {
            const readiness = await resolveReadyJudgeTarget({ host: reference_host, model: reference_model });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Reference governance'));
            }
        }

        const summary = await runJudgeGovernanceLoop({
            batchId: batch_id || null,
            judgeModel: judge_model || null,
            judgeHost: judge_host || null,
            referenceModel: reference_model || null,
            referenceHost: reference_host || null,
            passThreshold: pass_threshold !== undefined ? pass_threshold : 1.5,
            runRetroCalibration: !!run_retro_calibration,
            retroPerCell: retro_per_cell || 3,
            retroDryRun: !!retro_dry_run,
            triggeredBy: triggered_by || 'api',
            cancelSignal: req.workloadAdmissionSignal,
            assertAuthorityActive: req.assertWorkloadAdmissionActive
        });

        res.json({ status: 'success', data: summary });
    } catch (err) {
        if (err.retainAdmission === true) req.workloadAdmissionReconciliationError = err;
        logger.error('Governance loop failed', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
}));

/**
 * GET /api/benchmark/judge/governance-run/latest
 * Returns the most recent persisted governance summary.
 * Query: judge_model (optional)
 */
router.get('/judge/governance-run/latest', async (req, res) => {
    try {
        const { judge_model } = req.query;
        const summary = await getLatestGovernanceRun(judge_model || null);
        if (!summary) {
            return res.json({ status: 'success', data: null });
        }
        res.json({ status: 'success', data: summary });
    } catch (err) {
        logger.error('Fetch latest governance run failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;

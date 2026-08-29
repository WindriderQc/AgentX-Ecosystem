/**
 * Benchmark Routes - Diagnostics
 * Judge validation + ground truth management
 */

const express = require('express');
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

// ============ Judge Validation Endpoints ============

/**
 * POST /api/benchmark/judge/health
 * Run comprehensive judge health check
 */
router.post('/judge/health', async (req, res) => {
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
            model: readiness.target.model
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
});

/**
 * POST /api/benchmark/judge/validate/consistency
 * Run consistency test on judge
 */
router.post('/judge/validate/consistency', async (req, res) => {
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
                model: readiness.target.model
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
});

/**
 * POST /api/benchmark/judge/validate/ground-truth
 * Run ground truth evaluation
 */
router.post('/judge/validate/ground-truth', async (req, res) => {
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
                model: readiness.target.model
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
});

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

        const query = {};
        if (category) query.category = category;
        if (active !== undefined) query.active = active === 'true';

        const entries = await JudgeGroundTruth.find(query)
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

        const entries = await JudgeGroundTruth.getHighDeviation(
            threshold ? parseFloat(threshold) : 2.0,
            limit ? parseInt(limit, 10) : 20
        );

        res.json({
            status: 'success',
            data: {
                entries,
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
        const coverage = await JudgeGroundTruth.aggregate([
            { $match: { active: true } },
            {
                $group: {
                    _id: { category: '$category', difficulty: '$difficulty' },
                    count: { $sum: 1 },
                    retro_count: {
                        $sum: { $cond: [{ $eq: ['$created_by', 'retro-calibration'] }, 1, 0] }
                    }
                }
            },
            { $sort: { '_id.category': 1, '_id.difficulty': 1 } }
        ]);

        const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
        const difficulties = [1, 2, 3, 4, 5];
        const grid = [];
        let totalEntries = 0;
        let totalAllEntries = 0;
        let retroEntries = 0;
        let emptyCount = 0;

        // Coverage is measured against human-derived ground truth only.
        // retro-calibration rows are LLM-reference re-scores; counting them as
        // filled cells would inflate coverage_pct and let the judge be validated
        // against itself. all_count/retro expose the combined view without
        // conflating the two (mirrors retroCalibration.getCoverageStats).
        for (const cat of categories) {
            for (const diff of difficulties) {
                const found = coverage.find(
                    c => c._id.category === cat && c._id.difficulty === diff
                );
                const allCount = found ? found.count : 0;
                const retro = found ? found.retro_count : 0;
                const count = allCount - retro;
                totalEntries += count;
                totalAllEntries += allCount;
                retroEntries += retro;
                if (count === 0) emptyCount++;
                grid.push({ category: cat, difficulty: diff, count, all_count: allCount, retro });
            }
        }

        res.json({
            status: 'success',
            data: {
                grid,
                total_entries: totalEntries,
                total_all_entries: totalAllEntries,
                retro_entries: retroEntries,
                total_cells: categories.length * difficulties.length,
                empty_cells: emptyCount,
                coverage_pct: Math.round(((categories.length * difficulties.length - emptyCount) / (categories.length * difficulties.length)) * 100)
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
        res.status(500).json({ status: 'error', error: err.message });
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
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============ Calibration Endpoints ============

/**
 * POST /api/benchmark/judge/matrix-calibrate
 * Run full calibration: score ground truth with reference + challenger judge,
 * build accuracy matrix, save to DB.
 */
router.post('/judge/matrix-calibrate', async (req, res) => {
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

        const threshold = pass_threshold !== undefined ? pass_threshold : 1.5;

        const referenceScores = await runCalibrationBatch(entries, {
            model: referenceReadiness.target.model,
            host: referenceReadiness.target.host
        });

        const challengerScores = await runCalibrationBatch(entries, {
            model: judgeReadiness.target.model,
            host: judgeReadiness.target.host
        });

        const matrix = buildAccuracyMatrix(referenceScores, challengerScores, threshold);

        const saved = await JudgeAccuracyMatrix.create({
            judge_model,
            judge_host,
            reference_model,
            reference_host,
            pass_threshold: threshold,
            ground_truth_count: entries.length,
            cells: matrix.cells,
            overall_avg_deviation: matrix.overall_avg_deviation,
            pass_rate: matrix.pass_rate
        });

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
});

/**
 * GET /api/benchmark/judge/calibration-status
 * Returns latest calibration matrices for all judges, or a specific judge.
 * Query params: judge_model (optional)
 */
router.get('/judge/calibration-status', async (req, res) => {
    try {
        const { judge_model } = req.query;

        let matrices;
        if (judge_model) {
            const latest = await JudgeAccuracyMatrix.getLatest(judge_model);
            matrices = latest ? [latest] : [];
        } else {
            // Aggregate to get the latest matrix per judge_model
            matrices = await JudgeAccuracyMatrix.aggregate([
                { $sort: { calibrated_at: -1 } },
                {
                    $group: {
                        _id: '$judge_model',
                        doc: { $first: '$$ROOT' }
                    }
                },
                { $replaceRoot: { newRoot: '$doc' } },
                { $sort: { calibrated_at: -1 } }
            ]);
        }

        res.json({
            status: 'success',
            data: { matrices }
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
                .findOne({ judge_status: 'completed' })
                .sort({ updatedAt: -1 })
                .lean();

        const effectiveBatchId = batch_id || latestBatch?._id?.toString();
        if (!effectiveBatchId) {
            return res.json({ status: 'success', data: { drifted: false, insufficient_data: true } });
        }

        const [currentStats, historicalStats] = await Promise.all([
            BenchmarkResult.aggregate([
                { $match: { ...match, batch_id: effectiveBatchId } },
                { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
            ]),
            BenchmarkResult.aggregate([
                { $match: { ...match, batch_id: { $ne: effectiveBatchId } } },
                { $sort: { timestamp: -1 } },
                { $limit: 500 },
                { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
            ])
        ]);

        if (!currentStats.length || !historicalStats.length) {
            return res.json({ status: 'success', data: { drifted: false, insufficient_data: true } });
        }

        const current = { mean: currentStats[0].mean, variance: (currentStats[0].stddev || 0) ** 2, count: currentStats[0].count };
        const historical = { mean: historicalStats[0].mean, variance: (historicalStats[0].stddev || 0) ** 2, count: historicalStats[0].count };

        const drift = detectDrift(current, historical);
        res.json({ status: 'success', data: { ...drift, batch_id: effectiveBatchId } });
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
router.post('/judge/retro-calibrate', async (req, res) => {
    try {
        const { batch_id, reference_model, reference_host, per_cell, dry_run } = req.body;

        if (!batch_id || !reference_model || !reference_host) {
            return res.status(400).json({
                status: 'error',
                error: 'Missing required fields: batch_id, reference_model, reference_host'
            });
        }

        const batch = await BenchmarkBatch.findById(batch_id);
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
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
            dryRun: dry_run || false
        });

        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Retro-calibration failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

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
router.post('/judge/auto-promote', async (req, res) => {
    try {
        const result = await autoPromoteGroundTruth();
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Auto-promote failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

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
router.post('/judge/governance-run', async (req, res) => {
    try {
        const {
            batch_id, judge_model, judge_host, reference_model, reference_host,
            pass_threshold, run_retro_calibration, retro_per_cell, retro_dry_run,
            triggered_by
        } = req.body || {};

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
            triggeredBy: triggered_by || 'api'
        });

        res.json({ status: 'success', data: summary });
    } catch (err) {
        logger.error('Governance loop failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

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

/**
 * Benchmark Routes - Analytics
 * Summary, dashboard, compare, trends, leaderboard, presets
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { getCategoryHeatmap, getDimensionBreakdown, calculateEliteScores, detectCeilingModels, CEILING_THRESHOLD } = require('../../src/services/benchmark/ceilingDetection');
const { calculateAllGeneralistScores, getActiveCategoryWeights } = require('../../src/services/benchmark/generalistScore');
const { compareBatchRegression, detectLatestRegression, generateChangelog } = require('../../src/services/benchmark/regressionDetector');
const { archiveOldResults, pruneExcessBatches, purgeDeadModels, getRetentionStats } = require('../../src/services/benchmark/dataRetention');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const { requireExactConfirmation } = require('../../src/helpers/exactConfirmation');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkTrustReceipt = require('../../models/BenchmarkTrustReceipt');
const { withBenchmarkTrustEvidenceLock } = require('../../src/services/benchmark/benchmarkTrustEvidenceLock');
const {
    withPublicBenchmarkResultReadPrivacy
} = require('../../src/services/benchmark/publicReadPrivacy');

function parseBool(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

/**
 * GET /api/benchmark/summary
 * Get summary statistics and leaderboard
 */
router.get('/summary', async (req, res) => {
    try {
        const summary = await benchmarkService.getSummary();

        res.json({
            status: 'success',
            message: summary.total_tests === 0 ? 'No successful tests yet' : undefined,
            data: summary
        });
    } catch (err) {
        logger.error('Failed to generate summary', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/dashboard
 * Get dashboard data with charts and stats including quality metrics
 */
router.get('/dashboard', async (req, res) => {
    try {
        const { sort, modelCategory, promptCategory, tag } = req.query;
        const sortBy = sort || 'latency';
        const includeUnavailableModels = parseBool(req.query.includeUnavailableModels);
        const includeCloud = String(req.query.includeCloud ?? 'true').toLowerCase() !== 'false';

        const dashboard = await benchmarkService.getDashboard({
            sortBy,
            modelCategory,
            promptCategory,
            tag,
            includeUnavailableModels,
            includeCloud
        });

        res.json({
            status: 'success',
            data: dashboard
        });
    } catch (err) {
        logger.error('Failed to load dashboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/compare
 * Compare multiple models
 */
router.get('/compare', async (req, res) => {
    const { models } = req.query;

    if (!models) {
        return res.status(400).json({
            status: 'error',
            error: 'models query parameter required (comma-separated)'
        });
    }

    const modelList = models.split(',').map(m => m.trim());

    try {
        const { comparison } = await benchmarkService.compareModels(modelList);

        res.json({
            status: 'success',
            data: { comparison }
        });
    } catch (err) {
        logger.error('Failed to compare models', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/quality-breakdown
 * Get quality scores broken down by category and level
 */
router.get('/quality-breakdown', async (req, res) => {
    try {
        const { model, host } = req.query;

        const data = await benchmarkService.getQualityBreakdown(model, host);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch quality breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/quality-breakdown/batch
 * Fetch quality breakdowns for multiple model/host pairs in one request.
 * Body: { pairs: [{ model, host }] }  -- max 50 entries.
 */
router.post('/quality-breakdown/batch', withPublicBenchmarkResultReadPrivacy, async (req, res) => {
    try {
        const { pairs } = req.body || {};

        if (!Array.isArray(pairs) || pairs.length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'pairs array is required and must be non-empty'
            });
        }

        if (pairs.length > 50) {
            return res.status(400).json({
                status: 'error',
                error: 'pairs array must not exceed 50 entries'
            });
        }

        const data = await benchmarkService.getBatchQualityBreakdown(pairs);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batch quality breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/trends
 * Get time-series performance trends
 */
router.get('/trends', async (req, res) => {
    try {
        const { model, days, groupBy } = req.query;

        const data = await benchmarkService.getModelTrends({
            model,
            days: parseInt(days, 10) || 7,
            groupBy: groupBy || 'day'
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch trends', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge-leaderboard
 * Get judge performance statistics
 */
router.get('/judge-leaderboard', async (req, res) => {
    try {
        const leaderboard = await benchmarkService.getJudgeLeaderboard();
        const activity = await benchmarkService.getJudgeActivity(5);

        res.json({
            status: 'success',
            data: {
                leaderboard,
                activity
            }
        });
    } catch (err) {
        logger.error('Failed to fetch judge leaderboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/generalist-leaderboard
 * Get generalist quality scores for all models
 */
router.get('/generalist-leaderboard', async (req, res) => {
    try {
        // ?axis=composite|quality|deterministic|subjective. Defaults to
        // composite (latency-aware headline). axis=quality preserves the
        // pre-2026-05 behavior (judge quality only, no latency component).
        const axisRaw = String(req.query.axis || 'composite').toLowerCase();
        const axis = ['composite', 'quality', 'deterministic', 'subjective'].includes(axisRaw) ? axisRaw : 'composite';
        // ?hostScope=primary limits rankings to the primary configured
        // Ollama host. ?hostScope=current includes every configured host.
        // ?hostScope=all preserves the historical archive view.
        const hostScopeRaw = String(req.query.hostScope || 'all').toLowerCase();
        const hostScope = hostScopeRaw === 'primary' ? 'primary'
            : hostScopeRaw === 'current' ? 'current'
            : 'all';
        // ?challengeScope=advanced limits rankings to L4-L5 hard prompts.
        // ?challengeScope=foundation limits rankings to L1-L3 prompts and
        // disables the hard-level penalty for that intentional cohort view.
        const challengeScopeRaw = String(req.query.challengeScope || 'all').toLowerCase();
        const challengeScope = ['advanced', 'foundation'].includes(challengeScopeRaw)
            ? challengeScopeRaw
            : 'all';
        // Trust scope is a required consumer decision. Silent exploratory
        // fallback let report and recommendation callers turn archive data
        // into authoritative-looking winners.
        const trustScopeRaw = String(req.query.trustScope || req.query.trust || '').toLowerCase();
        if (!['trusted', 'exploratory'].includes(trustScopeRaw)) {
            return res.status(400).json({
                status: 'error',
                code: 'TRUST_SCOPE_REQUIRED',
                error: 'trustScope must be explicitly set to trusted or exploratory'
            });
        }
        const trustScope = trustScopeRaw;
        const includeUnavailableModels = parseBool(req.query.includeUnavailableModels);
        const includeCloud = String(req.query.includeCloud ?? 'true').toLowerCase() !== 'false';
        const data = await benchmarkService.getGeneralistLeaderboard({
            axis,
            hostScope,
            challengeScope,
            trustScope,
            includeUnavailableModels,
            includeCloud
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch generalist leaderboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/host-names
 * Returns URL-to-friendly-name mapping for Ollama hosts
 */
router.get('/host-names', (req, res) => {
    const hosts = getConfiguredHosts();
    const hostMap = {};
    for (const h of hosts) {
        hostMap[h.url] = h.name;
    }
    res.json({ status: 'success', data: hostMap });
});

/**
 * GET /api/benchmark/judge-breakdown
 * Break down judge performance by prompt level or model-under-test
 */
router.get('/judge-breakdown', async (req, res) => {
    try {
        const { judge_model, judge_host, groupBy, limit } = req.query;

        if (!judge_model) {
            return res.status(400).json({
                status: 'error',
                error: 'judge_model query parameter is required'
            });
        }

        const data = await benchmarkService.getJudgeBreakdown({
            judge_model: String(judge_model),
            judge_host: (judge_host !== undefined ? String(judge_host) : null),
            groupBy: groupBy ? String(groupBy) : 'level',
            limit: limit !== undefined ? Number(limit) : undefined
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch judge breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/truncation-stats
 * Get truncation statistics for diagnostics
 */
router.get('/truncation-stats', async (req, res) => {
    try {
        const { batch_id, limit } = req.query;

        const data = await benchmarkService.getTruncationStats({
            batch_id: batch_id || null,
            limit: limit ? parseInt(limit, 10) : 1000
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch truncation stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/compare-batches
 * Compare multiple batches side-by-side
 */
router.post('/compare-batches', withPublicBenchmarkResultReadPrivacy, async (req, res) => {
    try {
        const { batch_ids } = req.body;

        if (!batch_ids || !Array.isArray(batch_ids)) {
            return res.status(400).json({
                status: 'error',
                error: 'batch_ids array is required'
            });
        }

        if (batch_ids.length > 20) {
            return res.status(400).json({
                status: 'error',
                error: 'Maximum 20 batch IDs allowed for comparison'
            });
        }

        const { isValidObjectId } = require('mongoose');
        const invalidIds = batch_ids.filter(id => !isValidObjectId(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({
                status: 'error',
                error: `Invalid batch IDs: ${invalidIds.join(', ')}`
            });
        }

        const requestedBatches = await BenchmarkBatch.find({ _id: { $in: batch_ids } })
            .select('_id trust_campaign_spec_id +trust_evidence_context')
            .lean();
        if (requestedBatches.some(batch => (
            benchmarkService.isTrustCampaignBatch(batch) || batch.trust_evidence_context
        ))) {
            return res.status(409).json({
                status: 'error',
                code: 'BENCHMARK_TRUST_GENERIC_COMPARISON_FORBIDDEN',
                error: 'Strict Benchmark Trust campaigns cannot be opened through generic batch comparison'
            });
        }

        const data = await benchmarkService.compareBatches(batch_ids);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to compare batches', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * GET /api/benchmark/stats-by-tag
 * Get statistics grouped by tags
 */
router.get('/stats-by-tag', async (req, res) => {
    try {
        const data = await benchmarkService.getBatchStatsByTag();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch stats by tag', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/active-stats
 * Get real-time statistics for active batches
 */
router.get('/active-stats', async (req, res) => {
    try {
        const data = await benchmarkService.getActiveStats();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch active stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/presets
 * Get configuration presets for common test scenarios
 */
router.get('/presets', (req, res) => {
    try {
        const data = benchmarkService.getConfigPresets();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch presets', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge-calibration
 * Judge accuracy vs human reviewers — per judge model:
 * - agreement rate (within ±1 point)
 * - mean absolute error
 * - systematic bias (positive = judge scores higher than human)
 * - per-category breakdown
 */
router.get('/judge-calibration', async (req, res) => {
    try {

        // Find all results that have both judge and human scores
        const reviewed = await BenchmarkResult.find({
            human_score: { $ne: null },
            quality_score: { $ne: null },
            judge_model: { $ne: null }
        }).select({
            judge_model: 1, quality_score: 1, human_score: 1,
            prompt_category: 1, human_notes: 1
        }).lean();

        if (reviewed.length === 0) {
            return res.json({
                status: 'success',
                data: { judges: [], totalReviews: 0, message: 'No human reviews yet' }
            });
        }

        // Group by judge model
        const byJudge = {};
        for (const r of reviewed) {
            const jm = r.judge_model;
            if (!byJudge[jm]) byJudge[jm] = [];
            byJudge[jm].push(r);
        }

        const judges = [];
        for (const [judgeModel, results] of Object.entries(byJudge)) {
            let totalError = 0;
            let totalBias = 0;
            let agreements = 0;
            const byCategory = {};

            for (const r of results) {
                const diff = r.quality_score - r.human_score;
                const absDiff = Math.abs(diff);
                totalError += absDiff;
                totalBias += diff;
                if (absDiff <= 1) agreements++;

                // Per-category stats
                const cat = r.prompt_category || 'unknown';
                if (!byCategory[cat]) byCategory[cat] = { count: 0, totalError: 0, totalBias: 0, agreements: 0 };
                byCategory[cat].count++;
                byCategory[cat].totalError += absDiff;
                byCategory[cat].totalBias += diff;
                if (absDiff <= 1) byCategory[cat].agreements++;
            }

            const n = results.length;
            const categoryBreakdown = {};
            for (const [cat, stats] of Object.entries(byCategory)) {
                categoryBreakdown[cat] = {
                    reviews: stats.count,
                    meanAbsoluteError: Math.round((stats.totalError / stats.count) * 100) / 100,
                    bias: Math.round((stats.totalBias / stats.count) * 100) / 100,
                    agreementRate: Math.round((stats.agreements / stats.count) * 100)
                };
            }

            judges.push({
                judgeModel,
                reviews: n,
                meanAbsoluteError: Math.round((totalError / n) * 100) / 100,
                bias: Math.round((totalBias / n) * 100) / 100,
                agreementRate: Math.round((agreements / n) * 100),
                categoryBreakdown
            });
        }

        judges.sort((a, b) => a.meanAbsoluteError - b.meanAbsoluteError);

        res.json({
            status: 'success',
            data: { judges, totalReviews: reviewed.length }
        });
    } catch (err) {
        logger.error('Failed to fetch judge calibration', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/ceiling-analysis
 * Detect ceiling models and suggest differentiation strategies
 */
router.get('/ceiling-analysis', async (req, res) => {
    try {
        const threshold = parseFloat(req.query.threshold) || CEILING_THRESHOLD;
        const categoryWeights = await getActiveCategoryWeights();
        // Defense in depth per scoring-contract-v1 §2.7 (0117): infra-failed rows never surface
        // in a leaderboard, even though success:true already excludes them.
        const leaderboardMatch = {
            success: true,
            infra_error: { $ne: true },
            excluded_from_leaderboard: { $ne: true }
        };
        const generalistScores = await calculateAllGeneralistScores(leaderboardMatch, { categoryWeights });
        const ceilingModels = detectCeilingModels(generalistScores, threshold);
        const eliteScores = await calculateEliteScores(leaderboardMatch);

        // Match elite scores to ceiling models
        const enriched = ceilingModels.map(cm => {
            const elite = eliteScores.find(e => e.model === cm.model && e.host === cm.host);
            return {
                ...cm,
                eliteScore: elite?.eliteScore || null,
                eliteCoverage: elite?.eliteCoverage || 0,
                eliteCategoryScores: elite?.categoryScores || {}
            };
        });

        res.json({
            status: 'success',
            data: {
                threshold,
                ceilingCount: enriched.length,
                totalModels: [...generalistScores.values()].filter(d => !d.filtered).length,
                ceilingModels: enriched
            }
        });
    } catch (err) {
        logger.error('Failed to fetch ceiling analysis', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/category-heatmap
 * Model x category score matrix for heatmap visualization
 */
router.get('/category-heatmap', async (req, res) => {
    try {
        // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra_error.
        const data = await getCategoryHeatmap({
            success: true,
            infra_error: { $ne: true },
            excluded_from_leaderboard: { $ne: true }
        });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch category heatmap', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/dimension-breakdown
 * Per-model scoring dimension averages from quality_breakdown
 */
router.get('/dimension-breakdown', async (req, res) => {
    try {
        // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra_error.
        const data = await getDimensionBreakdown({
            success: true,
            infra_error: { $ne: true },
            excluded_from_leaderboard: { $ne: true }
        });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch dimension breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/elite-scores
 * Elite scores based on hard-mode categories (L4+ prompts only)
 */
router.get('/elite-scores', async (req, res) => {
    try {
        // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra_error.
        const data = await calculateEliteScores({
            success: true,
            infra_error: { $ne: true },
            excluded_from_leaderboard: { $ne: true }
        });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch elite scores', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/regression
 * Auto-detect regressions between the two most recent completed batches
 */
router.get('/regression', async (req, res) => {
    try {
        const report = await detectLatestRegression();
        if (!report) {
            return res.json({
                status: 'success',
                data: null,
                message: 'Need at least 2 completed batches to detect regressions'
            });
        }

        res.json({
            status: 'success',
            data: {
                ...report,
                changelog: generateChangelog(report)
            }
        });
    } catch (err) {
        logger.error('Failed to detect regressions', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/regression/compare
 * Compare two specific batches for regressions
 * Body: { current_batch_id, previous_batch_id }
 */
router.post('/regression/compare', withPublicBenchmarkResultReadPrivacy, async (req, res) => {
    try {
        const { current_batch_id, previous_batch_id } = req.body || {};
        if (!current_batch_id || !previous_batch_id) {
            return res.status(400).json({
                status: 'error',
                error: 'current_batch_id and previous_batch_id are required'
            });
        }
        if (!validateObjectId(current_batch_id, res, 'current_batch_id')) return;
        if (!validateObjectId(previous_batch_id, res, 'previous_batch_id')) return;

        const report = await compareBatchRegression(current_batch_id, previous_batch_id);

        res.json({
            status: 'success',
            data: {
                ...report,
                changelog: generateChangelog(report)
            }
        });
    } catch (err) {
        logger.error('Failed to compare batches for regression', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * GET /api/benchmark/retention/stats
 * Get data retention statistics (how much can be cleaned up)
 */
router.get('/retention/stats', async (req, res) => {
    try {
        const stats = await getRetentionStats();
        res.json({ status: 'success', data: stats });
    } catch (err) {
        logger.error('Failed to get retention stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/archive
 * Archive old batch results beyond retention period
 * Body: { retention_days, dry_run }
 */
router.post('/retention/archive', async (req, res) => {
    try {
        const { retention_days, dry_run } = req.body || {};
        const days = parseInt(retention_days, 10) || 90;
        const dryRun = dry_run !== false && dry_run !== 0;
        const expectedConfirmation = `DELETE RESULTS OLDER THAN ${days} DAYS`;

        if (!dryRun && !requireExactConfirmation(req, res, expectedConfirmation)) return;

        const result = await archiveOldResults(days, dryRun);
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to archive old results', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/prune
 * Prune excess batches per model (keep only latest N)
 * Body: { keep_batches, dry_run }
 */
router.post('/retention/prune', async (req, res) => {
    try {
        const { keep_batches, dry_run } = req.body || {};
        const keep = parseInt(keep_batches, 10) || 3;
        const dryRun = dry_run !== false && dry_run !== 0;
        const expectedConfirmation = `PRUNE RESULTS TO ${keep} BATCHES PER MODEL`;

        if (!dryRun && !requireExactConfirmation(req, res, expectedConfirmation)) return;

        const result = await pruneExcessBatches(keep, dryRun);
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to prune excess batches', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/purge-dead
 * Purge results from dead models (95%+ empty responses)
 * Body: { dry_run }
 */
router.post('/retention/purge-dead', async (req, res) => {
    try {
        const { dry_run } = req.body || {};
        const dryRun = dry_run !== false && dry_run !== 0;
        const expectedConfirmation = 'PURGE DEAD MODEL RESULTS';

        if (!dryRun && !requireExactConfirmation(req, res, expectedConfirmation)) return;

        const result = await purgeDeadModels(dryRun);
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to purge dead models', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/reset-all
 * Nuclear option — delete all results and batches
 * Requires body: { confirm: "RESET" }
 */
router.post('/retention/reset-all', async (req, res) => {
    try {
        const { confirm } = req.body || {};
        if (confirm !== 'RESET') {
            return res.status(400).json({
                status: 'error',
                error: 'Send { confirm: "RESET" } to confirm deletion of all data'
            });
        }

        const outcome = await withBenchmarkTrustEvidenceLock('reset-all-benchmark-evidence', async () => {
            const [protectedReceiptCount, sealedResultCount, sealedBatchCount] = await Promise.all([
                BenchmarkTrustReceipt.countDocuments({}),
                BenchmarkResult.countDocuments({ trust_evidence_sealed: true }),
                BenchmarkBatch.countDocuments({ trust_evidence_sealed: true })
            ]);
            if (protectedReceiptCount > 0 || sealedResultCount > 0 || sealedBatchCount > 0) {
                return {
                    blocked: true,
                    protectedReceiptCount,
                    sealedResultCount,
                    sealedBatchCount
                };
            }

            const [results, batches] = await Promise.all([
                BenchmarkResult.deleteMany({}),
                BenchmarkBatch.deleteMany({})
            ]);

            return {
                blocked: false,
                resultsDeleted: results.deletedCount,
                batchesDeleted: batches.deletedCount
            };
        });

        if (outcome.blocked) {
            return res.status(409).json({
                status: 'error',
                code: 'BENCHMARK_TRUST_EVIDENCE_PROTECTS_RESET',
                error: 'Reset is blocked while receipts or sealed benchmark evidence require preservation or manual recovery',
                protected_receipts: outcome.protectedReceiptCount,
                sealed_results: outcome.sealedResultCount,
                sealed_batches: outcome.sealedBatchCount
            });
        }

        logger.warn('Benchmark data reset', {
            results_deleted: outcome.resultsDeleted,
            batches_deleted: outcome.batchesDeleted
        });

        return res.json({
                status: 'success',
                data: {
                    results_deleted: outcome.resultsDeleted,
                    batches_deleted: outcome.batchesDeleted
                }
            });
    } catch (err) {
        logger.error('Failed to reset benchmark data', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

module.exports = router;

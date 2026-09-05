'use strict';
/**
 * Benchmark Results Analysis
 *
 * Quality breakdown, model trends, and batch comparison helpers extracted
 * from results.js to keep the core results module within the 600-line limit.
 *
 * Consumed by: src/services/benchmark/results.js
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

function strictTrustComparisonError() {
    const error = new Error('Strict Benchmark Trust campaigns cannot be opened through generic batch comparison');
    error.code = 'BENCHMARK_TRUST_GENERIC_COMPARISON_FORBIDDEN';
    error.statusCode = 409;
    return error;
}

function isStrictTrustBatch(batch) {
    return Boolean(batch?.trust_evidence_context)
        || (typeof batch?.trust_campaign_spec_id === 'string'
            && /^[0-9a-f]{64}$/.test(batch.trust_campaign_spec_id));
}

/**
 * Get quality score breakdown by category and level
 */
async function getQualityBreakdown(model = null, host = null) {
    const { byCategory, byLevel, byModel } = await BenchmarkResult.getQualityBreakdown(model, host);

    // Restructure category data by model
    const categoryByModel = {};
    byCategory.forEach(item => {
        const modelName = item._id.model;
        if (!categoryByModel[modelName]) categoryByModel[modelName] = {};
        categoryByModel[modelName][item._id.category] = {
            avg_quality: item.avg_quality.toFixed(1),
            avg_latency: Math.round(item.avg_latency),
            tests: item.count
        };
    });

    // Restructure level data by model
    const levelByModel = {};
    byLevel.forEach(item => {
        const modelName = item._id.model;
        if (!levelByModel[modelName]) levelByModel[modelName] = {};
        levelByModel[modelName][`level_${item._id.level}`] = {
            avg_quality: item.avg_quality.toFixed(1),
            avg_latency: Math.round(item.avg_latency),
            tests: item.count
        };
    });

    const categories = Array.from(new Set(
        byCategory
            .map(item => item && item._id ? item._id.category : null)
            .filter(Boolean)
    )).sort();

    const levels = Array.from(new Set(
        byLevel
            .map(item => Number(item && item._id ? item._id.level : NaN))
            .filter(Number.isFinite)
    )).sort((a, b) => a - b);

    return {
        overall: byModel.map(m => ({
            model: m._id,
            avg_quality: m.avg_quality.toFixed(1),
            avg_composite: m.avg_composite ? m.avg_composite.toFixed(1) : null,
            avg_latency: Math.round(m.avg_latency),
            quality_range: {
                max: m.max_quality_score.toFixed(1),
                min: m.min_quality_score.toFixed(1)
            },
            tests: m.count
        })),
        by_category: categoryByModel,
        by_level: levelByModel,
        categories,
        levels
    };
}

/**
 * Get time-series analytics for model performance trends
 */
async function getModelTrends({ model, days = 7, groupBy = 'day' } = {}) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const matchStage = {
        timestamp: { $gte: cutoff },
        success: true,
        infra_error: { $ne: true },
        needs_review: { $ne: true },
        excluded_from_leaderboard: { $ne: true }
    };

    if (model) {
        matchStage.model = model;
    }

    // Determine grouping based on parameter
    let dateGroup;
    switch (groupBy) {
        case 'hour':
            dateGroup = {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' },
                day: { $dayOfMonth: '$timestamp' },
                hour: { $hour: '$timestamp' }
            };
            break;
        case 'day':
        default:
            dateGroup = {
                year: { $year: '$timestamp' },
                month: { $month: '$timestamp' },
                day: { $dayOfMonth: '$timestamp' }
            };
    }

    const trends = await BenchmarkResult.aggregate([
        { $match: matchStage },
        {
            $group: {
                _id: {
                    ...dateGroup,
                    ...(model ? {} : { model: '$model' })
                },
                avg_latency: { $avg: '$latency' },
                avg_tokens_per_sec: { $avg: '$tokens_per_sec' },
                avg_quality: { $avg: '$quality_score' },
                avg_composite: { $avg: '$composite_score' },
                tests_count: { $sum: 1 },
                total_tokens: { $sum: '$tokens' }
            }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
    ]);

    return {
        trends,
        period: { days, groupBy },
        model: model || 'all'
    };
}

/**
 * Get comparative batch analysis
 */
async function compareBatches(batchIds) {
    if (!Array.isArray(batchIds) || batchIds.length === 0) {
        throw new Error('batchIds array is required');
    }

    const batches = await BenchmarkBatch.find({ _id: { $in: batchIds } })
        .select('+trust_evidence_context');

    const validBatches = batches.filter(b => b !== null);

    if (validBatches.length === 0) {
        throw new Error('No valid batches found');
    }
    if (validBatches.some(isStrictTrustBatch)) {
        throw strictTrustComparisonError();
    }

    const comparison = await Promise.all(validBatches.map(async batch => {
        // Calculate aggregated scores for this batch
        let avg_quality = null;
        let avg_composite = null;
        let full_passed = 0;
        let judge_failed = 0;
        let judge_pending = 0;

        const hasRankableQuality = {
            $and: [
                { $eq: ['$success', true] },
                { $ne: ['$infra_error', true] },
                { $ne: ['$needs_review', true] },
                { $ne: ['$excluded_from_leaderboard', true] },
                { $ne: [{ $ifNull: ['$quality_score', null] }, null] }
            ]
        };

        const scores = await BenchmarkResult.aggregate([
            { $match: { batch_id: batch._id } },
            {
                $group: {
                    _id: null,
                    avg_quality: {
                        $avg: { $cond: [hasRankableQuality, '$quality_score', null] }
                    },
                    avg_composite: {
                        $avg: {
                            $cond: [
                                {
                                    $and: [
                                        hasRankableQuality,
                                        { $ne: [{ $ifNull: ['$composite_score', null] }, null] }
                                    ]
                                },
                                '$composite_score',
                                null
                            ]
                        }
                    },
                    full_passed: {
                        $sum: {
                            $cond: [
                                hasRankableQuality,
                                1,
                                0
                            ]
                        }
                    },
                    judge_failed: {
                        $sum: {
                            $cond: [
                                {
                                    $eq: [{ $toLower: { $ifNull: ['$scoring_method', ''] } }, 'llm_failed']
                                },
                                1,
                                0
                            ]
                        }
                    },
                    judge_pending: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$success', true] },
                                        { $eq: [{ $type: '$response' }, 'string'] },
                                        { $ne: ['$response', ''] },
                                        { $eq: [{ $toLower: { $ifNull: ['$scoring_method', 'pending'] } }, 'pending'] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]);
        if (scores.length > 0) {
            avg_quality = scores[0].avg_quality !== null ? parseFloat(scores[0].avg_quality.toFixed(1)) : null;
            avg_composite = scores[0].avg_composite !== null ? parseFloat(scores[0].avg_composite.toFixed(1)) : null;
            full_passed = Number(scores[0].full_passed) || 0;
            judge_failed = Number(scores[0].judge_failed) || 0;
            judge_pending = Number(scores[0].judge_pending) || 0;
        }

        const totalTests = Number(batch.total_tests) || 0;
        const completed = Number(batch.completed) || 0;
        const execSuccessRate = Number(batch.success_rate) || 0;
        const fullPassRate = totalTests > 0 ? Number(((full_passed / totalTests) * 100).toFixed(1)) : 0;

        return {
            batch_id: batch._id.toString(),
            run_name: batch.run_name,
            models: batch.models,
            status: batch.status,
            total_tests: totalTests,
            completed,
            exec_success_rate: execSuccessRate,
            full_pass_rate: fullPassRate,
            full_passed,
            judge_failed,
            judge_pending,
            success_rate: batch.success_rate,
            execution_metrics: batch.execution_metrics,
            config_snapshot: batch.config_snapshot,
            created_at: batch.created_at,
            completed_at: batch.completed_at,
            avg_quality,
            avg_composite
        };
    }));

    // Calculate comparative statistics
    const stats = {
        avg_duration_ms: null,
        avg_tests_per_minute: null,
        avg_tokens_generated: null,
        fastest_batch: null,
        slowest_batch: null
    };

    const durations = validBatches
        .filter(b => b.execution_metrics?.total_duration_ms)
        .map(b => ({
            id: b._id.toString(),
            name: b.run_name,
            duration: b.execution_metrics.total_duration_ms
        }));

    if (durations.length > 0) {
        stats.avg_duration_ms = Math.round(
            durations.reduce((a, b) => a + b.duration, 0) / durations.length
        );
        stats.fastest_batch = durations.reduce((a, b) => (a.duration < b.duration ? a : b));
        stats.slowest_batch = durations.reduce((a, b) => (a.duration > b.duration ? a : b));
    }

    const throughputs = validBatches
        .filter(b => b.execution_metrics?.tests_per_minute)
        .map(b => b.execution_metrics.tests_per_minute);

    if (throughputs.length > 0) {
        stats.avg_tests_per_minute = Math.round(
            throughputs.reduce((a, b) => a + b, 0) / throughputs.length
        );
    }

    const tokens = validBatches
        .filter(b => b.execution_metrics?.total_tokens_generated)
        .map(b => b.execution_metrics.total_tokens_generated);

    if (tokens.length > 0) {
        stats.avg_tokens_generated = Math.round(
            tokens.reduce((a, b) => a + b, 0) / tokens.length
        );
    }

    return { comparison, stats };
}

/**
 * Batch quality breakdown -- fetch quality breakdowns for multiple model/host
 * pairs in parallel with a concurrency cap.
 * @param {Array<{model: string, host?: string}>} pairs
 * @returns {Promise<{results: Array<{model: string, host: string|null, breakdown: Object}>}>}
 */
async function getBatchQualityBreakdown(pairs) {
    const CONCURRENCY = 5;
    const results = [];
    let idx = 0;

    async function next() {
        while (idx < pairs.length) {
            const i = idx++;
            const { model, host } = pairs[i];
            try {
                const breakdown = await getQualityBreakdown(model || null, host || null);
                results[i] = { model, host: host || null, breakdown };
            } catch (err) {
                results[i] = { model, host: host || null, breakdown: null, error: err.message };
            }
        }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, pairs.length); w++) {
        workers.push(next());
    }
    await Promise.all(workers);

    return { results };
}

module.exports = {
    getQualityBreakdown,
    getModelTrends,
    compareBatches,
    getBatchQualityBreakdown
};

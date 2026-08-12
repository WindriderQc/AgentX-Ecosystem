/**
 * Benchmark Judges Module
 * Statistics and analysis for judge models
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');

/**
 * Get Judge Leaderboard
 * Aggregates performance stats for judge models
 */
async function getJudgeLeaderboard() {
    const leaderboard = await BenchmarkResult.aggregate([
        {
            $match: {
                judge_model: { $ne: null },
                scoring_method: { $ne: 'skipped' }
            }
        },
        {
            $group: {
                _id: {
                    judge_model: '$judge_model',
                    judge_host: '$judge_host'
                },
                count: { $sum: 1 },
                avg_latency: { $avg: '$scoring_time_ms' },
                success_count: {
                    $sum: {
                        $cond: [{ $ne: ['$scoring_method', 'llm_failed'] }, 1, 0]
                    }
                },
                avg_score_given: { $avg: '$quality_score' },
                avg_explanation_len: {
                    $avg: {
                        $cond: [
                            { $ifNull: ['$quality_explanation', false] },
                            { $strLenCP: '$quality_explanation' },
                            0
                        ]
                    }
                },
                // Collect score distribution for histogram
                scores: { $push: '$quality_score' }
            }
        },
        {
            $project: {
                _id: 0,
                judge_model: '$_id.judge_model',
                judge_host: '$_id.judge_host',
                count: 1,
                avg_latency: { $round: ['$avg_latency', 0] },
                success_rate: {
                    $multiply: [
                        { $divide: ['$success_count', '$count'] },
                        100
                    ]
                },
                avg_score_given: { $round: ['$avg_score_given', 1] },
                avg_explanation_len: { $round: ['$avg_explanation_len', 0] },
                // Calculate score distribution buckets (0-2, 2-4, 4-6, 6-8, 8-10)
                score_distribution: {
                    $reduce: {
                        input: '$scores',
                        initialValue: { '0-2': 0, '2-4': 0, '4-6': 0, '6-8': 0, '8-10': 0 },
                        in: {
                            $let: {
                                vars: { score: '$$this' },
                                in: {
                                    $cond: [
                                        { $eq: ['$$score', null] },
                                        '$$value',
                                        {
                                            $cond: [
                                                { $lte: ['$$score', 2] },
                                                { $mergeObjects: ['$$value', { '0-2': { $add: ['$$value.0-2', 1] } }] },
                                                {
                                                    $cond: [
                                                        { $lte: ['$$score', 4] },
                                                        { $mergeObjects: ['$$value', { '2-4': { $add: ['$$value.2-4', 1] } }] },
                                                        {
                                                            $cond: [
                                                                { $lte: ['$$score', 6] },
                                                                { $mergeObjects: ['$$value', { '4-6': { $add: ['$$value.4-6', 1] } }] },
                                                                {
                                                                    $cond: [
                                                                        { $lte: ['$$score', 8] },
                                                                        { $mergeObjects: ['$$value', { '6-8': { $add: ['$$value.6-8', 1] } }] },
                                                                        { $mergeObjects: ['$$value', { '8-10': { $add: ['$$value.8-10', 1] } }] }
                                                                    ]
                                                                }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            }
        },
        { $sort: { count: -1 } }
    ]);

    return leaderboard;
}

/**
 * Get Judge Breakdown
 * Break down judge performance by prompt level or model-under-test.
 *
 * @param {Object} opts
 * @param {string} opts.judge_model - Judge model name (required)
 * @param {string|null} [opts.judge_host] - Optional judge host filter
 * @param {'level'|'model'} [opts.groupBy='level'] - Breakdown dimension
 * @param {number} [opts.limit=25] - Max groups to return (applies to model grouping)
 */
async function getJudgeBreakdown({ judge_model, judge_host = null, groupBy = 'level', limit = 25 } = {}) {
    if (!judge_model || typeof judge_model !== 'string') {
        throw new Error('judge_model is required');
    }

    const normalizedGroupBy = groupBy === 'model' ? 'model' : 'level';
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));

    const match = {
        judge_model,
        scoring_method: { $ne: 'skipped' }
    };

    if (typeof judge_host === 'string' && judge_host.trim()) {
        match.judge_host = judge_host.trim();
    }

    if (normalizedGroupBy === 'level') {
        match.prompt_level = { $ne: null };
    } else {
        match.model = { $ne: null };
    }

    const groupKey = normalizedGroupBy === 'level' ? '$prompt_level' : '$model';

    const pipeline = [
        { $match: match },
        {
            $group: {
                _id: groupKey,
                count: { $sum: 1 },
                avg_latency: { $avg: '$scoring_time_ms' },
                success_count: {
                    $sum: {
                        $cond: [{ $ne: ['$scoring_method', 'llm_failed'] }, 1, 0]
                    }
                },
                avg_score_given: { $avg: '$quality_score' },
                avg_test_tokens: { $avg: '$tokens' }
            }
        },
        {
            $project: {
                _id: 0,
                key: '$_id',
                count: 1,
                avg_latency: { $round: ['$avg_latency', 0] },
                success_rate: {
                    // Guard against division by zero (returns 0 if count is 0)
                    $cond: {
                        if: { $eq: ['$count', 0] },
                        then: 0,
                        else: {
                            $multiply: [
                                { $divide: ['$success_count', '$count'] },
                                100
                            ]
                        }
                    }
                },
                avg_score_given: { $round: ['$avg_score_given', 1] },
                avg_test_tokens: { $round: ['$avg_test_tokens', 0] }
            }
        },
        { $sort: { count: -1 } }
    ];

    if (normalizedGroupBy === 'model') {
        pipeline.push({ $limit: safeLimit });
    }

    const groups = await BenchmarkResult.aggregate(pipeline);

    return {
        judge_model,
        judge_host: (typeof judge_host === 'string' && judge_host.trim()) ? judge_host.trim() : null,
        groupBy: normalizedGroupBy,
        limit: normalizedGroupBy === 'model' ? safeLimit : null,
        groups
    };
}

/**
 * Get recent judge activity
 */
async function getJudgeActivity(limit = 10) {
    return BenchmarkResult.find({
        judge_model: { $ne: null },
        scoring_method: { $ne: 'skipped' }
    })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select('judge_model judge_host model quality_score scoring_time_ms timestamp prompt_category');
}

/**
 * Get truncation statistics for diagnostics
 * Shows how many responses/judge outputs were truncated
 * @param {Object} opts - Options
 * @param {string} [opts.batch_id] - Optional batch ID to filter
 * @param {number} [opts.limit=1000] - Max results to analyze
 */
async function getTruncationStats({ batch_id = null, limit = 1000 } = {}) {
    const match = { success: true };
    if (batch_id) match.batch_id = batch_id;

    const results = await BenchmarkResult.find(match)
        .sort({ timestamp: -1 })
        .limit(limit)
        .select('model truncation scoring_method prompt_level prompt_category')
        .lean();

    const stats = {
        total_analyzed: results.length,
        response_truncated: 0,
        judge_truncated: 0,
        by_model: {},
        by_level: {},
        examples: []
    };

    results.forEach(r => {
        const t = r.truncation || {};

        if (t.response_truncated) {
            stats.response_truncated++;
            if (stats.examples.length < 5) {
                stats.examples.push({
                    type: 'response',
                    model: r.model,
                    level: r.prompt_level,
                    tokens: t.response_tokens,
                    limit: t.response_limit
                });
            }
        }
        if (t.judge_truncated) {
            stats.judge_truncated++;
            if (stats.examples.length < 10) {
                stats.examples.push({
                    type: 'judge',
                    model: r.model,
                    level: r.prompt_level,
                    judge_tokens: t.judge_tokens
                });
            }
        }

        // Aggregate by model
        if (!stats.by_model[r.model]) {
            stats.by_model[r.model] = { response: 0, judge: 0, total: 0 };
        }
        stats.by_model[r.model].total++;
        if (t.response_truncated) stats.by_model[r.model].response++;
        if (t.judge_truncated) stats.by_model[r.model].judge++;

        // Aggregate by level
        const level = r.prompt_level || 'unknown';
        if (!stats.by_level[level]) {
            stats.by_level[level] = { response: 0, judge: 0, total: 0 };
        }
        stats.by_level[level].total++;
        if (t.response_truncated) stats.by_level[level].response++;
        if (t.judge_truncated) stats.by_level[level].judge++;
    });

    // Calculate percentages
    stats.response_truncated_pct = stats.total_analyzed > 0
        ? ((stats.response_truncated / stats.total_analyzed) * 100).toFixed(1) + '%'
        : '0%';
    stats.judge_truncated_pct = stats.total_analyzed > 0
        ? ((stats.judge_truncated / stats.total_analyzed) * 100).toFixed(1) + '%'
        : '0%';

    return stats;
}

module.exports = {
    getJudgeLeaderboard,
    getJudgeBreakdown,
    getJudgeActivity,
    getTruncationStats
};

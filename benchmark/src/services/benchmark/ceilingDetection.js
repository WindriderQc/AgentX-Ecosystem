/**
 * Ceiling Detection & Score Differentiation
 * ==========================================
 *
 * Detects models at the scoring ceiling (generalist > threshold) and provides
 * analytics to differentiate them:
 *
 * - Ceiling model detection with configurable threshold
 * - Category heatmap: model x category score matrix
 * - Per-dimension scoring breakdown from quality_breakdown
 * - Elite score calculation (hard-mode only, L4-5 prompts, reasoning-heavy weights)
 *
 * Consumers:
 *   - routes/benchmark/analytics.js: GET /ceiling-analysis, /category-heatmap,
 *     /dimension-breakdown, /elite-scores
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');

const CEILING_THRESHOLD = 95;

// Elite scoring uses harder categories with heavier weights
const ELITE_CATEGORY_WEIGHTS = {
    'coding': 0.18,
    'reasoning': 0.20,
    'math': 0.15,
    'multi-turn-reasoning': 0.12,
    'debugging': 0.10,
    'refactoring': 0.08,
    'edge-cases': 0.10,
    'context-retention': 0.07
};

/**
 * Detect models scoring above the ceiling threshold.
 * @param {Map} generalistScores - From calculateAllGeneralistScores()
 * @param {number} threshold - Score above which a model is "at ceiling" (default 95)
 * @returns {Array} Ceiling models with score data
 */
function detectCeilingModels(generalistScores, threshold = CEILING_THRESHOLD) {
    const ceiling = [];
    for (const [key, data] of generalistScores) {
        if (data.filtered) continue;
        if (data.generalistScore >= threshold) {
            const [model, host] = key.split('@@');
            ceiling.push({
                model,
                host: host || null,
                generalistScore: data.generalistScore,
                categoryAverages: data.categoryAverages,
                coverage: data.coverage
            });
        }
    }
    ceiling.sort((a, b) => b.generalistScore - a.generalistScore);
    return ceiling;
}

/**
 * Get category x model heatmap data.
 * Returns a matrix of average quality scores per model per category.
 * @param {Object} matchQuery - MongoDB match filter
 * @returns {Object} { models, categories, matrix }
 */
async function getCategoryHeatmap(matchQuery = { success: true }) {
    const stats = await BenchmarkResult.aggregate([
        // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra-failed rows.
        {
            $match: {
                ...matchQuery,
                quality_score: { $ne: null },
                infra_error: { $ne: true },
                excluded_from_leaderboard: { $ne: true }
            }
        },
        {
            $group: {
                _id: {
                    model: '$model',
                    host: '$host',
                    category: '$prompt_category'
                },
                avg: { $avg: '$quality_score' },
                count: { $sum: 1 }
            }
        },
        { $sort: { '_id.model': 1, '_id.category': 1 } }
    ]);

    const modelMap = new Map();
    const categorySet = new Set();

    for (const s of stats) {
        const key = `${s._id.model}@@${s._id.host || ''}`;
        const cat = s._id.category;
        if (!cat) continue;
        categorySet.add(cat);

        if (!modelMap.has(key)) {
            modelMap.set(key, { model: s._id.model, host: s._id.host || null, scores: {} });
        }
        modelMap.get(key).scores[cat] = {
            avg: Math.round(s.avg * 100) / 100,
            count: s.count
        };
    }

    const categories = [...categorySet].sort();
    const models = [];
    const matrix = [];

    for (const [, entry] of modelMap) {
        models.push({ model: entry.model, host: entry.host });
        const row = categories.map(cat => {
            const s = entry.scores[cat];
            return s ? s.avg : null;
        });
        matrix.push(row);
    }

    return { models, categories, matrix };
}

/**
 * Get per-dimension scoring breakdown across models.
 * Extracts dimension scores from quality_breakdown stored per result.
 * @param {Object} matchQuery - MongoDB match filter
 * @returns {Array} Per-model dimension averages
 */
async function getDimensionBreakdown(matchQuery = { success: true }) {
    const results = await BenchmarkResult.aggregate([
        {
            $match: {
                ...matchQuery,
                quality_score: { $ne: null },
                quality_breakdown: { $ne: null },
                // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra-failed rows.
                infra_error: { $ne: true },
                excluded_from_leaderboard: { $ne: true }
            }
        },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                breakdowns: { $push: '$quality_breakdown' },
                count: { $sum: 1 },
                avg_quality: { $avg: '$quality_score' }
            }
        }
    ]);

    return results.map(r => {
        const dimSums = {};
        const dimCounts = {};

        for (const bd of r.breakdowns) {
            if (!bd || typeof bd !== 'object') continue;
            for (const [key, value] of Object.entries(bd)) {
                if (key === 'explanation' || key === 'overall' || typeof value !== 'number') continue;
                dimSums[key] = (dimSums[key] || 0) + value;
                dimCounts[key] = (dimCounts[key] || 0) + 1;
            }
        }

        const dimensions = {};
        for (const [dim, sum] of Object.entries(dimSums)) {
            dimensions[dim] = Math.round((sum / dimCounts[dim]) * 100) / 100;
        }

        return {
            model: r._id.model,
            host: r._id.host || null,
            avg_quality: Math.round(r.avg_quality * 100) / 100,
            result_count: r.count,
            dimensions
        };
    }).sort((a, b) => b.avg_quality - a.avg_quality);
}

/**
 * Calculate elite scores for ceiling models.
 * Uses only L4-5 prompts with reasoning-heavy category weights.
 * @param {Object} matchQuery - MongoDB match filter
 * @returns {Array} Elite scores per model
 */
async function calculateEliteScores(matchQuery = { success: true }) {
    const stats = await BenchmarkResult.aggregate([
        {
            $match: {
                ...matchQuery,
                quality_score: { $ne: null },
                prompt_level: { $gte: 4 },
                // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra-failed rows.
                infra_error: { $ne: true },
                excluded_from_leaderboard: { $ne: true }
            }
        },
        {
            $group: {
                _id: {
                    model: '$model',
                    host: '$host',
                    category: '$prompt_category'
                },
                avg: { $avg: '$quality_score' },
                count: { $sum: 1 },
                stddev: { $stdDevPop: '$quality_score' }
            }
        }
    ]);

    // Group by model
    const modelMap = new Map();
    for (const s of stats) {
        const key = `${s._id.model}@@${s._id.host || ''}`;
        const cat = s._id.category;
        if (!cat || !ELITE_CATEGORY_WEIGHTS[cat]) continue;

        if (!modelMap.has(key)) {
            modelMap.set(key, {
                model: s._id.model,
                host: s._id.host || null,
                categories: {}
            });
        }
        modelMap.get(key).categories[cat] = {
            avg: s.avg,
            count: s.count,
            stddev: s.stddev || 0
        };
    }

    const results = [];
    for (const [, entry] of modelMap) {
        let weightedSum = 0;
        let weightsCovered = 0;
        const categoryScores = {};

        for (const [cat, weight] of Object.entries(ELITE_CATEGORY_WEIGHTS)) {
            const data = entry.categories[cat];
            if (data && data.count > 0) {
                const score = Math.max(0, Math.min(10, data.avg)) * 10;
                weightedSum += score * weight;
                weightsCovered += weight;
                categoryScores[cat] = Math.round(score * 10) / 10;
            }
        }

        const eliteScore = weightsCovered > 0
            ? Math.round((weightedSum / weightsCovered) * 10) / 10
            : 0;
        const coveragePct = Math.round((weightsCovered / 1.0) * 100);

        results.push({
            model: entry.model,
            host: entry.host,
            eliteScore,
            eliteCoverage: coveragePct,
            categoryScores
        });
    }

    results.sort((a, b) => b.eliteScore - a.eliteScore);
    return results;
}

module.exports = {
    CEILING_THRESHOLD,
    ELITE_CATEGORY_WEIGHTS,
    detectCeilingModels,
    getCategoryHeatmap,
    getDimensionBreakdown,
    calculateEliteScores
};

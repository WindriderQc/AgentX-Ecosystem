/**
 * Generalist scoring — DB aggregation & orchestration (task 0228 split).
 *
 * Extracted verbatim from generalistScore.js. This layer reads BenchmarkResult /
 * BenchmarkPrompt from Mongo, builds the per-model category maps, and orchestrates
 * the pure formula in generalistScoreCalculator.js. All Mongo access for the
 * generalist leaderboard lives here.
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');
const { INFRA_ERROR_REGEX } = require('./errorClassifier');
const {
    GENERALIST_AGGREGATION_OPTIONS,
    EMPTY_RESPONSE_FILTER_THRESHOLD
} = require('./generalistScoreConstants');
const {
    normalizeCategoryKey,
    normalizeWeightMap,
    countByValue
} = require('./generalistScoreNormalizers');
const { calculateGeneralistScoreFromCategories } = require('./generalistScoreCalculator');

// Lazy-load to avoid circular deps at module init time
let _scoringProfile;
function getScoringProfileModule() {
    if (!_scoringProfile) {
        _scoringProfile = require('./scoringProfile');
    }
    return _scoringProfile;
}

/**
 * Get active generalist params from scoring profile (with fallback to defaults).
 * Used by calculateAllGeneralistScores to read configurable constants.
 */
async function getProfileGeneralistParams() {
    try {
        const { getScoringProfile } = getScoringProfileModule();
        const profile = await getScoringProfile();
        return profile.generalist || {};
    } catch (_) {
        return {};
    }
}

/**
 * Resolve active category weights from the scoring profile + prompt catalog.
 * Uses profile overrides when available; falls back to hardcoded defaults.
 * Filters to categories that have prompts in the catalog.
 */
async function getActiveCategoryWeights() {
    // Load profile weights (may be overridden by user)
    let profileWeights = GENERALIST_CATEGORY_WEIGHTS;
    try {
        const { getScoringProfile } = getScoringProfileModule();
        const profile = await getScoringProfile();
        if (profile.categoryWeights && typeof profile.categoryWeights === 'object') {
            profileWeights = profile.categoryWeights;
        }
    } catch (_) {
        // fall through to hardcoded defaults
    }

    try {
        const promptCategories = await BenchmarkPrompt.distinct('category');
        const available = new Set(
            (Array.isArray(promptCategories) ? promptCategories : [])
                .map(normalizeCategoryKey)
                .filter((cat) => cat && Object.prototype.hasOwnProperty.call(profileWeights, cat))
        );

        if (available.size === 0) {
            return { ...profileWeights };
        }

        const active = {};
        for (const [category, weight] of Object.entries(profileWeights)) {
            if (available.has(category)) {
                active[category] = weight;
            }
        }

        return normalizeWeightMap(active);
    } catch (_) {
        return { ...profileWeights };
    }
}

async function getCategoryDiagnosticsByModelCategory(successMatch, scoreFieldRef) {
    const rows = await BenchmarkResult.aggregate([
        { $match: successMatch },
        {
            $match: {
                prompt_name: { $type: 'string', $ne: '' },
                [scoreFieldRef.slice(1)]: { $ne: null }
            }
        },
        {
            $group: {
                _id: {
                    model: '$model',
                    host: '$host',
                    category: '$prompt_category',
                    prompt_name: '$prompt_name'
                },
                score: { $avg: scoreFieldRef },
                repeat_count: { $sum: 1 }
            }
        },
        {
            $facet: {
                uncertainty: [
                    {
                        $group: {
                            _id: {
                                model: '$_id.model',
                                host: '$_id.host',
                                category: '$_id.category'
                            },
                            prompt_stddev: { $stdDevSamp: '$score' },
                            prompt_count: { $sum: 1 },
                            repeat_count: { $sum: '$repeat_count' }
                        }
                    }
                ],
                residual: [
                    {
                        $group: {
                            _id: {
                                category: '$_id.category',
                                prompt_name: '$_id.prompt_name'
                            },
                            prompt_mean: { $avg: '$score' },
                            model_count: { $sum: 1 },
                            rows: {
                                $push: {
                                    model: '$_id.model',
                                    host: '$_id.host',
                                    score: '$score'
                                }
                            }
                        }
                    },
                    { $match: { model_count: { $gte: 2 } } },
                    { $unwind: '$rows' },
                    {
                        $project: {
                            model: '$rows.model',
                            host: '$rows.host',
                            category: '$_id.category',
                            residual: { $subtract: ['$rows.score', '$prompt_mean'] }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                model: '$model',
                                host: '$host',
                                category: '$category'
                            },
                            residual_stddev: { $stdDevPop: '$residual' },
                            residual_count: { $sum: 1 }
                        }
                    }
                ]
            }
        }
    ], GENERALIST_AGGREGATION_OPTIONS);

    const diagnostics = new Map();
    const result = rows[0] || {};
    for (const row of result.uncertainty || []) {
        const key = `${row._id.model}@@${row._id.host}@@${normalizeCategoryKey(row._id.category)}`;
        diagnostics.set(key, {
            uncertainty_stddev: row.prompt_stddev ?? null,
            uncertainty_count: row.prompt_count || 0,
            repeat_count: row.repeat_count || 0
        });
    }
    for (const row of result.residual || []) {
        const key = `${row._id.model}@@${row._id.host}@@${normalizeCategoryKey(row._id.category)}`;
        diagnostics.set(key, {
            ...(diagnostics.get(key) || {}),
            residual_stddev: row.residual_stddev ?? null,
            residual_count: row.residual_count || 0
        });
    }
    return diagnostics;
}

/*
 * The diagnostics aggregation above deliberately begins from per-prompt means:
 * repeated attempts improve one fixture estimate instead of pretending to add
 * independent fixtures. The residual facet remains the consistency basis.
 */

/**
 * Get category scores for all models from database
 * Includes within-category stddev for consistency measurement
 * @param {Object} matchQuery - MongoDB match query for filtering
 * @returns {Map} Model key -> category scores
 */
async function getCategoryScoresByModel(matchQuery = { success: true }, options = {}) {
    // Task 0199: scoreField parameterizes which numeric field to aggregate over.
    // Defaults to 'quality_score' so existing callers behave identically.
    // Pass 'deterministic_score' or 'subjective_score' to slice the leaderboard
    // by which signal contributed.
    const scoreField = options.scoreField || 'quality_score';
    const scoreFieldRef = '$' + scoreField;
    const baseMatch = { ...(matchQuery || {}) };
    delete baseMatch.success;

    // Defense in depth per scoring-contract-v1 §2.7 (0117): callers may pass
    // infra_error:{$ne:true} to harden the success path. The infra-attempts sub-query,
    // however, needs to *find* infra failures — so strip that filter from its base.
    const baseForInfra = { ...baseMatch };
    delete baseForInfra.infra_error;

    const successMatch = {
        ...baseMatch,
        success: true,
        infra_error: { $ne: true },
        excluded_from_leaderboard: { $ne: true }
    };
    const infraFailureMatch = {
        ...baseForInfra,
        success: false,
        $or: [
            { infra_error: true },
            { error_type: 'infra' },
            { error: { $regex: INFRA_ERROR_REGEX } }
        ]
    };

    const [categoryStats, infraAttempts, categoryDiagnostics] = await Promise.all([
        BenchmarkResult.aggregate([
            { $match: successMatch },
            {
                $group: {
                    _id: {
                        model: '$model',
                        host: '$host',
                        category: '$prompt_category'
                    },
                    avg_quality: {
                        $avg: {
                            $cond: [
                                { $ne: [scoreFieldRef, null] },
                                scoreFieldRef,
                                null
                            ]
                        }
                    },
                    // Within-category standard deviation for consistency measurement
                    stddev_quality: {
                        $stdDevPop: {
                            $cond: [
                                { $ne: [scoreFieldRef, null] },
                                scoreFieldRef,
                                null
                            ]
                        }
                    },
                    // Avg judge confidence only over rows where evidence exists.
                    // Missing legacy values remain explicitly unknown.
                    avg_confidence: {
                        $avg: {
                            $cond: [
                                { $ne: ['$judge_confidence', null] },
                                '$judge_confidence',
                                null
                            ]
                        }
                    },
                    confidence_count: {
                        $sum: {
                            $cond: [{ $ne: ['$judge_confidence', null] }, 1, 0]
                        }
                    },
                    levels: { $push: '$prompt_level' },
                    count: { $sum: 1 }
                }
            }
        ], GENERALIST_AGGREGATION_OPTIONS),
        BenchmarkResult.aggregate([
            { $match: infraFailureMatch },
            {
                $group: {
                    _id: {
                        model: '$model',
                        host: '$host',
                        category: '$prompt_category'
                    },
                    count: { $sum: 1 }
                }
            }
        ], GENERALIST_AGGREGATION_OPTIONS),
        getCategoryDiagnosticsByModelCategory(successMatch, scoreFieldRef)
    ]);

    // Group by model/host
    const modelCategoryMap = new Map();

    for (const stat of categoryStats) {
        const key = `${stat._id.model}@@${stat._id.host}`;
        const category = normalizeCategoryKey(stat._id.category);
        if (!category || !Object.prototype.hasOwnProperty.call(GENERALIST_CATEGORY_WEIGHTS, category)) continue;

        if (!modelCategoryMap.has(key)) {
            modelCategoryMap.set(key, {});
        }

        if (stat.avg_quality !== null) {
            const confCount = stat.confidence_count || 0;
            const nullCount = Math.max(0, (stat.count || 0) - confCount);
            const avgConfidence = confCount > 0 ? stat.avg_confidence : null;
            modelCategoryMap.get(key)[category] = {
                avg: stat.avg_quality,
                stddev: stat.stddev_quality ?? null,
                avg_confidence: avgConfidence,
                confidence_count: confCount,
                unknown_confidence_count: nullCount,
                count: stat.count,
                levels: (stat.levels || []).filter((level) => level !== null && level !== undefined),
                attempted: true
            };
            const diagnosticsKey = `${key}@@${category}`;
            const diagnostics = categoryDiagnostics.get(diagnosticsKey);
            if (diagnostics) {
                modelCategoryMap.get(key)[category].uncertainty_stddev = diagnostics.uncertainty_stddev;
                modelCategoryMap.get(key)[category].uncertainty_count = diagnostics.uncertainty_count;
                modelCategoryMap.get(key)[category].repeat_count = diagnostics.repeat_count;
            }
            if (diagnostics && diagnostics.residual_count >= 2) {
                modelCategoryMap.get(key)[category].residual_stddev = diagnostics.residual_stddev;
                modelCategoryMap.get(key)[category].residual_count = diagnostics.residual_count;
                modelCategoryMap.get(key)[category].consistency_basis = 'prompt_residual';
            } else {
                modelCategoryMap.get(key)[category].consistency_basis = 'none';
            }
        } else if (stat.count > 0) {
            // Tests ran successfully in this category but ALL judge calls failed
            // (avg_quality is null because every quality_score is null).
            // Treat same as an infra-failed category: mark attempted to avoid
            // coverage penalty, but contribute no quality score.
            if (!modelCategoryMap.get(key)[category]) {
                modelCategoryMap.get(key)[category] = { attempted: true, count: 0, judge_failed: true };
            } else {
                modelCategoryMap.get(key)[category].attempted = true;
            }
        }
    }

    // Mark infra-attempted categories as attempted to avoid coverage penalty.
    // 0117 / contract §2.7: we only annotate models that ALREADY have at least
    // one successful scored row. A model with only infra failures must not be
    // promoted onto the leaderboard.
    for (const att of infraAttempts) {
        const key = `${att._id.model}@@${att._id.host}`;
        const category = normalizeCategoryKey(att._id.category);
        if (!category || !Object.prototype.hasOwnProperty.call(GENERALIST_CATEGORY_WEIGHTS, category)) continue;
        if (!modelCategoryMap.has(key)) continue; // infra-only model — stay off leaderboard
        if (!modelCategoryMap.get(key)[category]) {
            modelCategoryMap.get(key)[category] = { attempted: true, count: 0 };
        } else {
            modelCategoryMap.get(key)[category].attempted = true;
        }
    }

    return modelCategoryMap;
}

/**
 * Get empty response rates per model+host.
 * Returns Map of "model@@host" -> { emptyCount, totalCount, emptyRate }
 */
async function getEmptyResponseRates(matchQuery = {}) {
    const baseMatch = { ...(matchQuery || {}) };
    delete baseMatch.success;

    const stats = await BenchmarkResult.aggregate([
        // Defense in depth per scoring-contract-v1 §2.7 (0117): exclude infra_error.
        {
            $match: {
                ...baseMatch,
                success: true,
                infra_error: { $ne: true },
                excluded_from_leaderboard: { $ne: true }
            }
        },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                total: { $sum: 1 },
                empty: {
                    $sum: {
                        $cond: [{ $eq: ['$scoring_method', 'empty_response'] }, 1, 0]
                    }
                }
            }
        }
    ]);

    const rates = new Map();
    for (const s of stats) {
        const key = `${s._id.model}@@${s._id.host}`;
        rates.set(key, {
            emptyCount: s.empty,
            totalCount: s.total,
            emptyRate: s.total > 0 ? s.empty / s.total : 0
        });
    }
    return rates;
}

/**
 * Return non-scoring metadata for each leaderboard entry.
 * This keeps leaderboard rows auditable when multiple benchmark cohorts are
 * present in the same database, for example foundation L1 rows beside L4/L5
 * hard-suite rows.
 */
async function getLeaderboardEntryStats(matchQuery = {}) {
    const stats = await BenchmarkResult.aggregate([
        { $match: matchQuery || {} },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                totalRows: { $sum: 1 },
                promptLevels: { $push: '$prompt_level' },
                contexts: { $push: '$execution_settings.num_ctx' },
                judgeModels: { $addToSet: '$judge_model' },
                judgeTargets: { $addToSet: { model: '$judge_model', host: '$judge_host' } },
                needsReviewCount: {
                    $sum: { $cond: [{ $eq: ['$needs_review', true] }, 1, 0] }
                },
                lowConfidenceCount: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $ne: ['$judge_confidence', null] },
                                    { $lt: ['$judge_confidence', 0.7] }
                                ]
                            },
                            1,
                            0
                        ]
                    }
                },
                earliestTimestamp: { $min: '$timestamp' },
                latestTimestamp: { $max: '$timestamp' }
            }
        }
    ]);

    const byEntry = new Map();
    for (const row of stats) {
        const key = `${row._id.model}@@${row._id.host}`;
        const numericLevels = (row.promptLevels || [])
            .map(Number)
            .filter((level) => Number.isFinite(level));
        const contexts = countByValue(row.contexts);
        const promptLevelCounts = countByValue(numericLevels);
        byEntry.set(key, {
            totalRows: row.totalRows || 0,
            promptLevelCounts,
            minPromptLevel: numericLevels.length ? Math.min(...numericLevels) : null,
            maxPromptLevel: numericLevels.length ? Math.max(...numericLevels) : null,
            contextCounts: contexts,
            judgeModels: (row.judgeModels || []).filter(Boolean),
            judgeTargets: (row.judgeTargets || []).filter((target) => target?.model && target?.host),
            needsReviewCount: row.needsReviewCount || 0,
            lowConfidenceCount: row.lowConfidenceCount || 0,
            earliestTimestamp: row.earliestTimestamp || null,
            latestTimestamp: row.latestTimestamp || null
        });
    }
    return byEntry;
}

/**
 * Calculate generalist scores for all models
 * @param {Object} matchQuery - MongoDB match query for filtering
 * @returns {Map} Model key -> generalist score data (includes `filtered` flag for dead models)
 */
async function calculateAllGeneralistScores(
    matchQuery = { success: true },
    {
        categoryWeights = GENERALIST_CATEGORY_WEIGHTS,
        scoreField = 'composite_score',
        difficultyPenaltyEnabled = true,
        generalistProfileOverrides = null
    } = {}
) {
    // Load profile generalist params (60s cached)
    const activeProfileParams = await getProfileGeneralistParams();
    const profileParams = generalistProfileOverrides
        ? { ...activeProfileParams, ...generalistProfileOverrides }
        : activeProfileParams;
    const emptyFilterThreshold = profileParams.emptyResponseFilterThreshold !== undefined
        ? profileParams.emptyResponseFilterThreshold
        : EMPTY_RESPONSE_FILTER_THRESHOLD;

    const [categoryMap, emptyRates] = await Promise.all([
        getCategoryScoresByModel(matchQuery, { scoreField }),
        getEmptyResponseRates(matchQuery)
    ]);

    const generalistScores = new Map();

    for (const [key, categoryScores] of categoryMap) {
        const emptyInfo = emptyRates.get(key);
        const emptyRate = emptyInfo ? emptyInfo.emptyRate : 0;

        if (emptyRate > emptyFilterThreshold) {
            generalistScores.set(key, {
                generalistScore: 0,
                weightedSum: 0,
                coveragePenalty: 0,
                consistencyBonus: 0,
                avgWithinCategoryStdDev: null,
                confidenceMargin: null,
                confidenceMethod: null,
                confidenceSampleSize: 0,
                confidenceRepeatCount: 0,
                coverage: 0,
                categoryAverages: {},
                testedCategories: 0,
                filtered: true,
                filterReason: 'excessive_empty_responses',
                emptyRate: Math.round(emptyRate * 100)
            });
            continue;
        }

        const scoreData = calculateGeneralistScoreFromCategories(categoryScores, categoryWeights, profileParams, {
            scoreField,
            difficultyPenaltyEnabled
        });
        scoreData.filtered = false;
        scoreData.emptyRate = Math.round(emptyRate * 100);
        generalistScores.set(key, scoreData);
    }

    return generalistScores;
}

module.exports = {
    getScoringProfileModule,
    getProfileGeneralistParams,
    getActiveCategoryWeights,
    getCategoryScoresByModel,
    getEmptyResponseRates,
    getLeaderboardEntryStats,
    calculateAllGeneralistScores
};

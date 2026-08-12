/**
 * Benchmark Results Module
 * Dashboard, statistics, and model comparison
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { calculateCompositeScore } = require('../qualityScorer');
const { CATEGORY_COMPOSITE_PROFILES, DEFAULT_SCORING_CATEGORY } = require('../scoring/scoringConfigs');
const { calculateAllGeneralistScores } = require('./generalistScore');
const { INFRA_ERROR_REGEX } = require('./errorClassifier');
const {
    getQualityBreakdown,
    getModelTrends,
    compareBatches,
    getBatchQualityBreakdown
} = require('./resultsAnalysis');
const {
    normalizeModelName,
    getRecommendedCategoriesByModel,
    getModelsForCategory,
    getLatestHardwareSnapshotsForModels,
    getRegistryMetadataByModel
} = require('./modelMetadata');
const {
    getCurrentHostModelSnapshot,
    isModelAvailableForRow,
    serializeHostModelSnapshot
} = require('./modelAvailability');

const LEADERBOARD_CATEGORIES = Object.keys(CATEGORY_COMPOSITE_PROFILES);

function buildCategoryScoreFields(scoreValue) {
    return LEADERBOARD_CATEGORIES.reduce((fields, category) => {
        fields[`${category}_score`] = scoreValue;
        return fields;
    }, {});
}

function buildCompositeCategorySummary(calibratedMetrics, fmtScore) {
    const composites = LEADERBOARD_CATEGORIES.map(category => ({
        category,
        composite: calculateCompositeScore(calibratedMetrics, category)
    }));

    const referenceComposite = composites.find(({ category }) => category === DEFAULT_SCORING_CATEGORY)?.composite
        || composites[0]?.composite
        || null;
    const avgCompositeRaw = composites.length > 0
        ? composites.reduce((sum, { composite }) => sum + (Number(composite?.composite_score) || 0), 0) / composites.length
        : null;

    return {
        avgComposite: fmtScore(avgCompositeRaw),
        referenceNormalized: referenceComposite?.normalized || null,
        scoreFields: composites.reduce((fields, { category, composite }) => {
            fields[`${category}_score`] = fmtScore(composite?.composite_score);
            return fields;
        }, {})
    };
}

function calculatePercentDelta(currentValue, referenceValue) {
    const current = Number(currentValue);
    const reference = Number(referenceValue);
    if (!Number.isFinite(current) || !Number.isFinite(reference) || reference === 0) {
        return null;
    }
    return Number((((current - reference) / reference) * 100).toFixed(1));
}

function getHostTestFreshness(ageHours) {
    if (ageHours == null) return 'missing';
    if (ageHours <= 24) return 'fresh';
    if (ageHours <= 72) return 'aging';
    return 'stale';
}

function buildHostTestMetrics(snapshot, benchmarkLatency, benchmarkTokensPerSec) {
    if (!snapshot) {
        return {
            host_test_freshness: 'missing',
            host_test_age_hours: null,
            host_test_latency_delta_pct: null,
            host_test_tokens_delta_pct: null
        };
    }

    const ageHours = Math.max(0, Number(((Date.now() - new Date(snapshot.testedAt).getTime()) / 3600000).toFixed(1)));
    const freshness = getHostTestFreshness(ageHours);
    const latencyDelta = calculatePercentDelta(benchmarkLatency, snapshot.latencyMs);
    const tokensDelta = calculatePercentDelta(benchmarkTokensPerSec, snapshot.tokensPerSec);


    return {
        host_test_freshness: freshness,
        host_test_age_hours: ageHours,
        host_test_latency_delta_pct: latencyDelta,
        host_test_tokens_delta_pct: tokensDelta
    };
}

/**
 * Get paginated test results
 * @param {number} [page=1] - Page number (1-based)
 * @param {number} [limit=50] - Results per page (max 200)
 */
async function getResults({ page = 1, limit = 50 } = {}) {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const skip = (safePage - 1) * safeLimit;

    const [results, total] = await Promise.all([
        BenchmarkResult.find()
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(safeLimit),
        BenchmarkResult.countDocuments()
    ]);

    const totalPages = Math.ceil(total / safeLimit);

    return { results, total, page: safePage, limit: safeLimit, totalPages };
}

/**
 * Generate summary statistics and leaderboard
 */
async function getSummary() {
    const successMatch = {
        success: true,
        // Defense in depth per scoring-contract-v1 §2.7 (0117): infra-failed rows never surface
        // in a leaderboard, even though success:true already excludes them.
        infra_error: { $ne: true },
        excluded_from_leaderboard: { $ne: true },
        model: { $not: /diagnostic/i } // Exclude diagnostic models
    };
    const failureMatch = {
        success: false,
        model: { $not: /diagnostic/i } // Exclude diagnostic models
    };

    const [failed, overallAgg, byModelAgg] = await Promise.all([
        BenchmarkResult.countDocuments(failureMatch),
        BenchmarkResult.aggregate([
            { $match: successMatch },
            {
                $group: {
                    _id: null,
                    successful: { $sum: 1 },
                    avg_latency: { $avg: '$latency' }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: successMatch },
            {
                $group: {
                    _id: '$model',
                    avg_latency: { $avg: '$latency' },
                    avg_tokens_per_sec: { $avg: '$tokens_per_sec' },
                    tests: { $sum: 1 }
                }
            },
            { $sort: { avg_latency: 1 } }
        ])
    ]);

    const summary = overallAgg[0];
    const successful = summary ? summary.successful : 0;

    if (successful === 0) {
        return {
            total_tests: 0,
            successful: 0,
            failed: 0,
            avg_latency: 0,
            leaderboard: []
        };
    }

    const leaderboard = byModelAgg.map(item => ({
        model: item._id,
        avg_latency: Math.round(Number(item.avg_latency) || 0),
        avg_tokens_per_sec: item.avg_tokens_per_sec != null
            ? Number(item.avg_tokens_per_sec).toFixed(2)
            : 0,
        tests: Number(item.tests) || 0
    }));

    return {
        total_tests: successful + failed,
        successful,
        failed,
        avg_latency: Math.round(Number(summary.avg_latency) || 0),
        leaderboard
    };
}

/**
 * Get dashboard data with model statistics
 */
async function getDashboard({ sortBy = 'latency', modelCategory, promptCategory, tag, includeUnavailableModels = false } = {}) {
    // Build match query for filtering.
    // Defense in depth per scoring-contract-v1 §2.7 (0117): infra-failed rows never surface
    // in a leaderboard, even though success:true already excludes them.
    const matchQuery = {
        success: true,
        infra_error: { $ne: true },
        excluded_from_leaderboard: { $ne: true }
    };

    // Filter by prompt category
    if (promptCategory) {
        matchQuery.prompt_category = promptCategory;
    }

    // Filter by tag (batch-level)
    if (tag) {
        const batches = await BenchmarkBatch.find({ tags: tag }).distinct('_id');
        if (batches.length > 0) {
            matchQuery.batch_id = { $in: batches };
        } else {
            // No batches with this tag - return empty results
            matchQuery.batch_id = { $in: [] };
        }
    }
    // Filter by model category using benchmark-derived category evidence
    let modelNames = null;
    if (modelCategory) {
        modelNames = await getModelsForCategory(modelCategory, { success: true });

        if (modelNames.length > 0) {
            matchQuery.model = { $in: modelNames };
        } else {
            matchQuery.model = { $in: [] };
        }
    }

    const scopedMatch = { ...matchQuery };
    delete scopedMatch.success;
    const failureMatchQuery = { ...scopedMatch, success: false };
    const totalMatchQuery = { ...scopedMatch };

    const judgeMatchQuery = { ...matchQuery, scoring_time_ms: { $ne: null } };

    const fullPassCountPromise = BenchmarkResult.countDocuments({
        ...matchQuery,
        quality_score: { $ne: null }
    });

    const [totalTests, successCount, fullPassCount, recentTests, modelStats, levelDistribution, failureStats, judgeStats, generalistScores] = await Promise.all([
        BenchmarkResult.countDocuments(totalMatchQuery),
        BenchmarkResult.countDocuments(matchQuery),
        fullPassCountPromise,
        BenchmarkResult.find(matchQuery).sort({ timestamp: -1 }).limit(10),
        BenchmarkResult.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    avg_latency: { $avg: '$latency' },
                    avg_tokens_per_sec: { $avg: '$tokens_per_sec' },
                    avg_time_to_first_token_ms: {
                        $avg: {
                            $cond: [
                                { $gt: ['$time_to_first_token_ms', 0] },
                                '$time_to_first_token_ms',
                                null
                            ]
                        }
                    },
                    avg_quality: {
                        $avg: {
                            $cond: [
                                { $ne: ['$quality_score', null] },
                                '$quality_score',
                                null
                            ]
                        }
                    },
                    avg_composite: {
                        $avg: {
                            $cond: [
                                { $ne: ['$composite_score', null] },
                                '$composite_score',
                                null
                            ]
                        }
                    },
                    quality_tests: {
                        $sum: {
                            $cond: [
                                { $ne: ['$quality_score', null] },
                                1,
                                0
                            ]
                        }
                    },
                    judge_failed_tests: {
                        $sum: {
                            $cond: [
                                {
                                    $eq: [{ $toLower: { $ifNull: ['$scoring_method', '' ] } }, 'llm_failed']
                                },
                                1,
                                0
                            ]
                        }
                    },
                    judge_pending_tests: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: [{ $type: '$response' }, 'string'] },
                                        { $ne: ['$response', ''] },
                                        { $eq: [{ $toLower: { $ifNull: ['$scoring_method', 'pending'] } }, 'pending'] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { avg_latency: 1 } }
        ]),
        BenchmarkResult.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: {
                        model: '$model',
                        host: '$host',
                        level: '$prompt_level'
                    },
                    count: { $sum: 1 }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: failureMatchQuery },
            {
                $addFields: {
                    __infra_error: {
                        $cond: [
                            { $eq: ['$infra_error', true] },
                            true,
                            {
                                $regexMatch: {
                                    input: { $ifNull: ['$error', ''] },
                                    regex: INFRA_ERROR_REGEX
                                }
                            }
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    failed: { $sum: 1 },
                    infra_failed: { $sum: { $cond: ['$__infra_error', 1, 0] } },
                    model_failed: { $sum: { $cond: ['$__infra_error', 0, 1] } }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: judgeMatchQuery },
            {
                $group: {
                    _id: { model: '$judge_model', host: '$judge_host' },
                    avg_latency: { $avg: '$scoring_time_ms' },
                    count: { $sum: 1 }
                }
            }
        ]),
        // Calculate generalist scores (with coverage penalty) for all models
        calculateAllGeneralistScores(matchQuery)
    ]);

    const failureByKey = new Map(
        (failureStats || []).map(s => [`${s._id.model}@@${s._id.host}`, {
            failed: s.failed || 0,
            infra_failed: s.infra_failed || 0,
            model_failed: s.model_failed || 0
        }])
    );
    const levelStatsByKey = new Map();
    for (const item of (levelDistribution || [])) {
        const level = Number(item && item._id ? item._id.level : NaN);
        if (!Number.isFinite(level)) continue;
        const key = `${item._id.model}@@${item._id.host}`;
        if (!levelStatsByKey.has(key)) {
            levelStatsByKey.set(key, {});
        }
        levelStatsByKey.get(key)[String(level)] = Number(item.count) || 0;
    }

    // Helper to format composite score (0-100) to display scale (0-10)
    const fmtScore = (s) => (s !== null && s !== undefined && !isNaN(s)) ? (s / 10).toFixed(1) : null;

    // Format and sort model stats
    const successByKey = new Map();
    let sortedStats = modelStats.map(m => {
        const hasQuality = m.avg_quality != null && !isNaN(m.avg_quality);

        // Raw quality (0-10 scale) for display
        const rawQuality = m.avg_quality ?? 0;

        const avgLatency = Number(m.avg_latency) || 0;
        const avgTokens = parseFloat(m.avg_tokens_per_sec) || 0;

        const key = `${m._id.model}@@${m._id.host}`;

        // Get generalist score (with coverage penalty and consistency bonus)
        // This is the single source of truth for quality scoring
        const generalistData = generalistScores.get(key);
        // Generalist score is 0-100 scale, convert to 0-10 for composite calculation
        const adjustedQuality = generalistData
            ? generalistData.generalistScore / 10
            : rawQuality;

        const fail = failureByKey.get(key) || { failed: 0, infra_failed: 0, model_failed: 0 };
        const failedTests = fail.failed || 0;
        const infraFailedTests = fail.infra_failed || 0;
        const modelFailedTests = fail.model_failed || 0;
        const successTests = m.count || 0;
        const fullPassedTests = m.quality_tests || 0;
        const judgeFailedTests = m.judge_failed_tests || 0;
        const judgePendingTests = m.judge_pending_tests || 0;
        const fullPassDenominator = successTests + modelFailedTests;
        const fullPassRate = fullPassDenominator > 0
            ? (fullPassedTests / fullPassDenominator) * 100
            : 0;

        successByKey.set(key, true);

        return {
            model: m._id.model,
            host: m._id.host,
            avg_latency: Math.round(avgLatency),
            avg_tokens_per_sec: avgTokens.toFixed(2),
            avg_time_to_first_token_ms: m.avg_time_to_first_token_ms != null
                ? Number(Number(m.avg_time_to_first_token_ms).toFixed(1))
                : null,
            // Display adjusted quality (generalist score on 0-10 scale)
            avg_quality: hasQuality ? adjustedQuality.toFixed(1) : null,
            // Also include raw quality for reference
            raw_quality: hasQuality ? rawQuality.toFixed(1) : null,

            // Generalist breakdown (for transparency)
            generalist_breakdown: generalistData ? {
                coverage: generalistData.coverage,
                coveragePenalty: generalistData.coveragePenalty,
                consistencyBonus: generalistData.consistencyBonus,
                avgWithinCategoryStdDev: generalistData.avgWithinCategoryStdDev,
                testedCategories: generalistData.testedCategories
            } : null,

            quality_tests: m.quality_tests || 0,
            full_passed_tests: fullPassedTests,
            judge_failed_tests: judgeFailedTests,
            judge_pending_tests: judgePendingTests,
            full_pass_rate: Number(fullPassRate.toFixed(1)),
            level_stats: levelStatsByKey.get(key) || {},
            tests: successTests,
            failed_tests: failedTests,
            infra_failed_tests: infraFailedTests,
            model_failed_tests: modelFailedTests,
            total_tests: successTests + failedTests,
            failure_only: false,
            filtered: generalistData?.filtered || false,
            emptyRate: generalistData?.emptyRate || 0
        };
    });

    // Add failure-only model/host combos so issues are visible in the leaderboard.
    for (const [key] of failureByKey.entries()) {
        if (successByKey.has(key)) continue;
        const [model, host] = key.split('@@');
        const fail = failureByKey.get(key) || { failed: 0, infra_failed: 0, model_failed: 0 };
        sortedStats.push({
            model,
            host,
            avg_latency: 0,
            avg_tokens_per_sec: '0',
            avg_time_to_first_token_ms: null,
            avg_quality: null,
            avg_composite: null,
            ...buildCategoryScoreFields(fmtScore(0)),
            quality_tests: 0,
            full_passed_tests: 0,
            judge_failed_tests: 0,
            judge_pending_tests: 0,
            full_pass_rate: 0,
            level_stats: {},
            tests: 0,
            failed_tests: fail.failed || 0,
            infra_failed_tests: fail.infra_failed || 0,
            model_failed_tests: fail.model_failed || 0,
            total_tests: fail.failed || 0,
            failure_only: true
        });
    }
    // Enrich with benchmark-derived category and hardware profile data
    const uniqueModelNames = [...new Set(sortedStats.map(s => normalizeModelName(s.model)).filter(Boolean))];
    const [recommendedCategories, hostPerformanceByModel, registryMetadataByModel, availabilitySnapshot] = await Promise.all([
        getRecommendedCategoriesByModel(uniqueModelNames),
        getLatestHardwareSnapshotsForModels(uniqueModelNames),
        getRegistryMetadataByModel(uniqueModelNames),
        getCurrentHostModelSnapshot()
    ]);

    sortedStats = sortedStats.map(stat => {
        const normalizedModel = normalizeModelName(stat.model);
        const hostPerfSummary = hostPerformanceByModel[normalizedModel] || { latestAny: null, latestPass: null, byHost: {} };
        const byExactHost = hostPerfSummary.byHost?.[stat.host];
        const hostSnapshot = byExactHost?.latestPass || byExactHost?.latest || hostPerfSummary.latestPass || hostPerfSummary.latestAny;
        const registryMetadata = registryMetadataByModel.get(normalizedModel) || { manualCategories: [], recommendedCategory: null };
        const hostTestMetrics = buildHostTestMetrics(
            hostSnapshot,
            stat.avg_latency,
            parseFloat(stat.avg_tokens_per_sec)
        );
        const calibratedMetrics = {
            latency: stat.avg_latency,
            tokens_per_sec: parseFloat(stat.avg_tokens_per_sec),
            time_to_first_token_ms: stat.avg_time_to_first_token_ms,
            quality_score: Number(stat.avg_quality) || 0,
            performance_baseline: hostSnapshot || null
        };
        const compositeSummary = buildCompositeCategorySummary(calibratedMetrics, fmtScore);
        const vramEfficiency = hostSnapshot?.vramUsedMiB && Number(stat.avg_quality)
            ? Number((Number(stat.avg_quality) / (hostSnapshot.vramUsedMiB / 1024)).toFixed(2))
            : null;

        return {
            ...stat,
            host_available: isModelAvailableForRow(stat, availabilitySnapshot),
            recommended_category: recommendedCategories.get(normalizedModel) || registryMetadata.recommendedCategory || null,
            manual_categories: registryMetadata.manualCategories || [],
            ...compositeSummary.scoreFields,
            normalized_quality: compositeSummary.referenceNormalized
                ? (compositeSummary.referenceNormalized.quality / 10).toFixed(1)
                : null,
            normalized_latency: compositeSummary.referenceNormalized
                ? (compositeSummary.referenceNormalized.latency / 10).toFixed(1)
                : null,
            normalized_speed: compositeSummary.referenceNormalized
                ? (compositeSummary.referenceNormalized.speed / 10).toFixed(1)
                : null,
            avg_composite: compositeSummary.avgComposite,
            avg_time_to_first_token_ms: stat.avg_time_to_first_token_ms ?? null,
            host_test_status: hostSnapshot?.status || null,
            host_test_tokens_per_sec: hostSnapshot?.tokensPerSec ?? null,
            host_test_latency_ms: hostSnapshot?.latencyMs ?? null,
            host_test_ttft_ms: hostSnapshot?.timeToFirstTokenMs ?? null,
            host_test_vram_used_mib: hostSnapshot?.vramUsedMiB ?? null,
            host_test_vram_total_mib: hostSnapshot?.vramTotalMiB ?? null,
            host_test_vram_efficiency: vramEfficiency,
            host_test_num_ctx: hostSnapshot?.numCtx ?? null,
            host_test_num_ctx_source: hostSnapshot?.numCtxSource ?? null,
            host_test_tested_at: hostSnapshot?.testedAt || null,
            host_test_source: hostSnapshot?.source || null,
            host_test_error: hostSnapshot?.error || null,
            ...hostTestMetrics
        };
    });

    const unavailableStats = sortedStats.filter(stat => !stat.host_available);
    if (!includeUnavailableModels) {
        sortedStats = sortedStats.filter(stat => stat.host_available);
    }

    // Apply sorting
    switch (sortBy) {
        case 'full_pass':
        case 'reliability':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                const aStrict = Number(a.full_pass_rate) || 0;
                const bStrict = Number(b.full_pass_rate) || 0;
                if (aStrict !== bStrict) return bStrict - aStrict;
                const aPending = Number(a.judge_pending_tests) || 0;
                const bPending = Number(b.judge_pending_tests) || 0;
                if (aPending !== bPending) return aPending - bPending;
                const aJudgeFailed = Number(a.judge_failed_tests) || 0;
                const bJudgeFailed = Number(b.judge_failed_tests) || 0;
                if (aJudgeFailed !== bJudgeFailed) return aJudgeFailed - bJudgeFailed;
                const aTotal = Number(a.total_tests) || 0;
                const bTotal = Number(b.total_tests) || 0;
                if (aTotal !== bTotal) return bTotal - aTotal;
                return a.avg_latency - b.avg_latency;
            });
            break;
        case 'quality':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                return (Number(b.avg_quality) || 0) - (Number(a.avg_quality) || 0);
            });
            break;
        case 'composite':
            sortedStats.sort((a, b) => {
                if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                const diff = (Number(b.avg_composite) || 0) - (Number(a.avg_composite) || 0);
                return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
            });
            break;
        default:
            if (LEADERBOARD_CATEGORIES.includes(sortBy)) {
                const scoreField = `${sortBy}_score`;
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    const diff = (Number(b[scoreField]) || 0) - (Number(a[scoreField]) || 0);
                    return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
                });
                break;
            }
            switch (sortBy) {
            case 'speed':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    return parseFloat(b.avg_tokens_per_sec) - parseFloat(a.avg_tokens_per_sec);
                });
                break;
            case 'latency':
            default:
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    return a.avg_latency - b.avg_latency;
                });
            }
            break;
    }

    return {
        overview: {
            total_tests: totalTests,
            successful: successCount,
            full_passed: fullPassCount,
            failed: totalTests - successCount,
            exec_success_rate: totalTests > 0
                ? ((successCount / totalTests) * 100).toFixed(1) + '%'
                : '0%',
            full_pass_rate: totalTests > 0
                ? ((fullPassCount / totalTests) * 100).toFixed(1) + '%'
                : '0%',
            success_rate: totalTests > 0
                ? ((successCount / totalTests) * 100).toFixed(1) + '%'
                : '0%'
        },
        recent_tests: recentTests,
        model_stats: sortedStats,
        unavailable_model_stats: unavailableStats,
        include_unavailable_models: includeUnavailableModels,
        host_model_snapshot: serializeHostModelSnapshot(availabilitySnapshot),
        judge_stats: judgeStats,
        sorted_by: sortBy
    };
}

/**
 * Compare multiple models
 */
async function compareModels(models) {
    if (!models || !Array.isArray(models)) {
        throw new Error('models array is required');
    }

    const comparison = await Promise.all(
        models.map(model => BenchmarkResult.getModelStats(model))
    );

    return { comparison };
}

module.exports = {
    getResults,
    getSummary,
    getDashboard,
    compareModels,
    getQualityBreakdown,
    getModelTrends,
    compareBatches,
    getBatchQualityBreakdown
};

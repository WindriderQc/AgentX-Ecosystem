/**
 * Benchmark Service
 * Business logic for LLM performance testing and quality scoring
 * Implements Service-Oriented Architecture pattern
 *
 * This is the main facade that preserves the singleton API while
 * delegating to modular sub-components.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');

// Import sub-modules
const { DEFAULT_EXECUTION_CONFIG } = require('./config');
const { seedPrompts, cleanupStaleBatches, getPrompts, getConfigPresets } = require('./init');
const { runTest, startBatch, resumeBatch, executeBatch, stopBatch, getActiveBatchId, getActiveHeartbeatInterval } = require('./execution');
const { getResults, getSummary, getDashboard, compareModels, getQualityBreakdown, getModelTrends, compareBatches, getBatchQualityBreakdown } = require('./results');
const { getBatches, getBatch, getBatchStatsByTag, clearResults, clearFailedResults, getActiveStats } = require('./batches');
const { getJudgeLeaderboard, getJudgeBreakdown, getJudgeActivity, getTruncationStats } = require('./judges');
const {
    calculateAllGeneralistScores,
    getActiveCategoryWeights,
    getCategoryScoresByModel,
    getLeaderboardEntryStats,
    buildCategoryEvidenceView
} = require('./generalistScore');
const { getTopCategoryFromAverages } = require('./modelMetadata');
const { getCurrentHostModelSnapshot, isModelAvailableForRow, serializeHostModelSnapshot } = require('./modelAvailability');
const {
    resolveTrustedEvidenceCohort,
    buildConsumerTrustVerdict
} = require('./trustedEvidenceCohort');
const { judgeResult, judgeBatch, stopJudging, getJudgingStatus, stopAllJudging } = require('./judging');
const { getEfficiencyMap } = require('./efficiencyMap');
const { buildIdleCurrentTest } = require('./batchHelpers');

const TRUST_SCOPE_TRUSTED = 'trusted';
const TRUST_SCOPE_EXPLORATORY = 'exploratory';

// Graceful shutdown handler - mark batch as interrupted when PM2 restarts
process.on('SIGTERM', async () => {
    const SHUTDOWN_DEADLINE_MS = 5000;  // 5 second hard deadline
    const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;

    const activeBatchId = getActiveBatchId();
    const activeHeartbeatInterval = getActiveHeartbeatInterval();

    const shutdown = async () => {
        // Stop all active judging jobs
        stopAllJudging();

        if (activeBatchId) {
            logger.warn('SIGTERM received - marking active batch as interrupted', { batchId: activeBatchId });
            try {
                if (activeHeartbeatInterval) {
                    clearInterval(activeHeartbeatInterval);
                }
                await BenchmarkTimelineEntry.create({
                    batchId: activeBatchId,
                    timestamp: new Date(),
                    event: 'sigterm_interrupted',
                    success: false,
                    error: 'Process received SIGTERM signal'
                }).catch(() => {});

                await BenchmarkBatch.updateOne(
                    { _id: activeBatchId, status: 'running' },
                    {
                        $set: {
                            status: 'interrupted',
                            completed_at: new Date(),
                            last_activity_at: new Date(),
                            current_test: buildIdleCurrentTest(),
                            active_slot: null
                        }
                    }
                );
                logger.info('Batch marked as interrupted', { batchId: activeBatchId });
            } catch (err) {
                logger.error('Failed to mark batch as interrupted on SIGTERM', {
                    batchId: activeBatchId,
                    error: err.message
                });
            }
        }
    };

    // Race between shutdown logic and hard deadline
    const sleepUntilDeadline = () => new Promise(resolve => {
        const remaining = deadline - Date.now();
        if (remaining > 0) setTimeout(resolve, remaining);
        else resolve();
    });

    try {
        await Promise.race([shutdown(), sleepUntilDeadline()]);
    } finally {
        process.exit(0);
    }
});

/**
 * BenchmarkService class - facade preserving original API
 */
class BenchmarkService {
    // Initialization
    seedPrompts = seedPrompts;
    cleanupStaleBatches = cleanupStaleBatches;
    getPrompts = getPrompts;
    getConfigPresets = getConfigPresets;

    getExecutionConfigDefaults() {
        return { ...DEFAULT_EXECUTION_CONFIG };
    }

    // Execution
    runTest = runTest;
    startBatch = startBatch;
    resumeBatch = resumeBatch;
    executeBatch = executeBatch;
    stopBatch = stopBatch;

    // Results and Dashboard
    getResults = getResults;
    getSummary = getSummary;
    getDashboard = getDashboard;
    compareModels = compareModels;
    getQualityBreakdown = getQualityBreakdown;
    getBatchQualityBreakdown = getBatchQualityBreakdown;
    getModelTrends = getModelTrends;
    compareBatches = compareBatches;

    // Batches
    getBatches = getBatches;
    getBatch = getBatch;
    getBatchStatsByTag = getBatchStatsByTag;
    clearResults = clearResults;
    clearFailedResults = clearFailedResults;
    getActiveStats = getActiveStats;

    // Judges
    getJudgeLeaderboard = getJudgeLeaderboard;
    getJudgeBreakdown = getJudgeBreakdown;
    getJudgeActivity = getJudgeActivity;
    getTruncationStats = getTruncationStats;

    // Judging (decoupled from execution)
    judgeResult = judgeResult;
    judgeBatch = judgeBatch;
    stopJudging = stopJudging;
    getJudgingStatus = getJudgingStatus;

    // Efficiency Map
    getEfficiencyMap = getEfficiencyMap;

    // Generalist Leaderboard
    // axis param ∈ {'composite' (default), 'deterministic', 'subjective', 'quality'}
    // selects which numeric field aggregations key off:
    //   composite     → composite_score (latency-aware "headline" leaderboard)
    //   quality       → quality_score (judge quality only, 0-10 scale)
    //   deterministic → deterministic_score (0-10 scale)
    //   subjective    → subjective_score (0-10 scale)
    async getGeneralistLeaderboard(options = {}) {
        const requestedAxis = options.axis === 'deterministic' ? 'deterministic'
            : options.axis === 'subjective' ? 'subjective'
            : options.axis === 'quality' ? 'quality'
            : 'composite';
        const includeCloud = options.includeCloud !== false;
        // The latency-aware composite mixes hardware-local latency with WAN and
        // provider queueing. It is intentionally available only on the
        // local-only board.
        const axis = includeCloud && requestedAxis === 'composite' ? 'quality' : requestedAxis;
        const hostScope = options.hostScope === 'primary' ? 'primary'
            : options.hostScope === 'current' ? 'current'
            : 'all';
        const challengeScope = options.challengeScope === 'advanced' ? 'advanced'
            : options.challengeScope === 'foundation' ? 'foundation'
            : 'all';
        if (![TRUST_SCOPE_TRUSTED, TRUST_SCOPE_EXPLORATORY].includes(options.trustScope)) {
            const error = new Error('trustScope must be explicitly set to trusted or exploratory');
            error.code = 'TRUST_SCOPE_REQUIRED';
            throw error;
        }
        const trustScope = options.trustScope;
        const trustedView = trustScope === TRUST_SCOPE_TRUSTED;
        const includeUnavailableModels = options.includeUnavailableModels === true;
        const scoreField = axis === 'deterministic' ? 'deterministic_score'
            : axis === 'subjective' ? 'subjective_score'
            : axis === 'quality' ? 'quality_score'
            : 'composite_score';

        const categoryWeights = await getActiveCategoryWeights();
        // Defense in depth per scoring-contract-v1 §2.7 (0117): infra-failed rows never surface
        // in a leaderboard, even though success:true already excludes them.
        const leaderboardMatch = {
            success: true,
            infra_error: { $ne: true },
            excluded_from_leaderboard: { $ne: true },
            // Every axis is now driven by a populated score field; without
            // this filter the aggregate averages over a sea of nulls and
            // produces phantom rankings. Pre-fix this guard was skipped for
            // the composite axis because composite resolved to quality_score,
            // which was almost always present once judging completed —
            // composite_score has the same property post-judging, but the
            // explicit guard removes that implicit assumption.
            [scoreField]: { $ne: null }
        };
        const addMatchClause = (clause) => {
            leaderboardMatch.$and = [...(leaderboardMatch.$and || []), clause];
        };
        if (!includeCloud) {
            addMatchClause({
                $or: [
                    { 'execution_target.tier': 'local' },
                    { execution_target: null },
                    { execution_target: { $exists: false } }
                ]
            });
        }
        const configuredHosts = getConfiguredHosts()
            .map((host) => ({ name: host.name, url: host.url }))
            .filter((host) => host.url);
        const configuredHostUrls = configuredHosts.map((host) => host.url);
        const primaryHostUrl = configuredHosts[0]?.url || null;
        const hostFilterApplied = Boolean((hostScope === 'current' && configuredHostUrls.length > 0)
            || (hostScope === 'primary' && primaryHostUrl));
        if (hostScope === 'primary' && primaryHostUrl) {
            leaderboardMatch.host = primaryHostUrl;
        } else if (hostFilterApplied) {
            if (includeCloud) {
                addMatchClause({
                    $or: [
                        { host: { $in: configuredHostUrls } },
                        { 'execution_target.tier': { $in: ['free_cloud', 'paid_cloud'] } }
                    ]
                });
            } else {
                leaderboardMatch.host = { $in: configuredHostUrls };
            }
        }
        if (challengeScope === 'advanced') {
            leaderboardMatch.prompt_level = { $gte: 4, $lte: 5 };
        } else if (challengeScope === 'foundation') {
            leaderboardMatch.prompt_level = { $gte: 1, $lte: 3 };
        }
        const trustedFilters = {
            confidenceWeighting: trustedView,
            exactIdentityRequired: trustedView,
            singleCompatibleCohort: trustedView,
            excludedIncompleteBatches: 0,
            cohort: null
        };
        let cohortResolution = null;
        let selectedQualityCohortFingerprint = null;
        let nonComparableRows = [];
        if (trustedView) {
            const [incompleteBatchIds, resolvedCohort] = await Promise.all([
                BenchmarkBatch.distinct('_id', {
                    status: 'failed',
                    failure_reason: 'incomplete_cells'
                }),
                resolveTrustedEvidenceCohort(leaderboardMatch)
            ]);
            cohortResolution = resolvedCohort;
            trustedFilters.excludedIncompleteBatches = incompleteBatchIds.length;
            trustedFilters.cohort = {
                selected: resolvedCohort.selected,
                candidateBatchCount: resolvedCohort.candidateBatchCount,
                eligibleBatchCount: resolvedCohort.eligibleBatchCount,
                excludedBatchCount: resolvedCohort.excludedBatchCount,
                exclusionReasons: resolvedCohort.exclusionReasons,
                freshnessDays: resolvedCohort.freshnessDays
            };
            // A single completed batch is the comparison boundary. Its rows
            // share one captured fixture suite and scorer generation, while
            // every candidate still carries its own exact artifact/runtime ID.
            // An empty $in intentionally yields an empty Trusted board when no
            // such cohort exists; legacy evidence remains in Exploratory.
            leaderboardMatch.batch_id = resolvedCohort.selectedBatchObjectId
                || { $in: [] };
        }
        if (includeCloud) {
            // Rank only one exact quality cohort. Historical rows without the
            // additive fingerprint stay visible below as non-comparable; they
            // are never silently treated as proof-equivalent.
            const cohortBaseMatch = { ...leaderboardMatch };
            const latestComparable = await BenchmarkResult.findOne({
                ...cohortBaseMatch,
                quality_cohort_fingerprint: { $type: 'string', $ne: '' }
            }).sort({ timestamp: -1 }).select('quality_cohort_fingerprint').lean();
            selectedQualityCohortFingerprint = latestComparable?.quality_cohort_fingerprint || null;
            leaderboardMatch.quality_cohort_fingerprint = selectedQualityCohortFingerprint || { $in: [] };
            nonComparableRows = await BenchmarkResult.aggregate([
                {
                    $match: selectedQualityCohortFingerprint
                        ? {
                            ...cohortBaseMatch,
                            $and: [
                                ...(cohortBaseMatch.$and || []),
                                {
                                $or: [
                                    { quality_cohort_fingerprint: { $ne: selectedQualityCohortFingerprint } },
                                    { quality_cohort_fingerprint: null },
                                    { quality_cohort_fingerprint: { $exists: false } }
                                ]
                                }
                            ]
                        }
                        : cohortBaseMatch
                },
                { $sort: { timestamp: -1 } },
                {
                    $group: {
                        _id: { model: '$model', host: '$host', cohort: '$quality_cohort_fingerprint' },
                        target: { $first: '$execution_target' },
                        latestTimestamp: { $first: '$timestamp' },
                        totalTests: { $sum: 1 },
                        providerCostNanodollars: { $sum: { $ifNull: ['$provider_cost.costNanodollars', 0] } }
                    }
                },
                { $limit: 200 }
            ]);
        }
        const challengeFilterApplied = challengeScope !== 'all';
        const [generalistScores, categoryMap, availabilitySnapshot] = await Promise.all([
            calculateAllGeneralistScores(leaderboardMatch, {
                categoryWeights,
                scoreField,
                difficultyPenaltyEnabled: challengeScope !== 'foundation',
                generalistProfileOverrides: trustedView ? { confidenceWeighting: true } : null
            }),
            getCategoryScoresByModel(leaderboardMatch, { scoreField }),
            getCurrentHostModelSnapshot()
        ]);
        const entryStats = await getLeaderboardEntryStats(leaderboardMatch);
        const leaderboard = [];
        for (const [key, data] of generalistScores) {
            const [model, host] = key.split('@@');
            const catScores = categoryMap.get(key) || {};
            const totalTests = Object.values(catScores).reduce((sum, c) => sum + (c.count || 0), 0);
            const stats = entryStats.get(key) || {};
            const harnessEvidence = stats.harnessEvidence || { rankable: true, reason: null };
            const categoryView = buildCategoryEvidenceView(
                catScores,
                data.categoryAverages,
                categoryWeights
            );

            const row = {
                model,
                host: host || null,
                host_available: stats.executionTarget?.executionKind === 'harness'
                    ? stats.executionTarget.available !== false
                    : isModelAvailableForRow({ model, host: host || null }, availabilitySnapshot),
                executionTarget: stats.executionTarget || null,
                provider: stats.executionTarget?.provider || 'ollama',
                tier: stats.executionTarget?.tier || 'local',
                harness: stats.executionTarget?.harness || null,
                pricing: stats.executionTarget?.pricing || null,
                providerCostNanodollars: stats.providerCostNanodollars || 0,
                qualityCohortFingerprint: stats.qualityCohortFingerprint || selectedQualityCohortFingerprint,
                rankable: harnessEvidence.rankable !== false,
                harnessEvidence,
                generalistScore: data.generalistScore,
                weightedSum: data.weightedSum,
                coveragePenalty: data.coveragePenalty,
                difficultyPenalty: data.difficultyPenalty || 0,
                difficultyCoverage: data.difficultyCoverage,
                fullScopeMinLevel: data.fullScopeMinLevel,
                requiredPromptLevels: data.requiredPromptLevels || [],
                missingRequiredLevelsByCategory: data.missingRequiredLevelsByCategory || {},
                minFullScopeResults: data.minFullScopeResults || 0,
                minConsistencyResults: data.minConsistencyResults || 0,
                fullScopeEligible: data.fullScopeEligible === true,
                evidenceStatus: data.evidenceStatus || null,
                consistencyBonus: data.consistencyBonus,
                evidenceConfidence: data.evidenceConfidence ?? null,
                evidenceConfidenceCoverage: data.evidenceConfidenceCoverage ?? null,
                evidenceConfidenceTarget: data.evidenceConfidenceTarget ?? null,
                evidenceConfidencePenalty: data.evidenceConfidencePenalty || 0,
                avgWithinCategoryStdDev: data.avgWithinCategoryStdDev,
                coverage: data.coverage,
                testedCategories: data.testedCategories,
                totalTests,
                confidenceMargin: data.confidenceMargin ?? null,
                confidenceMethod: data.confidenceMethod || null,
                confidenceSampleSize: data.confidenceSampleSize || 0,
                confidenceRepeatCount: data.confidenceRepeatCount || 0,
                confidenceWeighted: data.confidenceWeighted || false,
                categoryConfidence: data.categoryConfidence || null,
                recommended_category: getTopCategoryFromAverages(categoryView.categoryAverages, model),
                categoryAverages: categoryView.categoryAverages,
                categoryEvidence: categoryView.categoryEvidence,
                promptLevelCounts: stats.promptLevelCounts || {},
                minPromptLevel: stats.minPromptLevel || null,
                maxPromptLevel: stats.maxPromptLevel || null,
                contextCounts: stats.contextCounts || {},
                judgeModels: stats.judgeModels || [],
                judgeTargets: stats.judgeTargets || [],
                needsReviewCount: stats.needsReviewCount || 0,
                lowConfidenceCount: stats.lowConfidenceCount || 0,
                earliestTimestamp: stats.earliestTimestamp || null,
                latestTimestamp: stats.latestTimestamp || null,
                evidenceCompatibility: harnessEvidence.rankable === false
                    ? 'incomplete_harness_evidence'
                    : trustedView ? 'exact_compatible' : 'exploratory',
                evidenceCohortId: trustedView ? trustedFilters.cohort?.selected?.evidenceFingerprint || null : null,
                filtered: data.filtered || false,
                filterReason: data.filterReason || harnessEvidence.reason || null,
                emptyRate: data.emptyRate || 0
            };

            if (includeUnavailableModels || row.host_available) {
                leaderboard.push(row);
            }
        }

        for (const item of nonComparableRows) {
            const target = item.target || null;
            const row = {
                model: item._id.model,
                host: item._id.host || null,
                host_available: target?.executionKind === 'harness'
                    ? target.available !== false
                    : isModelAvailableForRow({ model: item._id.model, host: item._id.host || null }, availabilitySnapshot),
                executionTarget: target,
                provider: target?.provider || 'ollama',
                tier: target?.tier || 'local',
                harness: target?.harness || null,
                pricing: target?.pricing || null,
                providerCostNanodollars: item.providerCostNanodollars || 0,
                qualityCohortFingerprint: item._id.cohort || null,
                rankable: false,
                generalistScore: null,
                totalTests: item.totalTests || 0,
                evidenceStatus: 'non_comparable_cohort',
                evidenceCompatibility: 'non_comparable',
                filterReason: 'quality_cohort_fingerprint_mismatch',
                latestTimestamp: item.latestTimestamp || null,
                categoryAverages: {},
                categoryEvidence: {},
                testedCategories: 0,
                coverage: 0,
                fullScopeEligible: false,
                filtered: false
            };
            if (includeUnavailableModels || row.host_available) leaderboard.push(row);
        }

        // Full-scope rows rank ahead of partial evidence. Partial rows remain
        // visible/auditable, but they no longer masquerade as comparable
        // leaders just because a narrow hard-level slice scored well.
        leaderboard.sort((a, b) => {
            if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
            if (a.fullScopeEligible !== b.fullScopeEligible) return a.fullScopeEligible ? -1 : 1;
            return (b.generalistScore ?? -Infinity) - (a.generalistScore ?? -Infinity);
        });

        const confidenceWeighted = leaderboard.some(e => e.confidenceWeighted);
        const trustVerdict = buildConsumerTrustVerdict({
            trustScope,
            cohortResolution,
            rows: leaderboard,
            scopeComplete: trustedView
                ? leaderboard.length >= 2 && leaderboard.every((row) => row.fullScopeEligible === true)
                : null
        });
        for (const row of leaderboard) {
            row.evidenceTrustState = trustVerdict.state;
            row.qualifiedWinnerEligible = false;
        }

        return {
            leaderboard,
            categoryWeights,
            confidenceWeighted,
            axis,
            hostScope,
            hostFilterApplied,
            configuredHosts,
            primaryHostUrl,
            includeUnavailableModels,
            includeCloud,
            requestedAxis,
            selectedQualityCohortFingerprint,
            hostModelSnapshot: serializeHostModelSnapshot(availabilitySnapshot),
            challengeScope,
            challengeFilterApplied,
            trustScope,
            trusted: trustedView,
            trustVerdict,
            trustedFilters,
            challengeLevelRange: challengeScope === 'advanced'
                ? { min: 4, max: 5 }
                : challengeScope === 'foundation'
                    ? { min: 1, max: 3 }
                    : null
        };
    }
}

// Export singleton instance (preserves original API)
module.exports = new BenchmarkService();

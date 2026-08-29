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
    buildCategoryEvidenceView,
    confidenceMargin
} = require('./generalistScore');
const { getTopCategoryFromAverages } = require('./modelMetadata');
const { getCurrentHostModelSnapshot, isModelAvailableForRow, serializeHostModelSnapshot } = require('./modelAvailability');
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
        const axis = options.axis === 'deterministic' ? 'deterministic'
            : options.axis === 'subjective' ? 'subjective'
            : options.axis === 'quality' ? 'quality'
            : 'composite';
        const hostScope = options.hostScope === 'primary' ? 'primary'
            : options.hostScope === 'current' ? 'current'
            : 'all';
        const challengeScope = options.challengeScope === 'advanced' ? 'advanced'
            : options.challengeScope === 'foundation' ? 'foundation'
            : 'all';
        const trustScope = options.trustScope === TRUST_SCOPE_TRUSTED
            ? TRUST_SCOPE_TRUSTED
            : TRUST_SCOPE_EXPLORATORY;
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
            leaderboardMatch.host = { $in: configuredHostUrls };
        }
        if (challengeScope === 'advanced') {
            leaderboardMatch.prompt_level = { $gte: 4, $lte: 5 };
        } else if (challengeScope === 'foundation') {
            leaderboardMatch.prompt_level = { $gte: 1, $lte: 3 };
        }
        const trustedFilters = {
            confidenceWeighting: trustedView,
            excludedIncompleteBatches: 0
        };
        if (trustedView) {
            const incompleteBatchIds = await BenchmarkBatch.distinct('_id', {
                status: 'failed',
                failure_reason: 'incomplete_cells'
            });
            trustedFilters.excludedIncompleteBatches = incompleteBatchIds.length;
            if (incompleteBatchIds.length > 0) {
                leaderboardMatch.batch_id = { $nin: incompleteBatchIds };
            }
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
            const categoryView = buildCategoryEvidenceView(
                catScores,
                data.categoryAverages,
                categoryWeights
            );

            const margin = confidenceMargin(
                data.avgWithinCategoryStdDev || 0,
                totalTests
            );

            const row = {
                model,
                host: host || null,
                host_available: isModelAvailableForRow({ model, host: host || null }, availabilitySnapshot),
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
                evidenceConfidenceTarget: data.evidenceConfidenceTarget ?? null,
                evidenceConfidencePenalty: data.evidenceConfidencePenalty || 0,
                avgWithinCategoryStdDev: data.avgWithinCategoryStdDev,
                coverage: data.coverage,
                testedCategories: data.testedCategories,
                totalTests,
                confidenceMargin: margin,
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
                needsReviewCount: stats.needsReviewCount || 0,
                lowConfidenceCount: stats.lowConfidenceCount || 0,
                earliestTimestamp: stats.earliestTimestamp || null,
                latestTimestamp: stats.latestTimestamp || null,
                filtered: data.filtered || false,
                filterReason: data.filterReason || null,
                emptyRate: data.emptyRate || 0
            };

            if (includeUnavailableModels || row.host_available) {
                leaderboard.push(row);
            }
        }

        // Full-scope rows rank ahead of partial evidence. Partial rows remain
        // visible/auditable, but they no longer masquerade as comparable
        // leaders just because a narrow hard-level slice scored well.
        leaderboard.sort((a, b) => {
            if (a.fullScopeEligible !== b.fullScopeEligible) return a.fullScopeEligible ? -1 : 1;
            return b.generalistScore - a.generalistScore;
        });

        const confidenceWeighted = leaderboard.some(e => e.confidenceWeighted);

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
            hostModelSnapshot: serializeHostModelSnapshot(availabilitySnapshot),
            challengeScope,
            challengeFilterApplied,
            trustScope,
            trusted: trustedView,
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

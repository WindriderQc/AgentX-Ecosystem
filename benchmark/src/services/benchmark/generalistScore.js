/**
 * Generalist Quality Score Calculator — public facade
 * ===================================================
 *
 * SINGLE SOURCE OF TRUTH for quality scoring across all benchmark leaderboards.
 *
 * Documentation: docs/operations/GENERALIST_SCORING_SYSTEM.md
 *
 * FORMULA:
 *   generalistScore = weightedQuality - coveragePenalty - difficultyPenalty
 *                     - evidenceConfidencePenalty + consistencyBonus
 *
 * WHERE:
 *   - weightedQuality: Normalized weighted avg of category scores (0-100)
 *   - coveragePenalty: Points deducted for missing category coverage
 *   - consistencyBonus: +5 if avg within-category stddev < threshold
 *
 * USED BY:
 *   - Model Dashboard (results.js) - generalist score feeds composite calculation
 *   - Generalist Leaderboard API (/api/benchmark/generalist-leaderboard)
 *   - Frontend generalist-leaderboard.js (fetches from API, no local calc)
 *
 * DESIGN RATIONALE:
 *   - Coverage penalty prevents gaming by only running easy tests
 *   - Within-category consistency rewards reliable/predictable models
 *   - Infrastructure failures are exempted from coverage penalty
 *
 * STRUCTURE (task 0228 split — each module ≤700 lines, behavior unchanged and
 * locked by tests/unit/benchmark/generalistScoreGolden.test.js):
 *   - generalistScoreConstants.js   — tunable constants + score-field scales
 *   - generalistScoreNormalizers.js — pure normalizers & math helpers
 *   - generalistScoreCalculator.js  — the pure formula core
 *   - generalistScoreAggregation.js — Mongo aggregation + orchestration
 *   - generalistScore.js (this file) — public facade re-exporting the API
 *
 * This facade preserves the exact module.exports surface the rest of the
 * service imports; new code may require the sub-modules directly.
 */

const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');
const {
    COVERAGE_PENALTY_MAX,
    DIFFICULTY_PENALTY_MAX,
    FULL_SCOPE_MIN_LEVEL,
    REQUIRED_PROMPT_LEVELS,
    MIN_FULL_SCOPE_RESULTS,
    MIN_CONSISTENCY_RESULTS,
    CONSISTENCY_BONUS,
    CONSISTENCY_STDDEV_THRESHOLD,
    MIN_QUALITY_FOR_BONUS,
    EVIDENCE_CONFIDENCE_TARGET,
    EVIDENCE_CONFIDENCE_PENALTY_MAX,
    EMPTY_RESPONSE_FILTER_THRESHOLD,
    SCORE_FIELD_SCALES
} = require('./generalistScoreConstants');
const {
    normalizeQualityTo100,
    normalizeScoreTo100,
    normalizeCategoryKey,
    confidenceMargin
} = require('./generalistScoreNormalizers');
const { calculateGeneralistScoreFromCategories } = require('./generalistScoreCalculator');
const {
    getActiveCategoryWeights,
    getCategoryScoresByModel,
    getEmptyResponseRates,
    getLeaderboardEntryStats,
    calculateAllGeneralistScores
} = require('./generalistScoreAggregation');

module.exports = {
    GENERALIST_CATEGORY_WEIGHTS,
    COVERAGE_PENALTY_MAX,
    DIFFICULTY_PENALTY_MAX,
    FULL_SCOPE_MIN_LEVEL,
    REQUIRED_PROMPT_LEVELS,
    MIN_FULL_SCOPE_RESULTS,
    MIN_CONSISTENCY_RESULTS,
    CONSISTENCY_BONUS,
    CONSISTENCY_STDDEV_THRESHOLD,
    MIN_QUALITY_FOR_BONUS,
    EVIDENCE_CONFIDENCE_TARGET,
    EVIDENCE_CONFIDENCE_PENALTY_MAX,
    EMPTY_RESPONSE_FILTER_THRESHOLD,
    SCORE_FIELD_SCALES,
    normalizeQualityTo100,
    normalizeScoreTo100,
    normalizeCategoryKey,
    getActiveCategoryWeights,
    calculateGeneralistScoreFromCategories,
    getCategoryScoresByModel,
    getEmptyResponseRates,
    getLeaderboardEntryStats,
    calculateAllGeneralistScores,
    confidenceMargin
};

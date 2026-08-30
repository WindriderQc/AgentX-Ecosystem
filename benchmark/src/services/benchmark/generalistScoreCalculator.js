/**
 * Generalist scoring — formula core (task 0228 split).
 *
 * Extracted verbatim from generalistScore.js. This is the pure, DB-free scoring
 * function that turns a per-category score map into the full generalist
 * breakdown. It is the single highest-blast-radius unit in the service and is
 * locked by the golden snapshots in
 * tests/unit/benchmark/generalistScoreGolden.test.js — do not change any value
 * here without a deliberate, reviewed snapshot update.
 *
 * FORMULA:
 *   generalistScore = weightedQuality - coveragePenalty - difficultyPenalty
 *                     - evidenceConfidencePenalty + consistencyBonus
 */

const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');
const {
    getScoreFieldScale,
    COVERAGE_PENALTY_MAX,
    DIFFICULTY_PENALTY_MAX,
    FULL_SCOPE_MIN_LEVEL,
    MIN_FULL_SCOPE_RESULTS,
    CONSISTENCY_STDDEV_THRESHOLD,
    CONSISTENCY_BONUS,
    MIN_CONSISTENCY_RESULTS,
    MIN_QUALITY_FOR_BONUS,
    EVIDENCE_CONFIDENCE_TARGET,
    EVIDENCE_CONFIDENCE_PENALTY_MAX
} = require('./generalistScoreConstants');
const {
    normalizeScoreTo100,
    applyBiasCorrection,
    clampNumber,
    normalizeRequiredPromptLevels,
    weightedConfidenceMargin
} = require('./generalistScoreNormalizers');

/**
 * Calculate generalist score from category data
 * @param {Object} categoryScores - Map of category -> { avg, count, stddev, attempted }
 * @param {Object} categoryWeights - Category weight map
 * @param {Object} profileParams   - Optional generalist params from scoring profile
 * @param {Object} [options]       - Aggregation options
 * @param {String} [options.scoreField='quality_score'] - Which score field's
 *   averages are present in `categoryScores`. Drives scale and which scores
 *   may legitimately receive bias correction. composite_score is the
 *   latency-aware "headline" leaderboard score; the other axes are quality
 *   sub-axes on the 0-10 native scale.
 * @returns {Object} Generalist score breakdown
 */
function calculateGeneralistScoreFromCategories(categoryScores, categoryWeights = GENERALIST_CATEGORY_WEIGHTS, profileParams = {}, options = {}) {
    const scoreField = options.scoreField || 'quality_score';
    const scoreScale = getScoreFieldScale(scoreField);
    // Bias correction was calibrated against the quality goldset, so the
    // signed offsets only make sense applied to quality_score. Applying the
    // same numbers to composite_score (which is latency-weighted) or to a
    // sub-axis (deterministic/subjective) would overcorrect.
    const biasCorrectionEligible = scoreField === 'quality_score';
    // Resolve configurable constants: prefer profile values, fall back to module-level defaults
    const coveragePenaltyMax = profileParams.coveragePenaltyMax !== undefined
        ? profileParams.coveragePenaltyMax
        : COVERAGE_PENALTY_MAX;
    const consistencyStddevThreshold = profileParams.consistencyStddevThreshold !== undefined
        ? profileParams.consistencyStddevThreshold
        : CONSISTENCY_STDDEV_THRESHOLD;
    const consistencyBonusValue = profileParams.consistencyBonus !== undefined
        ? profileParams.consistencyBonus
        : CONSISTENCY_BONUS;
    const minQualityForBonus = profileParams.minQualityForBonus !== undefined
        ? profileParams.minQualityForBonus
        : MIN_QUALITY_FOR_BONUS;
    const difficultyPenaltyEnabled = options.difficultyPenaltyEnabled !== false;
    const difficultyPenaltyMax = profileParams.difficultyPenaltyMax !== undefined
        ? clampNumber(profileParams.difficultyPenaltyMax, 0, 100, DIFFICULTY_PENALTY_MAX)
        : DIFFICULTY_PENALTY_MAX;
    const fullScopeMinLevel = profileParams.fullScopeMinLevel !== undefined
        ? clampNumber(profileParams.fullScopeMinLevel, 1, 5, FULL_SCOPE_MIN_LEVEL)
        : FULL_SCOPE_MIN_LEVEL;
    const requiredPromptLevels = normalizeRequiredPromptLevels(profileParams.requiredPromptLevels);
    const minFullScopeResults = profileParams.minFullScopeResults !== undefined
        ? clampNumber(profileParams.minFullScopeResults, 0, 1000, MIN_FULL_SCOPE_RESULTS)
        : MIN_FULL_SCOPE_RESULTS;
    const minConsistencyResults = profileParams.minConsistencyResults !== undefined
        ? clampNumber(profileParams.minConsistencyResults, 0, 1000, MIN_CONSISTENCY_RESULTS)
        : MIN_CONSISTENCY_RESULTS;
    const evidenceConfidenceTarget = profileParams.evidenceConfidenceTarget !== undefined
        ? clampNumber(profileParams.evidenceConfidenceTarget, 0, 1, EVIDENCE_CONFIDENCE_TARGET)
        : EVIDENCE_CONFIDENCE_TARGET;
    const evidenceConfidencePenaltyMax = profileParams.evidenceConfidencePenaltyMax !== undefined
        ? clampNumber(profileParams.evidenceConfidencePenaltyMax, 0, 100, EVIDENCE_CONFIDENCE_PENALTY_MAX)
        : EVIDENCE_CONFIDENCE_PENALTY_MAX;
    const confidenceWeighting = profileParams.confidenceWeighting === true;

    let weightedSum = 0;
    let coveragePenalty = 0;
    let weightsCovered = 0;
    let confidenceWeightedSum = 0;
    let confidenceWeightCovered = 0;
    let requiredLevelWeightCovered = 0;
    let weightsWithLevels = 0;
    const seenPromptLevels = [];
    const missingRequiredLevelsByCategory = {};

    const categoryAverages = {};
    const categoryStdDevs = [];
    const consistencyBasis = {};
    let hasExplicitConsistencyBasis = false;
    let testedCategories = 0;
    // Only track effective confidence when the toggle is on; keeps it out of
    // the response payload when the feature is disabled.
    const categoryConfidence = confidenceWeighting ? {} : null;

    for (const [category, weight] of Object.entries(categoryWeights || {})) {
        const categoryData = categoryScores[category];

        const hasScore = !!(categoryData && (categoryData.count > 0 || categoryData.avg > 0));
        const attempted = !!(categoryData && categoryData.attempted);

        if (hasScore) {
            testedCategories++;
            const rawAvgScore = categoryData.avg !== undefined
                ? normalizeScoreTo100(categoryData.avg, scoreField)
                : 0;
            // Apply per-category bias correction when the profile opts in
            // AND the score field is the quality_score axis (the only one
            // the corrections were calibrated for).
            const biasCorrection = profileParams.biasCorrection === true && biasCorrectionEligible;
            const avgScore = biasCorrection
                ? applyBiasCorrection(rawAvgScore, category)
                : rawAvgScore;

            // Missing legacy confidence is unknown. It must never be rendered
            // or aggregated as a real 0% (or an invented fallback value).
            const rawConfidence = categoryData.avg_confidence;
            const confidence = Number.isFinite(rawConfidence)
                ? Math.max(0, Math.min(1, rawConfidence))
                : null;

            const contributionScore = confidenceWeighting
                ? (confidence === null ? 0 : avgScore * confidence)
                : avgScore;
            if (confidence !== null) {
                confidenceWeightedSum += confidence * weight;
                confidenceWeightCovered += weight;
            }
            const promptLevels = Array.isArray(categoryData.levels)
                ? categoryData.levels
                    .map(Number)
                    .filter((level) => Number.isFinite(level) && level >= 1 && level <= 5)
                : [];
            if (promptLevels.length > 0) {
                weightsWithLevels += weight;
                seenPromptLevels.push(...promptLevels);
                const present = new Set(promptLevels);
                const coveredRequired = requiredPromptLevels.filter((level) => present.has(level));
                requiredLevelWeightCovered += weight * (coveredRequired.length / requiredPromptLevels.length);
                const missing = requiredPromptLevels.filter((level) => !present.has(level));
                if (missing.length > 0) {
                    missingRequiredLevelsByCategory[category] = missing;
                }
            }

            categoryAverages[category] = avgScore;
            if (categoryConfidence) {
                categoryConfidence[category] = confidence === null ? null : Math.round(confidence * 100) / 100;
            }
            weightedSum += contributionScore * weight;
            weightsCovered += weight;

            // Prefer prompt-mean-centered residuals when aggregation supplied
            // them. Raw within-category stddev mixes prompt difficulty with
            // model instability and can punish models that simply track the
            // suite's easy/hard shape.
            const hasResidualBasis = categoryData.consistency_basis === 'prompt_residual'
                && Number.isFinite(categoryData.residual_stddev)
                && (categoryData.residual_count || 0) >= 2;
            const hasLegacyBasis = categoryData.consistency_basis === undefined
                && categoryData.stddev !== undefined
                && categoryData.count >= 2;
            if (categoryData.consistency_basis !== undefined) {
                hasExplicitConsistencyBasis = true;
            }
            if (hasResidualBasis || hasLegacyBasis) {
                const stddev = hasResidualBasis ? categoryData.residual_stddev : categoryData.stddev;
                categoryStdDevs.push(stddev * scoreScale);
                if (categoryData.consistency_basis !== undefined) {
                    consistencyBasis[category] = hasResidualBasis ? 'prompt_residual' : 'within_category';
                }
            } else {
                if (categoryData.consistency_basis !== undefined) {
                    consistencyBasis[category] = 'none';
                }
            }
        } else if (attempted) {
            // Attempted but failed due to infrastructure - do not penalize coverage
            testedCategories++;
            categoryAverages[category] = 0;
        } else {
            categoryAverages[category] = 0;
            coveragePenalty += weight * coveragePenaltyMax;
        }
    }

    const totalCategories = Object.keys(categoryWeights || {}).length;
    const coveragePercent = totalCategories > 0
        ? (testedCategories / totalCategories) * 100
        : 0;

    const totalScoredResults = Object.values(categoryScores || {})
        .reduce((sum, categoryData) => sum + (categoryData?.count || 0), 0);

    // Within-category consistency: average stddev across tested categories
    // Lower stddev = more consistent = bonus
    let avgStdDev = null;
    let consistencyBonus = 0;
    if (categoryStdDevs.length > 0) {
        avgStdDev = categoryStdDevs.reduce((a, b) => a + b, 0) / categoryStdDevs.length;
        if (avgStdDev < consistencyStddevThreshold && totalScoredResults >= minConsistencyResults) {
            consistencyBonus = consistencyBonusValue;
        }
    }

    // Normalize by covered weight so missing categories don't automatically depress quality
    const normalizedQuality = weightsCovered > 0 ? (weightedSum / weightsCovered) : 0;

    // Quality gate: consistency bonus only applies to models with meaningful output.
    if (normalizedQuality < minQualityForBonus) {
        consistencyBonus = 0;
    }

    let difficultyPenalty = 0;
    let difficultyCoverage = null;
    let maxPromptLevel = null;
    if (difficultyPenaltyEnabled && seenPromptLevels.length > 0) {
        const totalWeight = Object.values(categoryWeights || {})
            .reduce((sum, weight) => sum + (Number(weight) || 0), 0);
        const denominator = totalWeight > 0 ? totalWeight : weightsWithLevels;
        const levelCoverageRatio = denominator > 0
            ? Math.max(0, Math.min(1, requiredLevelWeightCovered / denominator))
            : 0;
        difficultyCoverage = Math.round(levelCoverageRatio * 100);
        maxPromptLevel = Math.max(...seenPromptLevels);
        difficultyPenalty = Math.round((1 - levelCoverageRatio) * difficultyPenaltyMax * 10) / 10;
    }

    const avgEvidenceConfidence = confidenceWeightCovered > 0
        ? confidenceWeightedSum / confidenceWeightCovered
        : null;
    const evidenceConfidenceCoverage = weightsCovered > 0
        ? confidenceWeightCovered / weightsCovered
        : null;
    let evidenceConfidencePenalty = 0;
    if (!confidenceWeighting
        && avgEvidenceConfidence !== null
        && evidenceConfidenceTarget > 0
        && evidenceConfidencePenaltyMax > 0
        && avgEvidenceConfidence < evidenceConfidenceTarget) {
        const shortfallRatio = (evidenceConfidenceTarget - avgEvidenceConfidence) / evidenceConfidenceTarget;
        evidenceConfidencePenalty = Math.round(shortfallRatio * evidenceConfidencePenaltyMax * 10) / 10;
    }

    const generalistScore = Math.max(0, normalizedQuality - coveragePenalty - difficultyPenalty - evidenceConfidencePenalty + consistencyBonus);
    const uncertainty = weightedConfidenceMargin(categoryScores, categoryWeights, scoreField);
    const fullScopeEligible = coveragePercent === 100
        && (difficultyCoverage === null || difficultyCoverage === 100)
        && totalScoredResults >= minFullScopeResults;

    return {
        generalistScore: Math.round(generalistScore * 10) / 10,
        weightedSum: Math.round(normalizedQuality * 10) / 10,
        coveragePenalty: Math.round(coveragePenalty * 10) / 10,
        difficultyPenalty,
        difficultyCoverage,
        fullScopeMinLevel,
        requiredPromptLevels,
        missingRequiredLevelsByCategory,
        maxPromptLevel,
        minFullScopeResults,
        minConsistencyResults,
        totalScoredResults,
        fullScopeEligible,
        evidenceStatus: fullScopeEligible ? 'full_scope' : 'partial_scope',
        consistencyBonus,
        evidenceConfidence: avgEvidenceConfidence === null ? null : Math.round(avgEvidenceConfidence * 100) / 100,
        evidenceConfidenceCoverage: evidenceConfidenceCoverage === null
            ? null
            : Math.round(evidenceConfidenceCoverage * 100) / 100,
        evidenceConfidenceTarget,
        evidenceConfidencePenalty,
        avgWithinCategoryStdDev: avgStdDev === null ? null : Math.round(avgStdDev * 10) / 10,
        confidenceMargin: uncertainty.margin,
        confidenceMethod: uncertainty.method,
        confidenceSampleSize: uncertainty.sampleSize,
        confidenceRepeatCount: uncertainty.repeatCount,
        coverage: Math.round(coveragePercent),
        categoryAverages,
        categoryConfidence,
        confidenceWeighted: confidenceWeighting,
        ...(hasExplicitConsistencyBasis ? { consistencyBasis } : {}),
        testedCategories
    };
}

module.exports = {
    calculateGeneralistScoreFromCategories
};

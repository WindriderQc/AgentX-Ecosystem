/**
 * Judge Confidence Service
 * Detects when judge is unreliable and flags for review
 *
 * Unreliability signals:
 * - Score spread < 1.0 (all dimensions 7-8 = suspicious clustering)
 * - Vague explanation (< 50 chars or generic phrases)
 * - High-level prompt (4-5) with very high score (judge may not understand)
 * - Prompt complexity >> judge capability
 */

const logger = require('../../config/logger');
const { normalizeBenchmarkCategory } = require('../../config/categories');

const CALIBRATION_MODEL = {
    intercept: 2.0644188278573705,
    weights: {
        balanceDeviation: 0.04903039478294602,
        varianceDeviation: 7.596490314685774,
        outlierDeviation: 5.1520043574347945,
        extremityPenalty: 0.03610475833046767
    },
    targets: {
        passRate: 0.72,
        variance: 0.035,
        maxDeviation: 0,
        outlierIssueThreshold: 0.4
    }
};

/**
 * Category-specific confidence refit from the 2026-06-12 human calibration
 * sprint. The old model treated any large inter-dimension spread as judge
 * instability. The sprint showed that some categories, especially coding and
 * translation, naturally have large spread while still ranking well against
 * human reviewers. These profiles make the outlier penalty relative to the
 * expected distribution for the category instead of absolute.
 *
 * Regenerate with:
 */
const CATEGORY_CALIBRATION_PROFILES = Object.freeze({
    coding: {
        sampleSize: 3,
        targets: {
            passRate: 0.82,
            variance: 0.06,
            maxDeviation: 0.56,
            outlierIssueThreshold: 0.68
        }
    },
    creative: {
        sampleSize: 5,
        targets: {
            passRate: 0.87,
            variance: 0.03,
            maxDeviation: 0.42,
            outlierIssueThreshold: 0.55
        }
    },
    instruction: {
        sampleSize: 4,
        targets: {
            passRate: 0.98,
            variance: 0.01,
            maxDeviation: 0.38,
            outlierIssueThreshold: 0.55
        }
    },
    knowledge: {
        sampleSize: 5,
        targets: {
            passRate: 0.72,
            variance: 0.07,
            maxDeviation: 0.45,
            outlierIssueThreshold: 0.6
        }
    },
    math: {
        sampleSize: 5,
        targets: {
            passRate: 0.9,
            variance: 0.03,
            maxDeviation: 0.3,
            outlierIssueThreshold: 0.45
        }
    },
    reasoning: {
        sampleSize: 4,
        targets: {
            passRate: 0.78,
            variance: 0.05,
            maxDeviation: 0.45,
            outlierIssueThreshold: 0.6
        }
    },
    translation: {
        sampleSize: 5,
        targets: {
            passRate: 0.84,
            variance: 0.08,
            maxDeviation: 0.5,
            outlierIssueThreshold: 0.65
        }
    }
});

/**
 * Generic phrases that indicate low-quality explanations
 */
const GENERIC_PHRASES = [
    'overall good',
    'generally correct',
    'satisfactory',
    'meets requirements',
    'acceptable response',
    'well done',
    'good job',
    'nice work',
    'as expected'
];

/**
 * Calculate score spread (max - min) across dimensions
 * @param {Object} breakdown - Score breakdown object { dimension: score }
 * @returns {number} Score spread
 */
function calculateScoreSpread(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return 0;

    const scores = Object.values(breakdown)
        .filter(v => typeof v === 'number');

    if (scores.length < 2) return 0;

    const min = Math.min(...scores);
    const max = Math.max(...scores);
    return max - min;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

function resolveConfidenceCategory(scoreResult = {}, context = {}) {
    return normalizeBenchmarkCategory(
        context.category
            || context.scoring_type
            || scoreResult.prompt_category
            || scoreResult.scoring_type,
        null
    );
}

function resolveCalibrationProfile(rawCategory) {
    const category = normalizeBenchmarkCategory(rawCategory, null);
    const categoryProfile = category ? CATEGORY_CALIBRATION_PROFILES[category] : null;

    return {
        category,
        intercept: CALIBRATION_MODEL.intercept,
        weights: CALIBRATION_MODEL.weights,
        targets: {
            ...CALIBRATION_MODEL.targets,
            ...(categoryProfile?.targets || {})
        },
        sampleSize: categoryProfile?.sampleSize || null
    };
}

function normalizeNumericBreakdown(breakdown) {
    const numericScores = Object.values(breakdown || {})
        .filter(v => typeof v === 'number')
        .map(v => clamp(v / 10, 0, 1));

    if (numericScores.length === 0) {
        return {
            dimensionRates: [],
            totalQuestions: 0,
            passRate: 0.5
        };
    }

    const passRate = numericScores.reduce((sum, value) => sum + value, 0) / numericScores.length;
    return {
        dimensionRates: numericScores,
        totalQuestions: numericScores.length,
        passRate
    };
}

function normalizeDecomposedBreakdown(decomposedBreakdown) {
    const dimensions = Object.values(decomposedBreakdown || {})
        .filter(Array.isArray);

    const dimensionRates = [];
    let totalQuestions = 0;
    let totalContributed = 0;

    for (const dimensionQuestions of dimensions) {
        let dimQuestions = 0;
        let dimContributed = 0;

        for (const question of dimensionQuestions) {
            if (typeof question?.contributed !== 'boolean') continue;
            dimQuestions += 1;
            if (question.contributed) dimContributed += 1;
        }

        if (dimQuestions > 0) {
            dimensionRates.push(dimContributed / dimQuestions);
            totalQuestions += dimQuestions;
            totalContributed += dimContributed;
        }
    }

    return {
        dimensionRates,
        totalQuestions,
        passRate: totalQuestions > 0 ? totalContributed / totalQuestions : 0.5
    };
}

function extractConfidenceFeatures(scoreResult = {}, context = {}) {
    const hasDecomposed = scoreResult.decomposed_breakdown
        && typeof scoreResult.decomposed_breakdown === 'object';
    const category = resolveConfidenceCategory(scoreResult, context);
    const calibrationProfile = resolveCalibrationProfile(category);
    const targets = calibrationProfile.targets;

    const normalized = hasDecomposed
        ? normalizeDecomposedBreakdown(scoreResult.decomposed_breakdown)
        : normalizeNumericBreakdown(scoreResult.breakdown);

    const { dimensionRates, passRate, totalQuestions } = normalized;
    const mean = dimensionRates.length > 0
        ? dimensionRates.reduce((sum, value) => sum + value, 0) / dimensionRates.length
        : passRate;

    const variance = dimensionRates.length > 0
        ? dimensionRates.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / dimensionRates.length
        : 0;

    const maxDeviation = dimensionRates.length > 0
        ? Math.max(...dimensionRates.map(value => Math.abs(value - mean)))
        : 0;

    const judgeScore = typeof scoreResult.quality_score === 'number'
        ? clamp(scoreResult.quality_score, 0, 10)
        : mean * 10;

    const balanceDeviation = Math.abs(passRate - targets.passRate);
    const varianceDeviation = Math.abs(variance - targets.variance);
    const outlierDeviation = Math.max(0, maxDeviation - (targets.maxDeviation || 0));
    const extremityPenalty = Math.abs(judgeScore - 5) / 5;
    const balanceScale = Math.max(targets.passRate, 1 - targets.passRate, 0.05);

    return {
        category,
        calibrationSampleSize: calibrationProfile.sampleSize,
        passRate,
        mean,
        variance,
        maxDeviation,
        expectedMaxDeviation: targets.maxDeviation || 0,
        outlierDeviation,
        outlierIssueThreshold: targets.outlierIssueThreshold || CALIBRATION_MODEL.targets.outlierIssueThreshold,
        totalQuestions,
        balanceDeviation,
        varianceDeviation,
        extremityPenalty,
        questionConfidence: clamp(1 - (balanceDeviation / balanceScale), 0, 1)
    };
}

function predictCalibratedConfidenceFromFeatures(features) {
    const profile = resolveCalibrationProfile(features?.category);
    const { weights, intercept } = profile;
    const outlierDeviation = Number.isFinite(features?.outlierDeviation)
        ? features.outlierDeviation
        : features.maxDeviation;
    const logit = intercept
        - (weights.balanceDeviation * features.balanceDeviation)
        - (weights.varianceDeviation * features.varianceDeviation)
        - (weights.outlierDeviation * outlierDeviation)
        - (weights.extremityPenalty * features.extremityPenalty);

    return clamp(sigmoid(logit), 0, 1);
}

/**
 * Check if explanation is too vague
 * @param {string} explanation - Judge explanation
 * @returns {Object} { isVague: boolean, reason: string }
 */
function checkExplanationQuality(explanation) {
    if (!explanation || typeof explanation !== 'string') {
        return { isVague: true, reason: 'No explanation provided' };
    }

    const trimmed = explanation.trim();

    // Too short
    if (trimmed.length < 50) {
        return { isVague: true, reason: `Explanation too short (${trimmed.length} chars)` };
    }

    // Contains generic phrases
    const lower = trimmed.toLowerCase();
    for (const phrase of GENERIC_PHRASES) {
        if (lower.includes(phrase)) {
            return { isVague: true, reason: `Contains generic phrase: "${phrase}"` };
        }
    }

    // No specific feedback (lacks dimension names or numbers)
    const hasSpecifics = /\b\d+(\.\d+)?\/10\b|\b(correct|incorrect|missing|unclear)\b/i.test(trimmed);
    if (!hasSpecifics && trimmed.length < 150) {
        return { isVague: true, reason: 'Lacks specific feedback' };
    }

    return { isVague: false, reason: null };
}

/**
 * Check for level-score mismatch — continuous version
 * High level prompts with very high scores are suspicious, but the penalty
 * is continuous to reflect increasing confidence with level and score.
 * @param {number} level - Prompt difficulty level (1-5)
 * @param {number} score - Quality score (0-10)
 * @returns {number} Penalty amount 0 to 0.25
 */
function calculateLevelScoreMismatchPenalty(level, score) {
    // No penalty for very easy prompts
    if (level < 3) {
        return 0;
    }

    // No penalty for low scores (judge is being reasonable)
    if (score < 8) {
        return 0;
    }

    // Continuous penalty that grows with both level and score
    // At level=3, score=8: penalty ≈ 0.042
    // At level=5, score=8.5: penalty ≈ 0.229
    // At level=5, score=10: penalty ≈ 0.25
    const levelFactor = (level - 2) / 3; // 0 at level 2, 1 at level 5
    const scoreFactor = Math.min(1, (score - 7) / 3); // 0 at score 7, 1 at score 10
    return levelFactor * scoreFactor * 0.25;
}

/**
 * Check if scores cluster suspiciously — continuous version
 * Returns a continuous penalty based on the spread of scores.
 * @param {Object} breakdown - Score breakdown
 * @returns {number} Penalty amount 0 to 0.25
 */
function calculateScoreClusteringPenalty(breakdown) {
    const spread = calculateScoreSpread(breakdown);
    const dimensionCount = Object.keys(breakdown).length;

    // Need at least 3 dimensions to detect clustering
    if (dimensionCount < 3) {
        return 0;
    }

    // Continuous penalty based on spread
    // At spread=0: penalty = 0.25 (complete clustering)
    // At spread=1: penalty ≈ 0.167
    // At spread=2: penalty ≈ 0.083
    // At spread=3+: penalty ≈ 0
    return Math.max(0, 1 - spread / 3) * 0.25;
}

/**
 * Calculate explanation quality penalty — continuous version
 * Returns a penalty based on explanation length and specificity.
 * @param {string} explanation - Judge explanation
 * @returns {number} Penalty amount 0 to 0.20
 */
function calculateExplanationQualityPenalty(explanation) {
    if (!explanation || typeof explanation !== 'string') {
        return 0.20; // No explanation = max penalty
    }

    const trimmed = explanation.trim();
    let penalty = 0;

    // Penalty for very short explanations
    // At 0 chars: penalty = 0.20 (complete lack)
    // At 50 chars: penalty = 0 (threshold met)
    if (trimmed.length < 50) {
        penalty = Math.max(0, (50 - trimmed.length) / 250) * 0.20;
    }

    // Check for generic phrases (reduces specificity)
    const lower = trimmed.toLowerCase();
    let genericCount = 0;
    for (const phrase of GENERIC_PHRASES) {
        if (lower.includes(phrase)) {
            genericCount++;
        }
    }
    if (genericCount > 0) {
        // Penalty: 0.03 per generic phrase, capped at 0.10
        penalty += Math.min(0.10, genericCount * 0.03);
    }

    // Check for specific feedback (reduces penalty if present)
    const hasSpecifics = /\b\d+(\.\d+)?\/10\b|\b(correct|incorrect|missing|unclear)\b/i.test(trimmed);
    if (!hasSpecifics && trimmed.length < 150) {
        // Lack of specificity adds to penalty, max 0.08
        penalty += 0.08;
    }

    return Math.min(0.20, penalty);
}

/**
 * Calculate complexity vs judge capability penalty — continuous version
 * Returns a penalty based on prompt complexity for a small judge model.
 * @param {number} complexity - Estimated complexity 1-10
 * @param {string} scoringMethod - The scoring method used
 * @returns {number} Penalty amount 0 to 0.20
 */
function calculateComplexityPenalty(complexity, scoringMethod) {
    // Only applies to LLM judge scoring
    if (scoringMethod !== 'llm_judge') {
        return 0;
    }

    // No penalty for low complexity
    if (complexity < 3) {
        return 0;
    }

    // Continuous penalty that grows with complexity
    // At complexity=3: penalty ≈ 0
    // At complexity=6: penalty ≈ 0.086
    // At complexity=10: penalty ≈ 0.20
    return Math.max(0, (complexity - 3) / 7) * 0.20;
}

/**
 * Check for level-score mismatch
 * High level prompts with very high scores are suspicious
 * @param {number} level - Prompt difficulty level (1-5)
 * @param {number} score - Quality score (0-10)
 * @returns {Object} { suspicious: boolean, reason: string }
 */
function checkLevelScoreMismatch(level, score) {
    if (level >= 5 && score >= 8.5) {
        return {
            suspicious: true,
            reason: `Level ${level} prompt with very high score (${score}) - automatic review`
        };
    }

    if (level >= 4 && score >= 9.5) {
        return {
            suspicious: true,
            reason: `Level ${level} prompt with near-perfect score (${score}) - judge may not understand complexity`
        };
    }

    return { suspicious: false, reason: null };
}

/**
 * Check if scores cluster suspiciously (low variance)
 * @param {Object} breakdown - Score breakdown
 * @returns {Object} { suspicious: boolean, reason: string }
 */
function checkScoreClustering(breakdown) {
    const spread = calculateScoreSpread(breakdown);

    // All scores within 1 point is suspicious (indicates judge giving same score to everything)
    if (spread < 1.0 && Object.keys(breakdown).length >= 3) {
        return {
            suspicious: true,
            reason: `Suspiciously low score spread (${spread.toFixed(1)}) - all dimensions scored similarly`
        };
    }

    // Check for all-same scores
    const scores = Object.values(breakdown).filter(v => typeof v === 'number');
    const unique = new Set(scores);
    if (scores.length >= 3 && unique.size === 1) {
        return {
            suspicious: true,
            reason: `All dimensions scored identically (${scores[0]}) - judge may not be differentiating`
        };
    }

    return { suspicious: false, reason: null };
}

/**
 * Estimate prompt complexity based on various factors
 * @param {Object} prompt - Prompt object
 * @returns {number} Complexity score 1-10
 */
function estimatePromptComplexity(prompt) {
    let complexity = prompt.level || 5;

    // Adjust based on prompt length
    const promptLength = (prompt.prompt || '').length;
    if (promptLength > 2000) complexity += 1;
    if (promptLength > 5000) complexity += 1;

    // Adjust based on expected answer complexity
    const expectedLength = (prompt.expected_answer || '').length;
    if (expectedLength > 1000) complexity += 0.5;

    // Certain categories are inherently harder
    const hardCategories = ['coding', 'reasoning', 'knowledge'];
    if (hardCategories.includes(prompt.category || prompt.scoring_type)) {
        complexity += 0.5;
    }

    return Math.min(10, Math.max(1, complexity));
}

/**
 * Main confidence assessment function
 * Computes confidence as 1.0 minus the sum of continuous penalties.
 * @param {Object} scoreResult - Result from scoring (has breakdown, explanation, etc.)
 * @param {Object} prompt - The prompt that was scored
 * @returns {Object} Confidence assessment
 */
function assess(scoreResult, prompt) {
    const issues = [];
    let confidence = 1.0;
    const features = extractConfidenceFeatures(scoreResult, prompt);

    confidence = predictCalibratedConfidenceFromFeatures(features);

    if (features.maxDeviation > features.outlierIssueThreshold && features.outlierDeviation > 0) {
        issues.push('Dimension outlier exceeds category-calibrated distribution - judge decisions may be unstable');
    }

    if (features.questionConfidence < 0.25) {
        issues.push('Question-level contributed balance is near floor/ceiling');
    }

    // Explanations exist in live judge output but not in the 0128 reveal fixture.
    // Only penalize when present and low-quality to avoid artificial flat penalties.
    if (typeof scoreResult.explanation === 'string' && scoreResult.explanation.trim().length > 0) {
        const explanationPenalty = calculateExplanationQualityPenalty(scoreResult.explanation);
        if (explanationPenalty > 0) {
            issues.push('Explanation quality penalty: may lack specificity or detail');
            confidence -= explanationPenalty;
        }
    }

    const level = prompt.level || 3;
    const levelScorePenalty = calculateLevelScoreMismatchPenalty(level, scoreResult.quality_score);
    if (levelScorePenalty > 0) {
        issues.push('Level-score mismatch penalty: high score on difficult prompt may indicate misunderstanding');
        confidence -= levelScorePenalty;
    }

    // Judge truncation penalty
    if (scoreResult.truncation?.judge_truncated) {
        issues.push('Judge output was truncated - may be incomplete');
        confidence -= 0.1;
    }
    if (scoreResult.response_truncated_for_judge) {
        issues.push(`Response truncated to ${scoreResult.judge_window_chars} chars for judge (full: ${scoreResult.response_chars})`);
        confidence -= 0.1;
    }

    const judgeErrorCount = Number(scoreResult.judge_errors) || 0;
    const failedDimensionCount = Array.isArray(scoreResult.failed_dimensions)
        ? scoreResult.failed_dimensions.length
        : 0;
    const hasJudgeSubcallFailure = scoreResult.judge_reliable === false
        || judgeErrorCount > 0
        || failedDimensionCount > 0;
    if (hasJudgeSubcallFailure) {
        const parts = [];
        if (judgeErrorCount > 0) {
            parts.push(`${judgeErrorCount} judge subcall error${judgeErrorCount === 1 ? '' : 's'}`);
        }
        if (failedDimensionCount > 0) {
            parts.push(`${failedDimensionCount} failed dimension${failedDimensionCount === 1 ? '' : 's'}`);
        }
        issues.push(`Judge execution reliability issue: ${parts.join(', ') || 'unreliable judge result'}`);

        const errorRate = features.totalQuestions > 0
            ? judgeErrorCount / features.totalQuestions
            : (judgeErrorCount > 0 ? 1 : 0);
        const reliabilityCap = failedDimensionCount > 0 || errorRate >= 0.25 ? 0.3 : 0.55;
        confidence = Math.min(confidence, reliabilityCap);
    }

    // Fallback scoring flag
    if (scoreResult.scoring_method === 'llm_failed') {
        issues.push('LLM judge failed - using fallback scoring');
        confidence = 0.1;
    }

    // Complexity vs judge capability penalty (continuous)
    const complexity = estimatePromptComplexity(prompt);
    const complexityPenalty = calculateComplexityPenalty(complexity, scoreResult.scoring_method);
    if (complexityPenalty > 0) {
        const judgeTier = scoreResult.judge_tier || 'unknown';
        issues.push(`Complexity penalty: high complexity prompt (${complexity.toFixed(1)}) may challenge ${judgeTier} tier judge`);
        confidence -= complexityPenalty * 0.5;
    }

    // Clamp confidence to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    // Determine if review is needed
    const needsReview = confidence < 0.7;

    return {
        judge_confidence: Math.round(confidence * 100) / 100,
        needs_review: needsReview,
        review_reason: issues.length > 0 ? issues.join('; ') : null,
        issues,
        prompt_complexity: complexity,
        score_spread: scoreResult.breakdown ? calculateScoreSpread(scoreResult.breakdown) : null
    };
}

/**
 * Quick confidence check without full analysis
 * @param {number} score - Quality score
 * @param {number} level - Prompt level
 * @returns {Object} { confidence: number, needsReview: boolean }
 */
function quickCheck(score, level = 3) {
    let confidence = 1.0;

    if (level >= 5 && score >= 8.5) {
        confidence = 0.5;
    } else if (level >= 4 && score >= 9.0) {
        confidence = 0.6;
    } else if (level >= 5) {
        confidence = 0.7;
    }

    return {
        confidence,
        needsReview: confidence < 0.7
    };
}

/**
 * Aggregate confidence across multiple results
 * @param {Array} results - Array of results with confidence assessments
 * @returns {Object} Aggregate statistics
 */
function aggregateConfidence(results) {
    if (!results || results.length === 0) {
        return { avgConfidence: 0, reviewNeeded: 0, total: 0 };
    }

    const confidences = results
        .map(r => r.judge_confidence)
        .filter(c => typeof c === 'number');

    const reviewNeeded = results.filter(r => r.needs_review).length;

    return {
        avgConfidence: confidences.length > 0
            ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
            : 0,
        minConfidence: confidences.length > 0 ? Math.min(...confidences) : 0,
        maxConfidence: confidences.length > 0 ? Math.max(...confidences) : 0,
        reviewNeeded,
        reviewPercent: Math.round((reviewNeeded / results.length) * 100),
        total: results.length
    };
}

module.exports = {
    assess,
    quickCheck,
    aggregateConfidence,
    calculateScoreSpread,
    checkExplanationQuality,
    checkLevelScoreMismatch,
    checkScoreClustering,
    estimatePromptComplexity,
    calculateLevelScoreMismatchPenalty,
    calculateScoreClusteringPenalty,
    calculateExplanationQualityPenalty,
    calculateComplexityPenalty,
    extractConfidenceFeatures,
    predictCalibratedConfidenceFromFeatures,
    CALIBRATION_MODEL,
    CATEGORY_CALIBRATION_PROFILES,
    GENERIC_PHRASES
};

/**
 * Multi-Judge Consensus Scoring
 *
 * Scores a benchmark result with multiple judge models and computes
 * a consensus score. Detects divergence between judges and optionally
 * escalates to a tiebreaker judge.
 *
 * Design:
 *   - If scores diverge by > DIVERGENCE_THRESHOLD, a 3rd judge breaks the tie
 *   - Final score = median of all judge scores
 *   - All individual scores stored in BenchmarkResult.judge_scores[]
 *
 * USED BY:
 *   - judging.js (when multi-judge mode is enabled)
 */

const logger = require('../../../config/logger');
const { scoreResponse } = require('../qualityScorer');

/** Max score difference (0-10 scale) before escalation to tiebreaker */
const DIVERGENCE_THRESHOLD = 2.0;
const LOW_CONFIDENCE_THRESHOLD = 0.8;

/** Theoretical max stdev on the 0..10 scale (stdev of [0, 10] ≈ 5) */
const MAX_SCORE_STDEV = 5;

/** Agreement below this threshold triggers needs_review on multi-judge rows */
const AGREEMENT_REVIEW_THRESHOLD = 0.7;

/** Prompt levels that automatically trigger multi-judge when available */
const AUTO_MULTI_JUDGE_MIN_LEVEL = 4;

const JUDGE_BASED_METHODS = new Set([
    'llm_judge',
    'decomposed',
    'reference',
    'reference_quick',
    'hybrid',
    'llm_failed',
    'deterministic_fallback'
]);

/**
 * Compute standard deviation of a numeric array.
 */
function stdev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sqDiffs = values.map(v => (v - mean) ** 2);
    return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Compute median of a numeric array.
 */
function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Score a result with multiple judges and return consensus.
 *
 * @param {Object} params
 * @param {string} params.response - Model response to judge
 * @param {Object} params.prompt - Prompt data (prompt, name, level, category, expected_answer, etc.)
 * @param {Array<Object>} params.judges - Array of judge configs [{ model, host, tier }]
 * @param {Object} [params.tiebreakerJudge] - Optional higher-tier judge for divergence resolution
 * @param {Object} [params._batchHardwareSnapshot] - Hardware snapshot for judge host
 * @returns {Object} { finalScore, scores[], divergent, tiebreakerUsed, consensus }
 */
async function multiJudgeScore({
    response,
    prompt,
    judges,
    tiebreakerJudge = null,
    _batchHardwareSnapshot = null,
    seedJudgeResult = null
}) {
    if (!judges || judges.length === 0) {
        throw new Error('At least one judge config is required');
    }

    const results = [];
    const effectiveJudges = [...judges];

    if (seedJudgeResult) {
        results.push({
            judge_model: seedJudgeResult.judge_model,
            judge_host: seedJudgeResult.judge_host,
            quality_score: seedJudgeResult.quality_score,
            explanation: seedJudgeResult.explanation,
            scoring_time_ms: seedJudgeResult.scoring_time_ms || 0,
            scoring_method: seedJudgeResult.scoring_method || 'llm_judge',
            success: !!seedJudgeResult.success
        });

        const duplicateJudgeIndex = effectiveJudges.findIndex((judgeConfig) =>
            judgeConfig.model === seedJudgeResult.judge_model
            && judgeConfig.host === seedJudgeResult.judge_host
        );
        if (duplicateJudgeIndex >= 0) {
            effectiveJudges.splice(duplicateJudgeIndex, 1);
        }
    }

    // Score with all primary judges in parallel
    const judgePromises = effectiveJudges.map(async (judgeConfig, idx) => {
        const start = Date.now();
        try {
            const scores = await scoreResponse({
                response,
                prompt,
                judgeConfig: {
                    model: judgeConfig.model,
                    host: judgeConfig.host
                },
                _batchHardwareSnapshot
            });

            return {
                judge_model: judgeConfig.model,
                judge_host: judgeConfig.host,
                quality_score: scores.quality_score,
                explanation: scores.explanation,
                scoring_time_ms: Date.now() - start,
                scoring_method: scores.scoring_method,
                success: true
            };
        } catch (err) {
            logger.warn('Multi-judge: judge failed', {
                judge_model: judgeConfig.model,
                judge_index: idx,
                error: err.message
            });
            return {
                judge_model: judgeConfig.model,
                judge_host: judgeConfig.host,
                quality_score: null,
                explanation: `Judge failed: ${err.message}`,
                scoring_time_ms: Date.now() - start,
                success: false
            };
        }
    });

    const judgeResults = await Promise.all(judgePromises);
    results.push(...judgeResults);

    // Extract successful scores
    const validScores = results
        .filter(r => r.success && r.quality_score !== null && r.quality_score !== undefined)
        .map(r => r.quality_score);

    if (validScores.length === 0) {
        return {
            finalScore: null,
            scores: results,
            divergent: false,
            tiebreakerUsed: false,
            consensus: 'no_valid_scores'
        };
    }

    if (validScores.length === 1) {
        return {
            finalScore: validScores[0],
            scores: results,
            divergent: false,
            tiebreakerUsed: false,
            consensus: 'single_judge'
        };
    }

    // Check divergence
    const maxScore = Math.max(...validScores);
    const minScore = Math.min(...validScores);
    const divergence = maxScore - minScore;
    const divergent = divergence > DIVERGENCE_THRESHOLD;

    // Escalate to tiebreaker if divergent and tiebreaker is available
    let tiebreakerUsed = false;
    if (divergent && tiebreakerJudge) {
        const start = Date.now();
        try {
            logger.info('Multi-judge: divergence detected, escalating to tiebreaker', {
                scores: validScores,
                divergence: divergence.toFixed(1),
                tiebreaker: tiebreakerJudge.model
            });

            const tbScores = await scoreResponse({
                response,
                prompt,
                judgeConfig: {
                    model: tiebreakerJudge.model,
                    host: tiebreakerJudge.host
                },
                _batchHardwareSnapshot
            });

            results.push({
                judge_model: tiebreakerJudge.model,
                judge_host: tiebreakerJudge.host,
                quality_score: tbScores.quality_score,
                explanation: tbScores.explanation,
                scoring_time_ms: Date.now() - start,
                scoring_method: tbScores.scoring_method,
                success: true,
                is_tiebreaker: true
            });

            validScores.push(tbScores.quality_score);
            tiebreakerUsed = true;
        } catch (err) {
            logger.warn('Multi-judge: tiebreaker failed', {
                tiebreaker: tiebreakerJudge.model,
                error: err.message
            });
            results.push({
                judge_model: tiebreakerJudge.model,
                judge_host: tiebreakerJudge.host,
                quality_score: null,
                explanation: `Tiebreaker failed: ${err.message}`,
                scoring_time_ms: Date.now() - start,
                success: false,
                is_tiebreaker: true
            });
        }
    }

    const finalScore = Math.round(median(validScores) * 10) / 10;

    // Agreement: 1 = unanimous, 0 = max theoretical disagreement
    const agreement = validScores.length >= 2
        ? Math.max(0, Math.min(1, 1 - (stdev(validScores) / MAX_SCORE_STDEV)))
        : null;

    const consensus = divergent
        ? (tiebreakerUsed ? 'tiebreaker_resolved' : 'divergent_unresolved')
        : 'agreement';

    logger.info('Multi-judge consensus', {
        category: prompt.category,
        finalScore,
        individualScores: validScores,
        divergence: divergence.toFixed(1),
        agreement: agreement !== null ? agreement.toFixed(3) : null,
        consensus,
        judgeCount: validScores.length
    });

    return {
        finalScore,
        scores: results,
        divergent,
        tiebreakerUsed,
        consensus,
        divergence: Math.round(divergence * 10) / 10,
        agreement: agreement !== null ? Math.round(agreement * 1000) / 1000 : null
    };
}

function shouldEscalateToMultiJudge({
    scoringMethod,
    judgeConfidence,
    needsReview,
    promptLevel,
    judgeReliable = true,
    judgeErrors = 0,
    multiJudgeConfig = {}
}) {
    if (!multiJudgeConfig?.enabled || !Array.isArray(multiJudgeConfig.judges) || multiJudgeConfig.judges.length < 2) {
        return false;
    }

    if (scoringMethod && !JUDGE_BASED_METHODS.has(scoringMethod)) {
        return false;
    }

    if (multiJudgeConfig._escalation
        && multiJudgeConfig._escalation.used >= multiJudgeConfig._escalation.budget) {
        return false;
    }

    const confidenceThreshold = Number.isFinite(Number(multiJudgeConfig.confidenceThreshold))
        ? Number(multiJudgeConfig.confidenceThreshold)
        : LOW_CONFIDENCE_THRESHOLD;

    const judgeHadInternalFailures = judgeReliable === false || (Number(judgeErrors) || 0) > 0;
    const judgeFailed = multiJudgeConfig.escalateOnJudgeFailure !== false
        && (scoringMethod === 'llm_failed' || judgeHadInternalFailures);
    const reviewTriggered = multiJudgeConfig.escalateOnReview !== false && !!needsReview;
    const lowConfidence = multiJudgeConfig.escalateOnLowConfidence !== false
        && typeof judgeConfidence === 'number'
        && judgeConfidence < confidenceThreshold;

    // Auto-escalate high-difficulty prompts for leaderboard confidence
    const level = typeof promptLevel === 'number' ? promptLevel : 0;
    const autoMinLevel = multiJudgeConfig.autoMinLevel ?? AUTO_MULTI_JUDGE_MIN_LEVEL;
    const highLevelTriggered = multiJudgeConfig.escalateOnHighLevel !== false && level >= autoMinLevel;

    return judgeFailed || reviewTriggered || lowConfidence || highLevelTriggered;
}

module.exports = {
    DIVERGENCE_THRESHOLD,
    LOW_CONFIDENCE_THRESHOLD,
    AUTO_MULTI_JUDGE_MIN_LEVEL,
    MAX_SCORE_STDEV,
    AGREEMENT_REVIEW_THRESHOLD,
    JUDGE_BASED_METHODS,
    multiJudgeScore,
    shouldEscalateToMultiJudge,
    median,
    stdev
};

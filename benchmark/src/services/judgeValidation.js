/**
 * Judge Validation Service
 * Comprehensive validation framework for LLM-as-Judge performance
 *
 * Features:
 * - Consistency testing (same input → consistent output)
 * - Ground truth evaluation (compare to expert scores)
 * - Bias detection (model favoritism, length bias, format bias)
 * - Calibration analysis (score distribution, discrimination)
 * - Failure mode analysis
 */

const logger = require('../../config/logger');
const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { scoreResponse, JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('./qualityScorer');
const { resolveJudgeConfig } = require('./scoring/resolveJudgeConfig');
const { normalizeScoringCategory, DEFAULT_SCORING_CATEGORY } = require('./scoring/scoringConfigs');
const { runBiasDetection, runCalibrationAnalysis } = require('./judgeValidationAnalysis');
const { calculatePearsonCorrelation, categorizeFailure, generateFailureRecommendations } = require('./judgeValidationHelpers');

/**
 * Run consistency test on a sample of results
 * Re-judges same responses multiple times to measure score variance
 *
 * @param {Object} options
 * @param {number} options.sampleSize - Number of results to test (default: 10)
 * @param {number} options.repeats - Times to re-judge each result (default: 3)
 * @param {string} options.category - Optional category filter
 * @returns {Promise<Object>} Consistency metrics
 */
async function runConsistencyTest(options = {}) {
    const {
        sampleSize = 10,
        repeats = 3,
        category = null,
        judgeConfig = {}
    } = options;

    logger.info('Starting judge consistency test', { sampleSize, repeats, category });

    // Get random sample of successful results with quality scores
    const matchQuery = {
        success: true,
        quality_score: { $ne: null },
        scoring_method: 'llm_judge',
        response: { $ne: '', $exists: true }
    };

    if (category) {
        matchQuery.prompt_category = category;
    }

    const samples = await BenchmarkResult.aggregate([
        { $match: matchQuery },
        { $sample: { size: sampleSize } }
    ]);

    if (samples.length === 0) {
        return {
            success: false,
            error: 'No suitable samples found for consistency testing',
            samples_found: 0
        };
    }

    const results = [];
    let totalVariance = 0;
    let maxVariance = 0;

    for (const sample of samples) {
        const scores = [];
        const dimensionScores = {};

        // Re-judge multiple times
        for (let i = 0; i < repeats; i++) {
            try {
                // Contract §2.3 (delta 0115 row 19): `scoreResponse` →
                // `routeScoring` derives `_dimensionWeights` from this prompt's
                // `scoring_type` via `getCategoryDimensionWeights`. We pass the
                // normalized category so decomposed gets category-aware weights
                // even when reached from this direct validation entry point.
                const scoreResult = await scoreResponse({
                    response: sample.response,
                    prompt: {
                        prompt: sample.prompt,
                        expected_answer: sample.expected_answer,
                        scoring_type: normalizeScoringCategory(sample.prompt_category, DEFAULT_SCORING_CATEGORY),
                        name: sample.prompt_name
                    },
                    judgeConfig: resolveJudgeConfig(judgeConfig)
                });

                if (scoreResult.quality_score !== null && scoreResult.quality_score !== undefined) {
                    scores.push(scoreResult.quality_score);

                    // Track dimension scores
                    if (scoreResult.breakdown) {
                        for (const [dim, val] of Object.entries(scoreResult.breakdown)) {
                            if (typeof val === 'number') {
                                if (!dimensionScores[dim]) dimensionScores[dim] = [];
                                dimensionScores[dim].push(val);
                            }
                        }
                    }
                }
            } catch (err) {
                logger.warn('Consistency test iteration failed', {
                    sample_id: sample._id,
                    iteration: i,
                    error: err.message
                });
            }
        }

        if (scores.length >= 2) {
            // Calculate variance
            const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
            const stdDev = Math.sqrt(variance);

            // Calculate dimension variances
            const dimensionVariances = {};
            for (const [dim, vals] of Object.entries(dimensionScores)) {
                if (vals.length >= 2) {
                    const dimMean = vals.reduce((a, b) => a + b, 0) / vals.length;
                    const dimVar = vals.reduce((sum, v) => sum + Math.pow(v - dimMean, 2), 0) / vals.length;
                    dimensionVariances[dim] = {
                        mean: Math.round(dimMean * 100) / 100,
                        stdDev: Math.round(Math.sqrt(dimVar) * 100) / 100
                    };
                }
            }

            totalVariance += stdDev;
            maxVariance = Math.max(maxVariance, stdDev);

            results.push({
                result_id: sample._id.toString(),
                prompt_name: sample.prompt_name,
                category: sample.prompt_category,
                original_score: sample.quality_score,
                scores,
                mean: Math.round(mean * 100) / 100,
                stdDev: Math.round(stdDev * 100) / 100,
                range: Math.round((Math.max(...scores) - Math.min(...scores)) * 100) / 100,
                dimension_variances: dimensionVariances
            });
        }
    }

    const avgStdDev = results.length > 0 ? totalVariance / results.length : 0;
    const consistencyScore = Math.max(0, 100 - (avgStdDev * 20)); // 0.5 stdDev = 90 score

    if (results.length === 0) {
        return {
            success: false,
            error: 'Consistency test produced no successful re-judged samples',
            summary: {
                samples_tested: 0,
                repeats_per_sample: repeats,
                avg_std_dev: null,
                max_std_dev: null,
                consistency_score: null,
                pass: false
            },
            details: [],
            thresholds: {
                target_std_dev: 0.5,
                excellent: 0.3,
                acceptable: 0.5,
                poor: 1.0
            }
        };
    }

    return {
        success: true,
        summary: {
            samples_tested: results.length,
            repeats_per_sample: repeats,
            avg_std_dev: Math.round(avgStdDev * 1000) / 1000,
            max_std_dev: Math.round(maxVariance * 1000) / 1000,
            consistency_score: Math.round(consistencyScore * 10) / 10,
            pass: avgStdDev < 0.5 // Target: σ < 0.5 points
        },
        details: results,
        thresholds: {
            target_std_dev: 0.5,
            excellent: 0.3,
            acceptable: 0.5,
            poor: 1.0
        }
    };
}

/**
 * Run ground truth evaluation
 * Compares judge scores against expert-assigned reference scores
 *
 * @param {Object} options
 * @param {string} options.category - Optional category filter
 * @param {number} options.limit - Max entries to evaluate
 * @returns {Promise<Object>} Accuracy metrics
 */
async function runGroundTruthEvaluation(options = {}) {
    const {
        category = null,
        limit = 50,
        judgeConfig = {}
    } = options;

    logger.info('Starting ground truth evaluation', { category, limit });

    // Get ground truth entries
    const queryOptions = { limit, random: true };
    if (category) {
        queryOptions.category = category;
    }

    const groundTruth = await JudgeGroundTruth.getForValidation(queryOptions);

    if (!groundTruth || groundTruth.length === 0) {
        return {
            success: false,
            error: 'No ground truth entries found. Seed the database first.',
            entries_found: 0
        };
    }

    const results = [];
    let totalDeviation = 0;
    let totalSquaredDeviation = 0;

    for (const entry of groundTruth) {
        try {
            // Contract §2.3 (delta 0115 row 19): normalize `scoring_type` so
            // `routeScoring`'s shared `getCategoryDimensionWeights` helper can
            // resolve category-aware dimension weights; `entry.category` comes
            // from `JudgeGroundTruth` and may not be canonical.
            const scoreResult = await scoreResponse({
                response: entry.response,
                prompt: {
                    prompt: entry.prompt,
                    expected_answer: entry.expected_answer,
                    scoring_type: normalizeScoringCategory(entry.category, DEFAULT_SCORING_CATEGORY),
                    name: entry.name,
                    // Pass per-prompt criteria through so calibration exercises
                    // the same specific_criteria dimension as live batches (0197).
                    judge_criteria: Array.isArray(entry.judge_criteria) ? entry.judge_criteria : []
                },
                judgeConfig: resolveJudgeConfig(judgeConfig)
            });

            const judgeScore = scoreResult.quality_score;
            const expertScore = entry.expert_scores.overall;
            const deviation = Math.abs(judgeScore - expertScore);

            totalDeviation += deviation;
            totalSquaredDeviation += deviation * deviation;

            // Record validation in ground truth entry
            const gtDoc = await JudgeGroundTruth.findById(entry._id);
            if (gtDoc) {
                await gtDoc.recordValidation({
                    judge_model: judgeConfig.model || JUDGE_CONFIG.model,
                    judge_score: judgeScore,
                    dimension_scores: scoreResult.breakdown
                });
            }

            results.push({
                name: entry.name,
                category: entry.category,
                difficulty: entry.difficulty,
                expert_score: expertScore,
                judge_score: judgeScore,
                deviation: Math.round(deviation * 100) / 100,
                direction: judgeScore > expertScore ? 'over' : (judgeScore < expertScore ? 'under' : 'exact')
            });
        } catch (err) {
            logger.warn('Ground truth evaluation failed for entry', {
                name: entry.name,
                error: err.message
            });
        }
    }

    if (results.length === 0) {
        return {
            success: false,
            error: 'All evaluations failed',
            entries_attempted: groundTruth.length
        };
    }

    const mae = totalDeviation / results.length;
    const rmse = Math.sqrt(totalSquaredDeviation / results.length);

    // Calculate Pearson correlation
    const expertScores = results.map(r => r.expert_score);
    const judgeScores = results.map(r => r.judge_score);
    const correlation = calculatePearsonCorrelation(expertScores, judgeScores);

    // Score distribution analysis
    const overCount = results.filter(r => r.direction === 'over').length;
    const underCount = results.filter(r => r.direction === 'under').length;
    const exactCount = results.filter(r => r.direction === 'exact').length;

    return {
        success: true,
        summary: {
            entries_evaluated: results.length,
            mean_absolute_error: Math.round(mae * 1000) / 1000,
            rmse: Math.round(rmse * 1000) / 1000,
            pearson_correlation: Math.round(correlation * 1000) / 1000,
            bias_direction: {
                over_scoring: overCount,
                under_scoring: underCount,
                exact: exactCount,
                bias: overCount > underCount ? 'tends_high' : (underCount > overCount ? 'tends_low' : 'balanced')
            },
            accuracy_grade: mae < 0.5 ? 'A' : (mae < 1.0 ? 'B' : (mae < 1.5 ? 'C' : (mae < 2.0 ? 'D' : 'F')))
        },
        details: results,
        thresholds: {
            excellent_mae: 0.5,
            good_mae: 1.0,
            acceptable_mae: 1.5,
            poor_mae: 2.0
        }
    };
}

/**
 * Run failure mode analysis
 * Analyzes when and why judge fails
 *
 * @param {Object} options
 * @returns {Promise<Object>} Failure analysis
 */
async function runFailureModeAnalysis(options = {}) {
    const { days = 30 } = options;

    logger.info('Starting failure mode analysis', { days });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Get all judge results including failures
    const [successResults, failedResults] = await Promise.all([
        BenchmarkResult.countDocuments({
            scoring_method: 'llm_judge',
            timestamp: { $gte: cutoffDate }
        }),
        BenchmarkResult.find({
            scoring_method: 'llm_failed',
            timestamp: { $gte: cutoffDate }
        }).select('prompt_category prompt_level quality_explanation judge_model timestamp')
    ]);

    const totalAttempts = successResults + failedResults.length;
    const failureRate = totalAttempts > 0 ? (failedResults.length / totalAttempts) * 100 : 0;

    // Analyze failure reasons
    const failureReasons = {};
    const failuresByCategory = {};
    const failuresByLevel = {};

    for (const f of failedResults) {
        // Extract reason from explanation
        const reason = categorizeFailure(f.quality_explanation || '');
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;

        // By category
        const cat = f.prompt_category || 'unknown';
        failuresByCategory[cat] = (failuresByCategory[cat] || 0) + 1;

        // By level
        const level = f.prompt_level || 'unknown';
        failuresByLevel[level] = (failuresByLevel[level] || 0) + 1;
    }

    // Get empty response stats
    const emptyResponses = await BenchmarkResult.countDocuments({
        scoring_method: 'empty_response',
        timestamp: { $gte: cutoffDate }
    });

    // Get out-of-range score incidents (logged in quality_explanation)
    const outOfRangeResults = await BenchmarkResult.find({
        scoring_method: 'llm_judge',
        quality_explanation: { $regex: /out.of.range|clamped/i },
        timestamp: { $gte: cutoffDate }
    }).countDocuments();

    return {
        success: true,
        summary: {
            period_days: days,
            total_judge_attempts: totalAttempts,
            successful: successResults,
            failed: failedResults.length,
            failure_rate: Math.round(failureRate * 100) / 100,
            empty_responses: emptyResponses,
            out_of_range_scores: outOfRangeResults
        },
        failure_reasons: failureReasons,
        failures_by_category: failuresByCategory,
        failures_by_level: failuresByLevel,
        health_status: failureRate < 5 ? 'healthy' : (failureRate < 15 ? 'degraded' : 'unhealthy'),
        recommendations: generateFailureRecommendations(failureReasons, failureRate)
    };
}

/**
 * Run comprehensive judge health check
 * Combines all analyses into a single health report
 */
async function runHealthCheck(options = {}) {
    const startTime = Date.now();

    logger.info('Starting comprehensive judge health check');

    const [consistency, calibration, bias, failures] = await Promise.all([
        runConsistencyTest({ sampleSize: 5, repeats: 3, ...options }).catch(err => ({ success: false, error: err.message })),
        runCalibrationAnalysis(options).catch(err => ({ success: false, error: err.message })),
        runBiasDetection({ sampleSize: 50, ...options }).catch(err => ({ success: false, error: err.message })),
        runFailureModeAnalysis(options).catch(err => ({ success: false, error: err.message }))
    ]);

    // Calculate overall health score (0-100)
    let healthScore = 100;
    const issues = [];

    if (consistency.success && consistency.summary) {
        if ((consistency.summary.samples_tested || 0) < 1) {
            healthScore -= 20;
            issues.push('Consistency validation has zero successful samples');
        }
        if (consistency.summary.avg_std_dev > 0.5) {
            healthScore -= 20;
            issues.push('High score variance (inconsistent judging)');
        } else if (consistency.summary.avg_std_dev > 0.3) {
            healthScore -= 10;
            issues.push('Moderate score variance');
        }
    } else {
        healthScore -= 10;
        issues.push('Consistency test failed');
    }

    if (calibration.success && calibration.summary) {
        if (calibration.summary.clustering_score < 50) {
            healthScore -= 15;
            issues.push('Poor score distribution (clustering)');
        }
        if (!calibration.summary.discrimination_ok) {
            healthScore -= 15;
            issues.push('Poor difficulty discrimination');
        }
    } else {
        healthScore -= 10;
        issues.push('Calibration analysis failed');
    }

    if (bias.success && bias.summary) {
        if (bias.summary.length_bias_detected) {
            healthScore -= 10;
            issues.push('Length bias detected');
        }
    }

    if (failures.success && failures.summary) {
        if (failures.summary.failure_rate > 15) {
            healthScore -= 20;
            issues.push('High failure rate');
        } else if (failures.summary.failure_rate > 5) {
            healthScore -= 10;
            issues.push('Moderate failure rate');
        }
    } else {
        healthScore -= 10;
        issues.push('Failure analysis failed');
    }

    const status = healthScore >= 80 ? 'healthy' : (healthScore >= 60 ? 'degraded' : 'unhealthy');

    return {
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        overall: {
            health_score: Math.max(0, healthScore),
            status,
            issues
        },
        consistency: consistency.success ? consistency.summary : { error: consistency.error },
        calibration: calibration.success ? calibration.summary : { error: calibration.error },
        bias: bias.success ? bias.summary : { error: bias.error },
        failures: failures.success ? failures.summary : { error: failures.error }
    };
}

module.exports = {
    runConsistencyTest,
    runGroundTruthEvaluation,
    runBiasDetection,
    runCalibrationAnalysis,
    runFailureModeAnalysis,
    runHealthCheck
};

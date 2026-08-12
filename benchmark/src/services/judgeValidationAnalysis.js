'use strict';
/**
 * Judge Validation — Bias Detection & Calibration Analysis
 *
 * Extracted from judgeValidation.js to keep service files within 600-line limit.
 *
 * Exports:
 *   runBiasDetection(options)      — model favoritism, length bias, format bias
 *   runCalibrationAnalysis(options) — score distribution, discrimination, clustering
 */

const logger = require('../../config/logger');
const BenchmarkResult = require('../../models/BenchmarkResult');
const {
    calculateStdDev,
    calculateMedian,
    calculateSkewness,
    calculateClusteringScore,
    getCalibrationGrade,
    generateBiasRecommendations
} = require('./judgeValidationHelpers');

/**
 * Run bias detection tests.
 * Checks for model favoritism, length bias, and format bias.
 *
 * @param {Object} options
 * @param {number} options.sampleSize - Number of results to analyse (default: 100)
 * @returns {Promise<Object>} Bias analysis results
 */
async function runBiasDetection(options = {}) {
    const { sampleSize = 100 } = options;

    logger.info('Starting bias detection analysis', { sampleSize });

    const results = await BenchmarkResult.aggregate([
        {
            $match: {
                success: true,
                quality_score: { $ne: null },
                scoring_method: 'llm_judge'
            }
        },
        { $sample: { size: sampleSize } }
    ]);

    if (results.length < 20) {
        return {
            success: false,
            error: 'Insufficient data for bias analysis',
            samples_found: results.length
        };
    }

    // ── Length bias ────────────────────────────────────────────────────────
    const lengthBuckets = {
        short:  { scores: [], threshold: 200 },   // < 200 chars
        medium: { scores: [], threshold: 800 },   // 200–800 chars
        long:   { scores: [], threshold: 2000 },  // 800–2000 chars
        very_long: { scores: [], threshold: Infinity } // > 2000 chars
    };

    for (const r of results) {
        const len = (r.response || '').length;
        if (len < 200)       lengthBuckets.short.scores.push(r.quality_score);
        else if (len < 800)  lengthBuckets.medium.scores.push(r.quality_score);
        else if (len < 2000) lengthBuckets.long.scores.push(r.quality_score);
        else                 lengthBuckets.very_long.scores.push(r.quality_score);
    }

    const lengthBias = {};
    for (const [bucket, data] of Object.entries(lengthBuckets)) {
        if (data.scores.length > 0) {
            lengthBias[bucket] = {
                count: data.scores.length,
                avg_score: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 100) / 100
            };
        }
    }

    // ── Model bias ─────────────────────────────────────────────────────────
    const modelScores = {};
    for (const r of results) {
        const model = r.model || 'unknown';
        if (!modelScores[model]) modelScores[model] = [];
        modelScores[model].push(r.quality_score);
    }

    const modelBias = {};
    for (const [model, scores] of Object.entries(modelScores)) {
        if (scores.length >= 5) {
            modelBias[model] = {
                count: scores.length,
                avg_score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
            };
        }
    }

    // ── Format bias ────────────────────────────────────────────────────────
    const formatAnalysis = {
        has_code_block: { scores: [], count: 0 },
        has_markdown:   { scores: [], count: 0 },
        plain_text:     { scores: [], count: 0 }
    };

    for (const r of results) {
        const response = r.response || '';
        if (response.includes('```')) {
            formatAnalysis.has_code_block.scores.push(r.quality_score);
            formatAnalysis.has_code_block.count++;
        } else if (response.includes('**') || response.includes('##') || response.includes('- ')) {
            formatAnalysis.has_markdown.scores.push(r.quality_score);
            formatAnalysis.has_markdown.count++;
        } else {
            formatAnalysis.plain_text.scores.push(r.quality_score);
            formatAnalysis.plain_text.count++;
        }
    }

    const formatBias = {};
    for (const [format, data] of Object.entries(formatAnalysis)) {
        if (data.scores.length > 0) {
            formatBias[format] = {
                count: data.count,
                avg_score: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 100) / 100
            };
        }
    }

    // ── Category bias ──────────────────────────────────────────────────────
    const categoryScores = {};
    for (const r of results) {
        const cat = r.prompt_category || 'unknown';
        if (!categoryScores[cat]) categoryScores[cat] = [];
        categoryScores[cat].push(r.quality_score);
    }

    const categoryBias = {};
    for (const [cat, scores] of Object.entries(categoryScores)) {
        if (scores.length >= 3) {
            categoryBias[cat] = {
                count: scores.length,
                avg_score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
            };
        }
    }

    // ── Detect significant biases ──────────────────────────────────────────
    const avgScores = Object.values(lengthBias).map(b => b.avg_score);
    const lengthBiasDetected = avgScores.length > 1 &&
        (Math.max(...avgScores) - Math.min(...avgScores) > 1.0);

    return {
        success: true,
        summary: {
            samples_analyzed: results.length,
            length_bias_detected: lengthBiasDetected,
            length_bias_severity: lengthBiasDetected ? 'significant' : 'minimal',
            models_analyzed: Object.keys(modelBias).length
        },
        length_bias: lengthBias,
        model_bias: modelBias,
        format_bias: formatBias,
        category_bias: categoryBias,
        recommendations: generateBiasRecommendations(lengthBias, formatBias)
    };
}

/**
 * Run calibration analysis.
 * Checks if scores are well-distributed and meaningful.
 *
 * @param {Object} options
 * @param {number} options.days - Look-back window in days (default: 30)
 * @returns {Promise<Object>} Calibration metrics
 */
async function runCalibrationAnalysis(options = {}) {
    const { days = 30 } = options;

    logger.info('Starting calibration analysis', { days });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const results = await BenchmarkResult.find({
        success: true,
        quality_score: { $ne: null },
        scoring_method: 'llm_judge',
        timestamp: { $gte: cutoffDate }
    }).select('quality_score prompt_category prompt_level');

    if (results.length < 50) {
        return {
            success: false,
            error: 'Insufficient data for calibration analysis',
            samples_found: results.length
        };
    }

    const scores = results.map(r => r.quality_score);

    // Score distribution histogram (0–10 in 0.5 increments)
    const histogram = {};
    for (let i = 0; i <= 20; i++) {
        histogram[i / 2] = 0;
    }
    for (const score of scores) {
        const bucket = Math.round(score * 2) / 2;
        histogram[bucket] = (histogram[bucket] || 0) + 1;
    }

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const stdDev = calculateStdDev(scores);
    const median = calculateMedian(scores);
    const skewness = calculateSkewness(scores, mean, stdDev);
    const clusteringScore = calculateClusteringScore(histogram, scores.length);

    // Discrimination analysis (can the judge distinguish difficulty levels?)
    const levelScores = {};
    for (const r of results) {
        const level = r.prompt_level || 'unknown';
        if (!levelScores[level]) levelScores[level] = [];
        levelScores[level].push(r.quality_score);
    }

    const levelAvgs = {};
    for (const [level, lvlScores] of Object.entries(levelScores)) {
        if (lvlScores.length >= 5) {
            levelAvgs[level] = Math.round((lvlScores.reduce((a, b) => a + b, 0) / lvlScores.length) * 100) / 100;
        }
    }

    const levels = Object.keys(levelAvgs).filter(l => !isNaN(parseInt(l))).map(l => parseInt(l)).sort((a, b) => a - b);
    let discriminationOk = true;
    for (let i = 1; i < levels.length; i++) {
        if (levelAvgs[levels[i]] > levelAvgs[levels[i - 1]] + 0.5) {
            discriminationOk = false;
            break;
        }
    }

    return {
        success: true,
        summary: {
            samples_analyzed: scores.length,
            mean: Math.round(mean * 100) / 100,
            median: Math.round(median * 100) / 100,
            std_dev: Math.round(stdDev * 100) / 100,
            skewness: Math.round(skewness * 100) / 100,
            clustering_score: clusteringScore,
            discrimination_ok: discriminationOk,
            calibration_grade: getCalibrationGrade(clusteringScore, stdDev, discriminationOk)
        },
        histogram,
        level_discrimination: levelAvgs,
        interpretation: {
            skewness: skewness > 0.5 ? 'right-skewed (tends high)' : (skewness < -0.5 ? 'left-skewed (tends low)' : 'approximately symmetric'),
            spread: stdDev > 2 ? 'good spread' : (stdDev > 1 ? 'moderate spread' : 'narrow spread (potential issue)'),
            clustering: clusteringScore > 70 ? 'well distributed' : (clusteringScore > 50 ? 'some clustering' : 'significant clustering (scores bunch together)')
        }
    };
}

module.exports = { runBiasDetection, runCalibrationAnalysis };

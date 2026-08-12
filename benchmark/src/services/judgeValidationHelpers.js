'use strict';
/**
 * Judge Validation — Pure Statistical Helpers
 *
 * Stateless math/classification utilities used by judgeValidation.js
 * and judgeValidationAnalysis.js.
 *
 * Exports:
 *   calculatePearsonCorrelation  — Pearson r between two arrays
 *   calculateStdDev              — population standard deviation
 *   calculateMedian              — median value of array
 *   calculateSkewness            — Fisher–Pearson skewness coefficient
 *   calculateClusteringScore     — histogram spread score (0–100)
 *   getCalibrationGrade          — letter grade from calibration metrics
 *   categorizeFailure            — classify failure from explanation text
 *   generateBiasRecommendations  — actionable bias fix suggestions
 *   generateFailureRecommendations — actionable failure fix suggestions
 */

// ── Statistical calculations ───────────────────────────────────────────────

function calculatePearsonCorrelation(x, y) {
    if (x.length !== y.length || x.length < 2) return 0;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
}

function calculateStdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

function calculateMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calculateSkewness(arr, mean, stdDev) {
    if (arr.length === 0 || stdDev === 0) return 0;
    const n = arr.length;
    const sum = arr.reduce((acc, val) => acc + Math.pow((val - mean) / stdDev, 3), 0);
    return sum / n;
}

function calculateClusteringScore(histogram, total) {
    // Higher score = better distribution.
    // Check how many buckets have reasonable counts.
    const buckets = Object.values(histogram).filter(v => v > 0);
    const expectedPerBucket = total / 21; // 21 buckets (0, 0.5, 1, … 10)

    let score = 0;
    for (const count of buckets) {
        const ratio = count / expectedPerBucket;
        if (ratio > 0 && ratio < 3) {
            score += 10;
        } else if (ratio >= 3) {
            score += 5; // credit for data, penalise clustering
        }
    }

    return Math.min(100, score);
}

// ── Grading / classification ───────────────────────────────────────────────

function getCalibrationGrade(clusteringScore, stdDev, discriminationOk) {
    let grade = 'A';

    if (clusteringScore < 50) grade = 'C';
    else if (clusteringScore < 70) grade = 'B';

    if (stdDev < 1) {
        grade = grade === 'A' ? 'B' : (grade === 'B' ? 'C' : 'D');
    }

    if (!discriminationOk) {
        grade = grade === 'A' ? 'B' : (grade === 'B' ? 'C' : 'D');
    }

    return grade;
}

function categorizeFailure(explanation) {
    const exp = explanation.toLowerCase();
    if (exp.includes('timeout') || exp.includes('timed out')) return 'timeout';
    if (exp.includes('json') || exp.includes('parse'))          return 'json_parse_error';
    if (exp.includes('connection') || exp.includes('econnreset')) return 'connection_error';
    if (exp.includes('http') || exp.includes('502') || exp.includes('503')) return 'http_error';
    if (exp.includes('array'))                                   return 'invalid_format';
    if (exp.includes('missing') || exp.includes('numeric'))      return 'missing_scores';
    return 'unknown';
}

// ── Recommendation generators ──────────────────────────────────────────────

function generateBiasRecommendations(lengthBias, formatBias) {
    const recommendations = [];

    const lengths = Object.entries(lengthBias);
    if (lengths.length >= 2) {
        const avgScores = lengths.map(([, data]) => data.avg_score);
        const maxDiff = Math.max(...avgScores) - Math.min(...avgScores);
        if (maxDiff > 1.0) {
            recommendations.push('Consider adding length-normalization to judge prompt');
        }
    }

    const formats = Object.entries(formatBias);
    if (formats.length >= 2) {
        const avgScores = formats.map(([, data]) => data.avg_score);
        const maxDiff = Math.max(...avgScores) - Math.min(...avgScores);
        if (maxDiff > 1.0) {
            recommendations.push('Consider adding format-agnostic evaluation criteria');
        }
    }

    if (recommendations.length === 0) {
        recommendations.push('No significant biases detected');
    }

    return recommendations;
}

function generateFailureRecommendations(failureReasons, failureRate) {
    const recommendations = [];

    if (failureReasons.timeout > 0) {
        recommendations.push('Increase judge timeout or reduce response length');
    }
    if (failureReasons.json_parse_error > 0) {
        recommendations.push('Judge model may need clearer JSON format instructions');
    }
    if (failureReasons.connection_error > 0) {
        recommendations.push('Check network stability to judge host');
    }
    if (failureRate > 10) {
        recommendations.push('Consider using a more reliable judge model');
    }
    if (recommendations.length === 0) {
        recommendations.push('Judge is operating within normal parameters');
    }

    return recommendations;
}

module.exports = {
    calculatePearsonCorrelation,
    calculateStdDev,
    calculateMedian,
    calculateSkewness,
    calculateClusteringScore,
    getCalibrationGrade,
    categorizeFailure,
    generateBiasRecommendations,
    generateFailureRecommendations
};

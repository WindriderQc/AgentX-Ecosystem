/**
 * Generalist scoring — pure normalizers & math helpers (task 0228 split).
 *
 * Extracted verbatim from generalistScore.js. These are stateless, DB-free
 * helpers used by the calculator and the aggregation layer. Keeping them
 * separate keeps the formula core small and independently testable.
 */

const { normalizeBenchmarkCategory } = require('../../../config/categories');
const {
    QUALITY_INPUT_SCALE,
    getScoreFieldScale,
    CATEGORY_BIAS_CORRECTIONS,
    REQUIRED_PROMPT_LEVELS
} = require('./generalistScoreConstants');

/**
 * Apply per-category bias correction to a 0-100 normalized score.
 * Correction is on the 0-10 scale, so multiply by 10 before adding.
 * Result is clamped to [0, 100].
 */
function applyBiasCorrection(scoreOn100, category) {
    const correction10 = CATEGORY_BIAS_CORRECTIONS[category] || 0;
    const corrected = scoreOn100 + correction10 * 10;
    return Math.max(0, Math.min(100, corrected));
}

/**
 * Normalize quality score to 0-100 scale.
 * Quality scores are 0-10 (contract §2.3); leaderboard expects 0-100.
 */
function normalizeQualityTo100(rawQuality) {
    const value = Number(rawQuality);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(10, value)) * QUALITY_INPUT_SCALE;
}

/**
 * Normalize any score field's average to 0-100 based on its native scale.
 * - 0-10 fields (quality/deterministic/subjective) get multiplied by 10
 * - composite_score is already 0-100 and is passed through (clamped)
 */
function normalizeScoreTo100(rawScore, scoreField = 'quality_score') {
    const value = Number(rawScore);
    if (!Number.isFinite(value)) return 0;
    const scale = getScoreFieldScale(scoreField);
    const inputMax = scale === 1 ? 100 : 10;
    return Math.max(0, Math.min(inputMax, value)) * scale;
}

/**
 * Normalize category key into canonical benchmark category naming.
 * Handles legacy aliases and snake_case variants.
 */
function normalizeCategoryKey(rawCategory) {
    return normalizeBenchmarkCategory(rawCategory, null);
}

/**
 * Normalize a weight map so values sum to 1.0 while preserving key order.
 */
function normalizeWeightMap(weights) {
    const entries = Object.entries(weights || {});
    if (entries.length === 0) return {};
    const total = entries.reduce((sum, [, w]) => sum + (Number(w) || 0), 0);
    if (!Number.isFinite(total) || total <= 0) return {};

    const normalized = {};
    for (const [category, weight] of entries) {
        normalized[category] = (Number(weight) || 0) / total;
    }
    return normalized;
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeRequiredPromptLevels(value, fallback = REQUIRED_PROMPT_LEVELS) {
    const raw = Array.isArray(value) && value.length > 0 ? value : fallback;
    const levels = [...new Set(raw
        .map(Number)
        .filter((level) => Number.isFinite(level) && level >= 1 && level <= 5)
        .map((level) => Math.round(level)))]
        .sort((a, b) => a - b);
    return levels.length > 0 ? levels : [...fallback];
}

function countByValue(values) {
    const counts = {};
    for (const value of values || []) {
        if (value === undefined || value === null || value === '') continue;
        const key = String(value);
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

/**
 * Build the category values exposed by the leaderboard API without changing
 * the scoring calculation. The calculator intentionally uses numeric zeroes
 * internally for missing coverage so it can apply the configured penalty, but
 * a zero in the UI reads as a measured score. Only categories with an actual
 * aggregate are therefore numeric in this presentation view.
 *
 * A measured zero remains a real score when it has result rows. Attempted
 * categories whose judge/infrastructure evidence never produced a score stay
 * distinct from categories that were never run, while both render unavailable.
 */
function buildCategoryEvidenceView(categoryScores, calculatedAverages, categoryWeights) {
    const categoryAverages = {};
    const categoryEvidence = {};

    for (const category of Object.keys(categoryWeights || {})) {
        const categoryData = categoryScores?.[category];
        const rawAverage = categoryData?.avg;
        const hasNumericAverage = rawAverage !== null
            && rawAverage !== undefined
            && Number.isFinite(Number(rawAverage));
        const hasScoredRows = hasNumericAverage
            && ((Number(categoryData?.count) || 0) > 0 || Number(rawAverage) > 0);
        const calculated = calculatedAverages?.[category];

        categoryAverages[category] = hasScoredRows && Number.isFinite(Number(calculated))
            ? Number(calculated)
            : null;
        categoryEvidence[category] = hasScoredRows
            ? 'scored'
            : categoryData?.attempted
                ? 'attempted_unscored'
                : 'untested';
    }

    return { categoryAverages, categoryEvidence };
}

/**
 * Calculate 95% confidence interval half-width for a score.
 * Uses t-distribution approximation for small samples.
 * @param {number} stddev - Standard deviation (0-100 scale)
 * @param {number} n - Sample size
 * @returns {number} Margin of error (half-width of 95% CI)
 */
function confidenceMargin(stddev, n) {
    if (!n || n < 2 || !Number.isFinite(stddev)) return null;
    // t-value approximation for 95% CI with small samples
    const tValues = { 2: 12.71, 3: 4.30, 4: 3.18, 5: 2.78, 6: 2.57, 7: 2.45, 8: 2.36, 9: 2.31, 10: 2.26 };
    const t = n <= 10 ? (tValues[n] || 2.26) : (n <= 30 ? 2.04 : 1.96);
    return Math.round((t * stddev / Math.sqrt(n)) * 10) / 10;
}

function tCritical95(degreesOfFreedom) {
    const df = Math.max(1, Math.floor(Number(degreesOfFreedom) || 1));
    const table = [
        12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
        2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
        2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
    ];
    return df <= table.length ? table[df - 1] : (df <= 60 ? 2.0 : 1.96);
}

/**
 * Weighted 95% uncertainty for the same covered-category mean used by UGRank.
 *
 * Each category contributes dispersion across independent prompt means. Repeat
 * attempts are averaged inside each prompt before this value reaches the
 * calculator, so repetitions improve a prompt estimate without pretending to
 * be additional fixtures. The category contributions are combined using the
 * configured weights and Welch-Satterthwaite effective degrees of freedom.
 */
function weightedConfidenceMargin(categoryScores, categoryWeights, scoreField = 'quality_score') {
    const measured = [];
    let coveredWeight = 0;
    for (const [category, rawWeight] of Object.entries(categoryWeights || {})) {
        const data = categoryScores?.[category];
        const weight = Number(rawWeight) || 0;
        const hasScore = !!(data && (Number(data.count) > 0 || Number(data.avg) > 0));
        if (!hasScore || weight <= 0) continue;
        measured.push({ data, weight });
        coveredWeight += weight;
    }
    if (measured.length === 0 || coveredWeight <= 0) {
        return { margin: null, sampleSize: 0, repeatCount: 0, method: null };
    }

    const scale = getScoreFieldScale(scoreField);
    const components = [];
    let sampleSize = 0;
    let repeatCount = 0;
    for (const { data, weight } of measured) {
        const n = Number(data.uncertainty_count);
        const stddev = Number(data.uncertainty_stddev);
        if (!Number.isFinite(n) || n < 2 || !Number.isFinite(stddev)) {
            return { margin: null, sampleSize: 0, repeatCount: 0, method: null };
        }
        const normalizedWeight = weight / coveredWeight;
        const standardDeviation100 = stddev * scale;
        const varianceComponent = (normalizedWeight ** 2) * (standardDeviation100 ** 2) / n;
        components.push({ varianceComponent, degreesOfFreedom: n - 1 });
        sampleSize += n;
        repeatCount += Number(data.repeat_count || data.count || 0);
    }

    const variance = components.reduce((sum, item) => sum + item.varianceComponent, 0);
    const denominator = components.reduce((sum, item) => (
        sum + ((item.varianceComponent ** 2) / item.degreesOfFreedom)
    ), 0);
    const effectiveDf = variance === 0
        ? components.reduce((sum, item) => sum + item.degreesOfFreedom, 0)
        : (variance ** 2) / denominator;
    const margin = tCritical95(effectiveDf) * Math.sqrt(variance);

    return {
        margin: Math.round(margin * 10) / 10,
        sampleSize,
        repeatCount,
        method: 'weighted_category_prompt_means_t95'
    };
}

module.exports = {
    applyBiasCorrection,
    normalizeQualityTo100,
    normalizeScoreTo100,
    normalizeCategoryKey,
    normalizeWeightMap,
    clampNumber,
    normalizeRequiredPromptLevels,
    countByValue,
    buildCategoryEvidenceView,
    confidenceMargin,
    weightedConfidenceMargin
};

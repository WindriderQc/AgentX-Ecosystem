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

module.exports = {
    applyBiasCorrection,
    normalizeQualityTo100,
    normalizeScoreTo100,
    normalizeCategoryKey,
    normalizeWeightMap,
    clampNumber,
    normalizeRequiredPromptLevels,
    countByValue,
    confidenceMargin
};

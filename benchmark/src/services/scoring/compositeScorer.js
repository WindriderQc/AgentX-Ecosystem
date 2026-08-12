/**
 * Composite Scorer
 * Combines quality, latency, and speed into a single composite score
 */

const logger = require('../../../config/logger');
const { CATEGORY_COMPOSITE_PROFILES, DEFAULT_SCORING_CATEGORY } = require('./scoringConfigs');

// LEGACY_PROFILES removed (contract §2.9, §3 row 12 — delta 0113).
// `CATEGORY_COMPOSITE_PROFILES` is the sole authority for composite weights.
// When callers pass an unresolvable profile/category name, we now fall back to
// `DEFAULT_SCORING_CATEGORY` with a warning instead of silently reviving the
// 'interactive' weight table.

/**
 * Calculate composite score combining speed and quality
 * @param {Object} metrics - Performance and quality metrics
 * @param {String} category - Category name (resolvable key of CATEGORY_COMPOSITE_PROFILES)
 * @returns {Object} Composite scores
 */
function calculateCompositeScore(metrics, category) {
    const performanceBaseline = metrics?.performance_baseline || null;
    let latency = metrics?.calibrated_latency_ms ?? performanceBaseline?.latencyMs ?? metrics?.latency;
    let tokens_per_sec = metrics?.calibrated_tokens_per_sec ?? performanceBaseline?.tokensPerSec ?? metrics?.tokens_per_sec;
    let time_to_first_token_ms = metrics?.time_to_first_token_ms ?? metrics?.benchmark_ttft_ms ?? metrics?.ttft_ms ?? metrics?.ttft;
    let { quality_score } = metrics;

    // A missing or invalid latency is UNKNOWN, not instant — it must never
    // earn the perfect responsiveness score that latency=0 used to imply.
    // Treated like missing TTFT: null, excluded, weights renormalized below.
    latency = Number(latency);
    if (!Number.isFinite(latency) || latency <= 0) latency = null;

    tokens_per_sec = parseFloat(tokens_per_sec);
    if (isNaN(tokens_per_sec)) tokens_per_sec = 0;

    time_to_first_token_ms = Number(time_to_first_token_ms);
    if (!Number.isFinite(time_to_first_token_ms) || time_to_first_token_ms <= 0) {
        time_to_first_token_ms = null;
    }

    quality_score = Number(quality_score);
    if (isNaN(quality_score)) quality_score = 0;

    let config;
    let profileUsed;
    let resolvedCategory = category;

    if (category && CATEGORY_COMPOSITE_PROFILES[category]) {
        config = CATEGORY_COMPOSITE_PROFILES[category];
        profileUsed = `category:${category}`;
    } else {
        // Contract §2.9 (delta 0113): no legacy profile fallback. Callers must
        // supply a resolvable category; otherwise default to knowledge and warn.
        resolvedCategory = DEFAULT_SCORING_CATEGORY;
        config = CATEGORY_COMPOSITE_PROFILES[DEFAULT_SCORING_CATEGORY];
        profileUsed = `category:${DEFAULT_SCORING_CATEGORY}`;
        logger.warn('calculateCompositeScore called without resolvable category; defaulting', {
            received: category,
            defaulted_to: DEFAULT_SCORING_CATEGORY
        });
    }

    const weights = config.weights;
    const ttftCap = Number(config.ttftCap) || 4000;

    // Missing/invalid latency must NOT score as instant. The old `latency <= 0
    // → 100` coerced unrecorded latency into a perfect responsiveness score,
    // silently inflating composites. Treat it as absent and renormalize below.
    let latencyScore = null;
    const latencyMissing = !Number.isFinite(Number(latency)) || latency <= 0;
    if (!latencyMissing) {
        if (latency >= config.latencyCap) {
            latencyScore = 0;
            logger.debug('Latency exceeds cap', { latency, cap: config.latencyCap });
        } else {
            latencyScore = 100 - ((latency / config.latencyCap) * 100);
        }
        latencyScore = Math.max(0, latencyScore);
    } else {
        logger.debug('Latency missing/invalid — excluded from composite (renormalized)', { latency });
    }

    let ttftScore = null;
    if (time_to_first_token_ms != null) {
        if (time_to_first_token_ms >= ttftCap) {
            ttftScore = 0;
            logger.debug('TTFT exceeds cap', { ttft: time_to_first_token_ms, cap: ttftCap });
        } else {
            ttftScore = 100 - ((time_to_first_token_ms / ttftCap) * 100);
        }
        ttftScore = Math.max(0, ttftScore);
    }

    // Responsiveness from whichever signals exist; null when neither does.
    let responsivenessScore;
    if (!latencyMissing && ttftScore != null) {
        responsivenessScore = (latencyScore * 0.65) + (ttftScore * 0.35);
    } else if (!latencyMissing) {
        responsivenessScore = latencyScore;
    } else if (ttftScore != null) {
        responsivenessScore = ttftScore;
    } else {
        responsivenessScore = null;
    }

    let speedScore;
    if (tokens_per_sec <= 0) {
        speedScore = 0;
    } else if (tokens_per_sec >= 100) {
        speedScore = 100;
    } else {
        speedScore = tokens_per_sec;
    }

    const qualityScore = Math.max(0, Math.min(100, (quality_score || 0) * 10));

    let composite;
    if (responsivenessScore == null) {
        // No latency signal at all — renormalize over the remaining weights
        // instead of granting the latency weight to a fictitious perfect score.
        const remainingWeight = weights.quality + weights.speed;
        composite = remainingWeight > 0
            ? (qualityScore * weights.quality + speedScore * weights.speed) / remainingWeight
            : 0;
    } else {
        composite = (
            qualityScore * weights.quality +
            responsivenessScore * weights.latency +
            speedScore * weights.speed
        );
    }

    // Quality floor: fast garbage is still garbage (contract §2.9, delta 0113).
    // When quality_score < 3, composite is capped at quality_score * 10 so a
    // 0.4/10 answer cannot earn >40/100 by being fast. The pre-existing
    // `quality_score === 0 → composite = 0` behavior is preserved as the
    // special case of this floor (0 * 10 = 0).
    if (quality_score < 3) {
        composite = quality_score * 10;
    }

    return {
        composite_score: Math.round(composite * 10) / 10,
        normalized: {
            quality: Math.round(qualityScore * 10) / 10,
            latency: latencyScore != null ? Math.round(latencyScore * 10) / 10 : null,
            ttft: ttftScore != null ? Math.round(ttftScore * 10) / 10 : null,
            responsiveness: responsivenessScore != null ? Math.round(responsivenessScore * 10) / 10 : null,
            speed: Math.round(speedScore * 10) / 10
        },
        weights,
        profile: resolvedCategory,
        composite_profile_used: profileUsed
    };
}

module.exports = { calculateCompositeScore };

/**
 * Centralized Judge Config Resolution
 *
 * Single source of truth for merging judge configuration from multiple layers:
 *   1. JUDGE_CONFIG defaults (lowest priority)
 *   2. Per-result saved config (re-judging from courthouse)
 *   3. Caller/batch overrides (highest priority)
 *
 * @module services/scoring/resolveJudgeConfig
 */

const { JUDGE_CONFIG, normalizeJudgeHost } = require('./judgeCall');

/**
 * Resolve a fully-merged judge configuration.
 *
 * @param {Object} [overrides={}] - Caller-supplied config (batch-level or per-request)
 * @param {Object} [options]
 * @param {Object} [options.resultDefaults] - Per-result fallback (e.g. { judge_model, judge_host })
 * @returns {Object} Fully resolved judge config with normalized host
 */
function resolveJudgeConfig(overrides = {}, { resultDefaults = null } = {}) {
    const resolved = { ...JUDGE_CONFIG };

    // Layer 2: per-result saved config (used during re-judging / retro-calibration)
    if (resultDefaults) {
        if (resultDefaults.judge_model) resolved.model = resultDefaults.judge_model;
        if (resultDefaults.judge_host) resolved.host = resultDefaults.judge_host;
    }

    // Layer 3: caller/batch overrides (highest priority)
    // Only copy defined, non-null keys to avoid accidentally nuking defaults
    for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined && value !== null) {
            resolved[key] = value;
        }
    }

    // Post-merge normalization
    resolved.host = normalizeJudgeHost(resolved.host);

    return resolved;
}

module.exports = { resolveJudgeConfig };

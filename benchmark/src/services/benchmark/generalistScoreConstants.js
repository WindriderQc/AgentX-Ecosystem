/**
 * Generalist scoring — constants & scale config (task 0228 split).
 *
 * Extracted verbatim from generalistScore.js. This module holds ONLY the tunable
 * constants and the score-field scale lookup. No DB access, no formula logic.
 * generalistScore.js re-exports the public subset of these so the external API
 * is unchanged.
 *
 * Documentation: docs/operations/GENERALIST_SCORING_SYSTEM.md
 */

// Quality-axis scores (quality_score, deterministic_score, subjective_score)
// are 0..10 per scoring-contract-v1 §2.3; leaderboard normalises to 0..100.
// composite_score is already 0..100 per BenchmarkResult schema, so its scale
// is 1. SCORE_FIELD_SCALES is the only place these factors are encoded — when
// adding a new score field, add an entry here.
const QUALITY_INPUT_SCALE = 10;
const SCORE_FIELD_SCALES = {
    quality_score: 10,
    deterministic_score: 10,
    subjective_score: 10,
    composite_score: 1
};
const GENERALIST_AGGREGATION_OPTIONS = Object.freeze({
    allowDiskUse: true,
    maxTimeMS: 15000
});

function getScoreFieldScale(scoreField) {
    return SCORE_FIELD_SCALES[scoreField] || QUALITY_INPUT_SCALE;
}

/**
 * COVERAGE PENALTY
 *
 * Models lose points for each category they haven't tested.
 * Penalty = categoryWeight × COVERAGE_PENALTY_MAX
 *
 * Example: Skipping 'coding' (15% weight) costs 0.15 × 20 = 3 points
 *
 * This prevents gaming by only running easy tests in one category.
 */
const COVERAGE_PENALTY_MAX = 20;

/**
 * DIFFICULTY COVERAGE PENALTY
 *
 * Category coverage alone lets a model tested only on easy L1 prompts avoid
 * penalty if it touched every category. The docs describe coverage as
 * protection against "only running easy tests", so full generalist ranking
 * also requires hard-level coverage across the category mix.
 */
const DIFFICULTY_PENALTY_MAX = 20;
const FULL_SCOPE_MIN_LEVEL = 4;
const REQUIRED_PROMPT_LEVELS = [4, 5];
const MIN_FULL_SCOPE_RESULTS = 28;

/**
 * WITHIN-CATEGORY CONSISTENCY BONUS
 *
 * Measures reliability: does the model produce consistent quality for similar tasks?
 *
 * - Low stddev within a category = reliable/predictable
 * - High stddev = inconsistent/unpredictable
 *
 * If average within-category stddev < threshold, model gets +5 bonus.
 * StdDev is on 0-100 scale (quality scores normalized to 0-100).
 */
const CONSISTENCY_STDDEV_THRESHOLD = 15;
const CONSISTENCY_BONUS = 5;
const MIN_CONSISTENCY_RESULTS = 42;

/** Minimum weighted quality (0-100) required to earn consistency bonus */
const MIN_QUALITY_FOR_BONUS = 10;

/**
 * Evidence confidence penalty
 *
 * Low-confidence judge rows can still be useful, but they should not rank as
 * equally proven evidence. This bounded penalty is separate from optional
 * confidence weighting: the default headline remains quality-first while
 * discounting fragile evidence.
 */
const EVIDENCE_CONFIDENCE_TARGET = 0.75;
const EVIDENCE_CONFIDENCE_PENALTY_MAX = 8;

/**
 * PER-CATEGORY JUDGE BIAS CORRECTION
 *
 * Empirical offset applied to the normalized 0-100 category score to undo
 * the judge's measured signed bias against the goldset. The judge consistently
 * under-scores some categories and over-scores others; without correction,
 * the cross-category aggregate scores reflect judge biases rather than
 * actual model quality.
 *
 * Values are SIGNED (judge - expert) on the 0-10 raw scale, inverted to
 * become a correction. To regenerate: re-run goldset validation per
 * category and aggregate with:
 *   for each entry in category: judge_score - expert_scores.overall
 *   correction = -mean(deviations)  (in 0-10 units)
 *
 * Last regenerated: 2026-05-02 (POST-0197) with 61-entry goldset, judge=qwen2.5:14b
 * after wiring per-prompt judge_criteria into the decomposed judge (1a9a8cf,
 * c046cfe). The criteria injection absorbed most of the prior bias —
 * corrections shrank dramatically (e.g. coding 1.50→0.61, math 1.75→0.47).
 *
 * Recompute when:
 *   - judge model or rubric changes
 *   - goldset is expanded
 *   - decomposed judge weights change (e.g. SPECIFIC_CRITERIA_WEIGHT)
 *
 * To disable: set CATEGORY_BIAS_CORRECTIONS to {} (no-op).
 */
const CATEGORY_BIAS_CORRECTIONS = {
    coding: 0.61,        // n=8 (was 1.50 pre-0197)
    creative: 0.04,      // n=9 — judge near-perfect (was 0.68)
    instruction: 0.43,   // n=9 (was 1.24)
    knowledge: 0.22,     // n=9 (was 1.15)
    math: -1.00,         // n=9 — judge over-scores math via reference scoring's similarity check (re-derived after fixing No-Solution outlier 0bb4d41)
    reasoning: 0.28,     // n=8 (was 0.17 — minor regression)
    translation: -0.62   // n=9 (was -0.80)
};

/**
 * CONFIDENCE WEIGHTING (opt-in, off by default)
 *
 * When enabled via scoring profile, each category's avg quality is multiplied
 * by its avg judge_confidence before contributing to the weighted composite.
 * Null/missing judge_confidence is treated as NULL_CONFIDENCE_FALLBACK to stay
 * conservative. The maintained regression contract lives in
 * tests/unit/benchmark/generalistScore*.test.js.
 */
const NULL_CONFIDENCE_FALLBACK = 0.5;

/** Threshold: models with more than 50% empty responses are filtered from leaderboard */
const EMPTY_RESPONSE_FILTER_THRESHOLD = 0.5;

module.exports = {
    QUALITY_INPUT_SCALE,
    SCORE_FIELD_SCALES,
    GENERALIST_AGGREGATION_OPTIONS,
    getScoreFieldScale,
    COVERAGE_PENALTY_MAX,
    DIFFICULTY_PENALTY_MAX,
    FULL_SCOPE_MIN_LEVEL,
    REQUIRED_PROMPT_LEVELS,
    MIN_FULL_SCOPE_RESULTS,
    CONSISTENCY_STDDEV_THRESHOLD,
    CONSISTENCY_BONUS,
    MIN_CONSISTENCY_RESULTS,
    MIN_QUALITY_FOR_BONUS,
    EVIDENCE_CONFIDENCE_TARGET,
    EVIDENCE_CONFIDENCE_PENALTY_MAX,
    CATEGORY_BIAS_CORRECTIONS,
    NULL_CONFIDENCE_FALLBACK,
    EMPTY_RESPONSE_FILTER_THRESHOLD
};

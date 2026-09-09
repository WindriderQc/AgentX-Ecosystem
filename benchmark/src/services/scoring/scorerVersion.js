/**
 * Scorer Version
 * ==============
 *
 * Single source of truth for the benchmark scoring pipeline identity.
 *
 * Scores are persisted at judging time. Any change to routing, judge prompts,
 * deterministic extractors, or aggregation semantics can change what a stored
 * quality_score means. Historical rows are not rewritten; consumers should
 * filter or label cross-version comparisons instead.
 */

const SCORER_VERSION = '2.5.0';

const SCORER_COMPONENTS = Object.freeze({
    routing: 2,
    generalist: 4,
    judge_prompt: 2,
    judge_parsing: 3,
    confidence: 3,
    judges: 2,
    deterministic: 3,
    composite: 2
});

function versionsComparable(a, b) {
    if (!a || !b) return false;
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    return pa[0] === pb[0] && pa[1] === pb[1];
}

module.exports = {
    SCORER_VERSION,
    SCORER_COMPONENTS,
    versionsComparable
};

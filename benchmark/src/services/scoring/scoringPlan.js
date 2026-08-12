/**
 * Scoring Plan
 * ============
 *
 * Explicit prompt-level scoring strategy. This replaces field-presence
 * inference as routing authority and makes legacy criteria-regex routing
 * visible during migration without letting it happen accidentally.
 */

const PLANS = Object.freeze({
    DETERMINISTIC: 'deterministic',
    CRITERIA: 'criteria',
    REFERENCE: 'reference',
    DECOMPOSED: 'decomposed',
    LLM_JUDGE: 'llm_judge',
    HYBRID: 'hybrid',
    AUTO: 'auto'
});

const VALID_PLANS = new Set(Object.values(PLANS));

const PLAN_REQUIREMENTS = {
    [PLANS.DETERMINISTIC]: (p) => (p?.deterministic_scoring?.type)
        ? null : 'deterministic plan requires deterministic_scoring.type',
    [PLANS.CRITERIA]: (p) => (Array.isArray(p?.judge_criteria) && p.judge_criteria.length > 0 && p.expected_answer)
        ? null : 'criteria plan requires non-empty judge_criteria and expected_answer',
    [PLANS.REFERENCE]: (p) => p?.reference_answer
        ? null : 'reference plan requires reference_answer',
    [PLANS.DECOMPOSED]: () => null,
    [PLANS.LLM_JUDGE]: () => null,
    [PLANS.HYBRID]: (p) => (Array.isArray(p?.judge_criteria) && p.judge_criteria.length > 0 && p.expected_answer)
        ? null : 'hybrid plan requires judge_criteria and expected_answer',
    [PLANS.AUTO]: () => null
};

function validatePlan(prompt) {
    const plan = prompt?.scoring_plan;
    if (plan === undefined || plan === null) {
        return { valid: true, error: null };
    }
    if (!VALID_PLANS.has(plan)) {
        return { valid: false, error: `Unknown scoring_plan '${plan}'` };
    }
    const error = PLAN_REQUIREMENTS[plan](prompt);
    return error ? { valid: false, error } : { valid: true, error: null };
}

function inferLegacyPlan(prompt, categoryStrategies = null) {
    if (prompt?.deterministic_scoring?.type) return PLANS.DETERMINISTIC;
    if (Array.isArray(prompt?.judge_criteria) && prompt.judge_criteria.length > 0 && prompt.expected_answer) {
        return PLANS.CRITERIA;
    }
    if (prompt?.reference_answer) return PLANS.REFERENCE;

    if (categoryStrategies) {
        const category = prompt?.scoring_type || prompt?.category;
        const strategy = categoryStrategies[category];
        if (strategy && (strategy.primary === 'decomposed' || strategy.llm_strategy === 'decomposed')) {
            return PLANS.DECOMPOSED;
        }
    }
    return PLANS.LLM_JUDGE;
}

function resolvePlan(prompt, categoryStrategies = null) {
    const declared = prompt?.scoring_plan;

    if (declared !== undefined && declared !== null) {
        const { valid, error } = validatePlan(prompt);
        if (valid && declared !== PLANS.AUTO) {
            return { plan: declared, source: 'explicit', error: null };
        }
        if (!valid) {
            return { plan: PLANS.LLM_JUDGE, source: 'fallback', error };
        }
    }

    const inferred = inferLegacyPlan(prompt, categoryStrategies);
    if (inferred === PLANS.CRITERIA) {
        return { plan: PLANS.LLM_JUDGE, source: 'inferred', error: null };
    }
    return { plan: inferred, source: declared === PLANS.AUTO ? 'explicit' : 'inferred', error: null };
}

module.exports = {
    PLANS,
    VALID_PLANS,
    validatePlan,
    inferLegacyPlan,
    resolvePlan
};

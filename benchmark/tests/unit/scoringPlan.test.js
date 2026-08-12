const {
    PLANS,
    validatePlan,
    inferLegacyPlan,
    resolvePlan
} = require('../../src/services/scoring/scoringPlan');

describe('scoringPlan', () => {
    test('validates declared deterministic requirements', () => {
        expect(validatePlan({ scoring_plan: PLANS.DETERMINISTIC }).valid).toBe(false);
        expect(validatePlan({
            scoring_plan: PLANS.DETERMINISTIC,
            deterministic_scoring: { type: 'numeric' }
        }).valid).toBe(true);
    });

    test('infers legacy criteria route for migration visibility', () => {
        const plan = inferLegacyPlan({
            judge_criteria: ['must mention Paris'],
            expected_answer: 'Paris'
        });
        expect(plan).toBe(PLANS.CRITERIA);
    });

    test('does not infer criteria route during live scoring', () => {
        const resolved = resolvePlan({
            judge_criteria: ['must mention Paris'],
            expected_answer: 'Paris'
        });
        expect(resolved.plan).toBe(PLANS.LLM_JUDGE);
        expect(resolved.source).toBe('inferred');
    });

    test('invalid explicit plan falls back to llm_judge with an error', () => {
        const resolved = resolvePlan({ scoring_plan: 'nope' });
        expect(resolved.plan).toBe(PLANS.LLM_JUDGE);
        expect(resolved.source).toBe('fallback');
        expect(resolved.error).toMatch(/Unknown scoring_plan/);
    });
});

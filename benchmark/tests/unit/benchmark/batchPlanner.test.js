const { buildExecutionPlan } = require('../../../src/services/benchmark/batchPlanner');

describe('batchPlanner workload summary', () => {
    it('computes matrix-balanced summary when all categories have equal prompt counts', () => {
        const selectedPrompts = [
            { category: 'coding' },
            { category: 'coding' },
            { category: 'reasoning' },
            { category: 'reasoning' }
        ];

        const { plan } = buildExecutionPlan('http://localhost:11434', ['m1', 'm2'], selectedPrompts, {});

        expect(plan.workload_summary).toMatchObject({
            category_count: 2,
            total_category_prompts: 4,
            projected_tests: 8
        });
    });

    it('computes non-balanced summary when category counts differ', () => {
        const selectedPrompts = [
            { category: 'coding' },
            { category: 'coding' },
            { category: 'coding' },
            { category: 'math' }
        ];

        const { plan } = buildExecutionPlan('http://localhost:11434', ['m1'], selectedPrompts, {});

        expect(plan.workload_summary).toMatchObject({
            category_count: 2,
            total_category_prompts: 4,
            projected_tests: 4
        });
    });
});

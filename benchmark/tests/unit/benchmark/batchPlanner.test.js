const { buildExecutionPlan } = require('../../../src/services/benchmark/batchPlanner');

describe('batchPlanner workload summary', () => {
    it('counts every repetition on the exact target host, including the same model on two hosts', () => {
        const { buildOllamaTarget } = require('../../../../shared/benchmarkTargetContract');
        const targets = [buildOllamaTarget('http://a:11434', 'same'), buildOllamaTarget('http://b:11434', 'same')];
        const { plan } = buildExecutionPlan('http://a:11434', ['same', 'same'], [
            { category: 'coding' }, { category: 'math' }, { category: 'math' }
        ], { targets, execution_config: { repeats: 2 }, judge_config: { host: 'http://judge:11434' } });
        expect(plan.exec_hosts).toEqual([
            { exec_host: 'http://a:11434', judge_host: 'http://judge:11434', models: ['same'], tests: 6 },
            { exec_host: 'http://b:11434', judge_host: 'http://judge:11434', models: ['same'], tests: 6 }
        ]);
        expect(plan.categories).toEqual([
            { category: 'math', prompt_count: 2, tests: 8 },
            { category: 'coding', prompt_count: 1, tests: 4 }
        ]);
        expect(plan.workload_summary.projected_tests).toBe(12);
    });

    it('includes repeated tests for legacy single-host callers', () => {
        const { plan } = buildExecutionPlan('http://a:11434', ['m'], [{ category: 'coding' }], {
            execution_config: { repeats: 3 }
        });
        expect(plan.exec_hosts[0].tests).toBe(3);
        expect(plan.categories[0].tests).toBe(3);
        expect(plan.workload_summary.projected_tests).toBe(3);
    });

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

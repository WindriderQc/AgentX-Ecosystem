const {
    HARD_BENCHMARK_DEFAULT_RULE,
    filterJudgeDefaultsForExecutionHost,
    includesHardBenchmarkLevel,
    resolveBatchMultiJudgeInput
} = require('../../../src/services/benchmark/multiJudgeDefaults');

describe('multiJudgeDefaults', () => {
    describe('includesHardBenchmarkLevel', () => {
        it('detects level 4 or higher in numeric or string form', () => {
            expect(includesHardBenchmarkLevel([1, 2, 3])).toBe(false);
            expect(includesHardBenchmarkLevel([1, '4'])).toBe(true);
            expect(includesHardBenchmarkLevel(['5'])).toBe(true);
        });

        it('ignores missing and non-array level input', () => {
            expect(includesHardBenchmarkLevel(undefined)).toBe(false);
            expect(includesHardBenchmarkLevel(null)).toBe(false);
            expect(includesHardBenchmarkLevel('4')).toBe(false);
        });
    });

    describe('resolveBatchMultiJudgeInput', () => {
        it('does not enable multi-judge by default for hard-suite batches', () => {
            expect(resolveBatchMultiJudgeInput([4, 5], undefined)).toBeUndefined();
            expect(resolveBatchMultiJudgeInput([1, '4'], undefined)).toBeUndefined();
            expect(HARD_BENCHMARK_DEFAULT_RULE).toBeUndefined();
        });

        it('does not default easier batches', () => {
            expect(resolveBatchMultiJudgeInput([1, 2, 3], undefined)).toBeUndefined();
        });

        it('preserves an explicit off choice', () => {
            expect(resolveBatchMultiJudgeInput([4, 5], { rule: 'off' })).toEqual({ rule: 'off' });
            expect(resolveBatchMultiJudgeInput([4, 5], { enabled: false })).toEqual({ enabled: false });
        });

        it('preserves an explicit custom rule', () => {
            expect(resolveBatchMultiJudgeInput([4, 5], 'always')).toBe('always');
        });
    });

    describe('filterJudgeDefaultsForExecutionHost', () => {
        it('removes the execution host from automatic judge defaults', () => {
            const defaults = {
                'http://192.0.2.66:11434': 'judge-a',
                'http://192.0.2.12:11434': 'judge-b',
                'http://192.0.2.99:11434': 'judge-c'
            };

            expect(filterJudgeDefaultsForExecutionHost(defaults, 'http://192.0.2.99:11434')).toEqual({
                'http://192.0.2.66:11434': 'judge-a',
                'http://192.0.2.12:11434': 'judge-b'
            });
        });

        it('normalizes host URLs before filtering', () => {
            const defaults = {
                'http://192.0.2.99:11434': 'judge-c',
                'http://192.0.2.12:11434': 'judge-b'
            };

            expect(filterJudgeDefaultsForExecutionHost(defaults, '192.0.2.99:11434')).toEqual({
                'http://192.0.2.12:11434': 'judge-b'
            });
        });
    });
});

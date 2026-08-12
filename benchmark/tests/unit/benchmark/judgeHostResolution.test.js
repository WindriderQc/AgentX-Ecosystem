const { resolveJudgeHost } = require('../../../src/services/benchmark/judgeHostResolution');

describe('resolveJudgeHost', () => {
    it('prefers an explicit judge host override', () => {
        const result = resolveJudgeHost('http://exec-host:11434', {
            host: 'http://judge-host:11434'
        });

        expect(result).toEqual({
            judgeHost: 'http://judge-host:11434',
            effectiveJudgeSameHost: false,
            resolution: 'explicit'
        });
    });

    it('falls back to the execution host when no explicit judge host is provided', () => {
        const result = resolveJudgeHost('http://exec-host:11434', {});

        expect(result).toEqual({
            judgeHost: 'http://exec-host:11434',
            effectiveJudgeSameHost: true,
            resolution: 'execution_host_default'
        });
    });
});

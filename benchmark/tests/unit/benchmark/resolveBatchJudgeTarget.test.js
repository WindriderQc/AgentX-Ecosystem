const core = require('../../../routes/benchmark/core');
const { JUDGE_CONFIG } = require('../../../src/services/scoring/judgeCall');

const { resolveBatchJudgeTarget, lookupHostJudgeDefault } = core;

const FRANK = 'http://192.0.2.99:11434';
const BRUTAL = 'http://192.0.2.12:11434';
const HOST_DEFAULT_JUDGE = 'host-default-judge:14b';
const HOST_DEFAULTS = {
    [FRANK]: HOST_DEFAULT_JUDGE,
    [BRUTAL]: HOST_DEFAULT_JUDGE
};

describe('lookupHostJudgeDefault', () => {
    it('matches by normalized host url (trailing slash / scheme insensitive)', () => {
        expect(lookupHostJudgeDefault(HOST_DEFAULTS, FRANK)).toBe(HOST_DEFAULT_JUDGE);
        expect(lookupHostJudgeDefault(HOST_DEFAULTS, `${FRANK}/`)).toBe(HOST_DEFAULT_JUDGE);
        expect(lookupHostJudgeDefault(HOST_DEFAULTS, '192.0.2.99:11434')).toBe(HOST_DEFAULT_JUDGE);
    });

    it('returns undefined when the host has no recorded default', () => {
        expect(lookupHostJudgeDefault(HOST_DEFAULTS, 'http://10.0.0.1:11434')).toBeUndefined();
        expect(lookupHostJudgeDefault({}, FRANK)).toBeUndefined();
        expect(lookupHostJudgeDefault(undefined, FRANK)).toBeUndefined();
    });

    it('ignores empty model entries', () => {
        expect(lookupHostJudgeDefault({ [FRANK]: '' }, FRANK)).toBeUndefined();
    });
});

describe('resolveBatchJudgeTarget judge model precedence', () => {
    it('uses the per-host stored default when no model is pinned (the config-trap fix)', async () => {
        const result = await resolveBatchJudgeTarget(
            FRANK,
            { host: FRANK },
            { judgeDefaults: HOST_DEFAULTS }
        );

        expect(result.validationModel).toBe(HOST_DEFAULT_JUDGE);
        expect(result.validationModel).not.toBe(JUDGE_CONFIG.model);
        expect(result.normalizedJudgeConfig.model).toBe(HOST_DEFAULT_JUDGE);
    });

    it('keys the host default off the resolved judge host, not the execution host', async () => {
        // Generation on BRUTAL, judging pinned to FRANK → must pick FRANK's default.
        const result = await resolveBatchJudgeTarget(
            BRUTAL,
            { host: FRANK },
            { judgeDefaults: { [FRANK]: HOST_DEFAULT_JUDGE, [BRUTAL]: 'some-other:7b' } }
        );

        expect(result.validationHost).toBe(FRANK);
        expect(result.validationModel).toBe(HOST_DEFAULT_JUDGE);
    });

    it('lets an explicitly pinned judge model win over the host default', async () => {
        const result = await resolveBatchJudgeTarget(
            FRANK,
            { host: FRANK, model: 'pinned-judge:32b' },
            { judgeDefaults: HOST_DEFAULTS }
        );

        expect(result.validationModel).toBe('pinned-judge:32b');
    });

    it('falls back to the env JUDGE_CONFIG.model when no host default exists', async () => {
        const result = await resolveBatchJudgeTarget(
            'http://10.0.0.5:11434',
            { host: 'http://10.0.0.5:11434' },
            { judgeDefaults: HOST_DEFAULTS }
        );

        expect(result.validationModel).toBe(JUDGE_CONFIG.model);
    });
});

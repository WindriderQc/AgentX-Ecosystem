const {
    normalizeThinkMode,
    resolveBenchmarkThinking,
    shouldEnableProfiledThinking
} = require('../../../src/services/benchmark/thinkingPolicy');

jest.mock('../../../models/ModelProfile', () => ({
    findOne: jest.fn()
}));

jest.mock('../../../models/HostProfile', () => ({
    findOne: jest.fn()
}));

const ModelProfile = require('../../../models/ModelProfile');
const HostProfile = require('../../../models/HostProfile');

function chainResolved(value) {
    return {
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(value)
        })
    };
}

describe('benchmark thinking policy', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('normalizes auto/on/off execution modes', () => {
        expect(normalizeThinkMode(undefined)).toBe('auto');
        expect(normalizeThinkMode('auto')).toBe('auto');
        expect(normalizeThinkMode('on')).toBe(true);
        expect(normalizeThinkMode('off')).toBe(false);
        expect(normalizeThinkMode(true)).toBe(true);
        expect(normalizeThinkMode(false)).toBe(false);
    });

    it('auto-enables only safe profiled thinking policies', () => {
        expect(shouldEnableProfiledThinking({
            profileVersion: 2,
            supported: true,
            recommendedPolicy: 'on',
            probeCount: 4,
            visibleFinalAnswerOk: true,
            thinkingOnlyResponse: false,
            runawayRisk: false
        })).toBe(true);

        expect(shouldEnableProfiledThinking({
            profileVersion: 2,
            supported: true,
            recommendedPolicy: 'metered',
            probeCount: 4,
            visibleFinalAnswerOk: true,
            thinkingOnlyResponse: false,
            runawayRisk: false
        })).toBe(true);
    });

    it('keeps auto thinking off for unsafe profiles', () => {
        expect(shouldEnableProfiledThinking({
            supported: true,
            recommendedPolicy: 'disallowed',
            visibleFinalAnswerOk: false
        })).toBe(false);

        expect(shouldEnableProfiledThinking({
            profileVersion: 2,
            supported: true,
            recommendedPolicy: 'on',
            probeCount: 4,
            visibleFinalAnswerOk: true,
            thinkingOnlyResponse: false,
            runawayRisk: true
        })).toBe(false);
    });

    it('keeps auto thinking off for old two-call thinking profiles', () => {
        expect(shouldEnableProfiledThinking({
            profileVersion: 2,
            supported: true,
            recommendedPolicy: 'on',
            visibleFinalAnswerOk: true,
            thinkingOnlyResponse: false,
            runawayRisk: false
        })).toBe(false);

        expect(shouldEnableProfiledThinking({
            supported: true,
            recommendedPolicy: 'on',
            probeCount: 2,
            visibleFinalAnswerOk: true,
            thinkingOnlyResponse: false,
            runawayRisk: false
        })).toBe(false);
    });

    it('keeps auto thinking off for pre-retry four-probe profiles', () => {
        expect(shouldEnableProfiledThinking({
            supported: true,
            recommendedPolicy: 'on',
            probeCount: 4,
            visibleFinalAnswerOk: true,
            thinkingOnlyResponse: false,
            runawayRisk: false
        })).toBe(false);
    });

    it('attaches profile metadata even when think=true is forced explicitly', async () => {
        HostProfile.findOne.mockReturnValue(chainResolved({ hostId: 'primary' }));
        ModelProfile.findOne.mockReturnValue(chainResolved({
            name: 'ax/gemma4:26b',
            thinkingProfiles: {
                primary: {
                    profileVersion: 2,
                    supported: true,
                    recommendedPolicy: 'metered',
                    probeCount: 4,
                    visibleFinalAnswerOk: true
                }
            }
        }));

        const policy = await resolveBenchmarkThinking({
            modelName: 'ax/gemma4:26b',
            hostUrl: 'http://host:11434',
            config: { think: true }
        });

        expect(policy).toMatchObject({
            think: true,
            mode: 'on',
            source: 'explicit',
            hostId: 'primary',
            modelProfileName: 'ax/gemma4:26b',
            profile: {
                recommendedPolicy: 'metered'
            }
        });
        expect(policy.reason).toMatch(/policy=metered/);
    });
});

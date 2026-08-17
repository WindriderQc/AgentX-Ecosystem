jest.mock('../../models/ModelProfile', () => ({
    findOne: jest.fn()
}));

jest.mock('../../models/ModelContextProbeSnapshot', () => ({
    findOne: jest.fn()
}));

jest.mock('../../models/ModelAdaptation', () => ({
    findOne: jest.fn()
}));

jest.mock('../../src/services/modelContextProfileService', () => ({
    findContextProfile: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
    getConfiguredHosts: jest.fn(),
    normalizeHostUrl: jest.fn((url) => {
        if (!url) return null;
        return String(url).replace(/\/+$/, '');
    })
}));

const ModelProfile = require('../../models/ModelProfile');
const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const ModelAdaptation = require('../../models/ModelAdaptation');
const modelContextProfileService = require('../../src/services/modelContextProfileService');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { resolveModelNumCtxDetails } = require('../../src/services/modelContextResolver');

function mockLeanResult(value) {
    return { lean: jest.fn().mockResolvedValue(value) };
}

function mockSortedLeanResult(value) {
    return {
        sort: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(value)
        })
    };
}

describe('modelContextResolver', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getConfiguredHosts.mockReturnValue([]);
        ModelContextProbeSnapshot.findOne.mockReturnValue(mockSortedLeanResult(null));
        ModelAdaptation.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
        modelContextProfileService.findContextProfile.mockResolvedValue(null);
    });

    it('returns profiler adaptation config as highest priority', async () => {
        getConfiguredHosts.mockReturnValue([{ url: 'http://host:11434', id: 'host-delta' }]);
        ModelAdaptation.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue({
                config: { num_ctx: 32768 },
                adaptedName: 'ax/llama3.1:8b'
            })
        });
        const result = await resolveModelNumCtxDetails('llama3.1:8b', 'http://host:11434');
        expect(result.num_ctx).toBe(32768);
        expect(result.source).toBe('profiler_adaptation');
    });

    it('uses the profiler adaptation context without a second runtime cap', async () => {
        getConfiguredHosts.mockReturnValue([{ url: 'http://host:11434', id: 'host-gamma' }]);
        ModelAdaptation.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue({
                config: { num_ctx: 202752 },
                adaptedName: 'ax/qwen3.6:35b-a3b-q8_0'
            })
        });

        const result = await resolveModelNumCtxDetails('ax/qwen3.6:35b-a3b-q8_0', 'http://host:11434');

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 202752,
            source: 'profiler_adaptation'
        }));
    });

    it('ignores stale profiler adaptations', async () => {
        getConfiguredHosts.mockReturnValue([{ url: 'http://host:11434', id: 'host-gamma' }]);
        ModelAdaptation.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue(null)
        });
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            executionDefaults: { num_ctx: 8192 },
            sourceHost: 'http://host:11434'
        }));

        const result = await resolveModelNumCtxDetails('ax/qwopus:27b', 'http://host:11434');

        expect(ModelAdaptation.findOne).toHaveBeenCalledWith(expect.objectContaining({
            'staleness.stale': { $ne: true }
        }));
        expect(result).toEqual(expect.objectContaining({
            num_ctx: null,
            source: 'unresolved',
            authoritative: false
        }));
    });

    it('returns explicit registry overrides first', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            executionOverrides: { num_ctx: 12288 },
            sourceHost: 'http://localhost:11434'
        }));

        const result = await resolveModelNumCtxDetails('qwen2.5:14b', {
            targetHost: 'http://localhost:11434'
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 12288,
            source: 'override'
        }));
    });

    it('prefers benchmark context probe results before VRAM estimation', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            parameterSize: '14B',
            quantization: 'Q4_K_M',
            sourceHost: 'http://localhost:11434'
        }));
        ModelContextProbeSnapshot.findOne.mockReturnValue(mockSortedLeanResult({
            testedNumCtx: 32768,
            hostUrl: 'http://localhost:11434',
            testedAt: new Date('2026-03-22T00:00:00Z'),
            status: 'completed'
        }));

        const result = await resolveModelNumCtxDetails('qwen2.5:14b', {
            targetHost: 'http://localhost:11434'
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 32768,
            source: 'benchmark_context_probe'
        }));
    });

    it('uses materialized context profiles before raw probe snapshots', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            parameterSize: '9B',
            quantization: 'Q8_0',
            sourceHost: 'http://localhost:11434'
        }));
        modelContextProfileService.findContextProfile.mockResolvedValue({
            modelName: 'ax/qwen3.5:9b',
            hostUrl: 'http://localhost:11434',
            recommendedContext: 65536,
            verifiedMaxContext: 237568,
            lastValidatedAt: new Date('2026-06-16T00:00:00Z')
        });
        ModelContextProbeSnapshot.findOne.mockReturnValue(mockSortedLeanResult({
            testedNumCtx: 65536,
            hostUrl: 'http://localhost:11434',
            testedAt: new Date('2026-06-15T00:00:00Z'),
            status: 'completed'
        }));

        const result = await resolveModelNumCtxDetails('ax/qwen3.5:9b', {
            targetHost: 'http://localhost:11434'
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 237568,
            source: 'model_context_profile',
            targetHost: 'http://localhost:11434'
        }));
        expect(result.details).toEqual(expect.objectContaining({
            verifiedMaxContext: 237568,
            matchedName: 'ax/qwen3.5:9b'
        }));
        expect(ModelContextProbeSnapshot.findOne).not.toHaveBeenCalled();
    });

    it('uses large measured context probe results directly', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            parameterSize: '35B',
            quantization: 'Q8_0',
            sourceHost: 'http://localhost:11434'
        }));
        ModelContextProbeSnapshot.findOne.mockReturnValue(mockSortedLeanResult({
            testedNumCtx: 202752,
            hostUrl: 'http://localhost:11434',
            testedAt: new Date('2026-05-31T16:36:43Z'),
            status: 'completed'
        }));

        const result = await resolveModelNumCtxDetails('qwen3.6:35b-a3b-q8_0', {
            targetHost: 'http://localhost:11434'
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 202752,
            source: 'benchmark_context_probe'
        }));
    });

    it('accepts benchmark context evidence regardless of its positive measured throughput', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            executionDefaults: { num_ctx: 8192 },
            sourceHost: 'http://localhost:11434'
        }));
        ModelContextProbeSnapshot.findOne.mockReturnValue(mockSortedLeanResult({
            testedNumCtx: 229376,
            atLimitTokensPerSec: 1000000,
            hostUrl: 'http://localhost:11434',
            testedAt: new Date('2026-06-15T00:00:00Z'),
            status: 'completed'
        }));

        const result = await resolveModelNumCtxDetails('qwopus3.6-coder-mtp:27b-q5_K_M', {
            targetHost: 'http://localhost:11434'
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 229376,
            source: 'benchmark_context_probe',
            authoritative: true
        }));
    });

    it('does not turn host VRAM into a context recommendation when no probe exists', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult({
            parameterSize: '7B',
            quantization: 'Q4_K_M',
            modelSizeBytes: 4 * 1024 * 1024 * 1024,
            sourceHost: 'http://localhost:11434'
        }));
        getConfiguredHosts.mockReturnValue([
            { url: 'http://localhost:11434', vramMb: 16384 }
        ]);

        const result = await resolveModelNumCtxDetails('qwen2.5:7b', {
            targetHost: 'http://localhost:11434'
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: null,
            source: 'unresolved',
            authoritative: false,
            targetHost: 'http://localhost:11434'
        }));
    });

    it('labels an explicit caller fallback without treating it as measured evidence', async () => {
        ModelProfile.findOne.mockReturnValue(mockLeanResult(null));

        const result = await resolveModelNumCtxDetails('unprofiled:7b', {
            targetHost: 'http://localhost:11434',
            fallback: 262144
        });

        expect(result).toEqual(expect.objectContaining({
            num_ctx: 262144,
            source: 'caller_fallback',
            authoritative: false
        }));
    });
});

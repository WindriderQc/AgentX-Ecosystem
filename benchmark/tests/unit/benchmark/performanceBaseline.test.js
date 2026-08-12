'use strict';

jest.mock('../../../models/BenchmarkBatch', () => ({
    updateOne: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../models/ModelAdaptation', () => ({
    findOne: jest.fn()
}));

jest.mock('../../../src/services/hostTestService', () => ({
    testModelOnHost: jest.fn()
}));

jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: jest.fn((hostUrl) => String(hostUrl || '').replace(/\/+$/, '')),
    getConfiguredHosts: jest.fn(() => [
        { id: 'host-beta', url: 'http://192.0.2.12:11434' }
    ])
}));

jest.mock('../../../src/services/modelContextResolver', () => ({
    modelNameCandidates: jest.fn((name) => {
        const normalized = String(name || '').replace(/:latest$/i, '');
        return normalized.startsWith('ax/') ? [normalized, normalized.slice(3)] : [normalized];
    })
}));

jest.mock('../../../src/services/benchmark/batchHelpers', () => ({
    toPerformanceBaseline: jest.fn((_model, _hostUrl, snapshot) => snapshot)
}));

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const ModelAdaptation = require('../../../models/ModelAdaptation');
const { _getProfilePerformanceBaseline } = require('../../../src/services/benchmark/performanceBaseline');

function chainResolved(value) {
    return {
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(value)
        })
    };
}

describe('performanceBaseline', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('looks up profiler adaptations for ax models by exact name before stripped fallback', async () => {
        const profiledAt = new Date().toISOString();
        ModelAdaptation.findOne.mockReturnValue(chainResolved({
            modelName: 'ax/qwen3.5:9b',
            config: { num_ctx: 65536 },
            profile: {
                tokensPerSec: 74.8,
                profiledAt
            },
            updatedAt: profiledAt
        }));

        const result = await _getProfilePerformanceBaseline(
            'ax/qwen3.5:9b',
            'http://192.0.2.12:11434'
        );

        expect(ModelAdaptation.findOne).toHaveBeenCalledWith({
            modelName: { $in: ['ax/qwen3.5:9b', 'qwen3.5:9b'] },
            hostId: 'host-beta'
        });
        expect(result).toMatchObject({
            hostId: 'host-beta',
            source: 'profiler_adaptation',
            tokensPerSec: 74.8,
            numCtx: 65536
        });
    });

    it('ignores stale profiler adaptations', async () => {
        const profiledAt = new Date().toISOString();
        ModelAdaptation.findOne.mockReturnValue(chainResolved({
            modelName: 'ax/qwopus:27b',
            config: { num_ctx: 194970 },
            profile: {
                tokensPerSec: 34.9,
                profiledAt
            },
            staleness: { stale: true, reason: 'invalid_probe' },
            updatedAt: profiledAt
        }));

        const result = await _getProfilePerformanceBaseline(
            'ax/qwopus:27b',
            'http://192.0.2.12:11434'
        );

        expect(result).toBeNull();
    });
});

'use strict';

jest.mock('../../../models/BenchmarkBatch', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../models/ModelPerformanceProfile', () => ({ findOne: jest.fn() }));
jest.mock('../../../src/services/hostTestService', () => ({ testModelOnHost: jest.fn() }));
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: jest.fn((hostUrl) => String(hostUrl || '').replace(/\/+$/, '')),
    getConfiguredHosts: jest.fn(() => [{ id: 'host-beta', url: 'http://192.0.2.12:11434' }])
}));
jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
    resolveArtifactIdentity: jest.fn(async (model, hostId, hostUrl) => ({
        model,
        hostId,
        hostUrl,
        digest: 'sha256:exact',
        runtimeFingerprint: 'runtime-a',
        registryQualified: true
    }))
}));
jest.mock('../../../src/services/benchmark/batchHelpers', () => ({
    toPerformanceBaseline: jest.fn((_model, _hostUrl, snapshot) => snapshot)
}));
jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const { _getProfilePerformanceBaseline } = require('../../../src/services/benchmark/performanceBaseline');

function chainResolved(value) {
    return {
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) })
    };
}

describe('performanceBaseline', () => {
    beforeEach(() => jest.clearAllMocks());

    it('looks up performance evidence for the exact artifact identity', async () => {
        const profiledAt = new Date().toISOString();
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved({
            artifact: { registryQualified: true },
            profile: {
                tokensPerSec: 74.8,
                recommendedConfig: { num_ctx: 65536 },
                profiledAt
            },
            updatedAt: profiledAt
        }));

        const result = await _getProfilePerformanceBaseline(
            'ax/qwen3.5:9b',
            'http://192.0.2.12:11434'
        );

        expect(ModelPerformanceProfile.findOne).toHaveBeenCalledWith({
            modelName: 'ax/qwen3.5:9b',
            hostId: 'host-beta',
            'artifact.digest': 'sha256:exact',
            'artifact.runtimeFingerprint': 'runtime-a',
            active: true,
            stale: { $ne: true }
        });
        expect(result).toMatchObject({
            hostId: 'host-beta',
            source: 'exact_artifact_profile',
            tokensPerSec: 74.8,
            numCtx: 65536
        });
    });

    it('ignores evidence that is not registry-qualified', async () => {
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved({
            artifact: { registryQualified: false },
            profile: { tokensPerSec: 34.9 }
        }));

        await expect(_getProfilePerformanceBaseline(
            'ax/qwopus:27b',
            'http://192.0.2.12:11434'
        )).resolves.toBeNull();
    });
});

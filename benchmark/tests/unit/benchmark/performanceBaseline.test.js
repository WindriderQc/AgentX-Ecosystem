'use strict';

jest.mock('../../../models/BenchmarkBatch', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../models/ModelPerformanceProfile', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/ModelProfile', () => ({ findOne: jest.fn() }));
jest.mock('../../../src/services/hostTestService', () => ({ testModelOnHost: jest.fn() }));
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: jest.fn((hostUrl) => String(hostUrl || '').replace(/\/+$/, '')),
    getConfiguredHosts: jest.fn(() => [{ id: 'host-beta', url: 'http://192.0.2.12:11434' }])
}));
jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
    identitiesMatch: jest.fn((left, right) => left?.digest === right?.digest
        && left?.runtimeFingerprint === right?.runtimeFingerprint),
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
const ModelProfile = require('../../../models/ModelProfile');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const {
    capturePerformanceBaseline,
    _getProfilePerformanceBaseline
} = require('../../../src/services/benchmark/performanceBaseline');
const { receiptDigest } = require('../../../src/services/profiler/profilerAuthorityReceipt');

function chainResolved(value) {
    return {
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) })
    };
}

function authority(evidenceId = 'evidence-1') {
    return {
        readiness: {
            'host-beta': {
                benchmarkQualified: true,
                stale: false,
                profileDepth: 'standard',
                evidenceId,
                artifact: {
                    model: 'ax/qwen3.5:9b',
                    hostId: 'host-beta',
                    hostUrl: 'http://192.0.2.12:11434',
                    digest: 'sha256:exact',
                    runtimeFingerprint: 'runtime-a',
                    registryQualified: true
                },
                authorityReceipt: {
                    version: 1,
                    source: 'profiler_pipeline',
                    evidenceId,
                    digest: receiptDigest({
                        modelName: 'ax/qwen3.5:9b',
                        hostId: 'host-beta',
                        artifact: {
                            model: 'ax/qwen3.5:9b',
                            hostId: 'host-beta',
                            hostUrl: 'http://192.0.2.12:11434',
                            digest: 'sha256:exact',
                            runtimeFingerprint: 'runtime-a',
                            registryQualified: true
                        },
                        profileDepth: 'standard',
                        required: 5,
                        passing: 5
                    })
                }
            }
        }
    };
}

describe('performanceBaseline', () => {
    beforeEach(() => jest.clearAllMocks());

    function exactEvidence(overrides = {}) {
        const profiledAt = new Date().toISOString();
        return {
            _id: 'evidence-1',
            artifact: authority().readiness['host-beta'].artifact,
            profile: {
                tokensPerSec: 74.8,
                recommendedInteractiveContext: 65536,
                requiredRetainedSamples: 5,
                measurementQuality: { reliability: 'medium', passingSampleCount: 5 },
                ttftMs: 125,
                ttftMeasurement: 'streamed_wall_clock',
                profileDepth: 'standard',
                profiledAt,
                ...overrides
            },
            updatedAt: profiledAt
        };
    }

    it('looks up performance evidence for the exact artifact identity', async () => {
        const profiledAt = new Date().toISOString();
        ModelProfile.findOne.mockReturnValue(chainResolved(authority()));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved(exactEvidence({ profiledAt })));

        const result = await _getProfilePerformanceBaseline(
            'ax/qwen3.5:9b',
            'http://192.0.2.12:11434'
        );

        expect(ModelPerformanceProfile.findOne).toHaveBeenCalledWith({
            _id: 'evidence-1',
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
        const readiness = authority();
        readiness.readiness['host-beta'].artifact.registryQualified = false;
        ModelProfile.findOne.mockReturnValue(chainResolved(readiness));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved({
            artifact: { registryQualified: false },
            profile: { tokensPerSec: 34.9 }
        }));

        await expect(_getProfilePerformanceBaseline(
            'ax/qwopus:27b',
            'http://192.0.2.12:11434'
        )).resolves.toBeNull();
    });

    it.each([
        ['Quick', { profileDepth: 'quick' }],
        ['non-qualified', { benchmarkQualified: false }],
        ['receipt-less', { authorityReceipt: null }]
    ])('refuses %s readiness even when a performance profile document exists', async (_label, readinessOverride) => {
        const modelAuthority = authority();
        Object.assign(modelAuthority.readiness['host-beta'], readinessOverride);
        ModelProfile.findOne.mockReturnValue(chainResolved(modelAuthority));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved(exactEvidence()));

        await expect(_getProfilePerformanceBaseline(
            'ax/qwen3.5:9b',
            'http://192.0.2.12:11434'
        )).resolves.toBeNull();
    });

    it('refuses authority evidence without a positive interactive recommendation', async () => {
        ModelProfile.findOne.mockReturnValue(chainResolved(authority()));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved(exactEvidence({
            recommendedInteractiveContext: null
        })));
        await expect(_getProfilePerformanceBaseline(
            'ax/qwen3.5:9b',
            'http://192.0.2.12:11434'
        )).resolves.toBeNull();
    });

    it('refuses a syntactically valid but forged authority digest', async () => {
        const forged = authority();
        forged.readiness['host-beta'].authorityReceipt.digest = '0'.repeat(64);
        ModelProfile.findOne.mockReturnValue(chainResolved(forged));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved(exactEvidence()));

        await expect(_getProfilePerformanceBaseline(
            'ax/qwen3.5:9b',
            'http://192.0.2.12:11434'
        )).resolves.toBeNull();
    });

    it('refuses baseline persistence without an exact claim proof', async () => {
        await expect(capturePerformanceBaseline({
            batchId: 'batch-1',
            model: 'ax/qwen3.5:9b',
            hostUrl: 'http://192.0.2.12:11434'
        })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_IDENTITY_MISSING' });
        expect(ModelPerformanceProfile.findOne).not.toHaveBeenCalled();
        expect(BenchmarkBatch.updateOne).not.toHaveBeenCalled();
    });

    it('retracts a just-written baseline when claim ownership is lost during the database write', async () => {
        ModelProfile.findOne.mockReturnValue(chainResolved(authority()));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved(exactEvidence()));
        let checkpoints = 0;
        const assertClaimActive = jest.fn(() => {
            checkpoints += 1;
            if (checkpoints === 3) {
                throw Object.assign(new Error('claim lost during write'), { code: 'BENCHMARK_CLAIM_LOST' });
            }
        });

        await expect(capturePerformanceBaseline({
            batchId: 'batch-write-race',
            model: 'ax/qwen3.5:9b',
            hostUrl: 'http://192.0.2.12:11434',
            claimIdentity: { claimBatchId: 'batch-write-race', claimGeneration: 'generation-1' },
            assertClaimActive
        })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_LOST' });

        expect(BenchmarkBatch.updateOne).toHaveBeenCalledTimes(2);
        const persisted = BenchmarkBatch.updateOne.mock.calls[0][1].$push.performance_baselines;
        expect(persisted.persistenceReceipt).toEqual(expect.any(String));
        expect(BenchmarkBatch.updateOne.mock.calls[1][1]).toEqual({
            $pull: { performance_baselines: { persistenceReceipt: persisted.persistenceReceipt } }
        });
    });

    it('retains admission when neither baseline compensation nor durable invalidation can be confirmed', async () => {
        ModelProfile.findOne.mockReturnValue(chainResolved(authority()));
        ModelPerformanceProfile.findOne.mockReturnValue(chainResolved(exactEvidence()));
        let checkpoints = 0;
        const assertClaimActive = jest.fn(() => {
            checkpoints += 1;
            if (checkpoints === 3) {
                throw Object.assign(new Error('claim lost during write'), { code: 'BENCHMARK_CLAIM_LOST' });
            }
        });
        BenchmarkBatch.updateOne
            .mockResolvedValueOnce({ matchedCount: 1 })
            .mockRejectedValueOnce(new Error('pull compensation unavailable'))
            .mockRejectedValueOnce(new Error('authority invalidation unavailable'));

        await expect(capturePerformanceBaseline({
            batchId: 'batch-write-race',
            model: 'ax/qwen3.5:9b',
            hostUrl: 'http://192.0.2.12:11434',
            claimIdentity: { claimBatchId: 'batch-write-race', claimGeneration: 'generation-1' },
            assertClaimActive
        })).rejects.toMatchObject({
            code: 'PERFORMANCE_BASELINE_RECONCILIATION_PENDING',
            retainAdmission: true,
            compensationError: expect.any(Error),
            invalidationError: expect.any(Error)
        });
    });
});

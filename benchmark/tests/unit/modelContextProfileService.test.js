'use strict';

jest.mock('../../models/ModelContextProfile', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(),
  normalizeHostUrl: jest.fn((hostUrl) => hostUrl ? String(hostUrl).replace(/\/+$/, '') : null)
}));

const ModelContextProfile = require('../../models/ModelContextProfile');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const service = require('../../src/services/modelContextProfileService');

function mockLean(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

describe('modelContextProfileService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfiguredHosts.mockReturnValue([
      { id: 'secondary', url: 'http://192.0.2.12:11434' }
    ]);
    ModelContextProfile.findOne.mockReturnValue(mockLean(null));
    ModelContextProfile.findOneAndUpdate.mockImplementation((_filter, update) => mockLean(update.$set));
    ModelContextProfile.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  it('materializes a recommended profile from a completed probe snapshot', async () => {
    const testedAt = new Date('2026-06-16T00:00:00Z');

    const profile = await service.updateFromProbeSnapshot({
      _id: 'snapshot-1',
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434/',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 237568,
      promptFillPct: 80,
      modelTheoreticalMax: 262144,
      testedAt,
      testDurationMs: 972000,
      degradationPct: 12.5,
      steps: [{
        numCtx: 237568,
        passed: true,
        degradationPct: 12.5,
        tokensPerSec: 71.2,
        promptTokens: 190000,
        vramUsedMiB: 12000,
        gpuPercent: 100,
        completionTokens: 64,
        requestedCompletionTokens: 64,
        minCompletionTokens: 32
      }]
    });

    expect(profile).toEqual(expect.objectContaining({
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      hostId: 'secondary',
      maxVerifiedContext: 237568,
      verifiedMaxContext: 237568,
      historicalMaxVerifiedContext: 237568,
      verifiedInputTokens: 190000,
      recommendedContext: 237568,
      source: 'context_probe',
      stale: false
    }));
    expect(profile.latestEvidence).toEqual(expect.objectContaining({
      snapshotId: 'snapshot-1',
      testedNumCtx: 237568,
      promptTokens: 190000,
      tokensPerSec: 71.2,
      completionTokens: 64
    }));
    expect(ModelContextProfile.findOneAndUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({
      rejectedEvidenceIds: { $ne: 'snapshot-1' }
    }));
  });

  it('lowers the current ceiling while retaining the historical maximum', async () => {
    ModelContextProfile.findOne.mockReturnValue(mockLean({
      verifiedMaxContext: 237568
    }));

    const profile = await service.updateFromProbeSnapshot({
      _id: 'snapshot-2',
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 131072,
      testedAt: new Date('2026-06-16T01:00:00Z'),
      steps: [{ numCtx: 131072, passed: true, tokensPerSec: 73.59, degradationPct: 10 }]
    });

    expect(profile).toEqual(expect.objectContaining({
      maxVerifiedContext: 131072,
      verifiedMaxContext: 131072,
      historicalMaxVerifiedContext: 237568,
      recommendedContext: 131072
    }));
    expect(profile.latestEvidence).toEqual(expect.objectContaining({
      snapshotId: 'snapshot-2',
      testedNumCtx: 131072,
      tokensPerSec: 73.59
    }));
  });

  it('marks a legacy 262K recommendation unknown while preserving capacity history', () => {
    expect(service.normalizeContextProfile({
      modelName: 'ornith:latest',
      recommendedContext: 262144,
      verifiedMaxContext: 262144
    })).toMatchObject({
      maxVerifiedContext: 262144,
      historicalMaxVerifiedContext: 262144,
      recommendedInteractiveContext: null,
      recommendedDocumentContext: null,
      recommendedContext: null,
      recommendationStatus: 'unknown',
      revalidationRequired: true
    });
  });

  it('persists a rejected snapshot fence before invalidating its projected authority', async () => {
    const snapshot = {
      _id: 'snapshot-rejected',
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434/',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a'
    };

    await service.invalidateIfSnapshot(snapshot, 'claim_lost');

    expect(ModelContextProfile.updateOne).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ modelName: 'ax/qwen3.5:9b', hostUrl: 'http://192.0.2.12:11434' }),
      { $addToSet: { rejectedEvidenceIds: 'snapshot-rejected' } },
      { upsert: true }
    );
    expect(ModelContextProfile.updateOne).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ 'latestEvidence.snapshotId': 'snapshot-rejected' }),
      { $set: expect.objectContaining({ stale: true, recommendationStatus: 'unknown' }) }
    );
  });

  it('does not turn max verified capacity into a recommendation when degradation evidence is absent', async () => {
    const profile = await service.updateFromProbeSnapshot({
      _id: 'snapshot-capacity-only',
      modelName: 'ornith:latest',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:ornith',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 262144,
      steps: [{ numCtx: 262144, passed: true, tokensPerSec: 12.5 }]
    });

    expect(profile).toMatchObject({
      maxVerifiedContext: 262144,
      recommendedInteractiveContext: null,
      recommendedDocumentContext: null,
      recommendedContext: null,
      recommendationStatus: 'unknown',
      revalidationRequired: true,
      stale: true,
      staleReason: 'context_recommendation_unavailable'
    });
  });

  it('ignores failed or incomplete snapshots', async () => {
    await expect(service.updateFromProbeSnapshot({
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'failed',
      testedNumCtx: 131072
    })).resolves.toBeNull();
    expect(ModelContextProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts positive measured throughput without an arbitrary ceiling', async () => {
    await expect(service.updateFromProbeSnapshot({
      _id: 'snapshot-bad',
      modelName: 'ax/qwopus:27b',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 131072,
      steps: [{ numCtx: 131072, passed: true, tokensPerSec: 1000000 }]
    })).resolves.toBeTruthy();

    expect(ModelContextProfile.findOneAndUpdate).toHaveBeenCalled();
  });

  it('does not invalidate a profile because another measured step was faster', async () => {
    await expect(service.updateFromProbeSnapshot({
      _id: 'snapshot-bad-step',
      modelName: 'ax/qwopus:27b',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 14336,
      baselineTokensPerSec: 35.18,
      atLimitTokensPerSec: 34.57,
      steps: [
        { numCtx: 2048, passed: true, tokensPerSec: 35.18 },
        { numCtx: 16384, passed: false, tokensPerSec: 1000000 },
        { numCtx: 14336, passed: true, tokensPerSec: 34.57 }
      ]
    })).resolves.toBeTruthy();

    expect(ModelContextProfile.findOneAndUpdate).toHaveBeenCalled();
  });

  it('persists the last good rung when a failed boundary step reports zero throughput', async () => {
    const profile = await service.updateFromProbeSnapshot({
      _id: 'snapshot-zero-boundary',
      modelName: 'gemma4:12b-it-qat',
      hostId: 'secondary',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 32768,
      baselineTokensPerSec: 50,
      atLimitTokensPerSec: 30,
      steps: [
        { numCtx: 2048, passed: true, tokensPerSec: 50, degradationPct: 0 },
        { numCtx: 32768, passed: true, tokensPerSec: 30, promptTokens: 26000, degradationPct: 25 },
        { numCtx: 65536, requestSucceeded: true, passed: false, tokensPerSec: 0 }
      ]
    });

    expect(profile).toEqual(expect.objectContaining({
      modelName: 'gemma4:12b-it-qat',
      hostId: 'secondary',
      verifiedMaxContext: 32768,
      recommendedContext: 32768
    }));
    expect(ModelContextProfile.findOneAndUpdate).toHaveBeenCalled();
  });

  it('rejects negative or non-finite throughput evidence', async () => {
    const base = {
      modelName: 'gemma4:12b-it-qat',
      hostUrl: 'http://192.0.2.12:11434',
      artifactDigest: 'sha256:exact',
      runtimeFingerprint: 'runtime-a',
      status: 'completed',
      testedNumCtx: 32768,
      baselineTokensPerSec: 50,
      atLimitTokensPerSec: 30
    };

    await expect(service.updateFromProbeSnapshot({
      ...base,
      steps: [{ numCtx: 65536, passed: false, tokensPerSec: -1 }]
    })).resolves.toBeNull();
    await expect(service.updateFromProbeSnapshot({
      ...base,
      steps: [{ numCtx: 65536, passed: false, tokensPerSec: Number.POSITIVE_INFINITY }]
    })).resolves.toBeNull();
    expect(ModelContextProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

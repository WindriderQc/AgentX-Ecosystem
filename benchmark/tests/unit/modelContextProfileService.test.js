'use strict';

jest.mock('../../models/ModelContextProfile', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn()
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
  });

  it('materializes a recommended profile from a completed probe snapshot', async () => {
    const testedAt = new Date('2026-06-16T00:00:00Z');

    const profile = await service.updateFromProbeSnapshot({
      _id: 'snapshot-1',
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434/',
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
      hostId: 'secondary',
      verifiedMaxContext: 237568,
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
  });

  it('preserves a higher verified ceiling when a later bounded probe updates evidence', async () => {
    ModelContextProfile.findOne.mockReturnValue(mockLean({
      verifiedMaxContext: 237568
    }));

    const profile = await service.updateFromProbeSnapshot({
      _id: 'snapshot-2',
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434',
      status: 'completed',
      testedNumCtx: 131072,
      testedAt: new Date('2026-06-16T01:00:00Z'),
      steps: [{ numCtx: 131072, passed: true, tokensPerSec: 73.59 }]
    });

    expect(profile).toEqual(expect.objectContaining({
      verifiedMaxContext: 237568,
      recommendedContext: 237568
    }));
    expect(profile.latestEvidence).toEqual(expect.objectContaining({
      snapshotId: 'snapshot-2',
      testedNumCtx: 131072,
      tokensPerSec: 73.59
    }));
  });

  it('ignores failed or incomplete snapshots', async () => {
    await expect(service.updateFromProbeSnapshot({
      modelName: 'ax/qwen3.5:9b',
      hostUrl: 'http://192.0.2.12:11434',
      status: 'failed',
      testedNumCtx: 131072
    })).resolves.toBeNull();
    expect(ModelContextProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('ignores completed snapshots with implausible throughput evidence', async () => {
    await expect(service.updateFromProbeSnapshot({
      _id: 'snapshot-bad',
      modelName: 'ax/qwopus:27b',
      hostUrl: 'http://192.0.2.12:11434',
      status: 'completed',
      testedNumCtx: 131072,
      steps: [{ numCtx: 131072, passed: true, tokensPerSec: 1000000 }]
    })).resolves.toBeNull();

    expect(ModelContextProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('ignores completed snapshots with implausible non-winning steps', async () => {
    await expect(service.updateFromProbeSnapshot({
      _id: 'snapshot-bad-step',
      modelName: 'ax/qwopus:27b',
      hostUrl: 'http://192.0.2.12:11434',
      status: 'completed',
      testedNumCtx: 14336,
      baselineTokensPerSec: 35.18,
      atLimitTokensPerSec: 34.57,
      steps: [
        { numCtx: 2048, passed: true, tokensPerSec: 35.18 },
        { numCtx: 16384, passed: false, tokensPerSec: 1000000 },
        { numCtx: 14336, passed: true, tokensPerSec: 34.57 }
      ]
    })).resolves.toBeNull();

    expect(ModelContextProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

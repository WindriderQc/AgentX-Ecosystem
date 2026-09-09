'use strict';

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  hasActiveBenchmarkClaim: jest.fn(pref => Boolean(pref?.benchmarkClaim))
}));
jest.mock('../../config/logger', () => ({ info: jest.fn() }));
jest.mock('../../src/services/runtimeCoordinationService', () => ({
  assertWorkloadAdmission: jest.fn(async () => ({ admitted: true }))
}));

const hostPreferenceService = require('../../src/services/hostPreferenceService');
const { assertHostAvailableForConsumer } = require('../../src/services/benchmarkClaimGuard');

describe('benchmarkClaimGuard session hold', () => {
  const hold = {
    holdId: 'hold-1',
    owner: 'extension/open',
    model: 'held-model:27b',
    expiresAt: new Date(Date.now() + 60_000)
  };

  beforeEach(() => {
    jest.clearAllMocks();
    hostPreferenceService.getByHost.mockResolvedValue({ benchmarkClaim: null, sessionHold: hold });
  });

  it('refuses other models on a held host with a retry hint', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'proxy',
      model: 'everyday-model:27b'
    })).rejects.toMatchObject({
      code: 'HOST_SESSION_HOLD_ACTIVE',
      statusCode: 503,
      holdOwner: 'extension/open',
      retryAfterMs: expect.any(Number)
    });
  });

  it('admits the held model itself', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'extension/open',
      model: 'held-model:27b'
    })).resolves.toBeNull();
  });

  it('is transparent when the hold has expired', async () => {
    hostPreferenceService.getByHost.mockResolvedValue({
      benchmarkClaim: null,
      sessionHold: { ...hold, expiresAt: new Date(Date.now() - 1_000) }
    });
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      model: 'everyday-model:27b'
    })).resolves.toBeNull();
  });
});

describe('benchmarkClaimGuard claim proof', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostPreferenceService.getByHost.mockResolvedValue({
      benchmarkClaim: {
        batchId: 'batch-1',
        claimGeneration: 'generation-1',
        admissionId: 'admission-1',
        admissionGeneration: 'admission-generation-1',
        admissionPrincipal: 'benchmark-service'
      }
    });
  });

  it('does not authorize a caller-controlled benchmark prefix', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'benchmark-spoofed'
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE', batchId: 'batch-1' });
  });

  it('authorizes only the exact active batch and generation', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'benchmark-batch-1',
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: true
    })).resolves.toMatchObject({ batchId: 'batch-1' });

    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-stale',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: true
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('rejects replay of an exact proof without authenticated Benchmark principal', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'benchmark-batch-1',
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: false
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('rejects an authenticated claim after its linked workload admission expires', async () => {
    const runtimeCoordinationService = require('../../src/services/runtimeCoordinationService');
    runtimeCoordinationService.assertWorkloadAdmission.mockResolvedValueOnce({
      admitted: false,
      reason: 'expired'
    });
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: true
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('rejects stale proof when no claim is active', async () => {
    hostPreferenceService.getByHost.mockResolvedValue(null);
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1'
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_PROOF_INVALID' });
  });
});

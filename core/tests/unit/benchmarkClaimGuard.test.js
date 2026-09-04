'use strict';

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  hasActiveBenchmarkClaim: jest.fn(pref => Boolean(pref?.benchmarkClaim))
}));
jest.mock('../../config/logger', () => ({ info: jest.fn() }));

const hostPreferenceService = require('../../src/services/hostPreferenceService');
const { assertHostAvailableForConsumer } = require('../../src/services/benchmarkClaimGuard');

describe('benchmarkClaimGuard claim proof', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostPreferenceService.getByHost.mockResolvedValue({
      benchmarkClaim: { batchId: 'batch-1', claimGeneration: 'generation-1' }
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
      claimGeneration: 'generation-1'
    })).resolves.toMatchObject({ batchId: 'batch-1' });

    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-stale'
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

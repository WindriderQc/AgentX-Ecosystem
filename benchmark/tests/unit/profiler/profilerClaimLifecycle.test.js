'use strict';

jest.mock('../../../src/clients/coreApiClient', () => ({
  claimHostForBenchmark: jest.fn().mockResolvedValue({ claimed: true }),
  heartbeatBenchmarkClaim: jest.fn(),
  releaseBenchmarkClaim: jest.fn().mockResolvedValue({
    released: true,
    runtimeRestore: { verified: true },
  }),
  getBenchmarkClaimIdentity: jest.fn((_host, batchId) => ({
    claimBatchId: batchId,
    claimGeneration: 'generation-profiler-1',
  })),
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const coreApiClient = require('../../../src/clients/coreApiClient');
const { acquireProfilerClaimLease } = require('../../../src/services/profiler/profilerClaimLifecycle');

describe('profiler claim lease cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });
    coreApiClient.heartbeatBenchmarkClaim
      .mockResolvedValueOnce({ heartbeat: true })
      .mockResolvedValue({ heartbeat: false, reason: 'generation replaced' });
    coreApiClient.releaseBenchmarkClaim.mockResolvedValue({
      released: true,
      runtimeRestore: { verified: true },
    });
  });

  test('aborts an in-flight Ollama operation on heartbeat loss and drains before release', async () => {
    const lease = await acquireProfilerClaimLease(
      ['http://gpu:11434'],
      'profiler-operation-1',
      60_000,
      { heartbeatIntervalMs: 5 }
    );
    let laterWrite = false;
    const suspendedOllamaFetch = new Promise((resolve, reject) => {
      lease.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }).then(() => {
      laterWrite = true;
    });

    await expect(suspendedOllamaFetch).rejects.toMatchObject({ name: 'AbortError' });
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.assertActive()).toThrow(expect.objectContaining({
      code: 'BENCHMARK_CLAIM_LOST',
    }));

    await expect(lease.finalize()).resolves.toMatchObject({ released: 1, failed: 0 });
    expect(laterWrite).toBe(false);
    expect(coreApiClient.heartbeatBenchmarkClaim).toHaveBeenCalledTimes(2);
    expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledTimes(1);
    expect(coreApiClient.releaseBenchmarkClaim.mock.invocationCallOrder[0])
      .toBeGreaterThan(coreApiClient.heartbeatBenchmarkClaim.mock.invocationCallOrder[1]);
  });
});

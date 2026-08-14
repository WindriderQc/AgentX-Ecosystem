/**
 * Unit Tests for Benchmark Claim Service
 *
 * Migrated from hostPreferenceService.test.js in task 0183 — these describes
 * exercise the claim lifecycle (acquire / release / list / claim-respecting
 * pin paths). The grace-period state machine (task 0176) and pin-CRUD tests
 * stay in hostPreferenceService.test.js since the state machine still lives
 * in that module.
 *
 * The `claim-respecting pin paths (0175)` describe still calls
 * `service.warmHost` / `service.restorePinnedModels` from the host-pref
 * service because that's where those primitives live; the claim assertions
 * target the new module via the re-export shim.
 */

// Mock logger to suppress output during tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const mockObserveClaimReleaseFailure = jest.fn(async () => ({ emitted: 1, matched: 1 }));
const mockObservePinRestoreFailure = jest.fn(async () => ({ emitted: 1, matched: 1 }));
jest.mock('../../src/services/laneObservabilityService', () => ({
  observeClaimReleaseFailure: (...args) => mockObserveClaimReleaseFailure(...args),
  observePinRestoreFailure: (...args) => mockObservePinRestoreFailure(...args)
}));

const HostPreference = require('../../models/HostPreference');
const service = require('../../src/services/benchmarkClaimService');
const hostPrefService = require('../../src/services/hostPreferenceService');

afterEach(async () => {
  await HostPreference.deleteMany({});
});

describe('benchmarkClaimService', () => {
  const HOST_URL = 'http://host1:11434';
  const BATCH_A = 'batch-aaa';
  const BATCH_B = 'batch-bbb';

  beforeEach(async () => {
    await HostPreference.create({
      hostUrl: HOST_URL,
      hostKey: 'primary',
      pinnedModels: [{ model: 'gemma4:26b' }],
      status: 'ready'
    });
  });

  describe('claimBenchmark', () => {
    it('flips status to benchmarking and stores prevStatus', async () => {
      const result = await service.claimBenchmark(HOST_URL, BATCH_A, 300_000);
      expect(result.claimed).toBe(true);
      expect(result.pref.status).toBe('benchmarking');
      expect(result.pref.benchmarkClaim.batchId).toBe(BATCH_A);
      expect(result.pref.benchmarkClaim.prevStatus).toBe('ready');
      expect(result.pref.benchmarkClaim.estimatedDurationMs).toBe(300_000);
      expect(result.pref.benchmarkClaim.source).toBe('manual');
      expect(result.pref.benchmarkClaim.heartbeatAt).toBeTruthy();
    });

    it('stores explicit claim source, owner, note, and heartbeat ttl', async () => {
      const result = await service.claimBenchmark(HOST_URL, BATCH_A, 300_000, {
        source: 'benchmark',
        owner: 'unit-test',
        note: 'claim metadata',
        heartbeatTtlMs: 120_000
      });
      expect(result.claimed).toBe(true);
      expect(result.pref.benchmarkClaim.source).toBe('benchmark');
      expect(result.pref.benchmarkClaim.owner).toBe('unit-test');
      expect(result.pref.benchmarkClaim.note).toBe('claim metadata');
      expect(result.pref.benchmarkClaim.heartbeatTtlMs).toBe(120_000);
    });

    it('is idempotent for same batch reclaiming', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A, 300_000);
      const again = await service.claimBenchmark(HOST_URL, BATCH_A, 999_999);
      expect(again.claimed).toBe(true);
      // prevStatus should still be 'ready' — not overwritten to 'benchmarking'
      expect(again.pref.benchmarkClaim.prevStatus).toBe('ready');
    });

    it('rejects a claim from a different batch while already benchmarking', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const conflict = await service.claimBenchmark(HOST_URL, BATCH_B);
      expect(conflict.claimed).toBe(false);
      expect(conflict.reason).toContain(BATCH_A);
    });

    it('rejects missing hostUrl or batchId', async () => {
      const r1 = await service.claimBenchmark(null, BATCH_A);
      const r2 = await service.claimBenchmark(HOST_URL, null);
      expect(r1.claimed).toBe(false);
      expect(r2.claimed).toBe(false);
    });

    it('upserts preference when host unknown', async () => {
      const result = await service.claimBenchmark('http://unknown:11434', BATCH_A);
      expect(result.claimed).toBe(true);
      expect(result.pref.hostUrl).toBe('http://unknown:11434');
    });
  });

  describe('heartbeatBenchmarkClaim', () => {
    it('refreshes the active claim heartbeat', async () => {
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A, 300_000, {
        source: 'manual',
        owner: 'first-owner'
      });
      const before = new Date(claimed.pref.benchmarkClaim.heartbeatAt).getTime();
      await new Promise(resolve => setTimeout(resolve, 5));

      const heartbeat = await service.heartbeatBenchmarkClaim(HOST_URL, BATCH_A, {
        owner: 'heartbeat-owner',
        heartbeatTtlMs: 90_000
      });

      expect(heartbeat.heartbeat).toBe(true);
      expect(new Date(heartbeat.pref.benchmarkClaim.heartbeatAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(heartbeat.pref.benchmarkClaim.owner).toBe('heartbeat-owner');
      expect(heartbeat.pref.benchmarkClaim.heartbeatTtlMs).toBe(90_000);
    });

    it('rejects heartbeat when another batch owns the claim', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const heartbeat = await service.heartbeatBenchmarkClaim(HOST_URL, BATCH_B);
      expect(heartbeat.heartbeat).toBe(false);
      expect(heartbeat.reason).toContain(BATCH_A);
    });
  });

  describe('releaseBenchmarkClaim', () => {
    // Pass skipPinRestore so the async post-release restore doesn't leak
    // a `setHostStatus('restoring')` call into the next test (0175).
    const RELEASE_OPTS = { skipPinRestore: true };

    it('restores prevStatus and clears claim fields', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, RELEASE_OPTS);
      expect(released.released).toBe(true);
      expect(released.pref.status).toBe('ready');
      expect(released.pref.benchmarkClaim.batchId).toBeNull();
      expect(released.pref.benchmarkClaim.prevStatus).toBeNull();
      expect(released.pref.benchmarkClaim.source).toBeNull();
      expect(released.pref.benchmarkClaim.heartbeatAt).toBeNull();
    });

    it('refuses to release another batch\'s claim', async () => {
      mockObserveClaimReleaseFailure.mockClear();
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const refused = await service.releaseBenchmarkClaim(HOST_URL, BATCH_B, RELEASE_OPTS);
      expect(refused.released).toBe(false);
      expect(refused.reason).toContain(BATCH_A);
      // Status should still be benchmarking
      const still = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(still.status).toBe('benchmarking');
      expect(mockObserveClaimReleaseFailure).toHaveBeenCalledWith(expect.objectContaining({
        host: HOST_URL,
        batchId: BATCH_B,
        source: 'benchmark-claim-release'
      }));
    });

    it('returns released=false when host preference missing', async () => {
      mockObserveClaimReleaseFailure.mockClear();
      const res = await service.releaseBenchmarkClaim('http://nohost:11434', BATCH_A, RELEASE_OPTS);
      expect(res.released).toBe(false);
      expect(mockObserveClaimReleaseFailure).toHaveBeenCalledTimes(1);
    });

    // 0175 / 0215 — auto-restore on legitimate release
    it('restores and verifies the pin after a successful release', async () => {
      const originalFetch = global.fetch;
      let psCalls = 0;
      global.fetch = jest.fn(async (url) => {
        if (typeof url === 'string' && url.endsWith('/api/ps')) {
          psCalls += 1;
          return {
            ok: true,
            json: async () => ({
              models: psCalls === 1 ? [] : [{ name: 'gemma4:26b' }]
            })
          };
        }
        return {
          ok: true,
          text: async () => '{}'
        };
      });

      try {
        await service.claimBenchmark(HOST_URL, BATCH_A);
        const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A);
        expect(released.released).toBe(true);
        expect(released.pinRestore?.status).toBe('ready');
        expect(released.pinRestore?.verified).toBe(true);

        const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
        expect(after.status).toBe('ready');
        expect(after.benchmarkClaim?.batchId).toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // 0175 — pin reconciler / warm paths must respect benchmark claims
  // These call into hostPreferenceService primitives (warmHost,
  // restorePinnedModels) but assert on the claim machinery owned by
  // benchmarkClaimService.
  describe('claim-respecting pin paths (0175)', () => {
    it('warmHost short-circuits on a host with an active claim', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const results = await hostPrefService.warmHost(HOST_URL);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('skipped_claim');
      expect(results[0].batchId).toBe(BATCH_A);
      // Status must remain 'benchmarking' — warmHost did not flip to 'restoring'
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.status).toBe('benchmarking');
    });

    it('restorePinnedModels short-circuits on a host with an active claim', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const result = await hostPrefService.restorePinnedModels(HOST_URL);
      expect(result.status).toBe('skipped_claim');
      expect(result.batchId).toBe(BATCH_A);
      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.status).toBe('benchmarking');
    });

    it('warmHost still works when there is no claim', async () => {
      // No claim — warmHost should attempt the warm. The host is unreachable
      // in tests so the per-entry result will be 'error', not 'skipped_claim'.
      const results = await hostPrefService.warmHost(HOST_URL);
      expect(results).toHaveLength(1);
      expect(results[0].status).not.toBe('skipped_claim');
    });
  });

  describe('listBenchmarkClaims', () => {
    it('returns all hosts currently claimed', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A, 60_000);
      const claims = await service.listBenchmarkClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].hostUrl).toBe(HOST_URL);
      expect(claims[0].batchId).toBe(BATCH_A);
      expect(claims[0].source).toBe('manual');
    });

    it('returns empty array when no claims active', async () => {
      const claims = await service.listBenchmarkClaims();
      expect(claims).toEqual([]);
    });
  });

  describe('hasActiveBenchmarkClaim', () => {
    it('returns false for null/undefined pref', () => {
      expect(service.hasActiveBenchmarkClaim(null)).toBe(false);
      expect(service.hasActiveBenchmarkClaim(undefined)).toBe(false);
    });

    it('returns true when status is benchmarking', () => {
      expect(service.hasActiveBenchmarkClaim({ status: 'benchmarking' })).toBe(true);
    });

    it('returns true when benchmarkClaim.batchId is set', () => {
      expect(service.hasActiveBenchmarkClaim({ benchmarkClaim: { batchId: 'b1' } })).toBe(true);
    });

    it('returns false for ready hosts with no claim', () => {
      expect(service.hasActiveBenchmarkClaim({ status: 'ready', benchmarkClaim: null })).toBe(false);
    });
  });
});

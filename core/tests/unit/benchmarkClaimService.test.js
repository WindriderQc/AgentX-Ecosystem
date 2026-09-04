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
  jest.restoreAllMocks();
  await HostPreference.deleteMany({});
});

describe('benchmarkClaimService', () => {
  const HOST_URL = 'http://host1:11434';
  const BATCH_A = 'batch-aaa';
  const BATCH_B = 'batch-bbb';

  test('summarizes only confirmed releases as reaped', () => {
    expect(service.summarizeBenchmarkClaimReaps([
      { hostUrl: 'released', released: true },
      { hostUrl: 'changed', released: false },
      { hostUrl: 'unknown' }
    ])).toEqual({
      released: [{ hostUrl: 'released', released: true }],
      refused: [
        { hostUrl: 'changed', released: false },
        { hostUrl: 'unknown' }
      ]
    });
  });

  beforeEach(async () => {
    await HostPreference.create({
      hostUrl: HOST_URL,
      hostKey: 'primary',
      pinnedModels: [{ model: 'gemma4:26b' }],
      status: 'ready'
    });
    const runtimeSnapshot = {
      capturedAt: new Date(),
      source: 'ollama_ps',
      exact: true,
      residents: [],
      error: null
    };
    runtimeSnapshot.identityDigest = hostPrefService.benchmarkRuntimeSnapshotIdentity(runtimeSnapshot);
    jest.spyOn(hostPrefService, 'captureBenchmarkRuntime').mockResolvedValue(runtimeSnapshot);
    jest.spyOn(hostPrefService, 'restoreBenchmarkRuntime').mockResolvedValue({
      host: HOST_URL,
      status: 'ready',
      verified: true,
      degraded: false,
      mode: 'exact_runtime_snapshot',
      snapshotIdentity: runtimeSnapshot.identityDigest,
      residents: []
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
      expect(result).toMatchObject({
        batchId: BATCH_A,
        prevStatus: 'ready',
        snapshotExact: true,
        snapshotIdentity: result.pref.benchmarkClaim.preClaimRuntime.identityDigest
      });
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
      const first = await service.claimBenchmark(HOST_URL, BATCH_A, 300_000);
      const again = await service.claimBenchmark(HOST_URL, BATCH_A, 999_999, {
        claimGeneration: first.claimGeneration
      });
      expect(again.claimed).toBe(true);
      expect(again.claimGeneration).toBe(first.claimGeneration);
      // prevStatus should still be 'ready' — not overwritten to 'benchmarking'
      expect(again.pref.benchmarkClaim.prevStatus).toBe('ready');
    });

    it('does not let a delayed same-batch reclaim update a newer generation', async () => {
      const first = await service.claimBenchmark(HOST_URL, BATCH_A, 300_000, {
        owner: 'old-owner'
      });
      const originalFindOneAndUpdate = HostPreference.findOneAndUpdate.bind(HostPreference);
      let second;
      const updateSpy = jest.spyOn(HostPreference, 'findOneAndUpdate')
        .mockImplementationOnce((...args) => ({
          lean: async () => {
            updateSpy.mockRestore();
            await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
              skipPinRestore: true,
              claimGeneration: first.claimGeneration
            });
            second = await service.claimBenchmark(HOST_URL, BATCH_A, 600_000, {
              owner: 'new-owner'
            });
            return originalFindOneAndUpdate(...args).lean();
          }
        }));

      const staleReclaim = await service.claimBenchmark(HOST_URL, BATCH_A, 999_999, {
        claimGeneration: first.claimGeneration,
        owner: 'stale-owner'
      });

      expect(staleReclaim.claimed).toBe(false);
      expect(second.claimed).toBe(true);
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.benchmarkClaim.claimGeneration).toBe(second.claimGeneration);
      expect(stored.benchmarkClaim.owner).toBe('new-owner');
      expect(stored.benchmarkClaim.estimatedDurationMs).toBe(600_000);
    });

    it('rejects a claim from a different batch while already benchmarking', async () => {
      await service.claimBenchmark(HOST_URL, BATCH_A);
      const conflict = await service.claimBenchmark(HOST_URL, BATCH_B);
      expect(conflict.claimed).toBe(false);
      expect(conflict.reason).toContain(BATCH_A);
    });

    it('atomically grants exactly one of two concurrent claimants', async () => {
      const [left, right] = await Promise.all([
        service.claimBenchmark(HOST_URL, BATCH_A),
        service.claimBenchmark(HOST_URL, BATCH_B)
      ]);
      expect([left, right].filter(result => result.claimed)).toHaveLength(1);

      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.status).toBe('benchmarking');
      expect([BATCH_A, BATCH_B]).toContain(stored.benchmarkClaim.batchId);
      const winner = left.claimed ? BATCH_A : BATCH_B;
      expect(stored.benchmarkClaim.batchId).toBe(winner);
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

    it('preserves a concurrent ready status while seeding an unknown host', async () => {
      const unknownHost = 'http://unknown-ready-race:11434';
      const originalUpdateOne = HostPreference.updateOne.bind(HostPreference);
      const updateSpy = jest.spyOn(HostPreference, 'updateOne').mockImplementationOnce(async (...args) => {
        await HostPreference.collection.insertOne({
          hostUrl: unknownHost,
          hostKey: 'primary',
          status: 'ready',
          pinnedModels: []
        });
        return originalUpdateOne(...args);
      });

      try {
        const claimed = await service.claimBenchmark(unknownHost, BATCH_A);
        expect(claimed.claimed).toBe(true);
        expect(claimed.pref.benchmarkClaim.prevStatus).toBe('ready');

        const released = await service.releaseBenchmarkClaim(unknownHost, BATCH_A, {
          skipPinRestore: true,
          claimGeneration: claimed.claimGeneration
        });
        expect(released.released).toBe(true);
        const stored = await HostPreference.findOne({ hostUrl: unknownHost }).lean();
        expect(stored.status).toBe('ready');
      } finally {
        updateSpy.mockRestore();
      }
    });

    it('atomically creates one owner when an unknown host is claimed concurrently', async () => {
      const unknownHost = 'http://concurrent-unknown:11434';
      await HostPreference.collection.dropIndex('hostUrl_1').catch((error) => {
        if (error?.codeName !== 'IndexNotFound') throw error;
      });
      const batchIds = Array.from({ length: 32 }, (_, index) => `batch-concurrent-${index}`);
      const results = await Promise.all(
        batchIds.map(id => service.claimBenchmark(unknownHost, id))
      );
      expect(results.filter(result => result.claimed)).toHaveLength(1);
      await expect(HostPreference.countDocuments({ hostUrl: unknownHost })).resolves.toBe(1);

      const stored = await HostPreference.findOne({ hostUrl: unknownHost }).lean();
      expect(stored.status).toBe('benchmarking');
      expect(stored.benchmarkClaim.batchId).toBe(
        results.find(result => result.claimed).pref.benchmarkClaim.batchId
      );
      const hostUrlIndex = (await HostPreference.collection.indexes())
        .find(index => index.name === 'hostUrl_1');
      expect(hostUrlIndex).toMatchObject({ key: { hostUrl: 1 }, unique: true });
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
        claimGeneration: claimed.claimGeneration,
        owner: 'heartbeat-owner',
        heartbeatTtlMs: 90_000
      });

      expect(heartbeat.heartbeat).toBe(true);
      expect(heartbeat).toMatchObject({
        batchId: BATCH_A,
        claimGeneration: claimed.claimGeneration,
        prevStatus: 'ready',
        snapshotExact: true,
        snapshotIdentity: claimed.snapshotIdentity
      });
      expect(new Date(heartbeat.pref.benchmarkClaim.heartbeatAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(heartbeat.pref.benchmarkClaim.owner).toBe('heartbeat-owner');
      expect(heartbeat.pref.benchmarkClaim.heartbeatTtlMs).toBe(90_000);
    });

    it('rejects heartbeat when another batch owns the claim', async () => {
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const heartbeat = await service.heartbeatBenchmarkClaim(HOST_URL, BATCH_B, {
        claimGeneration: claimed.claimGeneration
      });
      expect(heartbeat.heartbeat).toBe(false);
      expect(heartbeat.reason).toContain(BATCH_A);
    });
  });

  describe('releaseBenchmarkClaim', () => {
    it('keeps a pre-upgrade claim fenced when no exact runtime snapshot exists', async () => {
      hostPrefService.restoreBenchmarkRuntime.mockResolvedValueOnce({
        host: HOST_URL,
        status: 'error',
        verified: false,
        degraded: true,
        error: 'Exact pre-claim runtime snapshot is unavailable'
      });
      const claimedAt = new Date(Date.now() - 10 * 60 * 1000);
      await HostPreference.updateOne(
        { hostUrl: HOST_URL },
        {
          $set: {
            status: 'benchmarking',
            pinnedModels: [],
            benchmarkClaim: {
              batchId: 'legacy-batch',
              prevStatus: 'ready',
              claimedAt,
              estimatedDurationMs: null,
              source: 'manual',
              heartbeatAt: null,
              heartbeatTtlMs: null
            }
          }
        }
      );
      await HostPreference.updateOne(
        { hostUrl: HOST_URL },
        { $unset: { 'benchmarkClaim.claimGeneration': 1 } }
      );

      const direct = await service.releaseBenchmarkClaim(HOST_URL, 'legacy-batch');
      expect(direct).toEqual(expect.objectContaining({
        released: false,
        reason: 'claimGeneration is required'
      }));

      const reaped = await service.reapStaleBenchmarkClaims({ hardCapMs: 1000 });
      expect(reaped.reaped).toHaveLength(1);
      expect(reaped.reaped[0].released).toBe(false);
      expect(reaped.reaped[0].reason).toContain('Exact pre-claim runtime snapshot is unavailable');
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.status).toBe('benchmarking');
      expect(stored.benchmarkClaim.batchId).toBe('legacy-batch');
    });

    // Pass skipPinRestore so the async post-release restore doesn't leak
    // a `setHostStatus('restoring')` call into the next test (0175).
    const RELEASE_OPTS = { skipPinRestore: true };
    const releaseOptions = claimed => ({
      ...RELEASE_OPTS,
      claimGeneration: claimed.claimGeneration
    });

    it('restores prevStatus and clears claim fields', async () => {
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, releaseOptions(claimed));
      expect(released.released).toBe(true);
      expect(released.pref.status).toBe('ready');
      expect(released.pref.benchmarkClaim.batchId).toBeNull();
      expect(released.pref.benchmarkClaim.prevStatus).toBeNull();
      expect(released.pref.benchmarkClaim.source).toBeNull();
      expect(released.pref.benchmarkClaim.heartbeatAt).toBeNull();
    });

    it('refuses to release another batch\'s claim', async () => {
      mockObserveClaimReleaseFailure.mockClear();
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const refused = await service.releaseBenchmarkClaim(HOST_URL, BATCH_B, releaseOptions(claimed));
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

    it('does not let a stale release erase a newer claim owner', async () => {
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const originalFindOneAndUpdate = HostPreference.findOneAndUpdate.bind(HostPreference);
      const replacementClaim = {
        batchId: BATCH_B,
        claimGeneration: '11111111-1111-4111-8111-111111111111',
        prevStatus: 'ready',
        claimedAt: new Date(),
        estimatedDurationMs: null,
        source: 'manual',
        owner: null,
        note: null,
        heartbeatAt: new Date(),
        heartbeatTtlMs: null
      };
      const updateSpy = jest.spyOn(HostPreference, 'findOneAndUpdate')
        .mockImplementationOnce((...args) => ({
          lean: async () => {
            await HostPreference.collection.updateOne(
              { hostUrl: HOST_URL },
              { $set: { status: 'benchmarking', benchmarkClaim: replacementClaim } }
            );
            return originalFindOneAndUpdate(...args).lean();
          }
        }));

      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, releaseOptions(claimed));
      updateSpy.mockRestore();

      expect(released.released).toBe(false);
      expect(released.reason).toContain(BATCH_B);
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.status).toBe('benchmarking');
      expect(stored.benchmarkClaim.batchId).toBe(BATCH_B);
    });

    it('returns released=false when host preference missing', async () => {
      mockObserveClaimReleaseFailure.mockClear();
      const res = await service.releaseBenchmarkClaim('http://nohost:11434', BATCH_A, {
        ...RELEASE_OPTS,
        claimGeneration: '22222222-2222-4222-8222-222222222222'
      });
      expect(res.released).toBe(false);
      expect(mockObserveClaimReleaseFailure).toHaveBeenCalledTimes(1);
    });

    it('restores and verifies the exact pre-claim runtime before release', async () => {
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
        claimGeneration: claimed.claimGeneration
      });
      expect(released.released).toBe(true);
      expect(released.runtimeRestore?.status).toBe('ready');
      expect(released.runtimeRestore?.verified).toBe(true);
      expect(hostPrefService.restoreBenchmarkRuntime).toHaveBeenCalledWith(
        HOST_URL,
        expect.objectContaining({ exact: true, residents: [] }),
        expect.objectContaining({
          batchId: BATCH_A,
          claimGeneration: claimed.claimGeneration,
          finalizeToken: expect.any(String)
        })
      );
      expect(released.releaseReceipt).toMatchObject({
        contract: 'agentx.benchmark-claim-release/v1',
        hostUrl: HOST_URL,
        batchId: BATCH_A,
        claimGeneration: claimed.claimGeneration,
        snapshot: {
          identityDigest: claimed.pref.benchmarkClaim.preClaimRuntime.identityDigest,
          appliedIdentityDigest: claimed.pref.benchmarkClaim.preClaimRuntime.identityDigest,
          exact: true,
          residentCount: 0
        },
        verification: {
          ready: true,
          verified: true,
          degraded: false,
          mode: 'exact_runtime_snapshot'
        },
        state: { restoredStatus: 'ready', claimCleared: true, finalizerCleared: true }
      });

      const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(after.status).toBe('ready');
      expect(after.benchmarkClaim?.batchId).toBeNull();
    });

    it('attests only the resident set actually restored after finite TTL expiry', async () => {
      const expiringSnapshot = {
        capturedAt: new Date(),
        source: 'ollama_ps',
        exact: true,
        residents: [{
          model: 'finite:latest',
          digest: 'sha256:finite',
          artifactSize: 8_000_000_000,
          sizeVram: 7_500_000_000,
          contextLength: 32768,
          keepAlive: 1,
          expiresAt: new Date(Date.now() + 10)
        }],
        error: null
      };
      expiringSnapshot.identityDigest = hostPrefService.benchmarkRuntimeSnapshotIdentity(expiringSnapshot);
      hostPrefService.captureBenchmarkRuntime.mockResolvedValueOnce(expiringSnapshot);
      hostPrefService.restoreBenchmarkRuntime.mockImplementationOnce(async (_host, applied) => ({
        host: HOST_URL,
        status: 'ready',
        verified: true,
        degraded: false,
        mode: 'exact_runtime_snapshot',
        snapshotIdentity: applied.identityDigest,
        residents: applied.residents
      }));
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      await new Promise(resolve => setTimeout(resolve, 20));

      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
        claimGeneration: claimed.claimGeneration
      });

      expect(released.released).toBe(true);
      expect(hostPrefService.restoreBenchmarkRuntime).toHaveBeenCalledWith(
        HOST_URL,
        expect.objectContaining({ exact: true, residents: [] }),
        expect.objectContaining({ snapshotAlreadyFiltered: true })
      );
      expect(released.releaseReceipt).toMatchObject({
        snapshot: {
          identityDigest: expiringSnapshot.identityDigest,
          appliedIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          residentCount: 0,
          residents: [],
          excludedModels: [],
          expiredModels: ['finite:latest']
        },
        verification: {
          status: 'ready',
          ready: true,
          verified: true,
          degraded: false,
          mode: 'exact_runtime_snapshot'
        },
        state: {
          restoredStatus: 'ready',
          claimCleared: true,
          finalizerCleared: true
        }
      });
      expect(released.releaseReceipt.snapshot.appliedIdentityDigest)
        .not.toBe(released.releaseReceipt.snapshot.identityDigest);
      expect(released.releaseReceipt.verification.snapshotIdentity)
        .toBe(released.releaseReceipt.snapshot.appliedIdentityDigest);
    });

    it('keeps the fence recoverable when exact runtime restoration fails', async () => {
      hostPrefService.restoreBenchmarkRuntime.mockResolvedValueOnce({
        host: HOST_URL,
        status: 'error',
        verified: false,
        degraded: false,
        error: 'resident context verification failed'
      });
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
        claimGeneration: claimed.claimGeneration
      });

      expect(released).toMatchObject({
        released: false,
        runtimeRestore: { verified: false }
      });
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.status).toBe('benchmarking');
      expect(stored.benchmarkClaim.batchId).toBe(BATCH_A);
      expect(stored.benchmarkClaim.claimGeneration).toBe(claimed.claimGeneration);
    });

    it('keeps the fence when a restore claims success for a different snapshot identity', async () => {
      hostPrefService.restoreBenchmarkRuntime.mockResolvedValueOnce({
        host: HOST_URL,
        status: 'ready',
        verified: true,
        degraded: false,
        mode: 'exact_runtime_snapshot',
        snapshotIdentity: 'f'.repeat(64),
        residents: []
      });
      const claimed = await service.claimBenchmark(HOST_URL, BATCH_A);
      const released = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
        claimGeneration: claimed.claimGeneration
      });

      expect(released).toMatchObject({ released: false });
      expect(released.reason).toContain('restore failed');
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored).toMatchObject({
        status: 'benchmarking',
        benchmarkClaim: {
          batchId: BATCH_A,
          claimGeneration: claimed.claimGeneration,
          finalizeToken: null
        }
      });
    });

    it('linearizes restore and release before a replacement owner can acquire', async () => {
      let finishRestore;
      let expectedSnapshotIdentity;
      const restoreStarted = new Promise(resolve => {
        hostPrefService.restoreBenchmarkRuntime.mockImplementationOnce(async () => {
          resolve();
          await new Promise(done => { finishRestore = done; });
          return {
            host: HOST_URL,
            status: 'ready',
            verified: true,
            degraded: false,
            mode: 'exact_runtime_snapshot',
            snapshotIdentity: expectedSnapshotIdentity,
            residents: []
          };
        });
      });
      const first = await service.claimBenchmark(HOST_URL, BATCH_A);
      expectedSnapshotIdentity = first.pref.benchmarkClaim.preClaimRuntime.identityDigest;
      const releasing = service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
        claimGeneration: first.claimGeneration
      });
      await restoreStarted;

      await expect(service.claimBenchmark(HOST_URL, BATCH_B)).resolves.toMatchObject({ claimed: false });
      finishRestore();
      await expect(releasing).resolves.toMatchObject({ released: true });
      const second = await service.claimBenchmark(HOST_URL, BATCH_B);
      expect(second.claimed).toBe(true);

      const stale = await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, {
        skipPinRestore: true,
        claimGeneration: first.claimGeneration
      });
      expect(stale.released).toBe(false);
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.benchmarkClaim.batchId).toBe(BATCH_B);
      expect(stored.benchmarkClaim.claimGeneration).toBe(second.claimGeneration);
    });

    it('rejects stale same-batch heartbeat and release after a new generation acquires the host', async () => {
      const first = await service.claimBenchmark(HOST_URL, BATCH_A, null, { owner: 'old-owner' });
      await service.releaseBenchmarkClaim(HOST_URL, BATCH_A, releaseOptions(first));
      const second = await service.claimBenchmark(HOST_URL, BATCH_A, null, { owner: 'new-owner' });
      expect(second.claimGeneration).not.toBe(first.claimGeneration);

      const staleHeartbeat = await service.heartbeatBenchmarkClaim(HOST_URL, BATCH_A, {
        claimGeneration: first.claimGeneration,
        owner: 'stale-old'
      });
      const staleRelease = await service.releaseBenchmarkClaim(
        HOST_URL,
        BATCH_A,
        releaseOptions(first)
      );

      expect(staleHeartbeat.heartbeat).toBe(false);
      expect(staleRelease.released).toBe(false);
      const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
      expect(stored.status).toBe('benchmarking');
      expect(stored.benchmarkClaim.claimGeneration).toBe(second.claimGeneration);
      expect(stored.benchmarkClaim.owner).toBe('new-owner');
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

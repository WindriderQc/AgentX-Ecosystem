'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockFind = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockFindOne = jest.fn();
const mockGetBatch = jest.fn();

jest.mock('../../models/HostPreference', () => {
  function Model() {}
  Model.find = mockFind;
  Model.findOne = mockFindOne;
  Model.findOneAndUpdate = mockFindOneAndUpdate;
  Model.updateOne = mockUpdateOne;
  return Model;
});

jest.mock('../../src/services/benchmarkServiceClient', () => ({
  getBenchmarkServiceClient: () => ({
    getBatch: mockGetBatch
  })
}));

const svc = require('../../src/services/hostPreferenceService');
const originalFetch = global.fetch;

function claim({
  hostUrl,
  batchId,
  ageMinutes,
  estimatedMinutes = null,
  source = null,
  heartbeatAgeMinutes = null,
  heartbeatTtlMinutes = null,
  claimGeneration = '11111111-1111-4111-8111-111111111111'
}) {
  const claimedAt = new Date(Date.now() - ageMinutes * 60 * 1000);
  const heartbeatAt = heartbeatAgeMinutes == null
    ? null
    : new Date(Date.now() - heartbeatAgeMinutes * 60 * 1000);
  return {
    _id: `${hostUrl}-id`,
    hostUrl,
    status: 'benchmarking',
    benchmarkClaim: {
      batchId,
      claimGeneration,
      prevStatus: 'ready',
      claimedAt,
      estimatedDurationMs: estimatedMinutes != null ? estimatedMinutes * 60 * 1000 : null,
      source,
      heartbeatAt,
      heartbeatTtlMs: heartbeatTtlMinutes != null ? heartbeatTtlMinutes * 60 * 1000 : null,
      preClaimRuntime: claimGeneration ? (() => {
        const snapshot = {
        schemaVersion: 1,
        exact: true,
        capturedAt: new Date(),
        source: 'ollama_ps',
        residents: []
        };
        snapshot.identityDigest = svc.benchmarkRuntimeSnapshotIdentity(snapshot);
        return snapshot;
      })() : null
    }
  };
}

function mockFindReturning(docs) {
  mockFind.mockReturnValueOnce({ lean: () => Promise.resolve(docs) });
}

// The reaper calls releaseBenchmarkClaim(hostUrl, batchId, { claimGeneration })
// for each stale
// doc. releaseBenchmarkClaim reads the current HostPreference via findOne
// and only releases if batchId matches — so the mock must return a claim
// whose batchId matches whatever the reaper passes in.
function mockReleaseHappyPath(claims) {
  const byHost = new Map(claims.map(c => [c.hostUrl, c]));
  mockFindOne.mockImplementation((q) => ({
    lean: () => Promise.resolve(byHost.get(q.hostUrl) || null)
  }));
  mockFindOneAndUpdate.mockImplementation((query, update) => ({
    lean: () => {
      const current = byHost.get(query.hostUrl);
      if (update?.$set?.['benchmarkClaim.finalizeToken']) {
        const renewed = {
          ...current,
          benchmarkClaim: {
            ...current.benchmarkClaim,
            heartbeatAt: update.$set['benchmarkClaim.heartbeatAt'],
            heartbeatTtlMs: update.$set['benchmarkClaim.heartbeatTtlMs'],
            finalizeToken: update.$set['benchmarkClaim.finalizeToken'],
            finalizingAt: update.$set['benchmarkClaim.finalizingAt']
          }
        };
        byHost.set(query.hostUrl, renewed);
        return Promise.resolve(renewed);
      }
      if (update?.$set?.loadedModels) {
        const restored = { ...current, ...update.$set };
        byHost.set(query.hostUrl, restored);
        return Promise.resolve(restored);
      }
      return Promise.resolve({ hostUrl: query.hostUrl, status: 'ready' });
    }
  }));
}

describe('reapStaleBenchmarkClaims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBatch.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ models: [] }) }));
  });

  afterAll(() => { global.fetch = originalFetch; });

  it('returns zero reaped when no claims exist', async () => {
    mockFindReturning([]);
    mockReleaseHappyPath([]);
    const r = await svc.reapStaleBenchmarkClaims();
    expect(r.reaped).toEqual([]);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('leaves claims under the hard cap untouched', async () => {
    const claims = [claim({ hostUrl: 'h1', batchId: 'b1', ageMinutes: 30 })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    // No estimatedDurationMs → hard cap default 120 min
    const r = await svc.reapStaleBenchmarkClaims();
    expect(r.reaped).toEqual([]);
  });

  it('reaps a claim past the hard cap', async () => {
    const claims = [claim({ hostUrl: 'h-stale', batchId: 'b-stale', ageMinutes: 150 })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    const r = await svc.reapStaleBenchmarkClaims({ hardCapMs: 60 * 60 * 1000 });
    expect(r.reaped).toHaveLength(1);
    expect(r.reaped[0].hostUrl).toBe('h-stale');
    expect(r.reaped[0].batchId).toBe('b-stale');
    expect(r.reaped[0].released).toBe(true);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        'benchmarkClaim.batchId': 'b-stale',
        'benchmarkClaim.claimGeneration': '11111111-1111-4111-8111-111111111111'
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('keeps a stale legacy claim fenced when no exact runtime snapshot exists', async () => {
    const claims = [claim({
      hostUrl: 'h-legacy',
      batchId: 'b-legacy',
      ageMinutes: 150,
      claimGeneration: null
    })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);

    const r = await svc.reapStaleBenchmarkClaims({ hardCapMs: 60 * 60 * 1000 });

    expect(r.reaped).toHaveLength(1);
    expect(r.reaped[0]).toEqual(expect.objectContaining({
      hostUrl: 'h-legacy',
      released: false,
      reason: expect.stringContaining('Exact pre-claim runtime snapshot is unavailable')
    }));
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        'benchmarkClaim.batchId': 'b-legacy',
        'benchmarkClaim.claimGeneration': null,
        'benchmarkClaim.claimedAt': claims[0].benchmarkClaim.claimedAt
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ 'benchmarkClaim.heartbeatTtlMs': expect.any(Number) })
      }),
      { new: true }
    );
  });

  it('does not release a fresh generationless replacement created after the reaper scan', async () => {
    const stale = claim({
      hostUrl: 'h-legacy-race',
      batchId: 'b-legacy-race',
      ageMinutes: 150,
      claimGeneration: null
    });
    const replacement = claim({
      hostUrl: 'h-legacy-race',
      batchId: 'b-legacy-race',
      ageMinutes: 1,
      claimGeneration: null
    });
    mockFindReturning([stale]);
    mockReleaseHappyPath([replacement]);

    const r = await svc.reapStaleBenchmarkClaims({ hardCapMs: 60 * 60 * 1000 });

    expect(r.reaped).toHaveLength(1);
    expect(r.reaped[0]).toEqual(expect.objectContaining({
      hostUrl: 'h-legacy-race',
      released: false,
      reason: 'legacy claim changed since reaper scan'
    }));
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reaps a claim past estimatedDuration × graceFactor', async () => {
    const claims = [claim({ hostUrl: 'h1', batchId: 'b1', ageMinutes: 40, estimatedMinutes: 20 })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    // 20 min estimate × 1.5 = 30 min grace. 40 min age > 30 → reap.
    const r = await svc.reapStaleBenchmarkClaims();
    expect(r.reaped).toHaveLength(1);
  });

  it('reaps a claim when Engine Room says the batch is completed', async () => {
    const claims = [claim({ hostUrl: 'h-complete', batchId: 'b-complete', ageMinutes: 1, estimatedMinutes: 120, source: 'benchmark' })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    mockGetBatch.mockResolvedValue({ _id: 'b-complete', status: 'completed', judge_status: 'completed' });

    const r = await svc.reapStaleBenchmarkClaims();

    expect(r.reaped).toHaveLength(1);
    expect(r.reaped[0].hostUrl).toBe('h-complete');
    expect(r.reaped[0].staleReason).toContain('completed');
  });

  it('keeps a fresh claim when Engine Room says the batch is still running', async () => {
    const claims = [claim({ hostUrl: 'h-running', batchId: 'b-running', ageMinutes: 1, estimatedMinutes: 120, source: 'benchmark' })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    mockGetBatch.mockResolvedValue({ _id: 'b-running', status: 'running', judge_status: 'running' });

    const r = await svc.reapStaleBenchmarkClaims();

    expect(r.reaped).toEqual([]);
  });

  it('does not ask Engine Room about manual non-ObjectId claims', async () => {
    const claims = [claim({ hostUrl: 'h-manual', batchId: 'manual-scout-1', ageMinutes: 1, estimatedMinutes: 120 })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);

    const r = await svc.reapStaleBenchmarkClaims();

    expect(r.reaped).toEqual([]);
    expect(mockGetBatch).not.toHaveBeenCalled();
  });

  it('reaps a manual claim when its heartbeat expires', async () => {
    const claims = [claim({
      hostUrl: 'h-manual-stale',
      batchId: 'manual-scout-stale',
      ageMinutes: 3,
      estimatedMinutes: 120,
      heartbeatAgeMinutes: 2,
      heartbeatTtlMinutes: 1
    })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);

    const r = await svc.reapStaleBenchmarkClaims();

    expect(r.reaped).toHaveLength(1);
    expect(r.reaped[0].staleReason).toBe('claim heartbeat expired');
    expect(mockGetBatch).not.toHaveBeenCalled();
  });

  it('keeps a claim under estimatedDuration × graceFactor', async () => {
    const claims = [claim({ hostUrl: 'h1', batchId: 'b1', ageMinutes: 25, estimatedMinutes: 20 })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    // 20 × 1.5 = 30 min grace. 25 min age < 30 → keep.
    const r = await svc.reapStaleBenchmarkClaims();
    expect(r.reaped).toEqual([]);
  });

  it('handles multiple claims and only reaps the stale ones', async () => {
    const claims = [
      claim({ hostUrl: 'fresh', batchId: 'bf', ageMinutes: 5, estimatedMinutes: 30 }),
      claim({ hostUrl: 'stale', batchId: 'bs', ageMinutes: 180 })
    ];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    const r = await svc.reapStaleBenchmarkClaims();
    expect(r.reaped).toHaveLength(1);
    expect(r.reaped[0].hostUrl).toBe('stale');
  });

  it('skips claims with missing claimedAt (defensive)', async () => {
    const badClaim = {
      hostUrl: 'h-no-ts',
      status: 'benchmarking',
      benchmarkClaim: { batchId: 'bx', prevStatus: 'ready' }
    };
    mockFindReturning([badClaim]);
    mockReleaseHappyPath([badClaim]);
    const r = await svc.reapStaleBenchmarkClaims();
    expect(r.reaped).toEqual([]);
  });

  it('honors custom graceFactor', async () => {
    const claims = [claim({ hostUrl: 'h1', batchId: 'b1', ageMinutes: 22, estimatedMinutes: 20 })];
    mockFindReturning(claims);
    mockReleaseHappyPath(claims);
    // graceFactor 1.0 → 20 min grace. Age 22 > 20 → reap.
    const r = await svc.reapStaleBenchmarkClaims({ graceFactor: 1.0 });
    expect(r.reaped).toHaveLength(1);
  });
});

describe('benchmark claim reaper scheduler', () => {
  afterEach(() => {
    svc.stopBenchmarkClaimReaper();
  });

  it('start is idempotent and stop clears the interval', () => {
    // Start twice — should not double-schedule or throw.
    svc.startBenchmarkClaimReaper();
    svc.startBenchmarkClaimReaper();
    svc.stopBenchmarkClaimReaper();
    // Stop twice — should not throw.
    svc.stopBenchmarkClaimReaper();
  });

  it('exposes a sane default interval', () => {
    const ms = svc.getBenchmarkClaimReaperIntervalMs();
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });
});

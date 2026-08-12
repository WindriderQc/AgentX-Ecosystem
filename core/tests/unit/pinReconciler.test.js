/**
 * Unit Tests for the Pin Reconciler (task 0227)
 *
 * The reconciler (`checkAndReloadDefaults`) and the pin auto-restore
 * grace-period state machine (task 0176) were extracted from
 * hostPreferenceService.js into pinReconciler.js in task 0227. The facade
 * still re-exports them, and tests/unit/hostPreferenceService.test.js
 * continues to exercise them THROUGH the facade. This file exercises the
 * SAME grace-period transitions directly against pinReconciler.js so the
 * "trickiest concurrency logic in core" has focused, isolated coverage that
 * does not depend on the facade re-export.
 *
 * The grace window is driven down to a few ms via setPinRestoreGraceMs so the
 * timing scenarios run in-memory. The host is unreachable (port 11434 has no
 * listener), so `fetch` is mocked per-test to return a controlled `/api/ps`
 * payload.
 */

// Mock logger to suppress output during tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const HostPreference = require('../../models/HostPreference');
const reconciler = require('../../src/services/pinReconciler');

afterEach(async () => {
  await HostPreference.deleteMany({});
});

describe('pinReconciler — pin auto-restore grace period (0176)', () => {
  const HOST_URL = 'http://recon-grace-host:11434';
  const PIN_MODEL = 'gemma4:26b';
  const OTHER_MODEL = 'qwen3.6:27b';
  const originalFetch = global.fetch;
  const originalGrace = reconciler.getPinRestoreGraceMs();

  function mockPs(loadedModelNames) {
    global.fetch = jest.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return {
          ok: true,
          json: async () => ({
            models: loadedModelNames.map(name => (typeof name === 'string' ? { name } : name))
          })
        };
      }
      // /api/generate (warmup) — return ok so the reconciler thinks the warm
      // succeeded and clears the grace stamp.
      return {
        ok: true,
        text: async () => '{}'
      };
    });
  }

  beforeEach(async () => {
    await HostPreference.create({
      hostUrl: HOST_URL,
      hostKey: 'primary',
      pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1 }],
      status: 'ready'
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    reconciler.setPinRestoreGraceMs(originalGrace);
  });

  it('getPinRestoreGraceMs / setPinRestoreGraceMs round-trip', () => {
    reconciler.setPinRestoreGraceMs(4242);
    expect(reconciler.getPinRestoreGraceMs()).toBe(4242);
    reconciler.setPinRestoreGraceMs(-1); // rejected — stays unchanged
    expect(reconciler.getPinRestoreGraceMs()).toBe(4242);
  });

  it('scenario 1 — pin loaded: no grace stamp, no warm', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    mockPs([PIN_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeFalsy();
    expect(after.status).toBe('ready');
  });

  it('scenario 2 — pin first displaced: stamps pinFirstDisplacedAt, no warm', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    mockPs([OTHER_MODEL]);
    const before = Date.now();
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    const stampedAt = new Date(after.pinFirstDisplacedAt).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before - 100);
    expect(stampedAt).toBeLessThanOrEqual(Date.now() + 100);
    expect(after.status).not.toBe('restoring');
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('scenario 3 — pin still in grace: no warm, stamp preserved', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    const stampedAt = new Date(Date.now() - 5_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: stampedAt } }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    expect(new Date(after.pinFirstDisplacedAt).getTime()).toBe(stampedAt.getTime());
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('scenario 4 — pin grace elapsed: warms and clears the stamp', async () => {
    reconciler.setPinRestoreGraceMs(50);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: new Date(Date.now() - 1_000) } }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls.length).toBeGreaterThanOrEqual(1);
    expect(after.pinFirstDisplacedAt).toBeFalsy();
  });

  it('clears stamp when displacement resolves before grace elapses', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: new Date(Date.now() - 5_000) } }
    );
    mockPs([PIN_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeFalsy();
  });

  it('claim short-circuits before the grace check fires (defense in depth)', async () => {
    reconciler.setPinRestoreGraceMs(50);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      {
        $set: {
          status: 'benchmarking',
          benchmarkClaim: {
            batchId: 'batch-x',
            prevStatus: 'ready',
            claimedAt: new Date(),
            estimatedDurationMs: 60_000
          }
        }
      }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeFalsy();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
    expect(after.status).toBe('benchmarking');
  });

  it('treats a loaded pin with the wrong context as displaced', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      {
        $set: {
          pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1, contextSize: 65536 }]
        }
      }
    );
    mockPs([{ name: PIN_MODEL, context_length: 32768 }]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });
});

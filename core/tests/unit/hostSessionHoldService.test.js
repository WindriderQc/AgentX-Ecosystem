/**
 * Unit tests for host session holds.
 *
 * A trusted extension keeps one model resident on one host for an interactive
 * session. These tests cover the hold lifecycle (acquire / touch / release /
 * idle expiry), its interaction with benchmark claims, the admission-guard
 * predicate, and the status projection a surface uses to show "loading".
 *
 * Warm-up is injected: the real path goes through exclusive admission and
 * `prepareExclusiveModel`, which needs a live host. Residency is read from a
 * mocked `/api/ps`. The context tests inject the admitted executor instead so
 * the exact warm-up payload (num_ctx, keep_alive) is asserted.
 */

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));
jest.mock('../../src/services/laneObservabilityService', () => ({
  observeClaimReleaseFailure: jest.fn(),
  observePinRestoreFailure: jest.fn()
}));

const HostPreference = require('../../models/HostPreference');
const service = require('../../src/services/hostSessionHoldService');
const hostPrefService = require('../../src/services/hostPreferenceService');

const HOST_URL = 'http://session-hold-host:11434';
const PIN_MODEL = 'qwen3.8:27b-mtp-q8_0';
const HOLD_MODEL = 'huihui_ai/Qwen3.8-abliterated:27b-q8_0';
const OWNER = 'aio-ops-household/personal_operator/open';

const originalFetch = global.fetch;

// Entries are model names or `/api/ps` rows (`{ name, context_length }`).
function mockPs(loadedModels) {
  const models = loadedModels.map((entry) => (typeof entry === 'string' ? { name: entry } : entry));
  global.fetch = jest.fn(async (url) => {
    if (typeof url === 'string' && url.endsWith('/api/ps')) {
      return { ok: true, json: async () => ({ models }) };
    }
    return { ok: true, text: async () => '{"done":true}' };
  });
}

// Real warm-up path with the admitted executor stubbed: captures the payload.
function executorDeps(executeAdmittedOllamaAttempt) {
  return {
    executeAdmittedOllamaAttempt,
    hostPreferenceService: { prepareExclusiveModel: jest.fn(async () => ({ status: 'ready' })) }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  service.resetWarmStateForTests();
  await HostPreference.create({
    hostUrl: HOST_URL,
    hostKey: 'primary',
    displayName: 'UGAlien',
    pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1 }],
    status: 'ready'
  });
  mockPs([PIN_MODEL]);
});

afterEach(async () => {
  global.fetch = originalFetch;
  await HostPreference.deleteMany({});
});

describe('hostSessionHoldService', () => {
  it('acquires a hold, records the idle window, and starts the warm-up', async () => {
    // A warm-up that never settles keeps the phase at "loading" for the assertion.
    const warm = jest.fn(() => new Promise(() => {}));
    const before = Date.now();
    const status = await service.acquireSessionHold(HOST_URL, {
      owner: OWNER, model: HOLD_MODEL, idleTtlMs: 10 * 60_000
    }, { warm });

    expect(status.hold).toMatchObject({ owner: OWNER, model: HOLD_MODEL, idleTtlMs: 600_000 });
    expect(status.hold.holdId).toEqual(expect.any(String));
    expect(new Date(status.hold.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 600_000 - 50);
    expect(status.modelResident).toBe(false);
    expect(status.pinResident).toBe(true);
    expect(status.phase).toBe('loading');
    expect(warm).toHaveBeenCalledWith(HOST_URL, expect.objectContaining({ model: HOLD_MODEL }), expect.any(Object));

    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(stored.sessionHold.holdId).toBe(status.hold.holdId);
    expect(service.hasActiveSessionHold(stored)).toBe(true);
  });

  it('reports resident once Ollama lists the held model and does not warm again', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    mockPs([HOLD_MODEL]);
    const status = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    expect(status.phase).toBe('resident');
    expect(status.modelResident).toBe(true);
    expect(status.pinResident).toBe(false);
    expect(warm).not.toHaveBeenCalled();
  });

  it('is idempotent for the same owner and keeps the hold id', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    const first = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    const second = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    expect(second.hold.holdId).toBe(first.hold.holdId);
    expect(second.hold.claimedAt).toBe(first.hold.claimedAt);
  });

  it('refuses a second owner while the hold is active', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    await expect(service.acquireSessionHold(HOST_URL, { owner: 'someone-else', model: PIN_MODEL }, { warm }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_BUSY', statusCode: 409 });
  });

  it('refuses a hold while a benchmark claim owns the host', async () => {
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { status: 'benchmarking', benchmarkClaim: { batchId: 'batch-1', claimedAt: new Date() } } }
    );
    await expect(service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm: async () => {} }))
      .rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 503, batchId: 'batch-1' });
  });

  it('rejects an unknown host and malformed input', async () => {
    await expect(service.acquireSessionHold('http://nowhere:11434', { owner: OWNER, model: HOLD_MODEL }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_HOST_UNKNOWN', statusCode: 404 });
    await expect(service.acquireSessionHold(HOST_URL, { owner: 'bad owner!', model: HOLD_MODEL }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_INVALID', statusCode: 400 });
    await expect(service.acquireSessionHold(HOST_URL, { owner: OWNER, model: '' }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_INVALID', statusCode: 400 });
    await expect(service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, idleTtlMs: -5 }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_INVALID', statusCode: 400 });
  });

  it('bounds the idle window', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    const tiny = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, idleTtlMs: 5 }, { warm });
    expect(tiny.hold.idleTtlMs).toBe(service.MIN_IDLE_TTL_MS);
    await service.releaseSessionHold(HOST_URL, tiny.hold.holdId);
    const huge = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, idleTtlMs: 99 * 60 * 60_000 }, { warm });
    expect(huge.hold.idleTtlMs).toBe(service.MAX_IDLE_TTL_MS);
  });

  it('touch pushes the expiry forward by the idle window', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, idleTtlMs: 120_000 }, { warm });
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { 'sessionHold.expiresAt': new Date(Date.now() + 30_000) } }
    );
    const touched = await service.touchSessionHold(HOST_URL, acquired.hold.holdId, { owner: OWNER }, { warm });
    expect(new Date(touched.hold.expiresAt).getTime()).toBeGreaterThan(Date.now() + 100_000);
    await expect(service.touchSessionHold(HOST_URL, 'not-a-hold', {}, { warm }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_NOT_FOUND', statusCode: 404 });
    await expect(service.touchSessionHold(HOST_URL, acquired.hold.holdId, { owner: 'someone-else' }, { warm }))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_NOT_FOUND', statusCode: 404 });
  });

  it('touch re-warms a held model that was evicted', async () => {
    const warm = jest.fn(() => new Promise(() => {}));
    mockPs([HOLD_MODEL]);
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    expect(warm).not.toHaveBeenCalled();
    mockPs([PIN_MODEL]);
    const touched = await service.touchSessionHold(HOST_URL, acquired.hold.holdId, {}, { warm });
    expect(warm).toHaveBeenCalledTimes(1);
    expect(touched.phase).toBe('loading');
  });

  it('release clears the hold and forfeits the remaining pin grace', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    const released = await service.releaseSessionHold(HOST_URL, acquired.hold.holdId);
    expect(released).toEqual({ host: HOST_URL, holdId: acquired.hold.holdId, released: true });
    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(stored.sessionHold.holdId).toBeNull();
    expect(new Date(stored.pinFirstDisplacedAt).getTime()).toBe(0);
    const again = await service.releaseSessionHold(HOST_URL, acquired.hold.holdId);
    expect(again.released).toBe(false);
    const status = await service.getSessionHoldStatus(HOST_URL);
    expect(status.hold).toBeNull();
    expect(status.phase).toBe('none');
  });

  it('an expired hold is inactive and is cleared by the reconciler helper', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { 'sessionHold.expiresAt': new Date(Date.now() - 1_000) } }
    );
    const stale = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(service.hasActiveSessionHold(stale)).toBe(false);
    expect(await service.getActiveSessionHold(HOST_URL)).toBeNull();
    const refreshed = await service.expireStaleSessionHold(stale);
    expect(refreshed.sessionHold.holdId).toBeNull();
    expect(new Date(refreshed.pinFirstDisplacedAt).getTime()).toBe(0);
    // A new owner can acquire immediately after expiry.
    const next = await service.acquireSessionHold(HOST_URL, { owner: 'other-owner', model: HOLD_MODEL }, { warm });
    expect(next.hold.holdId).not.toBe(acquired.hold.holdId);
  });

  it('pin warming and restore paths skip a held host', async () => {
    const warm = jest.fn(() => new Promise(() => {}));
    await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    global.fetch.mockClear();
    const warmed = await hostPrefService.warmHost(HOST_URL);
    expect(warmed).toEqual([expect.objectContaining({ model: PIN_MODEL, status: 'skipped_hold', holdOwner: OWNER })]);
    const restored = await hostPrefService.restorePinnedModels(HOST_URL);
    expect(restored).toMatchObject({ status: 'skipped_hold', holdOwner: OWNER });
    const generateCalls = global.fetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(stored.status).toBe('ready');
  });

  it('status re-warms an active hold whose model is gone and no warm-up is running', async () => {
    const warm = jest.fn(() => new Promise(() => {}));
    mockPs([HOLD_MODEL]);
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    expect(acquired.phase).toBe('resident');
    expect(warm).not.toHaveBeenCalled();
    // Core restarted: in-memory warm state is gone and Ollama no longer lists the model.
    service.resetWarmStateForTests();
    mockPs([PIN_MODEL]);
    const status = await service.getSessionHoldStatus(HOST_URL, { deps: { warm } });
    expect(warm).toHaveBeenCalledTimes(1);
    expect(status.phase).toBe('loading');
    expect(status.hold.holdId).toBe(acquired.hold.holdId);
    // A second read while the warm-up is in flight does not start another one.
    await service.getSessionHoldStatus(HOST_URL, { deps: { warm } });
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-process mirror the watchdog can read without the database', async () => {
    const warm = jest.fn(() => new Promise(() => {}));
    expect(service.isHostHeld(HOST_URL)).toBeNull();
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    expect(service.isHostHeld(HOST_URL)).toMatchObject({ holdId: acquired.hold.holdId, model: HOLD_MODEL });
    // A restart empties the mirror; a reconciler observation of the stored hold refills it.
    service.resetWarmStateForTests();
    expect(service.isHostHeld(HOST_URL)).toBeNull();
    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(service.observeSessionHold(stored)).toMatchObject({ holdId: acquired.hold.holdId });
    expect(service.isHostHeld(HOST_URL)).toMatchObject({ holdId: acquired.hold.holdId });
    // Expiry is honoured without a database read.
    expect(service.isHostHeld(HOST_URL, Date.now() + 2 * service.DEFAULT_IDLE_TTL_MS)).toBeNull();
    expect(service.isHostHeld(HOST_URL)).toBeNull();
    expect(service.observeSessionHold(stored)).toMatchObject({ holdId: acquired.hold.holdId });
    await service.releaseSessionHold(HOST_URL, acquired.hold.holdId);
    expect(service.isHostHeld(HOST_URL)).toBeNull();
  });

  it('carries the session context into the persisted hold and the warm-up payload', async () => {
    const executeAdmittedOllamaAttempt = jest.fn(async () => ({ ok: true, status: 200 }));
    const deps = executorDeps(executeAdmittedOllamaAttempt);
    const status = await service.acquireSessionHold(HOST_URL, {
      owner: OWNER, model: HOLD_MODEL, numCtx: 8192
    }, deps);
    await settle();
    expect(status.hold.numCtx).toBe(8192);
    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(stored.sessionHold.numCtx).toBe(8192);
    expect(executeAdmittedOllamaAttempt).toHaveBeenCalledTimes(1);
    const call = executeAdmittedOllamaAttempt.mock.calls[0][0];
    expect(call).toMatchObject({ hostUrl: HOST_URL, model: HOLD_MODEL, exclusive: true, admissionKind: 'session-hold-warm' });
    expect(call.payload).toEqual({
      model: HOLD_MODEL, prompt: 'warmup', stream: false, keep_alive: -1,
      options: { num_predict: 1, num_ctx: 8192 }
    });
  });

  it('touch re-warms an evicted held model at the persisted session context', async () => {
    const executeAdmittedOllamaAttempt = jest.fn(() => new Promise(() => {}));
    const deps = executorDeps(executeAdmittedOllamaAttempt);
    mockPs([{ name: HOLD_MODEL, context_length: 8192 }]);
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 8192 }, deps);
    expect(acquired.phase).toBe('resident');
    expect(executeAdmittedOllamaAttempt).not.toHaveBeenCalled();
    // Core restarted (in-memory warm state gone) and Ollama evicted the model.
    service.resetWarmStateForTests();
    mockPs([PIN_MODEL]);
    const touched = await service.touchSessionHold(HOST_URL, acquired.hold.holdId, { owner: OWNER }, deps);
    await settle();
    expect(touched.phase).toBe('loading');
    expect(touched.hold.numCtx).toBe(8192);
    expect(executeAdmittedOllamaAttempt).toHaveBeenCalledTimes(1);
    expect(executeAdmittedOllamaAttempt.mock.calls[0][0].payload.options).toEqual({ num_predict: 1, num_ctx: 8192 });
  });

  it('omits num_ctx from the warm-up and reports residency by name when no context is supplied', async () => {
    const executeAdmittedOllamaAttempt = jest.fn(() => new Promise(() => {}));
    const deps = executorDeps(executeAdmittedOllamaAttempt);
    const status = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, deps);
    await settle();
    expect(status.hold.numCtx).toBeNull();
    expect(status.phase).toBe('loading');
    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(stored.sessionHold.numCtx).toBeNull();
    expect(executeAdmittedOllamaAttempt.mock.calls[0][0].payload).toEqual({
      model: HOLD_MODEL, prompt: 'warmup', stream: false, keep_alive: -1, options: { num_predict: 1 }
    });
    // Whatever context the model is loaded at satisfies a context-free hold.
    mockPs([{ name: HOLD_MODEL, context_length: 262144 }]);
    const resident = await service.getSessionHoldStatus(HOST_URL);
    expect(resident.phase).toBe('resident');
    expect(resident.residentContextLength).toBe(262144);
    await expect(service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 0 }, deps))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_INVALID', statusCode: 400 });
    await expect(service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 'lots' }, deps))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_INVALID', statusCode: 400 });
    await expect(service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 4096.5 }, deps))
      .rejects.toMatchObject({ code: 'HOST_SESSION_HOLD_INVALID', statusCode: 400 });
  });

  it('a held model resident at another context is not resident and is re-warmed at the hold context', async () => {
    const warm = jest.fn(() => new Promise(() => {}));
    mockPs([{ name: HOLD_MODEL, context_length: 262144 }]);
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 8192 }, { warm });
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm.mock.calls[0][1]).toMatchObject({ holdId: acquired.hold.holdId, model: HOLD_MODEL, numCtx: 8192 });
    expect(acquired.phase).toBe('loading');
    expect(acquired.modelResident).toBe(false);
    expect(acquired.residentContextLength).toBe(262144);
    // Once Ollama reports the hold context the model is resident and nothing re-warms.
    service.resetWarmStateForTests();
    mockPs([{ name: HOLD_MODEL, context_length: 8192 }]);
    const status = await service.getSessionHoldStatus(HOST_URL, { deps: { warm } });
    expect(status.phase).toBe('resident');
    expect(status.modelResident).toBe(true);
    expect(status.residentContextLength).toBe(8192);
    expect(warm).toHaveBeenCalledTimes(1);
    // A status read after a Core restart heals a wrong-context residency too.
    service.resetWarmStateForTests();
    mockPs([{ name: HOLD_MODEL, context_length: 262144 }]);
    const healed = await service.getSessionHoldStatus(HOST_URL, { deps: { warm } });
    expect(healed.phase).toBe('loading');
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm.mock.calls[1][1].numCtx).toBe(8192);
  });

  it('does not re-warm on every touch when Ollama reports another context after Core warmed the hold', async () => {
    const warm = jest.fn(async () => ({ ok: true }));
    // e.g. Ollama capped an oversized request: the reported context never equals the hold's.
    mockPs([{ name: HOLD_MODEL, context_length: 4096 }]);
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 8192 }, { warm });
    await settle();
    expect(warm).toHaveBeenCalledTimes(1);
    const touched = await service.touchSessionHold(HOST_URL, acquired.hold.holdId, { owner: OWNER }, { warm });
    expect(warm).toHaveBeenCalledTimes(1);
    expect(touched.phase).toBe('resident');
    expect(touched.modelResident).toBe(true);
    expect(touched.residentContextLength).toBe(4096);
    const status = await service.getSessionHoldStatus(HOST_URL, { deps: { warm } });
    expect(status.phase).toBe('resident');
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('a same-owner re-acquire with a new context keeps the hold id and re-warms at that context', async () => {
    const warm = jest.fn(() => new Promise(() => {}));
    mockPs([{ name: HOLD_MODEL, context_length: 8192 }]);
    const first = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 8192 }, { warm });
    expect(first.phase).toBe('resident');
    expect(warm).not.toHaveBeenCalled();
    const second = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL, numCtx: 16384 }, { warm });
    expect(second.hold.holdId).toBe(first.hold.holdId);
    expect(second.hold.numCtx).toBe(16384);
    expect(second.phase).toBe('loading');
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm.mock.calls[0][1].numCtx).toBe(16384);
    const stored = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(stored.sessionHold.numCtx).toBe(16384);
  });

  it('holdBlocksModel allows only the held model', () => {
    const hold = { model: HOLD_MODEL };
    expect(service.holdBlocksModel(hold, HOLD_MODEL)).toBe(false);
    expect(service.holdBlocksModel(hold, PIN_MODEL)).toBe(true);
    expect(service.holdBlocksModel(hold, null)).toBe(true);
    expect(service.holdBlocksModel(null, PIN_MODEL)).toBe(false);
    const error = service.buildSessionHoldError(HOST_URL, { ...hold, owner: OWNER, expiresAt: new Date(Date.now() + 5_000) });
    expect(error).toMatchObject({ code: 'HOST_SESSION_HOLD_ACTIVE', statusCode: 503, holdOwner: OWNER, holdModel: HOLD_MODEL });
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  it('surfaces a failed warm-up as the error phase without dropping the hold', async () => {
    const warm = jest.fn(async () => { throw Object.assign(new Error('host busy'), { code: 'HOST_SESSION_HOLD_WARM_BUSY' }); });
    const acquired = await service.acquireSessionHold(HOST_URL, { owner: OWNER, model: HOLD_MODEL }, { warm });
    await new Promise((resolve) => setImmediate(resolve));
    const status = await service.getSessionHoldStatus(HOST_URL);
    expect(status.hold.holdId).toBe(acquired.hold.holdId);
    expect(status.phase).toBe('error');
    expect(status.warm.error).toBe('host busy');
  });
});

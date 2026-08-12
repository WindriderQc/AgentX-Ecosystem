/**
 * Degraded retry wiring — task 0523 last mile.
 *
 * The point of these tests is the one I got wrong before: proving the feature
 * flag actually reaches live code. `DEGRADED_FALLBACK` shipped with policy and
 * tests but nothing invoking it, so it could be switched on in production and
 * change nothing. A flag that looks live and is inert is worse than no flag.
 *
 * So the assertions are deliberately end-to-end through the real route: flag on
 * means a real second upstream call and a degraded response; flag off means the
 * original error, unchanged, with exactly one telemetry row.
 */

const express = require('express');
const request = require('supertest');
const fetch = require('node-fetch');

jest.mock('node-fetch');

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://primary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn((url) => {
    if (!url) return null;
    if (url.includes('primary')) return 'primary';
    if (url.includes('secondary')) return 'secondary';
    if (url.includes('tertiary')) return 'tertiary';
    return null;
  }),
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: {
    primary: 'http://primary:11434',
    secondary: 'http://secondary:11434',
    tertiary: 'http://tertiary:11434',
  },
  TASK_MODELS: { quick_chat: { model: 'test-model', host: 'primary' } },
  buildRouterConfigPayload: jest.fn(),
  ensureTaskModelOverridesLoaded: jest.fn(),
  getAdvisoryModelForTask: jest.fn(async () => ({ model: 'test-model', url: 'http://primary:11434', host: 'primary' })),
  getDefaultTaskModels: jest.fn(() => ({})),
  getModelForTask: jest.fn(() => ({ model: 'test-model', host: 'primary' })),
  resolvePreferredTaskEntry: jest.fn(),
  resetAllTaskModelOverrides: jest.fn(),
  resetTaskModelOverride: jest.fn(),
  saveTaskModelOverride: jest.fn(),
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: { stage: 'available' } })),
  isReadyStage: jest.fn(() => true),
}));

const HOST_PREFS = [
  {
    hostUrl: 'http://primary:11434', hostKey: 'primary', status: 'ready',
    live: { online: true }, loadedModels: ['test-model'], pinnedModels: [],
  },
  {
    hostUrl: 'http://secondary:11434', hostKey: 'secondary', status: 'ready',
    live: { online: true }, loadedModels: ['test-model'], pinnedModels: [],
  },
];

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => HOST_PREFS),
  getByHost: jest.fn(async () => null),
  getPinnedEntries: jest.fn(() => []),
  resolvePinnedRuntimeOptions: jest.fn((pref, model, options, callerKeepAlive) => {
    const runtimeOptions = { ...(options || {}) };
    const pinnedEntry = (pref?.pinnedModels || []).find((entry) => entry.model === model) || null;
    let keepAlive = callerKeepAlive;
    let numCtxSource = runtimeOptions.num_ctx != null ? 'caller' : 'modelfile';
    if (pinnedEntry) {
      if (runtimeOptions.num_ctx == null && Number(pinnedEntry.contextSize) > 0) {
        runtimeOptions.num_ctx = Number(pinnedEntry.contextSize);
        numCtxSource = 'host_preference_pin';
      }
      if (keepAlive === undefined) keepAlive = pinnedEntry.keepAlive ?? -1;
    }
    return { options: runtimeOptions, keepAlive, numCtxSource, pinnedEntry };
  }),
  hasActiveBenchmarkClaim: jest.fn(() => false),
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn(),
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const hostGate = require('../../src/services/hostGate');
const { recordInference } = require('../../src/services/modelRouter');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const apiRoutes = require('../../routes/api');

/** Primary refuses the connection; secondary answers. */
function mockPrimaryDownSecondaryUp(capture = {}) {
  fetch.mockImplementation((url, opts = {}) => {
    if (typeof url === 'string' && url.includes('/api/show')) {
      const requested = JSON.parse(opts.body || '{}').name;
      return Promise.resolve({
        ok: url.includes('secondary') && requested === 'test-model',
        status: url.includes('secondary') && requested === 'test-model' ? 200 : 404,
      });
    }
    if (typeof url === 'string' && url.includes('secondary')) {
      capture.secondaryPayload = JSON.parse(opts.body || '{}');
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          model: 'test-model', response: 'fallback answer', done: true,
          prompt_eval_count: 7, eval_count: 3,
        }),
      });
    }
    return Promise.reject(new Error('connection refused'));
  });
}

function mockPrimaryHttpSecondaryUp(status, error, capture = {}) {
  fetch.mockImplementation((url, opts = {}) => {
    if (typeof url === 'string' && url.includes('/api/show')) {
      const requested = JSON.parse(opts.body || '{}').name;
      return Promise.resolve({
        ok: url.includes('secondary') && requested === 'test-model',
        status: url.includes('secondary') && requested === 'test-model' ? 200 : 404,
      });
    }
    if (String(url).includes('secondary')) {
      capture.secondaryPayload = JSON.parse(opts.body || '{}');
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'test-model', response: 'fallback answer', done: true,
          prompt_eval_count: 7, eval_count: 3,
        }),
      });
    }
    return Promise.resolve({
      ok: false,
      status,
      text: async () => JSON.stringify({ error }),
    });
  });
}

describe('degraded retry wiring (0523)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  const ORIGINAL = process.env.DEGRADED_FALLBACK;
  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.DEGRADED_FALLBACK;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEGRADED_FALLBACK;
    else process.env.DEGRADED_FALLBACK = ORIGINAL;
  });

  test('flag OFF: the original error surfaces unchanged, with one telemetry row', async () => {
    mockPrimaryDownSecondaryUp();

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    // Inert by default. Nothing retried, and no second host was contacted.
    expect(recordInference).toHaveBeenCalledTimes(1);
    const contacted = fetch.mock.calls.map((c) => String(c[0]));
    expect(contacted.some((u) => u.includes('secondary'))).toBe(false);
  });

  test('flag ON: a scoped lane retries on the healthy host and returns degraded', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryDownSecondaryUp();

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(200);

    // The flag reaches live code — this is the assertion that would have caught
    // the earlier "enabled but wired to nothing" mistake.
    const contacted = fetch.mock.calls.map((c) => String(c[0]));
    expect(contacted.some((u) => u.includes('secondary'))).toBe(true);

    expect(res.headers['x-agentx-degraded']).toBe('true');
    expect(res.headers['x-agentx-degraded-reason']).toBe('connection_failure');
    expect(res.headers['x-routed-host-key']).toBe('secondary');
    expect(res.headers['x-agentx-response-mode']).toBe('normalized');
    expect(res.body.agentx_normalized).toBe(true);
    expect(res.body.agentx_contract).toBeDefined();
    expect(res.body.agentx_degraded).toMatchObject({
      degraded: true,
      degradedReason: 'connection_failure',
      cloudEscalated: false,
    });
  });

  test('flag ON: each upstream call gets its own telemetry row, not one per request', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryDownSecondaryUp();

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(200);

    // Two attempts means two rows — the failed one and the successful retry.
    // Collapsing them would hide the failure; duplicating the request would
    // inflate usage. `attempt` is what distinguishes them.
    expect(recordInference).toHaveBeenCalledTimes(2);
    expect(recordInference).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: 'error', routedHostUrl: 'http://primary:11434',
    }));
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'success',
      attempt: 2,
      fallbackUsed: true,
      fallbackReason: 'connection_failure',
      routedHostUrl: 'http://secondary:11434',
      tokensIn: 7,
      tokensOut: 3,
    }));
  });

  test.each([
    [503, 'temporarily unavailable', 'upstream_unavailable'],
    [404, "model 'test-model' not found", 'missing_artifact_verified'],
  ])('flag ON: HTTP %s reaches the documented degraded class', async (status, error, reason) => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryHttpSecondaryUp(status, error);

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(200);

    expect(res.headers['x-agentx-degraded-reason']).toBe(reason);
    expect(recordInference).toHaveBeenCalledTimes(2);
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'success',
      fallbackReason: reason,
      routedHostUrl: 'http://secondary:11434',
    }));
  });

  test('flag ON: an unapproved 500 does not retry', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryHttpSecondaryUp(500, 'generation failed');

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(500);

    expect(fetch.mock.calls.some(([url]) => String(url).includes('secondary'))).toBe(false);
    expect(recordInference).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['offline', { status: 'offline', live: { online: false } }],
    ['benchmark-claimed', { status: 'benchmarking', live: { online: true }, benchmarkClaim: { batchId: 'batch-1' } }],
  ])('flag ON: a %s fallback host fails closed', async (_label, secondaryState) => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      { ...HOST_PREFS[1], ...secondaryState },
    ]);
    mockPrimaryDownSecondaryUp();

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => String(url).includes('secondary'))).toBe(false);
  });

  test('flag ON: Host Gamma/tertiary remains excluded from chat fallback', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      {
        hostUrl: 'http://tertiary:11434', hostKey: 'tertiary', status: 'ready',
        live: { online: true }, loadedModels: ['test-model'], pinnedModels: [],
      },
    ]);
    mockPrimaryDownSecondaryUp();

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => String(url).includes('tertiary'))).toBe(false);
  });

  test('flag ON: fallback recalculates pin context and keep-alive for its host', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      {
        ...HOST_PREFS[1],
        pinnedModels: [{ model: 'test-model', contextSize: 8192, keepAlive: -1 }],
      },
    ]);
    const capture = {};
    mockPrimaryDownSecondaryUp(capture);

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(200);

    expect(capture.secondaryPayload.options.num_ctx).toBe(8192);
    expect(capture.secondaryPayload.keep_alive).toBe(-1);
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      num_ctx: 8192,
      num_ctx_source: 'host_preference_pin',
    }));
  });

  test('flag ON: fallback acquires and releases admission on the retry host', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryDownSecondaryUp();

    await request(app)
      .post('/api/inference/generate')
      .send({
        taskType: 'quick_chat', model: 'test-model', prompt: 'hi', callerDetail: 'chat-playground',
      })
      .expect(200);

    const secondary = hostGate.stats().entries['http://secondary:11434::test-model'];
    expect(secondary.totalAcquired).toBe(1);
    expect(secondary.totalReleased).toBe(1);
    expect(secondary.inFlight).toBe(0);
  });

  test('flag ON: an out-of-scope lane does not retry', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryDownSecondaryUp();

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'deep_reasoning', model: 'test-model', prompt: 'hi' })
      .expect(502);

    // A long generation must not silently double its cost.
    const contacted = fetch.mock.calls.map((c) => String(c[0]));
    expect(contacted.some((u) => u.includes('secondary'))).toBe(false);
    expect(recordInference).toHaveBeenCalledTimes(1);
  });

  test('flag ON: a retry that also fails surfaces the ORIGINAL error', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    fetch.mockImplementation((url, opts = {}) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        const requested = JSON.parse(opts.body || '{}').name;
        return Promise.resolve({
          ok: url.includes('secondary') && requested === 'test-model',
          status: url.includes('secondary') && requested === 'test-model' ? 200 : 404,
        });
      }
      if (String(url).includes('secondary')) {
        return Promise.reject(new Error('secondary connection refused'));
      }
      return Promise.reject(new Error('primary connection refused'));
    });

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    // Replacing it with whatever the fallback hit would send an operator
    // chasing the wrong host.
    expect(res.body.message).toContain('primary connection refused');
    expect(recordInference).toHaveBeenCalledTimes(2);
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'error',
      attempt: 2,
      fallbackUsed: true,
      routedHostUrl: 'http://secondary:11434',
      error: 'secondary connection refused',
    }));
  });
});

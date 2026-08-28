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

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/inferenceContractService', () => ({
  hasQualifiedThinkingCapability: jest.fn(() => false),
  resolveInferenceContract: jest.fn(),
  resolveInferenceContractSnapshot: jest.fn(),
}));

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
  getPinnedEntries: jest.fn((pref) => pref?.pinnedModels || []),
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
const logger = require('../../config/logger');
const { recordInference } = require('../../src/services/modelRouter');
const { resolveInferenceContract } = require('../../src/services/inferenceContractService');
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

function qualifiedContract(input, overrides = {}) {
  return {
    version: 'agentx.inference-contract.v1',
    artifact: {
      model: input.model,
      host: input.host,
      hostId: input.host?.includes('secondary') ? 'secondary' : 'primary',
      digest: `sha256:${input.model}`,
      runtimeFingerprint: 'ollama:test',
      identityQualified: true,
    },
    qualification: {
      state: 'profiled',
      qualified: true,
      exactArtifact: true,
      stale: false,
      ...overrides.qualification,
    },
    capabilities: {
      thinking: {
        supported: false,
        recommendedPolicy: 'off',
        visibleFinalAnswer: { qualified: true },
      },
      tools: { supported: null, qualified: false },
      streaming: { supported: null, qualified: false },
    },
    contextBudget: {
      windowTokens: Number(input.requestedNumCtx) || 8192,
      source: input.numCtxSource || 'profiled',
      output: { reservedTokens: Number(input.requestedMaxOutputTokens) || 2048 },
      input: { estimatedTokens: 4, overflowTokens: 0, fits: true, validatedFits: true },
      transformations: {
        truncation: { applied: false },
        condensation: { applied: false },
        upstreamTruncationRisk: false,
      },
      ...overrides.contextBudget,
    },
  };
}

function mockPrimaryDownQualifiedCrossModelUp(capture = {}) {
  fetch.mockImplementation((url, opts = {}) => {
    const target = String(url);
    if (target.includes('/api/show')) {
      const requested = JSON.parse(opts.body || '{}').name;
      const exists = target.includes('secondary') && requested === 'small-model:latest';
      return Promise.resolve({ ok: exists, status: exists ? 200 : 404 });
    }
    if (target.includes('secondary')) {
      capture.secondaryPayload = JSON.parse(opts.body || '{}');
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'small-model:latest',
          response: 'qualified fallback answer',
          done: true,
          prompt_eval_count: 9,
          eval_count: 4,
        }),
      });
    }
    return Promise.reject(new Error('primary connection refused'));
  });
}

describe('degraded retry wiring (0523)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  const ORIGINAL = process.env.DEGRADED_FALLBACK;
  const ORIGINAL_BENCHMARK_TOKEN = process.env.AGENTX_BENCHMARK_TOKEN;
  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.DEGRADED_FALLBACK;
    resolveInferenceContract.mockImplementation(async (input) => qualifiedContract(input));
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEGRADED_FALLBACK;
    else process.env.DEGRADED_FALLBACK = ORIGINAL;
    if (ORIGINAL_BENCHMARK_TOKEN === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = ORIGINAL_BENCHMARK_TOKEN;
  });

  test('flag OFF: the original error surfaces unchanged, with one telemetry row', async () => {
    mockPrimaryDownSecondaryUp();

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    // Inert by default. Nothing retried, and no second host was contacted.
    expect(res.headers['x-agentx-route-outcome']).toBe('fallback_refused');
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
    expect(res.headers['x-agentx-route-outcome']).toBe('fallback_succeeded');
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
      routeDecision: expect.objectContaining({
        selectionSource: 'model_router+degraded-fallback',
        outcome: {
          stage: 'fallback',
          code: 'fallback_succeeded',
          reasonCode: 'connection_failure',
        },
      }),
    }));
    expect(logger.info).toHaveBeenCalledWith(
      '[InferenceProxy] route outcome',
      expect.objectContaining({
        outcomeCode: 'fallback_succeeded',
        routeDecision: expect.objectContaining({
          actual: expect.objectContaining({ host: 'secondary', hostUrl: 'http://secondary:11434' })
        })
      })
    );
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

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(500);

    expect(res.headers['x-agentx-route-outcome']).toBe('fallback_refused');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('secondary'))).toBe(false);
    expect(recordInference).toHaveBeenCalledTimes(1);
    expect(recordInference.mock.calls[0][0].routeDecision.outcome).toEqual(expect.objectContaining({
      code: 'upstream_error', reasonCode: 'upstream_http_500'
    }));
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

  test('cross-model fallback stays inert for proxy traffic without explicit opt-in', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    mockPrimaryDownQualifiedCrossModelUp();

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'large-model:latest', prompt: 'hi', callerDetail: 'openclaw-runtime-bridge' })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => String(url).includes('secondary'))).toBe(false);
    expect(recordInference).toHaveBeenCalledTimes(1);
  });

  test('a direct profiler caller cannot opt out of exact-model execution', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    process.env.AGENTX_BENCHMARK_TOKEN = 'direct-lane-test-token';
    mockPrimaryDownQualifiedCrossModelUp();

    await request(app)
      .post('/api/inference/generate')
      .set('x-agentx-benchmark-token', 'direct-lane-test-token')
      .send({
        model: 'large-model:latest',
        prompt: 'hi',
        callerDetail: 'profiler-host-secondary',
        allowCrossModelFallback: true,
      })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => String(url).includes('secondary'))).toBe(false);
    expect(recordInference).toHaveBeenCalledTimes(1);
  });

  test('opted-in proxy uses only an operator-pinned, exact-qualified alternate and labels it', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      {
        ...HOST_PREFS[1],
        loadedModels: ['small-model:latest'],
        pinnedModels: [{ model: 'small-model:latest', contextSize: 8192, keepAlive: -1 }],
      },
    ]);
    const capture = {};
    mockPrimaryDownQualifiedCrossModelUp(capture);

    const res = await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'large-model:latest',
        prompt: 'hi',
        callerDetail: 'openclaw-runtime-bridge',
        allowCrossModelFallback: true,
      })
      .expect(200);

    expect(capture.secondaryPayload).toMatchObject({
      model: 'small-model:latest',
      keep_alive: -1,
      options: { num_ctx: 8192 },
    });
    expect(resolveInferenceContract).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'small-model:latest',
        host: 'http://secondary:11434',
      }),
      { includeArtifactIdentity: true }
    );
    expect(res.headers).toMatchObject({
      'x-agentx-degraded': 'true',
      'x-agentx-degraded-fallback-type': 'cross_model',
      'x-agentx-degraded-model-changed': 'true',
      'x-agentx-degraded-primary-model': 'large-model:latest',
      'x-agentx-degraded-actual-model': 'small-model:latest',
      'x-resolved-model': 'small-model:latest',
      'x-routed-host-key': 'secondary',
    });
    expect(res.body.agentx_degraded).toMatchObject({
      degraded: true,
      fallbackType: 'cross_model',
      selectionPolicy: 'operator_pinned_exact_artifact',
      modelChanged: true,
      requested: { model: 'large-model:latest' },
      primary: { model: 'large-model:latest', hostUrl: 'http://primary:11434' },
      actual: {
        model: 'small-model:latest',
        hostUrl: 'http://secondary:11434',
        host: 'secondary',
      },
    });
    expect(recordInference).toHaveBeenCalledTimes(2);
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'small-model:latest',
      routedModel: 'small-model:latest',
      routedHostUrl: 'http://secondary:11434',
      fallbackUsed: true,
      routeDecision: expect.objectContaining({
        requested: expect.objectContaining({ model: 'large-model:latest' }),
        primary: expect.objectContaining({ model: 'large-model:latest', host: 'primary' }),
        actual: expect.objectContaining({ model: 'small-model:latest', host: 'secondary' }),
        degraded: true,
      }),
    }));
  });

  test('an installed but unqualified alternate is never dispatched', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      {
        ...HOST_PREFS[1],
        loadedModels: ['small-model:latest'],
        pinnedModels: [{ model: 'small-model:latest', contextSize: 8192, keepAlive: -1 }],
      },
    ]);
    resolveInferenceContract.mockImplementation(async (input) => qualifiedContract(
      input,
      input.model === 'small-model:latest'
        ? { qualification: { qualified: false, exactArtifact: false } }
        : {}
    ));
    mockPrimaryDownQualifiedCrossModelUp();

    await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'large-model:latest',
        prompt: 'hi',
        callerDetail: 'openclaw-runtime-bridge',
        allowCrossModelFallback: true,
      })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => (
      String(url).includes('secondary') && String(url).includes('/api/generate')
    ))).toBe(false);
    expect(recordInference).toHaveBeenCalledTimes(1);
  });

  test('an unpinned alternate is not part of the server-approved policy', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      {
        ...HOST_PREFS[1],
        loadedModels: ['small-model:latest'],
        pinnedModels: [],
      },
    ]);
    mockPrimaryDownQualifiedCrossModelUp();

    await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'large-model:latest',
        prompt: 'hi',
        allowCrossModelFallback: true,
      })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => (
      String(url).includes('secondary') && String(url).includes('/api/generate')
    ))).toBe(false);
  });

  test('a qualified alternate is refused when its own context cannot fit the input', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    hostPreferenceService.getAll.mockResolvedValueOnce([
      HOST_PREFS[0],
      {
        ...HOST_PREFS[1],
        loadedModels: ['small-model:latest'],
        pinnedModels: [{ model: 'small-model:latest', contextSize: 8192, keepAlive: -1 }],
      },
    ]);
    resolveInferenceContract.mockImplementation(async (input) => qualifiedContract(
      input,
      input.model === 'small-model:latest'
        ? {
          contextBudget: {
            input: { estimatedTokens: 9000, overflowTokens: 2856, fits: false, validatedFits: false },
            transformations: {
              truncation: { applied: false },
              condensation: { applied: false },
              upstreamTruncationRisk: true,
            },
          },
        }
        : {}
    ));
    mockPrimaryDownQualifiedCrossModelUp();

    await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'large-model:latest',
        prompt: 'large input',
        allowCrossModelFallback: true,
      })
      .expect(502);

    expect(fetch.mock.calls.some(([url]) => (
      String(url).includes('secondary') && String(url).includes('/api/generate')
    ))).toBe(false);
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
    expect(res.headers['x-agentx-route-outcome']).toBe('fallback_failed');
    expect(recordInference).toHaveBeenCalledTimes(2);
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'error',
      attempt: 2,
      fallbackUsed: true,
      routedHostUrl: 'http://secondary:11434',
      error: 'secondary connection refused',
      routeDecision: expect.objectContaining({
        outcome: {
          stage: 'fallback',
          code: 'fallback_failed',
          reasonCode: 'connection_failure',
        },
      }),
    }));
    const fallbackFailureLog = logger.info.mock.calls.find(([message, details]) => (
      message === '[InferenceProxy] route outcome'
      && details?.outcomeCode === 'fallback_failed'
    ));
    expect(fallbackFailureLog?.[1]?.routeDecision).toMatchObject({
      actual: { model: 'test-model', host: 'secondary', hostUrl: 'http://secondary:11434' },
      outcome: { stage: 'fallback', code: 'fallback_failed' },
    });
  });

  test('flag ON: a fallback timeout keeps the original response but records timeout truthfully', async () => {
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
        return Promise.reject(Object.assign(new Error('secondary timed out'), { name: 'AbortError' }));
      }
      return Promise.reject(new Error('primary connection refused'));
    });

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    expect(res.body).toEqual({ status: 'error', message: 'primary connection refused' });
    expect(res.headers['x-agentx-route-outcome']).toBe('fallback_failed');
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'timeout',
      fallbackReason: 'connection_failure',
      error: 'secondary timed out',
      routeDecision: expect.objectContaining({
        fallbackReason: 'connection_failure',
        degradedReason: 'connection_failure',
        outcome: {
          stage: 'fallback',
          code: 'fallback_failed',
          reasonCode: 'pre_response_timeout',
        },
      }),
    }));
  });

  test('flag ON: a fallback HTTP failure records its own safe status reason', async () => {
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
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve(JSON.stringify({ error: 'secondary unavailable' })),
        });
      }
      return Promise.reject(new Error('primary connection refused'));
    });

    const res = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hi' })
      .expect(502);

    expect(res.body.message).toBe('primary connection refused');
    expect(res.headers['x-agentx-route-outcome']).toBe('fallback_failed');
    expect(recordInference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'error',
      fallbackReason: 'connection_failure',
      routeDecision: expect.objectContaining({
        outcome: expect.objectContaining({ reasonCode: 'upstream_http_503' }),
      }),
    }));
  });
});

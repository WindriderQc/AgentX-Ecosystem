/**
 * Characterization tests for POST /api/inference/generate — task 0524 groundwork.
 *
 * 0524 extracts this handler into a reusable executor "without contract change"
 * and then migrates callers one canary at a time. That requirement is only
 * checkable against an oracle, and the existing suites pin adaptation
 * (inferenceUseAdapted), timeouts (inferenceTimeout) and the host allowlist —
 * not the invariants the card actually names: claims, host gate, cancellation,
 * and exactly-once telemetry.
 *
 * These tests pin CURRENT behaviour deliberately, including anything that later
 * turns out to be wrong. That is what a characterization suite is for: the
 * extraction must be provably behaviour-preserving first, and any correction is
 * a separate, visible change afterwards.
 *
 * The failure mode most worth guarding: an extraction that records telemetry in
 * both the new executor and the old route path. Double-counted inference logs
 * are invisible in a diff, silently corrupt cost and usage analytics, and are
 * very hard to notice after the fact.
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
  resolveHostKey: jest.fn((url) => (url && url.includes('primary') ? 'primary' : null)),
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: { primary: 'http://primary:11434' },
  TASK_MODELS: {},
  buildRouterConfigPayload: jest.fn(),
  ensureTaskModelOverridesLoaded: jest.fn(),
  getAdvisoryModelForTask: jest.fn(),
  getDefaultTaskModels: jest.fn(() => ({})),
  getModelForTask: jest.fn(),
  resolvePreferredTaskEntry: jest.fn(),
  resetAllTaskModelOverrides: jest.fn(),
  resetTaskModelOverride: jest.fn(),
  saveTaskModelOverride: jest.fn(),
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: { stage: 'available' } })),
  isReadyStage: jest.fn((stage) => ['profiled', 'adapted', 'benchmarked'].includes(stage)),
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => []),
  getByHost: jest.fn(async () => null),
  hasActiveBenchmarkClaim: jest.fn((pref) => !!(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId)),
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
const apiRoutes = require('../../routes/api');

/** Ollama answers normally; /api/show 404s so no adapted variant is used. */
function mockOllamaOk(capture = {}) {
  fetch.mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('/api/show')) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    capture.url = url;
    capture.opts = opts;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ model: 'test-model', response: 'hi', done: true }),
      text: async () => JSON.stringify({ model: 'test-model', response: 'hi', done: true }),
    });
  });
}

describe('POST /api/inference/generate — behaviour contract (0524)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  describe('exactly-once telemetry', () => {
    test('a successful request records exactly one inference', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      // The single most important invariant for the extraction. Recording in
      // both the new executor and the old path is invisible in a diff and
      // silently corrupts cost and usage analytics.
      expect(recordInference).toHaveBeenCalledTimes(1);
    });

    test('a failed request also records exactly one inference', async () => {
      fetch.mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/api/show')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.reject(new Error('connection refused'));
      });

      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' });

      expect(recordInference).toHaveBeenCalledTimes(1);
      expect(recordInference).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' })
      );
    });

    test('a request rejected before dispatch records nothing', async () => {
      // Validation failures never reached Ollama, so they are not inferences.
      // An extraction that records on every entry would invent traffic.
      await request(app)
        .post('/api/inference/generate')
        .send({ prompt: 'no model and no taskType' })
        .expect(400);

      expect(recordInference).not.toHaveBeenCalled();
    });

    test('telemetry carries the caller attribution the request supplied', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello', callerDetail: 'nestor/panel/ask' })
        .expect(200);

      expect(recordInference).toHaveBeenCalledWith(
        expect.objectContaining({ callerDetail: 'nestor/panel/ask' })
      );
    });
  });

  describe('host gate', () => {
    test('a non-stream request acquires and releases exactly one slot', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      expect(entry.totalAcquired).toBe(1);
      expect(entry.totalReleased).toBe(1);
      // Leaking a slot starves every other caller for that (host, model).
      expect(entry.inFlight).toBe(0);
    });

    test('the direct lane skips admission entirely', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello', callerDetail: 'benchmark-batch-abc123' })
        .expect(200);

      // Bench/profiler self-sequence per host; admission is ceremony for them.
      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      expect(entry === undefined || entry.totalAcquired === 0).toBe(true);
    });

    test('the interactive lane KEEPS admission', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello', callerDetail: 'chat-playground' })
        .expect(200);

      // Load-bearing: skipping this would let interactive callers cut in line
      // on a cron job mid-call and force model swaps.
      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      expect(entry.totalAcquired).toBe(1);
      expect(entry.inFlight).toBe(0);
    });
  });

  describe('cancellation', () => {
    test('a non-stream request passes an abort signal to the upstream call', async () => {
      const capture = {};
      mockOllamaOk(capture);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      // Without a signal there is no way to stop a hung generation, and the
      // timeout path in inferenceTimeout.api.test.js depends on this wiring.
      expect(capture.opts.signal).toBeDefined();
    });
  });

  describe('request shape', () => {
    test('messages route to /api/chat and prompt routes to /api/generate', async () => {
      const chat = {};
      mockOllamaOk(chat);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
        .expect(200);
      expect(chat.url).toContain('/api/chat');

      jest.clearAllMocks();
      hostGate._resetForTests();
      const generate = {};
      mockOllamaOk(generate);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hi' })
        .expect(200);
      expect(generate.url).toContain('/api/generate');
    });

    test('caller-supplied options survive to the upstream payload', async () => {
      const capture = {};
      mockOllamaOk(capture);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hi', options: { num_ctx: 8192, temperature: 0.2 } })
        .expect(200);

      // Explicit caller options always win — benchmark and profiler sweeps
      // depend on getting exactly what they asked for.
      const payload = JSON.parse(capture.opts.body);
      expect(payload.options.num_ctx).toBe(8192);
      expect(payload.options.temperature).toBe(0.2);
    });

    test('both required-field validations reject before any upstream call', async () => {
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model' })
        .expect(400);
      await request(app)
        .post('/api/inference/generate')
        .send({ prompt: 'hi' })
        .expect(400);

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe('RouteDecision attribution is populated (0519)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  test('every recorded attempt carries a RouteDecision v1', async () => {
    // The gap this closes: the contract shipped with a schema field nothing
    // populated. 403 production calls over 24h carried zero decisions, so 0465
    // alerting had an empty field to read. A shape assertion is not enough —
    // this asserts the field is actually present on the telemetry row.
    mockOllamaOk();
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello', callerDetail: 'nestor/panel/ask' })
      .expect(200);

    const entry = recordInference.mock.calls[0][0];
    expect(entry.routeDecision).toBeTruthy();
    expect(entry.routeDecision.decisionVersion).toBe(1);
    expect(entry.routeDecision.attribution).toMatchObject({
      caller: 'proxy',
      callerDetail: 'nestor/panel/ask',
    });
    expect(entry.routeDecision.selected.model).toBe('test-model');
    expect(entry.routeDecision.fallbackUsed).toBe(false);
  });

  test('a failed attempt is attributed too, not just successful ones', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.reject(new Error('connection refused'));
    });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello' });

    // Failures are exactly the rows an alerting surface most needs attributed.
    const entry = recordInference.mock.calls[0][0];
    expect(entry.routeDecision?.decisionVersion).toBe(1);
  });

  test('the decision carries no prompt or response payload', async () => {
    mockOllamaOk();
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'a secret question' })
      .expect(200);

    // 30-day retention on inferencelogs — a leak here would quietly build a
    // transcript archive. buildRouteDecision enforces this, and persisting it
    // per request is exactly when that guarantee has to hold.
    const serialized = JSON.stringify(recordInference.mock.calls[0][0].routeDecision);
    expect(serialized).not.toContain('a secret question');
  });
});

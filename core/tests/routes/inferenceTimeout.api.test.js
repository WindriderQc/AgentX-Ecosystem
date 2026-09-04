// Set timeout env BEFORE any module require so the module-level constant picks it up
process.env.INFERENCE_FETCH_TIMEOUT_MS = '500';

const express = require('express');
const http = require('http');
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
    return null;
  })
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
  saveTaskModelOverride: jest.fn()
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({
    readiness: { stage: 'available', benchmarkQualified: false, stale: false, isReady: false }
  }))
}));

jest.mock('../../src/services/inferenceAdmissionService', () => ({
  beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
    signal: signal || new AbortController().signal,
    markDispatched: jest.fn(),
    assertActive: jest.fn(),
    complete: jest.fn(async () => ({ released: true })),
    abandon: jest.fn(async () => ({ released: true })),
  })),
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => []),
  getByHost: jest.fn(async () => null),
  hasActiveBenchmarkClaim: jest.fn((pref) => !!(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId)),
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn()
}));

jest.mock('../../src/services/buddyEvents', () => ({
  emit: jest.fn()
}));

jest.mock('../../src/services/alertService', () => ({
  getAlertService: jest.fn(() => null)
}));

const hostGate = require('../../src/services/hostGate');
const { recordInference } = require('../../src/services/modelRouter');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const apiRoutes = require('../../routes/api');

function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error('Timed out waiting for inference request state'));
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function openInferenceRequest(server, body) {
  const encoded = JSON.stringify(body);
  const address = server.address();
  const clientRequest = http.request({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/inference/generate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(encoded),
    },
  });
  // Destroying the request is intentional in disconnect tests.
  clientRequest.on('error', () => {});
  clientRequest.end(encoded);
  return clientRequest;
}

function benchmarkEvidenceResponse(url) {
  if (!String(url).includes('/api/profiler/evidence/')) return null;
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: null }),
  });
}

describe('POST /api/inference/generate — fetch timeout', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  const originalDegradedFallback = process.env.DEGRADED_FALLBACK;
  let server;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll((done) => {
    if (originalDegradedFallback === undefined) delete process.env.DEGRADED_FALLBACK;
    else process.env.DEGRADED_FALLBACK = originalDegradedFallback;
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
    delete process.env.DEGRADED_FALLBACK;
  });

  it('returns 504 and releases gate slot when fetch times out', async () => {
    // Mock the exact-model request.
    // Mock /api/generate to never resolve (simulates Ollama hang)
    fetch.mockImplementation((url, opts) => {
      const evidence = benchmarkEvidenceResponse(url);
      if (evidence) return evidence;
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      // Simulate a hanging fetch that respects AbortController signal
      return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal) {
          const onAbort = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort);
        }
      });
    });

    const response = await request(server)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello' })
      .expect(504);

    expect(response.body.status).toBe('error');

    // Gate slot should be released
    const stats = hostGate.stats();
    const entry = stats.entries['http://primary:11434::test-model'];
    expect(entry.inFlight).toBe(0);
    expect(entry.totalReleased).toBe(1);

    // Timeout is a first-class terminal telemetry status and outcome.
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'timeout',
        error: expect.stringContaining('timeout'),
        estimatedInputTokensAtDispatch: expect.any(Number),
        routeDecision: expect.objectContaining({
          outcome: expect.objectContaining({
            code: 'upstream_timeout',
            reasonCode: 'fetch_timeout_500ms'
          })
        })
      })
    );
    expect(recordInference.mock.calls.at(-1)[0].estimatedInputTokensAtDispatch).toBeGreaterThan(0);
  }, 10000);

  it('returns 200 and releases gate slot on happy path', async () => {
    let transportSignal;
    fetch.mockImplementation((url, options) => {
      const evidence = benchmarkEvidenceResponse(url);
      if (evidence) return evidence;
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      transportSignal = options.signal;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ response: 'hi', done: true }))
      });
    });

    const response = await request(server)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello' })
      .expect(200);

    expect(response.body.response).toBe('hi');

    // Gate slot should be released
    const stats = hostGate.stats();
    const entry = stats.entries['http://primary:11434::test-model'];
    expect(entry.inFlight).toBe(0);
    expect(entry.totalReleased).toBe(1);

    // recordInference should have been called with success
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' })
    );

    // A normal ServerResponse `close` must not be treated as caller abort.
    await new Promise((resolve) => setImmediate(resolve));
    expect(transportSignal).toEqual(expect.any(AbortSignal));
    expect(transportSignal.aborted).toBe(false);
  });

  it('aborts the downstream transport and skips degraded retry when the caller disconnects', async () => {
    process.env.DEGRADED_FALLBACK = 'true';
    let transportSignal;
    let downstreamStartedResolve;
    let downstreamAbortedResolve;
    const downstreamStarted = new Promise((resolve) => { downstreamStartedResolve = resolve; });
    const downstreamAborted = new Promise((resolve) => { downstreamAbortedResolve = resolve; });

    fetch.mockImplementation((url, options) => {
      const evidence = benchmarkEvidenceResponse(url);
      if (evidence) return evidence;
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }

      transportSignal = options.signal;
      downstreamStartedResolve();
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          downstreamAbortedResolve();
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (transportSignal.aborted) onAbort();
        else transportSignal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const clientRequest = openInferenceRequest(server, {
      model: 'test-model',
      taskType: 'quick_chat',
      prompt: 'hello',
    });

    await downstreamStarted;
    expect(transportSignal.aborted).toBe(false);
    const disconnectedAt = Date.now();
    clientRequest.socket.resetAndDestroy();
    await downstreamAborted;
    expect(Date.now() - disconnectedAt).toBeLessThan(1000);

    await waitFor(() => {
      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      return entry?.inFlight === 0 && recordInference.mock.calls.length > 0;
    });

    expect(transportSignal.aborted).toBe(true);
    expect(hostPreferenceService.getAll).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/api/generate'))).toHaveLength(1);
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: 'Inference request cancelled: caller disconnected',
      routeDecision: expect.objectContaining({
        outcome: expect.objectContaining({ code: 'caller_disconnected' }),
      }),
    }));
  });

  it('removes a disconnected caller from admission before any upstream generation starts', async () => {
    const release1 = await hostGate.acquire('http://primary:11434', 'test-model');
    const release2 = await hostGate.acquire('http://primary:11434', 'test-model');
    let generationCalls = 0;

    fetch.mockImplementation((url) => {
      const evidence = benchmarkEvidenceResponse(url);
      if (evidence) return evidence;
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (typeof url === 'string' && url.includes('/api/generate')) {
        generationCalls += 1;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: 'should not run' }),
      });
    });

    try {
      const clientRequest = openInferenceRequest(server, {
        model: 'test-model',
        taskType: 'quick_chat',
        prompt: 'wait for admission',
      });

      await waitFor(() => (
        hostGate.stats().entries['http://primary:11434::test-model']?.waiters === 1
      ));
      expect(generationCalls).toBe(0);

      clientRequest.socket.resetAndDestroy();
      await waitFor(() => {
        const entry = hostGate.stats().entries['http://primary:11434::test-model'];
        return entry?.waiters === 0 && recordInference.mock.calls.length > 0;
      });

      expect(generationCalls).toBe(0);
      expect(hostGate.stats().entries['http://primary:11434::test-model']).toMatchObject({
        inFlight: 2,
        waiters: 0,
        totalAcquired: 2,
        totalReleased: 0,
      });
      expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
        status: 'error',
        error: 'Inference request cancelled: caller disconnected',
        routeDecision: expect.objectContaining({
          outcome: expect.objectContaining({ code: 'caller_disconnected' }),
        }),
      }));
    } finally {
      release1();
      release2();
    }
  });
});

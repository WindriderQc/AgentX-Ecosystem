// Set timeout env BEFORE any module require so the module-level constant picks it up
process.env.INFERENCE_FETCH_TIMEOUT_MS = '500';

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
const apiRoutes = require('../../routes/api');

describe('POST /api/inference/generate — fetch timeout', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('returns 504 and releases gate slot when fetch times out', async () => {
    // Mock the exact-model request.
    // Mock /api/generate to never resolve (simulates Ollama hang)
    fetch.mockImplementation((url, opts) => {
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

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello' })
      .expect(504);

    expect(response.body.status).toBe('error');

    // Gate slot should be released
    const stats = hostGate.stats();
    const entry = stats.entries['http://primary:11434::test-model'];
    expect(entry.inFlight).toBe(0);
    expect(entry.totalReleased).toBe(1);

    // recordInference should have been called with error status
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('timeout')
      })
    );
  }, 10000);

  it('returns 200 and releases gate slot on happy path', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ response: 'hi' }))
      });
    });

    const response = await request(app)
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
  });
});

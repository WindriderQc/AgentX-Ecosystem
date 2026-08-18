// Regression: a dead Ollama host used to hang /api/inference/embed forever
// (no timeout, no failover), which took down RAG search *and* ingest, which
// took down memory storage. Env must be set before requiring the route so the
// module-level timeout constant and the host allowlist pick it up.
process.env.EMBED_TIMEOUT_MS = '600';
process.env.EMBED_PROBE_TIMEOUT_MS = '200';
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_2 = 'http://secondary:11434';

const express = require('express');
const request = require('supertest');
const fetch = require('node-fetch');

jest.mock('node-fetch');

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  // Mirrors the real defect: embedding models resolved to the secondary host.
  getTargetForModel: jest.fn(() => 'http://secondary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn(() => null)
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({
    readiness: { stage: 'available', benchmarkQualified: false, stale: false, isReady: false }
  }))
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const { recordInference } = require('../../src/services/modelRouter');
const { emit: emitBuddyEvent } = require('../../src/services/buddyEvents');
const apiRoutes = require('../../routes/api');
const inferenceRouter = require('../../routes/inference');

/** A fetch that never settles until its AbortController fires. */
function hangingFetch(_url, opts) {
  return new Promise((_resolve, reject) => {
    const signal = opts?.signal;
    if (!signal) return;
    const onAbort = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);
  });
}

describe('POST /api/inference/embed — dead-host failover', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    inferenceRouter._resetEmbedLivenessForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('fails over to a healthy host when the routed host is a black hole', async () => {
    fetch.mockImplementation((url, opts) => {
      if (url.includes('secondary')) return hangingFetch(url, opts);
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }))
      });
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(200);

    expect(response.body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(response.headers['x-routed-host']).toBe('http://primary:11434');
    expect(response.headers['x-agentx-fallback-used']).toBe('true');

    // The dead host is recorded as an error, the healthy one as the success,
    // so telemetry names the host that actually answered.
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'http://secondary:11434', status: 'error' })
    );
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'http://primary:11434',
        routedHostUrl: 'http://secondary:11434',
        status: 'success',
        fallbackUsed: true,
        fallbackReason: expect.stringMatching(/unreachable|timed out/i)
      })
    );
    expect(emitBuddyEvent).toHaveBeenCalledWith(
      'failover_triggered',
      'infrastructure',
      expect.stringContaining('Embedding failover'),
      'high',
      { intent: 'warning', surfaceScope: 'core' }
    );
  }, 10000);

  it('gives up with 502 rather than hanging when every host is unreachable', async () => {
    fetch.mockImplementation(hangingFetch);

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(502);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toMatch(/unreachable|timed out/i);
  }, 10000);

  it('honours an explicit host override instead of failing over past it', async () => {
    fetch.mockImplementation(hangingFetch);

    await request(app)
      .post('/api/inference/embed')
      .send({
        model: 'nomic-embed-text:v1.5',
        prompt: 'probe',
        ollamaHost: 'http://secondary:11434'
      })
      .expect(502);

    // Only the pinned host should have been contacted — never primary.
    const hosts = [...new Set(fetch.mock.calls.map(([url]) => new URL(url).host))];
    expect(hosts).toEqual(['secondary:11434']);
  }, 10000);

  it('lets a slow cold model load finish instead of aborting it', async () => {
    // Reproduces the measured 15.8s cold load: the host is alive and answers
    // the probe instantly, but the embed body takes far longer than the probe
    // budget. It must not be mistaken for a dead host.
    fetch.mockImplementation((url) => {
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ embedding: [0.9] }))
        }), 400); // > EMBED_PROBE_TIMEOUT_MS (200), < EMBED_TIMEOUT_MS (600)
      });
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(200);

    expect(response.body.embedding).toEqual([0.9]);
  }, 10000);
});

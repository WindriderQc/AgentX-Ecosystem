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
  })
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: {
    primary: 'http://primary:11434',
    secondary: 'http://secondary:11434',
    tertiary: 'http://tertiary:11434'
  },
  TASK_MODELS: {},
  buildRouterConfigPayload: jest.fn(),
  ensureTaskModelOverridesLoaded: jest.fn(),
  getAdvisoryModelForTask: jest.fn(async () => ({
    model: 'qwen2.5:7b',
    host: 'tertiary',
    url: 'http://tertiary:11434',
    source: 'fallback'
  })),
  getDefaultTaskModels: jest.fn(() => ({})),
  getModelForTask: jest.fn(),
  resolvePreferredTaskEntry: jest.fn(async () => ({
    model: 'qwen2.5:7b',
    host: 'tertiary',
    url: 'http://tertiary:11434'
  })),
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
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  getPinnedEntries: jest.fn((pref) => pref?.pinnedModels || []),
  resolvePinnedRuntimeOptions: jest.fn(() => ({ options: {}, keepAlive: undefined })),
  hasActiveBenchmarkClaim: jest.fn(() => false),
  start: jest.fn(),
  stop: jest.fn()
}));

const { recordInference, getTargetForModel } = require('../../src/services/modelRouter');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const apiRoutes = require('../../routes/api');

describe('POST /api/inference/embed', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('rejects invalid request bodies with a 400 response', async () => {
    const response = await request(app)
      .post('/api/inference/embed')
      .send({})
      .expect(400);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toContain('model and prompt');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('proxies embeddings to the routed Ollama host', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ embedding: [0.12, 0.34, 0.56] }))
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({
        model: 'nomic-embed-text:v1.5',
        prompt: 'hello world'
      })
      .expect(200);

    expect(response.body.embedding).toEqual([0.12, 0.34, 0.56]);
    expect(getTargetForModel).toHaveBeenCalledWith('nomic-embed-text:v1.5');
    expect(fetch).toHaveBeenCalledWith(
      'http://primary:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nomic-embed-text:v1.5',
          prompt: 'hello world'
        })
      })
    );
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      host: 'http://primary:11434',
      model: 'nomic-embed-text:v1.5',
      caller: 'embedding',
      status: 'success'
    }));
  });

  it('propagates a matching app-managed pin keep-alive to Ollama', async () => {
    hostPreferenceService.getByHost.mockResolvedValue({
      pinnedModels: [{ model: 'nomic-embed-text:v1.5', keepAlive: -1 }]
    });
    hostPreferenceService.resolvePinnedRuntimeOptions.mockReturnValue({ options: {}, keepAlive: -1 });
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ embedding: [0.12, 0.34] }))
    });

    await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'keep me warm' })
      .expect(200);

    const embedCall = fetch.mock.calls.find(([url]) => url.endsWith('/api/embeddings'));
    expect(JSON.parse(embedCall[1].body)).toEqual({
      model: 'nomic-embed-text:v1.5',
      prompt: 'keep me warm',
      keep_alive: -1
    });
  });

  it('normalizes wildcard ollamaHost overrides before proxying', async () => {
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ embedding: [1, 2, 3] }))
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({
        model: 'nomic-embed-text:v1.5',
        prompt: 'hello world',
        ollamaHost: '0.0.0.0:11434'
      })
      .expect(200);

    expect(response.body.embedding).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/embeddings',
      expect.any(Object)
    );
  });
});

describe('RouteDecision attribution on the embed path (0540)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('the success row carries a RouteDecision v1 with embedding attribution', async () => {
    // The gap this closes: embeddings are the highest-volume inference path
    // (~80% of production calls) and carried zero decisions after 0519 shipped
    // for generate. Assert the field is present on the real telemetry row —
    // a shape-only assertion is what let the original gap ship.
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ embedding: [0.1, 0.2] }))
    });

    await request(app)
      .post('/api/inference/embed')
      .send({
        model: 'nomic-embed-text:v1.5',
        prompt: 'attribution probe payload',
        callerDetail: 'rag/ingest/chunk'
      })
      .expect(200);

    const successRow = recordInference.mock.calls
      .map(([entry]) => entry)
      .find(entry => entry.status === 'success');
    expect(successRow).toBeTruthy();
    const decision = successRow.routeDecision;
    expect(decision).toBeTruthy();
    expect(decision.decisionVersion).toBe(1);
    expect(decision.attribution).toMatchObject({
      caller: 'embedding',
      callerDetail: 'rag/ingest/chunk'
    });
    expect(decision.intent.mode).toBe('explicit_model');
    expect(decision.selectionSource).toBe('model_target');
    expect(decision.outcome).toEqual(expect.objectContaining({
      stage: 'execution', code: 'execution_succeeded'
    }));
    expect(decision.selected.model).toBe('nomic-embed-text:v1.5');
    expect(decision.primary.hostUrl).toBe('http://primary:11434');
    expect(decision.selected.hostUrl).toBe('http://primary:11434');
    expect(decision.fallbackUsed).toBe(false);
    // inferencelogs has 30-day retention; the no-prompt guarantee has to hold
    // on the persisted decision, not just in the builder's unit tests.
    expect(JSON.stringify(decision)).not.toContain('attribution probe payload');
  });

  it('a failover attributes both the failed attempt and the serving attempt', async () => {
    // The 145-silent-failovers case: primary accepts nothing, secondary
    // serves. The error row and the success row must each carry a decision,
    // and the success row must show primary != selected with the rejection.
    fetch.mockImplementation((url) => {
      if (url.endsWith('/api/tags')) {
        return Promise.resolve({ ok: true });
      }
      if (url.startsWith('http://primary:11434')) {
        return Promise.reject(new Error('connect ECONNREFUSED primary'));
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ embedding: [0.3, 0.4] }))
      });
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'failover probe' })
      .expect(200);

    expect(response.body.embedding).toEqual([0.3, 0.4]);
    expect(response.headers['x-agentx-fallback-used']).toBe('true');

    const rows = recordInference.mock.calls.map(([entry]) => entry);
    const errorRow = rows.find(entry => entry.status === 'error');
    expect(errorRow).toBeTruthy();
    expect(errorRow.routeDecision).toBeTruthy();
    expect(errorRow.routeDecision.selected.hostUrl).toBe('http://primary:11434');
    expect(errorRow.routeDecision.fallbackUsed).toBe(false);
    expect(errorRow.routeDecision.selectionSource).toBe('model_target');
    expect(errorRow.routeDecision.outcome).toEqual(expect.objectContaining({
      stage: 'execution', code: 'upstream_error', reasonCode: 'connection_failure'
    }));

    const successRow = rows.find(entry => entry.status === 'success');
    expect(successRow).toBeTruthy();
    const decision = successRow.routeDecision;
    expect(decision).toBeTruthy();
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.fallbackReason).toBe('connection_failure');
    expect(decision.outcome).toEqual(expect.objectContaining({
      stage: 'fallback', code: 'fallback_succeeded', reasonCode: 'connection_failure'
    }));
    expect(decision.primary.hostUrl).toBe('http://primary:11434');
    expect(decision.selected.hostUrl).toBe('http://127.0.0.1:11434');
    expect(decision.attempt).toBe(2);
    expect(decision.rejections).toHaveLength(1);
    expect(decision.rejections[0]).toMatchObject({
      hostUrl: 'http://primary:11434',
      reason: 'host_offline'
    });
  });

  it('an exhausted fleet still attributes the terminal failure row', async () => {
    // All hosts down. The terminal 502 row is exactly what a sustained-
    // fallback alert reads, so it must carry the decision with the full
    // rejection list rather than being the one unattributed row.
    fetch.mockRejectedValue(new Error('connect ECONNREFUSED everywhere'));

    await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'dead fleet probe' })
      .expect(502);

    const rows = recordInference.mock.calls.map(([entry]) => entry);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.routeDecision).toBeTruthy();
      expect(row.routeDecision.decisionVersion).toBe(1);
    }
    const terminalRow = rows[rows.length - 1];
    // Three candidates configured under jest (primary + 2 setup-env hosts),
    // all rejected before the terminal row is written.
    expect(terminalRow.routeDecision.rejections).toHaveLength(3);
    expect(terminalRow.routeDecision.outcome.code).toBe('fallback_failed');
    expect(terminalRow.routeDecision.outcome.reasonCode).toBe('host_offline');
    expect(JSON.stringify(terminalRow.routeDecision)).not.toContain('dead fleet probe');
  });
});

describe('POST /api/inference/generate', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('rejects requests that omit both model and taskType', async () => {
    const response = await request(app)
      .post('/api/inference/generate')
      .send({ prompt: 'hello' })
      .expect(400);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toContain('model or taskType');
  });

  it('routes taskType requests through the core router and forwards the resolved model', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ response: 'expanded query', done: true }))
      });
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({
        taskType: 'rag_query_expansion',
        prompt: 'expand this query',
        callerDetail: 'unit-test'
      })
      .expect(200);

    expect(response.body.response).toBe('expanded query');
    expect(fetch).toHaveBeenCalledWith(
      'http://tertiary:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:7b',
          prompt: 'expand this query',
          system: undefined,
          stream: false,
          options: { num_predict: 4096 },
          think: false
        })
      })
    );
    expect(response.headers['x-resolved-model']).toBe('qwen2.5:7b');
    expect(response.headers['x-routed-host']).toBe('http://tertiary:11434');
    expect(response.headers['x-routing-task-type']).toBe('rag_query_expansion');
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      model: 'qwen2.5:7b',
      taskType: 'rag_query_expansion',
      routed: true,
      host: 'http://tertiary:11434'
    }));
  });

  it('keeps soft-gate behavior by default for unprofiled models', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ response: 'hello there', done: true }))
      });
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'mystery-model',
        prompt: 'hello'
      })
      .expect(200);

    expect(response.body.response).toBe('hello there');
    expect(fetch).toHaveBeenCalledWith(
      'http://primary:11434/api/generate',
      expect.any(Object)
    );
  });

  it('blocks unprofiled models when REQUIRE_PROFILED_MODELS=true', async () => {
    process.env.REQUIRE_PROFILED_MODELS = 'true';
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'mystery-model',
        prompt: 'hello'
      })
      .expect(409);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toContain('not profiled');
    // The readiness gate must stop before any inference call.
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/generate'),
      expect.any(Object)
    );
  });
});

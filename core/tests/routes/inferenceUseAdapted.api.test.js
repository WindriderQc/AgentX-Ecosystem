'use strict';

const express = require('express');
const request = require('supertest');
const fetch = require('node-fetch');

jest.mock('node-fetch');
jest.mock('../../src/services/inferenceContractService', () => ({
  hasQualifiedThinkingCapability: jest.fn(() => false),
  resolveInferenceContract: jest.fn(async (input) => ({
    version: 'agentx.inference-contract.v1',
    artifact: { model: input.model, host: input.host, hostId: 'primary' },
    qualification: { state: 'profiled', qualified: true, exactArtifact: true },
    capabilities: {
      thinking: { supported: false, recommendedPolicy: 'off', visibleFinalAnswer: { qualified: true } },
      tools: { supported: null, qualified: false },
      streaming: { supported: null, qualified: false }
    },
    contextBudget: {
      windowTokens: Number(input.requestedNumCtx) || 8192,
      source: input.numCtxSource || 'profiled',
      output: { reservedTokens: Number(input.requestedMaxOutputTokens) || 2048 },
      input: { estimatedTokens: 1, overflowTokens: 0, fits: true },
      transformations: { truncation: { applied: false }, condensation: { applied: false } }
    }
  })),
  resolveInferenceContractSnapshot: jest.fn(async (input) => ({
    version: 'agentx.inference-contract.v1',
    artifact: {
      model: input.model,
      host: input.host,
      hostId: 'primary',
      digest: 'sha256:exact',
      runtimeFingerprint: 'runtime',
      registryQualified: true,
      identityQualified: true
    },
    qualification: { state: 'profiled', qualified: true, exactArtifact: true },
    capabilities: { thinking: { supported: false, visibleFinalAnswer: { qualified: true } } },
    contextBudget: {
      windowTokens: Number(input.requestedNumCtx) || 8192,
      validatedWindowTokens: Number(input.requestedNumCtx) || 8192,
      output: { reservedTokens: Number(input.requestedMaxOutputTokens) || 2048 }
    },
    snapshot: { schemaVersion: 1, fingerprint: 'a'.repeat(64), scope: 'deployed_artifact_host' }
  }))
}));
jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://primary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn(() => 'primary')
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
    readiness: { stage: 'benchmarked', benchmarkQualified: true, stale: false, isReady: true }
  })),
  isReadyStage: jest.fn(() => true)
}));
jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => []),
  getByHost: jest.fn(async () => null),
  hasActiveBenchmarkClaim: jest.fn(() => false),
  getPinnedEntries: jest.fn(() => []),
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn()
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const apiRoutes = require('../../routes/api');
const inferenceContractService = require('../../src/services/inferenceContractService');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers.host = 'localhost:3180';
    req.headers.origin = 'http://localhost:3180';
    req.headers['sec-fetch-site'] = 'same-origin';
    req.headers['x-agentx-benchmark-token'] = 'test-benchmark-token';
    next();
  });
  app.use('/api', apiRoutes);
  return app;
}

function buildRemoteMachineApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api', apiRoutes);
  return app;
}

function mockOllama() {
  const calls = [];
  fetch.mockImplementation(async (url, options = {}) => {
    let body = {};
    try { body = JSON.parse(options.body || '{}'); } catch { /* ignored */ }
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: 'ok', eval_count: 1, prompt_eval_count: 1 })
    };
  });
  return calls;
}

describe('POST /api/inference/generate exact artifact routing', () => {
  const app = buildApp();
  const originalBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;

  beforeAll(() => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'test-benchmark-token';
  });

  afterAll(() => {
    if (originalBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalBenchmarkToken;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('preserves a bare exact tag and performs no variant probe', async () => {
    const calls = mockOllama();
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', callerDetail: 'chat-user' })
      .expect(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://primary:11434/api/generate');
    expect(calls[0].body.model).toBe('gemma4:26b');
  });

  it('preserves an explicitly namespaced tag as a distinct artifact', async () => {
    const calls = mockOllama();
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'owner/gemma4:26b', prompt: 'hi' })
      .expect(200);
    expect(calls[0].body.model).toBe('owner/gemma4:26b');
  });

  it('rejects the retired useAdapted switch before contacting Ollama', async () => {
    mockOllama();
    const response = await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', useAdapted: true })
      .expect(400);
    expect(response.body.code).toBe('ADAPTED_MODEL_RESOLUTION_RETIRED');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/inference/contract/resolve', () => {
  const app = buildApp();

  beforeEach(() => jest.clearAllMocks());

  it('returns an exact-artifact campaign snapshot without inference', async () => {
    const response = await request(app)
      .post('/api/inference/contract/resolve')
      .send({ model: 'owner/model:8b', host: 'primary', options: { num_ctx: 8192, num_predict: 2048 } })
      .expect(200);
    expect(response.body).toMatchObject({
      artifact: { model: 'owner/model:8b', digest: 'sha256:exact', registryQualified: true },
      qualification: { qualified: true, exactArtifact: true },
      snapshot: { scope: 'deployed_artifact_host' }
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/inference/contract/resolve Benchmark service identity', () => {
  const app = buildRemoteMachineApp();
  const originalBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;
  const requestBody = {
    model: 'owner/model:8b',
    host: 'primary',
    options: { num_ctx: 8192, num_predict: 2048 }
  };

  beforeAll(() => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'test-benchmark-token';
  });

  afterAll(() => {
    if (originalBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalBenchmarkToken;
  });

  beforeEach(() => jest.clearAllMocks());

  function machineRequest(token) {
    let pending = request(app)
      .post('/api/inference/contract/resolve')
      .set('Host', 'remote-benchmark.example')
      .set('X-Forwarded-For', '203.0.113.21');
    if (token !== undefined) pending = pending.set('X-AgentX-Benchmark-Token', token);
    return pending.send(requestBody);
  }

  it('accepts the exact Benchmark token and resolves the contract', async () => {
    const response = await machineRequest('test-benchmark-token');

    expect(response.status).toBe(200);
    expect(inferenceContractService.resolveInferenceContractSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'wrong-token']
  ])('rejects a %s token before contract resolution', async (_label, token) => {
    const response = await machineRequest(token);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('BENCHMARK_SERVICE_ACCESS_REQUIRED');
    expect(inferenceContractService.resolveInferenceContractSnapshot).not.toHaveBeenCalled();
  });
});

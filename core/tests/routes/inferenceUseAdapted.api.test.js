/**
 * Task 0178 — `useAdapted` defaults + override.
 *
 * Verifies the runtime rule that daily-usage callers (interactive +
 * non-profiler direct lanes) resolve to `ax/<model>` automatically while
 * profiler / unknown / automated callers stay on the bare name unless they
 * explicitly opt in.
 */

const express = require('express');
const request = require('supertest');
const fetch = require('node-fetch');

jest.mock('node-fetch');

jest.mock('../../src/services/inferenceContractService', () => ({
  hasQualifiedThinkingCapability: jest.fn((contract) =>
    contract?.capabilities?.thinking?.supported === true
      && contract?.qualification?.qualified === true
      && contract?.capabilities?.thinking?.visibleFinalAnswer?.qualified === true
  ),
  resolveInferenceContract: jest.fn(async (input) => {
    const supported = String(input.model || '').includes('qwen');
    const windowTokens = Number(input.requestedNumCtx) || 8192;
    return {
      version: 'agentx.inference-contract.v1',
      artifact: {
        model: input.model,
        host: input.host,
        hostId: String(input.host || '').includes('secondary') ? 'secondary' : 'primary'
      },
      qualification: {
        state: supported ? 'profiled' : 'unknown',
        qualified: supported,
        source: supported ? 'benchmark_model_profile' : 'fallback'
      },
      capabilities: {
        thinking: {
          supported: supported ? true : null,
          recommendedPolicy: supported ? 'on' : 'unknown',
          source: supported ? 'benchmark_model_profile' : 'unqualified',
          visibleFinalAnswer: { qualified: supported }
        },
        tools: { supported: null, qualified: false },
        streaming: { supported: null, qualified: false }
      },
      contextBudget: {
        windowTokens,
        source: input.numCtxSource || 'fallback',
        input: {
          estimatedTokens: 1,
          overflowTokens: 0,
          fits: true
        },
        transformations: {
          condensation: { applied: false, removedTokens: 0 },
          truncation: { applied: false, removedTokens: 0 },
          upstreamTruncationRisk: false
        }
      }
    };
  }),
  resolveInferenceContractSnapshot: jest.fn(async (input) => ({
    version: 'agentx.inference-contract.v1',
    artifact: {
      model: input.model,
      host: input.host,
      hostId: 'primary'
    },
    qualification: {
      state: 'profiled',
      qualified: true,
      source: 'benchmark_model_profile'
    },
    capabilities: {
      thinking: {
        supported: true,
        source: 'benchmark_model_profile',
        visibleFinalAnswer: { qualified: true }
      }
    },
    contextBudget: {
      windowTokens: Number(input.requestedNumCtx) || 8192,
      output: { reservedTokens: Number(input.requestedMaxOutputTokens) || 2048 }
    },
    snapshot: {
      schemaVersion: 1,
      fingerprint: 'a'.repeat(64),
      resolvedAt: '2026-07-25T04:00:00.000Z',
      scope: 'deployed_artifact_host',
      freezeRecommended: true,
      reusePolicy: 'resolve_once_per_campaign'
    }
  }))
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
  getModelReadiness: jest.fn(async () => ({ readiness: { stage: 'available' } })),
  isReadyStage: jest.fn(() => true)
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => []),
  getByHost: jest.fn(async () => null),
  hasActiveBenchmarkClaim: jest.fn((pref) => !!(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId)),
  getPinnedEntries: jest.fn((pref) => pref?.pinnedModels || []),
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn()
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const hostGate = require('../../src/services/hostGate');
const lanePolicy = require('../../src/services/inferenceLanePolicy');
const { recordInference } = require('../../src/services/modelRouter');
const routerConfig = require('../../src/services/modelRouterConfig');
const hostPrefService = require('../../src/services/hostPreferenceService');
const { resolveInferenceContractSnapshot } = require('../../src/services/inferenceContractService');
const apiRoutes = require('../../routes/api');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  return app;
}

function mockOllama({ adaptedExists = true, generateData = null } = {}) {
  const showCalls = [];
  const generateCalls = [];
  fetch.mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('/api/show')) {
      let body = null;
      try { body = JSON.parse(opts && opts.body); } catch { /* ignore */ }
      showCalls.push({ url, name: body && body.name });
      return Promise.resolve({
        ok: !!adaptedExists,
        status: adaptedExists ? 200 : 404,
        text: () => Promise.resolve(adaptedExists ? '{}' : '{"error":"not found"}'),
      });
    }
    if (typeof url === 'string' && (url.includes('/api/generate') || url.includes('/api/chat'))) {
      let body = null;
      try { body = JSON.parse(opts && opts.body); } catch { /* ignore */ }
      generateCalls.push({ url, model: body && body.model, options: body && body.options, think: body && body.think });
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(generateData || { response: 'ok', eval_count: 1, prompt_eval_count: 1 })),
      });
    }
    return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') });
  });
  return { showCalls, generateCalls };
}

describe('POST /api/inference/generate — useAdapted (task 0178)', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    lanePolicy._resetProbeCacheForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
    hostPrefService.getByHost.mockResolvedValue(null);
    hostPrefService.hasActiveBenchmarkClaim.mockImplementation((pref) => !!(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId));
    hostPrefService.getPinnedEntries.mockImplementation((pref) => pref?.pinnedModels || []);
  });

  it('daily caller (chat) — cold cache: probes /api/show, resolves ax/, populates cache', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', callerDetail: 'chat-user-1' })
      .expect(200);

    expect(showCalls).toHaveLength(1);
    expect(showCalls[0].name).toBe('ax/gemma4:26b');
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0].model).toBe('ax/gemma4:26b');
    expect(response.headers['x-resolved-model']).toBe('ax/gemma4:26b');
    expect(response.headers['x-routing-source']).toMatch(/adapted/);

    // Cache populated for subsequent (host, model) lookups.
    expect(lanePolicy.getProbe('http://primary:11434', 'gemma4:26b')).toBe('ax/gemma4:26b');

    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      model: 'ax/gemma4:26b',
      routedModel: 'ax/gemma4:26b',
    }));
  });

  it('daily caller (chat) — warm cache: no probe, resolves ax/', async () => {
    lanePolicy.setProbe('http://primary:11434', 'gemma4:26b', 'ax/gemma4:26b');
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', callerDetail: 'chat-user-1' })
      .expect(200);

    expect(showCalls).toHaveLength(0);
    expect(generateCalls[0].model).toBe('ax/gemma4:26b');
  });

  it('daily caller (benchmark batch direct lane) — cold cache: probes once, resolves ax/, populates cache', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'gemma4:26b',
        prompt: 'hi',
        callerDetail: 'benchmark-batch-abc123',
      })
      .expect(200);

    expect(showCalls).toHaveLength(1);
    expect(generateCalls[0].model).toBe('ax/gemma4:26b');
    expect(response.headers['x-routing-source']).toMatch(/probe-direct/);
    expect(lanePolicy.getProbe('http://primary:11434', 'gemma4:26b')).toBe('ax/gemma4:26b');
  });

  it('daily caller (benchmark batch) — warm cache: no probe; second call after first is cache hit', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    // First call populates cache.
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: '1', callerDetail: 'benchmark-batch-abc' })
      .expect(200);
    // Second call should NOT issue another /api/show probe.
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: '2', callerDetail: 'benchmark-batch-abc' })
      .expect(200);

    expect(showCalls).toHaveLength(1); // amortized: 1 probe per (host, model)
    expect(generateCalls.map((c) => c.model)).toEqual(['ax/gemma4:26b', 'ax/gemma4:26b']);
  });

  it('profiler with useAdapted: false — bare model passes through, no probe', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'gemma4:26b',
        prompt: 'profile pass',
        callerDetail: 'profiler-baseline',
        useAdapted: false,
      })
      .expect(200);

    expect(showCalls).toHaveLength(0);
    expect(generateCalls[0].model).toBe('gemma4:26b');
    expect(response.headers['x-resolved-model']).toBe('gemma4:26b');
    expect(response.headers['x-routing-source']).toMatch(/useAdapted-false/);
  });

  it('profiler with useAdapted: true — probes and resolves ax/', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'gemma4:26b',
        prompt: 'profile pass',
        callerDetail: 'profiler-baseline',
        useAdapted: true,
      })
      .expect(200);

    expect(showCalls).toHaveLength(1);
    expect(generateCalls[0].model).toBe('ax/gemma4:26b');
  });

  it('profiler default (no useAdapted) — bare passes through, no probe', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'gemma4:26b',
        prompt: 'profile pass',
        callerDetail: 'profiler-baseline',
      })
      .expect(200);

    expect(showCalls).toHaveLength(0);
    expect(generateCalls[0].model).toBe('gemma4:26b');
  });

  it('consumer caller is blocked before model load when target host has active benchmark claim', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });
    hostPrefService.getByHost.mockResolvedValue({
      hostUrl: 'http://primary:11434',
      status: 'benchmarking',
      benchmarkClaim: { batchId: 'batch-1' }
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', callerDetail: 'chat-user-1' })
      .expect(503);

    expect(response.body.code).toBe('BENCHMARK_CLAIM_ACTIVE');
    expect(showCalls).toHaveLength(0);
    expect(generateCalls).toHaveLength(0);
  });

  it('benchmark caller can use a host it has explicitly targeted', async () => {
    const { generateCalls } = mockOllama({ adaptedExists: true });
    hostPrefService.getByHost.mockResolvedValue({
      hostUrl: 'http://primary:11434',
      status: 'benchmarking',
      benchmarkClaim: { batchId: 'batch-1' }
    });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', callerDetail: 'benchmark-batch-batch-1' })
      .expect(200);

    expect(generateCalls).toHaveLength(1);
  });

  it('unknown caller (no callerDetail) — automated lane, base name, no probe', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi' })
      .expect(200);

    expect(showCalls).toHaveLength(0);
    expect(generateCalls[0].model).toBe('gemma4:26b');
  });

  it('daily caller — adapted variant missing on host: caches negative, logs once, falls back to base', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: false });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'mystery-model', prompt: 'hi', callerDetail: 'chat-foo' })
      .expect(200);

    expect(showCalls).toHaveLength(1);
    expect(generateCalls[0].model).toBe('mystery-model');
    expect(lanePolicy.getProbe('http://primary:11434', 'mystery-model')).toBe('mystery-model');

    // Second call must hit the negative cache (no second probe).
    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'mystery-model', prompt: 'again', callerDetail: 'chat-foo' })
      .expect(200);
    expect(showCalls).toHaveLength(1);
    expect(generateCalls[1].model).toBe('mystery-model');
  });

  it('automated caller with explicit useAdapted: true — probes and resolves ax/', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'gemma4:26b', prompt: 'hi', useAdapted: true })
      .expect(200);

    expect(showCalls).toHaveLength(1);
    expect(generateCalls[0].model).toBe('ax/gemma4:26b');
  });

  it('caller already passes ax/-prefixed model — no probe; sent through unchanged', async () => {
    const { showCalls, generateCalls } = mockOllama({ adaptedExists: true });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'ax/gemma4:26b', prompt: 'hi', callerDetail: 'chat-user-1' })
      .expect(200);

    expect(showCalls).toHaveLength(0);
    expect(generateCalls[0].model).toBe('ax/gemma4:26b');
  });

  it('normalizes final responses and suppresses structured thinking by default', async () => {
    mockOllama({
      adaptedExists: true,
      generateData: {
        model: 'ax/qwen3:8b',
        message: {
          role: 'assistant',
          content: 'Final answer',
          thinking: 'Internal reasoning that should not leak'
        },
        done: true,
        eval_count: 3,
        prompt_eval_count: 2
      }
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }], callerDetail: 'chat-user-1', think: false })
      .expect(200);

    expect(response.headers['x-agentx-response-mode']).toBe('normalized');
    expect(response.body.response).toBe('Final answer');
    expect(response.body.message.content).toBe('Final answer');
    expect(response.body.message.thinking).toBeUndefined();
    expect(response.body.thinking).toBeUndefined();
    expect(response.body.thinking_suppressed).toBeUndefined();
    expect(response.body.eval_count).toBe(3);
    expect(response.body.agentx_contract).toMatchObject({
      version: 'agentx.inference-contract.v1',
      artifact: { model: 'ax/qwen3:8b' },
      contextBudget: {
        input: {
          overflowTokens: 0,
          fits: true
        },
        transformations: {
          condensation: { applied: false },
          truncation: { applied: false }
        }
      }
    });
    expect(response.headers['x-agentx-context-window']).toBe('8192');
    expect(response.headers['x-agentx-capability-qualification']).toBe('profiled');
  });

  it('keeps raw Ollama response only when responseMode raw is requested', async () => {
    mockOllama({
      adaptedExists: true,
      generateData: {
        message: {
          content: 'Final answer',
          thinking: 'Raw reasoning for diagnostics'
        },
        done: true
      }
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: 'hi' }],
        callerDetail: 'chat-user-1',
        responseMode: 'raw'
      })
      .expect(200);

    expect(response.headers['x-agentx-response-mode']).toBe('raw');
    expect(response.headers['x-agentx-context-condensed']).toBe('false');
    expect(response.headers['x-agentx-context-truncated']).toBe('false');
    expect(response.headers['x-agentx-context-truncation-risk']).toBe('false');
    expect(response.body.message.thinking).toBe('Raw reasoning for diagnostics');
    expect(response.body.agentx_contract).toBeUndefined();
  });

  it('routed pinned model inherits HostPreference context when caller omits num_ctx', async () => {
    const { generateCalls } = mockOllama({ adaptedExists: true });
    routerConfig.getModelForTask.mockReturnValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434'
    });
    routerConfig.getAdvisoryModelForTask.mockResolvedValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434',
      source: 'configured_host'
    });
    hostPrefService.getByHost.mockResolvedValue({
      hostUrl: 'http://secondary:11434',
      pinnedModels: [{ model: 'ax/qwen3.5:9b', keepAlive: -1, contextSize: 131072 }]
    });

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', prompt: 'hi', callerDetail: 'chat-user-1' })
      .expect(200);

    expect(generateCalls[0]).toMatchObject({
      model: 'ax/qwen3.5:9b',
      options: { num_ctx: 131072 },
      think: false
    });
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      num_ctx: 131072,
      num_ctx_source: 'host_preference_pin'
    }));
  });

  it('auto-enables thinking for deep reasoning on capable models', async () => {
    const { generateCalls } = mockOllama({ adaptedExists: true });
    routerConfig.getModelForTask.mockReturnValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434'
    });
    routerConfig.getAdvisoryModelForTask.mockResolvedValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434',
      source: 'configured_host'
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'deep_reasoning', prompt: 'solve this', callerDetail: 'chat-user-1' })
      .expect(200);

    expect(generateCalls[0]).toMatchObject({
      model: 'ax/qwen3.5:9b',
      think: true
    });
    expect(response.headers['x-agentx-thinking-mode']).toBe('auto');
    expect(response.headers['x-agentx-thinking-source']).toBe('task_policy');
    expect(response.headers['x-agentx-think']).toBe('true');
  });

  it('explicit think value overrides the daily default', async () => {
    const { generateCalls } = mockOllama({ adaptedExists: true });
    routerConfig.getModelForTask.mockReturnValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434'
    });
    routerConfig.getAdvisoryModelForTask.mockResolvedValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434',
      source: 'configured_host'
    });

    await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', prompt: 'hi', callerDetail: 'chat-user-1', think: true })
      .expect(200);

    expect(generateCalls[0]).toMatchObject({
      model: 'ax/qwen3.5:9b',
      think: true
    });
  });

  it('string think:false is treated as an explicit disable, not auto', async () => {
    const { generateCalls } = mockOllama({ adaptedExists: true });
    routerConfig.getModelForTask.mockReturnValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434'
    });
    routerConfig.getAdvisoryModelForTask.mockResolvedValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434',
      source: 'configured_host'
    });

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'deep_reasoning', prompt: 'solve this', callerDetail: 'chat-user-1', think: 'false' })
      .expect(200);

    expect(generateCalls[0]).toMatchObject({
      model: 'ax/qwen3.5:9b',
      think: false
    });
    expect(response.headers['x-agentx-thinking-mode']).toBe('off');
    expect(response.headers['x-agentx-think']).toBe('false');
  });

  it('caller num_ctx overrides pinned context', async () => {
    const { generateCalls } = mockOllama({ adaptedExists: true });
    routerConfig.getModelForTask.mockReturnValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434'
    });
    routerConfig.getAdvisoryModelForTask.mockResolvedValue({
      model: 'ax/qwen3.5:9b',
      host: 'secondary',
      url: 'http://secondary:11434',
      source: 'configured_host'
    });
    hostPrefService.getByHost.mockResolvedValue({
      hostUrl: 'http://secondary:11434',
      pinnedModels: [{ model: 'ax/qwen3.5:9b', keepAlive: -1, contextSize: 131072 }]
    });

    await request(app)
      .post('/api/inference/generate')
      .send({
        taskType: 'quick_chat',
        prompt: 'hi',
        callerDetail: 'chat-user-1',
        options: { num_ctx: 32768 }
      })
      .expect(200);

    expect(generateCalls[0]).toMatchObject({
      model: 'ax/qwen3.5:9b',
      options: { num_ctx: 32768 }
    });
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      num_ctx: 32768,
      num_ctx_source: 'caller'
    }));
  });
});

describe('POST /api/inference/contract/resolve', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires an exact deployed model and allowlisted host', async () => {
    await request(app)
      .post('/api/inference/contract/resolve')
      .send({ model: 'ax/plain-model:8b' })
      .expect(400);

    expect(resolveInferenceContractSnapshot).not.toHaveBeenCalled();
  });

  it('rejects invalid context parameters instead of silently falling back', async () => {
    await request(app)
      .post('/api/inference/contract/resolve')
      .send({
        model: 'ax/plain-model:8b',
        host: 'primary',
        options: { num_ctx: 'not-a-number' }
      })
      .expect(400);

    expect(resolveInferenceContractSnapshot).not.toHaveBeenCalled();
  });

  it('returns a campaign-freeze snapshot without performing inference', async () => {
    const response = await request(app)
      .post('/api/inference/contract/resolve')
      .send({
        model: 'ax/plain-model:8b',
        host: 'primary',
        options: {
          num_ctx: 16384,
          num_predict: 4096
        }
      })
      .expect(200);

    expect(response.body).toMatchObject({
      version: 'agentx.inference-contract.v1',
      artifact: {
        model: 'ax/plain-model:8b',
        host: expect.stringMatching(/^http:\/\/.+:11434$/)
      },
      contextBudget: {
        windowTokens: 16384,
        output: { reservedTokens: 4096 }
      },
      snapshot: {
        scope: 'deployed_artifact_host',
        freezeRecommended: true,
        reusePolicy: 'resolve_once_per_campaign'
      }
    });
    expect(resolveInferenceContractSnapshot).toHaveBeenCalledWith({
      model: 'ax/plain-model:8b',
      host: response.body.artifact.host,
      requestedNumCtx: 16384,
      numCtxSource: 'caller',
      requestedMaxOutputTokens: 4096
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

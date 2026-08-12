jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../../config/logger');

const mockGetByHost = jest.fn();
const mockHasActiveBenchmarkClaim = jest.fn();
jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: (...args) => mockGetByHost(...args),
  hasActiveBenchmarkClaim: (...args) => mockHasActiveBenchmarkClaim(...args),
}));

const mockRecordInference = jest.fn();
const mockGetTargetForModel = jest.fn();
jest.mock('../../src/services/modelRouter', () => ({
  getTargetForModel: (...args) => mockGetTargetForModel(...args),
  recordInference: (...args) => mockRecordInference(...args),
  resolveHostKey: (host) => (host || '').replace(/^https?:\/\//, '').replace(/:\d+$/, ''),
}));

// RAG reflex (task 0271): route uses the real proxyRagReflex + buildRagContext;
// only the underlying RAG service client is mocked so we control retrieval.
const mockSearchSimilarChunks = jest.fn();
jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({ searchSimilarChunks: (...a) => mockSearchSimilarChunks(...a) }),
}));

const mockFetch = jest.fn();
jest.mock('node-fetch', () => (...args) => mockFetch(...args));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const proxy = require('../../routes/hermes-openai-proxy');
  const app = express();
  app.use(express.json());
  app.use('/api/hermes-openai', proxy);
  return app;
}

describe('Hermes OpenAI-compatible proxy', () => {
  let app;
  const ORIGINAL_ENV = {
    HERMES_OPENAI_UPSTREAM: process.env.HERMES_OPENAI_UPSTREAM,
    HERMES_OLLAMA_UPSTREAM: process.env.HERMES_OLLAMA_UPSTREAM,
    HERMES_OPENAI_USE_ROUTER: process.env.HERMES_OPENAI_USE_ROUTER,
    OPENCLAW_OLLAMA_UPSTREAM: process.env.OPENCLAW_OLLAMA_UPSTREAM,
    OLLAMA_HOST: process.env.OLLAMA_HOST,
    PROXY_RAG_REFLEX: process.env.PROXY_RAG_REFLEX,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HERMES_OPENAI_UPSTREAM = 'http://192.0.2.99:11434/v1';
    delete process.env.HERMES_OLLAMA_UPSTREAM;
    delete process.env.HERMES_OPENAI_USE_ROUTER;
    delete process.env.OPENCLAW_OLLAMA_UPSTREAM;
    delete process.env.OLLAMA_HOST;
    delete process.env.PROXY_RAG_REFLEX; // default OFF — existing tests assume passthrough
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    mockGetTargetForModel.mockReturnValue('http://routed-host:11434');
    app = buildApp();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns an OpenAI-shaped 503 when the routed host has an active benchmark claim', async () => {
    mockGetByHost.mockResolvedValue({
      hostUrl: 'http://192.0.2.99:11434',
      status: 'benchmarking',
      benchmarkClaim: { batchId: 'batch-123' },
    });
    mockHasActiveBenchmarkClaim.mockReturnValue(true);

    const res = await request(app)
      .post('/api/hermes-openai/v1/chat/completions')
      .send({
        model: 'ax/gemma4:26b-a4b-it-qat',
        messages: [{ role: 'user', content: 'hi' }],
        options: { num_ctx: 65536 },
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual(expect.objectContaining({
      type: 'benchmark_claim_active',
      code: 'blocked_by_benchmark_claim',
    }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards chat completions and records OpenAI usage telemetry', async () => {
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.99:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockImplementation(async (url) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          model: 'ax/gemma4:26b-a4b-it-qat',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
        }),
      };
    });

    const res = await request(app)
      .post('/api/hermes-openai/v1/chat/completions')
      .set('Authorization', 'Bearer local')
      .set('X-Correlation-ID', 'hermes-run-0402')
      .set('X-AgentX-Work-Item-ID', '0402')
      .set('X-AgentX-Attempt', '3')
      .send({
        model: 'ax/gemma4:26b-a4b-it-qat',
        messages: [{ role: 'user', content: 'hi' }],
        options: { num_ctx: 65536 },
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-agentx-hermes-openai-proxy']).toBe('forwarded');
    expect(res.headers['x-agentx-upstream']).toBe('http://192.0.2.99:11434');
    expect(mockFetch.mock.calls[1][0]).toBe('http://192.0.2.99:11434/v1/chat/completions');
    // Task 0520 — behaviour change, asserted deliberately: the caller's
    // Authorization is NOT relayed to the local Ollama upstream. Ollama has no
    // authentication, so forwarding it only sent a caller's bearer token one hop
    // further than it needed to go, into another process's logs. This assertion
    // previously required the opposite.
    const forwardedHeaders = mockFetch.mock.calls[1][1].headers;
    expect(forwardedHeaders.Authorization).toBeUndefined();
    expect(forwardedHeaders.authorization).toBeUndefined();
    // Correlation still crosses the hop.
    expect(forwardedHeaders['x-correlation-id']).toBe('hermes-run-0402');

    await new Promise((r) => setImmediate(r));
    expect(mockRecordInference).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'proxy',
      callerDetail: 'hermes-openai',
      runtime: 'hermes',
      correlationId: 'hermes-run-0402',
      workItemId: '0402',
      attempt: 3,
      status: 'success',
      num_ctx: 65536,
      num_ctx_source: 'caller',
      tokensIn: 12,
      tokensOut: 5,
    }));
  });

  it('reports explicit num_ctx drift against the loaded context without rewriting the OpenAI body', async () => {
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.99:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockImplementation(async (url, opts = {}) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: 'ax/gemma4:26b-a4b-it-qat', context_length: 65536 }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: {},
          _forwardBody: opts.body
        }),
      };
    });

    const body = {
      model: 'ax/gemma4:26b-a4b-it-qat',
      messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 32768 },
    };
    const res = await request(app)
      .post('/api/hermes-openai/v1/chat/completions')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers['x-agentx-context-drift']).toBe('true');
    expect(res.headers['x-agentx-loaded-num-ctx']).toBe('65536');
    expect(res.headers['x-agentx-requested-num-ctx']).toBe('32768');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual(body);
    expect(logger.warn).toHaveBeenCalledWith(
      '[hermes-openai] caller num_ctx differs from loaded context',
      expect.objectContaining({
        requestedNumCtx: 32768,
        loadedNumCtx: 65536,
      })
    );
  });

  it('marks Gemma-style reasoning-only responses without rewriting them', async () => {
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.99:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: '', reasoning: 'hidden chain' },
          finish_reason: 'length'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 64, total_tokens: 74 }
      }),
    });

    const res = await request(app)
      .post('/api/hermes-openai/v1/chat/completions')
      .send({ model: 'gemma4:12b-it-qat', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.headers['x-agentx-hermes-reasoning-only']).toBe('true');
    expect(res.body.choices[0].message).toEqual(expect.objectContaining({
      content: '',
      reasoning: 'hidden chain'
    }));
  });

  it('forwards read-only /v1/models without checking claims', async () => {
    mockHasActiveBenchmarkClaim.mockReturnValue(true);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ data: [{ id: 'ax/gemma4:26b-a4b-it-qat' }] }),
    });

    const res = await request(app).get('/api/hermes-openai/v1/models');

    expect(res.status).toBe(200);
    expect(mockGetByHost).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://192.0.2.99:11434/v1/models');
  });

  it('supports Hermes discovery aliases without checking claims', async () => {
    mockHasActiveBenchmarkClaim.mockReturnValue(true);
    mockFetch.mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ upstreamUrl: url }),
    }));

    const models = await request(app).get('/api/hermes-openai/api/v1/models');
    const tags = await request(app).get('/api/hermes-openai/api/tags');
    const version = await request(app).get('/api/hermes-openai/version');
    const props = await request(app).get('/api/hermes-openai/v1/props');

    expect(models.status).toBe(200);
    expect(tags.status).toBe(200);
    expect(version.status).toBe(200);
    expect(props.status).toBe(200);
    expect(props.body).toEqual({});
    expect(mockGetByHost).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.map(call => call[0])).toEqual([
      'http://192.0.2.99:11434/v1/models',
      'http://192.0.2.99:11434/api/tags',
      'http://192.0.2.99:11434/api/version',
    ]);
  });

  it('uses AgentX model routing when no explicit Hermes upstream is configured', async () => {
    delete process.env.HERMES_OPENAI_UPSTREAM;
    mockGetTargetForModel.mockReturnValue('http://192.0.2.12:11434');
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.12:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        model: 'ax/qwen2.5:7b-instruct-q5_K_M',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {}
      }),
    });

    const res = await request(app)
      .post('/api/hermes-openai/v1/chat/completions')
      .send({
        model: 'ax/qwen2.5:7b-instruct-q5_K_M',
        messages: [{ role: 'user', content: 'hi' }]
      });

    expect(res.status).toBe(200);
    expect(mockGetTargetForModel).toHaveBeenCalledWith('ax/qwen2.5:7b-instruct-q5_K_M');
    expect(mockFetch.mock.calls[0][0]).toBe('http://192.0.2.12:11434/v1/chat/completions');
  });

  describe('RAG reflex (task 0271)', () => {
    beforeEach(() => {
      mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.99:11434', status: 'ready' });
      mockHasActiveBenchmarkClaim.mockReturnValue(false);
    });

    it('flag on → injects a `## Relevant knowledge` system block into the forwarded chat body', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      mockSearchSimilarChunks.mockResolvedValue([
        { text: 'Hermes uses the AgentX OpenAI-compatible proxy.', metadata: { source: 'arch.md', filename: 'arch.md' }, score: 0.88 },
      ]);
      mockFetch.mockResolvedValue({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} }),
      });

      const res = await request(app)
        .post('/api/hermes-openai/v1/chat/completions')
        .send({ model: 'ax/gemma4:26b-a4b-it-qat', messages: [{ role: 'user', content: 'how does hermes route?' }] });

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-rag-reflex']).toBe('injected');

      const chatCall = mockFetch.mock.calls.find(c => typeof c[0] === 'string' && c[0].endsWith('/v1/chat/completions'));
      const forwarded = JSON.parse(chatCall[1].body);
      const sys = forwarded.messages.find(m => m.role === 'system' && m.content.includes('## Relevant knowledge'));
      expect(sys).toBeDefined();
      expect(sys.content).toContain('Hermes uses the AgentX OpenAI-compatible proxy.');
      expect(forwarded.messages.some(m => m.role === 'user' && m.content === 'how does hermes route?')).toBe(true);
    });

    it('flag off (default) → forwards the chat body byte-identical, no retrieval', async () => {
      mockFetch.mockResolvedValue({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      });

      const body = { model: 'ax/gemma4:26b-a4b-it-qat', messages: [{ role: 'user', content: 'hi' }] };
      const res = await request(app).post('/api/hermes-openai/v1/chat/completions').send(body);

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-rag-reflex']).toBeUndefined();
      expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
      const chatCall = mockFetch.mock.calls.find(c => typeof c[0] === 'string' && c[0].endsWith('/v1/chat/completions'));
      expect(JSON.parse(chatCall[1].body)).toEqual(body);
    });

    it('memory-review caller stays a closed evidence bundle even when reflex is on', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      mockFetch.mockResolvedValue({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      });
      const body = {
        model: 'ax/gemma4:26b-a4b-it-qat',
        messages: [{ role: 'user', content: '[memory-review:evidence] {"observations":[]}' }],
      };
      const res = await request(app)
        .post('/api/hermes-openai/v1/chat/completions')
        .set('X-AgentX-Caller', 'memory-review')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-caller-detail']).toBe('hermes-memory-review');
      expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
      const chatCall = mockFetch.mock.calls.find(c => typeof c[0] === 'string' && c[0].endsWith('/v1/chat/completions'));
      expect(JSON.parse(chatCall[1].body)).toEqual(body);
    });
  });

  describe('cloud provider routing (#2, OpenRouter-first)', () => {
    it('routes an openrouter/* model to OpenRouter: injects the key, strips the prefix, skips Ollama gates', async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      mockFetch.mockResolvedValue({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          model: 'z-ai/glm-5.2',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }),
      });

      const res = await request(app)
        .post('/api/hermes-openai/v1/chat/completions')
        .set('Authorization', 'Bearer inbound-hermes')
        .send({ model: 'openrouter/z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] });

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-cloud-provider']).toBe('openrouter');
      expect(res.headers['x-agentx-upstream']).toBe('https://openrouter.ai/api/v1');

      // exactly one upstream call (no /api/ps drift probe), to OpenRouter
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
      // inbound Authorization overridden with the provider key
      // Relay headers are normalized to lower case so a header can never appear
      // twice under different casing; the injected server-side key is unchanged.
      expect(mockFetch.mock.calls[0][1].headers.authorization).toBe('Bearer sk-or-test');
      // routing prefix stripped for the upstream body; only the model is rewritten
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }],
      });
      // Ollama-only benchmark-claim gate skipped for cloud
      expect(mockGetByHost).not.toHaveBeenCalled();

      await new Promise((r) => setImmediate(r));
      expect(mockRecordInference).toHaveBeenCalledWith(expect.objectContaining({
        routedHost: 'openrouter', status: 'success', tokensIn: 9, tokensOut: 3,
      }));
    });

    it('returns an OpenAI-shaped 503 when OPENROUTER_API_KEY is unset', async () => {
      const res = await request(app)
        .post('/api/hermes-openai/v1/chat/completions')
        .send({ model: 'openrouter/z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] });

      expect(res.status).toBe(503);
      expect(res.body.error).toEqual(expect.objectContaining({
        type: 'cloud_provider_unconfigured',
        code: 'openrouter_api_key_missing',
      }));
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../../config/logger');

const mockGetByHost = jest.fn();
const mockHasActiveBenchmarkClaim = jest.fn();
jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: (...args) => mockGetByHost(...args),
  hasActiveBenchmarkClaim: (...args) => mockHasActiveBenchmarkClaim(...args),
  getPinnedEntries: (pref) => pref?.pinnedModels || [],
}));

const mockRecordInference = jest.fn();
jest.mock('../../src/services/modelRouter', () => ({
  recordInference: (...args) => mockRecordInference(...args),
  resolveHostKey: (host) => (host || '').replace(/^https?:\/\//, '').replace(/:\d+$/, ''),
}));

// RAG reflex (task 0271): the route uses the real proxyRagReflex + buildRagContext;
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
  // Re-require with a fresh module cache so env changes take effect.
  jest.isolateModules(() => {});
  const proxy = require('../../routes/openclaw-ollama-proxy');
  const app = express();
  app.use(express.json());
  app.use('/api/openclaw-ollama', proxy);
  return app;
}

describe('OpenClaw → Ollama claim-aware proxy (task 0180)', () => {
  let app;
  const ORIGINAL_ENV = process.env.OPENCLAW_OLLAMA_UPSTREAM;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENCLAW_OLLAMA_UPSTREAM = 'http://192.0.2.66:11434';
    delete process.env.OPENCLAW_PIN_GUARD_ENABLED;
    delete process.env.PROXY_RAG_REFLEX; // default OFF — existing tests assume passthrough
    app = buildApp();
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.OPENCLAW_OLLAMA_UPSTREAM;
    else process.env.OPENCLAW_OLLAMA_UPSTREAM = ORIGINAL_ENV;
    delete process.env.PROXY_RAG_REFLEX;
    delete process.env.OPENCLAW_PIN_GUARD_ENABLED;
  });

  it('returns 503 with Ollama-shaped error when an active benchmark claim is held', async () => {
    mockGetByHost.mockResolvedValue({
      hostUrl: 'http://192.0.2.66:11434',
      status: 'benchmarking',
      benchmarkClaim: { batchId: 'batch-xyz' },
    });
    mockHasActiveBenchmarkClaim.mockReturnValue(true);

    const res = await request(app)
      .post('/api/openclaw-ollama/api/chat')
      .send({
        model: 'ax/gemma4:26b',
        messages: [{ role: 'user', content: 'hi' }],
        options: { num_ctx: 32768 },
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.stringMatching(/active benchmark claim/),
    }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards inference requests when no claim is active and tags caller in inferencelogs', async () => {
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.66:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockImplementation(async (url) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: 'ax/gemma4:26b', message: { content: 'ok' }, prompt_eval_count: 5, eval_count: 7 }),
      };
    });

    const res = await request(app)
      .post('/api/openclaw-ollama/api/chat')
      .set('X-Correlation-ID', 'openclaw-run-0401')
      .set('X-AgentX-Work-Item-ID', '0401')
      .set('X-AgentX-Attempt', '2')
      .send({
        model: 'ax/gemma4:26b',
        messages: [{ role: 'user', content: 'hi' }],
        options: { num_ctx: 32768 },
      });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('http://192.0.2.66:11434/api/ps');
    expect(mockFetch.mock.calls[1][0]).toBe('http://192.0.2.66:11434/api/chat');

    // recordInference is dispatched via process.nextTick — wait one tick.
    await new Promise((r) => setImmediate(r));
    expect(mockRecordInference).toHaveBeenCalledTimes(1);
    expect(mockRecordInference.mock.calls[0][0]).toEqual(expect.objectContaining({
      caller: 'proxy',
      callerDetail: 'openclaw-ax',
      runtime: 'openclaw',
      correlationId: 'openclaw-run-0401',
      workItemId: '0401',
      attempt: 2,
      status: 'success',
      num_ctx: 32768,
      num_ctx_source: 'caller',
      tokensIn: 5,
      tokensOut: 7,
    }));
  });

  it('forwards a model that matches an app-managed pin', async () => {
    mockGetByHost.mockResolvedValue({
      hostUrl: 'http://192.0.2.66:11434',
      status: 'ready',
      pinnedModels: [{ model: 'gemma4:26b' }]
    });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: 'ax/gemma4:26b', done: true })
    });

    const res = await request(app)
      .post('/api/openclaw-ollama/api/generate')
      .send({ model: 'ax/gemma4:26b', prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['x-agentx-pin-guard']).toBeUndefined();
  });

  it('blocks an unpinned model before it can evict a resident pin', async () => {
    mockGetByHost.mockResolvedValue({
      hostUrl: 'http://192.0.2.66:11434',
      status: 'ready',
      pinnedModels: [{ model: 'gemma4:26b' }]
    });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);

    const res = await request(app)
      .post('/api/openclaw-ollama/api/chat')
      .send({ model: 'qwen3:30b', messages: [] });

    expect(res.status).toBe(409);
    expect(res.headers['x-agentx-pin-guard']).toBe('blocked');
    expect(res.body.error).toMatch(/allowed pinned inference call/);
    expect(mockFetch).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRecordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: 'blocked_by_pin_policy'
    }));
  });

  it('blocks model-management paths even when they name a pinned model', async () => {
    mockGetByHost.mockResolvedValue({
      hostUrl: 'http://192.0.2.66:11434',
      status: 'ready',
      pinnedModels: [{ model: 'gemma4:26b' }]
    });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);

    const res = await request(app)
      .delete('/api/openclaw-ollama/api/delete')
      .send({ name: 'ax/gemma4:26b' });

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('supports an explicit emergency rollback of the pin guard', async () => {
    process.env.OPENCLAW_PIN_GUARD_ENABLED = 'false';
    mockGetByHost.mockResolvedValue({
      hostUrl: 'http://192.0.2.66:11434',
      status: 'ready',
      pinnedModels: [{ model: 'gemma4:26b' }]
    });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: 'qwen3:30b', done: true })
    });

    const res = await request(app)
      .post('/api/openclaw-ollama/api/generate')
      .send({ model: 'qwen3:30b', prompt: 'diagnostic' });

    expect(res.status).toBe(200);
  });

  it('reports explicit num_ctx drift against the loaded Ollama context without rewriting the body', async () => {
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.66:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockImplementation(async (url, opts = {}) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: 'ax/gemma4:26b', context_length: 65536 }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: 'ax/gemma4:26b', done: true, _forwardBody: opts.body }),
      };
    });

    const body = { model: 'ax/gemma4:26b', prompt: 'hi', params: { num_ctx: 32768 } };
    const res = await request(app)
      .post('/api/openclaw-ollama/api/generate')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers['x-agentx-context-drift']).toBe('true');
    expect(res.headers['x-agentx-loaded-num-ctx']).toBe('65536');
    expect(res.headers['x-agentx-requested-num-ctx']).toBe('32768');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual(body);
    expect(logger.warn).toHaveBeenCalledWith(
      '[openclaw-ollama] caller num_ctx differs from loaded context',
      expect.objectContaining({
        requestedNumCtx: 32768,
        loadedNumCtx: 65536,
        loadedModel: 'ax/gemma4:26b'
      })
    );
  });

  it('always forwards read-only paths (/api/tags) without consulting the claim', async () => {
    mockHasActiveBenchmarkClaim.mockReturnValue(true);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ models: [{ name: 'ax/gemma4:26b' }] }),
    });

    const res = await request(app).get('/api/openclaw-ollama/api/tags');
    expect(res.status).toBe(200);
    expect(mockGetByHost).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit caller via the X-AgentX-Caller header', async () => {
    mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.66:11434', status: 'ready' });
    mockHasActiveBenchmarkClaim.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ done: true }),
    });

    await request(app)
      .post('/api/openclaw-ollama/api/generate')
      .set('X-AgentX-Caller', 'cron-overseer-prework')
      .send({ model: 'ax/gemma4:26b', prompt: 'hi' });

    await new Promise((r) => setImmediate(r));
    expect(mockRecordInference.mock.calls[0][0].callerDetail).toBe('openclaw-cron-overseer-prework');
  });

  it('blocks inference when the claim lookup itself throws', async () => {
    mockGetByHost.mockRejectedValue(new Error('mongo down'));
    mockHasActiveBenchmarkClaim.mockImplementation(() => { throw new Error('should not be called'); });
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ done: true }),
    });

    const res = await request(app)
      .post('/api/openclaw-ollama/api/chat')
      .send({ model: 'ax/gemma4:26b', messages: [] });

    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.stringMatching(/could not verify benchmark claim state/)
    }));
    expect(mockFetch).not.toHaveBeenCalled();

    await new Promise((r) => setImmediate(r));
    expect(mockRecordInference).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'proxy',
      callerDetail: 'openclaw-ax',
      status: 'error',
      error: 'benchmark_claim_lookup_failed'
    }));
  });

  describe('RAG reflex (task 0271)', () => {
    beforeEach(() => {
      mockGetByHost.mockResolvedValue({ hostUrl: 'http://192.0.2.66:11434', status: 'ready' });
      mockHasActiveBenchmarkClaim.mockReturnValue(false);
    });

    it('flag on → injects a `## Relevant knowledge` system block into the forwarded /api/chat body', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      mockSearchSimilarChunks.mockResolvedValue([
        { text: 'Host Alpha is the primary/masterbrain GPU Ollama host.', metadata: { source: 'hosts.md', filename: 'hosts.md' }, score: 0.92 },
      ]);
      mockFetch.mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify({ model: 'ax/gemma4:26b', message: { content: 'ok' } }),
      });

      const res = await request(app)
        .post('/api/openclaw-ollama/api/chat')
        .send({ model: 'ax/gemma4:26b', messages: [{ role: 'user', content: 'which host is primary?' }] });

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-rag-reflex']).toBe('injected');

      const chatCall = mockFetch.mock.calls.find(c => typeof c[0] === 'string' && c[0].endsWith('/api/chat'));
      const forwarded = JSON.parse(chatCall[1].body);
      const sys = forwarded.messages.find(m => m.role === 'system' && m.content.includes('## Relevant knowledge'));
      expect(sys).toBeDefined();
      expect(sys.content).toContain('Host Alpha is the primary/masterbrain GPU Ollama host.');
      // original user turn preserved
      expect(forwarded.messages.some(m => m.role === 'user' && m.content === 'which host is primary?')).toBe(true);
    });

    it('flag off (default) → forwards the chat body byte-identical, no retrieval', async () => {
      mockFetch.mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify({ done: true }),
      });

      const body = { model: 'ax/gemma4:26b', messages: [{ role: 'user', content: 'which host is primary?' }] };
      const res = await request(app).post('/api/openclaw-ollama/api/chat').send(body);

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-rag-reflex']).toBeUndefined();
      expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
      const chatCall = mockFetch.mock.calls.find(c => typeof c[0] === 'string' && c[0].endsWith('/api/chat'));
      expect(JSON.parse(chatCall[1].body)).toEqual(body);
    });

    it('flag on but RAG empty → passthrough, no injected block', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      mockSearchSimilarChunks.mockResolvedValue([]);
      mockFetch.mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify({ done: true }),
      });

      const body = { model: 'ax/gemma4:26b', messages: [{ role: 'user', content: 'anything' }] };
      const res = await request(app).post('/api/openclaw-ollama/api/chat').send(body);

      expect(res.status).toBe(200);
      expect(res.headers['x-agentx-rag-reflex']).toBeUndefined();
      const chatCall = mockFetch.mock.calls.find(c => typeof c[0] === 'string' && c[0].endsWith('/api/chat'));
      expect(JSON.parse(chatCall[1].body)).toEqual(body);
    });
  });
});

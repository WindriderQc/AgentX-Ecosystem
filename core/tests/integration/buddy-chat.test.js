// Phase 6f — /api/buddy/chat product-boundary tests.
const request = require('supertest');

jest.mock('../../src/services/memoryAdapters', () => ({
  searchMemory: jest.fn(),
  searchSingle: jest.fn(),
  statusForSource: jest.fn(),
  getEcosystemMemoryAlignmentStatus: jest.fn(),
}));

jest.mock('../../src/services/buddyPersonality', () => {
  const actual = jest.requireActual('../../src/services/buddyPersonality');
  return {
    ...actual,
    resolvePersonality: jest.fn(),
  };
});

jest.mock('../../models/Buddy', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  create: jest.fn(),
}));

const memoryAdapters = require('../../src/services/memoryAdapters');
const buddyPersonality = require('../../src/services/buddyPersonality');
const Buddy = require('../../models/Buddy');
const { app } = require('../../src/app');

describe('POST /api/buddy/chat (Phase 6f)', () => {
  const clientId = 'buddy-chat-test-' + Date.now();
  let originalFetch;

  beforeEach(() => {
    memoryAdapters.searchMemory.mockReset();
    memoryAdapters.searchSingle.mockReset();
    memoryAdapters.statusForSource.mockReset();
    memoryAdapters.getEcosystemMemoryAlignmentStatus.mockReset();
    buddyPersonality.resolvePersonality.mockReset();
    Buddy.findOne.mockReset();
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: [], k: 5 },
      model: { host: '', model: '' },
      personality: { source: 'standalone', agentId: '' },
      soul: 'fallback',
    });
    buddyPersonality.resolvePersonality.mockResolvedValue({
      soul: 'You are buddy.',
      source: 'standalone',
      ref: null,
    });
    memoryAdapters.searchMemory.mockResolvedValue([]);
    memoryAdapters.searchSingle.mockResolvedValue([]);
    memoryAdapters.statusForSource.mockImplementation(async (source) => ({ source, available: true }));
    memoryAdapters.getEcosystemMemoryAlignmentStatus.mockResolvedValue({
      policy: { sharedMemoryLane: 'agentx-rag' },
      shared: { rag: { source: 'agentx-rag', vectorDimension: 768 } },
      private: {},
      compatibility: {},
      warnings: [],
    });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns 400 when messages is missing', async () => {
    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-missing')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_messages');
  });

  it('returns 400 when messages is empty', async () => {
    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-empty')
      .send({ messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_messages');
  });

  it('returns 400 when role is invalid', async () => {
    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-role')
      .send({ messages: [{ role: 'system', content: 'hi' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_messages');
  });

  it('returns ecosystem memory alignment status', async () => {
    const res = await request(app)
      .get('/api/buddy/memory/alignment')
      .set('x-test-client', clientId + '-alignment');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'success',
      data: {
        status: expect.objectContaining({
          policy: expect.objectContaining({ sharedMemoryLane: 'agentx-rag' }),
          shared: expect.objectContaining({
            rag: expect.objectContaining({ vectorDimension: 768 }),
          }),
        }),
      },
    }));
    expect(memoryAdapters.getEcosystemMemoryAlignmentStatus).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with personality + memory metadata when standalone, no memory sources', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'Reply.' } }),
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-default')
      .send({ messages: [{ role: 'user', content: 'hello' }], sessionId: 'sid-1' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Reply.');
    expect(res.body.sessionId).toBe('sid-1');
    expect(res.body.personality).toEqual({ source: 'standalone', ref: null });
    expect(res.body.memory).toEqual({ sources: expect.any(Array), chunks: 0 });
    expect(res.body.warnings).toEqual([]);
    expect(res.body.model).toEqual(expect.objectContaining({ host: '', model: '' }));
    expect(memoryAdapters.searchMemory).not.toHaveBeenCalled();
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.taskType).toBe('buddy_chat');
    expect(body.callerDetail).toBe('buddy/chat');
  });

  it('does not pass source field anymore', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok.' } }),
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-no-source')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.source).toBeUndefined();
  });

  it('reports the Agent X personality and ref', async () => {
    buddyPersonality.resolvePersonality.mockResolvedValue({
      soul: 'I am Agent X shaped.',
      source: 'agentx',
      ref: 'agentx:buddy.soul',
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'Hi.' } }),
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-agentx-pers')
      .send({ messages: [{ role: 'user', content: 'who are you' }] });

    expect(res.status).toBe(200);
    expect(res.body.personality).toEqual({ source: 'agentx', ref: 'agentx:buddy.soul' });
  });

  it('honors brain.perTask.chat for per-task model resolution', async () => {
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: [], k: 5 },
      model: { host: 'legacy-host', model: 'legacy-model' },
      brain: {
        defaults: { host: 'def-host', model: 'def-model' },
        perTask: { chat: { host: 'Host Gamma', model: 'qwen2.5:7b-instruct-q5_K_M' }, react: {}, summarize: {} },
      },
      personality: { source: 'standalone', agentId: '' },
      soul: '',
      facts: [],
    });

    let captured = null;
    global.fetch = jest.fn().mockImplementation((url, opts) => {
      captured = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ message: { content: 'ack.' } }) });
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-pertask-chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.model).toEqual(expect.objectContaining({
      host: 'Host Gamma',
      model: 'qwen2.5:7b-instruct-q5_K_M',
      requestedHost: 'Host Gamma',
      requestedModel: 'qwen2.5:7b-instruct-q5_K_M'
    }));
    expect(captured.host).toBe('Host Gamma');
    expect(captured.model).toBe('qwen2.5:7b-instruct-q5_K_M');
  });

  it('falls back to brain.defaults when perTask is empty', async () => {
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: [], k: 5 },
      model: { host: '', model: '' },
      brain: {
        defaults: { host: 'def-host', model: 'def-model' },
        perTask: { chat: {}, react: {}, summarize: {} },
      },
      personality: { source: 'standalone', agentId: '' },
      soul: '',
      facts: [],
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok.' } }),
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-pertask-fallback')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.model).toEqual(expect.objectContaining({
      host: 'def-host',
      model: 'def-model',
      requestedHost: 'def-host',
      requestedModel: 'def-model'
    }));
  });

  it('injects facts into the system prompt and reports facts.count', async () => {
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: [], k: 5 },
      model: { host: '', model: '' },
      personality: { source: 'standalone', agentId: '' },
      soul: '',
      facts: [
        { text: 'Example User prefers Host Gamma for buddy traffic', addedAt: new Date(), weight: 1 },
        { text: 'Host Beta wedges under sustained load', addedAt: new Date(), weight: 1 },
      ],
    });

    let captured = null;
    global.fetch = jest.fn().mockImplementation((url, opts) => {
      captured = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ message: { content: 'ack.' } }) });
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-facts')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.facts).toEqual({ count: 2 });
    const sysMsg = captured.messages[0];
    expect(sysMsg.content).toMatch(/Known facts/);
    expect(sysMsg.content).toMatch(/Host Gamma/);
  });

  it('honors agentx as a memory source', async () => {
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: ['agentx'], k: 4 },
      model: { host: '', model: '' },
      personality: { source: 'standalone', agentId: '' },
      soul: '',
      facts: [],
    });
    memoryAdapters.searchMemory.mockResolvedValue([
      { source: 'agentx', text: 'Recent benchmark: gemma4:26b on Host Delta', score: 4.3, ref: 'conversation:abc' },
    ]);

    let captured = null;
    global.fetch = jest.fn().mockImplementation((url, opts) => {
      captured = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ message: { content: 'ok.' } }) });
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-agentx-source')
      .send({ messages: [{ role: 'user', content: 'recent benchmarks' }] });

    expect(res.status).toBe(200);
    expect(res.body.memory).toEqual({ sources: ['agentx'], chunks: 1 });
    expect(res.body.warnings).toEqual([]);
    expect(memoryAdapters.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      sources: ['agentx'], query: 'recent benchmarks', k: 4,
    }));
    const sysMsg = captured.messages[0];
    expect(sysMsg.content).toMatch(/Relevant memory/);
    expect(sysMsg.content).toMatch(/gemma4:26b/);
  });

  it('injects memory chunks into the system prompt when memory sources are configured', async () => {
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: ['agentx'], k: 3 },
      model: { host: '', model: '' },
      personality: { source: 'standalone', agentId: '' },
      soul: '',
    });
    memoryAdapters.searchMemory.mockResolvedValue([
      { source: 'agentx', text: 'Benchmark recovery procedure', score: 5, ref: 'alert:1' },
      { source: 'agentx', text: 'Pinned models per host', score: 3, ref: 'inferencelog:2' },
    ]);

    let captured = null;
    global.fetch = jest.fn().mockImplementation((url, opts) => {
      captured = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ message: { content: 'ack.' } }) });
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-mem-inject')
      .send({ messages: [{ role: 'user', content: 'tell me about host-beta' }] });

    expect(res.status).toBe(200);
    expect(res.body.memory).toEqual({ sources: ['agentx'], chunks: 2 });
    expect(memoryAdapters.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      sources: ['agentx'],
      query: 'tell me about host-beta',
      k: 3,
    }));
    expect(captured).not.toBeNull();
    const sysMsg = captured.messages[0];
    expect(sysMsg.role).toBe('system');
    expect(sysMsg.content).toMatch(/Relevant memory/);
    expect(sysMsg.content).toMatch(/Benchmark recovery/);
  });

  it('returns warning metadata when configured memory source is unavailable', async () => {
    Buddy.findOne.mockResolvedValue({
      seed: 'global',
      mood: 'neutral',
      stats: {},
      memory: { sources: ['agentx'], k: 5 },
      model: { host: '', model: '' },
      personality: { source: 'standalone', agentId: '' },
      soul: '',
      facts: [],
    });
    memoryAdapters.searchMemory.mockResolvedValue([]);
    memoryAdapters.statusForSource.mockResolvedValue({
      source: 'agentx',
      available: false,
      reason: 'ENOENT',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok.' } }),
    });

    const res = await request(app)
      .post('/api/buddy/chat')
      .set('x-test-client', clientId + '-memory-warning')
      .send({ messages: [{ role: 'user', content: 'what do you remember?' }] });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'memory_sources_unavailable', sources: ['agentx'] }),
    ]));
    expect(res.body.sourceHealth.memory.agentx).toEqual(expect.objectContaining({
      available: false,
    }));
  });
});

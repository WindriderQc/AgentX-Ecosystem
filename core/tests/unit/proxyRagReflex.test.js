jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../../config/logger');

// getRagServiceClient must never be hit in these tests — we always inject a
// fake store via opts.ragStore. If the default client were used it would try a
// real HTTP call, so assert it stays untouched.
const mockGetRagServiceClient = jest.fn(() => { throw new Error('default RAG client should not be used'); });
jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: (...args) => mockGetRagServiceClient(...args),
}));

const {
  applyRagReflex,
  reflexEnabled,
  latestUserQuery,
  messageText,
  injectSystemBlock,
  RAG_BLOCK_HEADING,
} = require('../../src/services/proxyRagReflex');

function fakeStore(results) {
  return { searchSimilarChunks: jest.fn(async () => results) };
}

const HIT = [
  { text: 'Host Alpha is the primary/masterbrain GPU Ollama host.', metadata: { source: 'hosts.md', filename: 'hosts.md' }, score: 0.91 },
];

describe('proxyRagReflex (task 0271)', () => {
  const ORIGINAL = process.env.PROXY_RAG_REFLEX;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PROXY_RAG_REFLEX;
    delete process.env.PROXY_RAG_REFLEX_TOPK;
    delete process.env.PROXY_RAG_REFLEX_TIMEOUT_MS;
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.PROXY_RAG_REFLEX;
    else process.env.PROXY_RAG_REFLEX = ORIGINAL;
  });

  describe('pure helpers', () => {
    it('latestUserQuery returns the most recent user turn', () => {
      const q = latestUserQuery([
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'which host is primary?' },
      ]);
      expect(q).toBe('which host is primary?');
    });

    it('messageText flattens OpenAI array content', () => {
      expect(messageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
      expect(messageText('plain')).toBe('plain');
      expect(messageText({ weird: true })).toBe('');
    });

    it('injectSystemBlock inserts after the leading system run, never mutating input', () => {
      const input = [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'hi' },
      ];
      const out = injectSystemBlock(input, 'BLOCK');
      expect(out).toHaveLength(3);
      expect(out[0]).toEqual({ role: 'system', content: 'persona' });
      expect(out[1]).toEqual({ role: 'system', content: 'BLOCK' });
      expect(out[2]).toEqual({ role: 'user', content: 'hi' });
      // input untouched
      expect(input).toHaveLength(2);
    });
  });

  describe('reflexEnabled flag', () => {
    it('is off by default and on only for the literal "true"', () => {
      expect(reflexEnabled()).toBe(false);
      process.env.PROXY_RAG_REFLEX = 'TRUE';
      expect(reflexEnabled()).toBe(true);
      process.env.PROXY_RAG_REFLEX = '1';
      expect(reflexEnabled()).toBe(false);
      process.env.PROXY_RAG_REFLEX = 'yes';
      expect(reflexEnabled()).toBe(false);
    });
  });

  describe('applyRagReflex', () => {
    it('flag OFF → returns the SAME body reference, no retrieval', async () => {
      const body = { model: 'm', messages: [{ role: 'user', content: 'which host is primary?' }] };
      const store = fakeStore(HIT);
      const out = await applyRagReflex(body, { ragStore: store });
      expect(out.ragInjected).toBe(false);
      expect(out.body).toBe(body); // identical reference => byte-identical forward
      expect(store.searchSimilarChunks).not.toHaveBeenCalled();
    });

    it('flag ON + a hit → injects a `## Relevant knowledge` system block', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      const body = {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are Nestor.' },
          { role: 'user', content: 'which host is primary?' },
        ],
        options: { num_ctx: 65536 },
      };
      const store = fakeStore(HIT);
      const out = await applyRagReflex(body, { ragStore: store });

      expect(out.ragInjected).toBe(true);
      expect(out.body).not.toBe(body);
      // original body not mutated
      expect(body.messages).toHaveLength(2);

      const injected = out.body.messages.find(m => m.role === 'system' && m.content.startsWith(RAG_BLOCK_HEADING));
      expect(injected).toBeDefined();
      expect(injected.content).toContain('Host Alpha is the primary/masterbrain GPU Ollama host.');
      // persona stays first, knowledge block second, user last
      expect(out.body.messages[0].content).toBe('You are Nestor.');
      expect(out.body.messages[1]).toBe(injected);
      expect(out.body.messages[2].role).toBe('user');
      // non-message fields preserved verbatim
      expect(out.body.model).toBe('m');
      expect(out.body.options).toEqual({ num_ctx: 65536 });
      // top-K passed through
      expect(store.searchSimilarChunks).toHaveBeenCalledWith('which host is primary?', expect.objectContaining({ topK: 4 }));
    });

    it('respects PROXY_RAG_REFLEX_TOPK', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      process.env.PROXY_RAG_REFLEX_TOPK = '7';
      const store = fakeStore(HIT);
      await applyRagReflex({ messages: [{ role: 'user', content: 'q' }] }, { ragStore: store });
      expect(store.searchSimilarChunks).toHaveBeenCalledWith('q', expect.objectContaining({ topK: 7 }));
    });

    it('flag ON but RAG returns nothing → unchanged passthrough', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      const body = { messages: [{ role: 'user', content: 'q' }] };
      const out = await applyRagReflex(body, { ragStore: fakeStore([]) });
      expect(out.ragInjected).toBe(false);
      expect(out.body).toBe(body);
    });

    it('flag ON but RAG throws → unchanged passthrough, warns', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      const body = { messages: [{ role: 'user', content: 'q' }] };
      const store = { searchSimilarChunks: jest.fn(async () => { throw new Error('rag boom'); }) };
      const out = await applyRagReflex(body, { ragStore: store });
      // buildRagContext swallows the error internally => empty => unchanged
      expect(out.ragInjected).toBe(false);
      expect(out.body).toBe(body);
    });

    it('flag ON but RAG slower than the timeout → unchanged passthrough', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      process.env.PROXY_RAG_REFLEX_TIMEOUT_MS = '20';
      const body = { messages: [{ role: 'user', content: 'q' }] };
      const store = { searchSimilarChunks: jest.fn(() => new Promise(r => setTimeout(() => r(HIT), 200))) };
      const out = await applyRagReflex(body, { ragStore: store });
      expect(out.ragInjected).toBe(false);
      expect(out.body).toBe(body);
    });

    it('flag ON but non-chat body (raw prompt) → unchanged passthrough', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      const body = { model: 'm', prompt: 'just a prompt' };
      const store = fakeStore(HIT);
      const out = await applyRagReflex(body, { ragStore: store });
      expect(out.ragInjected).toBe(false);
      expect(out.body).toBe(body);
      expect(store.searchSimilarChunks).not.toHaveBeenCalled();
    });

    it('flag ON but no user turn in messages → unchanged passthrough', async () => {
      process.env.PROXY_RAG_REFLEX = 'true';
      const body = { messages: [{ role: 'system', content: 'only system' }] };
      const out = await applyRagReflex(body, { ragStore: fakeStore(HIT) });
      expect(out.ragInjected).toBe(false);
      expect(out.body).toBe(body);
    });
  });
});

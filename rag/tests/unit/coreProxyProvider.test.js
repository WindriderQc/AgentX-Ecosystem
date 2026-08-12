jest.mock('node-fetch', () => jest.fn());
jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const fetch = require('node-fetch');
const CoreProxyProvider = require('../../src/services/embeddings/coreProxyProvider');

function okEmbedding(embedding = [0.1, 0.2, 0.3]) {
  return {
    ok: true,
    json: async () => ({ embedding }),
    text: async () => JSON.stringify({ embedding }),
  };
}

function failRes(status, body = 'error') {
  return { ok: false, status, text: async () => body };
}

beforeEach(() => fetch.mockReset());

// ── Constructor ──────────────────────────────────────────

describe('CoreProxyProvider constructor', () => {
  it('uses config values', () => {
    const p = new CoreProxyProvider({
      coreProxyUrl: 'http://core:3080',
      embeddingModel: 'custom-model',
      dimension: 512,
    });
    expect(p.coreProxyUrl).toBe('http://core:3080');
    expect(p.model).toBe('custom-model');
    expect(p.dimension).toBe(512);
    expect(p.name).toBe('core-proxy');
  });

  it('falls back to defaults', () => {
    const p = new CoreProxyProvider();
    expect(p.coreProxyUrl).toBe(process.env.CORE_PROXY_URL || 'http://localhost:3080');
    expect(p.batchSize).toBe(10);
    expect(p.maxTextLength).toBe(8000);
  });
});

// ── _validateText ────────────────────────────────────────

describe('_validateText', () => {
  let provider;
  beforeEach(() => { provider = new CoreProxyProvider(); });

  it('throws on empty string', () => {
    expect(() => provider._validateText('')).toThrow('non-empty string');
  });

  it('throws on null', () => {
    expect(() => provider._validateText(null)).toThrow('non-empty string');
  });

  it('throws on non-string', () => {
    expect(() => provider._validateText(123)).toThrow('non-empty string');
  });

  it('does not throw on valid text', () => {
    expect(() => provider._validateText('hello')).not.toThrow();
  });
});

// ── _truncateText ────────────────────────────────────────

describe('_truncateText', () => {
  let provider;
  beforeEach(() => { provider = new CoreProxyProvider(); });

  it('returns text unchanged when under limit', () => {
    expect(provider._truncateText('short')).toBe('short');
  });

  it('truncates text exceeding maxTextLength', () => {
    const long = 'x'.repeat(9000);
    expect(provider._truncateText(long)).toHaveLength(8000);
  });
});

// ── embed ────────────────────────────────────────────────

describe('embed', () => {
  it('sends correct request to core proxy', async () => {
    fetch.mockResolvedValueOnce(okEmbedding());
    const provider = new CoreProxyProvider({ coreProxyUrl: 'http://core:3080' });

    const result = await provider.embed('hello world');
    expect(result).toEqual([0.1, 0.2, 0.3]);

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('http://core:3080/api/inference/embed');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.prompt).toBe('hello world');
    expect(body.model).toBeDefined();
  });

  it('passes preferredHost as ollamaHost', async () => {
    fetch.mockResolvedValueOnce(okEmbedding());
    const provider = new CoreProxyProvider();
    await provider.embed('text', 'http://custom:11434');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.ollamaHost).toBe('http://custom:11434');
  });

  it('does not include ollamaHost when preferredHost is null', async () => {
    fetch.mockResolvedValueOnce(okEmbedding());
    const provider = new CoreProxyProvider();
    await provider.embed('text');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.ollamaHost).toBeUndefined();
  });

  it('validates text before requesting', async () => {
    const provider = new CoreProxyProvider();
    await expect(provider.embed('')).rejects.toThrow('non-empty string');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('truncates long text before sending', async () => {
    fetch.mockResolvedValueOnce(okEmbedding());
    const provider = new CoreProxyProvider();
    await provider.embed('x'.repeat(9000));
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toHaveLength(8000);
  });

  it('throws on non-ok response', async () => {
    fetch.mockResolvedValueOnce(failRes(502, 'bad gateway'));
    const provider = new CoreProxyProvider();
    await expect(provider.embed('test')).rejects.toThrow('Failed to generate embedding');
  });

  it('throws on invalid response (missing embedding)', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 'unexpected' }),
    });
    const provider = new CoreProxyProvider();
    await expect(provider.embed('test')).rejects.toThrow('Failed to generate embedding');
  });

  it('throws on network error', async () => {
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const provider = new CoreProxyProvider();
    await expect(provider.embed('test')).rejects.toThrow('Failed to generate embedding');
  });
});

// ── embedBatch ───────────────────────────────────────────

describe('embedBatch', () => {
  it('processes all texts and returns embeddings', async () => {
    fetch.mockResolvedValue(okEmbedding([1, 2, 3]));
    const provider = new CoreProxyProvider();
    const results = await provider.embedBatch(['a', 'b', 'c']);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual([1, 2, 3]);
  });

  it('throws on empty array', async () => {
    const provider = new CoreProxyProvider();
    await expect(provider.embedBatch([])).rejects.toThrow('non-empty array');
  });

  it('throws on non-array', async () => {
    const provider = new CoreProxyProvider();
    await expect(provider.embedBatch('not an array')).rejects.toThrow('non-empty array');
  });

  it('batches in groups of batchSize', async () => {
    fetch.mockResolvedValue(okEmbedding());
    const provider = new CoreProxyProvider({ batchSize: 3 });
    await provider.embedBatch(['a', 'b', 'c', 'd', 'e']);
    // 3 + 2 = 5 individual embed calls
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

// ── getDimension ─────────────────────────────────────────

describe('getDimension', () => {
  it('returns configured dimension', () => {
    const provider = new CoreProxyProvider({ dimension: 1024 });
    expect(provider.getDimension()).toBe(1024);
  });
});

// ── testConnection ───────────────────────────────────────

describe('testConnection', () => {
  it('returns true when embed succeeds with correct dimension', async () => {
    const embedding = Array.from({ length: 768 }, () => 0.1);
    fetch.mockResolvedValueOnce(okEmbedding(embedding));
    const provider = new CoreProxyProvider({ dimension: 768 });
    expect(await provider.testConnection()).toBe(true);
  });

  it('returns false when embed fails', async () => {
    fetch.mockRejectedValueOnce(new Error('down'));
    const provider = new CoreProxyProvider();
    expect(await provider.testConnection()).toBe(false);
  });
});

// ── destroy ──────────────────────────────────────────────

describe('destroy', () => {
  it('is callable without error', () => {
    const provider = new CoreProxyProvider();
    expect(() => provider.destroy()).not.toThrow();
  });
});

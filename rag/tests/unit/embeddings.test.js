jest.mock('node-fetch', () => jest.fn());

describe('Embeddings providers', () => {
  const originalEnv = process.env;
  let fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    fetch = require('node-fetch');
    fetch.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('selects the direct Ollama provider by default', () => {
    process.env.OLLAMA_HOSTS = 'alpha:11434';

    const { getEmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    const service = getEmbeddingsService();

    expect(service.providerName).toBe('ollama-direct');
    expect(typeof service.embed).toBe('function');

    resetEmbeddingsService();
  });

  it('selects the core proxy provider when configured', () => {
    process.env.EMBEDDING_PROVIDER = 'core-proxy';

    const { getEmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    const service = getEmbeddingsService();

    expect(service.providerName).toBe('core-proxy');

    resetEmbeddingsService();
  });

  it('rotates Ollama hosts in round-robin order', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] })
    });

    const provider = new OllamaProvider({
      ollamaHosts: 'alpha:11434,beta:11434,gamma:11434'
    });

    await provider.embed('first');
    await provider.embed('second');
    await provider.embed('third');

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://alpha:11434/api/embeddings',
      'http://beta:11434/api/embeddings',
      'http://gamma:11434/api/embeddings'
    ]);
  });

  it('falls back to the next Ollama host when the current one fails', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'boom'
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [1, 2, 3] })
      });

    const provider = new OllamaProvider({
      ollamaHosts: 'alpha:11434,beta:11434'
    });

    await expect(provider.embed('hello')).resolves.toEqual([1, 2, 3]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://alpha:11434/api/embeddings',
      'http://beta:11434/api/embeddings'
    ]);
  });

  it('uses native Ollama batch embed endpoint for a multi-text batch', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
          [0.7, 0.8, 0.9],
        ]
      })
    });

    const provider = new OllamaProvider({ ollamaHosts: 'alpha:11434' });
    const results = await provider.embedBatch(['first', 'second', 'third']);

    expect(results).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('http://alpha:11434/api/embed');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      model: 'nomic-embed-text:v1.5',
      input: ['first', 'second', 'third']
    });
  });

  it('splits native batch embedding work into groups of 10 and preserves vector order', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch.mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          embeddings: body.input.map((text) => [Number(text.replace('text-', ''))])
        })
      };
    });

    const provider = new OllamaProvider({ ollamaHosts: 'alpha:11434' });
    const results = await provider.embedBatch(
      Array.from({ length: 25 }, (_, index) => `text-${index}`)
    );

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://alpha:11434/api/embed',
      'http://alpha:11434/api/embed',
      'http://alpha:11434/api/embed'
    ]);
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).input.length)).toEqual([10, 10, 5]);
    expect(results).toEqual(Array.from({ length: 25 }, (_, index) => [index]));
  });

  it('falls back to the next Ollama host when native batch embedding fails', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'boom'
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[1], [2]] })
      });

    const provider = new OllamaProvider({
      ollamaHosts: 'alpha:11434,beta:11434'
    });

    await expect(provider.embedBatch(['a', 'b'])).resolves.toEqual([[1], [2]]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://alpha:11434/api/embed',
      'http://beta:11434/api/embed'
    ]);
  });

  it('falls back to legacy single-prompt embeddings when native batch endpoint is missing', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'not found'
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [1] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [2] })
      });

    const provider = new OllamaProvider({ ollamaHosts: 'alpha:11434' });

    await expect(provider.embedBatch(['a', 'b'])).resolves.toEqual([[1], [2]]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://alpha:11434/api/embed',
      'http://alpha:11434/api/embeddings',
      'http://alpha:11434/api/embeddings'
    ]);
    expect(fetch.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body).prompt)).toEqual(['a', 'b']);
  });

  it('rejects native batch embedding responses with mismatched counts', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1]] })
    });

    const provider = new OllamaProvider({ ollamaHosts: 'alpha:11434' });

    await expect(provider.embedBatch(['a', 'b'])).rejects.toThrow('count mismatch');
  });

  it('truncates text to 8000 characters before requesting embeddings', async () => {
    const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');

    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] })
    });

    const provider = new OllamaProvider({ ollamaHosts: 'alpha:11434' });

    await provider.embed('x'.repeat(9000));

    const [, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body).prompt).toHaveLength(8000);
  });
});

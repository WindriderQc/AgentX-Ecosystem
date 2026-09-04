'use strict';

jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

describe('Embeddings provider boundary', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('selects the admission-backed Core proxy by default', () => {
    delete process.env.EMBEDDING_PROVIDER;

    const { getEmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    const service = getEmbeddingsService();

    expect(service.providerName).toBe('core-proxy');
    expect(typeof service.embed).toBe('function');
    resetEmbeddingsService();
  });

  it('selects the Core proxy when configured explicitly', () => {
    process.env.EMBEDDING_PROVIDER = 'core-proxy';

    const { getEmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    const service = getEmbeddingsService();

    expect(service.providerName).toBe('core-proxy');
    resetEmbeddingsService();
  });

  it.each([
    ['environment', () => {
      process.env.EMBEDDING_PROVIDER = 'ollama-direct';
      const { getEmbeddingsService } = require('../../src/services/embeddings');
      return () => getEmbeddingsService();
    }],
    ['explicit config', () => {
      const { createEmbeddingsProvider } = require('../../src/services/embeddings');
      return () => createEmbeddingsProvider({ embeddingProvider: 'ollama-direct' });
    }],
    ['legacy direct import', () => {
      const OllamaProvider = require('../../src/services/embeddings/ollamaProvider');
      return () => new OllamaProvider({ ollamaHosts: 'alpha:11434' });
    }]
  ])('cannot reactivate direct Ollama embeddings through %s', (_source, buildAttempt) => {
    expect(buildAttempt()).toThrow(expect.objectContaining({
      code: 'DIRECT_OLLAMA_EMBEDDINGS_DISABLED'
    }));
  });

  it('rejects unknown providers rather than falling back to a direct host', () => {
    const { createEmbeddingsProvider } = require('../../src/services/embeddings');
    expect(() => createEmbeddingsProvider({ embeddingProvider: 'unknown' }))
      .toThrow('Unsupported embedding provider: unknown');
  });
});

'use strict';

// `/status` is observational by design: a GET never starts embedding
// inference. That leaves a gap — a freshly started service holds no evidence
// and reports its embedding dependency unhealthy until an operator POSTs a
// refresh, which nothing in normal operation does. These tests pin the
// behaviour that closes it: a real embedding call is itself the probe.

describe('EmbeddingsService connection evidence', () => {
  const originalEnv = process.env;
  let EmbeddingsService;
  let resetEmbeddingCache;

  function buildService(provider) {
    const service = new EmbeddingsService({});
    service.provider = provider;
    service.dimension = provider.getDimension();
    return service;
  }

  function stubProvider(overrides = {}) {
    return {
      name: 'stub',
      model: 'stub-model',
      getDimension: () => 3,
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
      testConnection: jest.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'test', OLLAMA_HOSTS: 'alpha:11434' };
    ({ EmbeddingsService } = require('../../src/services/embeddings'));
    ({ resetEmbeddingCache } = require('../../src/services/embeddingCache'));
    resetEmbeddingCache();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('holds no evidence before anything has exercised the provider', () => {
    const service = buildService(stubProvider());

    // This is the precondition the false "degraded" reading came from.
    expect(service.getCachedConnectionStatus()).toBeNull();
  });

  it('records healthy evidence from a successful embed', async () => {
    const service = buildService(stubProvider());

    await service.embed('a real question');

    const status = service.getCachedConnectionStatus();
    expect(status).toEqual(expect.objectContaining({
      healthy: true,
      stale: false,
      source: 'traffic',
    }));
    expect(typeof status.checkedAt).toBe('number');
  });

  it('records unhealthy evidence from a failing embed and still rethrows', async () => {
    const service = buildService(stubProvider({
      embed: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    }));

    await expect(service.embed('a real question')).rejects.toThrow('connect ECONNREFUSED');
    expect(service.getCachedConnectionStatus()).toEqual(
      expect.objectContaining({ healthy: false })
    );
  });

  it('rejects a wrong-dimension vector and records unhealthy evidence', async () => {
    const service = buildService(stubProvider({
      embed: jest.fn().mockResolvedValue([0.1]),
    }));

    await expect(service.embed('wrong dimension')).rejects.toThrow(
      'expected 3 finite values, got 1'
    );
    expect(service.getCachedConnectionStatus()).toEqual(
      expect.objectContaining({ healthy: false, source: 'traffic' })
    );
  });

  it('rejects non-finite vector values and records unhealthy evidence', async () => {
    const service = buildService(stubProvider({
      embed: jest.fn().mockResolvedValue([0.1, Number.NaN, 0.3]),
    }));

    await expect(service.embed('invalid values')).rejects.toThrow('finite values');
    expect(service.getCachedConnectionStatus().healthy).toBe(false);
  });

  it('lets a later success correct an earlier failure', async () => {
    const embed = jest.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce([0.1, 0.2, 0.3]);
    const service = buildService(stubProvider({ embed }));

    await expect(service.embed('first')).rejects.toThrow();
    expect(service.getCachedConnectionStatus().healthy).toBe(false);

    await service.embed('second');
    expect(service.getCachedConnectionStatus().healthy).toBe(true);
  });

  it('does not invent evidence when the answer came from cache', async () => {
    const provider = stubProvider();
    const service = buildService(provider);

    await service.embed('same text');
    expect(provider.embed).toHaveBeenCalledTimes(1);

    // A cache hit proves nothing about the connection, so the recorded
    // observation must not be refreshed by it.
    const afterFirst = service.getCachedConnectionStatus().checkedAt;
    service._connectionStatus = null;

    await service.embed('same text');
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(service.getCachedConnectionStatus()).toBeNull();
    expect(typeof afterFirst).toBe('number');
  });

  it('records evidence from embedBatch when it reaches the provider', async () => {
    const service = buildService(stubProvider({
      embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]),
    }));

    await service.embedBatch(['one', 'two']);

    expect(service.getCachedConnectionStatus()).toEqual(
      expect.objectContaining({ healthy: true })
    );
  });

  it('rejects an incomplete batch and records unhealthy evidence', async () => {
    const service = buildService(stubProvider({
      embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    }));

    await expect(service.embedBatch(['one', 'two'])).rejects.toThrow(
      'expected 2 vectors, got 1'
    );
    expect(service.getCachedConnectionStatus().healthy).toBe(false);
  });

  it('rejects a wrong-dimension vector inside a batch', async () => {
    const service = buildService(stubProvider({
      embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3], [0.4]]),
    }));

    await expect(service.embedBatch(['one', 'two'])).rejects.toThrow(
      'expected 3 finite values, got 1'
    );
    expect(service.getCachedConnectionStatus().healthy).toBe(false);
  });

  it('retains startup proof when later traffic becomes the latest observation', async () => {
    const service = buildService(stubProvider());

    await service.refreshConnectionStatus({ source: 'startup' });
    const startupVerifiedAt = service.getCachedConnectionStatus().startupVerifiedAt;
    await service.embed('later traffic');

    expect(service.getCachedConnectionStatus()).toEqual(expect.objectContaining({
      healthy: true,
      source: 'traffic',
      startupVerifiedAt,
    }));
  });

  it('records unhealthy evidence when embedBatch fails', async () => {
    const service = buildService(stubProvider({
      embedBatch: jest.fn().mockRejectedValue(new Error('upstream 503')),
    }));

    await expect(service.embedBatch(['one', 'two'])).rejects.toThrow('upstream 503');
    expect(service.getCachedConnectionStatus().healthy).toBe(false);
  });
});

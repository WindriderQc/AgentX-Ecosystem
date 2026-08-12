const { EmbeddingCache, resetEmbeddingCache } = require('../../src/services/embeddingCache');

describe('EmbeddingCache', () => {
  let cache;

  beforeEach(() => {
    resetEmbeddingCache();
    cache = new EmbeddingCache({ maxSize: 3, ttlMs: 5000 });
  });

  test('get returns null for uncached text (miss)', () => {
    const result = cache.get('hello', 'model-a');
    expect(result).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });

  test('set + get returns cached embedding (hit)', () => {
    const embedding = [0.1, 0.2, 0.3];
    cache.set('hello', 'model-a', embedding);
    const result = cache.get('hello', 'model-a');
    expect(result).toEqual(embedding);
    expect(cache.getStats().hits).toBe(1);
  });

  test('different models produce different cache keys', () => {
    cache.set('hello', 'model-a', [1, 2, 3]);
    cache.set('hello', 'model-b', [4, 5, 6]);
    expect(cache.get('hello', 'model-a')).toEqual([1, 2, 3]);
    expect(cache.get('hello', 'model-b')).toEqual([4, 5, 6]);
  });

  test('eviction fires when max size exceeded (oldest entry removed)', () => {
    cache.set('a', 'model', [1]);
    cache.set('b', 'model', [2]);
    cache.set('c', 'model', [3]);
    // Cache is full at 3. Adding a fourth should evict the oldest ('a').
    cache.set('d', 'model', [4]);

    expect(cache.get('a', 'model')).toBeNull(); // evicted
    expect(cache.get('d', 'model')).toEqual([4]);
    expect(cache.getStats().evictions).toBe(1);
    expect(cache.getStats().size).toBe(3);
  });

  test('TTL-expired entries are not returned (treated as misses)', () => {
    const shortTtlCache = new EmbeddingCache({ maxSize: 10, ttlMs: 1 });
    shortTtlCache.set('text', 'model', [1, 2]);

    // Wait just enough for the 1ms TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }

    const result = shortTtlCache.get('text', 'model');
    expect(result).toBeNull();
    expect(shortTtlCache.getStats().misses).toBe(1);
    expect(shortTtlCache.getStats().evictions).toBe(1);
  });

  test('clear() resets cache and all counters', () => {
    cache.set('a', 'model', [1]);
    cache.get('a', 'model'); // hit
    cache.get('b', 'model'); // miss

    cache.clear();

    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.evictions).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  test('getStats() returns accurate hit/miss/eviction counts and hit rate', () => {
    cache.set('x', 'model', [10]);
    cache.get('x', 'model'); // hit
    cache.get('x', 'model'); // hit
    cache.get('y', 'model'); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 4);
    expect(stats.size).toBe(1);
    expect(stats.maxSize).toBe(3);
  });

  test('LRU: recently accessed entries survive eviction', () => {
    cache.set('a', 'model', [1]);
    cache.set('b', 'model', [2]);
    cache.set('c', 'model', [3]);

    // Access 'a' to make it most-recently-used
    cache.get('a', 'model');

    // Add 'd' — should evict 'b' (the oldest non-accessed entry)
    cache.set('d', 'model', [4]);

    expect(cache.get('a', 'model')).toEqual([1]); // survived because of recent access
    expect(cache.get('b', 'model')).toBeNull();    // evicted
    expect(cache.get('d', 'model')).toEqual([4]);
  });
});

describe('EmbeddingsService caching integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'test', OLLAMA_HOSTS: 'test:11434' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('embed() cache hit returns stored embedding without calling provider', async () => {
    const { resetEmbeddingCache } = require('../../src/services/embeddingCache');
    resetEmbeddingCache();

    const { EmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    resetEmbeddingsService();

    const svc = new EmbeddingsService();
    const mockEmbed = jest.fn().mockResolvedValue([0.5, 0.6]);
    svc.provider.embed = mockEmbed;

    // First call — miss, calls provider
    const result1 = await svc.embed('cached text');
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(result1).toEqual([0.5, 0.6]);

    // Second call — hit, does NOT call provider
    const result2 = await svc.embed('cached text');
    expect(mockEmbed).toHaveBeenCalledTimes(1); // still 1
    expect(result2).toEqual([0.5, 0.6]);

    resetEmbeddingsService();
    resetEmbeddingCache();
  });

  test('embedBatch() with mixed hits/misses only calls provider for misses', async () => {
    const { resetEmbeddingCache } = require('../../src/services/embeddingCache');
    resetEmbeddingCache();

    const { EmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    resetEmbeddingsService();

    const svc = new EmbeddingsService();

    // Pre-populate cache via embed()
    const mockEmbed = jest.fn().mockResolvedValue([1, 1]);
    svc.provider.embed = mockEmbed;
    await svc.embed('text-a'); // cache 'text-a'

    // Now set up embedBatch mock on the provider
    const mockBatchEmbed = jest.fn().mockResolvedValue([[2, 2], [3, 3]]);
    svc.provider.embedBatch = mockBatchEmbed;

    // Call embedBatch with a mix: 'text-a' (cached) + 'text-b' + 'text-c' (uncached)
    const results = await svc.embedBatch(['text-a', 'text-b', 'text-c']);

    // Only 'text-b' and 'text-c' should have been sent to the provider
    expect(mockBatchEmbed).toHaveBeenCalledTimes(1);
    expect(mockBatchEmbed).toHaveBeenCalledWith(['text-b', 'text-c'], null);

    // Results should be in correct order
    expect(results).toEqual([[1, 1], [2, 2], [3, 3]]);

    resetEmbeddingsService();
    resetEmbeddingCache();
  });

  test('embedBatch() with all cached texts does not call provider at all', async () => {
    const { resetEmbeddingCache } = require('../../src/services/embeddingCache');
    resetEmbeddingCache();

    const { EmbeddingsService, resetEmbeddingsService } = require('../../src/services/embeddings');
    resetEmbeddingsService();

    const svc = new EmbeddingsService();

    // Pre-populate cache
    const mockEmbed = jest.fn()
      .mockResolvedValueOnce([1, 1])
      .mockResolvedValueOnce([2, 2]);
    svc.provider.embed = mockEmbed;
    await svc.embed('alpha');
    await svc.embed('beta');

    const mockBatchEmbed = jest.fn();
    svc.provider.embedBatch = mockBatchEmbed;

    const results = await svc.embedBatch(['alpha', 'beta']);
    expect(mockBatchEmbed).not.toHaveBeenCalled();
    expect(results).toEqual([[1, 1], [2, 2]]);

    resetEmbeddingsService();
    resetEmbeddingCache();
  });
});

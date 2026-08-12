const { RAGCompressionService, getCompressionService, resetCompressionService } = require('../../src/services/ragCompression');

jest.mock('../../src/utils/fetchWithTimeout');
const fetchWithTimeout = require('../../src/utils/fetchWithTimeout');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));
const logger = require('../../config/logger');

describe('ragCompression', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCompressionService();
    delete process.env.OLLAMA_HOSTS;
    delete process.env.OLLAMA_HOST;
    delete process.env.COMPRESSION_CACHE_TTL;
    service = getCompressionService();
  });

  describe('singleton', () => {
    it('returns same instance across calls', () => {
      const a = getCompressionService();
      const b = getCompressionService();
      expect(a).toBe(b);
    });

    it('returns new instance after reset', () => {
      const a = getCompressionService();
      resetCompressionService();
      const b = getCompressionService();
      expect(a).not.toBe(b);
    });
  });

  describe('compressChunks', () => {
    it('should return empty array for empty input', async () => {
      expect(await service.compressChunks('query', [])).toEqual([]);
      expect(await service.compressChunks('query', null)).toEqual([]);
    });

    it('should compress chunks successfully', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'This is a relevant sentence.' })
      });

      const chunks = [{ _id: '1', text: 'This is a relevant sentence. This is noise.' }];
      const result = await service.compressChunks('test query', chunks);

      expect(result).toHaveLength(1);
      expect(result[0].compressedText).toBe('This is a relevant sentence.');
      expect(result[0].wasCompressed).toBe(true);
      expect(result[0].originalText).toBe('This is a relevant sentence. This is noise.');
      expect(result[0].compressionRatio).toBeGreaterThan(0);

      // Verify Ollama API call
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/api/inference/generate'),
        expect.objectContaining({ method: 'POST' }),
        expect.any(Number)
      );

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody).toHaveProperty('taskType', 'rag_compression');
      expect(callBody).toHaveProperty('prompt');
      expect(callBody).toHaveProperty('system');
      expect(callBody.options.temperature).toBe(0.1);
    });

    it('should filter out chunks with no relevant content', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'NO_RELEVANT_CONTENT' })
      });

      const chunks = [{ _id: '1', text: 'Just noise.' }];
      const result = await service.compressChunks('test query', chunks);

      expect(result).toHaveLength(0);
    });

    it('should use cache for repeated queries', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed result text.' })
      });

      const chunks = [{ _id: '1', text: 'Original text content.' }];

      // First call
      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

      // Second call — should hit cache
      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('should not collide cache entries for different chunks', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed output' })
      });

      const chunks = [
        { text: 'Chunk A text', metadata: { documentId: 'doc-1', chunkIndex: 0 } },
        { text: 'Chunk B text', metadata: { documentId: 'doc-1', chunkIndex: 1 } }
      ];

      await service.compressChunks('same-query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('should use sha1 hash for cache key when no identifiers present', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed output' })
      });

      const chunks = [
        { text: 'Chunk A text without ID' },
        { text: 'Chunk B text without ID' }
      ];

      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

      // Same query+text should cache
      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('should handle API errors gracefully (fallback to original text)', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const chunks = [{ _id: '1', text: 'Original text.' }];
      const result = await service.compressChunks('query', chunks);

      expect(result).toHaveLength(1);
      expect(result[0].compressedText).toBe('Original text.');
      expect(result[0].wasCompressed).toBe(false);
      expect(result[0].compressionError).toBeDefined();
    });

    it('should handle fetch timeout gracefully', async () => {
      fetchWithTimeout.mockRejectedValue(new Error('Request timed out after 15000ms'));

      const chunks = [{ _id: '1', text: 'Original text.' }];
      const result = await service.compressChunks('query', chunks);

      expect(result).toHaveLength(1);
      expect(result[0].compressedText).toBe('Original text.');
      expect(result[0].wasCompressed).toBe(false);
    });

    it('should bypass cache when useCache is false', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed output here.' })
      });

      const chunks = [{ _id: '1', text: 'Original text here.' }];

      await service.compressChunks('query', chunks, { useCache: false });
      await service.compressChunks('query', chunks, { useCache: false });

      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('should route compression through the core task router', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed.' })
      });

      await service.compressChunks('test', [{ _id: '1', text: 'hello world test.' }]);

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.taskType).toBe('rag_compression');
      expect(callBody.model).toBeUndefined();
    });

    it('should compress all chunks in parallel', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed text.' })
      });

      const chunks = [
        { _id: '1', text: 'Chunk 1 text content.' },
        { _id: '2', text: 'Chunk 2 text content.' },
        { _id: '3', text: 'Chunk 3 text content.' }
      ];

      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    });

    it('should clean up LLM response artifacts', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: 'Here are the relevant sentences:\n[Sentence 1]: First sentence.\n- Second sentence.'
        })
      });

      const chunks = [{ _id: '1', text: 'First sentence. Second sentence. Third noise.' }];
      const result = await service.compressChunks('query', chunks);

      expect(result[0].compressedText).not.toContain('[Sentence 1]');
      expect(result[0].compressedText).not.toContain('Here are');
      expect(result[0].compressedText).toContain('First sentence.');
    });

    it('should log compression summary at debug level', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed.' })
      });

      await service.compressChunks('test query', [{ _id: '1', text: 'hello world original.' }]);

      expect(logger.debug).toHaveBeenCalledWith('Compression complete', expect.objectContaining({
        originalChunks: 1,
        compressedChunks: 1,
        reductionPercent: expect.any(Number)
      }));
    });
  });

  describe('cache management', () => {
    it('clearCache should empty the cache', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed.' })
      });

      await service.compressChunks('q', [{ _id: '1', text: 'Text.' }]);
      expect(service.getCacheStats().size).toBe(1);

      service.clearCache();
      expect(service.getCacheStats().size).toBe(0);
    });

    it('getCacheStats should return size and ttl', () => {
      const stats = service.getCacheStats();
      expect(stats).toHaveProperty('size', 0);
      expect(stats).toHaveProperty('ttl', 3600000);
    });

    it('should respect COMPRESSION_CACHE_TTL env var', () => {
      resetCompressionService();
      process.env.COMPRESSION_CACHE_TTL = '60000';
      service = getCompressionService();
      expect(service.getCacheStats().ttl).toBe(60000);
    });

    it('should evict expired cache entries on next access', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Compressed text.' })
      });

      const chunks = [{ _id: '1', text: 'Original text content.' }];

      // First call — populates cache
      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

      // Force cache entry expiry by manipulating timestamp
      const cacheKey = service._buildCacheKey('query', chunks[0]);
      const entry = service.compressionCache.get(cacheKey);
      entry.timestamp = Date.now() - service.cacheTTL - 1;

      // Second call — cache expired, should re-fetch
      await service.compressChunks('query', chunks);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    });
  });
});

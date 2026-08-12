'use strict';

const { buildRagContext } = require('../../src/services/chat/ragContextBuilder');

describe('ragContextBuilder', () => {
  const mockResults = [
    {
      text: 'The alert system monitors host health and triggers notifications.',
      score: 0.85,
      metadata: { source: 'docs/alerts.md', documentId: 'doc-1', filename: 'alerts.md' }
    },
    {
      text: 'Alerts can be configured per-model or per-host with custom thresholds.',
      score: 0.72,
      metadata: { source: 'docs/config.md', documentId: 'doc-2', filename: 'config.md' }
    }
  ];

  function makeMockStore(results) {
    return { searchSimilarChunks: jest.fn().mockResolvedValue(results) };
  }

  describe('successful RAG search', () => {
    it('should call searchSimilarChunks with correct defaults', async () => {
      const store = makeMockStore(mockResults);
      const result = await buildRagContext('How do alerts work?', store, {});

      expect(store.searchSimilarChunks).toHaveBeenCalledWith('How do alerts work?', {
        topK: 5,
        filters: undefined,
        minScore: 0.3,
        expand: false,
        hybrid: false,
        rerank: false,
        compress: false
      });
      expect(result.ragUsed).toBe(true);
      expect(result.ragSources).toHaveLength(2);
      expect(result.ragContext).toContain('[1] alerts.md');
      expect(result.ragContext).toContain('[2] config.md');
      expect(result.ragContext).toContain('85% match');
    });

    it('should inject context in the correct envelope format', async () => {
      const store = makeMockStore(mockResults);
      const result = await buildRagContext('test query', store, {});

      expect(result.ragContext).toMatch(/\[1\].*alerts\.md/);
      expect(result.ragContext).toContain('The alert system monitors');
      expect(result.ragSources[0]).toMatchObject({
        documentId: 'doc-1',
        score: 0.85,
        title: 'alerts.md',
        source: 'docs/alerts.md'
      });
    });

    it('should respect custom topK', async () => {
      const store = makeMockStore(mockResults);
      await buildRagContext('query', store, { ragTopK: 10 });

      expect(store.searchSimilarChunks).toHaveBeenCalledWith('query', expect.objectContaining({ topK: 10 }));
    });

    it('should use minScore 0.15 for hybrid search', async () => {
      const store = makeMockStore(mockResults);
      await buildRagContext('query', store, { ragOptions: { ragHybrid: true } });

      expect(store.searchSimilarChunks).toHaveBeenCalledWith('query', expect.objectContaining({ minScore: 0.15 }));
    });
  });

  describe('graceful degradation', () => {
    it('should return ragUsed=false when store throws', async () => {
      const store = { searchSimilarChunks: jest.fn().mockRejectedValue(new Error('Connection refused')) };
      const result = await buildRagContext('test query', store, {});

      expect(result.ragUsed).toBe(false);
      expect(result.ragSources).toEqual([]);
      expect(result.ragContext).toBeNull();
    });

    it('should return ragUsed=false when store returns empty results', async () => {
      const store = makeMockStore([]);
      const result = await buildRagContext('test query', store, {});

      expect(result.ragUsed).toBe(false);
      expect(result.ragSources).toEqual([]);
      expect(result.ragContext).toBeNull();
    });

    it('should return ragUsed=false when no store provided', async () => {
      const result = await buildRagContext('test query', null, {});

      expect(result.ragUsed).toBe(false);
    });

    it('should return ragUsed=false when query is empty', async () => {
      const store = makeMockStore(mockResults);
      const result = await buildRagContext('', store, {});

      expect(result.ragUsed).toBe(false);
    });

    it('should return ragUsed=false when query is not a string', async () => {
      const store = makeMockStore(mockResults);
      const result = await buildRagContext(123, store, {});

      expect(result.ragUsed).toBe(false);
    });
  });
});

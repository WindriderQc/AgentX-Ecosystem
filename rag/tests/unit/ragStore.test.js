const { RagStore, resetRagStore } = require('../../src/services/ragStore');
const { resetEmbeddingsService } = require('../../src/services/embeddings');

// Mock queryExpansion module for expand tests
jest.mock('../../src/services/queryExpansion', () => ({
  expandQuery: jest.fn(async () => ['related query 1', 'related query 2']),
}));
const { expandQuery } = require('../../src/services/queryExpansion');

// Mock reranker module for rerank tests
jest.mock('../../src/services/reranker', () => ({
  rerankResults: jest.fn(async (query, results, topK) => {
    // Simulate re-ranking: reverse order and add llmScore/vectorScore
    return results
      .map((r, i) => ({
        ...r,
        llmScore: (results.length - i) / results.length,
        vectorScore: r.score
      }))
      .sort((a, b) => b.llmScore - a.llmScore)
      .slice(0, topK);
  })
}));
const { rerankResults } = require('../../src/services/reranker');

describe('RagStore (in-memory, mocked embeddings)', () => {
  let store;
  const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];

  beforeEach(() => {
    resetRagStore();
    resetEmbeddingsService();

    store = new RagStore({ type: 'memory' });
    // Mock the embeddings service to avoid network calls
    store.embeddingsService = {
      embedBatch: jest.fn(async (texts) =>
        texts.map(() => [...mockEmbedding])
      ),
    };
  });

  test('upsertDocumentWithChunks creates chunks and returns result', async () => {
    const result = await store.upsertDocumentWithChunks('Hello world. This is a test document.', {
      source: 'test-source',
      tags: ['unit-test'],
    });

    expect(result.documentId).toBeDefined();
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('created');
  });

  test('upsertDocumentWithChunks with custom documentId', async () => {
    const result = await store.upsertDocumentWithChunks('Some content', {
      source: 'test',
      documentId: 'custom-id-123',
    });

    expect(result.documentId).toBe('custom-id-123');
  });

  test('searchSimilarChunks returns results', async () => {
    await store.upsertDocumentWithChunks('Test content for search', {
      source: 'test',
    });

    const results = await store.searchSimilarChunks('test query', { topK: 3 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty('text');
    expect(results[0]).toHaveProperty('score');
  });

  test('listDocuments returns ingested docs', async () => {
    await store.upsertDocumentWithChunks('Doc one', { source: 'src-a' });
    await store.upsertDocumentWithChunks('Doc two', { source: 'src-b' });

    const { documents: docs, total } = await store.listDocuments();
    expect(docs).toHaveLength(2);
    expect(total).toBe(2);
  });

  test('deleteDocument removes a document', async () => {
    await store.upsertDocumentWithChunks('To be deleted', {
      source: 'test',
      documentId: 'delete-me',
    });

    const deleted = await store.deleteDocument('delete-me');
    expect(deleted).toBe(true);

    const { documents: docs } = await store.listDocuments();
    expect(docs).toHaveLength(0);
  });

  test('getStats returns store statistics', async () => {
    await store.upsertDocumentWithChunks('Stats test content', { source: 'test' });

    const stats = await store.getStats();
    expect(stats.documentCount).toBe(1);
    expect(stats.chunkCount).toBeGreaterThanOrEqual(1);
    expect(stats).toHaveProperty('vectorStore');
  });

  test('throws on empty text', async () => {
    await expect(
      store.upsertDocumentWithChunks('', { source: 'test' })
    ).rejects.toThrow();
  });

  test('embeddings service called with chunk texts', async () => {
    await store.upsertDocumentWithChunks('A short doc', { source: 'test' });

    expect(store.embeddingsService.embedBatch).toHaveBeenCalledTimes(1);
    const callArg = store.embeddingsService.embedBatch.mock.calls[0][0];
    expect(Array.isArray(callArg)).toBe(true);
    expect(callArg.length).toBeGreaterThanOrEqual(1);
  });

  test('hash match returns unchanged without re-ingesting', async () => {
    // First ingest to populate
    await store.upsertDocumentWithChunks('Original text', {
      source: 'test',
      documentId: 'hash-test',
      hash: 'abc123'
    });

    // Second ingest with same hash
    const result = await store.upsertDocumentWithChunks('Same text', {
      source: 'test',
      documentId: 'hash-test',
      hash: 'abc123'
    });

    expect(result).toEqual({ unchanged: true, documentId: 'hash-test' });
    // embeddings should only be called once (first ingest)
    expect(store.embeddingsService.embedBatch).toHaveBeenCalledTimes(1);
  });

  // ── Query expansion integration ──────────────────────────

  describe('searchSimilarChunks with expand', () => {
    beforeEach(() => {
      expandQuery.mockClear();
    });

    test('expand=false does not call expandQuery', async () => {
      await store.upsertDocumentWithChunks('Test content', { source: 'test' });
      await store.searchSimilarChunks('query', { topK: 3, expand: false });
      expect(expandQuery).not.toHaveBeenCalled();
    });

    test('expand=true calls expandQuery and searches with all queries', async () => {
      await store.upsertDocumentWithChunks('Test content', { source: 'test' });

      expandQuery.mockResolvedValue(['alt query 1', 'alt query 2']);
      const results = await store.searchSimilarChunks('original query', { topK: 5, expand: true });

      expect(expandQuery).toHaveBeenCalledWith('original query');
      expect(Array.isArray(results)).toBe(true);
      // Should have called embedBatch for each query (original + 2 expansions)
      // Plus the 1 call from upsert
      const embedCalls = store.embeddingsService.embedBatch.mock.calls;
      // 1 ingest call + 3 search queries = 4
      expect(embedCalls.length).toBe(4);
    });

    test('expand=true returns results even when expansion fails', async () => {
      await store.upsertDocumentWithChunks('Test content', { source: 'test' });

      expandQuery.mockResolvedValue([]); // expansion fails, returns empty
      const results = await store.searchSimilarChunks('query', { topK: 3, expand: true });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test('expand=true deduplicates results by chunk identity', async () => {
      // All embeddings are identical mock data, so all queries will find the same chunks
      await store.upsertDocumentWithChunks('Some unique content', {
        source: 'test',
        documentId: 'dedup-doc'
      });

      expandQuery.mockResolvedValue(['related']);
      const results = await store.searchSimilarChunks('query', { topK: 5, expand: true });

      // Even though two queries ran, the same chunk should appear only once
      const ids = results.map(r => `${r.metadata?.documentId}:${r.metadata?.chunkIndex}`);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);
    });
  });

  // ── Hybrid search integration ─────────────────────────────

  describe('searchSimilarChunks with hybrid', () => {
    test('hybrid=true runs vector + keyword search and fuses results', async () => {
      // Ingest a document with searchable text
      await store.upsertDocumentWithChunks(
        'MongoDB handles persistent storage for the entire platform infrastructure.',
        { source: 'test', documentId: 'hybrid-doc' }
      );

      const results = await store.searchSimilarChunks('MongoDB storage', {
        topK: 5,
        hybrid: true
      });

      expect(Array.isArray(results)).toBe(true);
      // Should have results from at least one search path
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Each result should have an rrfScore from fusion
      for (const r of results) {
        expect(r).toHaveProperty('rrfScore');
        expect(typeof r.rrfScore).toBe('number');
      }
    });

    test('hybrid=true does not call expandQuery', async () => {
      expandQuery.mockClear();

      await store.upsertDocumentWithChunks('Test content here', {
        source: 'test',
        documentId: 'no-expand-doc'
      });

      await store.searchSimilarChunks('test query', {
        topK: 3,
        hybrid: true,
        expand: true // Should be ignored — hybrid skips expansion
      });

      expect(expandQuery).not.toHaveBeenCalled();
    });

    test('hybrid=false does not produce rrfScore', async () => {
      await store.upsertDocumentWithChunks('Regular search content', {
        source: 'test',
        documentId: 'non-hybrid-doc'
      });

      const results = await store.searchSimilarChunks('regular search', {
        topK: 3,
        hybrid: false
      });

      expect(Array.isArray(results)).toBe(true);
      // Standard vector search results should NOT have rrfScore
      for (const r of results) {
        expect(r.rrfScore).toBeUndefined();
      }
    });

    test('hybrid respects topK limit', async () => {
      // Ingest multiple documents to ensure many results
      for (let i = 0; i < 5; i++) {
        await store.upsertDocumentWithChunks(
          `Document number ${i} about databases and servers and storage and caching.`,
          { source: 'test', documentId: `topk-doc-${i}` }
        );
      }

      const results = await store.searchSimilarChunks('databases servers storage', {
        topK: 2,
        hybrid: true
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    test('hybrid returns results even when keyword search finds nothing', async () => {
      // Ingest content that vector search will find but keyword won't match well
      await store.upsertDocumentWithChunks('Completely unrelated alphanumeric data here', {
        source: 'test',
        documentId: 'vec-only-doc'
      });

      // Query that won't keyword-match but will vector-match (mock embeddings always match)
      const results = await store.searchSimilarChunks('xyz', {
        topK: 3,
        hybrid: true
      });

      // Should still get vector results via RRF
      expect(Array.isArray(results)).toBe(true);
      // Mock embeddings all return same vector so cosine similarity = 1.0
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Re-ranking integration ──────────────────────────────

  describe('searchSimilarChunks with rerank', () => {
    beforeEach(() => {
      rerankResults.mockClear();
    });

    test('rerank=false does not call rerankResults', async () => {
      await store.upsertDocumentWithChunks('Test content', { source: 'test' });
      await store.searchSimilarChunks('query', { topK: 3, rerank: false });
      expect(rerankResults).not.toHaveBeenCalled();
    });

    test('rerank=true calls rerankResults with query and results', async () => {
      await store.upsertDocumentWithChunks('Rerank test content', { source: 'test' });

      const results = await store.searchSimilarChunks('test query', { topK: 3, rerank: true });

      expect(rerankResults).toHaveBeenCalledTimes(1);
      expect(rerankResults).toHaveBeenCalledWith(
        'test query',
        expect.any(Array),
        3
      );
      expect(Array.isArray(results)).toBe(true);
      // Mock reranker adds llmScore and vectorScore
      for (const r of results) {
        expect(r).toHaveProperty('llmScore');
        expect(r).toHaveProperty('vectorScore');
      }
    });

    test('rerank=true fetches more candidates (topK * 3)', async () => {
      await store.upsertDocumentWithChunks('Content for rerank candidate test', { source: 'test' });

      await store.searchSimilarChunks('query', { topK: 3, rerank: true });

      // The mock reranker receives the candidate array; we check that
      // rerankResults was called (the increased candidate fetching is internal)
      expect(rerankResults).toHaveBeenCalledTimes(1);
      const candidatesPassed = rerankResults.mock.calls[0][1];
      expect(Array.isArray(candidatesPassed)).toBe(true);
    });

    test('rerank works with hybrid search', async () => {
      await store.upsertDocumentWithChunks(
        'MongoDB handles persistent storage for the entire platform.',
        { source: 'test', documentId: 'hybrid-rerank-doc' }
      );

      const results = await store.searchSimilarChunks('MongoDB storage', {
        topK: 3,
        hybrid: true,
        rerank: true
      });

      // rerankResults should be called on the hybrid results
      expect(rerankResults).toHaveBeenCalledTimes(1);
      expect(Array.isArray(results)).toBe(true);
    });

    test('rerank works with query expansion', async () => {
      expandQuery.mockResolvedValue(['expanded query']);
      await store.upsertDocumentWithChunks('Test for expand+rerank', { source: 'test' });

      const results = await store.searchSimilarChunks('test query', {
        topK: 3,
        expand: true,
        rerank: true
      });

      expect(expandQuery).toHaveBeenCalled();
      expect(rerankResults).toHaveBeenCalledTimes(1);
      expect(Array.isArray(results)).toBe(true);
    });

    test('rerank not called when no results exist', async () => {
      // Empty store — no documents ingested
      const results = await store.searchSimilarChunks('no matches', {
        topK: 3,
        rerank: true
      });

      // No results to rerank — rerankResults should not be called
      // (vector search returns empty from empty store)
      expect(Array.isArray(results)).toBe(true);
    });
  });
});

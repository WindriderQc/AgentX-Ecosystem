jest.mock('node-fetch', () => jest.fn());

const fetch = require('node-fetch');
const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');

// ─── Helper ─────────────────────────────────────────────────
function mockOk(jsonBody = {}) {
  return { ok: true, json: async () => jsonBody, text: async () => '' };
}
function mockFail(status = 500, body = 'error') {
  return { ok: false, status, text: async () => body };
}

describe('QdrantVectorStore.getStats', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  it('includes a deduplicated document count for status consumers', async () => {
    fetch
      // collection info
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            points_count: 4,
            status: 'green',
            config: { params: { vectors: { size: 768 } } }
          }
        })
      })
      // lightweight scroll (_scrollByFilterLite)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            points: [
              { payload: { documentId: 'doc-a' } },
              { payload: { documentId: 'doc-a' } },
              { payload: { documentId: 'doc-b' } },
              { payload: { documentId: 'doc-c' } }
            ]
          }
        })
      });

    const store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'agentx_embeddings'
    });

    await expect(store.getStats()).resolves.toEqual({
      documentCount: 3,
      chunkCount: 4,
      vectorDimension: 768,
      status: 'green'
    });

    // Verify the lite scroll sends with_vector: false and minimal payload
    const scrollCall = fetch.mock.calls[1];
    const scrollBody = JSON.parse(scrollCall[0].endsWith('/scroll') ? scrollCall[1]?.body : '{}');
    // The second call should be to the scroll endpoint
    expect(scrollCall[0]).toContain('/points/scroll');
    expect(scrollBody.with_vector).toBe(false);
    expect(scrollBody.with_payload).toEqual({ include: ['documentId'] });
  });

  it('reports an empty corpus when the configured collection does not exist yet', async () => {
    fetch.mockResolvedValueOnce(mockFail(
      404,
      '{"status":{"error":"Not found: Collection `test` doesn\'t exist!"}}'
    ));

    const store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test',
      vectorDimension: 768
    });

    await expect(store.getStats()).resolves.toEqual({
      documentCount: 0,
      chunkCount: 0,
      vectorDimension: 768,
      status: 'empty'
    });
  });

  it('throws on collection info failure instead of returning error shape', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    const store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'agentx_embeddings'
    });

    await expect(store.getStats()).rejects.toThrow('Qdrant getStats failed: 500');
  });
});

describe('QdrantVectorStore._ensureCollection caching', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  it('only calls Qdrant once across multiple upserts', async () => {
    // _ensureCollection check — collection exists
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { points: [] } }),
      text: async () => ''
    });

    const store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test_collection'
    });

    await store._ensureCollection(768);
    await store._ensureCollection(768);
    await store._ensureCollection(768);

    // Only the first call should hit the network
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store._collectionVerified).toBe(true);
  });
});

describe('QdrantVectorStore._deleteByDocumentId', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  it('throws on Qdrant error instead of returning false', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'server error'
    });

    const store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'agentx_embeddings'
    });

    await expect(store._deleteByDocumentId('doc-1')).rejects.toThrow('Qdrant delete by documentId failed: 500');
  });
});

describe('QdrantVectorStore._scrollByFilter', () => {
  beforeEach(() => {
    fetch.mockReset();
  });

  it('logs warning and throws on page-fetch failure', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable'
    });

    const store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'agentx_embeddings'
    });

    await expect(store._scrollByFilter(null, 100)).rejects.toThrow('Qdrant scroll failed: 503');
  });
});

// ═════════════════════════════════════════════════════════════
// NEW TESTS — covers the remaining untested methods
// ═════════════════════════════════════════════════════════════

describe('QdrantVectorStore._generatePointId', () => {
  let store;

  beforeEach(() => {
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('returns a deterministic UUID for the same inputs', () => {
    const id1 = store._generatePointId('doc-a', 0);
    const id2 = store._generatePointId('doc-a', 0);
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different documentId values', () => {
    const id1 = store._generatePointId('doc-a', 0);
    const id2 = store._generatePointId('doc-b', 0);
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different chunkIndex values', () => {
    const id1 = store._generatePointId('doc-a', 0);
    const id2 = store._generatePointId('doc-a', 1);
    expect(id1).not.toBe(id2);
  });

  it('returns a valid UUID v4 format', () => {
    const id = store._generatePointId('test-doc', 42);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(id).toMatch(uuidRegex);
  });

  it('has no collisions across 1000 distinct inputs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(store._generatePointId(`doc-${i}`, i));
    }
    expect(ids.size).toBe(1000);
  });
});

describe('QdrantVectorStore.upsertDocument', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
    // Pre-mark collection as verified to simplify mocking
    store._collectionVerified = true;
  });

  it('returns early for empty chunks', async () => {
    const result = await store.upsertDocument('doc-1', {}, []);
    expect(result).toEqual({ documentId: 'doc-1', chunkCount: 0, status: 'empty' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('calls _ensureCollection, scrolls for old points, upserts, and returns result', async () => {
    store._collectionVerified = false;

    // _ensureCollection — collection exists
    fetch.mockResolvedValueOnce(mockOk());
    // _scrollByFilter — no old points
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));
    // upsert batch
    fetch.mockResolvedValueOnce(mockOk());

    const chunks = [
      { text: 'hello', embedding: [0.1, 0.2], chunkIndex: 0 },
      { text: 'world', embedding: [0.3, 0.4], chunkIndex: 1 }
    ];

    const result = await store.upsertDocument('doc-1', { source: 'test' }, chunks);

    expect(result).toEqual({ documentId: 'doc-1', chunkCount: 2, status: 'created' });
    expect(store._collectionVerified).toBe(true);
    // _ensureCollection (1) + scroll (1) + upsert batch (1) = 3
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('deletes old points when re-upserting a document', async () => {
    // scroll — returns old points
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { id: 'old-uuid-1', payload: { documentId: 'doc-1' } },
          { id: 'old-uuid-2', payload: { documentId: 'doc-1' } }
        ]
      }
    }));
    // upsert batch
    fetch.mockResolvedValueOnce(mockOk());
    // _deleteByPointIds
    fetch.mockResolvedValueOnce(mockOk());

    const chunks = [
      { text: 'new content', embedding: [0.5, 0.6], chunkIndex: 0 }
    ];

    await store.upsertDocument('doc-1', { source: 'test' }, chunks);

    // scroll (1) + upsert (1) + deleteByPointIds (1) = 3
    expect(fetch).toHaveBeenCalledTimes(3);
    // Verify the delete call passes the old point IDs
    const deleteCall = fetch.mock.calls[2];
    expect(deleteCall[0]).toContain('/points/delete');
    const deleteBody = JSON.parse(deleteCall[1].body);
    expect(deleteBody.points).toEqual(['old-uuid-1', 'old-uuid-2']);
  });

  it('batches upserts in groups of 100', async () => {
    // scroll — no old points
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));
    // Will need 3 batch calls (250 chunks / 100 = 3 batches)
    fetch.mockResolvedValueOnce(mockOk());
    fetch.mockResolvedValueOnce(mockOk());
    fetch.mockResolvedValueOnce(mockOk());

    const chunks = [];
    for (let i = 0; i < 250; i++) {
      chunks.push({ text: `chunk-${i}`, embedding: [0.1], chunkIndex: i });
    }

    const result = await store.upsertDocument('big-doc', {}, chunks);
    expect(result.chunkCount).toBe(250);

    // scroll (1) + 3 upsert batches = 4
    expect(fetch).toHaveBeenCalledTimes(4);

    // Verify batch sizes: 100, 100, 50
    const upsertCalls = fetch.mock.calls.slice(1);
    const batchSizes = upsertCalls.map(call => JSON.parse(call[1].body).points.length);
    expect(batchSizes).toEqual([100, 100, 50]);
  });

  it('throws on upsert failure', async () => {
    // scroll — no old points
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));
    // upsert — fail
    fetch.mockResolvedValueOnce(mockFail(500, 'disk full'));

    const chunks = [{ text: 'a', embedding: [0.1], chunkIndex: 0 }];
    await expect(store.upsertDocument('doc-1', {}, chunks)).rejects.toThrow('Qdrant upsert failed: 500');
  });
});

describe('QdrantVectorStore.searchSimilar', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('passes query vector and returns mapped results', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: [
        { score: 0.95, payload: { text: 'hello world', documentId: 'doc-1', source: 'test' } },
        { score: 0.80, payload: { text: 'goodbye', documentId: 'doc-2', source: 'test' } }
      ]
    }));

    const results = await store.searchSimilar([0.1, 0.2, 0.3], { topK: 5 });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      text: 'hello world',
      score: 0.95,
      metadata: { text: 'hello world', documentId: 'doc-1', source: 'test' }
    });

    // Verify request body
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.vector).toEqual([0.1, 0.2, 0.3]);
    expect(body.limit).toBe(5);
    expect(body.with_payload).toBe(true);
  });

  it('caps topK at 20', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: [] }));

    await store.searchSimilar([0.1], { topK: 100 });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.limit).toBe(20);
  });

  it('defaults topK to 5', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: [] }));

    await store.searchSimilar([0.1]);

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.limit).toBe(5);
  });

  it('includes filters in the request', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: [] }));

    await store.searchSimilar([0.1], { filters: { source: 'docs', tags: ['api', 'v2'] } });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.filter.must).toEqual([
      { key: 'source', match: { value: 'docs' } },
      { key: 'tags', match: { value: 'api' } },
      { key: 'tags', match: { value: 'v2' } }
    ]);
  });

  it('omits filter when no filters provided', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: [] }));

    await store.searchSimilar([0.1]);

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.filter).toBeUndefined();
  });

  it('throws on search failure', async () => {
    fetch.mockResolvedValueOnce(mockFail(500, 'timeout'));

    await expect(store.searchSimilar([0.1])).rejects.toThrow('Qdrant search failed: 500');
  });

  it('passes minScore as score_threshold', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: [] }));

    await store.searchSimilar([0.1], { minScore: 0.7 });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.score_threshold).toBe(0.7);
  });
});

describe('QdrantVectorStore.getDocument', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('returns metadata for an existing document', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { payload: { documentId: 'doc-1', source: 'api', tags: ['test'], hash: 'abc123' } }
        ]
      }
    }));

    const doc = await store.getDocument('doc-1');
    expect(doc).toEqual({
      documentId: 'doc-1',
      source: 'api',
      tags: ['test'],
      hash: 'abc123'
    });
  });

  it('returns null for a missing document', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));

    const doc = await store.getDocument('nonexistent');
    expect(doc).toBeNull();
  });
});

describe('QdrantVectorStore.listDocuments', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('groups points by documentId and returns correct shape', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { payload: { documentId: 'doc-a', source: 'api', tags: ['x'] } },
          { payload: { documentId: 'doc-a', source: 'api', tags: ['x'] } },
          { payload: { documentId: 'doc-b', source: 'file', tags: [] } }
        ]
      }
    }));

    const { documents, total } = await store.listDocuments();

    expect(total).toBe(2);
    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual({
      documentId: 'doc-a',
      source: 'api',
      tags: ['x'],
      chunkCount: 2
    });
    expect(documents[1]).toEqual({
      documentId: 'doc-b',
      source: 'file',
      tags: [],
      chunkCount: 1
    });
  });

  it('applies a source filter', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));

    await store.listDocuments({ source: 'api' });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.filter).toEqual({ must: [{ key: 'source', match: { value: 'api' } }] });
  });

  it('supports pagination via offset and limit', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { payload: { documentId: 'doc-a', source: 'a', tags: [] } },
          { payload: { documentId: 'doc-b', source: 'b', tags: [] } },
          { payload: { documentId: 'doc-c', source: 'c', tags: [] } }
        ]
      }
    }));

    const { documents, total } = await store.listDocuments({}, { offset: 1, limit: 1 });

    expect(total).toBe(3);
    expect(documents).toHaveLength(1);
    expect(documents[0].documentId).toBe('doc-b');
  });

  it('returns an empty page when the configured collection does not exist yet', async () => {
    fetch.mockResolvedValueOnce(mockFail(
      404,
      '{"status":{"error":"Not found: Collection `test` doesn\'t exist!"}}'
    ));

    await expect(store.listDocuments()).resolves.toEqual({ documents: [], total: 0 });
  });

  it('does not hide unrelated Qdrant 404 responses', async () => {
    fetch.mockResolvedValueOnce(mockFail(404, 'route not found'));

    await expect(store.listDocuments()).rejects.toThrow('Qdrant scroll failed: 404 route not found');
  });
});

describe('QdrantVectorStore.getDocumentChunks', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('returns chunks sorted by chunkIndex', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { payload: { documentId: 'doc-1', text: 'second', chunkIndex: 1 } },
          { payload: { documentId: 'doc-1', text: 'first', chunkIndex: 0 } }
        ]
      }
    }));

    const chunks = await store.getDocumentChunks('doc-1');
    expect(chunks).toEqual([
      { text: 'first', chunkIndex: 0 },
      { text: 'second', chunkIndex: 1 }
    ]);
  });

  it('returns empty array when document has no chunks', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));

    const chunks = await store.getDocumentChunks('nonexistent');
    expect(chunks).toEqual([]);
  });
});

describe('QdrantVectorStore.deleteDocument', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('calls the delete endpoint with the correct documentId filter', async () => {
    fetch.mockResolvedValueOnce(mockOk());

    const result = await store.deleteDocument('doc-1');
    expect(result).toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain('/points/delete');
    const body = JSON.parse(opts.body);
    expect(body.filter.must).toEqual([
      { key: 'documentId', match: { value: 'doc-1' } }
    ]);
  });

  it('propagates errors from Qdrant', async () => {
    fetch.mockResolvedValueOnce(mockFail(500, 'delete failed'));

    await expect(store.deleteDocument('doc-1')).rejects.toThrow('Qdrant delete by documentId failed: 500');
  });
});

describe('QdrantVectorStore originalText get/set (0163)', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('getDocumentOriginalText scrolls chunk-0 and returns payload.originalText', async () => {
    // _scrollByFilter call: returns 1 point with payload.originalText
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { id: 'uuid-chunk-0', payload: { documentId: 'doc-1', chunkIndex: 0, originalText: 'hello\nworld — é' } }
        ]
      }
    }));

    const text = await store.getDocumentOriginalText('doc-1');
    expect(text).toBe('hello\nworld — é');

    // Verify scroll filter uses documentId + chunkIndex=0
    const scrollCall = fetch.mock.calls[0];
    expect(scrollCall[0]).toContain('/points/scroll');
    const scrollBody = JSON.parse(scrollCall[1].body);
    expect(scrollBody.filter).toEqual({
      must: [
        { key: 'documentId', match: { value: 'doc-1' } },
        { key: 'chunkIndex', match: { value: 0 } }
      ]
    });
  });

  it('getDocumentOriginalText returns null when no chunk-0 exists', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));

    const text = await store.getDocumentOriginalText('doc-missing');
    expect(text).toBeNull();
    expect(text === undefined).toBe(false);
  });

  it('getDocumentOriginalText returns null when chunk-0 exists but payload lacks originalText', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { id: 'uuid-0', payload: { documentId: 'doc-1', chunkIndex: 0 } }
        ]
      }
    }));

    const text = await store.getDocumentOriginalText('doc-1');
    expect(text).toBeNull();
  });

  it('setDocumentOriginalText locates chunk-0 and patches its payload', async () => {
    // scroll — returns chunk-0 point
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [
          { id: 'uuid-chunk-0', payload: { documentId: 'doc-1', chunkIndex: 0 } }
        ]
      }
    }));
    // setPayload — ok
    fetch.mockResolvedValueOnce(mockOk());

    await store.setDocumentOriginalText('doc-1', 'hello\nworld — é');

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, opts] = fetch.mock.calls[1];
    expect(url).toContain('/points/payload');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.payload).toEqual({ originalText: 'hello\nworld — é' });
    expect(body.points).toEqual(['uuid-chunk-0']);
  });

  it('setDocumentOriginalText throws a clear error when chunk-0 is missing', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [] } }));

    await expect(store.setDocumentOriginalText('ghost', 'body'))
      .rejects.toThrow('cannot set originalText: no chunk-0 for ghost');
    // No setPayload attempted
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('setDocumentOriginalText throws when Qdrant setPayload fails', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [{ id: 'uuid-0', payload: { documentId: 'd', chunkIndex: 0 } }]
      }
    }));
    fetch.mockResolvedValueOnce(mockFail(500, 'server error'));

    await expect(store.setDocumentOriginalText('d', 'x'))
      .rejects.toThrow('Qdrant setPayload failed: 500');
  });

  it('set-then-get roundtrip (two-phase) returns the stored text', async () => {
    // Phase 1: setDocumentOriginalText
    //   scroll finds chunk-0
    fetch.mockResolvedValueOnce(mockOk({
      result: { points: [{ id: 'uuid-0', payload: { documentId: 'd', chunkIndex: 0 } }] }
    }));
    //   setPayload ok
    fetch.mockResolvedValueOnce(mockOk());
    // Phase 2: getDocumentOriginalText
    //   scroll finds chunk-0 with originalText in payload
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [{ id: 'uuid-0', payload: { documentId: 'd', chunkIndex: 0, originalText: 'hello\nworld — é' } }]
      }
    }));

    await store.setDocumentOriginalText('d', 'hello\nworld — é');
    const got = await store.getDocumentOriginalText('d');
    expect(got).toBe('hello\nworld — é');
  });
});

describe('QdrantVectorStore.healthCheck', () => {
  let store;

  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({
      qdrantUrl: 'http://qdrant:6333',
      collectionName: 'test'
    });
  });

  it('returns healthy when Qdrant responds ok', async () => {
    fetch.mockResolvedValueOnce({ ok: true });

    const health = await store.healthCheck();
    expect(health).toEqual({ healthy: true, type: 'qdrant', url: 'http://qdrant:6333' });
  });

  it('returns unhealthy when Qdrant responds with an error', async () => {
    fetch.mockResolvedValueOnce({ ok: false });

    const health = await store.healthCheck();
    expect(health).toEqual({ healthy: false, type: 'qdrant', url: 'http://qdrant:6333' });
  });

  it('returns unhealthy when fetch throws (network error)', async () => {
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const health = await store.healthCheck();
    expect(health).toEqual({
      healthy: false,
      type: 'qdrant',
      error: 'ECONNREFUSED'
    });
  });
});

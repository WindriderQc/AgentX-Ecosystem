jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

const fetch = require('../../src/utils/fetchWithTimeout');
const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');

// ─── Helper ─────────────────────────────────────────────────
function mockOk(jsonBody = {}) {
  return { ok: true, json: async () => jsonBody, text: async () => '' };
}
function mockFail(status = 500, body = 'error') {
  return { ok: false, status, text: async () => body };
}

describe('bounded corpus traversal payloads', () => {
  let requests;
  let store;
  const metadata = { documentId: 'doc-1', source: 'guide', tags: ['local'], hash: 'hash-1', sourceIdentity: 'source:guide', sourceIdentityKind: 'label', contentHash: 'content-1', identityVersion: 2, chunkSize: 1000, chunkOverlap: 100 };
  beforeEach(() => {
    requests = [];
    fetch.mockReset();
    store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' });
    fetch.mockImplementation(async (url, options = {}) => {
      if (!url.endsWith('/scroll')) return mockOk({ result: {} });
      const body = JSON.parse(options.body);
      requests.push(body);
      const payload = { ...metadata, text: 'passage', originalText: 'complete source', chunkIndex: 0 };
      const fields = body.with_payload?.include;
      const selected = fields ? Object.fromEntries(fields.filter(key => key in payload).map(key => [key, payload[key]])) : payload;
      return mockOk({ result: { points: [{ id: 'point-0', ...(body.with_payload === false ? {} : { payload: selected }) }], next_page_offset: null } });
    });
  });

  test('inventory and metadata reads omit all source text while preserving document identity', async () => {
    const result = await store.listDocuments();
    const { hash, ...listedMetadata } = metadata;
    expect(result).toEqual({ total: 1, documents: [{ ...listedMetadata, chunkCount: 1 }] });
    expect(await store.getDocument('doc-1')).toMatchObject(metadata);
    for (const body of requests) {
      expect(body.with_payload.include).not.toEqual(expect.arrayContaining(['text']));
      expect(body.with_payload.include).not.toEqual(expect.arrayContaining(['originalText']));
      expect(body.with_vector).toBe(false);
    }
    expect(requests[1].limit).toBe(1);
  });

  test('passage reads omit original text and preserve text ordering fields', async () => {
    expect(await store.getDocumentChunks('doc-1')).toEqual([{ text: 'passage', chunkIndex: 0 }]);
    expect(requests[0].with_payload.include).toEqual(['text', 'chunkIndex']);
  });

  test('replacement and original-text updates fetch only IDs; original-text reads stay lossless', async () => {
    store._collectionVerified = true;
    await store.upsertDocument('doc-1', {}, [{ chunkIndex: 0, text: 'new', embedding: [1] }]);
    expect(requests[0].with_payload).toBe(false);
    expect(await store.getDocumentOriginalText('doc-1')).toBe('complete source');
    await store.setDocumentOriginalText('doc-1', 'updated');
    expect(requests[1].with_payload.include).toEqual(['originalText']);
    expect(requests[2].with_payload).toBe(false);
    expect(requests.slice(1).map(body => body.limit)).toEqual([1, 1]);
  });
});

describe('failed corpus traversals never become empty or partial results', () => {
  const store = () => new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' });
  beforeEach(() => fetch.mockReset());
  test.each(['inventory', 'passages', 'replacement'])('a collection removed after the first page fails %s without writes', async operation => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points: [{ payload: { documentId: 'doc-1' } }], next_page_offset: 'next-opaque-id' } }))
      .mockResolvedValueOnce(mockFail(404, 'Not found: Collection test does not exist'));
    const client = store();
    client._collectionVerified = true;
    const read = operation === 'inventory' ? client.listDocuments()
      : operation === 'passages' ? client.getDocumentChunks('doc-1')
        : client.upsertDocument('doc-1', {}, [{ chunkIndex: 0, text: 'new', embedding: [1] }]);
    await expect(read).rejects.toThrow('Qdrant scroll failed: 404');
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'POST']);
    expect(fetch.mock.calls.every(([url]) => url.endsWith('/scroll'))).toBe(true);
  });
  test.each([{}, { result: {} }, { result: { points: null } }])('an invalid successful response is unavailable: %p', async response => {
    fetch.mockResolvedValueOnce(mockOk(response));
    await expect(store().listDocuments()).rejects.toThrow('Qdrant scroll returned an invalid result');
  });
  test('stats reject a collection disappearing between collection info and its first page', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { points_count: 10 } }))
      .mockResolvedValueOnce(mockFail(404, 'Not found: Collection test does not exist'));
    await expect(store().getStats()).rejects.toThrow('Qdrant scroll failed: 404');
  });
});

describe('complete corpus reads beyond 10,000 points', () => {
  beforeEach(() => {
    fetch.mockReset();
    fetch.mockImplementation(async (url, options = {}) => {
      if (!url.endsWith('/scroll')) return mockOk({ result: { points_count: 10001, status: 'green' } });
      const body = JSON.parse(options.body);
      const offset = body.offset || 0;
      const end = Math.min(offset + body.limit, 10001);
      const points = Array.from({ length: end - offset }, (_, i) => ({
        id: `point-${offset + i}`,
        payload: { documentId: offset + i === 10000 ? 'last-source' : 'large-source', chunkIndex: offset + i, text: `passage-${offset + i}` }
      }));
      return mockOk({ result: { points, next_page_offset: end < 10001 ? end : null } });
    });
  });

  test('status counts sources on the final Qdrant page', async () => {
    const store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' });
    expect((await store.getStats()).documentCount).toBe(2);
    const pages = fetch.mock.calls.filter(([url]) => url.endsWith('/scroll'));
    expect(pages.length).toBeLessThanOrEqual(12);
    expect(pages.every(([, options]) => JSON.parse(options.body).limit <= 1000)).toBe(true);
  });

  test('document pagination includes the final source and complete passage counts', async () => {
    const store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' });
    const first = await store.listDocuments({}, { limit: 1 });
    expect(first.total).toBe(2);
    expect(first.documents[0].chunkCount).toBe(10000);
    const last = await store.listDocuments({}, { offset: 1, limit: 1 });
    expect(last.documents[0].documentId).toBe('last-source');
  });

  test('a failure on the final page is unavailable, not a partial successful corpus', async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/scroll') && JSON.parse(options.body).offset === 10000) return mockFail(503, 'unavailable');
      return original(url, options);
    });
    const store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' });
    await expect(store.getStats()).rejects.toThrow('Qdrant scroll failed');
    await expect(store.listDocuments()).rejects.toThrow('Qdrant scroll failed');
  });

  test('long documents retain their final passage and remove all stale points on replacement', async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith('/scroll')) return response;
      const body = await response.json();
      body.result.points.forEach(point => { point.payload.documentId = 'large-source'; });
      return mockOk(body);
    });
    const store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' });
    const chunks = await store.getDocumentChunks('large-source');
    expect(chunks).toHaveLength(10001);
    expect(chunks.at(-1).text).toBe('passage-10000');
    store._collectionVerified = true;
    await store.upsertDocument('large-source', { source: 'api' }, [{ chunkIndex: 0, text: 'replacement', embedding: [1, 0] }]);
    const deletion = fetch.mock.calls.find(([url]) => url.endsWith('/points/delete'));
    expect(JSON.parse(deletion[1].body).points).toHaveLength(10001);
    expect(JSON.parse(deletion[1].body).points).toContain('point-10000');
  });
});

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
      // document-ID-only scroll
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

describe('QdrantVectorStore inventory page failures', () => {
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

    await expect(store.listDocuments()).rejects.toThrow('Qdrant scroll failed: 503');
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
    // Scroll — no old points
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

    const result = await store.upsertDocument('doc-1', { source: 'test' }, chunks);

    // scroll (1) + upsert (1) + deleteByPointIds (1) = 3
    expect(fetch).toHaveBeenCalledTimes(3);
    // Verify the delete call passes the old point IDs
    const deleteCall = fetch.mock.calls[2];
    expect(deleteCall[0]).toContain('/points/delete');
    const deleteBody = JSON.parse(deleteCall[1].body);
    expect(deleteBody.points).toEqual(['old-uuid-1', 'old-uuid-2']);
    expect(result.status).toBe('updated');
  });

  it('does not delete a deterministic point that was replaced in place', async () => {
    const currentPointId = store._generatePointId('doc-1', 0);
    // scroll — the existing revision has the same deterministic chunk-0 ID
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [{ id: currentPointId, payload: { documentId: 'doc-1' } }]
      }
    }));
    // upsert batch
    fetch.mockResolvedValueOnce(mockOk());

    const result = await store.upsertDocument('doc-1', { source: 'test' }, [{
      text: 'replacement content',
      embedding: [0.5, 0.6],
      chunkIndex: 0
    }]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('/points');
    expect(result).toEqual({ documentId: 'doc-1', chunkCount: 1, status: 'updated' });
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

  it('filters and returns canonical source/content identity metadata', async () => {
    fetch.mockResolvedValueOnce(mockOk({
      result: {
        points: [{
          payload: {
            documentId: 'doc-identity',
            source: 'guide.md',
            tags: [],
            sourceIdentity: 'source-label:guide.md',
            sourceIdentityKind: 'source_label',
            contentHash: 'content-123',
            identityVersion: 'source-content-v1',
            chunkSize: 500,
            chunkOverlap: 50
          }
        }]
      }
    }));

    const { documents } = await store.listDocuments({
      sourceIdentity: 'source-label:guide.md',
      contentHash: 'content-123'
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.filter.must).toEqual([
      { key: 'sourceIdentity', match: { value: 'source-label:guide.md' } },
      { key: 'contentHash', match: { value: 'content-123' } }
    ]);
    expect(documents[0]).toMatchObject({
      documentId: 'doc-identity',
      sourceIdentity: 'source-label:guide.md',
      sourceIdentityKind: 'source_label',
      contentHash: 'content-123',
      identityVersion: 'source-content-v1',
      chunkSize: 500,
      chunkOverlap: 50,
      chunkCount: 1
    });
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
    // Scroll call: returns 1 point with payload.originalText
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

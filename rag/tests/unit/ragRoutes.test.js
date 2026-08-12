jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/services/ragStore', () => {
  const mockStore = {
    upsertDocumentWithChunks: jest.fn(),
    searchSimilarChunks: jest.fn(),
    listDocuments: jest.fn(),
    deleteDocument: jest.fn(),
    getStats: jest.fn(),
    vectorStore: { healthCheck: jest.fn().mockResolvedValue({ healthy: true }) },
  };
  return {
    getRagStore: () => mockStore,
    _mockStore: mockStore,
  };
});

jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: () => ({
    providerName: 'ollama-direct',
    model: 'nomic-embed-text:v1.5',
    getStatusInfo: () => ({ provider: 'ollama-direct', model: 'nomic' }),
    getCachedConnectionStatus: () => ({ healthy: true, checkedAt: new Date().toISOString() }),
  }),
}));

jest.mock('../../src/services/embeddingCache', () => ({
  getEmbeddingCache: () => ({
    clear: jest.fn(),
    getStats: () => ({ hits: 0, misses: 0, size: 0 }),
  }),
}));

jest.mock('../../src/services/ingestWorker', () => ({
  runIngestScan: jest.fn(),
  getConfiguredRoots: jest.fn(() => []),
  isPathUnderRoot: jest.fn(() => false),
}));

jest.mock('../../src/services/ingestJobManager', () => ({
  isRunning: jest.fn(() => false),
  getActiveJobId: jest.fn(),
  createJob: jest.fn(),
  getJob: jest.fn(),
  updateProgress: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
  cancelJob: jest.fn(),
}));

jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
}));

jest.mock('../../models/IngestJob', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const express = require('express');
const ragRoutes = require('../../routes/rag');
const { _mockStore: mockStore } = require('../../src/services/ragStore');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', ragRoutes);
  return app;
}

beforeEach(() => {
  Object.values(mockStore).forEach((fn) => {
    if (typeof fn.mockReset === 'function') fn.mockReset();
  });
  mockStore.vectorStore = { healthCheck: jest.fn().mockResolvedValue({ healthy: true }) };
});

// ── POST /ingest ─────────────────────────────────────────

describe('POST /api/rag/ingest', () => {
  it('ingests valid text and returns result', async () => {
    mockStore.upsertDocumentWithChunks.mockResolvedValue({
      documentId: 'abc', chunkCount: 2, status: 'created',
    });

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'Hello world', source: 'test', tags: ['a'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentId).toBe('abc');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ source: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/text is required/);
  });

  it('returns 400 when text is empty', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: '   ' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when source is not a string', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'hello', source: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source must be a string/);
  });

  it('returns 400 when tags is not an array', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'hello', tags: 'not-array' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tags must be an array/);
  });

  it('returns 503 when vector store is unreachable', async () => {
    mockStore.upsertDocumentWithChunks.mockRejectedValue(
      new Error('fetch failed: ECONNREFUSED')
    );

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'hello' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('VECTOR_STORE_UNAVAILABLE');
  });

  it('returns 503 when embedding service is down', async () => {
    mockStore.upsertDocumentWithChunks.mockRejectedValue(
      new Error('core proxy returned 502')
    );

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'hello' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('EMBEDDING_SERVICE_UNAVAILABLE');
  });

  it('returns 500 for unexpected errors', async () => {
    mockStore.upsertDocumentWithChunks.mockRejectedValue(new Error('unexpected'));

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'hello' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('defaults source to "api" when omitted', async () => {
    mockStore.upsertDocumentWithChunks.mockResolvedValue({ documentId: 'x', chunkCount: 1, status: 'created' });

    await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'hello' });

    expect(mockStore.upsertDocumentWithChunks).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ source: 'api' })
    );
  });
});

// ── POST /documents (alias) ─────────────────────────────

describe('POST /api/rag/documents', () => {
  it('works as an alias for /ingest', async () => {
    mockStore.upsertDocumentWithChunks.mockResolvedValue({ documentId: 'x', chunkCount: 1, status: 'created' });

    const res = await request(buildApp())
      .post('/api/rag/documents')
      .send({ text: 'alias test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── POST /search ─────────────────────────────────────────

describe('POST /api/rag/search', () => {
  it('returns search results', async () => {
    mockStore.searchSimilarChunks.mockResolvedValue([
      { text: 'match', score: 0.9 },
    ]);

    const res = await request(buildApp())
      .post('/api/rag/search')
      .send({ query: 'find this' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.count).toBe(1);
  });

  it('returns 400 when query is missing', async () => {
    const res = await request(buildApp())
      .post('/api/rag/search')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query is required/);
  });

  it('returns 400 when query is empty', async () => {
    const res = await request(buildApp())
      .post('/api/rag/search')
      .send({ query: '  ' });

    expect(res.status).toBe(400);
  });

  it('returns 503 on embedding service failure', async () => {
    mockStore.searchSimilarChunks.mockRejectedValue(new Error('embedding service 503'));

    const res = await request(buildApp())
      .post('/api/rag/search')
      .send({ query: 'test' });

    expect(res.status).toBe(503);
  });
});

// ── GET /documents ───────────────────────────────────────

describe('GET /api/rag/documents', () => {
  it('returns document list', async () => {
    mockStore.listDocuments.mockResolvedValue({
      documents: [{ documentId: 'a', source: 'api', chunkCount: 3 }],
      total: 1,
    });

    const res = await request(buildApp()).get('/api/rag/documents');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
  });

  it('passes source filter from query string', async () => {
    mockStore.listDocuments.mockResolvedValue({ documents: [], total: 0 });

    await request(buildApp()).get('/api/rag/documents?source=docs');

    expect(mockStore.listDocuments).toHaveBeenCalledWith(
      { source: 'docs' },
      expect.objectContaining({ limit: expect.any(Number), offset: 0 })
    );
  });

  it('splits comma-separated tags into array filter', async () => {
    mockStore.listDocuments.mockResolvedValue({ documents: [], total: 0 });

    await request(buildApp()).get('/api/rag/documents?tags=a,b');

    expect(mockStore.listDocuments).toHaveBeenCalledWith(
      { tags: ['a', 'b'] },
      expect.any(Object)
    );
  });

  it('returns 500 on store error', async () => {
    mockStore.listDocuments.mockRejectedValue(new Error('db down'));

    const res = await request(buildApp()).get('/api/rag/documents');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

// ── DELETE /documents/:id ────────────────────────────────

describe('DELETE /api/rag/documents/:id', () => {
  it('deletes and returns documentId', async () => {
    mockStore.deleteDocument.mockResolvedValue(true);

    const res = await request(buildApp()).delete('/api/rag/documents/doc123');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentId).toBe('doc123');
  });

  it('returns 404 when document not found', async () => {
    mockStore.deleteDocument.mockResolvedValue(false);

    const res = await request(buildApp()).delete('/api/rag/documents/missing');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('returns 500 on error', async () => {
    mockStore.deleteDocument.mockRejectedValue(new Error('fail'));

    const res = await request(buildApp()).delete('/api/rag/documents/x');

    expect(res.status).toBe(500);
  });
});

// ── GET /status ──────────────────────────────────────────

describe('GET /api/rag/status', () => {
  it('returns stats with dependencies', async () => {
    mockStore.getStats.mockResolvedValue({
      documentCount: 5,
      chunkCount: 20,
      vectorStore: { healthy: true, type: 'qdrant', url: 'http://qdrant:6333' },
    });

    const res = await request(buildApp()).get('/api/rag/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentCount).toBe(5);
    expect(res.body.data.dependencies).toBeDefined();
  });
});

// ── error classification ─────────────────────────────────

describe('error classification', () => {
  it('classifies ECONNREFUSED as VECTOR_STORE_UNAVAILABLE', async () => {
    mockStore.upsertDocumentWithChunks.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'test' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('VECTOR_STORE_UNAVAILABLE');
  });

  it('classifies "fetch failed" as VECTOR_STORE_UNAVAILABLE', async () => {
    mockStore.upsertDocumentWithChunks.mockRejectedValue(new Error('fetch failed'));

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'test' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('VECTOR_STORE_UNAVAILABLE');
  });

  it('classifies "core proxy" errors as EMBEDDING_SERVICE_UNAVAILABLE', async () => {
    mockStore.upsertDocumentWithChunks.mockRejectedValue(new Error('core proxy timeout'));

    const res = await request(buildApp())
      .post('/api/rag/ingest')
      .send({ text: 'test' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('EMBEDDING_SERVICE_UNAVAILABLE');
  });

  it('classifies "embedding" errors as EMBEDDING_SERVICE_UNAVAILABLE', async () => {
    mockStore.searchSimilarChunks.mockRejectedValue(new Error('embedding generation failed'));

    const res = await request(buildApp())
      .post('/api/rag/search')
      .send({ query: 'test' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('EMBEDDING_SERVICE_UNAVAILABLE');
  });
});

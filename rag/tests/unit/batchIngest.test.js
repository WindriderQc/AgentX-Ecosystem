/**
 * Tests for POST /api/rag/ingest/batch — bulk multi-document ingest.
 */

jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
  Schema: class { constructor() {} index() {} },
  model: jest.fn(() => ({}))
}));

jest.mock('../../src/services/ingestWorker', () => ({
  runIngestScan: jest.fn(),
  getConfiguredRoots: jest.fn().mockReturnValue([]),
  isPathUnderRoot: jest.fn()
}));

jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: jest.fn(() => ({
    testConnection: jest.fn().mockResolvedValue(true),
    providerName: 'mock',
    model: 'mock-model'
  }))
}));

jest.mock('../../src/services/embeddingCache', () => ({
  getEmbeddingCache: jest.fn(() => null)
}));

const mockUpsert = jest.fn();
jest.mock('../../src/services/ragStore', () => ({
  getRagStore: () => ({
    upsertDocumentWithChunks: mockUpsert
  })
}));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/rag'));
  return app;
}

describe('POST /api/rag/ingest/batch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsert.mockReset();
  });

  // ── Validation ────────────────────────────────────────

  it('rejects missing documents field', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/documents must be an array/);
  });

  it('rejects non-array documents', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documents must be an array/);
  });

  it('rejects empty documents array', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must not be empty/);
  });

  it('rejects batch exceeding max size', async () => {
    // Default max is 50 (or BATCH_MAX_DOCS env var)
    const docs = Array.from({ length: 51 }, (_, i) => ({ text: `doc ${i}` }));
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: docs });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds maximum/);
  });

  it('rejects document without text', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: [{ source: 'test' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documents\[0\]\.text is required/);
  });

  it('rejects document with empty text', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: [{ text: '   ' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documents\[0\]\.text is required/);
  });

  it('rejects document with non-string source', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: [{ text: 'hello', source: 123 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documents\[0\]\.source must be a string/);
  });

  it('rejects document with non-array tags', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: [{ text: 'hello', tags: 'not-array' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documents\[0\]\.tags must be an array/);
  });

  it('rejects if second document fails validation (whole batch rejected)', async () => {
    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'valid doc' },
          { text: '' }
        ]
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documents\[1\]\.text is required/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // ── Successful processing ─────────────────────────────

  it('processes documents and returns per-doc results', async () => {
    mockUpsert
      .mockResolvedValueOnce({ documentId: 'aaa', chunkCount: 3 })
      .mockResolvedValueOnce({ documentId: 'bbb', chunkCount: 5 });

    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'Document one content', source: 'test', tags: ['a'] },
          { text: 'Document two content', source: 'test' }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.succeeded).toBe(2);
    expect(res.body.data.failed).toBe(0);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results[0]).toEqual({
      index: 0, documentId: 'aaa', status: 'ok', chunkCount: 3
    });
    expect(res.body.data.results[1]).toEqual({
      index: 1, documentId: 'bbb', status: 'ok', chunkCount: 5
    });
  });

  it('passes correct options to upsertDocumentWithChunks', async () => {
    mockUpsert.mockResolvedValue({ documentId: 'x', chunkCount: 1 });

    await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [{
          text: 'Content here',
          source: 'my-source',
          tags: ['t1', 't2'],
          documentId: 'custom-id',
          chunkSize: 300,
          chunkOverlap: 30
        }]
      });

    expect(mockUpsert).toHaveBeenCalledWith('Content here', {
      source: 'my-source',
      tags: ['t1', 't2'],
      chunkSize: 300,
      chunkOverlap: 30,
      documentId: 'custom-id'
    });
  });

  it('defaults source to api when not provided', async () => {
    mockUpsert.mockResolvedValue({ documentId: 'x', chunkCount: 1 });

    await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({ documents: [{ text: 'hello' }] });

    expect(mockUpsert).toHaveBeenCalledWith('hello', expect.objectContaining({
      source: 'api',
      tags: []
    }));
  });

  // ── Sequential processing verification ────────────────

  it('processes documents sequentially (not in parallel)', async () => {
    const callOrder = [];
    mockUpsert.mockImplementation(async (text) => {
      callOrder.push(`start-${text}`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`end-${text}`);
      return { documentId: text, chunkCount: 1 };
    });

    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'A' },
          { text: 'B' },
          { text: 'C' }
        ]
      });

    expect(res.status).toBe(200);
    // If sequential, end of each doc must come before start of next
    expect(callOrder).toEqual([
      'start-A', 'end-A',
      'start-B', 'end-B',
      'start-C', 'end-C'
    ]);
  });

  // ── Per-doc error isolation ───────────────────────────

  it('isolates individual document failures and continues batch', async () => {
    mockUpsert
      .mockResolvedValueOnce({ documentId: 'a', chunkCount: 2 })
      .mockRejectedValueOnce(new Error('Chunk generation failed'))
      .mockResolvedValueOnce({ documentId: 'c', chunkCount: 4 });

    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'Good doc one' },
          { text: 'Bad doc two' },
          { text: 'Good doc three' }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.succeeded).toBe(2);
    expect(res.body.data.failed).toBe(1);
    expect(res.body.data.results[0].status).toBe('ok');
    expect(res.body.data.results[1].status).toBe('error');
    expect(res.body.data.results[1].error).toBe('Chunk generation failed');
    expect(res.body.data.results[2].status).toBe('ok');
  });

  // ── Early abort on availability errors ────────────────

  it('aborts batch with 503 when first document hits availability error (embedding)', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('Embedding service returned 503'));

    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'Doc one' },
          { text: 'Doc two' }
        ]
      });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('EMBEDDING_SERVICE_UNAVAILABLE');
    // Second document should never be attempted
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('aborts batch with 503 when first document hits vector store unavailable', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('connect ECONNREFUSED qdrant:6333'));

    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'Doc one' },
          { text: 'Doc two' }
        ]
      });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('VECTOR_STORE_UNAVAILABLE');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('does NOT abort batch when non-first document hits availability error', async () => {
    mockUpsert
      .mockResolvedValueOnce({ documentId: 'a', chunkCount: 1 })
      .mockRejectedValueOnce(new Error('Embedding service returned 503'))
      .mockResolvedValueOnce({ documentId: 'c', chunkCount: 1 });

    const res = await request(buildApp())
      .post('/api/rag/ingest/batch')
      .send({
        documents: [
          { text: 'Doc one' },
          { text: 'Doc two' },
          { text: 'Doc three' }
        ]
      });

    // Batch continues — availability error on non-first doc is treated as normal per-doc error
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.succeeded).toBe(2);
    expect(res.body.data.failed).toBe(1);
    expect(res.body.data.results[1].status).toBe('error');
  });
});

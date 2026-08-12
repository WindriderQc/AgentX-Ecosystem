jest.mock('mongoose', () => ({
  connection: { readyState: 1 }
}));

jest.mock('../../src/services/ragStore', () => {
  const mockRagStore = {
    listDocuments: jest.fn(),
    getStats: jest.fn(),
    upsertDocumentWithChunks: jest.fn(),
    vectorStore: {
      getDocumentOriginalText: jest.fn(),
      getDocument: jest.fn(),
    },
  };
  return {
    getRagStore: jest.fn(() => mockRagStore),
    _mockRagStore: mockRagStore,
  };
});

jest.mock('../../src/services/embeddings', () => {
  const mockEmbeddingsService = {
    model: 'nomic-embed-text:v1.5',
    getDimension: jest.fn(() => 768),
  };
  return {
    getEmbeddingsService: jest.fn(() => mockEmbeddingsService),
    _mockEmbeddingsService: mockEmbeddingsService,
  };
});

const express = require('express');
const request = require('supertest');
const { getRagStore, _mockRagStore } = require('../../src/services/ragStore');
const { getEmbeddingsService, _mockEmbeddingsService } = require('../../src/services/embeddings');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/migration.routes'));
  return app;
}

function getJobsMap() {
  return require('../../routes/migration.routes')._jobs;
}

describe('GET /api/rag/embedding-migration/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _mockEmbeddingsService.model = 'nomic-embed-text:v1.5';
    _mockEmbeddingsService.getDimension.mockReturnValue(768);
  });

  it('returns status with matching dimensions', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 768,
      documentCount: 42,
      chunkCount: 310,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({
      currentModel: 'nomic-embed-text:v1.5',
      currentDimension: 768,
      storedDimension: 768,
      dimensionMatch: true,
      documentCount: 42,
      chunkCount: 310,
      migrationNeeded: false,
    });
  });

  it('detects dimension mismatch and reports migrationNeeded', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 384,
      documentCount: 10,
      chunkCount: 80,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.status).toBe(200);
    expect(res.body.data.dimensionMatch).toBe(false);
    expect(res.body.data.migrationNeeded).toBe(true);
    expect(res.body.data.note).toContain('collection recreation');
  });

  it('reports no migration needed for empty collection', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 0,
      documentCount: 0,
      chunkCount: 0,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.body.data.dimensionMatch).toBe(true);
    expect(res.body.data.migrationNeeded).toBe(false);
  });

  it('reports no migration needed when dimensions differ but no documents exist', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 384,
      documentCount: 0,
      chunkCount: 0,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.body.data.dimensionMatch).toBe(false);
    expect(res.body.data.migrationNeeded).toBe(false);
  });

  it('returns 500 on internal error', async () => {
    _mockRagStore.getStats.mockRejectedValue(new Error('Qdrant down'));

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/rag/embedding-migration/reindex', () => {
  // Default stats for reindex tests: migrationNeeded === true (dims differ, docs present)
  // so the new no-op guard does not block the legacy happy-path assertions.
  const MIGRATION_NEEDED_STATS = {
    vectorDimension: 384,
    documentCount: 10,
    chunkCount: 80,
  };
  // Stats where dims match and docs exist: migrationNeeded === false — triggers the guard.
  const MIGRATION_NOT_NEEDED_STATS = {
    vectorDimension: 768,
    documentCount: 42,
    chunkCount: 310,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    _mockEmbeddingsService.model = 'nomic-embed-text:v1.5';
    _mockEmbeddingsService.getDimension.mockReturnValue(768);
    _mockRagStore.getStats.mockResolvedValue(MIGRATION_NEEDED_STATS);
    // Clear all jobs between tests
    const jobs = getJobsMap();
    jobs.clear();
  });

  it('returns 400 when confirm is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('CONFIRMATION_REQUIRED');
  });

  it('returns 400 when confirm is false', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CONFIRMATION_REQUIRED');
  });

  it('returns 400 when confirm is a string "true"', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: 'true' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CONFIRMATION_REQUIRED');
  });

  it('returns 202 with jobId when confirm is true', async () => {
    _mockRagStore.listDocuments.mockResolvedValue({ documents: [], total: 0 });

    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.jobId).toMatch(/^reindex-\d+$/);
    expect(res.body.data.status).toBe('running');
  });

  it('returns 409 when a reindex is already running', async () => {
    // Make the first reindex hang
    _mockRagStore.listDocuments.mockReturnValue(new Promise(() => {}));

    const app = buildApp();

    const first = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('REINDEX_ALREADY_RUNNING');
    expect(second.body.data.activeJobId).toBe(first.body.data.jobId);
  });

  it('completes immediately for empty document list', async () => {
    _mockRagStore.listDocuments.mockResolvedValue({ documents: [], total: 0 });

    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    const jobId = res.body.data.jobId;

    // Wait for background completion
    await new Promise((r) => setTimeout(r, 50));

    const jobs = getJobsMap();
    const job = jobs.get(jobId);
    expect(job.status).toBe('completed');
    expect(job.completedAt).not.toBeNull();
    expect(job.progress.total).toBe(0);
  });

  // ── No-op guard (0161) ─────────────────────────────────
  // When stored and current embedding dimensions already match, the reindex
  // is pure wasted GPU time. The POST handler must refuse unless force:true.

  it('returns 400 MIGRATION_NOT_NEEDED when dimensions match and force is absent', async () => {
    _mockRagStore.getStats.mockResolvedValue(MIGRATION_NOT_NEEDED_STATS);

    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('MIGRATION_NOT_NEEDED');
    // listDocuments must not be touched — the guard rejects before the job runs.
    expect(_mockRagStore.listDocuments).not.toHaveBeenCalled();
  });

  it('accepts { confirm: true, force: true } even when migration is not needed', async () => {
    _mockRagStore.getStats.mockResolvedValue(MIGRATION_NOT_NEEDED_STATS);
    _mockRagStore.listDocuments.mockResolvedValue({ documents: [], total: 0 });

    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true, force: true });

    // Accepted: 202 (running) or 409 (another reindex already running). Both prove
    // the guard was bypassed by force:true. In this isolated test, the jobs map
    // is cleared in beforeEach so we should always see 202.
    expect([202, 409]).toContain(res.status);
    if (res.status === 202) {
      expect(res.body.ok).toBe(true);
      expect(res.body.data.jobId).toMatch(/^reindex-\d+$/);
      expect(res.body.data.status).toBe('running');
    }
  });

  it('accepts { confirm: true } without force when migrationNeeded is true (happy path preserved)', async () => {
    // Default beforeEach already sets MIGRATION_NEEDED_STATS.
    _mockRagStore.listDocuments.mockResolvedValue({ documents: [], total: 0 });

    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.jobId).toMatch(/^reindex-\d+$/);
  });

  // ── Legacy doc handling (T3) ───────────────────────────
  // After T3, reindex reads originalText written by T2 at ingest. Documents
  // ingested before T2 have no originalText payload — they fail with a clear
  // re-ingest message rather than silently corrupting via chunk-concat.

  it('fails legacy documents (no originalText) with a re-ingest message', async () => {
    _mockRagStore.listDocuments.mockResolvedValue({
      documents: [{ documentId: 'legacy-doc', source: 'test' }],
      total: 1,
    });
    _mockRagStore.vectorStore.getDocumentOriginalText.mockResolvedValue(null);

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    expect(startRes.status).toBe(202);
    const jobId = startRes.body.data.jobId;

    await new Promise((r) => setTimeout(r, 50));

    const jobs = getJobsMap();
    const job = jobs.get(jobId);
    expect(job.status).toBe('completed');
    expect(job.progress.failed).toBe(1);
    expect(job.progress.succeeded).toBe(0);
    expect(job.progress.errors[0].documentId).toBe('legacy-doc');
    expect(job.progress.errors[0].error).toMatch(/originalText/);
    expect(_mockRagStore.upsertDocumentWithChunks).not.toHaveBeenCalled();
  });
});

describe('GET /api/rag/embedding-migration/reindex/:jobId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _mockEmbeddingsService.model = 'nomic-embed-text:v1.5';
    _mockEmbeddingsService.getDimension.mockReturnValue(768);
    // Dimensions differ so the POST no-op guard does not block these tests.
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 384,
      documentCount: 10,
      chunkCount: 80,
    });
    const jobs = getJobsMap();
    jobs.clear();
  });

  it('returns 404 for unknown jobId', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/rag/embedding-migration/reindex/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Job not found');
  });

  it('returns live progress for a running job', async () => {
    // Make listDocuments hang so we can inspect progress
    _mockRagStore.listDocuments.mockReturnValue(new Promise(() => {}));

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    const jobId = startRes.body.data.jobId;

    const statusRes = await request(app)
      .get(`/api/rag/embedding-migration/reindex/${jobId}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.ok).toBe(true);
    expect(statusRes.body.data.jobId).toBe(jobId);
    expect(statusRes.body.data.status).toBe('running');
    expect(statusRes.body.data.startedAt).toBeDefined();
    expect(statusRes.body.data.completedAt).toBeNull();
    expect(statusRes.body.data.progress).toBeDefined();
    expect(statusRes.body.data).toHaveProperty('currentDocument');
  });

  it('returns completed status with final counts after reindex finishes', async () => {
    _mockRagStore.listDocuments.mockResolvedValue({
      documents: [
        { documentId: 'doc-1', source: 'test', chunkCount: 2 },
        { documentId: 'doc-2', source: 'test', chunkCount: 3 },
      ],
      total: 2,
    });
    _mockRagStore.vectorStore.getDocumentOriginalText.mockResolvedValue('original document body');
    _mockRagStore.vectorStore.getDocument.mockResolvedValue({
      documentId: 'doc-1',
      source: 'test',
      tags: ['a'],
    });
    _mockRagStore.upsertDocumentWithChunks.mockResolvedValue({ documentId: 'doc-1', chunkCount: 2 });

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    const jobId = startRes.body.data.jobId;

    // Wait for background work to finish
    await new Promise((r) => setTimeout(r, 100));

    const statusRes = await request(app)
      .get(`/api/rag/embedding-migration/reindex/${jobId}`);

    expect(statusRes.body.data.status).toBe('completed');
    expect(statusRes.body.data.completedAt).not.toBeNull();
    expect(statusRes.body.data.progress.total).toBe(2);
    expect(statusRes.body.data.progress.processed).toBe(2);
    expect(statusRes.body.data.progress.succeeded).toBe(2);
    expect(statusRes.body.data.progress.failed).toBe(0);
    expect(statusRes.body.data.currentDocument).toBeNull();
  });

  it('records failed documents without aborting the reindex', async () => {
    _mockRagStore.listDocuments.mockResolvedValue({
      documents: [
        { documentId: 'doc-ok', source: 'test' },
        { documentId: 'doc-fail', source: 'test' },
        { documentId: 'doc-ok-2', source: 'test' },
      ],
      total: 3,
    });
    _mockRagStore.vectorStore.getDocumentOriginalText.mockResolvedValue('original body');
    _mockRagStore.vectorStore.getDocument.mockResolvedValue({
      documentId: 'doc-ok',
      source: 'test',
      tags: [],
    });
    _mockRagStore.upsertDocumentWithChunks
      .mockResolvedValueOnce({ documentId: 'doc-ok', chunkCount: 1 })
      .mockRejectedValueOnce(new Error('Embedding timeout'))
      .mockResolvedValueOnce({ documentId: 'doc-ok-2', chunkCount: 1 });

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirm: true });

    const jobId = startRes.body.data.jobId;

    await new Promise((r) => setTimeout(r, 100));

    const statusRes = await request(app)
      .get(`/api/rag/embedding-migration/reindex/${jobId}`);

    expect(statusRes.body.data.status).toBe('completed');
    expect(statusRes.body.data.progress.total).toBe(3);
    expect(statusRes.body.data.progress.processed).toBe(3);
    expect(statusRes.body.data.progress.succeeded).toBe(2);
    expect(statusRes.body.data.progress.failed).toBe(1);
    expect(statusRes.body.data.progress.errors).toHaveLength(1);
    expect(statusRes.body.data.progress.errors[0].documentId).toBe('doc-fail');
    expect(statusRes.body.data.progress.errors[0].error).toBe('Embedding timeout');
  });
});

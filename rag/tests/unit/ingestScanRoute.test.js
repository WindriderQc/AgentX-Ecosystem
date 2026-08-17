jest.mock('mongoose', () => ({
  connection: {
    readyState: 1
  },
  Schema: class { constructor() {} index() {} },
  model: jest.fn(() => ({ create: jest.fn().mockResolvedValue({}) }))
}));

jest.mock('../../src/services/ingestWorker', () => ({
  runIngestScan: jest.fn(),
  getConfiguredRoots: jest.fn().mockReturnValue(['/data/imports/docs']),
  isPathUnderRoot: jest.fn((filePath, root) => {
    const resolved = require('path').resolve(filePath);
    const resolvedRoot = require('path').resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}/`);
  })
}));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const { runIngestScan } = require('../../src/services/ingestWorker');
const jobManager = require('../../src/services/ingestJobManager');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/rag'));
  return app;
}

describe('POST /api/rag/ingest-scan (async job pattern)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoose.connection.readyState = 1;
    jobManager._reset();

    // Default: resolve immediately (background task completes fast)
    runIngestScan.mockResolvedValue({
      totalCandidates: 2,
      processed: 2,
      ingested: 1,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      results: [{ status: 'ingested' }, { status: 'updated' }]
    });
  });

  it('returns 202 with jobId and status running', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/ingest-scan')
      .send({ limit: 10, roots: ['/data/imports/docs'] });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.jobId).toBeDefined();
    expect(res.body.data.status).toBe('running');
  });

  it('passes correct scan params to runIngestScan', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/rag/ingest-scan')
      .send({ limit: 10, roots: ['/data/imports/docs'] });

    // Wait a tick for the fire-and-forget call
    await new Promise((r) => setTimeout(r, 10));

    expect(runIngestScan).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        roots: ['/data/imports/docs']
      })
    );
  });

  it('returns 503 when MongoDB is not connected', async () => {
    mongoose.connection.readyState = 0;

    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('MONGODB_UNAVAILABLE');
    expect(runIngestScan).not.toHaveBeenCalled();
  });

  it('rejects roots outside configured paths', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/rag/ingest-scan')
      .send({ roots: ['/etc/passwd'] });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('INVALID_ROOTS');
    expect(runIngestScan).not.toHaveBeenCalled();
  });

  it('rejects an empty roots array instead of widening the scan', async () => {
    const response = await request(buildApp())
      .post('/api/rag/ingest-scan')
      .send({ roots: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_ROOTS');
    expect(runIngestScan).not.toHaveBeenCalled();
  });

  it('caps limit at 5000', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/rag/ingest-scan')
      .send({ limit: 99999 });

    // Wait a tick for the fire-and-forget call
    await new Promise((r) => setTimeout(r, 10));

    expect(runIngestScan).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000 })
    );
  });

  it('returns 409 when a scan is already running', async () => {
    // Make the first scan hang so it stays "running"
    runIngestScan.mockReturnValue(new Promise(() => {}));

    const app = buildApp();

    const first = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('SCAN_ALREADY_RUNNING');
    expect(second.body.data.activeJobId).toBe(first.body.data.jobId);
  });

  it('includes onProgress and isCancelled callbacks in runIngestScan call', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    await new Promise((r) => setTimeout(r, 10));

    expect(runIngestScan).toHaveBeenCalledWith(
      expect.objectContaining({
        onProgress: expect.any(Function),
        isCancelled: expect.any(Function)
      })
    );
  });
});

describe('GET /api/rag/ingest-scan/:jobId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoose.connection.readyState = 1;
    jobManager._reset();
  });

  it('returns 404 for unknown job ID', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/rag/ingest-scan/nonexistent-id');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Job not found');
  });

  it('returns running job with progress', async () => {
    // Make the scan hang so it stays running
    runIngestScan.mockReturnValue(new Promise(() => {}));

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    const jobId = startRes.body.data.jobId;

    // Simulate progress update
    jobManager.updateProgress(jobId, { processed: 5, total: 20, errors: 1 });

    const statusRes = await request(app)
      .get(`/api/rag/ingest-scan/${jobId}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.ok).toBe(true);
    expect(statusRes.body.data.jobId).toBe(jobId);
    expect(statusRes.body.data.status).toBe('running');
    expect(statusRes.body.data.progress).toEqual({ processed: 5, total: 20, errors: 1 });
    expect(statusRes.body.data.startedAt).toBeDefined();
    expect(statusRes.body.data.completedAt).toBeNull();
  });

  it('returns completed job with summary and completedAt', async () => {
    // Let the scan complete immediately
    runIngestScan.mockResolvedValue({
      totalCandidates: 3,
      processed: 3,
      ingested: 2,
      updated: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      results: []
    });

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    const jobId = startRes.body.data.jobId;

    // Wait for the background task to complete
    await new Promise((r) => setTimeout(r, 50));

    const statusRes = await request(app)
      .get(`/api/rag/ingest-scan/${jobId}`);

    expect(statusRes.body.data.status).toBe('completed');
    expect(statusRes.body.data.completedAt).toBeDefined();
    expect(statusRes.body.data.completedAt).not.toBeNull();
    expect(statusRes.body.data.summary).toEqual(
      expect.objectContaining({
        processed: 3,
        ingested: 2,
        updated: 1
      })
    );
  });

  it('returns failed job with error', async () => {
    runIngestScan.mockRejectedValue(new Error('Disk full'));

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    const jobId = startRes.body.data.jobId;

    // Wait for the background task to fail
    await new Promise((r) => setTimeout(r, 50));

    const statusRes = await request(app)
      .get(`/api/rag/ingest-scan/${jobId}`);

    expect(statusRes.body.data.status).toBe('failed');
    expect(statusRes.body.data.error).toBe('Disk full');
    expect(statusRes.body.data.completedAt).toBeDefined();
  });
});

describe('DELETE /api/rag/ingest-scan/:jobId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoose.connection.readyState = 1;
    jobManager._reset();
  });

  it('returns 404 for unknown job ID', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/api/rag/ingest-scan/nonexistent-id');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('cancels a running job', async () => {
    // Make the scan hang so it stays running
    runIngestScan.mockReturnValue(new Promise(() => {}));

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    const jobId = startRes.body.data.jobId;

    const deleteRes = await request(app)
      .delete(`/api/rag/ingest-scan/${jobId}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
    expect(deleteRes.body.data.status).toBe('cancelled');

    // Verify the job shows as cancelled via GET
    const statusRes = await request(app)
      .get(`/api/rag/ingest-scan/${jobId}`);
    expect(statusRes.body.data.status).toBe('cancelled');
  });

  it('returns 400 when trying to cancel a completed job', async () => {
    runIngestScan.mockResolvedValue({
      totalCandidates: 0, processed: 0, ingested: 0,
      updated: 0, unchanged: 0, skipped: 0, failed: 0, results: []
    });

    const app = buildApp();
    const startRes = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    const jobId = startRes.body.data.jobId;

    // Wait for completion
    await new Promise((r) => setTimeout(r, 50));

    const deleteRes = await request(app)
      .delete(`/api/rag/ingest-scan/${jobId}`);

    expect(deleteRes.status).toBe(400);
    expect(deleteRes.body.error).toBe('JOB_NOT_RUNNING');
  });

  it('allows a new scan after cancelling', async () => {
    // First scan hangs
    runIngestScan.mockReturnValue(new Promise(() => {}));

    const app = buildApp();
    const first = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    // Cancel it
    await request(app)
      .delete(`/api/rag/ingest-scan/${first.body.data.jobId}`);

    // Now a new scan should be accepted
    runIngestScan.mockResolvedValue({
      totalCandidates: 0, processed: 0, ingested: 0,
      updated: 0, unchanged: 0, skipped: 0, failed: 0, results: []
    });

    const second = await request(app)
      .post('/api/rag/ingest-scan')
      .send({});

    expect(second.status).toBe(202);
    expect(second.body.data.jobId).not.toBe(first.body.data.jobId);
  });
});

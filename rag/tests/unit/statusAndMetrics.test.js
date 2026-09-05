const request = require('supertest');

const mockEmbeddingsService = {
  providerName: 'core-proxy',
  model: 'nomic-embed-text:v1.5',
  testConnection: jest.fn().mockResolvedValue(true),
  getCachedConnectionStatus: jest.fn(() => ({
    healthy: true,
    checkedAt: 1710000000000,
    stale: false,
  })),
  refreshConnectionStatus: jest.fn().mockResolvedValue(true),
  getStatusInfo: jest.fn(() => ({
    provider: 'core-proxy',
    model: 'nomic-embed-text:v1.5',
    endpoint: 'http://localhost:3080',
    route: '/api/inference/embed'
  })),
};

// ── Mock dependencies before requiring app ──

const mockVectorStore = {
  getStats: jest.fn(),
  healthCheck: jest.fn(),
  listDocuments: jest.fn(),
};

jest.mock('../../src/services/ragStore', () => {
  const store = {
    getStats: async () => {
      const storeStats = await mockVectorStore.getStats();
      const health = await mockVectorStore.healthCheck();
      return { ...storeStats, embeddingModel: 'nomic-embed-text:v1.5', vectorStore: health };
    },
    listDocuments: (...args) => mockVectorStore.listDocuments(...args),
    vectorStore: mockVectorStore,
  };
  return { getRagStore: () => store, resetRagStore: jest.fn() };
});

jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: () => mockEmbeddingsService,
  resetEmbeddingsService: jest.fn(),
}));

// Mock embeddingCache if it exists (added by task 0043)
jest.mock('../../src/services/embeddingCache', () => ({
  getEmbeddingCache: () => ({
    clear: jest.fn(),
    getStats: jest.fn().mockReturnValue({ hits: 0, misses: 0, size: 0 }),
  }),
}), { virtual: true });

jest.mock('../../models/RagManifest', () => {
  const mock = {
    findOne: jest.fn(),
  };
  return mock;
});

jest.mock('../../src/services/ingestWorker', () => ({
  runIngestScan: jest.fn(),
  getConfiguredRoots: jest.fn().mockReturnValue([]),
  isPathUnderRoot: jest.fn(),
}));

jest.mock('../../src/services/ingestJobManager', () => ({
  isRunning: jest.fn().mockReturnValue(false),
  createJob: jest.fn(),
  getJob: jest.fn(),
  getActiveJobId: jest.fn(),
}));

const app = require('../../app');
const RagManifest = require('../../models/RagManifest');
const api = request.agent(app);

afterAll((done) => {
  if (api.app.listening) return api.app.close(done);
  return done();
});

// ── Tests ───────────────────────────────────────────────

describe('GET /api/rag/status — dependency health matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbeddingsService.testConnection.mockResolvedValue(true);
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue({
      healthy: true,
      checkedAt: 1710000000000,
      stale: false,
    });
    mockVectorStore.getStats.mockResolvedValue({
      documentCount: 10,
      chunkCount: 50,
      vectorDimension: 768,
    });
    mockVectorStore.healthCheck.mockResolvedValue({
      healthy: true,
      type: 'qdrant',
      url: 'http://qdrant:6333',
    });
  });

  it('returns dependencies object with mongodb, embedding, and qdrant', async () => {
    const res = await api.get('/api/rag/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.dependencies).toBeDefined();
    expect(res.body.data.dependencies.mongodb).toBeDefined();
    expect(res.body.data.dependencies.embedding).toBeDefined();
    expect(res.body.data.dependencies.qdrant).toBeDefined();
  });

  it('returns per-dependency healthy booleans', async () => {
    const res = await api.get('/api/rag/status');
    const deps = res.body.data.dependencies;

    expect(typeof deps.mongodb.healthy).toBe('boolean');
    expect(typeof deps.embedding.healthy).toBe('boolean');
    expect(typeof deps.qdrant.healthy).toBe('boolean');
  });

  it('returns overall healthy boolean (true when all healthy)', async () => {
    const res = await api.get('/api/rag/status');

    // MongoDB readyState is 0 in test (not connected), so healthy = false
    expect(typeof res.body.data.healthy).toBe('boolean');
    expect(res.body.data.healthy).toBe(false); // mongo is disconnected in test
    expect(res.body.data.serviceReady).toBe(false);
    expect(res.body.data.queryReady).toBe(false);
    expect(res.body.data.status).toBe('red');
    expect(Number.isFinite(Date.parse(res.body.data.observedAt))).toBe(true);
  });

  it('does not preserve a green adapter status when end-to-end query readiness is false', async () => {
    mockVectorStore.getStats.mockResolvedValue({
      status: 'green',
      documentCount: 10,
      chunkCount: 50,
      vectorDimension: 768,
    });

    const res = await api.get('/api/rag/status');

    expect(res.body.data.healthy).toBe(false);
    expect(res.body.data.queryReady).toBe(false);
    expect(res.body.data.status).not.toBe('green');
  });

  it('preserves existing fields (documentCount, chunkCount, embeddingModel)', async () => {
    const res = await api.get('/api/rag/status');

    expect(res.body.data.documentCount).toBe(10);
    expect(res.body.data.chunkCount).toBe(50);
    expect(res.body.data.embeddingModel).toBe('nomic-embed-text:v1.5');
    expect(res.body.data.vectorStore).toBeDefined();
  });

  it('reports mongodb as unhealthy when disconnected', async () => {
    const res = await api.get('/api/rag/status');
    const mongo = res.body.data.dependencies.mongodb;

    // In test env, mongoose is not connected (readyState = 0)
    expect(mongo.healthy).toBe(false);
    expect(mongo.readyState).toBe(0);
  });

  it('reports embedding provider info', async () => {
    const res = await api.get('/api/rag/status');
    const emb = res.body.data.dependencies.embedding;

    expect(emb.healthy).toBe(true);
    expect(emb.provider).toBe('core-proxy');
    expect(emb.model).toBe('nomic-embed-text:v1.5');
    expect(emb).not.toHaveProperty('endpoint');
  });

  it('keeps GET observational when embedding evidence is stale', async () => {
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue({
      healthy: true,
      checkedAt: 1710000000000,
      stale: true,
    });

    const res = await api.get('/api/rag/status');

    expect(res.status).toBe(200);
    expect(res.body.data.dependencies.embedding.stale).toBe(true);
    expect(mockEmbeddingsService.refreshConnectionStatus).not.toHaveBeenCalled();
  });

  it('runs the embedding connection check only through POST refresh', async () => {
    const res = await api.post('/api/rag/status/refresh');

    expect(res.status).toBe(200);
    expect(mockEmbeddingsService.refreshConnectionStatus).toHaveBeenCalledTimes(1);
  });

  it('marks embedding unhealthy when the connection test returns false', async () => {
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue({
      healthy: false,
      checkedAt: 1710000000000,
      stale: false,
    });

    const res = await api.get('/api/rag/status');
    const emb = res.body.data.dependencies.embedding;

    expect(emb.healthy).toBe(false);
    expect(emb.error).toBe('Embedding connection test failed');
    expect(res.body.data.queryReady).toBe(false);
  });

  it('reports qdrant health from vectorStore healthCheck', async () => {
    const res = await api.get('/api/rag/status');
    const qdrant = res.body.data.dependencies.qdrant;

    expect(qdrant.healthy).toBe(true);
    expect(qdrant).not.toHaveProperty('url');
  });

  it('does not crash if getStats throws', async () => {
    mockVectorStore.getStats.mockRejectedValue(new Error('Qdrant down'));
    mockVectorStore.healthCheck.mockRejectedValue(new Error('Qdrant down'));

    const res = await api.get('/api/rag/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.dependencies).toBeDefined();
    expect(res.body.data.dependencies.qdrant.healthy).toBe(false);
  });
});

describe('GET /api/rag/metrics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVectorStore.getStats.mockResolvedValue({
      documentCount: 42,
      chunkCount: 310,
      vectorDimension: 768,
    });
    mockVectorStore.healthCheck.mockResolvedValue({ healthy: true, type: 'memory' });
    mockVectorStore.listDocuments.mockResolvedValue({
      documents: [
        { documentId: 'doc1', source: 'nas-scan', chunkCount: 100 },
        { documentId: 'doc2', source: 'nas-scan', chunkCount: 120 },
        { documentId: 'doc3', source: 'api', chunkCount: 90 },
      ],
      total: 3,
    });
  });

  it('returns totals with documents and chunks', async () => {
    RagManifest.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });

    const res = await api.get('/api/rag/metrics');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totals.documents).toBe(42);
    expect(res.body.data.totals.chunks).toBe(310);
  });

  it('returns bySource breakdown grouped correctly', async () => {
    RagManifest.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });

    const res = await api.get('/api/rag/metrics');

    expect(res.body.data.bySource).toHaveLength(2);

    const nasScan = res.body.data.bySource.find((s) => s.source === 'nas-scan');
    expect(nasScan.documents).toBe(2);
    expect(nasScan.chunks).toBe(220);

    const apiSource = res.body.data.bySource.find((s) => s.source === 'api');
    expect(apiSource.documents).toBe(1);
    expect(apiSource.chunks).toBe(90);
  });

  it('returns lastIngest from RagManifest', async () => {
    const fakeDate = new Date('2026-04-01T14:32:00Z');
    RagManifest.findOne.mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve({
            updatedAt: fakeDate,
            source: 'nas-scan',
          }),
      }),
    });

    const res = await api.get('/api/rag/metrics');

    expect(res.body.data.lastIngest).not.toBeNull();
    expect(res.body.data.lastIngest.timestamp).toBe(fakeDate.toISOString());
    expect(res.body.data.lastIngest.source).toBe('nas-scan');
  });

  it('returns lastIngest as null when no manifests exist', async () => {
    RagManifest.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });

    const res = await api.get('/api/rag/metrics');

    expect(res.body.data.lastIngest).toBeNull();
  });

  it('returns gracefully when listDocuments fails', async () => {
    mockVectorStore.listDocuments.mockRejectedValue(new Error('Store error'));
    RagManifest.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    });

    const res = await api.get('/api/rag/metrics');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.bySource).toEqual([]);
  });
});

// The observational contract, from the reader's side. A GET reports whatever
// evidence exists and never goes and gets some; the evidence itself is
// collected by the startup probe, an explicit refresh, or real embed traffic.
describe('GET /api/rag/status — embedding evidence contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVectorStore.getStats.mockResolvedValue({
      documentCount: 10,
      chunkCount: 50,
      vectorDimension: 768,
    });
    mockVectorStore.healthCheck.mockResolvedValue({
      healthy: true,
      type: 'qdrant',
      url: 'http://qdrant:6333',
    });
  });

  it('labels a real observation as active evidence', async () => {
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue({
      healthy: true,
      checkedAt: 1710000000000,
      stale: false,
    });

    const res = await api.get('/api/rag/status');
    const embedding = res.body.data.dependencies.embedding;

    expect(embedding.healthy).toBe(true);
    expect(embedding.evidence).toBe('active');
    expect(embedding.error).toBeUndefined();
  });

  it('still reports unhealthy when the observation says the connection failed', async () => {
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue({
      healthy: false,
      checkedAt: 1710000000000,
      stale: false,
    });

    const res = await api.get('/api/rag/status');
    const embedding = res.body.data.dependencies.embedding;

    // Holding evidence must never be confused with the evidence being good:
    // trading the old false negative for a false positive would be worse.
    expect(embedding.healthy).toBe(false);
    expect(embedding.evidence).toBe('active');
    expect(embedding.error).toBe('Embedding connection test failed');
    expect(res.body.data.queryReady).toBe(false);
  });

  it('reports unknown evidence, and never probes, when nothing has been collected', async () => {
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue(null);

    const res = await api.get('/api/rag/status');
    const embedding = res.body.data.dependencies.embedding;

    expect(embedding.evidence).toBe('unknown');
    expect(embedding.healthy).toBe(false);
    // The whole point of the GET: observational, no embedding inference.
    expect(mockEmbeddingsService.refreshConnectionStatus).not.toHaveBeenCalled();
  });

  it('refreshes on the operator-owned POST, which is the active path', async () => {
    mockEmbeddingsService.getCachedConnectionStatus.mockReturnValue({
      healthy: true,
      checkedAt: 1710000000000,
      stale: false,
    });

    await api.post('/api/rag/status/refresh');

    expect(mockEmbeddingsService.refreshConnectionStatus).toHaveBeenCalled();
  });
});

/**
 * Integration test — ingest, search, delete cycle using InMemoryVectorStore
 * with mocked embedding provider. No external services required.
 */

// Must mock before any require that touches these modules
jest.mock('mongoose', () => {
  function FakeSchema() {
    // Schema instances need index() for compound index declarations
    this.index = jest.fn().mockReturnThis();
  }
  return {
    connection: { readyState: 0 },
    connect: jest.fn(),
    Schema: FakeSchema,
    model: jest.fn(() => ({ create: jest.fn().mockResolvedValue({}) })),
  };
});

const supertest = require('supertest');
const { resetRagStore, RagStore } = require('../../src/services/ragStore');
const { resetEmbeddingsService } = require('../../src/services/embeddings');

// A fixed embedding vector to return for all texts
const DIMENSION = 8;
const FIXED_EMBEDDING = Array.from({ length: DIMENSION }, (_, i) => (i + 1) / DIMENSION);

let app;
let ragStoreInstance;

beforeAll(() => {
  // Reset singletons before setting up
  resetRagStore();
  resetEmbeddingsService();

  // Set env so factory picks in-memory store
  process.env.VECTOR_STORE_TYPE = 'memory';

  // Create a RagStore with in-memory vector store
  ragStoreInstance = new RagStore({ type: 'memory' });

  // Replace the embeddings service with a mock that returns fixed vectors
  ragStoreInstance.embeddingsService = {
    model: 'mock-embed',
    embedBatch: jest.fn(async (texts) => texts.map(() => [...FIXED_EMBEDDING])),
    getDimension: () => DIMENSION,
  };

  // Monkey-patch getRagStore so routes use our prepared instance
  const ragStoreModule = require('../../src/services/ragStore');
  ragStoreModule.getRagStore = () => ragStoreInstance;

  // Now require app (after mocks are in place)
  app = require('../../app');
});

afterAll(() => {
  resetRagStore();
  resetEmbeddingsService();
});

describe('Integration: ingest → search → delete cycle', () => {
  const testText = 'The quick brown fox jumps over the lazy dog. ' +
    'This is an important document about foxes and dogs. ' +
    'It contains several sentences for chunking.';
  let documentId;

  it('ingests a document via POST /api/rag/ingest', async () => {
    const res = await supertest(app)
      .post('/api/rag/ingest')
      .send({
        text: testText,
        source: 'integration-test',
        tags: ['fox', 'dog'],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentId).toBeDefined();
    expect(res.body.data.chunkCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.status).toBe('created');

    documentId = res.body.data.documentId;
  });

  it('finds the document via POST /api/rag/search', async () => {
    const res = await supertest(app)
      .post('/api/rag/search')
      .send({ query: 'fox and dog', topK: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.results.length).toBeGreaterThanOrEqual(1);

    // All chunks share the same fixed embedding, so cosine similarity should be 1.0
    const topResult = res.body.data.results[0];
    expect(topResult.score).toBeCloseTo(1.0);
    expect(topResult.text).toBeDefined();
    expect(topResult.metadata).toBeDefined();
    expect(topResult.metadata.source).toBe('integration-test');
  });

  it('lists the document via GET /api/rag/documents', async () => {
    const res = await supertest(app)
      .get('/api/rag/documents')
      .query({ source: 'integration-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.documents[0].documentId).toBe(documentId);
  });

  it('deletes the document via DELETE /api/rag/documents/:id', async () => {
    const res = await supertest(app)
      .delete(`/api/rag/documents/${documentId}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentId).toBe(documentId);
  });

  it('search returns no results after deletion', async () => {
    const res = await supertest(app)
      .post('/api/rag/search')
      .send({ query: 'fox and dog', topK: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.results).toHaveLength(0);
  });
});

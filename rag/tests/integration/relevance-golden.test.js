/**
 * Integration test — golden relevance dataset using InMemoryVectorStore
 * with deterministic topic embeddings.
 */

jest.mock('mongoose', () => {
  function FakeSchema() {
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

const FEATURE_GROUPS = [
  ['qdrant', 'vector', 'embedding', 'embeddings', 'retrieval', 'search', 'chunk', 'chunks', 'index', 'store', 'stored'],
  ['gpu', 'rtx', 'inference', 'ollama', 'vram', 'model', 'models', 'local'],
  ['alert', 'alerts', 'threshold', 'thresholds', 'notification', 'notifications', 'metric', 'metrics', 'monitor', 'monitoring'],
  ['ingest', 'ingestion', 'scan', 'scanner', 'nas', 'document', 'documents', 'file', 'files', 'indexed'],
];

const GOLDEN_DOCUMENTS = [
  {
    documentId: 'doc-storage',
    source: 'golden-kb',
    tags: ['storage'],
    text: 'Qdrant stores vector embeddings and chunk metadata so retrieval and semantic search can find the right context quickly.'
  },
  {
    documentId: 'doc-inference',
    source: 'golden-kb',
    tags: ['inference'],
    text: 'Local model inference runs on the RTX GPU through Ollama, using available VRAM to serve models efficiently.'
  },
  {
    documentId: 'doc-alerting',
    source: 'golden-kb',
    tags: ['alerting'],
    text: 'The alert system monitors metrics and sends notifications when thresholds are exceeded by hosts or services.'
  },
  {
    documentId: 'doc-ingestion',
    source: 'golden-kb',
    tags: ['ingestion'],
    text: 'A NAS scan finds files and documents, then ingestion indexes them so they are searchable later.'
  }
];

function embedText(text) {
  const normalized = String(text || '').toLowerCase();
  return FEATURE_GROUPS.map((terms) => terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0));
}

let app;
let ragStoreInstance;

beforeAll(async () => {
  resetRagStore();
  resetEmbeddingsService();

  process.env.VECTOR_STORE_TYPE = 'memory';

  ragStoreInstance = new RagStore({ type: 'memory' });
  ragStoreInstance.embeddingsService = {
    model: 'golden-topic-embed',
    embedBatch: jest.fn(async (texts) => texts.map((text) => embedText(text))),
  };

  const ragStoreModule = require('../../src/services/ragStore');
  ragStoreModule.getRagStore = () => ragStoreInstance;

  app = require('../../app');

  for (const doc of GOLDEN_DOCUMENTS) {
    const response = await supertest(app)
      .post('/api/rag/ingest')
      .send(doc);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.documentId).toBe(doc.documentId);
  }
});

afterAll(() => {
  resetRagStore();
  resetEmbeddingsService();
});

describe('Integration: golden relevance dataset', () => {
  test('loads the full golden dataset', async () => {
    const response = await supertest(app)
      .get('/api/rag/documents')
      .query({ source: 'golden-kb' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.total).toBe(GOLDEN_DOCUMENTS.length);
  });

  test.each([
    ['Where are embeddings stored for retrieval?', 'doc-storage'],
    ['What hardware runs local model inference?', 'doc-inference'],
    ['How do alerts trigger from metrics thresholds?', 'doc-alerting'],
    ['How are NAS files ingested into the index?', 'doc-ingestion'],
  ])('returns %s with %s at rank 1', async (query, expectedDocumentId) => {
    const response = await supertest(app)
      .post('/api/rag/search')
      .send({ query, topK: 3, minScore: 0.2 });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.count).toBeGreaterThanOrEqual(1);
    expect(response.body.data.results[0].metadata.documentId).toBe(expectedDocumentId);
  });

  test('supports filter-based relevance checks', async () => {
    const response = await supertest(app)
      .post('/api/rag/search')
      .send({
        query: 'Which component stores vector embeddings?',
        topK: 3,
        minScore: 0.2,
        filters: { tags: ['storage'] }
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.results).toHaveLength(1);
    expect(response.body.data.results[0].metadata.documentId).toBe('doc-storage');
  });

  test('returns no matches for unrelated queries above the score threshold', async () => {
    const response = await supertest(app)
      .post('/api/rag/search')
      .send({ query: 'banana hammock saxophone', topK: 3, minScore: 0.2 });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.results).toHaveLength(0);
  });
});
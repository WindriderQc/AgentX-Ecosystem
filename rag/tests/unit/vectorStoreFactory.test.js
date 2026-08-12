jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { createVectorStore } = require('../../src/services/vectorStore/factory');
const InMemoryVectorStore = require('../../src/services/vectorStore/InMemoryVectorStore');
const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');

describe('createVectorStore', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VECTOR_STORE_TYPE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('creates InMemoryVectorStore when type is "memory"', () => {
    const store = createVectorStore({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryVectorStore);
  });

  it('creates QdrantVectorStore when type is "qdrant"', () => {
    const store = createVectorStore({ type: 'qdrant' });
    expect(store).toBeInstanceOf(QdrantVectorStore);
  });

  it('reads type from VECTOR_STORE_TYPE env when not in config', () => {
    process.env.VECTOR_STORE_TYPE = 'qdrant';
    const store = createVectorStore();
    expect(store).toBeInstanceOf(QdrantVectorStore);
  });

  it('defaults to InMemoryVectorStore for any non-qdrant type', () => {
    const store = createVectorStore({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryVectorStore);
  });

  it('throws when no type is configured at all', () => {
    expect(() => createVectorStore()).toThrow('VECTOR_STORE_TYPE is not set');
  });

  it('passes config through to the created store', () => {
    const store = createVectorStore({
      type: 'qdrant',
      qdrantUrl: 'http://custom:6333',
      collectionName: 'my_coll',
    });
    expect(store.qdrantUrl).toBe('http://custom:6333');
    expect(store.collectionName).toBe('my_coll');
  });
});

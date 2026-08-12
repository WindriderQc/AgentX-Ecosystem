// Test utilities for mocking Ollama responses
const mockOllamaResponse = (content, model = 'llama3.2') => ({
  message: {
    role: 'assistant',
    content: content
  },
  model: model,
  created_at: new Date().toISOString(),
  done: true
});

const mockOllamaStreamChunk = (content, done = false) => ({
  message: {
    content: content
  },
  done: done
});

const mockEmbeddingResponse = (text) => {
  // Generate deterministic embeddings based on text length
  const dimension = 384; // nomic-embed-text dimension
  const embedding = new Array(dimension).fill(0).map((_, i) => {
    return Math.sin(text.length * i * 0.01);
  });

  return {
    embedding: embedding,
    model: 'nomic-embed-text'
  };
};

// Helper to create test documents
const createTestDocument = (overrides = {}) => ({
  id: `doc-${Date.now()}-${Math.random()}`,
  vector: [0.1, 0.2, 0.3, 0.4, 0.5],
  content: 'Test document content',
  metadata: {
    source: 'test',
    timestamp: Date.now(),
    ...overrides.metadata
  },
  ...overrides
});

// Helper to create mock MongoDB document
const createMockMongoDocument = (data) => ({
  ...data,
  _id: data._id || `mongo-${Date.now()}`,
  save: jest.fn().mockResolvedValue(data),
  toObject: jest.fn().mockReturnValue(data)
});

module.exports = {
  mockOllamaResponse,
  mockOllamaStreamChunk,
  mockEmbeddingResponse,
  createTestDocument,
  createMockMongoDocument
};

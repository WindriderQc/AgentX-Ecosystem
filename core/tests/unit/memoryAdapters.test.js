'use strict';

const mockRagClient = {
  searchSimilarChunks: jest.fn(),
  getStatus: jest.fn(),
};

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => mockRagClient,
}));

const {
  getEcosystemMemoryAlignmentStatus,
  searchMemory,
  searchSingle,
  statusForSource,
} = require('../../src/services/memoryAdapters');

describe('memoryAdapters product boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns no results for missing sources or query', async () => {
    await expect(searchMemory({ sources: [], query: 'fact' })).resolves.toEqual([]);
    await expect(searchMemory({ sources: ['rag'], query: '' })).resolves.toEqual([]);
  });

  test('delegates bounded RAG search to the product RAG client', async () => {
    mockRagClient.searchSimilarChunks.mockResolvedValue([{ text: 'Agent X fact', score: 0.9 }]);
    await expect(searchSingle('rag', 'fact', 3)).resolves.toEqual([
      { text: 'Agent X fact', score: 0.9 },
    ]);
    expect(mockRagClient.searchSimilarChunks).toHaveBeenCalledWith('fact', { topK: 3 });
  });

  test('unknown sources fail closed', async () => {
    await expect(searchSingle('external-runtime', 'fact', 3)).resolves.toEqual([]);
    await expect(statusForSource('external-runtime')).resolves.toEqual({
      source: 'external-runtime', available: false, error: 'unknown source',
    });
  });

  test('alignment status names only Agent X Core and RAG lanes', async () => {
    mockRagClient.getStatus.mockResolvedValue({ healthy: true, documents: 2 });
    const status = await getEcosystemMemoryAlignmentStatus();
    expect(status.policy).toEqual({
      localMemoryLane: 'agentx',
      sharedMemoryLane: 'agentx-rag',
      externalRuntimeMemories: 'outside-product-boundary',
    });
    expect(status.shared.rag).toEqual(expect.objectContaining({
      source: 'agentx-rag', available: true,
    }));
  });
});

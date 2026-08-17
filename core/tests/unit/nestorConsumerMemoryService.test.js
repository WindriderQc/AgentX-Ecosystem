'use strict';

const mockStatusForSource = jest.fn();
const mockSearchSingle = jest.fn();
const mockGetRagStatus = jest.fn();
const mockSearchRag = jest.fn();

jest.mock('../../src/services/memoryAdapters', () => ({
  statusForSource: (...args) => mockStatusForSource(...args),
  searchSingle: (...args) => mockSearchSingle(...args),
}));

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    getStatus: (...args) => mockGetRagStatus(...args),
    searchSimilarChunks: (...args) => mockSearchRag(...args),
  }),
}));

const {
  getMemoryStatus,
  searchMemory,
} = require('../../src/services/nestorConsumerMemoryService');

describe('Nestor consumer memory adapters', () => {
  beforeEach(() => jest.clearAllMocks());

  it('searches the product-owned Core and RAG sources', async () => {
    mockSearchSingle.mockImplementation(async (source) => (
      [{ source, text: `${source} result`, score: 0.8, ref: `${source}:1` }]
    ));
    mockSearchRag.mockResolvedValue([{ text: 'rag result', score: 0.9, metadata: { documentId: 'doc-1' } }]);

    const result = await searchMemory({
      sources: ['agentx', 'rag'],
      query: 'routing contract',
      k: 5,
    });

    expect(result.bySource.agentx).toHaveLength(1);
    expect(result.bySource.rag[0]).toEqual(expect.objectContaining({ source: 'rag', ref: 'doc-1' }));
    expect(result.warnings).toEqual([]);
  });

  it('rejects unknown sources and oversized queries', async () => {
    await expect(searchMemory({ source: 'unknown', query: 'x' }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNKNOWN_MEMORY_SOURCE' }));
    await expect(searchMemory({ source: 'agentx', query: 'x'.repeat(2001) }))
      .rejects.toEqual(expect.objectContaining({ code: 'MEMORY_QUERY_TOO_LARGE' }));
  });

  it('returns fail-soft status for every requested source', async () => {
    mockStatusForSource.mockImplementation(async (source) => {
      if (source === 'agentx') throw new Error('offline');
      return { source, available: true };
    });
    mockGetRagStatus.mockResolvedValue({ healthy: true, documentCount: 4 });
    const result = await getMemoryStatus(['agentx', 'rag']);
    expect(result.sources.rag.available).toBe(true);
    expect(result.sources.agentx.available).toBe(false);
    expect(result.warnings[0]).toEqual(expect.objectContaining({ source: 'agentx' }));
  });
});

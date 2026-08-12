const { expandQuery } = require('../../src/services/queryExpansion');

// Mock fetchWithTimeout before requiring the module
jest.mock('../../src/utils/fetchWithTimeout');
const fetchWithTimeout = require('../../src/utils/fetchWithTimeout');

// Suppress logger output during tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));
const logger = require('../../config/logger');

describe('queryExpansion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OLLAMA_HOSTS;
    delete process.env.OLLAMA_HOST;
  });

  describe('expandQuery', () => {
    it('should generate related queries from LLM response', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: 'python list comprehension\npython loops\n'
        })
      });

      const queries = await expandQuery('python iteration');
      expect(queries).toEqual(['python list comprehension', 'python loops']);
      expect(fetchWithTimeout).toHaveBeenCalledWith(
        expect.stringContaining('/api/inference/generate'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }),
        expect.any(Number)
      );

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.taskType).toBe('rag_query_expansion');
      expect(callBody.model).toBeUndefined();
    });

    it('should handle API failure gracefully', async () => {
      fetchWithTimeout.mockResolvedValue({ ok: false });
      const queries = await expandQuery('fail');
      expect(queries).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expansion failed'));
    });

    it('should fallback on fetch exception', async () => {
      fetchWithTimeout.mockRejectedValue(new Error('Net error'));
      const queries = await expandQuery('error');
      expect(queries).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('expansion error'),
        expect.objectContaining({ error: 'Net error' })
      );
    });

    it('should strip numbered items from response', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: '1. numbered query\n2) another numbered\nclean query\nalso clean\n'
        })
      });

      const queries = await expandQuery('test');
      expect(queries).toEqual(['clean query', 'also clean']);
    });

    it('should limit results to 3 max', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: 'q1\nq2\nq3\nq4\nq5\n'
        })
      });

      const queries = await expandQuery('test');
      expect(queries.length).toBeLessThanOrEqual(3);
    });

    it('should filter out empty lines and overly long lines', async () => {
      const longLine = 'x'.repeat(201);
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: `\n\nvalid query\n${longLine}\n\n`
        })
      });

      const queries = await expandQuery('test');
      expect(queries).toEqual(['valid query']);
    });

    it('should return empty array when response has no content', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '' })
      });

      const queries = await expandQuery('test');
      expect(queries).toEqual([]);
    });
  });
});

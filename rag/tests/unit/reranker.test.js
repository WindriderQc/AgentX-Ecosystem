const { rerankResults, buildScoringPrompt, parseScore } = require('../../src/services/reranker');

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

describe('reranker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OLLAMA_HOSTS;
    delete process.env.OLLAMA_HOST;
  });

  describe('buildScoringPrompt', () => {
    it('includes query and truncated text', () => {
      const prompt = buildScoringPrompt('test query', 'some text content');
      expect(prompt).toContain('test query');
      expect(prompt).toContain('some text content');
      expect(prompt).toContain('0 to 10');
    });

    it('truncates text to 500 characters', () => {
      const longText = 'a'.repeat(1000);
      const prompt = buildScoringPrompt('q', longText);
      // The prompt should contain at most 500 chars of the text
      expect(prompt).not.toContain('a'.repeat(501));
    });
  });

  describe('parseScore', () => {
    it('extracts integer score and normalizes to 0-1', () => {
      expect(parseScore('8', 0.5)).toBeCloseTo(0.8);
    });

    it('extracts decimal score', () => {
      expect(parseScore('7.5', 0.5)).toBeCloseTo(0.75);
    });

    it('caps score at 10', () => {
      expect(parseScore('15', 0.5)).toBeCloseTo(1.0);
    });

    it('returns fallback on empty response', () => {
      expect(parseScore('', 0.42)).toBeCloseTo(0.42);
    });

    it('returns fallback on non-numeric response', () => {
      expect(parseScore('not a number', 0.3)).toBeCloseTo(0.3);
    });

    it('extracts number from text with extra content', () => {
      expect(parseScore('Score: 9', 0.5)).toBeCloseTo(0.9);
    });

    it('handles null/undefined', () => {
      expect(parseScore(null, 0.5)).toBeCloseTo(0.5);
      expect(parseScore(undefined, 0.5)).toBeCloseTo(0.5);
    });
  });

  describe('rerankResults', () => {
    const mockResults = [
      { text: 'irrelevant text here', score: 0.9, metadata: { documentId: 'doc1', chunkIndex: 0 } },
      { text: 'highly relevant text', score: 0.5, metadata: { documentId: 'doc2', chunkIndex: 0 } }
    ];

    it('should return empty array for empty/null input', async () => {
      expect(await rerankResults('query', [])).toEqual([]);
      expect(await rerankResults('query', null)).toEqual([]);
    });

    it('should reorder results based on LLM judge score', async () => {
      fetchWithTimeout.mockImplementation(async (url, options) => {
        const body = JSON.parse(options.body);
        const prompt = body.prompt || '';
        if (prompt.includes('highly relevant')) {
          return { ok: true, json: () => Promise.resolve({ response: '10' }) };
        }
        return { ok: true, json: () => Promise.resolve({ response: '0' }) };
      });

      const reranked = await rerankResults('query', mockResults, 2);

      expect(reranked[0].text).toBe('highly relevant text');
      expect(reranked[0].llmScore).toBe(1.0); // 10/10
      expect(reranked[0].vectorScore).toBe(0.5); // original score preserved

      expect(reranked[1].text).toBe('irrelevant text here');
      expect(reranked[1].llmScore).toBe(0.0);
      expect(reranked[1].vectorScore).toBe(0.9); // original score preserved
    });

    it('should fallback to vector score on fetch error', async () => {
      fetchWithTimeout.mockRejectedValue(new Error('Judge down'));
      const results = await rerankResults('query', mockResults, 5);

      // Should still return results (fallback path)
      expect(results).toHaveLength(2);
      // Order preserved from original (both have llmScore = original score)
      expect(results[0].text).toBe('irrelevant text here');
    });

    it('should fallback individual result on non-ok response', async () => {
      let callCount = 0;
      fetchWithTimeout.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 500 };
        }
        return { ok: true, json: () => Promise.resolve({ response: '8' }) };
      });

      const results = await rerankResults('query', mockResults, 2);
      expect(results).toHaveLength(2);
      // The one that succeeded (score 8/10 = 0.8) should be first
      // The one that failed falls back to its original score (0.9 or 0.5)
    });

    it('should route reranking through the core task router', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '5' })
      });

      await rerankResults('test', [{ text: 'hello', score: 0.5 }], 1);

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.taskType).toBe('rag_reranking');
      expect(callBody.model).toBeUndefined();
    });

    it('should score all results in parallel', async () => {
      const threeResults = [
        { text: 'result 1', score: 0.3 },
        { text: 'result 2', score: 0.6 },
        { text: 'result 3', score: 0.9 }
      ];

      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '7' })
      });

      await rerankResults('query', threeResults, 3);

      // All three should be scored in parallel (3 fetch calls)
      expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    });

    it('should respect topK limit', async () => {
      const manyResults = Array.from({ length: 10 }, (_, i) => ({
        text: `result ${i}`,
        score: (10 - i) / 10
      }));

      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '5' })
      });

      const reranked = await rerankResults('query', manyResults, 3);
      expect(reranked).toHaveLength(3);
    });

    it('should log re-ranking summary', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '7' })
      });

      await rerankResults('test query', [{ text: 'a', score: 0.5 }], 1);

      expect(logger.info).toHaveBeenCalledWith('Results re-ranked', expect.objectContaining({
        originalCount: 1,
        rerankedCount: 1
      }));
    });

    it('should use low temperature for consistent scoring', async () => {
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '5' })
      });

      await rerankResults('test', [{ text: 'hello', score: 0.5 }], 1);

      const callBody = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
      expect(callBody.options.temperature).toBe(0.1);
      expect(callBody.options.num_predict).toBe(10);
    });
  });
});

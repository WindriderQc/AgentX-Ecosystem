jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

const { BenchmarkServiceClient } = require('../../src/services/benchmarkServiceClient');

describe('BenchmarkServiceClient', () => {
  let client;

  beforeEach(() => {
    client = new BenchmarkServiceClient();
    mockFetch.mockReset();
  });

  describe('Benchmark-owned evidence', () => {
    it('reads host and model evidence through the profiler contract', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          status: 'success',
          data: {
            hostProfile: { hostId: 'host-a' },
            modelProfile: { name: 'owner/model:8b', readiness: {} }
          }
        })
      });

      await expect(client.getInferenceEvidence('owner/model:8b', 'http://host-a:11434'))
        .resolves.toMatchObject({
          hostProfile: { hostId: 'host-a' },
          modelProfile: { name: 'owner/model:8b' }
        });
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/api/profiler/evidence/inference/owner%2Fmodel%3A8b');
      expect(url.searchParams.get('hostUrl')).toBe('http://host-a:11434');
    });

    it('reads the compact readiness roster and exact context evidence', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            status: 'success',
            data: { profiles: [{ name: 'model-a', readiness: { primary: { stage: 'profiled' } } }] }
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            status: 'success',
            data: { contextProfile: { verifiedMaxContext: 32768 } }
          })
        });

      await expect(client.getReadinessProfiles()).resolves.toHaveLength(1);
      await expect(client.getContextProfile('model-a', {
        hostUrl: 'http://host-a:11434',
        artifactDigest: 'sha256:a',
        runtimeFingerprint: 'runtime-a'
      })).resolves.toMatchObject({ verifiedMaxContext: 32768 });
    });

    it('degrades evidence reads to null or an empty roster when Benchmark is offline', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));

      await expect(client.getHostProfile('http://host-a:11434')).resolves.toBeNull();
      await expect(client.getReadinessProfiles()).resolves.toEqual([]);
    });
  });

  describe('getRecommendations', () => {
    it('should return recommendations for a valid category', async () => {
      const mockRecs = [
        { model: 'qwen3:14b', host: 'http://192.0.2.12:11434', quality_score: 8.4, result_count: 24, confidence: 'high' },
        { model: 'llama3.1:8b', host: 'http://192.0.2.66:11434', quality_score: 7.1, result_count: 8, confidence: 'medium' }
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'coding', recommendations: mockRecs } })
      });

      const result = await client.getRecommendations('coding');

      expect(result).toHaveLength(2);
      expect(result[0].model).toBe('qwen3:14b');
      expect(result[0].quality_score).toBe(8.4);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/benchmark/recommend?category=coding');
    });

    it('should return empty array for empty category', async () => {
      const result = await client.getRecommendations('');
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should cache results and not re-fetch within TTL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'coding', recommendations: [{ model: 'a' }] } })
      });

      const first = await client.getRecommendations('coding');
      const second = await client.getRecommendations('coding');

      expect(first).toEqual(second);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should bypass cache when skipCache is true', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'coding', recommendations: [{ model: 'a' }] } })
      });

      await client.getRecommendations('coding');
      await client.getRecommendations('coding', { skipCache: true });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return stale cache when benchmark is unreachable', async () => {
      // Seed cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'math', recommendations: [{ model: 'cached' }] } })
      });
      await client.getRecommendations('math', { skipCache: true });

      // Now simulate network failure
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await client.getRecommendations('math', { skipCache: true });

      expect(result).toHaveLength(1);
      expect(result[0].model).toBe('cached');
    });

    it('should return empty array when benchmark is unreachable and no cache', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.getRecommendations('coding');
      expect(result).toEqual([]);
    });

    it('should return stale cache on non-200 response', async () => {
      // Seed cache first
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'coding', recommendations: [{ model: 'stale' }] } })
      });
      await client.getRecommendations('coding', { skipCache: true });

      // Simulate 500 error
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const result = await client.getRecommendations('coding', { skipCache: true });

      expect(result).toHaveLength(1);
      expect(result[0].model).toBe('stale');
    });

    it('should pass host and min_quality params', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'coding', recommendations: [] } })
      });

      await client.getRecommendations('coding', { host: '192.0.2.66', min_quality: 7.5 });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('host=192.0.2.66');
      expect(url).toContain('min_quality=7.5');
    });
  });

  describe('getAllCategoryRecommendations', () => {
    it('should fetch all 7 categories', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { recommendations: [{ model: 'test' }] } })
      });

      const result = await client.getAllCategoryRecommendations();

      expect(Object.keys(result)).toHaveLength(7);
      expect(result.coding).toHaveLength(1);
      expect(result.reasoning).toHaveLength(1);
      expect(result.translation).toHaveLength(1);
    });

    it('should return empty arrays for failed categories', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));

      const result = await client.getAllCategoryRecommendations();

      expect(Object.keys(result)).toHaveLength(7);
      expect(result.coding).toEqual([]);
    });
  });

  describe('getJudgeDrift', () => {
    it('returns the drift payload when benchmark responds OK', async () => {
      const mockPayload = {
        computed_at: '2026-04-22T00:00:00.000Z',
        overall_status: 'ok',
        baseline_label: 'v1-2026Q1',
        thresholds: { drop_pp: 0.15, absolute_floor: 0.5, min_sample_size: 5 },
        categories: [
          { category: 'coding', current_rho: 0.82, baseline_rho: 0.80, drop_pp: -0.02, sample_size: 30, status: 'ok', reasons: [], triggered: false },
          { category: 'reasoning', current_rho: 0.41, baseline_rho: 0.72, drop_pp: 0.31, sample_size: 30, status: 'alert', reasons: ['drop_15pp', 'absolute_floor'], triggered: true }
        ]
      };

      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ status: 'success', data: mockPayload })
      });

      const result = await client.getJudgeDrift();

      expect(result).toEqual(mockPayload);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/benchmark/drift');
    });

    it('passes perCategory as query when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ status: 'success', data: { overall_status: 'ok', categories: [] } })
      });

      await client.getJudgeDrift({ perCategory: 50 });

      expect(mockFetch.mock.calls[0][0]).toContain('per_category=50');
    });

    it('returns null when benchmark is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.getJudgeDrift();
      expect(result).toBeNull();
    });

    it('returns null on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ status: 'error', error: 'boom' })
      });

      const result = await client.getJudgeDrift();
      expect(result).toBeNull();
    });

    it('returns null when envelope has no data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ status: 'success' })
      });

      const result = await client.getJudgeDrift();
      expect(result).toBeNull();
    });
  });

  describe('getBatch', () => {
    it('returns a batch payload by id', async () => {
      const batch = { _id: 'batch-1', status: 'completed', judge_status: 'completed' };
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ status: 'success', data: batch })
      });

      const result = await client.getBatch('batch-1');

      expect(result).toEqual(batch);
      expect(mockFetch.mock.calls[0][0]).toContain('/api/benchmark/batch/batch-1');
    });

    it('returns null for missing batch id', async () => {
      const result = await client.getBatch('');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null when the batch lookup fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ status: 'error', message: 'not found' })
      });

      const result = await client.getBatch('missing');
      expect(result).toBeNull();
    });
  });

  describe('Planning metric reads', () => {
    it('lists the newest batch for an exact Planning tag', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          status: 'success',
          data: { batches: [{ _id: 'batch-1' }], total: 1 }
        })
      });

      const result = await client.getBatches({
        tag: 'planning:agentx:benchmark-capability',
        limit: 1
      });

      expect(result.batches[0]._id).toBe('batch-1');
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/api/benchmark/batches');
      expect(url.searchParams.get('tag')).toBe('planning:agentx:benchmark-capability');
      expect(url.searchParams.get('limit')).toBe('1');
    });

    it('returns null when the batch list is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.getBatches({ tag: 'planning:test' })).resolves.toBeNull();
    });

    it('requests the trusted composite leaderboard', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({
          status: 'success',
          data: { trusted: true, trustScope: 'trusted', leaderboard: [] }
        })
      });

      const result = await client.getTrustedGeneralistLeaderboard({ hostScope: 'primary' });

      expect(result.trusted).toBe(true);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/api/benchmark/generalist-leaderboard');
      expect(url.searchParams.get('axis')).toBe('composite');
      expect(url.searchParams.get('trustScope')).toBe('trusted');
      expect(url.searchParams.get('hostScope')).toBe('primary');
    });

    it('returns null when the trusted leaderboard is unavailable', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => '' });

      await expect(client.getTrustedGeneralistLeaderboard()).resolves.toBeNull();
    });
  });

  describe('clearCache', () => {
    it('should clear internal cache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: { category: 'coding', recommendations: [{ model: 'a' }] } })
      });

      await client.getRecommendations('coding');
      client.clearCache();
      await client.getRecommendations('coding');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

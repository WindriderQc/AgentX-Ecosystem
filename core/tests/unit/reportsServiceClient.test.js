jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

const {
  ReportsServiceClient,
  ReportsServiceClientError,
  getReportsServiceClient
} = require('../../src/services/reportsServiceClient');

// Restore a saved env var correctly: `process.env.X = undefined` coerces to the
// string 'undefined' and leaks across tests. Delete when orig was undefined.
const restoreEnv = (key, orig) => {
  if (orig === undefined) delete process.env[key];
  else process.env[key] = orig;
};

describe('ReportsServiceClientError', () => {
  it('should carry status and code', () => {
    const err = new ReportsServiceClientError('something went wrong', { status: 503, code: 'SERVICE_DOWN' });
    expect(err.message).toBe('something went wrong');
    expect(err.status).toBe(503);
    expect(err.code).toBe('SERVICE_DOWN');
    expect(err.name).toBe('ReportsServiceClientError');
  });

  it('should have defaults for status and code', () => {
    const err = new ReportsServiceClientError('oops');
    expect(err.status).toBe(500);
    expect(err.code).toBe('REPORTS_SERVICE_ERROR');
  });
});

describe('ReportsServiceClient', () => {
  let client;

  beforeEach(() => {
    client = new ReportsServiceClient();
    mockFetch.mockReset();
  });

  describe('fetchBenchmarkAnalyticsSummary', () => {
    it('should call localhost:3081/api/benchmark/summary and return data', async () => {
      const mockData = { totalRuns: 42, avgScore: 7.8 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: mockData })
      });

      const result = await client.fetchBenchmarkAnalyticsSummary();

      expect(result).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('localhost:3081');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/benchmark/summary');
    });

    it('should return null when service is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.fetchBenchmarkAnalyticsSummary();
      expect(result).toBeNull();
    });

    it('should return null when response is not JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('invalid json'); }
      });

      const result = await client.fetchBenchmarkAnalyticsSummary();
      expect(result).toBeNull();
    });

    it('should return null on non-200 response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await client.fetchBenchmarkAnalyticsSummary();
      expect(result).toBeNull();
    });

    it('should unwrap {status:success, data:{...}} envelope', async () => {
      const innerData = { runs: 10 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: innerData })
      });

      const result = await client.fetchBenchmarkAnalyticsSummary();
      expect(result).toEqual(innerData);
    });

    it('should unwrap {ok:true, data:{...}} envelope', async () => {
      const innerData = { healthy: true };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, data: innerData })
      });

      const result = await client.fetchBenchmarkAnalyticsSummary();
      expect(result).toEqual(innerData);
    });

    it('should return raw payload when no envelope', async () => {
      const rawPayload = { runs: 10 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => rawPayload
      });

      const result = await client.fetchBenchmarkAnalyticsSummary();
      expect(result).toEqual(rawPayload);
    });

    it('should respect BENCHMARK_SERVICE_URL env var', async () => {
      const orig = process.env.BENCHMARK_SERVICE_URL;
      process.env.BENCHMARK_SERVICE_URL = 'http://custom-bench:3081';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: {} })
      });

      await client.fetchBenchmarkAnalyticsSummary();

      expect(mockFetch.mock.calls[0][0]).toContain('http://custom-bench:3081');
      restoreEnv('BENCHMARK_SERVICE_URL', orig);
    });
  });

  describe('fetchRagStatus', () => {
    it('should call localhost:3082/api/rag/status and return data', async () => {
      const mockData = { status: 'ok', documentsIndexed: 120 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'success', data: mockData })
      });

      const result = await client.fetchRagStatus();

      expect(result).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('localhost:3082');
      expect(mockFetch.mock.calls[0][0]).toContain('/api/rag/status');
    });

    it('should return null when RAG service is unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.fetchRagStatus();
      expect(result).toBeNull();
    });

    it('should respect RAG_SERVICE_URL env var', async () => {
      const orig = process.env.RAG_SERVICE_URL;
      process.env.RAG_SERVICE_URL = 'http://custom-rag:3082';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: {} })
      });

      await client.fetchRagStatus();

      expect(mockFetch.mock.calls[0][0]).toContain('http://custom-rag:3082');
      restoreEnv('RAG_SERVICE_URL', orig);
    });
  });

  describe('other fetch methods — graceful null on failure', () => {
    it('fetchBenchmarkTrends returns null on ECONNREFUSED', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await client.fetchBenchmarkTrends()).toBeNull();
    });

    it('fetchBenchmarkLeaderboard returns null on ECONNREFUSED', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await client.fetchBenchmarkLeaderboard({ trustScope: 'trusted' })).toBeNull();
    });

    it('fetchBenchmarkLeaderboard calls correct URL', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ([]) });
      await client.fetchBenchmarkLeaderboard({ trustScope: 'trusted' });
      expect(mockFetch.mock.calls[0][0]).toContain('/api/benchmark/generalist-leaderboard');
      expect(mockFetch.mock.calls[0][0]).toContain('trustScope=trusted');
    });

    it('fetchBenchmarkRecommendations keeps every failed category explicitly unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await client.fetchBenchmarkRecommendations({ trustScope: 'trusted' });
      expect(result.trustScope).toBe('trusted');
      expect(result.recommendations).toEqual([]);
      expect(result.categories.coding).toBeNull();
    });

    it('requires report consumers to choose a trust scope', async () => {
      await expect(client.fetchBenchmarkLeaderboard()).rejects.toMatchObject({
        code: 'TRUST_SCOPE_REQUIRED'
      });
      await expect(client.fetchBenchmarkRecommendations()).rejects.toMatchObject({
        code: 'TRUST_SCOPE_REQUIRED'
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetchProfilerDashboard returns null on ECONNREFUSED', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await client.fetchProfilerDashboard()).toBeNull();
    });

    it('fetchProfilerDashboard calls correct URL', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
      await client.fetchProfilerDashboard();
      expect(mockFetch.mock.calls[0][0]).toContain('/api/profiler/dashboard');
      expect(mockFetch.mock.calls[0][0]).not.toContain('/api/benchmark/profiler');
    });

    it('fetchRagMetrics returns null on ECONNREFUSED', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await client.fetchRagMetrics()).toBeNull();
    });
  });

  describe('5s timeout', () => {
    it('should pass a timeout option on all requests', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      await client.fetchBenchmarkAnalyticsSummary();

      const opts = mockFetch.mock.calls[0][1];
      expect(opts).toBeDefined();
      expect(opts.timeout).toBe(5000);
    });
  });
});

describe('getReportsServiceClient singleton', () => {
  it('should return the same instance on repeated calls', () => {
    const a = getReportsServiceClient();
    const b = getReportsServiceClient();
    expect(a).toBe(b);
  });

  it('should return an instance of ReportsServiceClient', () => {
    expect(getReportsServiceClient()).toBeInstanceOf(ReportsServiceClient);
  });
});

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Make a value awaitable through Mongoose-query-style mockChainable methods
// (.maxTimeMS(), .option()). Production code chains these before awaiting.
function mockChainable(value) {
  const c = {
    maxTimeMS: jest.fn(() => c),
    option: jest.fn(() => c),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject)
  };
  return c;
}

// --- ReportsServiceClient mock ---
const mockFetchBenchmarkSummary = jest.fn();
const mockFetchRagStatus = jest.fn();
const mockFetchBenchmarkTrends = jest.fn().mockResolvedValue(null);
const mockFetchBenchmarkLeaderboard = jest.fn().mockResolvedValue(null);
const mockFetchBenchmarkRecommendations = jest.fn().mockResolvedValue(null);
const mockFetchProfilerDashboard = jest.fn().mockResolvedValue(null);
const mockFetchRagMetrics = jest.fn().mockResolvedValue(null);
jest.mock('../../src/services/reportsServiceClient', () => ({
  getReportsServiceClient: () => ({
    fetchBenchmarkAnalyticsSummary: mockFetchBenchmarkSummary,
    fetchRagStatus: mockFetchRagStatus,
    fetchBenchmarkTrends: mockFetchBenchmarkTrends,
    fetchBenchmarkLeaderboard: mockFetchBenchmarkLeaderboard,
    fetchBenchmarkRecommendations: mockFetchBenchmarkRecommendations,
    fetchProfilerDashboard: mockFetchProfilerDashboard,
    fetchRagMetrics: mockFetchRagMetrics
  })
}));

const mockBuildPlanningWeeklyReview = jest.fn().mockResolvedValue({
  pulse: { active: 2, atRisk: 1, blocked: 0 },
  metrics: [{
    title: 'Alert lifecycle is trustworthy',
    adapter: 'alerts.active_count',
    value: 10,
    status: 'fresh'
  }],
  wins: [],
  risks: [],
  decisions: [],
  nextActions: [{ code: 'decide', count: 1, label: 'Resolve 1 proposed decision(s)' }],
  summary: 'Planning: 2 active, 0 blocked, 1 at risk, 0 recent proof/win(s).'
});
jest.mock('../../src/services/planningReviewService', () => ({
  buildWeeklyReview: mockBuildPlanningWeeklyReview
}));

const mockBuildMemoryReviewDigest = jest.fn().mockResolvedValue({
  text: 'Memory review run-1: 2 awaiting review.', runId: 'run-1', pending: 2, total: 3
});
jest.mock('../../src/services/memoryReview/memoryReviewService', () => ({
  buildDigest: mockBuildMemoryReviewDigest
}));

// --- Alert mock (mockChainable: find().sort().limit().maxTimeMS().lean()) ---
const mockAlertCountDocuments = jest.fn();
const mockAlertLean = jest.fn();
const mockAlertMaxTimeMS = jest.fn(() => ({ lean: mockAlertLean }));
const mockAlertLimit = jest.fn(() => ({ maxTimeMS: mockAlertMaxTimeMS }));
const mockAlertSort = jest.fn(() => ({ limit: mockAlertLimit }));
const mockAlertFind = jest.fn(() => ({ sort: mockAlertSort }));

jest.mock('../../models/Alert', () => ({
  countDocuments: (...args) => mockChainable(mockAlertCountDocuments(...args)),
  find: mockAlertFind
}));

// --- Conversation mock ---
const mockConversationCountDocuments = jest.fn();
const mockConversationAggregate = jest.fn();

jest.mock('../../models/Conversation', () => ({
  countDocuments: (...args) => mockChainable(mockConversationCountDocuments(...args)),
  aggregate: (...args) => mockChainable(mockConversationAggregate(...args))
}));

// --- InferenceLog mock ---
const mockInferenceLogAggregate = jest.fn();

jest.mock('../../models/InferenceLog', () => ({
  aggregate: (...args) => mockChainable(mockInferenceLogAggregate(...args))
}));

const express = require('express');
const request = require('supertest');
const reports = require('../../routes/reports');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reports);
  return app;
}

describe('Reports Routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  describe('GET /api/reports/morning-brief', () => {
    describe('happy path', () => {
      beforeEach(() => {
        // Alert mocks
        mockAlertCountDocuments
          .mockResolvedValueOnce(2)   // active count
          .mockResolvedValueOnce(0)   // critical count
          .mockResolvedValueOnce(2);  // warning count
        mockAlertLean.mockResolvedValue([
          { _id: 'a1', severity: 'warning', title: 'High latency', createdAt: new Date() }
        ]);

        // Conversation mocks
        mockConversationCountDocuments.mockResolvedValue(15);
        mockConversationAggregate.mockResolvedValue([{ messages: 142, totalCost: 1.23 }]);

        // InferenceLog mock
        mockInferenceLogAggregate.mockResolvedValue([
          { avgLatency: 320, count: 142, errors: 3 }
        ]);
      });

      it('should return 200 with all sections present', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data).toBeDefined();
      });

      it('should return report name "morning-brief"', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.body.data.report).toBe('morning-brief');
      });

      it('should include generated timestamp and period', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.body.data.generated).toBeDefined();
        expect(res.body.data.period).toBe('24h');
      });

      it('should include alerts section with expected fields', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.body.data.alerts).toBeDefined();
        expect(res.body.data.alerts).toHaveProperty('active');
        expect(res.body.data.alerts).toHaveProperty('critical');
        expect(res.body.data.alerts).toHaveProperty('warning');
        expect(res.body.data.alerts).toHaveProperty('recent');
        expect(Array.isArray(res.body.data.alerts.recent)).toBe(true);
      });

      it('should include analytics section with expected fields', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.body.data.analytics).toBeDefined();
        expect(res.body.data.analytics).toHaveProperty('conversations');
        expect(res.body.data.analytics).toHaveProperty('messages');
        expect(res.body.data.analytics).toHaveProperty('cost_usd');
      });

      it('should include performance section with expected fields', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.body.data.performance).toBeDefined();
        expect(res.body.data.performance).toHaveProperty('avg_latency_ms');
        expect(res.body.data.performance).toHaveProperty('requests');
        expect(res.body.data.performance).toHaveProperty('error_rate');
      });

      it('should include a statement-free Dreaming review summary', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(mockBuildMemoryReviewDigest).toHaveBeenCalledWith({ includeStatements: false });
        expect(res.body.data.memoryReview).toEqual(expect.objectContaining({
          runId: 'run-1', pending: 2, total: 3
        }));
        expect(res.body.data.summary).toContain('2 Dreaming candidates awaiting review.');
      });

      it('should surface an overdue Dreaming reconciliation without candidate text', async () => {
        mockBuildMemoryReviewDigest.mockResolvedValueOnce({
          runId: 'complete-1', pending: 0, total: 0, attention: true,
          activeRun: { runId: 'late-1', reconciliation: { overdue: true } },
        });
        const res = await request(app).get('/api/reports/morning-brief');
        expect(res.body.data.summary).toContain('Dreaming reconciliation needs attention.');
        expect(res.body.data.summary).not.toContain('candidate wording');
      });

      it('should include a summary string', async () => {
        const res = await request(app).get('/api/reports/morning-brief');

        expect(typeof res.body.data.summary).toBe('string');
        expect(res.body.data.summary.length).toBeGreaterThan(0);
      });

      it('should accept custom period via query param', async () => {
        const res = await request(app).get('/api/reports/morning-brief?period=7d');

        expect(res.status).toBe(200);
        expect(res.body.data.period).toBe('7d');
      });
    });

    describe('partial failure tolerance', () => {
      it('should return 200 with fallback alert data when Alert.countDocuments rejects', async () => {
        // Alert throws
        mockAlertCountDocuments.mockRejectedValue(new Error('DB timeout'));
        mockAlertFind.mockImplementation(() => ({
          sort: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.reject(new Error('DB timeout')) }) }) })
        }));

        // Other models succeed
        mockConversationCountDocuments.mockResolvedValue(5);
        mockConversationAggregate.mockResolvedValue([{ messages: 40, totalCost: 0.5 }]);
        mockInferenceLogAggregate.mockResolvedValue([{ avgLatency: 200, count: 40, errors: 0 }]);

        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data.alerts).toBeDefined();
        expect(res.body.data.alerts.active).toBe(0);
        expect(res.body.data.alerts.critical).toBe(0);
        expect(res.body.data.alerts.warning).toBe(0);
        expect(Array.isArray(res.body.data.alerts.recent)).toBe(true);
        expect(res.body.data.alerts.recent).toHaveLength(0);
        expect(res.body.data.alerts.error).toBe('unavailable');
      });

      it('should return 200 even when all data sources fail', async () => {
        mockAlertCountDocuments.mockRejectedValue(new Error('fail'));
        mockAlertFind.mockImplementation(() => ({
          sort: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.reject(new Error('fail')) }) }) })
        }));
        mockConversationCountDocuments.mockRejectedValue(new Error('fail'));
        mockConversationAggregate.mockRejectedValue(new Error('fail'));
        mockInferenceLogAggregate.mockRejectedValue(new Error('fail'));
        mockBuildMemoryReviewDigest.mockRejectedValueOnce(new Error('fail'));

        const res = await request(app).get('/api/reports/morning-brief');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data.report).toBe('morning-brief');
        expect(res.body.data.memoryReview).toEqual(expect.objectContaining({ error: 'unavailable' }));
      });
    });
  });

  describe('GET /api/reports/daily-digest', () => {
    describe('happy path', () => {
      beforeEach(() => {
        // Conversation mocks: countDocuments for gatherAnalytics, aggregate called twice
        // (once for gatherAnalytics, once for gatherCostByModel)
        mockConversationCountDocuments.mockResolvedValue(15);
        mockConversationAggregate
          .mockResolvedValueOnce([{ messages: 142, totalCost: 1.23 }])  // gatherAnalytics agg
          .mockResolvedValueOnce([                                       // gatherCostByModel
            { _id: 'qwen3', cost: 0.80, messages: 90 },
            { _id: 'gemma4', cost: 0.43, messages: 52 }
          ]);

        // InferenceLog mock
        mockInferenceLogAggregate.mockResolvedValue([
          { avgLatency: 320, count: 142, errors: 3 }
        ]);

        // Cross-service mocks
        mockFetchBenchmarkSummary.mockResolvedValue({ batches: 2, top_model: 'qwen3' });
        mockFetchRagStatus.mockResolvedValue({ status: 'healthy', documents: 340 });
      });

      it('should return a complete daily digest', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data.report).toBe('daily-digest');
        expect(res.body.data.generated).toBeDefined();
        expect(res.body.data.period).toBe('24h');
      });

      it('should include analytics with cost_by_model array', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.body.data.analytics).toBeDefined();
        expect(res.body.data.analytics).toHaveProperty('conversations', 15);
        expect(res.body.data.analytics).toHaveProperty('messages', 142);
        expect(res.body.data.analytics).toHaveProperty('cost_usd');
        expect(Array.isArray(res.body.data.analytics.cost_by_model)).toBe(true);
        expect(res.body.data.analytics.cost_by_model.length).toBeGreaterThan(0);
        expect(res.body.data.analytics.cost_by_model[0]).toHaveProperty('model');
        expect(res.body.data.analytics.cost_by_model[0]).toHaveProperty('cost');
        expect(res.body.data.analytics.cost_by_model[0]).toHaveProperty('messages');
      });

      it('should include performance section', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.body.data.performance).toBeDefined();
        expect(res.body.data.performance).toHaveProperty('avg_latency_ms', 320);
        expect(res.body.data.performance).toHaveProperty('requests', 142);
        expect(res.body.data.performance).toHaveProperty('error_rate');
      });

      it('should include benchmark and rag sections from cross-service calls', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.body.data.benchmark).toEqual({ batches: 2, top_model: 'qwen3' });
        expect(res.body.data.rag).toEqual({ status: 'healthy', documents: 340 });
      });

      it('should include a non-empty summary string', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(typeof res.body.data.summary).toBe('string');
        expect(res.body.data.summary.length).toBeGreaterThan(0);
      });

      it('should accept custom period via query param', async () => {
        const res = await request(app).get('/api/reports/daily-digest?period=7d');

        expect(res.status).toBe(200);
        expect(res.body.data.period).toBe('7d');
      });
    });

    describe('graceful degradation when benchmark/rag are down', () => {
      beforeEach(() => {
        mockConversationCountDocuments.mockResolvedValue(5);
        mockConversationAggregate
          .mockResolvedValueOnce([{ messages: 40, totalCost: 0.5 }])
          .mockResolvedValueOnce([]);
        mockInferenceLogAggregate.mockResolvedValue([
          { avgLatency: 200, count: 40, errors: 0 }
        ]);

        // Both cross-service calls return null (unreachable)
        mockFetchBenchmarkSummary.mockResolvedValue(null);
        mockFetchRagStatus.mockResolvedValue(null);
      });

      it('should degrade gracefully when benchmark/rag are down', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data.benchmark).toEqual({ status: 'unreachable' });
        expect(res.body.data.rag).toEqual({ status: 'unreachable' });
      });

      it('should still return valid analytics and performance when services are down', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.body.data.analytics.conversations).toBe(5);
        expect(res.body.data.analytics.messages).toBe(40);
        expect(res.body.data.performance.requests).toBe(40);
      });

      it('should mention unreachable services in summary', async () => {
        const res = await request(app).get('/api/reports/daily-digest');

        expect(res.body.data.summary).toContain('unreachable');
      });
    });
  });

  describe('GET /api/reports/weekly-review', () => {
    describe('happy path', () => {
      beforeEach(() => {
        mockConversationAggregate.mockResolvedValue([
          { totalCost: 8.5, messages: 980 }
        ]);

        mockFetchBenchmarkTrends.mockResolvedValue({ direction: 'up', delta: 0.05 });
        mockFetchBenchmarkLeaderboard.mockResolvedValue([
          { model: 'qwen3', score: 0.92 }
        ]);
        mockFetchBenchmarkRecommendations.mockResolvedValue([
          { model: 'qwen3', reason: 'top performer' }
        ]);
        mockFetchProfilerDashboard.mockResolvedValue({ hosts_healthy: 3 });
      });

      it('should return a complete weekly review', async () => {
        const res = await request(app).get('/api/reports/weekly-review');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data.report).toBe('weekly-review');
        expect(res.body.data.generated).toBeDefined();
        expect(res.body.data.period).toBe('7d');

        expect(res.body.data.costs).toEqual({ this_period_usd: 8.5, messages: 980 });

        expect(res.body.data.benchmark).toHaveProperty('trends');
        expect(res.body.data.benchmark).toHaveProperty('leaderboard');
        expect(res.body.data.benchmark).toHaveProperty('recommendations');
        expect(res.body.data.benchmark.status).toBeUndefined();

        expect(res.body.data.profiler).toEqual({ hosts_healthy: 3 });
        expect(res.body.data.planning).toEqual(expect.objectContaining({
          pulse: expect.objectContaining({ active: 2, atRisk: 1 }),
          metrics: expect.arrayContaining([
            expect.objectContaining({ adapter: 'alerts.active_count', value: 10 })
          ])
        }));

        expect(typeof res.body.data.summary).toBe('string');
        expect(res.body.data.summary.length).toBeGreaterThan(0);
        expect(res.body.data.summary).toContain('Planning: 2 active');
      });

      it('should normalize wrapped benchmark leaderboard and trends payloads', async () => {
        mockFetchBenchmarkTrends.mockResolvedValue({
          trends: { direction: 'up', delta: 0.12 },
          period: { days: 7 }
        });
        mockFetchBenchmarkLeaderboard.mockResolvedValue({
          leaderboard: [
            { model: 'gemma4', score: 91.2 },
            { model: 'qwen3', score: 89.8 }
          ],
          benchmarkedModels: ['gemma4', 'qwen3']
        });
        mockFetchBenchmarkRecommendations.mockResolvedValue({
          recommendations: [
            { model: 'gemma4', reason: 'stable top performer' }
          ]
        });

        const res = await request(app).get('/api/reports/weekly-review');

        expect(res.status).toBe(200);
        expect(res.body.data.benchmark.trends).toEqual({
          direction: 'up',
          delta: 0.12,
          period: { days: 7 }
        });
        expect(res.body.data.benchmark.leaderboard).toEqual([
          { model: 'gemma4', score: 91.2 },
          { model: 'qwen3', score: 89.8 }
        ]);
        expect(res.body.data.benchmark.recommendations).toEqual([
          { model: 'gemma4', reason: 'stable top performer' }
        ]);
        expect(res.body.data.summary).toContain('Top model: gemma4');
      });
    });

    describe('graceful degradation when all cross-service calls fail', () => {
      beforeEach(() => {
        mockConversationAggregate.mockResolvedValue([
          { totalCost: 2.1, messages: 200 }
        ]);

        mockFetchBenchmarkTrends.mockResolvedValue(null);
        mockFetchBenchmarkLeaderboard.mockResolvedValue(null);
        mockFetchBenchmarkRecommendations.mockResolvedValue(null);
        mockFetchProfilerDashboard.mockResolvedValue(null);
      });

      it('should work with all cross-service calls failing', async () => {
        const res = await request(app).get('/api/reports/weekly-review');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data.report).toBe('weekly-review');

        expect(res.body.data.benchmark).toEqual({ status: 'unreachable' });
        expect(res.body.data.profiler).toEqual({ status: 'unreachable' });

        expect(res.body.data.costs).toEqual({ this_period_usd: 2.1, messages: 200 });

        expect(res.body.data.summary).toContain('unreachable');
      });

      it('keeps the weekly review available when Planning projection fails', async () => {
        mockBuildPlanningWeeklyReview.mockRejectedValueOnce(new Error('planning unavailable'));

        const res = await request(app).get('/api/reports/weekly-review');

        expect(res.status).toBe(200);
        expect(res.body.data.planning).toEqual({
          status: 'unreachable',
          summary: 'Planning: unavailable.'
        });
        expect(res.body.data.summary).toContain('Planning: unavailable.');
      });
    });
  });

  describe('GET /api/reports/system-status', () => {
    it('happy path: all services reachable', async () => {
      mockFetchBenchmarkSummary.mockResolvedValue({ batches: 5, top_model: 'qwen3' });
      mockFetchRagStatus.mockResolvedValue({ status: 'healthy', documents: 200 });

      const res = await request(app).get('/api/reports/system-status');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.report).toBe('system-status');
      expect(res.body.data.generated).toBeDefined();

      expect(res.body.data.services.core.status).toBe('ok');
      expect(res.body.data.services.benchmark.status).toBe('ok');
      expect(res.body.data.services.rag.status).toBe('ok');

      expect(res.body.data.summary).toContain('operational');
    });

    it('degraded path: rag unreachable', async () => {
      mockFetchBenchmarkSummary.mockResolvedValue({ batches: 3, top_model: 'gemma4' });
      mockFetchRagStatus.mockResolvedValue(null);

      const res = await request(app).get('/api/reports/system-status');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      expect(res.body.data.services.core.status).toBe('ok');
      expect(res.body.data.services.benchmark.status).toBe('ok');
      expect(res.body.data.services.rag).toEqual({ status: 'unreachable' });

      expect(res.body.data.summary).toContain('unreachable');
      expect(res.body.data.summary).toContain('rag');
    });
  });
});

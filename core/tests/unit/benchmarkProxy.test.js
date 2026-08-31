jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockGetRecommendationView = jest.fn();
const mockGetAllCategoryRecommendations = jest.fn();

jest.mock('../../src/services/benchmarkServiceClient', () => ({
  getBenchmarkServiceClient: () => ({
    getRecommendationView: mockGetRecommendationView,
    getAllCategoryRecommendations: mockGetAllCategoryRecommendations
  })
}));

const express = require('express');
const request = require('supertest');
const benchmarkProxy = require('../../routes/benchmark-proxy');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/benchmark-proxy', benchmarkProxy);
  return app;
}

describe('Benchmark Proxy Routes', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    app = buildApp();
    mockGetRecommendationView.mockReset();
    mockGetAllCategoryRecommendations.mockReset();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('GET /api/benchmark-proxy/recommend', () => {
    it('should return 400 when category is missing', async () => {
      const res = await request(app).get('/api/benchmark-proxy/recommend');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/category/);
    });

    it('should return 400 for invalid category', async () => {
      const res = await request(app).get('/api/benchmark-proxy/recommend?category=invalid');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid category/);
    });

    it('should reject a recommendation consumer with no explicit trust scope', async () => {
      const res = await request(app).get('/api/benchmark-proxy/recommend?category=coding');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TRUST_SCOPE_REQUIRED');
    });

    it('should return recommendations for valid category', async () => {
      const mockRecs = [{ model: 'qwen3:14b', quality_score: 8.4, confidence: 'medium' }];
      mockGetRecommendationView.mockResolvedValue({
        category: 'coding',
        trustScope: 'trusted',
        trustVerdict: { state: 'trusted', qualified: false },
        recommendations: mockRecs
      });

      const res = await request(app).get('/api/benchmark-proxy/recommend?category=coding&trustScope=trusted');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.category).toBe('coding');
      expect(res.body.data.recommendations).toEqual(mockRecs);
      expect(res.body.data.source).toBe('benchmark');
    });

    it('should forward host and min_quality params', async () => {
      mockGetRecommendationView.mockResolvedValue({ recommendations: [] });

      await request(app).get('/api/benchmark-proxy/recommend?category=coding&trustScope=exploratory&host=192.0.2.66&min_quality=7');

      expect(mockGetRecommendationView).toHaveBeenCalledWith('coding', {
        host: '192.0.2.66',
        min_quality: '7',
        trustScope: 'exploratory'
      });
    });

    it('should return 502 when service client throws', async () => {
      mockGetRecommendationView.mockRejectedValue(new Error('unexpected'));

      const res = await request(app).get('/api/benchmark-proxy/recommend?category=math&trustScope=trusted');

      expect(res.status).toBe(502);
      expect(res.body.message).toMatch(/unavailable/i);
    });
  });

  describe('GET /api/benchmark-proxy/recommend/all', () => {
    it('should return recommendations for all categories', async () => {
      const mockAll = {
        coding: [{ model: 'a' }],
        reasoning: [],
        math: [{ model: 'b' }],
        knowledge: [],
        instruction: [],
        creative: [],
        translation: []
      };
      mockGetAllCategoryRecommendations.mockResolvedValue(mockAll);

      const res = await request(app).get('/api/benchmark-proxy/recommend/all?trustScope=trusted');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.categories).toEqual(mockAll);
      expect(res.body.data.source).toBe('benchmark');
      expect(mockGetAllCategoryRecommendations).toHaveBeenCalledWith({ trustScope: 'trusted' });
    });

    it('should return 502 on error', async () => {
      mockGetAllCategoryRecommendations.mockRejectedValue(new Error('fail'));

      const res = await request(app).get('/api/benchmark-proxy/recommend/all?trustScope=trusted');

      expect(res.status).toBe(502);
    });
  });

  describe('generic passthrough', () => {
    it('forwards non-recommend GET routes and query parameters', async () => {
      global.fetch.mockResolvedValue({
        status: 200,
        headers: { get: () => 'application/json' },
        json: jest.fn().mockResolvedValue({ status: 'success', data: ['model-a'] })
      });

      const res = await request(app)
        .get('/api/benchmark-proxy/leaderboard?limit=2');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(['model-a']);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3081/api/benchmark/leaderboard?limit=2',
        { method: 'GET', headers: { 'Content-Type': 'application/json' } }
      );
    });

    it('forwards mutation bodies and preserves the upstream status', async () => {
      global.fetch.mockResolvedValue({
        status: 201,
        headers: { get: () => 'application/json; charset=utf-8' },
        json: jest.fn().mockResolvedValue({ status: 'success', id: 'batch-1' })
      });

      const res = await request(app)
        .post('/api/benchmark-proxy/batches')
        .send({ name: 'smoke' });

      expect(res.status).toBe(201);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3081/api/benchmark/batches',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'smoke' })
        }
      );
    });

    it('returns a bounded 502 response when benchmark is unreachable', async () => {
      global.fetch.mockRejectedValue(new Error('connection refused'));

      const res = await request(app)
        .get('/api/benchmark-proxy/courthouse');

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        status: 'error',
        message: 'Benchmark service unreachable',
        detail: 'connection refused'
      });
    });
  });
});

'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../models/PerformanceSnapshot');
jest.mock('../../models/PerformanceLoadTest');
jest.mock('../../models/PerformanceBaseline');
jest.mock('../../src/services/artilleryParser', () => ({}));
jest.mock('../../routes/performance-data', () => require('express').Router());

const PerformanceSnapshot = require('../../models/PerformanceSnapshot');
const PerformanceLoadTest = require('../../models/PerformanceLoadTest');
const PerformanceBaseline = require('../../models/PerformanceBaseline');
const router = require('../../routes/performance');

function app() {
  const instance = express();
  instance.use('/api/performance', router);
  return instance;
}

const metrics = (over = {}) => ({
  total_requests: 1000,
  total_successful: 980,
  total_failed: 20,
  error_rate: 2,
  avg_latency: 300,
  avg_p95: 500,
  avg_p99: 800,
  max_latency: 2000,
  min_latency: 5,
  ...over
});

function wireSnapshots({ current, previous, trendCurrent }) {
  // Calls: (1) the live display window, then in parallel (2) the trend's
  // complete-hours current window and (3) the previous window.
  PerformanceSnapshot.getAggregatedMetrics = jest.fn()
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(trendCurrent === undefined ? current : trendCurrent)
    .mockResolvedValueOnce(previous);
  PerformanceSnapshot.countDocuments = jest.fn().mockResolvedValue(24);
  PerformanceSnapshot.findOne = jest.fn().mockReturnValue({
    sort: () => ({ select: () => ({ lean: async () => ({ hour: new Date('2026-07-31T17:00:00Z') }) }) })
  });
  PerformanceSnapshot.aggregate = jest.fn().mockResolvedValue([{
    totals: [{ _id: true, count: 400 }, { _id: false, count: 600 }],
    categories: [],
    top_endpoints: [],
    top_error_endpoints: [],
    top_slow_endpoints: []
  }]);
  PerformanceSnapshot.getThroughputTrend = jest.fn().mockResolvedValue([{ rps: '0.50' }, { rps: '0.70' }]);
  PerformanceLoadTest.getLatest = jest.fn().mockResolvedValue(null);
  PerformanceBaseline.getActive = jest.fn().mockResolvedValue(null);
}

describe('GET /api/performance/dashboard', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a single-level envelope — this is the defect that blanked every KPI card', async () => {
    wireSnapshots({ current: metrics(), previous: metrics() });
    const res = await request(app()).get('/api/performance/dashboard?hours=24');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The bug: data used to hold another {status, data} envelope, so the page
    // read data.system_health as undefined and rendered zeros over real traffic.
    expect(res.body.data.data).toBeUndefined();
    expect(res.body.data.status).toBeUndefined();
    expect(res.body.data.system_health).toBeDefined();
    expect(res.body.data.metrics_24h.total_requests).toBe(1000);
    expect(res.body.data.metrics_24h.avg_latency).toBe(300);
    expect(res.body.data.sources.production.snapshots).toBe(24);
  });

  test('reports percent change against the previous equal-length window', async () => {
    wireSnapshots({
      current: metrics({ avg_latency: 300, avg_p95: 500, error_rate: 2 }),
      previous: metrics({ avg_latency: 200, avg_p95: 400, error_rate: 4 })
    });
    const res = await request(app()).get('/api/performance/dashboard?hours=24');

    expect(res.body.data.trends.avg_latency_pct).toBe(50);
    expect(res.body.data.trends.p95_latency_pct).toBe(25);
    expect(res.body.data.trends.error_rate_pct).toBe(-50);
    expect(res.body.data.trends.previous_window.total_requests).toBe(1000);
  });

  test('compares complete hours only, so a partial hour cannot fake a collapse', async () => {
    // The live window holds 10 minutes of traffic; the trend windows hold full
    // hours. Reading the partial bucket as the trend numerator produced a
    // spurious -87% throughput drop that tracked wall-clock position.
    wireSnapshots({
      current: metrics({ total_requests: 164 }),
      trendCurrent: metrics({ total_requests: 1400 }),
      previous: metrics({ total_requests: 1429 })
    });
    const res = await request(app()).get('/api/performance/dashboard?hours=1');

    expect(res.body.data.trends.basis).toBe('complete-hours-only');
    // 1400 vs 1429 is a ~2% dip, not a collapse.
    expect(res.body.data.trends.throughput_pct).toBeCloseTo(-2, 0);
    // The displayed metrics still reflect the real requested window.
    expect(res.body.data.metrics_24h.total_requests).toBe(164);
    // Trend windows never overlap and are equal length.
    const t = res.body.data.trends;
    expect(new Date(t.current_window.from).getTime())
      .toBe(new Date(t.previous_window.to).getTime());
  });

  test('yields null trends when there is no prior window, never a fake 0%', async () => {
    wireSnapshots({ current: metrics(), previous: null });
    const res = await request(app()).get('/api/performance/dashboard?hours=24');

    expect(res.body.data.trends.avg_latency_pct).toBeNull();
    expect(res.body.data.trends.p95_latency_pct).toBeNull();
    expect(res.body.data.trends.error_rate_pct).toBeNull();
    expect(res.body.data.trends.throughput_pct).toBeNull();
  });

  test('survives an empty current window', async () => {
    wireSnapshots({ current: null, previous: null });
    const res = await request(app()).get('/api/performance/dashboard?hours=24');

    expect(res.status).toBe(200);
    expect(res.body.data.metrics_24h.total_requests).toBe(0);
    expect(res.body.data.metrics_24h.uptime_percent).toBe(100);
  });

  test('coalesces persisted nullish endpoint IDs without losing diagnostic volume', async () => {
    wireSnapshots({ current: metrics(), previous: metrics() });
    PerformanceSnapshot.aggregate.mockResolvedValue([{
      totals: [{ _id: true, count: 5 }],
      categories: [],
      top_endpoints: [
        { path: '/api/family/room/undefined', method: 'GET', count: 2, error_count: 2, avg_latency: 100 },
        { path: '/api/family/room/null', method: 'GET', count: 3, error_count: 1, avg_latency: 200 }
      ],
      top_error_endpoints: [],
      top_slow_endpoints: []
    }]);

    const res = await request(app()).get('/api/performance/dashboard?hours=24');

    expect(res.body.data.sources.production.top_endpoints).toEqual([expect.objectContaining({
      path: '/api/family/room/:invalid-id',
      count: 5,
      error_count: 3,
      error_rate: 60,
      avg_latency: 160
    })]);
  });
});

describe('GET /api/performance/endpoints', () => {
  beforeEach(() => jest.clearAllMocks());

  test('deduplicates legacy placeholder spellings into the visible invalid-id aggregate', async () => {
    PerformanceSnapshot.aggregate.mockResolvedValue([
      { _id: '/api/family/room/undefined' },
      { _id: '/api/family/room/null' },
      { _id: '/api/chat' }
    ]);

    const res = await request(app()).get('/api/performance/endpoints').expect(200);

    expect(res.body.data).toEqual([
      '/api/chat',
      '/api/family/room/:invalid-id'
    ]);
    expect(res.body.data.join(' ')).not.toMatch(/\/undefined|\/null/);
  });
});

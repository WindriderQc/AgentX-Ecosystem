'use strict';

const mockGetGeneralistLeaderboard = jest.fn();
const mockGetDashboard = jest.fn();
jest.mock('../../src/services/benchmark', () => ({
  getGeneralistLeaderboard: (...args) => mockGetGeneralistLeaderboard(...args),
  getDashboard: (...args) => mockGetDashboard(...args),
}));

const express = require('express');
const router = require('../../routes/benchmark/analytics');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

describe('leaderboard cloud filter route', () => {
  let harness;

  beforeAll(async () => {
    const app = express();
    app.use('/api/benchmark', router);
    harness = await startTestHttpHarness(app);
  });

  afterAll(async () => harness?.close());

  beforeEach(() => {
    mockGetGeneralistLeaderboard.mockReset();
    mockGetGeneralistLeaderboard.mockResolvedValue({ leaderboard: [] });
    mockGetDashboard.mockReset();
    mockGetDashboard.mockResolvedValue({ overview: {}, model_stats: [] });
  });

  test('includes cloud targets by default', async () => {
    await harness.request.get('/api/benchmark/generalist-leaderboard?trustScope=trusted').expect(200);
    expect(mockGetGeneralistLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ includeCloud: true }));
  });

  test('passes includeCloud=false to server-side ranking and statistics', async () => {
    await harness.request.get('/api/benchmark/generalist-leaderboard?trustScope=exploratory&includeCloud=false').expect(200);
    expect(mockGetGeneralistLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ includeCloud: false }));
    await harness.request.get('/api/benchmark/dashboard?includeCloud=false').expect(200);
    expect(mockGetDashboard).toHaveBeenCalledWith(expect.objectContaining({ includeCloud: false }));
  });
});

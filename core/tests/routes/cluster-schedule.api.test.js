const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const ClusterScheduleClaim = require('../../models/ClusterScheduleClaim');
const clusterScheduleRoutes = require('../../routes/cluster-schedule');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cluster', clusterScheduleRoutes);
  return app;
}

describe('cluster schedule claim routes', () => {
  let app;

  beforeEach(async () => {
    app = buildApp();
    await ClusterScheduleClaim.deleteMany({});
  });

  afterEach(async () => {
    await ClusterScheduleClaim.deleteMany({});
  });

  it('creates, lists, and releases Mongo-backed schedule claims', async () => {
    const createRes = await request(app)
      .post('/api/cluster/schedule/claim')
      .send({ host: 'primary', model: 'qwen3:8b', caller: 'route-test', ttlMs: 30000 })
      .expect(200);

    expect(createRes.body.status).toBe('success');
    expect(createRes.body.data.claimId).toBeDefined();
    expect(await ClusterScheduleClaim.countDocuments({ host: 'primary' })).toBe(1);

    const listRes = await request(app)
      .get('/api/cluster/schedule/claims')
      .expect(200);

    expect(listRes.body.data.count).toBe(1);
    expect(listRes.body.data.claims[0]).toMatchObject({
      claimId: createRes.body.data.claimId,
      host: 'primary',
      model: 'qwen3:8b',
      caller: 'route-test'
    });

    const releaseRes = await request(app)
      .delete(`/api/cluster/schedule/claim/${encodeURIComponent(createRes.body.data.claimId)}`)
      .expect(200);

    expect(releaseRes.body.data.released).toBe(true);
    expect(await ClusterScheduleClaim.countDocuments({})).toBe(0);
  });
});

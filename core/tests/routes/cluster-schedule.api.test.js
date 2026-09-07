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
const clusterScheduleService = require('../../src/services/clusterScheduleService');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cluster', clusterScheduleRoutes);
  return app;
}

function buildRemoteApp() {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      configurable: true,
      value: '203.0.113.9'
    });
    next();
  });
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

describe('cluster schedule evidence routes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('labels the upcoming assignment projection with its own observation scope', async () => {
    jest.spyOn(clusterScheduleService, 'getNextTasks').mockResolvedValue([{
      id: 'next-task',
      name: 'Next task',
      msFromNow: 1000
    }]);

    const response = await request(buildApp())
      .get('/api/cluster/schedule/next?count=20')
      .expect(200);

    expect(response.body.data).toMatchObject({
      count: 1,
      tasks: [{ id: 'next-task' }],
      evidence: {
        authority: 'agentx.cluster-schedule',
        scope: 'upcoming-assignment-projection',
        observedAt: expect.any(String)
      }
    });
    expect(Number.isNaN(Date.parse(response.body.data.evidence.observedAt))).toBe(false);
  });
});

describe('cluster schedule remote machine mutations', () => {
  const mutations = [
    {
      label: 'sync',
      method: 'post',
      path: '/api/cluster/schedule/sync',
      body: { entries: [{ source: 'route-test', sourceId: 'entry-1', name: 'Entry 1' }] },
      serviceMethod: 'syncEntries',
      result: { created: 1, updated: 0, unchanged: 0 }
    },
    {
      label: 'claim',
      method: 'post',
      path: '/api/cluster/schedule/claim',
      body: { host: 'primary', model: 'qwen3:8b', caller: 'route-test', ttlMs: 30000 },
      serviceMethod: 'createClaim',
      result: { claimId: 'claim-1', host: 'primary' }
    },
    {
      label: 'release',
      method: 'delete',
      path: '/api/cluster/schedule/claim/claim-1',
      body: {},
      serviceMethod: 'releaseClaim',
      result: true
    }
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(mutations)('allows a remote $label call without any token', async (mutation) => {
    const sideEffect = jest.spyOn(clusterScheduleService, mutation.serviceMethod)
      .mockResolvedValue(mutation.result);

    await request(buildRemoteApp())[mutation.method](mutation.path)
      .set('Host', 'remote-scheduler.example')
      .send(mutation.body)
      .expect(200);

    expect(sideEffect).toHaveBeenCalledTimes(1);
  });
});

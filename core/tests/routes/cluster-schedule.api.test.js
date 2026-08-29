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

describe('cluster schedule scoped machine mutations', () => {
  const ENV_KEYS = [
    'AGENTX_SCHEDULE_TOKEN',
    'AGENTX_OPERATOR_TOKEN',
    'AGENTX_ADMIN_TOKEN',
    'AGENTX_TRUST_INTERNAL_SERVICE_HOSTS',
    'AGENTX_TRUST_LOOPBACK_PROXY_UI',
  ];
  const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
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

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(mutations)('denies remote $label calls before their service side effect', async (mutation) => {
    const sideEffect = jest.spyOn(clusterScheduleService, mutation.serviceMethod)
      .mockResolvedValue(mutation.result);
    const denialCases = [
      { configured: 'schedule-secret' },
      { configured: 'schedule-secret', presented: 'not-the-secret' },
      {},
      { presented: 'invented-without-configuration' }
    ];

    for (const denial of denialCases) {
      if (denial.configured === undefined) delete process.env.AGENTX_SCHEDULE_TOKEN;
      else process.env.AGENTX_SCHEDULE_TOKEN = denial.configured;

      let pending = request(buildRemoteApp())[mutation.method](mutation.path)
        .set('Host', 'remote-scheduler.example');
      if (denial.presented !== undefined) {
        pending = pending.set('X-AgentX-Schedule-Token', denial.presented);
      }

      const response = await pending.send(mutation.body).expect(403);
      expect(response.body).toMatchObject({
        status: 'error',
        code: 'SCHEDULE_MACHINE_ACCESS_REQUIRED'
      });
    }

    expect(sideEffect).not.toHaveBeenCalled();
  });

  it.each(mutations)('allows a remote $label call with the exact schedule token', async (mutation) => {
    process.env.AGENTX_SCHEDULE_TOKEN = 'schedule-secret';
    const sideEffect = jest.spyOn(clusterScheduleService, mutation.serviceMethod)
      .mockResolvedValue(mutation.result);

    await request(buildRemoteApp())[mutation.method](mutation.path)
      .set('Host', 'remote-scheduler.example')
      .set('X-AgentX-Schedule-Token', 'schedule-secret')
      .send(mutation.body)
      .expect(200);

    expect(sideEffect).toHaveBeenCalledTimes(1);
  });
});

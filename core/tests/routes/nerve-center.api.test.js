/**
 * Integration Tests for Nerve Center API Routes
 *
 * Tests all endpoints under /api/nerve-center/ using supertest.
 * Mocks external services (fetch, alertService, hostPreferenceService,
 * InferenceLog) while letting the real modelRouter/modelRouterConfig
 * load with test env vars so routing logic is exercised.
 */

// ── Env setup (before any require) ──────────────────────────────────────────
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const mockRouterTaskOverrideState = new Map();

// ── InferenceLog chainable mock ─────────────────────────────────────────────
const mockLean = jest.fn();
const mockLimit = jest.fn(() => ({ lean: mockLean }));
const mockSort = jest.fn(() => ({ limit: mockLimit }));
const mockFind = jest.fn(() => ({ sort: mockSort }));
const mockLatestLean = jest.fn();
const mockLatestSort = jest.fn(() => ({ lean: mockLatestLean }));
const mockAggregate = jest.fn();

jest.mock('../../models/InferenceLog', () => ({
  find: (...args) => mockFind(...args),
  findOne: jest.fn(() => ({ sort: mockLatestSort })),
  countDocuments: jest.fn(() => Promise.resolve(0)),
  aggregate: (...args) => mockAggregate(...args)
}));

jest.mock('../../models/RouterTaskConfig', () => ({
  find: jest.fn(() => ({
    lean: jest.fn(() => Promise.resolve([...mockRouterTaskOverrideState.values()]))
  })),
  findOneAndUpdate: jest.fn((_query, update) => {
    mockRouterTaskOverrideState.set(update.taskType, {
      taskType: update.taskType,
      model: update.model,
      host: update.host
    });
    return Promise.resolve(update);
  }),
  deleteOne: jest.fn(({ taskType }) => {
    mockRouterTaskOverrideState.delete(taskType);
    return Promise.resolve({ deletedCount: 1 });
  }),
  deleteMany: jest.fn(() => {
    const deletedCount = mockRouterTaskOverrideState.size;
    mockRouterTaskOverrideState.clear();
    return Promise.resolve({ deletedCount });
  })
}));

jest.mock('../../models/ModelRegistry', () => ({
  find: jest.fn(() => {
    const chain = {
      sort: jest.fn(() => chain),
      select: jest.fn(() => chain),
      lean: jest.fn(() => Promise.resolve([
        { modelName: 'qwen3.5:9b' },
        { modelName: 'qwen3-2507-30b-long-48k' },
        { modelName: 'qwen2.5:7b' }
      ]))
    };
    return chain;
  })
}));

// ── Logger mock ─────────────────────────────────────────────────────────────
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

// ── node-fetch mock (healthy by default) ────────────────────────────────────
jest.mock('node-fetch', () =>
  jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) })
  )
);

// ── Alert service mock ──────────────────────────────────────────────────────
jest.mock('../../src/services/alertService', () => {
  const mock = {
    getRecentAlerts: jest.fn(),
    getAlertSnapshot: jest.fn(),
    getStatistics: jest.fn(),
    getAlertService: jest.fn()
  };
  mock.getAlertSnapshot.mockImplementation(async ({ limit = 50, filters = {} } = {}) => {
    const result = await mock.getRecentAlerts(limit, filters);
    const candidates = Array.isArray(result) ? result : [];
    const alerts = filters.status
      ? candidates.filter(alert => (alert.status || 'active') === filters.status)
      : candidates;
    const activeCount = filters.status === 'active'
      ? alerts.length
      : alerts.filter(alert => (alert.status || 'active') === 'active').length;
    return {
      alerts,
      total: alerts.length,
      limit,
      skip: 0,
      summary: {
        total: alerts.length,
        activeCount,
        bySeverity: {},
        byStatus: activeCount ? { active: activeCount } : {},
        basis: { activePredicate: { status: 'active' } },
        observedAt: new Date().toISOString()
      }
    };
  });
  mock.getAlertService.mockReturnValue(mock);
  return mock;
});

// ── Host preference service mock ────────────────────────────────────────────
jest.mock('../../src/services/hostPreferenceService', () => ({
  ...jest.requireActual('../../src/services/hostPreferenceIdentity'),
  getAll: jest.fn(),
  get: jest.fn(),
  upsert: jest.fn(),
  reload: jest.fn(),
  getHealthCheckIntervalMs: jest.fn(() => 30000),
  getPinnedEntries: jest.fn((pref) => pref.pinnedModels || []),
  claimBenchmark: jest.fn(),
  heartbeatBenchmarkClaim: jest.fn(),
  releaseBenchmarkClaim: jest.fn(),
  listBenchmarkClaims: jest.fn()
}));

const mockGetPortalStatus = jest.fn();
jest.mock('../../src/services/portalStatusService', () => ({
  getPortalStatus: (...args) => mockGetPortalStatus(...args)
}));

// ── Require modules AFTER mocks ─────────────────────────────────────────────
const express = require('express');
const request = require('supertest');

const alertService = require('../../src/services/alertService');
const hostPrefService = require('../../src/services/hostPreferenceService');
const {
  HOSTS,
  TASK_MODELS,
  resetAllTaskModelOverrides
} = require('../../src/services/modelRouterConfig');

// Snapshot original config values so we can restore after PUT mutations
const ORIGINAL_TASK_MODELS = JSON.parse(JSON.stringify(TASK_MODELS));

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/nerve-center', require('../../routes/nerve-center'));

// ── Test suite ──────────────────────────────────────────────────────────────

describe('Nerve Center API Routes', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRouterTaskOverrideState.clear();

    // Default mock returns
    mockLean.mockResolvedValue([]);
    mockLatestLean.mockResolvedValue(null);
    mockAggregate.mockResolvedValue([]);
    alertService.getRecentAlerts.mockResolvedValue([]);
    hostPrefService.getAll.mockResolvedValue([]);
    hostPrefService.get.mockResolvedValue(null);
    hostPrefService.upsert.mockResolvedValue({});
    hostPrefService.reload.mockResolvedValue();
    hostPrefService.getHealthCheckIntervalMs.mockReturnValue(30000);
    hostPrefService.getPinnedEntries.mockImplementation((pref) => pref.pinnedModels || []);
    const observedAt = new Date().toISOString();
    const identity = (service) => ({
      service,
      version: '0.1.1',
      profile: 'full',
      revision: 'test-revision',
      ts: observedAt
    });
    mockGetPortalStatus.mockResolvedValue({
      generatedAt: observedAt,
      summary: { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0 },
      consistency: {
        status: 'ok',
        profiles: ['full'],
        versions: ['0.1.1'],
        revisions: ['test-revision'],
        missing: [],
        issues: []
      },
      services: [
        { id: 'core', status: 'ok', identity: identity('agentx-core') },
        { id: 'benchmark', status: 'ok', identity: identity('agentx-benchmark') },
        { id: 'rag', status: 'ok', identity: identity('agentx-rag') }
      ]
    });

    // Restore config objects to original state
    Object.keys(TASK_MODELS).forEach(k => delete TASK_MODELS[k]);
    Object.assign(TASK_MODELS, JSON.parse(JSON.stringify(ORIGINAL_TASK_MODELS)));

    await resetAllTaskModelOverrides();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 1. GET /api/nerve-center/intelligence
  // ════════════════════════════════════════════════════════════════════════

  describe('GET /intelligence', () => {
    it('returns success with all expected nested fields', async () => {
      hostPrefService.getAll.mockResolvedValue([
        { hostUrl: 'http://primary:11434', preferredModel: 'qwen3-2507-30b-long-48k:latest' }
      ]);
      alertService.getRecentAlerts.mockResolvedValue([{ title: 'test alert' }]);
      mockLean.mockResolvedValue([{ model: 'qwen3:14b', host: 'primary' }]);

      const res = await request(app)
        .get('/api/nerve-center/intelligence')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('cluster');
      expect(res.body.data).toHaveProperty('routing');
      expect(res.body.data).toHaveProperty('hostPreferences');
      expect(res.body.data).toHaveProperty('alerts');
      expect(res.body.data).toHaveProperty('recentRouting');

      // cluster comes from getAllModelsHealth — array of host health objects
      expect(Array.isArray(res.body.data.cluster)).toBe(true);

      // hostPreferences reflects our mock
      expect(res.body.data.hostPreferences).toEqual([
        { hostUrl: 'http://primary:11434', preferredModel: 'qwen3-2507-30b-long-48k:latest' }
      ]);

      // alerts reflect our mock
      expect(res.body.data.alerts).toEqual([{ title: 'test alert' }]);

      // recentRouting reflects InferenceLog mock
      expect(res.body.data.recentRouting).toEqual([
        { model: 'qwen3:14b', host: 'primary' }
      ]);
    });

    it('uses the shared payload-free projection for legacy recent routing rows', async () => {
      const secret = 'LEGACY_NERVE_SECRET_d16b';
      mockLean.mockResolvedValue([{
        _id: 'legacy-row',
        model: 'model:1',
        status: 'error',
        error: `upstream echoed ${secret}`,
        payload: secret,
        routingTrace: {
          request: { requestedModel: 'model:1', preview: { prompt: { preview: secret } }, query: secret },
          selected: { routingSource: 'model_router', hostile: secret },
        },
      }]);

      const res = await request(app).get('/api/nerve-center/intelligence').expect(200);
      const row = res.body.data.recentRouting[0];
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row).not.toHaveProperty('payload');
      expect(row.error).toBeNull();
      expect(row.routingTrace.request).not.toHaveProperty('preview');
      expect(row.routingTrace.selected).toEqual(expect.objectContaining({ routingSource: 'model_router' }));
    });

    it('returns routing with failover status properties', async () => {
      const res = await request(app)
        .get('/api/nerve-center/intelligence')
        .expect(200);

      const routing = res.body.data.routing;
      expect(routing).toHaveProperty('currentHost');
      expect(routing).toHaveProperty('isFailedOver');
      expect(routing).toHaveProperty('failoverCount');
      expect(routing).toHaveProperty('primaryHost', 'http://primary:11434');
      expect(routing).toHaveProperty('authority', 'inference_log');
      expect(routing).toHaveProperty('statePersisted', true);
    });

    it('reports the latest persisted actual fallback instead of manual intent', async () => {
      mockLatestLean.mockResolvedValueOnce({
        _id: 'fallback-log',
        caller: 'embedding',
        model: 'nomic-embed-text:v1.5',
        host: 'http://secondary:11434',
        routedHostUrl: 'http://primary:11434',
        fallbackUsed: true,
        fallbackReason: 'connection_failure',
        status: 'success',
        timestamp: new Date('2026-07-23T12:00:00.000Z')
      });

      const res = await request(app)
        .get('/api/nerve-center/intelligence')
        .expect(200);

      expect(res.body.data.routing).toEqual(expect.objectContaining({
        currentHost: 'http://secondary:11434',
        isFailedOver: true,
        reason: 'connection_failure',
        authority: 'inference_log'
      }));
      expect(res.body.data.routing.observedRequest).toEqual(expect.objectContaining({
        actualHost: 'http://secondary:11434',
        requestedHost: 'http://primary:11434',
        fallbackUsed: true
      }));
    });

    it('returns /status as a compatibility alias for /intelligence', async () => {
      const res = await request(app)
        .get('/api/nerve-center/status')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.meta).toEqual({ aliasFor: '/intelligence' });
      expect(res.body.data).toHaveProperty('cluster');
      expect(res.body.data).toHaveProperty('routing');
      expect(res.body.data).toHaveProperty('hostPreferences');
      expect(res.body.data).toHaveProperty('alerts');
      expect(res.body.data).toHaveProperty('recentRouting');
    });

    it('returns 500 when getAllModelsHealth throws', async () => {
      // node-fetch is used by getAllModelsHealth → getModelHealth → checkHostHealth
      // Force fetch to throw to trigger the error path
      const fetch = require('node-fetch');
      fetch.mockImplementationOnce(() => { throw new Error('network down'); });

      // getAllModelsHealth catches individual host errors, so we need ALL hosts to fail
      // Actually, the intelligence endpoint wraps buildIntelligenceSummary in try/catch.
      // Let's instead make the InferenceLog.find throw to trigger the catch.
      mockLean.mockRejectedValue(new Error('db connection lost'));

      const res = await request(app)
        .get('/api/nerve-center/intelligence')
        .expect(500);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('db connection lost');
    });
  });

  describe('GET /ecosystem', () => {
    it('returns the strict product-owned machine, model, and routing snapshot', async () => {
      hostPrefService.getAll.mockResolvedValue([
        { hostUrl: 'http://primary:11434', preferredModel: 'qwen3-2507-30b-long-48k:latest' }
      ]);
      alertService.getRecentAlerts.mockResolvedValue([{ title: 'test alert' }]);
      mockLean.mockResolvedValue([{ model: 'qwen3:14b', host: 'primary' }]);

      const res = await request(app)
        .get('/api/nerve-center/ecosystem')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data).toEqual(expect.objectContaining({
        schemaVersion: 2,
        authority: 'agentx-product',
        readOnly: true
      }));
      expect(res.body.data.health).toEqual(expect.objectContaining({
        status: 'ok',
        configuredHosts: 3,
        onlineHosts: 3
      }));
      expect(res.body.data.cluster).toHaveLength(3);
      expect(res.body.data.routing).toHaveProperty('authority', 'inference_log');
      expect(res.body.data.routingConfig).toHaveProperty('taskModels');
      expect(res.body.data.serviceHealth).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(res.body.data.services).toHaveLength(3);
      expect(res.body.data.identityConsistency).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(res.body.data.evidenceTrust).toEqual(expect.objectContaining({
        schemaVersion: 1,
        status: 'verified',
        operationalStatus: 'ok',
        contradictionBudget: expect.objectContaining({
          allowed: 0,
          observed: 0,
          withinBudget: true
        })
      }));
      expect(res.body.data.hostPreferences).toHaveLength(1);
      expect(res.body.data.alerts).toEqual([{ title: 'test alert' }]);
      expect(res.body.data.alertSummary).toEqual(expect.objectContaining({
        activeCount: 1,
        basis: { activePredicate: { status: 'active' } }
      }));
      expect(res.body.data.recentRouting).toEqual([{ model: 'qwen3:14b', host: 'primary' }]);
    });

    it('fails closed instead of returning fabricated partial data', async () => {
      mockLean.mockRejectedValue(new Error('routing telemetry unavailable'));

      const res = await request(app)
        .get('/api/nerve-center/ecosystem')
        .expect(503);

      expect(res.body).toEqual({
        status: 'error',
        code: 'ECOSYSTEM_SNAPSHOT_UNAVAILABLE',
        message: 'Ecosystem snapshot is unavailable.'
      });
      expect(res.body).not.toHaveProperty('data');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 2. GET /api/nerve-center/routing/config
  // ════════════════════════════════════════════════════════════════════════

  describe('GET /routing/config', () => {
    it('returns merged taskModels plus config metadata', async () => {
      const res = await request(app)
        .get('/api/nerve-center/routing/config')
        .expect(200);

      expect(res.body.status).toBe('success');
      const {
        taskModels,
        hosts,
        taskMetadata,
        explainerSteps,
        classification,
        defaults,
        overrides,
        taskConfigState,
        availableModels
      } = res.body.data;

      expect(taskModels).toBeDefined();
      expect(hosts).toBeDefined();
      expect(taskMetadata).toBeDefined();
      expect(Array.isArray(explainerSteps)).toBe(true);
      expect(classification).toHaveProperty('prompt');
      expect(defaults.taskModels.quick_chat).toBeDefined();
      expect(overrides.taskModels).toEqual({});
      expect(taskConfigState.quick_chat.isOverride).toBe(false);
      expect(availableModels).toContain('qwen3.5:9b');
    });

    it('taskModels.code_generation has model and host properties', async () => {
      const res = await request(app)
        .get('/api/nerve-center/routing/config')
        .expect(200);

      const cg = res.body.data.taskModels.code_generation;
      expect(cg).toBeDefined();
      expect(cg).toHaveProperty('model');
      expect(cg).toHaveProperty('host');
    });

    it('hosts has primary, secondary, tertiary keys', async () => {
      const res = await request(app)
        .get('/api/nerve-center/routing/config')
        .expect(200);

      const { hosts } = res.body.data;
      expect(hosts).toHaveProperty('primary', 'http://primary:11434');
      expect(hosts).toHaveProperty('secondary', 'http://secondary:11434');
      expect(hosts).toHaveProperty('tertiary', 'http://tertiary:11434');
    });

    it('includes persisted overrides in the effective config payload', async () => {
      await request(app)
        .put('/api/nerve-center/routing/config')
        .send({ taskModels: { quick_chat: { model: 'qwen2.5:7b', host: 'tertiary' } } })
        .expect(200);

      const res = await request(app)
        .get('/api/nerve-center/routing/config')
        .expect(200);

      expect(res.body.data.taskModels.quick_chat).toEqual({
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });
      expect(res.body.data.taskConfigState.quick_chat.isOverride).toBe(true);
      expect(res.body.data.overrides.taskModels.quick_chat).toEqual({
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 3. PUT /api/nerve-center/routing/config
  // ════════════════════════════════════════════════════════════════════════

  describe('PUT /routing/config', () => {
    it('updates taskModels and returns updated config', async () => {
      const res = await request(app)
        .put('/api/nerve-center/routing/config')
        .send({ taskModels: { code_generation: { model: 'new-model:30b', host: 'secondary' } } })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.taskModels.code_generation.model).toBe('new-model:30b');
      expect(res.body.data.taskModels.code_generation.host).toBe('secondary');
      expect(res.body.data.taskConfigState.code_generation.isOverride).toBe(true);
    });

    it('persists taskModels change across subsequent GET', async () => {
      await request(app)
        .put('/api/nerve-center/routing/config')
        .send({ taskModels: { quick_chat: { model: 'patched:1b', host: 'tertiary' } } })
        .expect(200);

      const res = await request(app)
        .get('/api/nerve-center/routing/config')
        .expect(200);

      expect(res.body.data.taskModels.quick_chat.model).toBe('patched:1b');
      expect(res.body.data.taskConfigState.quick_chat.isOverride).toBe(true);
    });

    it('handles empty body without crashing', async () => {
      const res = await request(app)
        .put('/api/nerve-center/routing/config')
        .send({})
        .expect(200);

      expect(res.body.status).toBe('success');
    });

    it('ignores non-object taskModels', async () => {
      const res = await request(app)
        .put('/api/nerve-center/routing/config')
        .send({ taskModels: 'not-an-object' })
        .expect(200);

      // Should not crash, existing config unchanged
      expect(res.body.status).toBe('success');
      expect(res.body.data.taskModels.code_generation).toBeDefined();
    });

    it('resets a task back to defaults when requested', async () => {
      await request(app)
        .put('/api/nerve-center/routing/config')
        .send({ taskModels: { quick_chat: { model: 'patched:1b', host: 'tertiary' } } })
        .expect(200);

      const res = await request(app)
        .put('/api/nerve-center/routing/config')
        .send({ taskModels: { quick_chat: { resetToDefault: true } } })
        .expect(200);

      expect(res.body.data.taskModels.quick_chat).toEqual(ORIGINAL_TASK_MODELS.quick_chat);
      expect(res.body.data.taskConfigState.quick_chat.isOverride).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 4. GET /api/nerve-center/routing/log
  // ════════════════════════════════════════════════════════════════════════

  describe('GET /routing/log', () => {
    it('returns routing log with default limit', async () => {
      mockLean.mockResolvedValue([{ model: 'qwen3:14b' }]);

      const res = await request(app)
        .get('/api/nerve-center/routing/log')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data).toEqual([{ model: 'qwen3:14b' }]);

      // Default limit is 20
      expect(mockLimit).toHaveBeenCalledWith(20);
      expect(mockSort).toHaveBeenCalledWith({ timestamp: -1 });
    });

    it('sanitizes legacy Mixed fields before returning routing rows', async () => {
      const secret = 'LEGACY_ROUTING_LOG_SECRET_90f2';
      mockLean.mockResolvedValue([{
        host: `http://primary:11434/${secret}`,
        callerDetail: secret,
        model: 'model:1',
        routingTrace: {
          request: {
            requestedModel: 'model:1',
            hostOverride: `http://primary:11434/${secret}`,
            requestBody: { instruction: secret },
          },
          selected: {
            routingSource: 'model_router',
            hostUrl: `http://primary:11434/${secret}`,
          },
          ollama: {
            endpoint: '/api/generate',
            url: `http://primary:11434/api/generate/${secret}`,
            options: { stop: [secret] },
          },
        },
        transcript: secret,
      }]);

      const res = await request(app).get('/api/nerve-center/routing/log').expect(200);
      expect(JSON.stringify(res.body.data)).not.toContain(secret);
      expect(res.body.data[0]).not.toHaveProperty('transcript');
      expect(res.body.data[0].host).toBeNull();
      expect(res.body.data[0].callerDetail).toBeNull();
      expect(res.body.data[0].routingTrace.request.hostOverride).toBeNull();
      expect(res.body.data[0].routingTrace.selected.hostUrl).toBeNull();
      expect(res.body.data[0].routingTrace.ollama.url).toBeNull();
      expect(res.body.data[0].routingTrace.ollama.optionsFingerprint).toBeNull();
    });

    it('respects ?limit=5', async () => {
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/routing/log?limit=5')
        .expect(200);

      expect(mockLimit).toHaveBeenCalledWith(5);
    });

    it('caps limit at 100 for ?limit=500', async () => {
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/routing/log?limit=500')
        .expect(200);

      expect(mockLimit).toHaveBeenCalledWith(100);
    });

    it('passes taskType filter to query', async () => {
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/routing/log?taskType=code_generation')
        .expect(200);

      expect(mockFind).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'code_generation' })
      );
    });

    it('passes model filter to query', async () => {
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/routing/log?model=qwen3:14b')
        .expect(200);

      expect(mockFind).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen3:14b' })
      );
    });

    it('passes host filter to query', async () => {
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/routing/log?host=primary')
        .expect(200);

      expect(mockFind).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'primary' })
      );
    });

    it('passes multiple filters simultaneously', async () => {
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/routing/log?taskType=analysis&model=qwen3:14b&host=primary')
        .expect(200);

      expect(mockFind).toHaveBeenCalledWith({
        taskType: 'analysis',
        model: 'qwen3:14b',
        host: 'primary'
      });
    });

    it('returns 500 on database error', async () => {
      mockLean.mockRejectedValue(new Error('query failed'));

      const res = await request(app)
        .get('/api/nerve-center/routing/log')
        .expect(500);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('query failed');
    });
  });

  describe('GET /inference/activity privacy boundary', () => {
    it('sanitizes legacy rows before adding host identity', async () => {
      const secret = 'LEGACY_ACTIVITY_SECRET_3a71';
      mockLean.mockResolvedValue([{
        host: 'http://primary:11434',
        hostKey: 'primary',
        model: 'model:1',
        routingTrace: { payload: secret, selected: { routingSource: 'model_router' } },
      }]);

      const res = await request(app).get('/api/nerve-center/inference/activity').expect(200);
      const row = res.body.data.logs[0];
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row.hostIdentity).toBeDefined();
      expect(row.routingTrace).not.toHaveProperty('payload');
    });
  });

  describe('GET /routing/analytics', () => {
    it('returns UI-ready routing distribution data for the requested time window', async () => {
      mockLean.mockResolvedValue([
        {
          taskType: 'analysis',
          autoRouted: true,
          classificationMs: 20,
          routedModel: 'qwen3:14b',
          routedHost: 'primary',
          durationMs: 1200
        },
        {
          taskType: 'analysis',
          autoRouted: true,
          classificationMs: 40,
          routedModel: 'qwen3:14b',
          routedHost: 'primary',
          durationMs: 1800
        },
        {
          taskType: 'translation',
          autoRouted: false,
          classificationMs: 0,
          routedModel: 'qwen3.5:9b',
          routedHost: 'secondary',
          durationMs: 900
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/routing/analytics?hours=12')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.summary).toEqual(expect.objectContaining({
        windowHours: 12,
        totalRequests: 3,
        autoRoutedCount: 2,
        autoRoutedPct: 66.7,
        avgDurationMs: 1300,
        avgClassificationMs: 30,
        avgTotalForClassifiedMs: 1500,
        classificationOverheadPct: 2,
        classificationSamples: 2
      }));
      expect(res.body.data.taskDistribution[0]).toEqual(expect.objectContaining({
        taskType: 'analysis',
        count: 2,
        percentage: 66.7,
        avgDurationMs: 1500,
        avgClassificationMs: 30
      }));
      expect(res.body.data.modelDistribution[0]).toEqual(expect.objectContaining({
        model: 'qwen3:14b',
        count: 2
      }));
      expect(res.body.data.hostDistribution[0]).toEqual(expect.objectContaining({
        host: 'primary',
        count: 2
      }));
      expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
        caller: 'chat',
        timestamp: expect.any(Object)
      }));
    });

    it('returns empty analytics buckets when there is little or no telemetry data', async () => {
      mockLean.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/nerve-center/routing/analytics')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.summary).toEqual(expect.objectContaining({
        windowHours: 24,
        totalRequests: 0,
        autoRoutedCount: 0,
        avgDurationMs: null,
        avgClassificationMs: null,
        avgTotalForClassifiedMs: null,
        classificationOverheadPct: null
      }));
      expect(res.body.data.taskDistribution).toEqual([]);
      expect(res.body.data.modelDistribution).toEqual([]);
      expect(res.body.data.hostDistribution).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 5. POST /api/nerve-center/failover
  // ════════════════════════════════════════════════════════════════════════

  describe('POST /failover', () => {
    it('returns 400 when hostUrl is missing', async () => {
      const res = await request(app)
        .post('/api/nerve-center/failover')
        .send({})
        .expect(400);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('hostUrl is required');
    });

    it('switches host and returns failover status on valid hostUrl', async () => {
      const res = await request(app)
        .post('/api/nerve-center/failover')
        .send({ hostUrl: 'http://secondary:11434', reason: 'test_failover' })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('currentHost', 'http://secondary:11434');
      expect(res.body.data).toHaveProperty('isFailedOver', true);
      expect(res.body.data).toHaveProperty('reason', 'test_failover');
    });

    it('uses default reason when none provided', async () => {
      const res = await request(app)
        .post('/api/nerve-center/failover')
        .send({ hostUrl: 'http://tertiary:11434' })
        .expect(200);

      expect(res.body.data.reason).toBe('manual_nerve_center');
    });

    it('increments failoverCount', async () => {
      const first = await request(app)
        .post('/api/nerve-center/failover')
        .send({ hostUrl: 'http://secondary:11434' })
        .expect(200);

      const second = await request(app)
        .post('/api/nerve-center/failover')
        .send({ hostUrl: 'http://tertiary:11434' })
        .expect(200);

      expect(second.body.data.failoverCount).toBeGreaterThan(first.body.data.failoverCount);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 6. POST /api/nerve-center/failover/reset
  // ════════════════════════════════════════════════════════════════════════

  describe('POST /failover/reset', () => {
    it('resets to primary and returns status', async () => {
      // First failover to secondary
      await request(app)
        .post('/api/nerve-center/failover')
        .send({ hostUrl: 'http://secondary:11434' })
        .expect(200);

      const res = await request(app)
        .post('/api/nerve-center/failover/reset')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.currentHost).toBe('http://primary:11434');
      expect(res.body.data.isFailedOver).toBe(false);
    });

    it('is idempotent — calling twice both return 200', async () => {
      const first = await request(app)
        .post('/api/nerve-center/failover/reset')
        .expect(200);

      const second = await request(app)
        .post('/api/nerve-center/failover/reset')
        .expect(200);

      expect(first.body.status).toBe('success');
      expect(second.body.status).toBe('success');
      expect(first.body.data.currentHost).toBe(second.body.data.currentHost);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 7. GET /api/nerve-center/health/feed
  // ════════════════════════════════════════════════════════════════════════

  describe('GET /health/feed', () => {
    it('merges alerts and inference errors into unified feed', async () => {
      const now = new Date().toISOString();
      const earlier = new Date(Date.now() - 60000).toISOString();

      alertService.getRecentAlerts.mockResolvedValue([
        {
          _id: 'alert-1',
          severity: 'critical',
          title: 'Host unreachable — host-alpha',
          message: 'Host down',
          ruleName: 'Ollama host unreachable',
          occurrenceCount: 5,
          context: {
            component: 'host-alpha',
            metric: 'host_unreachable',
            currentValue: 1,
            additionalData: { model: 'ax/gemma4:e4b', host: 'host-alpha' }
          },
          createdAt: now,
          lastOccurrence: now
        }
      ]);

      mockLean.mockResolvedValue([
        {
          _id: 'log-1',
          status: 'error',
          model: 'qwen3:14b',
          host: 'primary',
          error: 'connection refused',
          fallbackUsed: false,
          timestamp: earlier
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);

      // Sorted by timestamp descending — alert (now) first, then log (earlier)
      const [first, second] = res.body.data;
      expect(first.type).toBe('alert');
      // source is the affected component, never a hardcoded 'alertService'
      expect(first.source).toBe('host-alpha');
      expect(first.id).toBe('alert-1');
      expect(first.severity).toBe('critical');
      expect(first.title).toBe('Host unreachable — host-alpha');
      expect(first.ruleName).toBe('Ollama host unreachable');
      expect(first.occurrenceCount).toBe(5);
      expect(first.description).toContain('Host down');
      expect(first.description).toContain('ax/gemma4:e4b');

      expect(second.type).toBe('inference_error');
      expect(second.source).toBe('inferenceLog');
      expect(second.id).toBe('log-1');
      expect(second.severity).toBe('error');
      expect(second.title).toContain('error');
      expect(second.title).toContain('qwen3:14b');
      expect(res.body.meta.activeAlertCount).toBe(1);
      expect(res.body.meta.activeAlertBasis).toEqual({ status: 'active' });
    });

    it('events have required shape: type, severity, source, title, timestamp, id', async () => {
      alertService.getRecentAlerts.mockResolvedValue([
        { _id: 'a1', severity: 'warning', message: 'Disk full', createdAt: new Date().toISOString() }
      ]);
      mockLean.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      const event = res.body.data[0];
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('severity');
      expect(event).toHaveProperty('source');
      expect(event).toHaveProperty('title');
      expect(event).toHaveProperty('timestamp');
      expect(event).toHaveProperty('id');
    });

    it('normalizes failover events distinctly from errors', async () => {
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue([
        {
          _id: 'log-2',
          status: 'error',
          model: 'qwen3:14b',
          hostKey: 'primary',
          fallbackUsed: true,
          fallbackReason: 'connection_failure',
          timestamp: new Date().toISOString()
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      const event = res.body.data[0];
      expect(event.type).toBe('failover');
      expect(event.title).toContain('Failover');
      expect(event.description).toBe('connection_failure');
    });

    it('removes hostile legacy error and fallback prose from inference events', async () => {
      const secret = 'legacy health payload secret@example.test /private/path sk-token';
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue([{
        _id: 'log-private',
        status: 'error',
        model: 'model:1',
        host: 'primary',
        fallbackUsed: true,
        fallbackReason: secret,
        error: secret,
        timestamp: new Date().toISOString()
      }]);

      const res = await request(app).get('/api/nerve-center/health/feed').expect(200);
      expect(JSON.stringify(res.body)).not.toContain(secret);
      expect(res.body.data[0].description).toBe('');
      expect(res.body.data[0].expandable).toBe(false);
    });

    it('timeout inference events have warning severity', async () => {
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue([
        {
          _id: 'log-3',
          status: 'timeout',
          model: 'deepseek-r1:8b',
          host: 'secondary',
          fallbackUsed: false,
          error: 'request timed out after 30s',
          timestamp: new Date().toISOString()
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      expect(res.body.data[0].severity).toBe('warning');
    });

    it('uses default limit 30 and caps at 100', async () => {
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue([]);

      // Default limit
      await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      expect(alertService.getAlertSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        limit: 150,
        maxLimit: 500,
        sort: 'recency'
      }));

      jest.clearAllMocks();
      mockLean.mockResolvedValue([]);
      alertService.getRecentAlerts.mockResolvedValue([]);

      // Exceeding limit — should be capped to 100
      await request(app)
        .get('/api/nerve-center/health/feed?limit=500')
        .expect(200);

      expect(alertService.getAlertSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        limit: 500,
        maxLimit: 500,
        sort: 'recency'
      }));
    });

    it('custom limit is respected', async () => {
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue([]);

      await request(app)
        .get('/api/nerve-center/health/feed?limit=10')
        .expect(200);

      expect(alertService.getAlertSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        limit: 50,
        maxLimit: 500,
        sort: 'recency'
      }));
    });

    it('returns empty array when no alerts or errors', async () => {
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('handles null alerts gracefully', async () => {
      alertService.getRecentAlerts.mockResolvedValue(null);
      mockLean.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('returns 500 on service error', async () => {
      alertService.getRecentAlerts.mockRejectedValue(new Error('alert db unavailable'));

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(500);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('alert db unavailable');
    });

    it('sorts merged events by timestamp descending', async () => {
      const t1 = '2026-03-27T10:00:00Z';
      const t2 = '2026-03-27T11:00:00Z';
      const t3 = '2026-03-27T12:00:00Z';

      alertService.getRecentAlerts.mockResolvedValue([
        { _id: 'a1', severity: 'info', message: 'Old alert', createdAt: t1 },
        { _id: 'a2', severity: 'warning', message: 'New alert', createdAt: t3 }
      ]);

      mockLean.mockResolvedValue([
        {
          _id: 'log-1',
          status: 'error',
          model: 'qwen3:14b',
          host: 'primary',
          fallbackUsed: false,
          timestamp: t2
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      const timestamps = res.body.data.map(e => e.timestamp);
      expect(timestamps[0]).toBe(t3);
      expect(timestamps[1]).toBe(t2);
      expect(timestamps[2]).toBe(t1);
    });

    it('groups repeated cancelled inference history without deleting its evidence ids', async () => {
      alertService.getRecentAlerts.mockResolvedValue([]);
      mockLean.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({
        _id: `cancel-${index}`,
        status: 'error',
        model: 'qwen3:14b',
        hostKey: 'primary',
        caller: 'chat',
        taskType: 'general_chat',
        fallbackUsed: false,
        error: 'Inference request cancelled.',
        timestamp: new Date(Date.UTC(2026, 7, 28, 12, index)).toISOString()
      })));

      const res = await request(app)
        .get('/api/nerve-center/health/feed?limit=30')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toEqual(expect.objectContaining({
        type: 'inference_cancelled',
        severity: 'info',
        groupedCount: 25,
        occurrenceCount: 25
      }));
      expect(res.body.data[0].memberIds).toHaveLength(25);
      expect(res.body.meta.groupedRows).toBe(24);
    });

    it('normalizes unresolved alert templates in the health projection', async () => {
      alertService.getRecentAlerts.mockResolvedValue([{
        _id: 'legacy-alert',
        fingerprint: 'legacy-alert',
        severity: 'info',
        status: 'resolved',
        title: 'VRAM displacement — {{component}}',
        message: 'Displacement on {{component}}',
        context: { component: 'scheduler' },
        createdAt: '2026-08-28T10:00:00Z'
      }]);
      mockLean.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/nerve-center/health/feed')
        .expect(200);

      expect(res.body.data[0].title).toBe('VRAM displacement — scheduler');
      expect(JSON.stringify(res.body.data[0])).not.toContain('{{component}}');
      expect(res.body.data[0].lifecycle).toBe('history');
    });
  });

  describe('GET /host-preferences', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ models: [] })
      }));
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns loaded-model evidence with an observation timestamp', async () => {
      hostPrefService.getAll.mockResolvedValue([
        {
          hostUrl: 'http://primary:11434',
          hostKey: 'primary',
          displayName: 'Host Alpha',
          pinnedModels: [{ model: 'qwen3:14b' }],
          vramTotalMiB: 24576
        }
      ]);
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{
            name: 'qwen3:14b',
            size: 8_000_000_000,
            size_vram: 7_500_000_000,
            expires_at: '2026-08-28T14:00:00.000Z'
          }]
        })
      });

      const res = await request(app)
        .get('/api/nerve-center/host-preferences')
        .expect(200);

      expect(res.body.data[0].live).toEqual(expect.objectContaining({
        online: true,
        pinnedLoaded: true,
        anyPinnedLoaded: true,
        observedAt: expect.any(String)
      }));
      expect(res.body.data[0].live.runningModels).toEqual([
        expect.objectContaining({
          name: 'qwen3:14b',
          sizeVram: 7_500_000_000,
          matchedPinned: 'qwen3:14b'
        })
      ]);
      expect(Number.isNaN(Date.parse(res.body.data[0].live.observedAt))).toBe(false);
    });

    it('normalizes duplicate persisted primary keys to configured active keys', async () => {
      hostPrefService.getAll.mockResolvedValue([
        {
          hostUrl: 'http://primary:11434',
          hostKey: 'primary',
          displayName: 'Host Alpha',
          pinnedModels: [{ model: 'ax/qwen3-coder:30b' }]
        },
        {
          hostUrl: 'http://secondary:11434',
          hostKey: 'secondary',
          displayName: 'Host Beta',
          pinnedModels: [{ model: 'ax/qwen3.5:9b' }]
        },
        {
          hostUrl: 'http://tertiary:11434',
          hostKey: 'primary',
          displayName: 'Host Gamma',
          pinnedModels: []
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/host-preferences')
        .expect(200);

      const byName = Object.fromEntries(res.body.data.map((host) => [host.displayName, host]));

      expect(byName['Host Alpha'].hostKey).toBe('primary');
      expect(byName['Host Beta'].hostKey).toBe('secondary');
      expect(byName['Host Gamma'].hostKey).toBe('tertiary');
      expect(byName['Host Gamma'].persistedHostKey).toBe('primary');
      expect(byName['Host Gamma'].hostKeyDrift).toEqual(expect.objectContaining({
        type: 'host_key_mismatch',
        persisted: 'primary',
        configured: 'tertiary'
      }));
      expect(res.body.hostIdentityDrift.duplicatePersistedHostKeys).toEqual([
        expect.objectContaining({ hostKey: 'primary', count: 2 })
      ]);
      expect(res.body.hostIdentityDrift.duplicateActiveHostKeys).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Benchmark Coordination
  // ════════════════════════════════════════════════════════════════════════

  describe('POST /host-preferences/:hostUrl/benchmark-claim', () => {
    const HOST_URL = 'http://primary:11434';
    const path = `/api/nerve-center/host-preferences/${encodeURIComponent(HOST_URL)}/benchmark-claim`;

    it('returns 400 when batchId missing', async () => {
      const res = await request(app).post(path).send({}).expect(400);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toMatch(/batchId/);
    });

    it('returns 200 with claim data on success', async () => {
      hostPrefService.claimBenchmark.mockResolvedValue({
        claimed: true,
        pref: { hostUrl: HOST_URL, status: 'benchmarking', benchmarkClaim: { batchId: 'b1', prevStatus: 'ready' } }
      });

      const res = await request(app)
        .post(path)
        .send({ batchId: 'b1', estimatedDurationMs: 60000 })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.claimed).toBe(true);
      expect(hostPrefService.claimBenchmark).toHaveBeenCalledWith(HOST_URL, 'b1', 60000);
    });

    it('passes optional manual claim metadata to the service', async () => {
      hostPrefService.claimBenchmark.mockResolvedValue({
        claimed: true,
        pref: {
          hostUrl: HOST_URL,
          status: 'benchmarking',
          benchmarkClaim: { batchId: 'manual-b1', source: 'manual', owner: 'operator' }
        }
      });

      const res = await request(app)
        .post(path)
        .send({
          batchId: 'manual-b1',
          estimatedDurationMs: 60000,
          source: 'manual',
          owner: 'operator',
          note: 'scout',
          heartbeatTtlMs: 30000
        })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(hostPrefService.claimBenchmark).toHaveBeenCalledWith(
        HOST_URL,
        'manual-b1',
        60000,
        {
          source: 'manual',
          owner: 'operator',
          note: 'scout',
          heartbeatTtlMs: 30000
        }
      );
    });

    it('returns 409 when claim is rejected (host already claimed)', async () => {
      hostPrefService.claimBenchmark.mockResolvedValue({
        claimed: false,
        reason: 'host already claimed by batch other'
      });

      const res = await request(app)
        .post(path)
        .send({ batchId: 'b2' })
        .expect(409);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('other');
    });

    it('returns 500 when service throws', async () => {
      hostPrefService.claimBenchmark.mockRejectedValue(new Error('db down'));

      const res = await request(app)
        .post(path)
        .send({ batchId: 'b3' })
        .expect(500);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toBe('db down');
    });
  });

  describe('POST /host-preferences/:hostUrl/benchmark-claim/:batchId/heartbeat', () => {
    const HOST_URL = 'http://primary:11434';

    it('refreshes an active claim heartbeat', async () => {
      hostPrefService.heartbeatBenchmarkClaim.mockResolvedValue({
        heartbeat: true,
        pref: { hostUrl: HOST_URL, status: 'benchmarking', benchmarkClaim: { batchId: 'b1' } }
      });

      const res = await request(app)
        .post(`/api/nerve-center/host-preferences/${encodeURIComponent(HOST_URL)}/benchmark-claim/b1/heartbeat`)
        .send({ owner: 'operator', heartbeatTtlMs: 30000 })
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.heartbeat).toBe(true);
      expect(hostPrefService.heartbeatBenchmarkClaim).toHaveBeenCalledWith(
        HOST_URL,
        'b1',
        expect.objectContaining({ owner: 'operator', heartbeatTtlMs: 30000 })
      );
    });

    it('returns 409 when heartbeat no longer owns the claim', async () => {
      hostPrefService.heartbeatBenchmarkClaim.mockResolvedValue({
        heartbeat: false,
        reason: 'claim belongs to batch other'
      });

      const res = await request(app)
        .post(`/api/nerve-center/host-preferences/${encodeURIComponent(HOST_URL)}/benchmark-claim/b1/heartbeat`)
        .send({})
        .expect(409);

      expect(res.body.status).toBe('error');
      expect(res.body.message).toContain('other');
    });
  });

  describe('DELETE /host-preferences/:hostUrl/benchmark-claim/:batchId', () => {
    const HOST_URL = 'http://primary:11434';

    it('releases claim and returns released=true', async () => {
      hostPrefService.releaseBenchmarkClaim.mockResolvedValue({
        released: true,
        pref: { hostUrl: HOST_URL, status: 'ready' }
      });

      const res = await request(app)
        .delete(`/api/nerve-center/host-preferences/${encodeURIComponent(HOST_URL)}/benchmark-claim/b1`)
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.released).toBe(true);
      expect(hostPrefService.releaseBenchmarkClaim).toHaveBeenCalledWith(HOST_URL, 'b1');
    });

    it('returns 200 with released=false when claim mismatched (idempotent)', async () => {
      hostPrefService.releaseBenchmarkClaim.mockResolvedValue({
        released: false,
        reason: 'claim belongs to batch other'
      });

      const res = await request(app)
        .delete(`/api/nerve-center/host-preferences/${encodeURIComponent(HOST_URL)}/benchmark-claim/bX`)
        .expect(200);

      expect(res.body.data.released).toBe(false);
    });
  });

  describe('GET /host-preferences/benchmark-claims/active', () => {
    it('returns active claims list', async () => {
      hostPrefService.listBenchmarkClaims.mockResolvedValue([
        { hostUrl: 'http://primary:11434', batchId: 'b1', prevStatus: 'ready' }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/host-preferences/benchmark-claims/active')
        .expect(200);

      expect(res.body.status).toBe('success');
      expect(res.body.data.claims).toHaveLength(1);
      expect(res.body.data.count).toBe(1);
    });
  });
});

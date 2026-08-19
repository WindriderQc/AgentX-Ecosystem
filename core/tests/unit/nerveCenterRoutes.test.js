// nerveCenterRoutes.test.js

// Set env vars BEFORE requiring modules
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';
process.env.MODEL_HEALTH_CACHE_TTL_MS = '0';
process.env.NODE_ENV = 'test';

// Mock dependencies
jest.mock('node-fetch', () => jest.fn(() =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
));

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/services/alertService', () => {
  const mock = {
    getRecentAlerts: jest.fn(() => Promise.resolve([
      {
        _id: 'alert-1',
        severity: 'warning',
        message: 'High latency on primary',
        details: 'Latency > 5000ms',
        createdAt: new Date('2026-03-27T10:00:00Z')
      }
    ])),
    getStatistics: jest.fn(() => Promise.resolve({})),
    getAlertService: jest.fn()
  };
  mock.getAlertService = () => mock;
  return mock;
});

const mockInferenceLogLean = jest.fn();
const mockInferenceLogLimit = jest.fn(() => ({ lean: mockInferenceLogLean }));
const mockInferenceLogSort = jest.fn(() => ({ limit: mockInferenceLogLimit, lean: mockInferenceLogLean }));
const mockLatestInferenceLean = jest.fn(() => Promise.resolve(null));
const mockLatestInferenceSort = jest.fn(() => ({ lean: mockLatestInferenceLean }));
const mockInferenceLogFind = jest.fn(() => ({
  sort: mockInferenceLogSort,
  limit: mockInferenceLogLimit,
  lean: mockInferenceLogLean,
  select: jest.fn(() => ({ lean: mockInferenceLogLean }))
}));

jest.mock('../../models/InferenceLog', () => {
  const rows = [
    {
      _id: 'log-1',
      host: 'http://primary:11434',
      hostKey: 'primary',
      model: 'qwen2.5:7b',
      taskType: 'general_chat',
      status: 'success',
      durationMs: 1200,
      tokensIn: 1000,
      tokensOut: 250,
      timestamp: new Date('2026-03-27T09:55:00Z')
    }
  ];
  mockInferenceLogLean.mockResolvedValue(rows);
  return {
    find: mockInferenceLogFind,
    findOne: jest.fn(() => ({ sort: mockLatestInferenceSort })),
    countDocuments: jest.fn(() => Promise.resolve(0))
  };
});

jest.mock('../../src/services/costCalculator', () => ({
  calculateMessageCost: jest.fn(() => Promise.resolve({ totalCost: 0.0015 }))
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(() => Promise.resolve([
    {
      hostUrl: 'http://primary:11434',
      preferredModel: 'qwen3-2507-30b-long-48k:latest',
      state: 'ready'
    }
  ])),
  get: jest.fn(() => Promise.resolve(null)),
  upsert: jest.fn(() => Promise.resolve({})),
  reload: jest.fn(() => Promise.resolve())
}));

const mockRouterTaskOverrideState = new Map();

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
    mockRouterTaskOverrideState.clear();
    return Promise.resolve({ deletedCount: mockRouterTaskOverrideState.size });
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

const { buildIntelligenceSummary, getRoutingConfig, buildInferenceStats, buildRoutingAnalytics } = require('../../routes/nerve-center');
const { calculateMessageCost } = require('../../src/services/costCalculator');
const { resetAllTaskModelOverrides, saveTaskModelOverride } = require('../../src/services/modelRouterConfig');

describe('Nerve Center Routes — Unit Tests', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRouterTaskOverrideState.clear();
    mockInferenceLogLean.mockResolvedValue([
      {
        _id: 'log-1',
        host: 'http://primary:11434',
        hostKey: 'primary',
        model: 'qwen2.5:7b',
        taskType: 'general_chat',
        status: 'success',
        durationMs: 1200,
        tokensIn: 1000,
        tokensOut: 250,
        timestamp: new Date('2026-03-27T09:55:00Z')
      }
    ]);
    await resetAllTaskModelOverrides();
  });

  describe('getRoutingConfig()', () => {
    it('should return taskModels, hosts, and routing explainer metadata', async () => {
      const config = await getRoutingConfig();

      expect(config).toHaveProperty('taskModels');
      expect(config).toHaveProperty('hosts');
      expect(config).toHaveProperty('taskMetadata');
      expect(config).toHaveProperty('explainerSteps');
      expect(config).toHaveProperty('classification');
      expect(config).toHaveProperty('defaults');
      expect(config).toHaveProperty('overrides');
      expect(config).toHaveProperty('taskConfigState');
      expect(config).toHaveProperty('availableModels');
      expect(typeof config.taskModels).toBe('object');
      expect(typeof config.hosts).toBe('object');
      expect(typeof config.taskMetadata).toBe('object');
      expect(Array.isArray(config.explainerSteps)).toBe(true);
      expect(config.classification).toHaveProperty('prompt');
      expect(Array.isArray(config.availableModels)).toBe(true);
    });

    it('should include known host keys', async () => {
      const config = await getRoutingConfig();
      expect(config.hosts).toHaveProperty('primary');
      expect(config.hosts).toHaveProperty('secondary');
      expect(config.hosts).toHaveProperty('tertiary');
    });

    it('should have TASK_MODELS with model and host per task type', async () => {
      const config = await getRoutingConfig();
      const taskKeys = Object.keys(config.taskModels);
      expect(taskKeys.length).toBeGreaterThan(0);

      for (const key of taskKeys) {
        const entry = config.taskModels[key];
        expect(entry).toHaveProperty('model');
        expect(entry).toHaveProperty('host');
      }
    });

    it('should expose default-vs-override state per task', async () => {
      await saveTaskModelOverride('quick_chat', {
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });

      const config = await getRoutingConfig();

      expect(config.taskConfigState.quick_chat.isOverride).toBe(true);
      expect(config.taskConfigState.quick_chat.override).toEqual({
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });
      expect(config.taskModels.quick_chat).toEqual({
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });
      expect(config.defaults.taskModels.quick_chat).toEqual({
        model: 'gemma4:26b-a4b-it-qat',
        host: 'secondary'
      });
    });
  });

  describe('buildIntelligenceSummary()', () => {
    it('should return expected top-level keys', async () => {
      const summary = await buildIntelligenceSummary();

      expect(summary).toHaveProperty('cluster');
      expect(summary).toHaveProperty('routing');
      expect(summary).toHaveProperty('hostPreferences');
      expect(summary).toHaveProperty('alerts');
      expect(summary).toHaveProperty('recentRouting');
    });

    it('should return routing with failover state fields', async () => {
      const summary = await buildIntelligenceSummary();

      expect(summary.routing).toHaveProperty('currentHost');
      expect(summary.routing).toHaveProperty('isFailedOver');
      expect(summary.routing).toHaveProperty('primaryHost');
    });

    it('should return hostPreferences as an array', async () => {
      const summary = await buildIntelligenceSummary();

      expect(Array.isArray(summary.hostPreferences)).toBe(true);
      expect(summary.hostPreferences.length).toBeGreaterThan(0);
      expect(summary.hostPreferences[0]).toHaveProperty('hostUrl');
      expect(summary.hostPreferences[0]).toHaveProperty('preferredModel');
    });

    it('should return alerts as an array', async () => {
      const summary = await buildIntelligenceSummary();

      expect(Array.isArray(summary.alerts)).toBe(true);
      expect(summary.alerts.length).toBeGreaterThan(0);
      expect(summary.alerts[0]).toHaveProperty('severity');
    });

    it('should return recentRouting as an array of inference logs', async () => {
      const summary = await buildIntelligenceSummary();

      expect(Array.isArray(summary.recentRouting)).toBe(true);
      expect(summary.recentRouting.length).toBeGreaterThan(0);
      expect(summary.recentRouting[0]).toHaveProperty('model');
      expect(summary.recentRouting[0]).toHaveProperty('host');
    });
  });

  describe('buildRoutingAnalytics()', () => {
    it('should summarize task, model, and host distributions for chat routing telemetry', async () => {
      const analyticsRows = [
        {
          taskType: 'analysis',
          autoRouted: true,
          classificationMs: 25,
          routedModel: 'qwen3-2507-30b-long-48k',
          routedHost: 'primary',
          durationMs: 1500
        },
        {
          taskType: 'analysis',
          autoRouted: true,
          classificationMs: 35,
          routedModel: 'qwen3-2507-30b-long-48k',
          routedHost: 'primary',
          durationMs: 2500
        },
        {
          taskType: 'translation',
          autoRouted: false,
          classificationMs: 0,
          routedModel: 'qwen3.5:9b',
          routedHost: 'secondary',
          durationMs: 1000
        }
      ];

      mockInferenceLogLean.mockResolvedValueOnce(analyticsRows);

      const analytics = await buildRoutingAnalytics(6, new Date('2026-03-27T12:00:00Z'));

      expect(analytics.summary).toEqual(expect.objectContaining({
        windowHours: 6,
        totalRequests: 3,
        autoRoutedCount: 2,
        autoRoutedPct: 66.7,
        avgDurationMs: 1666.7,
        avgClassificationMs: 20
      }));
      expect(analytics.taskDistribution[0]).toEqual(expect.objectContaining({
        taskType: 'analysis',
        count: 2,
        avgDurationMs: 2000,
        avgClassificationMs: 30,
        percentage: 66.7
      }));
      expect(analytics.modelDistribution[0]).toEqual(expect.objectContaining({
        model: 'qwen3-2507-30b-long-48k',
        count: 2
      }));
      expect(analytics.hostDistribution[0]).toEqual(expect.objectContaining({
        host: 'primary',
        count: 2
      }));
    });
  });

  describe('buildInferenceStats()', () => {
    it('should return today inference count and total cost', async () => {
      const stats = await buildInferenceStats(new Date('2026-03-27T12:00:00Z'));

      expect(stats).toEqual({
        count: 1,
        totalCost: 0.0015
      });
      expect(calculateMessageCost).toHaveBeenCalledWith('qwen2.5:7b', expect.objectContaining({
        usage: expect.objectContaining({
          promptTokens: 1000,
          completionTokens: 250,
          totalTokens: 1250
        })
      }));
    });
  });
});

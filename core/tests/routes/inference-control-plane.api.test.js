const express = require('express');
const request = require('supertest');

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_2 = 'http://secondary:11434';

jest.mock('node-fetch', () => jest.fn());

const mockRoutingStatus = {
  hosts: {
    primary: { url: 'http://primary:11434', status: 'online' }
  },
  taskModels: {
    quick_chat: { model: 'qwen3.5:9b', host: 'primary' }
  }
};

const mockRouterConfig = {
  taskModels: mockRoutingStatus.taskModels,
  taskMetadata: {
    quick_chat: { title: 'Quick Chat', description: 'Fast replies.' }
  },
  explainerSteps: ['Classify the request', 'Select the configured host and model'],
  classification: {
    model: 'qwen3.5:9b',
    host: 'primary',
    hostUrl: 'http://primary:11434'
  },
  defaults: { taskModels: mockRoutingStatus.taskModels },
  overrides: { taskModels: {} },
  taskConfigState: {},
  availableModels: ['qwen3.5:9b']
};

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(async () => mockRoutingStatus),
  classifyQuery: jest.fn(async () => 'quick_chat'),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://primary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn(() => 'primary')
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: {
    primary: 'http://primary:11434',
    secondary: 'http://secondary:11434'
  },
  TASK_MODELS: mockRoutingStatus.taskModels,
  buildRouterConfigPayload: jest.fn(async () => mockRouterConfig),
  ensureTaskModelOverridesLoaded: jest.fn(async () => ({})),
  getAdvisoryModelForTask: jest.fn(),
  getDefaultTaskModels: jest.fn(() => mockRoutingStatus.taskModels),
  getModelForTask: jest.fn(() => ({
    model: 'qwen3.5:9b',
    host: 'primary',
    url: 'http://primary:11434'
  })),
  resolvePreferredTaskEntry: jest.fn(),
  resetAllTaskModelOverrides: jest.fn(),
  resetTaskModelOverride: jest.fn(),
  saveTaskModelOverride: jest.fn()
}));

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: jest.fn(() => ({}))
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(),
  isReadyStage: jest.fn()
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(async () => null),
  hasActiveBenchmarkClaim: jest.fn(() => false)
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));

const fetch = require('node-fetch');
const hostGate = require('../../src/services/hostGate');
const {
  getAllModelsHealth,
  getModelHealth,
  getRoutingStatus
} = require('../../src/services/modelRouter');
const { buildRouterConfigPayload } = require('../../src/services/modelRouterConfig');
const inferenceRoutes = require('../../routes/inference');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', inferenceRoutes);
  return app;
}

describe('Inference control-plane API', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    app = buildApp();
  });

  it('lists Ollama models and hides a base model when its ax/ variant exists', async () => {
    fetch.mockResolvedValueOnce({
      json: async () => ({
        models: [
          { name: 'qwen3.5:9b', size: 9, modified_at: '2026-07-01T00:00:00Z' },
          { name: 'ax/qwen3.5:9b', size: 10, modified_at: '2026-07-02T00:00:00Z' },
          { name: 'nomic-embed-text:v1.5', size: 1, modified_at: '2026-07-03T00:00:00Z' }
        ]
      })
    });

    const response = await request(app)
      .get('/api/ollama/models')
      .query({ target: 'primary' })
      .expect(200);

    expect(fetch).toHaveBeenCalledWith('http://primary:11434/api/tags');
    expect(response.body).toEqual({
      status: 'success',
      data: [
        { name: 'ax/qwen3.5:9b', size: 10, modified_at: '2026-07-02T00:00:00Z' },
        { name: 'nomic-embed-text:v1.5', size: 1, modified_at: '2026-07-03T00:00:00Z' }
      ]
    });
  });

  it('rejects an arbitrary Ollama catalog target before proxying', async () => {
    const response = await request(app)
      .get('/api/ollama/models')
      .query({ target: 'http://192.0.2.77:11434' })
      .expect(400);

    expect(response.body.message).toMatch(/allowlist/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns health for one allowlisted host and model', async () => {
    getModelHealth.mockResolvedValueOnce({ status: 'healthy', latency: 18 });

    const response = await request(app)
      .get('/api/models/health')
      .query({ host: 'primary', model: 'qwen3.5:9b' })
      .expect(200);

    expect(getModelHealth).toHaveBeenCalledWith('http://primary:11434', 'qwen3.5:9b');
    expect(response.body.data.health).toEqual({ status: 'healthy', latency: 18 });
  });

  it('returns the aggregate model-health view when no pair is requested', async () => {
    getAllModelsHealth.mockResolvedValueOnce([
      { model: 'qwen3.5:9b', host: 'primary', status: 'healthy' }
    ]);

    const response = await request(app)
      .get('/api/models/health')
      .expect(200);

    expect(getAllModelsHealth).toHaveBeenCalledTimes(1);
    expect(response.body.data.models).toHaveLength(1);
  });

  it('combines live routing status with the effective operator config', async () => {
    const response = await request(app)
      .get('/api/models/routing')
      .expect(200);

    expect(getRoutingStatus).toHaveBeenCalledTimes(1);
    expect(buildRouterConfigPayload).toHaveBeenCalledTimes(1);
    expect(response.body.data.hosts.primary.status).toBe('online');
    expect(response.body.data.taskMetadata.quick_chat.title).toBe('Quick Chat');
    expect(response.body.data.availableModels).toContain('qwen3.5:9b');
  });

  it('exposes admission-gate statistics', async () => {
    const response = await request(app)
      .get('/api/router/gate-stats')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data).toEqual(expect.objectContaining({ entries: {} }));
  });
});

const express = require('express');
const request = require('supertest');

const mockDefaultTaskModels = {
  quick_chat: { model: 'qwen3.5:9b', host: 'secondary' },
  general_chat: { model: 'qwen3-2507-30b-long-48k', host: 'primary' },
  code_generation: { model: 'qwen3-2507-30b-long-48k', host: 'primary' },
  code_review: { model: 'qwen3-2507-30b-long-48k', host: 'primary' },
  deep_reasoning: { model: 'qwen3.5:9b', host: 'secondary' },
  analysis: { model: 'qwen3-2507-30b-long-48k', host: 'primary' },
  summarization: { model: 'qwen2.5:7b', host: 'tertiary' },
  translation: { model: 'qwen2.5:7b', host: 'tertiary' },
  rag_query_expansion: { model: 'qwen2.5:7b', host: 'tertiary' },
  rag_reranking: { model: 'qwen2.5:7b', host: 'tertiary' },
  rag_compression: { model: 'qwen2.5:7b', host: 'tertiary' },
  nestor_answer_light: { model: 'ax/gemma4:26b-a4b-it-qat', host: 'primary' },
  voice_persona_chat: { model: 'qwen3.5:9b', host: 'secondary' },
  voice_persona_reader: { model: 'qwen3.5:9b', host: 'secondary' },
  janitor_ai: { model: 'qwen2.5:7b', host: 'tertiary' },
  embeddings: { model: 'nomic-embed-text:v1.5', host: 'tertiary' }
};

const mockHosts = {
  primary: 'http://primary:11434',
  secondary: 'http://secondary:11434',
  tertiary: 'http://tertiary:11434'
};

let mockEffectiveTaskModels;
let mockOverrides;

function mockClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mockResetConfigState() {
  mockEffectiveTaskModels = mockClone(mockDefaultTaskModels);
  mockOverrides = {};
}

function mockGetTaskConfigState() {
  return Object.fromEntries(Object.keys(mockDefaultTaskModels).map((taskType) => [
    taskType,
    {
      default: mockClone(mockDefaultTaskModels[taskType]),
      override: mockOverrides[taskType] ? mockClone(mockOverrides[taskType]) : null,
      effective: mockClone(mockEffectiveTaskModels[taskType]),
      isOverride: !!mockOverrides[taskType]
    }
  ]));
}

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(async () => ({
    hosts: {
      primary: { url: mockHosts.primary, status: 'online' },
      secondary: { url: mockHosts.secondary, status: 'online' },
      tertiary: { url: mockHosts.tertiary, status: 'online' }
    },
    taskModels: mockClone(mockEffectiveTaskModels)
  })),
  classifyQuery: jest.fn(async () => 'quick_chat'),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => mockHosts.primary),
  recordInference: jest.fn()
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: mockHosts,
  TASK_MODELS: mockDefaultTaskModels,
  buildRouterConfigPayload: jest.fn(async () => ({
    taskModels: mockClone(mockEffectiveTaskModels),
    hosts: { ...mockHosts },
    defaults: {
      taskModels: mockClone(mockDefaultTaskModels)
    },
    overrides: {
      taskModels: mockClone(mockOverrides)
    },
    taskConfigState: mockGetTaskConfigState(),
    availableModels: ['qwen2.5:7b', 'qwen3-2507-30b-long-48k', 'qwen3.5:9b'],
    taskMetadata: {
      quick_chat: { title: 'Quick Chat', description: 'Fast replies.' },
      nestor_answer_light: { title: 'Nestor Answer Light', description: 'Local fast replies.' },
      voice_persona_reader: { title: 'Voice Persona Reader', description: 'Kid reader lane.' }
    },
    explainerSteps: ['step 1'],
    classification: {
      model: 'qwen3.5:9b',
      host: 'secondary',
      hostUrl: mockHosts.secondary,
      prompt: 'Classifier prompt'
    }
  })),
  ensureTaskModelOverridesLoaded: jest.fn(async () => mockClone(mockOverrides)),
  getDefaultTaskModels: jest.fn(() => mockClone(mockDefaultTaskModels)),
  getModelForTask: jest.fn((taskType) => {
    const task = mockEffectiveTaskModels[taskType] || mockEffectiveTaskModels.general_chat;
    return {
      model: task.model,
      host: task.host,
      url: mockHosts[task.host]
    };
  }),
  resetAllTaskModelOverrides: jest.fn(async () => {
    mockResetConfigState();
    return mockGetTaskConfigState();
  }),
  resetTaskModelOverride: jest.fn(async (taskType) => {
    delete mockOverrides[taskType];
    mockEffectiveTaskModels[taskType] = mockClone(mockDefaultTaskModels[taskType]);
    return mockGetTaskConfigState()[taskType];
  }),
  saveTaskModelOverride: jest.fn(async (taskType, entry) => {
    mockOverrides[taskType] = {
      model: entry.model,
      host: entry.host
    };
    mockEffectiveTaskModels[taskType] = mockClone(mockOverrides[taskType]);
    return mockGetTaskConfigState()[taskType];
  })
}));

jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: jest.fn(() => ({}))
}));

const app = express();
app.use(express.json());
app.use('/api', require('../../routes/api'));

describe('Router Config API Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResetConfigState();
  });

  it('returns merged effective router config', async () => {
    const response = await request(app)
      .get('/api/router/config')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.taskModels.quick_chat).toEqual(mockDefaultTaskModels.quick_chat);
    expect(response.body.data.defaults.taskModels.quick_chat).toEqual(mockDefaultTaskModels.quick_chat);
    expect(response.body.data.taskModels.voice_persona_reader).toEqual(mockDefaultTaskModels.voice_persona_reader);
    expect(response.body.data.taskModels.nestor_answer_light).toEqual(mockDefaultTaskModels.nestor_answer_light);
    expect(response.body.data.taskMetadata.voice_persona_reader.title).toBe('Voice Persona Reader');
    expect(response.body.data.taskConfigState.quick_chat.isOverride).toBe(false);
    expect(response.body.data.availableModels).toContain('qwen3.5:9b');
  });

  it('updates a single task override and reflects it immediately in classification routing', async () => {
    await request(app)
      .put('/api/router/config/tasks/quick_chat')
      .send({ model: 'qwen2.5:7b', host: 'tertiary' })
      .expect(200);

    const configResponse = await request(app)
      .get('/api/router/config')
      .expect(200);

    expect(configResponse.body.data.taskModels.quick_chat).toEqual({
      model: 'qwen2.5:7b',
      host: 'tertiary'
    });
    expect(configResponse.body.data.taskConfigState.quick_chat.isOverride).toBe(true);

    const classifyResponse = await request(app)
      .post('/api/models/classify')
      .send({ message: 'hey there' })
      .expect(200);

    expect(classifyResponse.body.data).toEqual({
      taskType: 'quick_chat',
      recommendedModel: 'qwen2.5:7b',
      recommendedHost: 'tertiary',
      hostUrl: mockHosts.tertiary
    });
  });

  it('returns hardcoded defaults separately', async () => {
    await request(app)
      .put('/api/router/config/tasks/quick_chat')
      .send({ model: 'qwen2.5:7b', host: 'tertiary' })
      .expect(200);

    const response = await request(app)
      .get('/api/router/config/defaults')
      .expect(200);

    expect(response.body.data.taskModels.quick_chat).toEqual(mockDefaultTaskModels.quick_chat);
    expect(response.body.data.hosts).toEqual(mockHosts);
  });

  it('rejects an unconfirmed bulk reset without changing app overrides', async () => {
    await request(app)
      .put('/api/router/config/tasks/quick_chat')
      .send({ model: 'qwen2.5:7b', host: 'tertiary' })
      .expect(200);

    const response = await request(app)
      .post('/api/router/config/reset')
      .expect(409);

    expect(response.body.code).toBe('deployment_defaults_confirmation_required');
    expect(mockOverrides.quick_chat).toEqual({ model: 'qwen2.5:7b', host: 'tertiary' });
  });

  it('resets overrides back to reviewed deployment defaults when explicitly confirmed', async () => {
    await request(app)
      .put('/api/router/config/tasks/quick_chat')
      .send({ model: 'qwen2.5:7b', host: 'tertiary' })
      .expect(200);

    const response = await request(app)
      .post('/api/router/config/reset')
      .send({ confirmDeploymentDefaults: true })
      .expect(200);

    expect(response.body.data.taskModels.quick_chat).toEqual(mockDefaultTaskModels.quick_chat);
    expect(response.body.data.taskConfigState.quick_chat.isOverride).toBe(false);
    expect(response.body.data.overrides.taskModels).toEqual({});
  });
});

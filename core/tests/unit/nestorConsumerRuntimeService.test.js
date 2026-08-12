'use strict';

const mockValidateHostUrl = jest.fn((host) => ({ valid: true, host }));
const mockGetAdvisoryModelForTask = jest.fn();

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  validateHostUrl: (...args) => mockValidateHostUrl(...args),
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: { local: 'http://local:11434' },
  ensureTaskModelOverridesLoaded: jest.fn().mockResolvedValue(undefined),
  getTaskModelConfigState: jest.fn(() => ({
    buddy_chat: {
      default: { model: 'chat-default', host: 'local' },
      override: null,
      effective: { model: 'chat-default', host: 'local' },
      isOverride: false,
    },
    buddy_reaction: {
      default: { model: 'react-default', host: 'local' },
      override: { model: 'react-override', host: 'local' },
      effective: { model: 'react-override', host: 'local' },
      isOverride: true,
    },
    analysis: {
      default: { model: 'analysis-default', host: 'local' },
      override: null,
      effective: { model: 'analysis-default', host: 'local' },
      isOverride: false,
    },
  })),
  getAdvisoryModelForTask: (...args) => mockGetAdvisoryModelForTask(...args),
}));

const {
  normalizeRequest,
  executeInference,
  getRouterSnapshot,
} = require('../../src/services/nestorConsumerRuntimeService');

function response(body, headers = {}, status = 200) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: (name) => normalizedHeaders[String(name).toLowerCase()] || null },
  };
}

describe('Nestor consumer inference runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateHostUrl.mockImplementation((host) => ({ valid: true, host: `http://${host}:11434` }));
  });

  it('maps operations to fixed task types and emits a nestor/* callerDetail', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(
      { message: { content: 'hello' }, prompt_eval_count: 10, eval_count: 4 },
      {
        'x-resolved-model': 'ax/chat-model',
        'x-routed-host': 'http://host:11434',
        'x-routed-host-key': 'local',
        'x-routing-source': 'task_router',
        'x-inference-lane': 'interactive',
        'x-routing-task-type': 'buddy_chat',
      }
    ));

    const result = await executeInference({
      operation: 'chat',
      messages: [{ role: 'system', content: 'Nestor owns this prompt.' }, { role: 'user', content: 'Hi' }],
      requested: { host: 'local', model: '' },
      context: { surface: 'desktop', sessionId: 'opaque' },
    }, { fetchImpl, port: 3080 });

    const forwarded = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(fetchImpl.mock.calls[0][1].headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json',
      'x-agentx-internal-nestor-consumer': expect.any(String),
    }));
    expect(forwarded).toEqual(expect.objectContaining({
      taskType: 'buddy_chat',
      callerDetail: 'nestor/desktop/chat',
      host: 'http://local:11434',
      responseMode: 'normalized',
      stream: false,
    }));
    expect(result).toEqual(expect.objectContaining({
      operation: 'chat',
      taskType: 'buddy_chat',
      callerDetail: 'nestor/desktop/chat',
      reply: 'hello',
    }));
    expect(result.provenance).toEqual(expect.objectContaining({
      lane: 'interactive',
      routingSource: 'task_router',
    }));
  });

  it('rejects invalid roles, oversized content, unknown operations, and unsafe surfaces', () => {
    expect(() => normalizeRequest({ operation: 'tool', messages: [{ role: 'user', content: 'x' }] }))
      .toThrow(/operation must be one of/);
    expect(() => normalizeRequest({ operation: 'chat', messages: [{ role: 'tool', content: 'x' }] }))
      .toThrow(/role must be/);
    expect(() => normalizeRequest({ operation: 'chat', messages: [{ role: 'user', content: 'x'.repeat(8001) }] }))
      .toThrow(/exceeds 8000/);
    expect(() => normalizeRequest({
      operation: 'chat',
      messages: [{ role: 'user', content: 'x' }],
      context: { surface: '../benchmark' },
    })).toThrow(/surface/);
  });

  it('rejects a requested host before the internal inference call when allowlisting fails', async () => {
    mockValidateHostUrl.mockReturnValue({ valid: false, message: 'host is not configured' });
    const fetchImpl = jest.fn();
    await expect(executeInference({
      operation: 'react',
      messages: [{ role: 'user', content: 'React' }],
      requested: { host: 'http://attacker.invalid' },
    }, { fetchImpl })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_HOST' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports default/override provenance without mutating router state', async () => {
    mockGetAdvisoryModelForTask.mockImplementation(async (taskType) => ({
      model: `${taskType}-model`,
      host: 'local',
      url: 'http://local:11434',
      source: 'configured_host',
      reason: 'configured',
      readiness: { stage: 'ready' },
    }));
    const snapshot = await getRouterSnapshot();
    expect(snapshot.modelCatalog).toBe('/api/models/all');
    expect(snapshot.modelCatalogMode).toBe('embedded-in-routes');
    expect(snapshot.routes.chat.provenance).toBe('router-default');
    expect(snapshot.routes.react.provenance).toBe('operator-override');
    expect(snapshot.routes.analyze.taskType).toBe('analysis');
    expect(Object.values(snapshot.routes).every((route) => route.lane === 'interactive')).toBe(true);
  });
});

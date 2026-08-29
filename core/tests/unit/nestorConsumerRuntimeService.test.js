'use strict';

const { PassThrough } = require('stream');

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

function runtimeResult(body = {}, metadata = {}) {
  return {
    ok: true,
    status: 200,
    body,
    metadata: {
      model: 'ax/chat-model',
      hostUrl: 'http://host:11434',
      hostKey: 'local',
      routingSource: 'task_router',
      taskType: 'buddy_chat',
      ...metadata,
    },
  };
}

describe('Nestor consumer inference runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateHostUrl.mockImplementation((host) => ({ valid: true, host: `http://${host}:11434` }));
  });

  it('maps operations to fixed task types and emits a nestor/* callerDetail', async () => {
    const execute = jest.fn().mockResolvedValue(runtimeResult({
      message: { content: 'hello' }, prompt_eval_count: 10, eval_count: 4,
    }));
    const runtimeServices = { inference: { execute } };

    const result = await executeInference({
      operation: 'chat',
      messages: [{ role: 'system', content: 'Nestor owns this prompt.' }, { role: 'user', content: 'Hi' }],
      requested: { host: 'local', model: '' },
      context: { surface: 'desktop', sessionId: 'opaque' },
    }, { runtimeServices });

    const [forwarded, runtimeOptions] = execute.mock.calls[0];
    expect(forwarded).toEqual(expect.objectContaining({
      mode: 'chat',
      taskType: 'buddy_chat',
      callerDetail: 'nestor/desktop/chat',
      stream: false,
      think: false,
      timeoutMs: 125000,
    }));
    expect(runtimeOptions).toEqual(expect.objectContaining({
      consumerContract: 'nestor-v1',
      hostUrl: 'http://local:11434',
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
    expect(() => normalizeRequest({
      operation: 'chat', stream: 'yes', messages: [{ role: 'user', content: 'x' }],
    })).toThrow(/stream must be boolean/);
  });

  it('rejects a requested host before the trusted inference call when allowlisting fails', async () => {
    mockValidateHostUrl.mockReturnValue({ valid: false, message: 'host is not configured' });
    const execute = jest.fn();
    await expect(executeInference({
      operation: 'react',
      messages: [{ role: 'user', content: 'React' }],
      requested: { host: 'http://attacker.invalid' },
    }, { runtimeServices: { inference: { execute } } })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_HOST' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns the trusted byte stream with bounded Nestor route identity', async () => {
    const stream = new PassThrough();
    const execute = jest.fn().mockResolvedValue({
      ...runtimeResult({}, { routingSource: 'configured_host' }),
      stream,
    });
    const controller = new AbortController();

    const result = await executeInference({
      operation: 'chat',
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
      context: { surface: 'voix-native', sessionId: 'session-1' },
    }, {
      runtimeServices: { inference: { execute } },
      signal: controller.signal,
    });

    expect(result.stream).toBe(stream);
    expect(result).toEqual(expect.objectContaining({
      operation: 'chat',
      callerDetail: 'nestor/voix-native/chat',
      sessionId: 'session-1',
    }));
    expect(result.provenance.responseMode).toBe('raw-stream');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), expect.objectContaining({
      signal: controller.signal,
      consumerContract: 'nestor-v1',
    }));
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
    expect(new Date(snapshot.generatedAt).toISOString()).toBe(snapshot.generatedAt);
    expect(snapshot.topology).toBe('opaque');
    expect(snapshot.modelCatalog).toBe('/api/models/all');
    expect(snapshot.modelCatalogMode).toBe('embedded-in-routes');
    expect(snapshot.routes.chat.provenance).toBe('router-default');
    expect(snapshot.routes.react.provenance).toBe('operator-override');
    expect(snapshot.routes.analyze.taskType).toBe('analysis');
    expect(Object.values(snapshot.routes).every((route) => route.lane === 'interactive')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('http://local:11434');
    expect(Object.values(snapshot.routes).every((route) => !Object.hasOwn(route, 'hostUrl'))).toBe(true);
  });
});

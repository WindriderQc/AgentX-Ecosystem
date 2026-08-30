const mockFetch = jest.fn();
const mockGetActivePrompt = jest.fn();
const mockBuildSystemPrompt = jest.fn();
const mockGetOrCreateProfile = jest.fn();
const mockPersistConversation = jest.fn();
const mockGetHostPreference = jest.fn();

jest.mock('node-fetch', () => mockFetch);
jest.mock('../../src/services/chat/chatPromptHelpers', () => ({
  isThinkingModel: jest.fn(() => false),
  getActivePrompt: mockGetActivePrompt,
  buildSystemPrompt: mockBuildSystemPrompt
}));
jest.mock('../../src/helpers/userHelpers', () => ({
  getOrCreateProfile: mockGetOrCreateProfile
}));
jest.mock('../../src/helpers/ollamaResponseHandler', () => ({
  buildOllamaPayload: jest.fn(({ model, messages, options, streamEnabled }) => ({
    model,
    messages,
    options,
    stream: streamEnabled
  })),
  buildOllamaStats: jest.fn((data, content = '') => {
    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    const evalDuration = data.eval_duration || 0;
    const hasContent = typeof content === 'string' && content.trim().length > 0;
    return {
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      performance: {
        totalDuration: data.total_duration || 0,
        evalDuration,
        tokensPerSecond: hasContent && completionTokens > 0 && evalDuration > 0
          ? Number((completionTokens / (evalDuration / 1e9)).toFixed(2))
          : null
      }
    };
  }),
  isThinkingModel: jest.fn(() => false),
  extractResponse: jest.fn()
}));
jest.mock('../../src/helpers/ollamaUtils', () => ({
  sanitizeOptions: jest.fn((options) => ({ ...options })),
  resolveTarget: jest.fn((target) => target || 'http://192.0.2.66:11434')
}));
jest.mock('../../src/services/modelRouter', () => ({
  routeRequest: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://192.0.2.66:11434'),
  recordInference: jest.fn()
}));
jest.mock('../../src/services/hostPreferenceService', () => {
  const primitives = jest.requireActual('../../src/services/hostPinPrimitives');
  return {
    getByHost: mockGetHostPreference,
    hasActiveBenchmarkClaim: jest.fn(() => false),
    resolvePinnedRuntimeOptions: primitives.resolvePinnedRuntimeOptions
  };
});
jest.mock('../../src/services/chat/ragContextBuilder', () => ({
  buildRagContext: jest.fn()
}));
jest.mock('../../src/services/chat/conversationPersistence', () => ({
  persistConversation: mockPersistConversation
}));
jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: jest.fn()
}));
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));
jest.mock('../../models/Conversation', () => jest.fn());

const { handleChatRequestStream } = require('../../src/services/chatServiceStream');
const { routeRequest, recordInference } = require('../../src/services/modelRouter');
const { buildOllamaPayload, buildOllamaStats } = require('../../src/helpers/ollamaResponseHandler');

describe('chatServiceStream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActivePrompt.mockResolvedValue({
      _id: 'prompt-1',
      name: 'default_chat',
      version: 'v1',
      systemPrompt: 'You are helpful.'
    });
    mockBuildSystemPrompt.mockReturnValue('You are helpful.');
    mockGetOrCreateProfile.mockResolvedValue({ about: '', preferences: {} });
    mockPersistConversation.mockResolvedValue({
      conversation: { _id: 'conv-1' },
      assistantMessageId: 'msg-1'
    });
    mockGetHostPreference.mockResolvedValue(null);
  });

  it('surfaces Ollama error details without masking them in finally cleanup', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: jest.fn().mockResolvedValue({
        error: 'invalid options: frequency_penalty'
      })
    });

    const onError = jest.fn();

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'qwen3:14b',
      message: 'hello',
      target: 'http://192.0.2.66:11434',
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete: jest.fn(),
      onError
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toContain('invalid options: frequency_penalty');
  });

  it('classifies missing Ollama models in streaming mode', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: jest.fn().mockResolvedValue({
        error: "model 'missing-stream-model:latest' not found"
      })
    });

    const onError = jest.fn();

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'missing-stream-model:latest',
      message: 'hello',
      target: 'http://192.0.2.66:11434',
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete: jest.fn(),
      onError
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      statusCode: 404,
      upstreamStatus: 404,
      upstreamMessage: "model 'missing-stream-model:latest' not found"
    });
  });

  it('records streaming router analytics fields on successful auto-routed requests', async () => {
    routeRequest.mockResolvedValue({
      routed: true,
      autoRouted: true,
      classificationMs: 31,
      model: 'qwen3-2507-30b-long-48k',
      target: 'http://192.0.2.66:11434',
      host: 'primary',
      taskType: 'analysis'
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* stream() {
        yield Buffer.from(JSON.stringify({
          message: { content: 'Hello' }
        }) + '\n');
        yield Buffer.from(JSON.stringify({
          done: true,
          eval_count: 5,
          prompt_eval_count: 3,
          total_duration: 2000000000,
          eval_duration: 1000000000,
          prompt_eval_duration: 500000000
        }) + '\n');
      })()
    });

    const onComplete = jest.fn();
    mockGetActivePrompt.mockResolvedValueOnce({
      _id: 'prompt-4',
      name: 'reviewer',
      version: 4,
      systemPrompt: 'Review carefully.'
    });

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'auto',
      message: 'Analyze this',
      persona: 'reviewer',
      promptVersion: 4,
      autoRoute: true,
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete,
      onError: jest.fn()
    });

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: {
        name: 'reviewer',
        version: 4,
        exact: true,
        requestedVersion: 4
      },
      routing: expect.objectContaining({
        taskType: 'analysis',
        routed: true,
        autoRouted: true,
        classificationMs: 31,
        routedModel: 'qwen3-2507-30b-long-48k',
        routedHost: 'primary',
        routedHostUrl: 'http://192.0.2.66:11434'
      })
    }));
    expect(mockGetActivePrompt).toHaveBeenCalledWith(undefined, 'reviewer', {
      preferSystem: false,
      promptVersion: 4
    });
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'analysis',
      routed: true,
      autoRouted: true,
      classificationMs: 31,
      routedModel: 'qwen3-2507-30b-long-48k',
      routedHost: 'primary',
      routedHostUrl: 'http://192.0.2.66:11434'
    }));
  });

  // RouteDecision attribution (0519): the stream path used to drop the
  // decision routeRequest built. Assert presence on the recorded row itself.
  it('threads the routeRequest decision onto the streaming telemetry row', async () => {
    const decision = {
      decisionVersion: 1,
      attribution: { caller: 'chat', callerDetail: 'chat-user-1' }
    };
    routeRequest.mockResolvedValue({
      routed: true,
      autoRouted: true,
      classificationMs: 7,
      model: 'qwen3-2507-30b-long-48k',
      target: 'http://192.0.2.66:11434',
      host: 'primary',
      taskType: 'analysis',
      decision
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* stream() {
        yield Buffer.from(JSON.stringify({
          message: { content: 'Hello' }
        }) + '\n');
        yield Buffer.from(JSON.stringify({ done: true, eval_count: 2 }) + '\n');
      })()
    });

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'auto',
      message: 'Analyze this',
      autoRoute: true,
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn()
    });

    expect(routeRequest).toHaveBeenCalledWith('Analyze this', expect.objectContaining({
      callerDetail: expect.any(String)
    }));
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      routeDecision: expect.objectContaining({
        outcome: expect.objectContaining({
          stage: 'execution',
          code: 'execution_succeeded'
        })
      }),
      observability: expect.objectContaining({
        contract: expect.objectContaining({ version: 'agentx.inference-contract.v1' }),
        outcome: expect.objectContaining({ visibleFinal: true, completed: true })
      })
    }));
  });

  it('records streaming upstream failures with a terminal error decision', async () => {
    routeRequest.mockResolvedValue({
      routed: true,
      model: 'qwen3:14b',
      target: 'http://192.0.2.66:11434',
      host: 'primary',
      taskType: 'analysis',
      decision: { decisionVersion: 1, selected: { model: 'qwen3:14b', host: 'primary' } }
    });
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const onError = jest.fn();

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'qwen3:14b',
      message: 'Analyze this',
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete: jest.fn(),
      onError
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      routeDecision: expect.objectContaining({
        outcome: expect.objectContaining({ code: 'upstream_error' })
      })
    }));
  });

  it('includes the current user message in the streaming Ollama payload', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* stream() {
        yield Buffer.from(JSON.stringify({
          message: { content: 'Hello' }
        }) + '\n');
        yield Buffer.from(JSON.stringify({
          done: true,
          eval_count: 1,
          prompt_eval_count: 1,
          total_duration: 1000000000,
          eval_duration: 1000000000
        }) + '\n');
      })()
    });

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'qwen3:14b',
      message: 'Stream this',
      messages: [{ role: 'assistant', content: 'Prior answer' }],
      target: 'http://192.0.2.66:11434',
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn()
    });

    expect(buildOllamaPayload).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'assistant', content: 'Prior answer' },
        { role: 'user', content: 'Stream this' }
      ]
    }));
  });

  it('uses the matching pin context and keep-alive for streaming chat (0512)', async () => {
    mockGetHostPreference.mockResolvedValue({
      pinnedModels: [{
        model: 'ax/gemma4:31b-it-qat',
        keepAlive: -1,
        contextSize: 49152,
        autoRestore: true
      }]
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* stream() {
        yield Buffer.from(JSON.stringify({ message: { content: 'Done' } }) + '\n');
        yield Buffer.from(JSON.stringify({
          done: true,
          eval_count: 1,
          prompt_eval_count: 1,
          total_duration: 1000000000,
          eval_duration: 1000000000
        }) + '\n');
      })()
    });
    const onComplete = jest.fn();

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'ax/gemma4:31b-it-qat',
      message: 'Think deeply',
      target: 'http://192.0.2.199:11434',
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete,
      onError: jest.fn()
    });

    expect(buildOllamaPayload).toHaveBeenCalledWith(expect.objectContaining({
      model: 'ax/gemma4:31b-it-qat',
      options: expect.objectContaining({ num_ctx: 49152, keep_alive: -1 })
    }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ numCtx: 49152 }));
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      num_ctx: 49152,
      num_ctx_source: 'host_preference_pin'
    }));
  });

  it('keeps authoritative stateless external turns bounded with exact telemetry', async () => {
    routeRequest.mockResolvedValue({
      routed: true,
      model: 'ax/gemma4:26b-a4b-it-qat',
      target: 'http://192.0.2.199:11434',
      host: 'primary',
      taskType: 'nestor_answer_light'
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* stream() {
        const line = JSON.stringify({ message: { content: 'Bonjour.' } }) + '\n';
        yield Buffer.from(line.slice(0, 17));
        yield Buffer.from(line.slice(17));
        yield Buffer.from(JSON.stringify({
          done: true,
          eval_count: 1,
          prompt_eval_count: 2,
          total_duration: 500000000,
          eval_duration: 100000000
        }) + '\n');
      })()
    });
    const onToken = jest.fn();

    await handleChatRequestStream({
      userId: 'nestor-answer-light',
      callerDetail: 'nestor/turn/answer-light',
      message: 'Allô?',
      system: 'Nestor local system.',
      authoritativeSystem: true,
      persist: false,
      allowTools: false,
      allowRag: false,
      loadUserProfile: false,
      taskType: 'nestor_answer_light',
      onToken,
      onThinking: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn()
    });

    expect(mockGetActivePrompt).toHaveBeenCalledWith(
      'Nestor local system.',
      'default_chat',
      { preferSystem: true }
    );
    expect(onToken).toHaveBeenCalledWith('Bonjour.');
    expect(mockGetOrCreateProfile).not.toHaveBeenCalled();
    expect(mockPersistConversation).not.toHaveBeenCalled();
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      callerDetail: 'nestor/turn/answer-light',
      taskType: 'nestor_answer_light',
      routedModel: 'ax/gemma4:26b-a4b-it-qat',
      routedHost: 'primary'
    }));
  });

  it('does not report tokens per second when the streaming response is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: (async function* stream() {
        yield Buffer.from(JSON.stringify({
          done: true,
          eval_count: 1,
          prompt_eval_count: 2,
          total_duration: 1000000,
          eval_duration: 1000
        }) + '\n');
      })()
    });

    const onComplete = jest.fn();

    await handleChatRequestStream({
      userId: 'user-1',
      model: 'qwen3:14b',
      message: 'Stream this',
      target: 'http://192.0.2.66:11434',
      onToken: jest.fn(),
      onThinking: jest.fn(),
      onComplete,
      onError: jest.fn()
    });

    expect(buildOllamaStats).toHaveBeenCalledWith(expect.objectContaining({
      eval_count: 1,
      prompt_eval_count: 2,
      eval_duration: 1000
    }), '');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      response: '',
      stats: expect.objectContaining({
        performance: expect.objectContaining({
          tokensPerSecond: null
        })
      })
    }));
  });
});

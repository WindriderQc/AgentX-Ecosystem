/**
 * Unit tests for nestorTurnService (task 0453) — one brain for voice and text.
 */

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/services/openclawClient', () => {
  class OpenClawClientError extends Error {
    constructor(message, { status = 502, code = 'OPENCLAW_CLIENT_ERROR' } = {}) {
      super(message);
      this.name = 'OpenClawClientError';
      this.status = status;
      this.code = code;
    }
  }
  const client = {
    invoke: jest.fn(),
    exec: jest.fn(),
    respond: jest.fn(),
    respondStream: jest.fn(),
    healthCheck: jest.fn()
  };
  return {
    OpenClawClientError,
    getOpenClawClient: () => client,
    isOpenClawIntegrationEnabled: jest.fn(() => true),
    __client: client
  };
});

jest.mock('../../src/services/nestorLiveContextService', () => ({
  buildPipelineSnapshot: jest.fn().mockResolvedValue({
    sourceOfTruth: 'mongodb:pipelinetasks',
    generatedAt: '2026-07-27T21:00:00.000Z',
    total: 449,
    activeCount: 18,
    counts: { queued: 14, in_progress: 0, review: 3, blocked: 1, done: 431 },
    activeTasks: [{ pipelineId: '0454', title: 'Latency', status: 'queued', assignee: null }],
    truncated: true
  }),
  formatPipelineSnapshot: jest.fn(() => 'LIVE PIPELINE: total=449; active=18')
}));

const mockHandleChatRequestStream = jest.fn();
jest.mock('../../src/services/chatServiceStream', () => ({
  handleChatRequestStream: (...args) => mockHandleChatRequestStream(...args)
}));

const openclaw = require('../../src/services/openclawClient');
const liveContextService = require('../../src/services/nestorLiveContextService');
const logger = require('../../config/logger');
const {
  runTurn,
  runTurnStream,
  extractReply,
  parseAnswerLightEscalation,
  buildSessionKey,
  NestorTurnError
} = require('../../src/services/nestorTurnService');

const client = openclaw.__client;

beforeEach(() => {
  jest.clearAllMocks();
  openclaw.isOpenClawIntegrationEnabled.mockReturnValue(true);
  global.fetch = jest.fn();
});

describe('OpenClaw conversation routing', () => {
  test('derives a stable routing-safe OpenClaw session key from the conversation id', () => {
    const first = buildSessionKey('conv with unsafe $() characters');
    const second = buildSessionKey('conv with unsafe $() characters');
    expect(first).toBe(second);
    expect(first).toMatch(/^agent:main:nestor-[a-f0-9]{32}$/);
    expect(first).not.toContain('$');
  });
});

describe('extractReply', () => {
  test('handles strings, objects, and message arrays', () => {
    expect(extractReply('  hello ')).toBe('hello');
    expect(extractReply({ reply: 'a' })).toBe('a');
    expect(extractReply({ result: { text: 'nested' } })).toBe('nested');
    expect(extractReply({ messages: [{ content: 'first' }, { content: 'last' }] })).toBe('last');
    expect(extractReply({ output: [{ content: [{ type: 'output_text', text: 'OpenResponses reply' }] }] }))
      .toBe('OpenResponses reply');
    expect(extractReply(null)).toBe('');
  });
});

describe('Answer-Light escalation signal', () => {
  test('accepts only the exact machine-readable signal', () => {
    expect(parseAnswerLightEscalation('[[NESTOR_ESCALATE:requires-tools]]')).toEqual({
      reason: 'requires-tools'
    });
    expect(parseAnswerLightEscalation('Use Nestor complet instead.')).toBeNull();
    expect(parseAnswerLightEscalation('[[NESTOR_ESCALATE:requires-tools]] because I cannot')).toBeNull();
  });
});

describe('runTurn', () => {
  test('validates text', async () => {
    await expect(runTurn({ text: '' })).rejects.toThrow(NestorTurnError);
    await expect(runTurn({ text: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'NESTOR_TEXT_TOO_LONG' });
    await expect(runTurn({ text: 'hello', lane: 'unknown' })).rejects.toMatchObject({
      code: 'NESTOR_LANE_INVALID'
    });
  });

  test('runs the explicit Answer-Light lane locally without calling OpenClaw', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'x-resolved-model': 'ax/gemma4:26b-a4b-it-qat',
          'x-routed-host-key': 'primary'
        })[name]
      },
      text: async () => JSON.stringify({ data: { reply: 'Réponse locale rapide.' } })
    });

    const result = await runTurn({ text: 'Réponds brièvement.', lane: 'answer_light' });

    expect(client.respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reply: 'Réponse locale rapide.',
      brain: 'nestor-local',
      transport: 'local-inference-answer-light',
      lane: 'answer_light',
      model: 'ax/gemma4:26b-a4b-it-qat',
      host: 'primary'
    });
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.taskType).toBe('nestor_answer_light');
    expect(payload.callerDetail).toBe('nestor/turn/answer-light');
    expect(payload.messages[0].content).toContain("Example User's unflappable majordomo");
    expect(payload.messages[0].content).toContain('low-latency local Answer-Light lane');
  });

  test('auto-selects Answer-Light for a bounded question and exposes the decision', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: { reply: 'Une très grande chose.' } })
    });

    const result = await runTurn({ text: 'Que veut dire gigantesque?', lane: 'auto' });

    expect(client.respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      lane: 'answer_light',
      laneSelection: {
        requestedLane: 'auto',
        source: 'deterministic-policy-v1',
        reason: 'bounded-answer'
      }
    });
  });

  test('auto-selects the complete front door for a secretary action', async () => {
    client.respond.mockResolvedValue('Je m’en occupe.');

    const result = await runTurn({ text: 'Ajoute acheter du lait à ma liste', lane: 'auto' });

    expect(client.respond).toHaveBeenCalled();
    expect(result).toMatchObject({
      lane: 'front_door',
      laneSelection: {
        requestedLane: 'auto',
        source: 'deterministic-policy-v1',
        reason: 'action-or-secretary'
      }
    });
  });

  test('retries one auto Answer-Light escalation through Complete with the same trace family', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: { reply: '[[NESTOR_ESCALATE:requires-tools]]' } })
    });
    client.respond.mockResolvedValue('Réponse complète avec outils.');

    const result = await runTurn({
      text: 'Bonjour, peux-tu vérifier ceci?',
      lane: 'auto',
      conversationId: 'conv-escalate',
      traceId: 'trace-escalate'
    });

    expect(client.respond).toHaveBeenCalledTimes(1);
    expect(client.respond.mock.calls[0][1].sessionKey).toBe(buildSessionKey('conv-escalate'));
    expect(result).toMatchObject({
      reply: 'Réponse complète avec outils.',
      lane: 'front_door',
      traceId: 'trace-escalate',
      laneSelection: {
        requestedLane: 'auto',
        source: 'answer-light-escalation-v1',
        reason: 'requires-tools',
        initialLane: 'answer_light',
        escalated: true
      },
      escalation: {
        source: 'answer-light-signal-v1',
        from: 'answer_light',
        to: 'front_door'
      }
    });
  });

  test('keeps an explicit Answer-Light override local and hides its machine signal', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: { reply: '[[NESTOR_ESCALATE:requires-tools]]' } })
    });

    const result = await runTurn({ text: 'Fais une action', lane: 'answer_light' });

    expect(client.respond).not.toHaveBeenCalled();
    expect(result.lane).toBe('answer_light');
    expect(result.reply).toContain('Nestor complet');
    expect(result.reply).not.toContain('NESTOR_ESCALATE');
  });

  test('happy path via Gateway OpenResponses', async () => {
    client.respond.mockResolvedValue({
      output: [{ content: [{ type: 'output_text', text: 'Queue holds 15 tasks.' }] }]
    });

    const result = await runTurn({
      text: 'How is the pipeline?',
      surface: 'voice-console',
      conversationId: 'voice-conversation'
    });

    expect(client.respond).toHaveBeenCalledWith(
      'How is the pipeline?',
      expect.objectContaining({
        agentId: 'main',
        sessionKey: buildSessionKey('voice-conversation'),
        instructions: expect.stringContaining('LIVE PIPELINE: total=449; active=18'),
        timeout: expect.any(Number)
      })
    );
    expect(client.respond.mock.calls[0][1].instructions).toContain(
      'A request for Council, debate, or independent model/prompt'
    );
    expect(result.reply).toBe('Queue holds 15 tasks.');
    expect(result.brain).toBe('nestor-openclaw');
    expect(result.transport).toBe('gateway-openresponses');
    expect(result.conversationId).toBeTruthy();
    expect(result.traceId).toBeTruthy();
    expect(result.fallback).toBeNull();
    expect(result.grounding.pipeline).toMatchObject({
      sourceOfTruth: 'mongodb:pipelinetasks',
      total: 449,
      activeCount: 18
    });
    expect(result.timings.contextMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preserves conversationId and traceId when provided', async () => {
    client.respond.mockResolvedValue('ok');
    const result = await runTurn({ text: 'hi', conversationId: 'conv-1', traceId: 'trace-1' });
    expect(result.conversationId).toBe('conv-1');
    expect(result.traceId).toBe('trace-1');
  });

  test('uses local inference fallback when the gateway is unreachable', async () => {
    client.respond.mockRejectedValue(
      new openclaw.OpenClawClientError('Gateway unreachable: connect ECONNREFUSED', { code: 'GATEWAY_UNREACHABLE' })
    );
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { reply: 'Degraded-mode answer.' } })
    });

    const result = await runTurn({ text: 'hello?' });

    expect(result.brain).toBe('local-fallback');
    expect(result.transport).toBe('local-inference');
    expect(result.reply).toBe('Degraded-mode answer.');
    expect(result.fallback).toMatchObject({ reason: 'GATEWAY_UNREACHABLE' });

    const [, fetchOpts] = global.fetch.mock.calls[0];
    const payload = JSON.parse(fetchOpts.body);
    expect(payload.taskType).toBe('nestor_answer_light');
    expect(payload.messages[0].content).toContain('LIVE PIPELINE: total=449; active=18');
    expect(payload.messages[1]).toEqual({ role: 'user', content: 'hello?' });
  });

  test('uses local fallback when OpenClaw integration is disabled', async () => {
    openclaw.isOpenClawIntegrationEnabled.mockReturnValue(false);
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { response: 'Local only.' } })
    });

    const result = await runTurn({ text: 'ping' });

    expect(client.respond).not.toHaveBeenCalled();
    expect(result.brain).toBe('local-fallback');
    expect(result.fallback).toMatchObject({ reason: 'OPENCLAW_DISABLED' });
  });

  test('surfaces a typed error when brain and fallback both fail', async () => {
    client.respond.mockRejectedValue(
      new openclaw.OpenClawClientError('Gateway request timed out', { code: 'GATEWAY_TIMEOUT' })
    );
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ message: 'router down' })
    });

    await expect(runTurn({ text: 'anyone there?' })).rejects.toMatchObject({
      code: 'NESTOR_FALLBACK_FAILED'
    });
  });

  test('rejects an empty gateway reply instead of synthesizing silence', async () => {
    client.respond.mockResolvedValue({});
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { reply: 'fallback text' } })
    });

    const result = await runTurn({ text: 'say something' });
    // empty gateway reply → NESTOR_EMPTY_REPLY → local fallback takes over
    expect(result.brain).toBe('local-fallback');
    expect(result.reply).toBe('fallback text');
  });

  test('continues without stale pipeline claims when live grounding is unavailable', async () => {
    liveContextService.buildPipelineSnapshot.mockRejectedValueOnce(new Error('mongo unavailable'));
    client.respond.mockResolvedValue('I cannot verify the live pipeline right now.');

    const result = await runTurn({ text: 'How many tasks are active?' });

    expect(result.grounding).toBeNull();
    expect(client.respond).toHaveBeenCalledWith(
      'How many tasks are active?',
      expect.objectContaining({
        instructions: expect.stringContaining('Do not infer current pipeline facts from memory.')
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Nestor turn: live pipeline grounding unavailable',
      expect.objectContaining({ error: 'mongo unavailable' })
    );
  });

  test('retries a length-limited non-streaming Auto answer through Complete', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        response: 'Réponse locale coupée. Inconnus:',
        done_reason: 'length',
        eval_count: 160
      })
    });
    client.respond.mockResolvedValue('Réponse complète et terminée.');

    const result = await runTurn({ text: 'Explique-moi cela.', lane: 'auto' });

    expect(result).toMatchObject({
      reply: 'Réponse complète et terminée.',
      lane: 'front_door',
      laneSelection: { escalated: true, reason: 'output-limit' },
      escalation: { reason: 'output-limit' }
    });
  });
});

describe('runTurnStream', () => {
  test('streams Answer-Light through the dedicated local lane', async () => {
    mockHandleChatRequestStream.mockImplementation(async (options) => {
      options.onToken('Réponse locale.');
      options.onComplete({
        response: 'Réponse locale.',
        model: 'ax/gemma4:26b-a4b-it-qat',
        routing: { routedHost: 'primary' }
      });
    });
    const deltas = [];
    const starts = [];

    const result = await runTurnStream({
      text: 'Allô?',
      lane: 'answer_light'
    }, {
      onStart: (data) => starts.push(data),
      onDelta: (data) => deltas.push(data.delta)
    });

    expect(client.respondStream).not.toHaveBeenCalled();
    expect(mockHandleChatRequestStream).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'nestor_answer_light',
      callerDetail: 'nestor/turn/answer-light',
      authoritativeSystem: true,
      persist: false,
      allowTools: false,
      allowRag: false,
      loadUserProfile: false,
      enableWebSearch: false,
      thinkingMode: 'off'
    }));
    expect(mockHandleChatRequestStream.mock.calls[0][0].system).toContain("Example User's unflappable majordomo");
    expect(mockHandleChatRequestStream.mock.calls[0][0].system).toContain('Return only final words meant for the user');
    expect(starts[0].lane).toBe('answer_light');
    expect(deltas.join('')).toBe('Réponse locale.');
    expect(result).toMatchObject({
      brain: 'nestor-local',
      transport: 'local-ollama-stream',
      lane: 'answer_light',
      model: 'ax/gemma4:26b-a4b-it-qat',
      host: 'primary'
    });
  });

  test('preserves the one-brain route while emitting deltas and speakable sentences', async () => {
    client.respondStream.mockImplementation(async (_text, options) => {
      options.onDelta('Bonjour Example User. ');
      options.onDelta('Tout est prêt!');
      return { text: 'Bonjour Example User. Tout est prêt!' };
    });
    const deltas = [];
    const sentences = [];
    const starts = [];

    const result = await runTurnStream({
      text: 'Statut?',
      surface: 'voice-console',
      conversationId: 'voice-stream'
    }, {
      onStart: (data) => starts.push(data),
      onDelta: (data) => deltas.push(data.delta),
      onSentence: (data) => sentences.push(data.text)
    });

    expect(client.respondStream).toHaveBeenCalledWith(
      'Statut?',
      expect.objectContaining({
        agentId: 'main',
        sessionKey: buildSessionKey('voice-stream'),
        instructions: expect.stringContaining('LIVE PIPELINE: total=449; active=18')
      })
    );
    expect(starts[0]).toMatchObject({
      conversationId: 'voice-stream',
      surface: 'voice-console'
    });
    expect(deltas.join('')).toBe(result.reply);
    expect(sentences).toEqual(['Bonjour Example User.', 'Tout est prêt!']);
    expect(result).toMatchObject({
      brain: 'nestor-openclaw',
      transport: 'gateway-openresponses-stream'
    });
    expect(result.timings.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.firstSentenceMs).toBeGreaterThanOrEqual(0);
  });

  test('does not emit the escalation token before retrying an auto stream through Complete', async () => {
    mockHandleChatRequestStream.mockImplementation(async (options) => {
      options.onToken('[[NESTOR_');
      options.onToken('ESCALATE:requires-tools]]');
      options.onComplete({ response: '[[NESTOR_ESCALATE:requires-tools]]' });
    });
    client.respondStream.mockImplementation(async (_text, options) => {
      options.onDelta('Réponse complète.');
      return { text: 'Réponse complète.' };
    });
    const deltas = [];

    const result = await runTurnStream({
      text: 'Bonjour, peux-tu vérifier ceci?',
      lane: 'auto',
      conversationId: 'conv-stream-escalate',
      traceId: 'trace-stream-escalate'
    }, {
      onDelta: (data) => deltas.push(data.delta)
    });

    expect(deltas.join('')).toBe('Réponse complète.');
    expect(deltas.join('')).not.toContain('NESTOR_ESCALATE');
    expect(client.respondStream).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      reply: 'Réponse complète.',
      lane: 'front_door',
      traceId: 'trace-stream-escalate',
      laneSelection: { escalated: true, reason: 'requires-tools' }
    });
  });

  test('does not expose a length-limited local answer before retrying Auto through Complete', async () => {
    const deltas = [];
    const sentences = [];
    mockHandleChatRequestStream.mockImplementation(async (options) => {
      options.onToken('Vérifié: ceci est une longue réponse. Inconnus:');
      expect(deltas).toEqual([]);
      options.onComplete({
        response: 'Vérifié: ceci est une longue réponse. Inconnus:',
        stats: {
          completion: { reason: 'length' },
          usage: { completionTokens: 160 }
        }
      });
    });
    client.respondStream.mockImplementation(async (_text, options) => {
      options.onDelta('Réponse complète et terminée.');
      return { text: 'Réponse complète et terminée.' };
    });

    const result = await runTurnStream({
      text: 'Explique-moi cela.',
      lane: 'auto'
    }, {
      onDelta: (data) => deltas.push(data.delta),
      onSentence: (data) => sentences.push(data.text)
    });

    expect(deltas.join('')).toBe('Réponse complète et terminée.');
    expect(sentences).toEqual(['Réponse complète et terminée.']);
    expect(result).toMatchObject({
      reply: 'Réponse complète et terminée.',
      lane: 'front_door',
      laneSelection: { escalated: true, reason: 'output-limit' },
      escalation: { reason: 'output-limit' }
    });
  });

  test('filters hidden local reasoning before display and speech', async () => {
    mockHandleChatRequestStream.mockImplementation(async (options) => {
      options.onToken('<think>private routing notes</think>Réponse utile.');
      options.onComplete({ response: '<think>private routing notes</think>Réponse utile.' });
    });
    const deltas = [];
    const sentences = [];

    const result = await runTurnStream({ text: 'Allô?', lane: 'answer_light' }, {
      onDelta: (data) => deltas.push(data.delta),
      onSentence: (data) => sentences.push(data.text)
    });

    expect(deltas.join('')).toBe('Réponse utile.');
    expect(sentences).toEqual(['Réponse utile.']);
    expect(result.reply).toBe('Réponse utile.');
  });

  test('falls back only when the gateway fails before emitting text', async () => {
    client.respondStream.mockRejectedValue(
      new openclaw.OpenClawClientError('offline', { code: 'GATEWAY_UNREACHABLE' })
    );
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: 'Réponse locale.' })
    });
    const sentences = [];

    const result = await runTurnStream({ text: 'allo' }, {
      onSentence: (data) => sentences.push(data.text)
    });

    expect(result.brain).toBe('local-fallback');
    expect(result.fallback.reason).toBe('GATEWAY_UNREACHABLE');
    expect(sentences).toEqual(['Réponse locale.']);
  });

  test('does not start a contradictory fallback after a partial answer', async () => {
    client.respondStream.mockImplementation(async (_text, options) => {
      options.onDelta('Réponse partielle qui a déjà commencé. ');
      throw new openclaw.OpenClawClientError('connection lost', { code: 'GATEWAY_UNREACHABLE' });
    });

    await expect(runTurnStream({ text: 'allo' })).rejects.toMatchObject({
      code: 'NESTOR_STREAM_INTERRUPTED'
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

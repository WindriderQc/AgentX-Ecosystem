jest.mock('../../models/Roundtable', () => ({
  create: jest.fn(async (doc) => doc),
  updateOne: jest.fn(async () => ({ acknowledged: true })),
  findById: jest.fn()
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  resolvePinnedRuntimeOptions: jest.fn()
}));

jest.mock('../../src/services/roundtable/runtimeParticipantAdapter', () => ({
  callRuntimeParticipant: jest.fn()
}));

const Roundtable = require('../../models/Roundtable');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const { callRuntimeParticipant } = require('../../src/services/roundtable/runtimeParticipantAdapter');
const {
  createRoundtable,
  buildSynthesisRequest,
  buildPinnedAgentPayload,
  executeRound
} = require('../../src/services/roundtable/orchestrator');

describe('Roundtable v2 orchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostPreferenceService.getByHost.mockResolvedValue({ pinnedModels: [] });
    hostPreferenceService.resolvePinnedRuntimeOptions.mockImplementation((_pref, _model, options) => ({
      options: { ...options },
      keepAlive: undefined
    }));
  });

  test('uses the matching pin context and keep-alive for model participants', async () => {
    hostPreferenceService.getByHost.mockResolvedValue({ pinnedModels: [{ model: 'ax/gemma4:31b-it-qat' }] });
    hostPreferenceService.resolvePinnedRuntimeOptions.mockReturnValue({
      options: { num_predict: -1, num_ctx: 49152 },
      keepAlive: -1
    });

    const payload = await buildPinnedAgentPayload(
      { model: 'ax/gemma4:31b-it-qat' },
      [{ role: 'user', content: 'Discuss.' }],
      'http://primary:11434',
      true
    );

    expect(payload).toMatchObject({
      model: 'ax/gemma4:31b-it-qat',
      stream: true,
      keep_alive: -1,
      options: { num_ctx: 49152, num_predict: -1 }
    });
  });

  test('normalizes runtime participant configuration and strips untrusted endpoints', async () => {
    await createRoundtable({
      question: 'Discuss runtime routing.',
      panel: [{
        agentId: 'codex-reviewer', role: 'Codex reviewer', runtime: 'codex',
        runtimeConfig: {
          sessionKey: 'agent:leadx:roundtable-routing',
          endpoint: 'http://attacker.invalid'
        },
        systemPrompt: 'Assess operations.'
      }],
      synthesizer: { model: 'runtime/model-a', systemPrompt: 'Synthesize.' },
      governance: { requireApproval: true }
    });

    expect(Roundtable.create).toHaveBeenCalledWith(expect.objectContaining({
      panelConfig: [expect.objectContaining({
        runtime: 'codex',
        model: 'runtime-managed',
        runtimeConfig: {
          sessionKey: 'agent:leadx:roundtable-routing',
          sessionId: null
        }
      })],
      governance: { requireApproval: true, decisionStatus: 'deliberating' }
    }));
  });

  test('rejects duplicate agent identities before persistence', async () => {
    await expect(createRoundtable({
      question: 'Duplicate?',
      panel: [
        { agentId: 'same', role: 'One', runtime: 'model', model: 'qwen3:8b', systemPrompt: 'One.' },
        { agentId: 'same', role: 'Two', runtime: 'codex', systemPrompt: 'Two.' }
      ]
    })).rejects.toThrow('duplicate panel agentId');
    expect(Roundtable.create).not.toHaveBeenCalled();
  });

  test('makes the original question output contract the final synthesis instruction', () => {
    const prompt = buildSynthesisRequest(
      'Answer in exactly two bullets.',
      'Critic: Keep the answer bounded.'
    );

    expect(prompt).toContain('Original question: Answer in exactly two bullets.');
    expect(prompt).toContain('Every explicit format or length constraint');
    expect(prompt).toContain('return exactly that shape and nothing else');
    expect(prompt.endsWith('no preamble, headings, appendix, or open-questions section.')).toBe(true);
  });

  test('persists a real-runtime turn as final text only', async () => {
    callRuntimeParticipant.mockResolvedValue({
      response: 'Bounded operational position.',
      thinking: null,
      stats: { tokensPerSecond: null, latencyMs: 25 },
      error: null,
      target: 'codex://bridge',
      hostName: 'codex.example',
      runtime: 'codex',
      runtimeRef: 'roundtable-rt-1',
      startedAt: new Date(),
      completedAt: new Date()
    });
    const doc = { _id: 'rt-1' };
    const agent = {
      agentId: 'codex-reviewer', role: 'Codex reviewer', runtime: 'codex',
      model: 'runtime-managed', systemPrompt: 'Assess operations.', enableWebSearch: false
    };

    const results = await executeRound(
      doc, 1, [agent],
      () => [{ role: 'user', content: 'Discuss.' }],
      5000, null
    );

    expect(results['codex-reviewer'].response).toBe('Bounded operational position.');
    expect(Roundtable.updateOne).toHaveBeenCalledWith(
      { _id: 'rt-1' },
      { $push: { turns: expect.objectContaining({
        runtime: 'codex',
        thinking: null,
        runtimeRef: 'roundtable-rt-1'
      }) } }
    );
  });
});

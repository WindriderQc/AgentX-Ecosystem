'use strict';

/**
 * Council participant calls must land in inference telemetry with a
 * server-generated attribution that a session's six turns plus synthesis
 * can be correlated with, and without any prompt, response or reasoning.
 */

jest.mock('../../models/Roundtable', () => ({
  create: jest.fn(async (doc) => doc),
  updateOne: jest.fn(async () => ({ acknowledged: true })),
  findById: jest.fn()
}));
jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(async () => ({ pinnedModels: [] })),
  resolvePinnedRuntimeOptions: jest.fn((_pref, _model, options) => ({ options: { ...options }, keepAlive: undefined }))
}));
jest.mock('../../src/services/roundtable/runtimeParticipantAdapter', () => ({
  callRuntimeParticipant: jest.fn(),
  validateRuntimeConfiguration: jest.fn()
}));
jest.mock('../../src/services/modelRouter', () => ({
  getTargetForModel: jest.fn(() => 'http://primary.example.test:11434'),
  recordInference: jest.fn(async () => null)
}));
jest.mock('../../src/services/routing/inferenceAttemptExecutor', () => ({
  createOllamaStreamTerminalValidator: jest.fn(),
  executeAdmittedOllamaAttempt: jest.fn()
}));

const { recordInference } = require('../../src/services/modelRouter');
const { executeAdmittedOllamaAttempt } = require('../../src/services/routing/inferenceAttemptExecutor');
const orchestrator = require('../../src/services/roundtable/orchestrator');

const SECRET_PROMPT = 'Confidential deliberation prompt that must never enter telemetry';
const PRIVATE_REASONING = 'private chain of thought';

describe('Council inference telemetry', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a successful participant turn is recorded as a correlated council call without payload', async () => {
    executeAdmittedOllamaAttempt.mockResolvedValue({
      response: { ok: true },
      data: {
        done: true,
        message: { content: `<think>${PRIVATE_REASONING}</think>Final position.` },
        prompt_eval_count: 120, eval_count: 40, eval_duration: 2e9, total_duration: 3e9
      },
      raw: ''
    });

    const result = await orchestrator.callAgent(
      { agentId: 'critic', role: 'Critic', model: 'qwen3:8b', systemPrompt: SECRET_PROMPT },
      [{ role: 'system', content: SECRET_PROMPT }, { role: 'user', content: 'Question?' }],
      5000,
      { roundtableId: 'rt-123', round: 2 }
    );

    expect(result.error).toBeNull();
    expect(recordInference).toHaveBeenCalledTimes(1);
    const row = recordInference.mock.calls[0][0];
    expect(row).toMatchObject({
      host: 'http://primary.example.test:11434',
      model: 'qwen3:8b',
      caller: 'council',
      callerDetail: 'council:turn:critic:round2',
      consumerContract: 'core-council-v1',
      correlationId: 'rt-123',
      workItemId: 'rt-123',
      taskType: 'council_deliberation',
      status: 'success',
      tokensIn: 120,
      tokensOut: 40
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(PRIVATE_REASONING);
    expect(serialized).not.toContain('Final position.');
  });

  test('the synthesis phase is recorded with its own detail and the same correlation id', async () => {
    executeAdmittedOllamaAttempt.mockResolvedValue({
      response: { ok: true },
      data: { message: { content: 'Verdict.' }, prompt_eval_count: 10, eval_count: 5 },
      raw: ''
    });

    await orchestrator.callAgentStreaming(
      { agentId: 'synthesizer', role: 'Synthesizer', model: 'qwen3:8b', systemPrompt: 'x', _round: 0 },
      [{ role: 'user', content: 'Synthesize.' }],
      5000,
      null,
      'synthesis',
      { roundtableId: 'rt-123', round: 0, phase: 'synthesis' }
    );

    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'council',
      callerDetail: 'council:synthesis:synthesizer',
      correlationId: 'rt-123',
      status: 'success'
    }));
  });

  test('a failed or timed-out participant call is still recorded, with its status', async () => {
    const timeout = new Error('aborted');
    timeout.name = 'AbortError';
    executeAdmittedOllamaAttempt.mockRejectedValueOnce(timeout);

    const result = await orchestrator.callAgent(
      { agentId: 'critic', role: 'Critic', model: 'qwen3:8b', systemPrompt: 'x' },
      [{ role: 'user', content: 'Question?' }],
      1000,
      { roundtableId: 'rt-9', round: 1 }
    );

    expect(result.error).toMatch(/Timeout after 1000ms/);
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'council',
      callerDetail: 'council:turn:critic:round1',
      correlationId: 'rt-9',
      status: 'timeout',
      error: 'Timeout after 1000ms'
    }));
  });

  test('a telemetry failure never fails the turn', async () => {
    recordInference.mockImplementationOnce(() => Promise.reject(new Error('mongo down')));
    executeAdmittedOllamaAttempt.mockResolvedValue({
      response: { ok: true }, data: { message: { content: 'ok' } }, raw: ''
    });
    const result = await orchestrator.callAgent(
      { agentId: 'critic', role: 'Critic', model: 'qwen3:8b', systemPrompt: 'x' },
      [{ role: 'user', content: 'Question?' }],
      1000,
      { roundtableId: 'rt-1', round: 1 }
    );
    expect(result.error).toBeNull();
    expect(result.response).toBe('ok');
  });
});

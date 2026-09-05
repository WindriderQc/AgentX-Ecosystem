'use strict';

jest.mock('../../src/services/routing/inferenceAttemptExecutor', () => ({
  executeAdmittedOllamaAttempt: jest.fn()
}));
jest.mock('../../src/services/modelRouter', () => ({
  getTargetForModel: jest.fn(() => 'http://ollama.test:11434')
}));
jest.mock('../../models/Roundtable', () => ({}));

const { executeAdmittedOllamaAttempt } = require('../../src/services/routing/inferenceAttemptExecutor');
const { _internal } = require('../../src/services/roundtable/qualityAnalyzer');

describe('roundtable quality judge admission', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses the shared exact-terminal admitted executor', async () => {
    executeAdmittedOllamaAttempt.mockResolvedValue({
      ok: true,
      status: 200,
      data: { response: '{"clarity":8,"overall":8}', done: true }
    });

    await expect(_internal.callJudge('score this')).resolves.toEqual({
      success: true,
      scores: { clarity: 8, overall: 8 }
    });
    expect(executeAdmittedOllamaAttempt).toHaveBeenCalledWith(expect.objectContaining({
      hostUrl: 'http://ollama.test:11434',
      stream: false,
      useChat: false,
      admissionKind: 'council-quality-judge',
      principal: 'core-council',
      timeoutMs: expect.any(Number),
      payload: expect.objectContaining({ stream: false })
    }));
  });

  test('surfaces exact-terminal and heartbeat loss as a failed score', async () => {
    executeAdmittedOllamaAttempt
      .mockRejectedValueOnce(Object.assign(new Error('terminal missing'), {
        code: 'OLLAMA_RESPONSE_INCOMPLETE'
      }))
      .mockRejectedValueOnce(Object.assign(new Error('inference heartbeat lost'), {
        code: 'INFERENCE_ADMISSION_HEARTBEAT_FAILED'
      }));

    await expect(_internal.callJudge('score this')).resolves.toEqual({
      success: false,
      error: 'terminal missing'
    });
    await expect(_internal.callJudge('score this')).resolves.toEqual({
      success: false,
      error: 'inference heartbeat lost'
    });
  });
});

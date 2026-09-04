'use strict';

jest.mock('../../src/services/routing/inferenceAttemptExecutor', () => ({
  executeAdmittedOllamaAttempt: jest.fn()
}));

const { executeAdmittedOllamaAttempt } = require('../../src/services/routing/inferenceAttemptExecutor');
const { callOllamaForAnalysis } = require('../../src/helpers/promptAnalysis');

const MODEL_ENV_KEYS = [
  'PROMPT_ANALYSIS_MODEL',
  'OLLAMA_ANALYSIS_MODEL',
  'OLLAMA_MODEL',
  'AGENTX_DEFAULT_CHAT_MODEL',
];

describe('prompt analysis model selection', () => {
  const originalEnv = Object.fromEntries(MODEL_ENV_KEYS.map(key => [key, process.env[key]]));

  afterEach(() => {
    jest.clearAllMocks();
    for (const key of MODEL_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test('fails closed instead of guessing an unconfigured model tag', async () => {
    for (const key of MODEL_ENV_KEYS) delete process.env[key];

    const result = await callOllamaForAnalysis(
      { systemPrompt: 'Be useful.' },
      { stats: { totalConversations: 0, avgMessagesPerConversation: 0, mostCommonFailurePoints: [] }, themes: [], patterns: [] },
      [],
      'http://127.0.0.1:11434'
    );

    expect(result).toEqual(expect.objectContaining({
      success: false,
      fallback: true,
      error: 'A configured analysis or default chat model is required for prompt analysis',
    }));
    expect(executeAdmittedOllamaAttempt).not.toHaveBeenCalled();
  });

  test('routes configured analysis through the exact-terminal admitted executor', async () => {
    process.env.PROMPT_ANALYSIS_MODEL = 'analysis-model';
    executeAdmittedOllamaAttempt.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        response: JSON.stringify({
          root_causes: [],
          specific_problems: [],
          improvement_suggestions: [],
          suggested_prompt: 'Improved.',
          expected_improvements: []
        }),
        done: true
      }
    });

    const result = await callOllamaForAnalysis(
      { systemPrompt: 'Be useful.' },
      { stats: { totalConversations: 0, avgMessagesPerConversation: 0, mostCommonFailurePoints: [] }, themes: [], patterns: [] },
      [],
      'http://127.0.0.1:11434'
    );

    expect(result.success).toBe(true);
    expect(executeAdmittedOllamaAttempt).toHaveBeenCalledWith(expect.objectContaining({
      hostUrl: 'http://127.0.0.1:11434',
      model: 'analysis-model',
      stream: false,
      useChat: false,
      admissionKind: 'prompt-analysis',
      principal: 'core-prompt-analysis',
      timeoutMs: expect.any(Number),
      payload: expect.objectContaining({ stream: false })
    }));
  });

  test('does not report success when terminal validation abandons the admission', async () => {
    process.env.PROMPT_ANALYSIS_MODEL = 'analysis-model';
    executeAdmittedOllamaAttempt.mockRejectedValue(Object.assign(
      new Error('Ollama response ended without an exact terminal done object'),
      { code: 'OLLAMA_RESPONSE_INCOMPLETE' }
    ));

    const result = await callOllamaForAnalysis(
      { systemPrompt: 'Be useful.' },
      { stats: { totalConversations: 0, avgMessagesPerConversation: 0, mostCommonFailurePoints: [] }, themes: [], patterns: [] },
      [],
      'http://127.0.0.1:11434'
    );

    expect(result).toMatchObject({
      success: false,
      fallback: true,
      error: 'Ollama response ended without an exact terminal done object'
    });
  });
});

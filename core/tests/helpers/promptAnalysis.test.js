'use strict';

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
  });
});

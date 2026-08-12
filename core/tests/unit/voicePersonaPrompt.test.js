const { getPack, resolveMode } = require('../../src/services/voicePersonaPacks');
const {
  MAX_HISTORY_MESSAGES,
  buildMemorySection,
  buildVoicePersonaMessages,
  sanitizeHistory
} = require('../../src/services/voicePersonaPrompt');

describe('voicePersonaPrompt', () => {
  test('builds a spoken-use prompt with mode, memory, and safety context', async () => {
    const pack = getPack('personal_operator');
    const mode = resolveMode(pack, 'planner');
    const messages = await buildVoicePersonaMessages({
      pack,
      mode,
      prompt: 'Base system prompt',
      promptSource: 'manifest',
      scopeId: 'personal',
      memoryResults: [{ text: 'Example User prefers short direct answers.' }],
      safety: { flagIds: [], requiresAttention: false },
      history: [{ role: 'user', content: 'previous' }],
      userText: 'What next?'
    });

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Base system prompt');
    expect(messages[0].content).toContain('Mode: planner');
    expect(messages[0].content).toContain('Example User prefers short direct answers.');
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'What next?' });
  });

  test('limits and sanitizes transcript history', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `turn ${index}`
    })).concat([{ role: 'system', content: 'drop me' }]);

    const sanitized = sanitizeHistory(history);

    expect(sanitized).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(sanitized[0].content).toBe('turn 4');
    expect(sanitized.some((turn) => turn.role === 'system')).toBe(false);
  });

  test('formats RAG chunks into compact memory bullets', () => {
    const section = buildMemorySection([
      { text: 'Fact one.' },
      { chunk: { text: 'Fact two.' } }
    ]);

    expect(section).toContain('Relevant memory:');
    expect(section).toContain('- Fact one.');
    expect(section).toContain('- Fact two.');
  });
});

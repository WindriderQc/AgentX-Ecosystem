const {
  TELEGRAM_TEXT_LIMIT,
  buildTelegramText,
  normalizeTelegramConfig,
  sendTelegramText,
  truncateTelegram
} = require('../../src/services/roundtable/telegramPublisher');

describe('roundtable Telegram publisher', () => {
  test('normalizes a forum topic without accepting malformed identifiers', () => {
    expect(normalizeTelegramConfig({ chatId: '-100123', threadId: '42' })).toEqual({
      chatId: '-100123',
      threadId: 42,
      publishTurns: true,
      publishLifecycle: true
    });
    expect(() => normalizeTelegramConfig({ chatId: 'group-name' })).toThrow('numeric chat id');
    expect(() => normalizeTelegramConfig({ chatId: '123', threadId: 0 })).toThrow('positive integer');
  });

  test('renders final response text but never runtime thinking', () => {
    const text = buildTelegramText(
      { _id: 'abc12345678', telegram: { chatId: '1' } },
      {
        type: 'turn',
        turn: {
          role: 'Codex reviewer', round: 1, runtime: 'codex',
          response: 'Visible conclusion.', thinking: 'private chain of thought'
        }
      }
    );
    expect(text).toContain('Visible conclusion.');
    expect(text).not.toContain('private chain of thought');
  });

  test('truncates messages to the Telegram text limit', () => {
    const result = truncateTelegram('x'.repeat(TELEGRAM_TEXT_LIMIT + 100));
    expect(result.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(result).toContain('[message truncated]');
  });

  test('sends to the configured topic as plain text', async () => {
    let requested;
    await sendTelegramText(
      { chatId: '-100123', threadId: 99 },
      'Roundtable update *without Markdown parsing*',
      {
        env: { ROUNDTABLE_TELEGRAM_BOT_TOKEN: 'secret-token' },
        fetchImpl: async (url, options) => {
          requested = { url, options, body: JSON.parse(options.body) };
          return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
        }
      }
    );
    expect(requested.url).toContain('botsecret-token/sendMessage');
    expect(requested.body.chat_id).toBe('-100123');
    expect(requested.body.message_thread_id).toBe(99);
    expect(requested.body).not.toHaveProperty('parse_mode');
  });
});

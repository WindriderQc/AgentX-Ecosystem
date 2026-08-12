jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { NotificationService } = require('../../src/services/notificationService');

describe('NotificationService Telegram channel', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALERT_TELEGRAM_ENABLED = 'true';
    process.env.ALERT_TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.ALERT_TELEGRAM_CHAT_ID = '123456';
    process.env.ALERT_TELEGRAM_RETRY_MAX_ATTEMPTS = '1';
    delete process.env.ALERT_TEST_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('sends a plain-text Bot API message without exposing secrets in status', async () => {
    const service = new NotificationService();
    const fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    service._getFetch = jest.fn().mockResolvedValue(fetch);

    const result = await service.send('telegram', {
      _id: 'alert-1',
      title: 'Host offline',
      message: 'Host Alpha is unreachable',
      severity: 'critical',
      ruleName: 'Host health',
      source: 'agentx',
      context: { component: 'ollama' },
      createdAt: new Date()
    });

    expect(result).toEqual(expect.objectContaining({ sent: true, statusCode: 200 }));
    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Host Alpha is unreachable')
      })
    );
    expect(service.getStatus().telegram).toEqual({ enabled: true, configured: true });
    expect(JSON.stringify(service.getStatus())).not.toContain('test-token');
    expect(JSON.stringify(service.getStatus())).not.toContain('123456');
  });

  test('fails closed when enabled without both deployment secrets', async () => {
    delete process.env.ALERT_TELEGRAM_CHAT_ID;
    const service = new NotificationService();

    await expect(service.send('telegram', { _id: 'alert-2' })).resolves.toEqual({
      sent: false,
      error: 'Telegram bot token or chat id not configured'
    });
  });
});

const { NotificationService } = require('../../src/services/notificationService');

describe('NotificationService external adapter boundary', () => {
  test.each(['email', 'slack', 'telegram', 'webhook'])(
    'never performs embedded %s delivery',
    async (channel) => {
      const service = new NotificationService();
      await expect(service.send(channel, { _id: 'alert-1' })).resolves.toEqual(expect.objectContaining({
        sent: false,
        code: 'ADAPTER_REQUIRED'
      }));
      expect(service.getStatus()[channel]).toEqual({
        enabled: false,
        configured: false,
        external: true
      });
    }
  );
});

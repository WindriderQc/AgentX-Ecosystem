'use strict';

const EXTERNAL_CHANNELS = Object.freeze(['email', 'slack', 'telegram', 'webhook']);
const ADAPTER_MESSAGE = 'External notification delivery is not embedded in Agent X. Install a separate adapter that consumes the alert API.';

/**
 * Compatibility facade for retired outbound notification channels.
 *
 * Alert persistence and local logging remain product-owned. This service never
 * reads delivery credentials and never performs network I/O.
 */
class NotificationService {
  constructor() {
    this.config = Object.freeze(Object.fromEntries(
      EXTERNAL_CHANNELS.map((channel) => [channel, Object.freeze({
        enabled: false,
        configured: false,
        external: true
      })])
    ));
  }

  async send(channel) {
    if (!EXTERNAL_CHANNELS.includes(channel)) {
      return { sent: false, error: `Unknown channel: ${channel}` };
    }
    return { sent: false, error: ADAPTER_MESSAGE, code: 'ADAPTER_REQUIRED' };
  }

  async verifyChannel(channel) {
    if (!EXTERNAL_CHANNELS.includes(channel)) {
      return { valid: false, error: `Unknown channel: ${channel}` };
    }
    return { valid: false, error: ADAPTER_MESSAGE, code: 'ADAPTER_REQUIRED' };
  }

  getStatus() {
    return Object.fromEntries(EXTERNAL_CHANNELS.map((channel) => [channel, {
      enabled: false,
      configured: false,
      external: true
    }]));
  }
}

let instance = null;

function getNotificationService() {
  if (!instance) instance = new NotificationService();
  return instance;
}

module.exports = {
  ADAPTER_MESSAGE,
  EXTERNAL_CHANNELS,
  NotificationService,
  getNotificationService
};

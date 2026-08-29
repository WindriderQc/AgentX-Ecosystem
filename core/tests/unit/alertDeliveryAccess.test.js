'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  alertDeliveryAccessAllowed,
  requireAlertDeliveryAccess,
} = require('../../src/helpers/alertDeliveryAccess');

const ENV_KEYS = [
  'AGENTX_ALERT_DELIVERY_TOKEN',
  'AGENTX_OPERATOR_TOKEN',
  'AGENTX_ADMIN_TOKEN',
  'AGENTX_TRUST_INTERNAL_SERVICE_HOSTS',
  'AGENTX_TRUST_LOOPBACK_PROXY_UI',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function request({ headers = {}, ip = '203.0.113.9' } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip,
    protocol: 'http',
    headers: normalized,
    socket: { remoteAddress: ip },
    get(name) {
      return normalized[String(name).toLowerCase()];
    }
  };
}

describe('alert-delivery scoped machine access', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts only the exact configured token from a remote automation worker', () => {
    process.env.AGENTX_ALERT_DELIVERY_TOKEN = 'delivery-secret';
    expect(alertDeliveryAccessAllowed(request({
      headers: { host: 'agentx.example', 'x-agentx-alert-delivery-token': 'delivery-secret' }
    }))).toBe(true);
    expect(alertDeliveryAccessAllowed(request({
      headers: { host: 'agentx.example', 'x-agentx-alert-delivery-token': 'wrong-secret' }
    }))).toBe(false);
  });

  it('fails closed for a remote caller when the token is unconfigured', () => {
    expect(alertDeliveryAccessAllowed(request({
      headers: { host: 'agentx.example', 'x-agentx-alert-delivery-token': 'invented' }
    }))).toBe(false);
  });

  it('preserves loopback and operator authority', () => {
    expect(alertDeliveryAccessAllowed(request({
      headers: { host: '127.0.0.1:3180' },
      ip: '127.0.0.1'
    }))).toBe(true);

    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    expect(alertDeliveryAccessAllowed(request({
      headers: { host: 'agentx.example', 'x-agentx-operator-token': 'operator-secret' }
    }))).toBe(true);
  });

  it('returns a stable denial and the route mounts it before the handler', () => {
    const req = request({ headers: { host: 'agentx.example' } });
    const next = jest.fn();
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    requireAlertDeliveryAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ALERT_DELIVERY_ACCESS_REQUIRED'
    }));

    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'routes', 'alerts-ops.js'),
      'utf8'
    );
    expect(routeSource).toContain(
      "router.post('/:id/delivery-status', requireAlertDeliveryAccess, async (req, res) => {"
    );
  });
});

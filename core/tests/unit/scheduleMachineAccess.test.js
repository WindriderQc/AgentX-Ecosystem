'use strict';

const {
  SCHEDULE_TOKEN_HEADER,
  scheduleTokenAllowed,
  scheduleMachineAccessAllowed,
  requireScheduleMachineAccess,
} = require('../../src/helpers/scheduleMachineAccess');

const ENV_KEYS = [
  'AGENTX_SCHEDULE_TOKEN',
  'AGENTX_OPERATOR_TOKEN',
  'AGENTX_ADMIN_TOKEN',
  'AGENTX_TRUST_INTERNAL_SERVICE_HOSTS',
  'AGENTX_TRUST_LOOPBACK_PROXY_UI',
  'CORE_PUBLIC_URL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

function request({ headers = {}, ip = '203.0.113.9', protocol = 'http' } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip,
    protocol,
    headers: normalized,
    socket: { remoteAddress: ip },
    get(name) {
      return normalized[String(name).toLowerCase()];
    }
  };
}

describe('schedule machine access', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts only the exact purpose-scoped token from a remote machine', () => {
    process.env.AGENTX_SCHEDULE_TOKEN = 'schedule-secret';

    expect(SCHEDULE_TOKEN_HEADER).toBe('X-AgentX-Schedule-Token');
    expect(scheduleTokenAllowed(request({
      headers: {
        host: 'remote-scheduler.example',
        'x-agentx-schedule-token': 'schedule-secret'
      }
    }))).toBe(true);
    expect(scheduleTokenAllowed(request({
      headers: {
        host: 'remote-scheduler.example',
        'x-agentx-schedule-token': 'not-the-secret'
      }
    }))).toBe(false);
  });

  it.each([
    ['missing configuration and missing header', undefined, undefined],
    ['missing configuration and supplied header', undefined, 'invented-secret'],
    ['configured token and missing header', 'schedule-secret', undefined],
    ['configured token and wrong header', 'schedule-secret', 'not-the-secret'],
  ])('fails closed for a remote machine with %s', (_label, configured, presented) => {
    if (configured !== undefined) process.env.AGENTX_SCHEDULE_TOKEN = configured;
    const headers = { host: 'remote-scheduler.example' };
    if (presented !== undefined) headers['x-agentx-schedule-token'] = presented;

    expect(scheduleMachineAccessAllowed(request({ headers }))).toBe(false);
  });

  it('preserves same-origin UI, operator-token, and explicit trusted-local authority', () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';

    expect(scheduleMachineAccessAllowed(request({
      ip: '127.0.0.1',
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin'
      }
    }))).toBe(true);
    expect(scheduleMachineAccessAllowed(request({
      headers: {
        host: 'remote-operator.example',
        'x-agentx-operator-token': 'operator-secret'
      }
    }))).toBe(true);
    expect(scheduleMachineAccessAllowed(request({
      headers: { host: 'core:3080' }
    }))).toBe(true);
  });

  it('returns a stable denial without advancing an unauthorized request', () => {
    const req = request({ headers: { host: 'remote-scheduler.example' } });
    const next = jest.fn();
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };

    requireScheduleMachineAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SCHEDULE_MACHINE_ACCESS_REQUIRED'
    }));
  });
});

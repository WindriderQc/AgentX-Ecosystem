'use strict';

const {
  benchmarkServiceAccessAllowed,
  requireBenchmarkServiceAccess,
} = require('../../src/middleware/benchmarkServiceAccess');

const ENV_KEYS = [
  'AGENTX_BENCHMARK_TOKEN',
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

describe('Benchmark route-local service access', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts the exact scoped Benchmark token from a remote machine', () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    expect(benchmarkServiceAccessAllowed(request({
      headers: {
        host: 'core:3080',
        'x-agentx-benchmark-token': 'benchmark-secret'
      }
    }))).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'not-the-secret']
  ])('rejects a %s token from an untrusted remote machine', (_label, token) => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
    const headers = { host: 'remote-benchmark.example' };
    if (token !== undefined) headers['x-agentx-benchmark-token'] = token;

    expect(benchmarkServiceAccessAllowed(request({ headers }))).toBe(false);
  });

  it('preserves the explicit secret-free trusted internal-machine authority', () => {
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
    expect(benchmarkServiceAccessAllowed(request({
      headers: { host: 'core:3080' }
    }))).toBe(true);
  });

  it('requires the scoped token from an internal machine once a token is configured', () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
    expect(benchmarkServiceAccessAllowed(request({
      headers: { host: 'core:3080' }
    }))).toBe(false);
  });

  it('preserves same-origin UI and remote operator-token authorities', () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';

    expect(benchmarkServiceAccessAllowed(request({
      ip: '127.0.0.1',
      headers: {
        host: '127.0.0.1:3180',
        origin: 'http://127.0.0.1:3180',
        'sec-fetch-site': 'same-origin'
      }
    }))).toBe(true);
    expect(benchmarkServiceAccessAllowed(request({
      headers: {
        host: 'public.example',
        'x-agentx-operator-token': 'operator-secret'
      }
    }))).toBe(true);
  });

  it('returns a stable 403 response and never advances an unauthorized request', () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    const req = request({ headers: { host: 'remote-benchmark.example' } });
    const next = jest.fn();
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };

    requireBenchmarkServiceAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BENCHMARK_SERVICE_ACCESS_REQUIRED'
    }));
  });
});

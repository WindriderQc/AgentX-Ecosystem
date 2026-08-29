'use strict';

const crypto = require('crypto');
const {
  memoryReviewProducerAccessAllowed,
  memoryReviewProducerRequestIdentity,
  memoryReviewTokenAllowed,
  requireMemoryReviewProducerAccess,
  tokensMatch,
} = require('../../src/middleware/memoryReviewProducerAccess');

const ENV_KEYS = [
  'AGENTX_MEMORY_REVIEW_TOKEN',
  'AGENTX_OPERATOR_TOKEN',
  'AGENTX_ADMIN_TOKEN',
  'AGENTX_OPERATOR_UI_HOSTS',
  'AGENTX_TRUSTED_UI_HOSTS',
  'AGENTX_TRUST_INTERNAL_SERVICE_HOSTS',
  'AGENTX_TRUST_LOOPBACK_PROXY_UI',
  'CORE_PUBLIC_URL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function request({ headers = {}, ip = '203.0.113.9', protocol = 'http' } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip,
    protocol,
    socket: { remoteAddress: ip },
    get(name) {
      return normalized[String(name).toLowerCase()];
    },
  };
}

describe('Memory Review producer access', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('uses timing-safe equality for same-length non-empty token values', () => {
    const timingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');

    expect(tokensMatch('review-token', 'review-token')).toBe(true);
    expect(tokensMatch('review-token', 'review-tokem')).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);

    timingSafeEqual.mockRestore();
  });

  test('fails closed for a remote producer when the token is unset, missing, or wrong', () => {
    const remote = request({ headers: { host: 'producer.example.test' } });
    const arbitrary = request({
      headers: {
        host: 'producer.example.test',
        'x-agentx-memory-review-token': 'arbitrary-token',
      },
    });

    expect(memoryReviewTokenAllowed(remote)).toBe(false);
    expect(memoryReviewTokenAllowed(arbitrary)).toBe(false);
    expect(memoryReviewProducerAccessAllowed(remote)).toBe(false);

    process.env.AGENTX_MEMORY_REVIEW_TOKEN = 'memory-review-secret';
    expect(memoryReviewTokenAllowed(remote)).toBe(false);
    expect(memoryReviewTokenAllowed(arbitrary)).toBe(false);
  });

  test('accepts only the exact purpose-scoped header from a remote producer', () => {
    process.env.AGENTX_MEMORY_REVIEW_TOKEN = 'memory-review-secret';
    const scoped = request({
      headers: {
        host: 'producer.example.test',
        'x-agentx-memory-review-token': 'memory-review-secret',
      },
    });

    expect(memoryReviewProducerAccessAllowed(scoped)).toBe(true);
    expect(memoryReviewProducerRequestIdentity(scoped)).toBe('memory-review-producer-token');
  });

  test('preserves same-origin UI, operator-token, and explicitly trusted local-machine paths', () => {
    const sameOrigin = request({
      ip: '127.0.0.1',
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(memoryReviewProducerAccessAllowed(sameOrigin)).toBe(true);

    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    const operator = request({
      headers: {
        host: 'producer.example.test',
        'x-agentx-operator-token': 'operator-secret',
      },
    });
    expect(memoryReviewProducerAccessAllowed(operator)).toBe(true);

    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
    const trustedInternal = request({ headers: { host: 'core:3080' } });
    expect(memoryReviewProducerAccessAllowed(trustedInternal)).toBe(true);
    expect(memoryReviewProducerRequestIdentity(trustedInternal)).toBe('trusted-local-machine');

    const browserShapedInternal = request({
      headers: {
        host: 'core:3080',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(memoryReviewProducerAccessAllowed(browserShapedInternal)).toBe(false);
  });

  test('returns a stable 403 and never advances an unauthorized request', () => {
    const req = request({ headers: { host: 'producer.example.test' } });
    const next = jest.fn();
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    requireMemoryReviewProducerAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MEMORY_REVIEW_PRODUCER_ACCESS_REQUIRED',
    }));
  });
});

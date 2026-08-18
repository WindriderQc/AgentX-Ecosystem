/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and excessive requests
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../../config/logger');
const { resolveCallerPolicy } = require('../services/routing/callerPolicy');

function getClientKey(req) {
  // In tests, allow callers to isolate rate limit buckets deterministically.
  if (process.env.NODE_ENV === 'test') {
    const testKey = req.get('x-test-client');
    if (testKey) return `test:${testKey}`;
  }

  // Default: key by IP (IPv6-aware)
  return ipKeyGenerator(req.ip);
}

function getGeneralApiKey(req) {
  // In tests, preserve deterministic bucketing.
  if (process.env.NODE_ENV === 'test') {
    return getClientKey(req);
  }

  // x-api-key is forwarded for compatibility but is not authenticated by this
  // middleware. Letting it select a bucket would allow unlimited key rotation.
  return ipKeyGenerator(req.ip);
}

const NESTOR_CONSUMER_BASE_PATH = '/api/consumers/nestor/v1';

function isNestorConsumerPath(req) {
  const requestPath = String(req.originalUrl || '').split('?', 1)[0];
  return requestPath === NESTOR_CONSUMER_BASE_PATH
    || requestPath.startsWith(`${NESTOR_CONSUMER_BASE_PATH}/`);
}

const AUTOMATION_CONTROL_PREFIXES = [
  '/api/pipeline'
];

function isAutomationControlPath(req) {
  const path = String(req.originalUrl || '').split('?', 1)[0];
  return AUTOMATION_CONTROL_PREFIXES.some((prefix) => (
    path === prefix || path.startsWith(`${prefix}/`)
  ));
}

/**
 * General API rate limiter
 * 500 requests per 15 minutes
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: {
    status: 'error',
    message: 'Too many requests. Please try again after 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getGeneralApiKey,
  validate: { ip: false },
  skip: (req) => (
    req.originalUrl.startsWith('/api/benchmark')
    || req.originalUrl.startsWith('/api/buddy')
    || req.originalUrl.startsWith('/api/nerve-center')
    || isNestorConsumerPath(req)
    || req.originalUrl.startsWith('/api/inference/generate')  // Route via inferenceCallerRouter instead
    || isAutomationControlPath(req)
  ),
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    res.status(429).json({
      status: 'error',
      message: 'Too many requests. Please slow down and try again later.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Automation control-plane limiter
 * Separate high-volume bucket for Mongo pipeline lifecycle and bounded
 * automation paths. These are trusted automation surfaces, but they
 * still retain a finite ceiling and independent rate-limit telemetry.
 */
const automationControlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: {
    status: 'error',
    message: 'Automation control-plane rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `automation:${getClientKey(req)}`,
  validate: { ip: false },
  handler: (req, res) => {
    logger.warn('Automation control-plane rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    res.status(429).json({
      status: 'error',
      message: 'Automation control-plane traffic is temporarily rate-limited.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Benchmark rate limiter
 * Higher limits for polling and batch testing
 * 5000 requests per 15 minutes
 */
const benchmarkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: {
    status: 'error',
    message: 'Benchmark rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey
});

/**
 * Internal caller rate limiter (task 0141)
 * Same ceiling as benchmarkLimiter (5000/15min) but a separate bucket so
 * its stats are independently trackable from benchmark traffic.
 * Used by nestor/*, legacy buddy/*, chat-*, nerve-center-*, alerts-*, and other internal
 * callers under core/routes/ that shouldn't share the tight external
 * apiLimiter ceiling during active corpus runs.
 */
const internalCallerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: {
    status: 'error',
    message: 'Internal caller rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const base = getClientKey(req);
    // Namespace the bucket so it doesn't collide with benchmarkLimiter
    // even though both share keyGenerator for test determinism.
    return `internal:${base}`;
  },
  validate: { ip: false }
});

/**
 * Chat endpoint rate limiter
 * 20 requests per minute (prevents spam/abuse)
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    status: 'error',
    message: 'Too many chat requests. Please wait a moment.'
  },
  keyGenerator: (req) => {
    if (process.env.NODE_ENV === 'test') {
      return getClientKey(req);
    }
    return ipKeyGenerator(req.ip);
  },
  validate: { ip: false },
  handler: (req, res) => {
    logger.warn('Chat rate limit exceeded', { ip: req.ip });
    res.status(429).json({
      status: 'error',
      message: 'You are sending messages too quickly. Please wait a moment.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * Strict rate limiter for expensive operations
 * 10 requests per minute
 */
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    status: 'error',
    message: 'This operation is rate-limited. Please try again in a minute.'
  },
  keyGenerator: (req) => {
    if (process.env.NODE_ENV === 'test') {
      return getClientKey(req);
    }
    return ipKeyGenerator(req.ip);
  },
  validate: { ip: false },
  handler: (req, res) => {
    logger.warn('Strict rate limit exceeded', {
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      status: 'error',
      message: 'This operation is temporarily rate-limited. Please try again shortly.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * Buddy companion rate limiter
 * 30 requests per minute (general buddy endpoints)
 */
const buddyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: getClientKey,
  validate: { ip: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfterMs = Math.max(0, req.rateLimit.resetTime - Date.now());
    res.status(429).json({
      reaction: null,
      error: 'rate_limited',
      retryAfterMs,
      message: 'Too many buddy requests. Please slow down.'
    });
  }
});

/**
 * Versioned Nestor consumer limiter
 *
 * The desktop contract has a larger independent budget than the legacy Buddy
 * API and always returns the documented v1 error envelope.
 */
const nestorConsumerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `nestor:${getClientKey(req)}`,
  validate: { ip: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfterMs = Math.max(0, req.rateLimit.resetTime - Date.now());
    const message = 'Nestor v1 request rate limit exceeded. Please retry shortly.';
    res.status(429).json({
      ok: false,
      status: 'error',
      error: message,
      message,
      code: 'NESTOR_RATE_LIMITED',
      retryAfterMs,
    });
  },
});

/**
 * Buddy react rate limiter (LLM calls are expensive)
 * 10 requests per minute
 */
const buddyReactLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: getClientKey,
  validate: { ip: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfterMs = Math.max(0, req.rateLimit.resetTime - Date.now());
    res.status(429).json({
      reaction: null,
      error: 'rate_limited',
      retryAfterMs,
      message: 'Too many LLM reaction requests. Please wait.'
    });
  }
});

/**
 * Caller-aware router for /api/inference/generate
 *
 * Caller families are classified by the shared caller policy registry so
 * rate-limit and inference-lane behavior cannot drift independently.
 *
 * Callers are identified by `req.body.callerDetail`. This middleware must
 * run AFTER body parsing so `req.body` is available.
 *
 * Keeping benchmark and internal callers in separate buckets lets us
 * attribute drift / throttling independently (benchmark bucket is watched
 * for corpus-run drift detection; internal bucket is watched for buddy/chat
 * starvation incidents).
 */
function createInferenceCallerRouter() {
  return (req, res, next) => {
    const caller = req.body?.callerDetail || '';
    const { rateBucket } = resolveCallerPolicy(caller);

    if (rateBucket === 'benchmark') {
      return benchmarkLimiter(req, res, next);
    }

    if (rateBucket === 'internal') {
      return internalCallerLimiter(req, res, next);
    }

    // External / unrecognized callers — tight general limit
    return apiLimiter(req, res, next);
  };
}

const inferenceCallerRouter = createInferenceCallerRouter();

module.exports = {
  apiLimiter,
  automationControlLimiter,
  benchmarkLimiter,
  internalCallerLimiter,
  chatLimiter,
  strictLimiter,
  buddyLimiter,
  buddyReactLimiter,
  nestorConsumerLimiter,
  inferenceCallerRouter,
  AUTOMATION_CONTROL_PREFIXES,
  isAutomationControlPath,
  isNestorConsumerPath,
  getGeneralApiKey,
};

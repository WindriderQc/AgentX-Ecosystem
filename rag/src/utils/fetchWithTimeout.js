'use strict';

const http = require('node:http');

const logger = require('../../config/logger');
const {
  SERVICE_OUTBOUND_OPERATIONS,
  createServiceOutboundClient,
} = require('../clients/serviceOutboundClient');

function isAbortSignal(value) {
  return value === undefined
    || value === null
    || (typeof value === 'object'
      && typeof value.aborted === 'boolean'
      && typeof value.addEventListener === 'function'
      && typeof value.removeEventListener === 'function');
}

function validateRequestContext(context) {
  let keys;
  let operationId;
  let expectedOrigins;
  try {
    keys = Object.keys(context).sort().join(',');
    operationId = context.operationId;
    expectedOrigins = context.expectedOrigins;
  } catch {
    throw new TypeError('Outbound request context must name one operation and its configured origins.');
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || keys !== 'expectedOrigins,operationId') {
    throw new TypeError('Outbound request context must name one operation and its configured origins.');
  }
  const policy = SERVICE_OUTBOUND_OPERATIONS[operationId];
  if (!policy) throw new TypeError('Outbound request operation is not registered.');
  let ownedOrigins;
  try {
    ownedOrigins = Object.freeze(Array.isArray(expectedOrigins)
      ? [...expectedOrigins]
      : [expectedOrigins]);
  } catch {
    throw new TypeError('Outbound request context must name one operation and its configured origins.');
  }
  return Object.freeze({ expectedOrigins: ownedOrigins, operationId, policy });
}

function createBufferedResponse(result) {
  const bytes = Buffer.from(result.bytes);
  let bodyUsed = false;
  const consume = () => {
    if (bodyUsed) return Promise.reject(new TypeError('body used already'));
    bodyUsed = true;
    return Promise.resolve(Buffer.from(bytes));
  };
  const response = {
    headers: result.headers,
    ok: result.ok,
    status: result.status,
    statusText: http.STATUS_CODES[result.status] || '',
    url: result.url,
    async arrayBuffer() {
      const body = await consume();
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
    async json() {
      return JSON.parse((await consume()).toString('utf8'));
    },
    async text() {
      return (await consume()).toString('utf8');
    },
  };
  Object.defineProperty(response, 'bodyUsed', {
    enumerable: true,
    get: () => bodyUsed,
  });
  return Object.freeze(response);
}

/**
 * Compatibility facade for existing RAG callers. Every call must select a
 * closed logical operation and configured authority set. The shared executor
 * owns redirects, byte caps, request snapshots, and the full response deadline.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, context) {
  const requestContext = validateRequestContext(context);
  const { policy } = requestContext;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > policy.deadlineMs) {
    throw new TypeError('Outbound request timeout exceeds its registered operation ceiling.');
  }

  let callerSignal;
  try {
    callerSignal = options?.signal;
  } catch {
    throw new TypeError('Outbound request options are invalid.');
  }
  if (!isAbortSignal(callerSignal)) {
    throw new TypeError('Outbound request signal is invalid.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  try {
    if (callerSignal?.aborted) controller.abort();
    else if (callerSignal) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      // Close the check/listen race for signal-like implementations that abort
      // between the initial state read and listener registration.
      if (callerSignal.aborted) controller.abort();
    }
  } catch {
    try {
      callerSignal?.removeEventListener('abort', onCallerAbort);
    } catch {
      // A hostile signal-like object cannot retain a listener we never trust.
    }
    throw new TypeError('Outbound request signal is invalid.');
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    const client = createServiceOutboundClient({ expectedOrigins: requestContext.expectedOrigins });
    const result = await client.requestBytes(requestContext.operationId, url, {
      ...options,
      signal: controller.signal,
    });
    return createBufferedResponse(result);
  } catch (err) {
    if (timedOut) {
      logger.warn('HTTP request timed out', {
        operationId: requestContext.operationId,
        timeoutMs,
      });
      const timeoutError = new Error(`HTTP request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'OUTBOUND_DEADLINE_EXCEEDED';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    try {
      callerSignal?.removeEventListener('abort', onCallerAbort);
    } catch {
      // Cleanup failure must not replace the governed request outcome.
    }
  }
}

module.exports = fetchWithTimeout;
module.exports.createBufferedResponse = createBufferedResponse;
module.exports.validateRequestContext = validateRequestContext;

'use strict';

const logger = require('../../config/logger');

const CLOSED = 'CLOSED', OPEN = 'OPEN', HALF_OPEN = 'HALF_OPEN';
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const RECOVERY_MS       = 60 * 1000;       // 60 seconds

/** @type {Map<string, { failures: number, lastFailure: number, state: string }>} */
const breakers = new Map();

function _getOrCreate(hostUrl) {
  if (!breakers.has(hostUrl)) {
    breakers.set(hostUrl, { failures: 0, lastFailure: 0, state: CLOSED });
  }
  return breakers.get(hostUrl);
}

/** Check whether a request to hostUrl should proceed. */
function canRequest(hostUrl) {
  const b = _getOrCreate(hostUrl);
  if (b.state === CLOSED) return { allowed: true, state: CLOSED };
  if (b.state === OPEN) {
    if (Date.now() - b.lastFailure >= RECOVERY_MS) {
      b.state = HALF_OPEN;
      logger.warn(`Circuit breaker HALF_OPEN for ${hostUrl} — allowing probe request`);
      return { allowed: true, state: HALF_OPEN };
    }
    return {
      allowed: false, state: OPEN,
      reason: `Host circuit breaker open — skipping (${b.failures} consecutive failures)`
    };
  }
  return { allowed: true, state: HALF_OPEN };
}

/** Record a successful request — resets the breaker to CLOSED. */
function recordSuccess(hostUrl) {
  const b = _getOrCreate(hostUrl);
  if (b.state !== CLOSED) {
    logger.warn(`Circuit breaker CLOSED for ${hostUrl} — host recovered`);
  }
  b.failures = 0;
  b.lastFailure = 0;
  b.state = CLOSED;
}

/** Record a failed request — may trip the breaker to OPEN. */
function recordFailure(hostUrl) {
  const b = _getOrCreate(hostUrl);
  const now = Date.now();
  if (b.lastFailure && now - b.lastFailure > FAILURE_WINDOW_MS) {
    b.failures = 0;
  }
  b.failures += 1;
  b.lastFailure = now;
  if (b.state === HALF_OPEN) {
    b.state = OPEN;
    logger.warn(`Circuit breaker OPEN for ${hostUrl} — probe failed, back to OPEN`);
    return;
  }
  if (b.failures >= FAILURE_THRESHOLD) {
    b.state = OPEN;
    logger.warn(`Circuit breaker OPEN for ${hostUrl} after ${b.failures} failures`);
  }
}

function getState(hostUrl) {
  const b = breakers.get(hostUrl);
  return b ? { ...b } : { failures: 0, lastFailure: 0, state: CLOSED };
}

function resetAll() { breakers.clear(); }

module.exports = { canRequest, recordSuccess, recordFailure, getState, resetAll, CLOSED, OPEN, HALF_OPEN };

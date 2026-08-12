const fetch = require('node-fetch');
const logger = require('../../config/logger');

/**
 * Wraps node-fetch with an AbortController timeout.
 * On timeout, logs a warning and throws with a clear message.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('HTTP request timed out', { url, timeoutMs });
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = fetchWithTimeout;

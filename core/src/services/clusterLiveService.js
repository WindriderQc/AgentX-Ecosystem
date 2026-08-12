/**
 * Cluster Live Service
 *
 * Real-time polling of Ollama hosts to get currently loaded models
 * and running inference tasks. Separate from schedule data (static config).
 */
const logger = require('../../config/logger');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');

let _fetch = null;
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}
// Allow test injection
function _setFetch(fn) { _fetch = fn; }

const LIVE_TIMEOUT_MS = 3000;

/**
 * Poll all configured Ollama hosts for their current state.
 * Returns per-host status with loaded models. Gracefully degrades if a host is unreachable.
 * @returns {Promise<{ hosts: Array, polledAt: string }>}
 */
async function getLiveState() {
  const hosts = getConfiguredHosts();
  const polledAt = new Date().toISOString();

  const results = await Promise.allSettled(
    hosts.map(host => pollHost(host))
  );

  const hostStates = hosts.map((host, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') {
      return { ...host, status: 'online', ...result.value };
    }
    return {
      ...host,
      status: 'unreachable',
      error: result.reason?.message || 'Unknown error',
      models: []
    };
  });

  return { hosts: hostStates, polledAt };
}

/**
 * Poll a single host for running models via /api/ps.
 */
async function pollHost(host) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);

  try {
    const fetchFn = await getFetch();
    const res = await fetchFn(`${host.url}/api/ps`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const models = (data.models || []).map(m => ({
      name: m.name,
      model: m.model,
      size: m.size,
      sizeVram: m.size_vram,
      expiresAt: m.expires_at,
      digest: m.digest
    }));
    return { models };
  } catch (err) {
    logger.debug('Host poll failed', { host: host.id, url: host.url, error: err.message });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { getLiveState, _setFetch };

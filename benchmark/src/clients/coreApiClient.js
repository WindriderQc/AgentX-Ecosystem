/**
 * Core API Client
 *
 * HTTP client for benchmark → core service-to-service calls.
 * Replaces direct MongoDB access to core-owned collections.
 *
 * @see docs/SERVICE_CONTRACTS.md
 */

const fetch = require('node-fetch');
const logger = require('../../config/logger');

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const SERVICE_NAME = 'benchmark';
const DEFAULT_TIMEOUT_MS = 10000;
const PIN_RESTORE_TIMEOUT_MS = parseInt(process.env.CORE_PIN_RESTORE_TIMEOUT_MS, 10) || 600000;

/**
 * Base fetch wrapper with service-caller header and error handling.
 */
async function coreRequest(path, options = {}) {
  const url = `${CORE_URL}${path}`;
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  const res = await fetch(url, {
    ...options,
    timeout,
    headers: {
      'x-service-caller': SERVICE_NAME,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Core API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * GET /api/models/registry — list active models from core's model registry.
 *
 * @param {Object} [query] - Optional filters: category, tag, vendor, status
 * @returns {Promise<Object[]>} Array of model registry entries
 */
async function getModelRegistries(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null) params.set(key, value);
  }
  const qs = params.toString();
  const path = `/api/models/registry${qs ? `?${qs}` : ''}`;

  const data = await coreRequest(path);
  return data.data?.models || [];
}

/**
 * GET /api/models/registry/:name — get a single model by name.
 *
 * @param {string} name - Model name
 * @returns {Promise<Object|null>} Model registry entry or null
 */
async function getModelRegistryByName(name) {
  try {
    const data = await coreRequest(`/api/models/registry/${encodeURIComponent(name)}`);
    return data.data?.model || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ── GPU Host Preferences (Nerve Center) ─────────────────────────────────────

/**
 * GET /api/nerve-center/host-preferences — all host preferences with live status.
 * Returns array of { hostUrl, defaultModels, live, ... }
 * Normalised to a common shape so callers can use .host and .pinnedModels
 * the same way they did with the old sovereignty endpoint.
 * @returns {Promise<Object[]>} Array of { host, pinnedModels, ... }
 */
async function getDedicationStatuses() {
  const data = await coreRequest('/api/nerve-center/host-preferences');
  const prefs = Array.isArray(data) ? data : (data.data || []);
  return prefs.map(p => ({
    host: p.hostUrl,
    pinnedModels: p.defaultModels || [],
    state: p.live?.defaultLoaded ? 'ready' : 'unloaded',
    ...p
  }));
}

/**
 * Resolve a host URL to its Nerve Center hostKey.
 * Kept for backward compatibility — callers that already have a hostKey
 * can still use it, but reloadDedication no longer needs it.
 * @param {string} hostUrl - e.g. "http://192.0.2.66:11434"
 * @returns {Promise<string|null>} hostKey, or null if not found
 */
async function resolveHostKey(hostUrl) {
  const prefs = await getDedicationStatuses();
  const normalized = hostUrl.replace(/\/+$/, '');
  const match = prefs.find(p => (p.hostUrl || p.host || '').replace(/\/+$/, '') === normalized);
  return match?.hostKey || null;
}

/**
 * POST /api/nerve-center/host-preferences/:hostUrl/reload — reload default models.
 * @param {string} hostUrlOrKey - host URL (preferred) or legacy hostKey (ignored gracefully)
 */
async function restoreDedication(hostUrlOrKey) {
  // The new endpoint takes a hostUrl, not a hostKey.
  // If a bare key like "primary" was passed, resolve it first.
  let hostUrl = hostUrlOrKey;
  if (!hostUrlOrKey.startsWith('http')) {
    const prefs = await getDedicationStatuses();
    const match = prefs.find(p => p.hostKey === hostUrlOrKey);
    hostUrl = match?.hostUrl || hostUrlOrKey;
  }
  return coreRequest(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/reload`, {
    method: 'POST',
    timeout: PIN_RESTORE_TIMEOUT_MS
  });
}

// ── Benchmark Coordination ──────────────────────────────────────────────────
//
// Announce to core that a benchmark batch is taking over a host, so that
// other consumers (chat, buddy, bounded API clients) can route around us while we
// swap models in and out of VRAM. Callers treat claim acquisition as a
// required startup guard; a failed claim must block the batch before warmup.

/**
 * POST /api/nerve-center/host-preferences/:hostUrl/benchmark-claim
 * @param {string} hostUrl
 * @param {string} batchId
 * @param {number} [estimatedDurationMs]
 * @param {Object} [claimOptions]
 * @returns {Promise<{ claimed: boolean, reason?: string, pref?: object }>}
 */
async function claimHostForBenchmark(hostUrl, batchId, estimatedDurationMs = null, claimOptions = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim`;
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      body: JSON.stringify({ batchId, estimatedDurationMs, ...claimOptions })
    });
    return data.data || { claimed: true };
  } catch (err) {
    // 409 Conflict = already claimed — surface without throwing
    if (err.status === 409) {
      logger.warn('Benchmark claim conflict — host already claimed', {
        hostUrl, batchId, error: err.message
      });
      return { claimed: false, reason: err.message };
    }
    throw err;
  }
}

async function heartbeatBenchmarkClaim(hostUrl, batchId, estimatedDurationMs = null) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}/heartbeat`;
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      body: JSON.stringify({
        estimatedDurationMs,
        source: 'benchmark',
        owner: 'agentx-benchmark'
      })
    });
    return data.data || { heartbeat: true };
  } catch (err) {
    if (err.status === 409) return { heartbeat: false, reason: err.message };
    throw err;
  }
}

/**
 * DELETE /api/nerve-center/host-preferences/:hostUrl/benchmark-claim/:batchId
 * @param {string} hostUrl
 * @param {string} batchId
 * @returns {Promise<{ released: boolean, reason?: string }>}
 */
async function releaseBenchmarkClaim(hostUrl, batchId) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}`;
  const data = await coreRequest(path, { method: 'DELETE', timeout: PIN_RESTORE_TIMEOUT_MS });
  return data.data || { released: true };
}

/**
 * GET /api/nerve-center/host-preferences/benchmark-claims/active
 * List all hosts currently claimed by benchmark batches.
 * @returns {Promise<Array<{hostUrl, hostKey, batchId, prevStatus, claimedAt, estimatedDurationMs}>>}
 */
async function getBenchmarkClaims() {
  const data = await coreRequest('/api/nerve-center/host-preferences/benchmark-claims/active', { method: 'GET' });
  return data?.data?.claims || [];
}

module.exports = {
  getModelRegistries,
  getModelRegistryByName,
  coreRequest,
  getDedicationStatuses,
  resolveHostKey,
  restoreDedication,
  claimHostForBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  getBenchmarkClaims
};

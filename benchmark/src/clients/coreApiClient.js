/**
 * Core API Client
 *
 * HTTP client for benchmark → core service-to-service calls.
 * Replaces direct MongoDB access to core-owned collections.
 *
 * @see docs/SERVICE_CONTRACTS.md
 */

const crypto = require('crypto');
const logger = require('../../config/logger');
const nodeFetch = require('node-fetch');
const { withBenchmarkServiceAuth } = require('../helpers/coreServiceAuth');
const { createNodeFetchPeerTransport } = require('../helpers/outboundHttpTransport');
const {
  createOutboundHttpExecutor,
  readBoundedJson,
  readBoundedText,
} = require('../../../shared/outboundHttpExecutor');

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const SERVICE_NAME = 'benchmark';
const DEFAULT_TIMEOUT_MS = 10000;
const PIN_RESTORE_TIMEOUT_MS = 600000;
const PROTECTED_CORE_HEADERS = new Set([
  ':authority',
  'content-type',
  'host',
  'x-agentx-benchmark-token',
  'x-service-caller',
]);

const CORE_OPERATIONS = Object.freeze({
  MODEL_REGISTRIES: 'benchmark.core-api.model-registries',
  MODEL_REGISTRY: 'benchmark.core-api.model-registry',
  PUBLIC_CONFIG: 'benchmark.core-api.public-config',
  HOST_PREFERENCES: 'benchmark.core-api.host-preferences',
  HOST_RELOAD: 'benchmark.core-api.host-reload',
  CLAIM_ACQUIRE: 'benchmark.core-api.claim-acquire',
  CLAIM_HEARTBEAT: 'benchmark.core-api.claim-heartbeat',
  CLAIM_RELEASE: 'benchmark.core-api.claim-release',
  CLAIMS_ACTIVE: 'benchmark.core-api.claims-active',
});

function operation(method, pathPattern, {
  allowSearch = false,
  deadlineMs = DEFAULT_TIMEOUT_MS,
  maxRequestBytes = 0,
  maxResponseBytes = 1024 * 1024,
} = {}) {
  return Object.freeze({
    allowSearch,
    method,
    pathPattern,
    policy: Object.freeze({
      authoritySource: 'configured',
      deadlineMs,
      maxRequestBytes,
      maxResponseBytes,
    }),
  });
}

const CORE_OPERATION_SPECS = Object.freeze({
  [CORE_OPERATIONS.MODEL_REGISTRIES]: operation('GET', '^/api/models/registry$', {
    allowSearch: true,
    maxResponseBytes: 2 * 1024 * 1024,
  }),
  [CORE_OPERATIONS.MODEL_REGISTRY]: operation('GET', '^/api/models/registry/[^/]+$', {
    allowSearch: true,
  }),
  [CORE_OPERATIONS.PUBLIC_CONFIG]: operation('GET', '^/api/config$', {
    deadlineMs: 2_000,
    maxResponseBytes: 64 * 1024,
  }),
  [CORE_OPERATIONS.HOST_PREFERENCES]: operation('GET', '^/api/nerve-center/host-preferences$'),
  [CORE_OPERATIONS.HOST_RELOAD]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/reload$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS }
  ),
  [CORE_OPERATIONS.CLAIM_ACQUIRE]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim$',
    { maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIM_HEARTBEAT]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim/[^/]+/heartbeat$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIM_RELEASE]: operation(
    'DELETE',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim/[^/]+$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIMS_ACTIVE]: operation(
    'GET',
    '^/api/nerve-center/host-preferences/benchmark-claims/active$'
  ),
});

const claimGenerationByOwner = new Map();

function claimOwnerKey(hostUrl, batchId) {
  return `${hostUrl}\n${batchId}`;
}

function configuredCoreOrigin() {
  let parsed;
  try {
    parsed = new URL(CORE_URL);
  } catch {
    throw new Error('Core service URL is invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new Error('Core service URL is invalid');
  }
  return parsed.origin;
}

function parseCorePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Core API path is not registered');
  }
  return new URL(path, `${configuredCoreOrigin()}/`);
}

function operationMatches(spec, method, target) {
  return spec.method === method
    && new RegExp(spec.pathPattern).test(target.pathname)
    && (spec.allowSearch || !target.search);
}

function classifyCoreOperation(path, method) {
  const target = parseCorePath(path);
  const matches = Object.entries(CORE_OPERATION_SPECS)
    .filter(([, spec]) => operationMatches(spec, method, target));
  if (matches.length !== 1) throw new Error('Core API operation is not registered');
  return matches[0][0];
}

function normalizeCallerHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  let entries;
  try {
    if (Array.isArray(headers)) entries = headers;
    else if (typeof headers.entries === 'function') entries = [...headers.entries()];
    else if (typeof headers === 'object') entries = Object.entries(headers);
    else throw new TypeError('invalid headers');
  } catch {
    throw new Error('Core API headers are invalid');
  }

  const normalized = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new Error('Core API headers are invalid');
    }
    const name = String(entry[0]);
    if (PROTECTED_CORE_HEADERS.has(name.toLowerCase())) {
      throw new Error('Core API protected headers cannot be overridden');
    }
    normalized[name] = entry[1];
  }
  return normalized;
}

const coreExecutor = createOutboundHttpExecutor({
  operations: Object.fromEntries(Object.entries(CORE_OPERATION_SPECS)
    .map(([operationId, spec]) => [operationId, spec.policy])),
  authorityAdapter: ({ sinkId, target }) => {
    const spec = CORE_OPERATION_SPECS[sinkId];
    const requested = new URL(target);
    const expectedOrigin = configuredCoreOrigin();
    if (!spec || requested.origin !== expectedOrigin
      || !new RegExp(spec.pathPattern).test(requested.pathname)
      || (!spec.allowSearch && requested.search)) {
      throw new Error('Core API target is not registered');
    }
    return { expectedOrigin };
  },
  fetchImpl: nodeFetch,
  transportAdapter: createNodeFetchPeerTransport(),
});

/**
 * Base fetch wrapper with service-caller header and error handling.
 */
async function coreRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const operationId = options.operationId || classifyCoreOperation(path, method);
  const spec = CORE_OPERATION_SPECS[operationId];
  const target = parseCorePath(path);
  if (!spec || !operationMatches(spec, method, target)) {
    throw new Error('Core API operation is not registered');
  }

  const {
    operationId: _operationId,
    timeout: _legacyTimeout,
    ...requestOptions
  } = options;
  const headers = withBenchmarkServiceAuth({
    ...normalizeCallerHeaders(options.headers),
    'x-service-caller': SERVICE_NAME,
    'Content-Type': 'application/json',
  });
  const receipt = await coreExecutor.admitTarget(operationId, target.href, {
    signal: requestOptions.signal,
  });
  const res = await coreExecutor.request(receipt, {
    ...requestOptions,
    method,
    headers,
  });

  if (!res.ok) {
    const body = await readBoundedText(res);
    const err = new Error(`Core API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  return readBoundedJson(res);
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

  const data = await coreRequest(path, { operationId: CORE_OPERATIONS.MODEL_REGISTRIES });
  return data.data?.models || [];
}

/**
 * GET /api/models/registry/:name — get a single model by name.
 *
 * @param {string} name - Model name
 * @returns {Promise<Object|null>} Model registry entry or null
 */
async function getModelRegistryByName(name, options = {}) {
  try {
    const params = new URLSearchParams();
    if (options.host) params.set('host', options.host);
    const qs = params.toString();
    const data = await coreRequest(`/api/models/registry/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`, {
      operationId: CORE_OPERATIONS.MODEL_REGISTRY,
    });
    return data.data?.model || data.data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * GET /api/config — resolve Core-owned public browser URLs. The shared browser
 * resolver receives this as an injected loader so Benchmark never invokes its
 * generic raw-fetch fallback at runtime.
 */
async function loadCorePublicConfig({ signal } = {}) {
  return coreRequest('/api/config', {
    operationId: CORE_OPERATIONS.PUBLIC_CONFIG,
    signal,
  });
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
  const data = await coreRequest('/api/nerve-center/host-preferences', {
    operationId: CORE_OPERATIONS.HOST_PREFERENCES,
  });
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
 * @param {string} hostUrl - full Ollama base URL
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
    operationId: CORE_OPERATIONS.HOST_RELOAD,
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
  const ownerKey = claimOwnerKey(hostUrl, batchId);
  const claimGeneration = claimOptions.claimGeneration
    || claimGenerationByOwner.get(ownerKey)
    || crypto.randomUUID();
  claimGenerationByOwner.set(ownerKey, claimGeneration);
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_ACQUIRE,
      body: JSON.stringify({ ...claimOptions, batchId, claimGeneration, estimatedDurationMs })
    });
    const result = data.data || { claimed: true, claimGeneration };
    const confirmedGeneration = result.claimGeneration || result.pref?.benchmarkClaim?.claimGeneration;
    if (confirmedGeneration) claimGenerationByOwner.set(ownerKey, confirmedGeneration);
    return result;
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
      operationId: CORE_OPERATIONS.CLAIM_HEARTBEAT,
      body: JSON.stringify({
        claimGeneration: claimGenerationByOwner.get(claimOwnerKey(hostUrl, batchId)) || null,
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
  const data = await coreRequest(path, {
    method: 'DELETE',
    operationId: CORE_OPERATIONS.CLAIM_RELEASE,
    timeout: PIN_RESTORE_TIMEOUT_MS,
    body: JSON.stringify({
      claimGeneration: claimGenerationByOwner.get(claimOwnerKey(hostUrl, batchId)) || null
    })
  });
  const result = data.data || { released: true };
  if (result.released === true) claimGenerationByOwner.delete(claimOwnerKey(hostUrl, batchId));
  return result;
}

/**
 * GET /api/nerve-center/host-preferences/benchmark-claims/active
 * List all hosts currently claimed by benchmark batches.
 * @returns {Promise<Array<{hostUrl, hostKey, batchId, prevStatus, claimedAt, estimatedDurationMs}>>}
 */
async function getBenchmarkClaims() {
  const data = await coreRequest('/api/nerve-center/host-preferences/benchmark-claims/active', {
    method: 'GET',
    operationId: CORE_OPERATIONS.CLAIMS_ACTIVE,
  });
  const claims = data?.data?.claims || [];
  for (const claim of claims) {
    if (claim?.hostUrl && claim?.batchId && claim?.claimGeneration) {
      claimGenerationByOwner.set(
        claimOwnerKey(claim.hostUrl, claim.batchId),
        claim.claimGeneration
      );
    }
  }
  return claims;
}

module.exports = {
  getModelRegistries,
  getModelRegistryByName,
  loadCorePublicConfig,
  coreRequest,
  getDedicationStatuses,
  resolveHostKey,
  restoreDedication,
  claimHostForBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  getBenchmarkClaims,
  CORE_OPERATIONS,
  _internal: {
    classifyCoreOperation,
    configuredCoreOrigin,
    CORE_OPERATION_SPECS,
    normalizeCallerHeaders,
  },
};

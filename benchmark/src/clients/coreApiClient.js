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
const CLAIM_ACQUIRE_TIMEOUT_MS = Math.max(
  45_000,
  (Number(process.env.BENCHMARK_CLAIM_DRAIN_TIMEOUT_MS) || 30_000) + 15_000
);
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
  WORKLOAD_ACQUIRE: 'benchmark.core-api.workload-acquire',
  WORKLOAD_HEARTBEAT: 'benchmark.core-api.workload-heartbeat',
  WORKLOAD_RELEASE: 'benchmark.core-api.workload-release',
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
    { deadlineMs: CLAIM_ACQUIRE_TIMEOUT_MS, maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
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
  [CORE_OPERATIONS.WORKLOAD_ACQUIRE]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions$',
    { deadlineMs: CLAIM_ACQUIRE_TIMEOUT_MS, maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_HEARTBEAT]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/heartbeat$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RELEASE]: operation(
    'DELETE',
    '^/api/nerve-center/workload-admissions/[^/]+$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
});

const claimProofByOwner = new Map();
const workloadAdmissionById = new Map();

function claimOwnerKey(hostUrl, batchId) {
  return `${hostUrl}\n${batchId}`;
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function exactBenchmarkReleaseReceipt(result, expected) {
  const receipt = result?.releaseReceipt;
  const snapshot = receipt?.snapshot;
  const verification = receipt?.verification;
  const state = receipt?.state;
  const residents = snapshot?.residents;
  const actualExclusions = Array.isArray(snapshot?.excludedModels)
    ? [...new Set(snapshot.excludedModels.map(String))].sort()
    : null;
  const expectedExclusions = [...new Set(expected.excludedModels.map(String))].sort();
  const residentsComplete = Array.isArray(residents) && residents.every((entry) => (
    typeof entry?.model === 'string' && entry.model.length > 0
    && typeof entry?.digest === 'string' && entry.digest.length > 0
    && Number.isFinite(Number(entry.artifactSize)) && Number(entry.artifactSize) > 0
    && Number.isFinite(Number(entry.sizeVram)) && Number(entry.sizeVram) >= 0
    && Number.isInteger(Number(entry.contextLength)) && Number(entry.contextLength) > 0
    && Number.isFinite(Number(entry.keepAlive))
    && (entry.expiresAt === null || Number.isFinite(Date.parse(entry.expiresAt)))
  ));
  const identityChainExact = isSha256Hex(snapshot?.identityDigest)
    && isSha256Hex(snapshot?.appliedIdentityDigest)
    && verification?.snapshotIdentity === snapshot.appliedIdentityDigest
    && (expectedExclusions.length > 0
      || snapshot.identityDigest === snapshot.appliedIdentityDigest);

  return result?.released === true
    && receipt?.contract === 'agentx.benchmark-claim-release/v1'
    && receipt.hostUrl === expected.hostUrl
    && receipt.batchId === expected.batchId
    && receipt.claimGeneration === expected.claimGeneration
    && snapshot?.exact === true
    && snapshot?.residentCount === residents?.length
    && residentsComplete
    && identityChainExact
    && JSON.stringify(actualExclusions) === JSON.stringify(expectedExclusions)
    && verification?.status === 'ready'
    && verification?.ready === true
    && verification?.verified === true
    && verification?.degraded === false
    && verification?.mode === 'exact_runtime_snapshot'
    && state?.restoredStatus === expected.prevStatus
    && state?.claimCleared === true
    && state?.finalizerCleared === true
    && Number.isFinite(Date.parse(receipt.releasedAt));
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
    || claimProofByOwner.get(ownerKey)?.claimGeneration
    || crypto.randomUUID();
  claimProofByOwner.set(ownerKey, { claimGeneration });
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_ACQUIRE,
      body: JSON.stringify({ ...claimOptions, batchId, claimGeneration, estimatedDurationMs })
    });
    const result = data?.data;
    if (!result || typeof result !== 'object' || typeof result.claimed !== 'boolean') {
      const error = new Error('Core claim response did not contain an explicit claim decision');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_INVALID';
      throw error;
    }
    const confirmedGeneration = result.claimGeneration || result.pref?.benchmarkClaim?.claimGeneration;
    const confirmedBatchId = result.batchId || result.pref?.benchmarkClaim?.batchId;
    const prevStatus = result.prevStatus || result.pref?.benchmarkClaim?.prevStatus;
    const snapshotExact = result.snapshotExact === true
      || result.pref?.benchmarkClaim?.preClaimRuntime?.exact === true;
    const snapshotIdentity = result.snapshotIdentity
      || result.pref?.benchmarkClaim?.preClaimRuntime?.identityDigest;
    const nestedClaim = result.pref?.benchmarkClaim;
    if (result.claimed === true
      && (confirmedBatchId !== batchId || confirmedGeneration !== claimGeneration)) {
      const error = new Error('Core claim receipt did not attest the requested batch and generation');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true && nestedClaim
      && (nestedClaim.batchId !== confirmedBatchId
        || nestedClaim.claimGeneration !== confirmedGeneration
        || nestedClaim.prevStatus !== prevStatus
        || nestedClaim.preClaimRuntime?.exact !== snapshotExact
        || nestedClaim.preClaimRuntime?.identityDigest !== snapshotIdentity)) {
      const error = new Error('Core claim receipt projections disagree');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true
      && (typeof prevStatus !== 'string' || !prevStatus || !snapshotExact || !isSha256Hex(snapshotIdentity))) {
      const error = new Error('Core claim receipt did not attest an exact pre-claim runtime snapshot');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true) {
      claimProofByOwner.set(ownerKey, { claimGeneration, prevStatus, snapshotIdentity });
    } else claimProofByOwner.delete(ownerKey);
    return result;
  } catch (err) {
    // 409 Conflict = already claimed — surface without throwing
    if (err.status === 409) {
      logger.warn('Benchmark claim conflict — host already claimed', {
        hostUrl, batchId, error: err.message
      });
      claimProofByOwner.delete(ownerKey);
      return { claimed: false, reason: err.message };
    }
    // The request may have reached Core even when its response was lost.
    // Cleanup is fenced by the locally generated UUID, so it can never clear
    // another owner or a replacement generation.
    if (err.code !== 'OUTBOUND_REQUEST_TOO_LARGE') {
      await releaseBenchmarkClaim(hostUrl, batchId).catch(() => {});
    }
    claimProofByOwner.delete(ownerKey);
    throw err;
  }
}

async function heartbeatBenchmarkClaim(hostUrl, batchId, estimatedDurationMs = null, claimOptions = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}/heartbeat`;
  const proof = claimProofByOwner.get(claimOwnerKey(hostUrl, batchId));
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_HEARTBEAT,
      body: JSON.stringify({
        claimGeneration: proof?.claimGeneration || null,
        estimatedDurationMs,
        source: claimOptions.source || 'benchmark',
        owner: claimOptions.owner || 'agentx-benchmark'
      })
    });
    const result = data.data;
    const exact = result?.heartbeat === true
      && result.batchId === batchId
      && result.claimGeneration === proof?.claimGeneration
      && result.prevStatus === proof?.prevStatus
      && result.snapshotExact === true
      && result.snapshotIdentity === proof?.snapshotIdentity;
    if (!exact) {
      return { heartbeat: false, reason: result?.reason || 'Core benchmark heartbeat receipt is invalid' };
    }
    return result;
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
async function releaseBenchmarkClaim(hostUrl, batchId, options = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}`;
  const ownerKey = claimOwnerKey(hostUrl, batchId);
  const proof = claimProofByOwner.get(ownerKey);
  const excludedModels = Array.isArray(options.excludedModels) ? options.excludedModels : [];
  const data = await coreRequest(path, {
    method: 'DELETE',
    operationId: CORE_OPERATIONS.CLAIM_RELEASE,
    timeout: PIN_RESTORE_TIMEOUT_MS,
    body: JSON.stringify({
      claimGeneration: proof?.claimGeneration || null,
      ...(excludedModels.length > 0
        ? { excludedModels }
        : {})
    })
  });
  const result = data?.data;
  if (!result || typeof result !== 'object' || typeof result.released !== 'boolean') {
    const error = new Error('Core release response did not contain an explicit release decision');
    error.code = 'BENCHMARK_RELEASE_RECEIPT_INVALID';
    throw error;
  }
  if (result.released === true && !exactBenchmarkReleaseReceipt(result, {
    hostUrl,
    batchId,
    claimGeneration: proof?.claimGeneration || null,
    prevStatus: proof?.prevStatus || null,
    excludedModels
  })) {
    return {
      released: false,
      reason: 'Core benchmark release receipt is invalid',
      releaseReceipt: result.releaseReceipt || null
    };
  }
  if (result.released === true) claimProofByOwner.delete(ownerKey);
  return result;
}

async function acquireWorkloadAdmission(workloadId, options = {}) {
  const key = String(workloadId || '');
  if (!key) throw new Error('workloadId is required');
  const expectedKind = options.kind || 'benchmark';
  const expectedBatchId = options.batchId || null;
  const requestId = options.requestId || `benchmark:${key}`;
  const existing = workloadAdmissionById.get(key);
  if (existing) {
    if (existing.requestId !== requestId
      || existing.kind !== expectedKind
      || (existing.batchId || null) !== expectedBatchId) {
      const error = new Error('Local workload id already binds a different admission intent');
      error.code = 'WORKLOAD_ADMISSION_CONFLICT';
      throw error;
    }
    return { acquired: true, ...existing, idempotent: true };
  }
  const request = async () => coreRequest('/api/nerve-center/workload-admissions', {
    method: 'POST',
    operationId: CORE_OPERATIONS.WORKLOAD_ACQUIRE,
    body: JSON.stringify({
      requestId,
      workloadId: key,
      kind: expectedKind,
      batchId: expectedBatchId,
      hosts: Array.isArray(options.hosts) ? options.hosts : [],
      ttlMs: options.ttlMs || null
    })
  });
  let data;
  try {
    data = await request();
  } catch (error) {
    // A lost response after Core's atomic acquire is ambiguous. Retry the same
    // idempotency key once; Core returns the same Core-minted proof.
    try {
      data = await request();
    } catch {
      throw error;
    }
  }
  const result = data?.data;
  if (!result?.acquired || !result.admissionId || !result.generation
    || !result.principal
    || result.workloadId !== key
    || result.requestId !== requestId
    || result.kind !== expectedKind
    || (result.batchId || null) !== expectedBatchId) {
    const error = new Error(result?.reason || 'Core workload admission receipt is invalid');
    error.code = 'WORKLOAD_ADMISSION_REJECTED';
    throw error;
  }
  const receipt = {
    admissionId: result.admissionId,
    generation: result.generation,
    principal: result.principal,
    requestId,
    workloadId: key,
    kind: expectedKind,
    batchId: expectedBatchId,
    expiresAt: result.expiresAt || null
  };
  workloadAdmissionById.set(key, receipt);
  return { acquired: true, ...receipt };
}

async function heartbeatWorkloadAdmission(workloadId, ttlMs = null) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt) return { heartbeat: false, reason: 'local workload admission proof missing' };
  try {
    const data = await coreRequest(`/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}/heartbeat`, {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_HEARTBEAT,
      body: JSON.stringify({ generation: receipt.generation, ttlMs })
    });
    const result = data?.data;
    const exact = result?.heartbeat === true
      && result.admissionId === receipt.admissionId
      && result.generation === receipt.generation
      && result.principal === receipt.principal
      && result.requestId === receipt.requestId
      && result.workloadId === receipt.workloadId
      && result.kind === receipt.kind
      && (result.batchId || null) === (receipt.batchId || null);
    if (!exact) {
      return { heartbeat: false, reason: result?.reason || 'Core workload heartbeat receipt is invalid' };
    }
    receipt.expiresAt = result.expiresAt || receipt.expiresAt;
    return result;
  } catch (error) {
    if (error.status === 409) return { heartbeat: false, reason: error.message };
    throw error;
  }
}

async function releaseWorkloadAdmission(workloadId) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt) return { released: false, reason: 'local workload admission proof missing' };
  const data = await coreRequest(`/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}`, {
    method: 'DELETE',
    operationId: CORE_OPERATIONS.WORKLOAD_RELEASE,
    body: JSON.stringify({ generation: receipt.generation })
  });
  const result = data?.data;
  const exact = result?.released === true
    && result.admissionId === receipt.admissionId
    && result.generation === receipt.generation
    && result.principal === receipt.principal
    && result.requestId === receipt.requestId
    && result.workloadId === receipt.workloadId
    && result.kind === receipt.kind
    && (result.batchId || null) === (receipt.batchId || null)
    && Number.isFinite(Date.parse(result.releasedAt));
  if (!exact) return { released: false, reason: result?.reason || 'Core workload release receipt is invalid' };
  workloadAdmissionById.delete(key);
  return result;
}

function getBenchmarkClaimIdentity(hostUrl, batchId) {
  const claimGeneration = claimProofByOwner.get(claimOwnerKey(hostUrl, batchId))?.claimGeneration;
  if (!claimGeneration) return null;
  return { claimBatchId: batchId, claimGeneration };
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
  // Discovery is not capability acquisition. Never import claim generations
  // from this operator-visible list into the local proof map.
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
  getBenchmarkClaimIdentity,
  getBenchmarkClaims,
  acquireWorkloadAdmission,
  heartbeatWorkloadAdmission,
  releaseWorkloadAdmission,
  CORE_OPERATIONS,
  _internal: {
    classifyCoreOperation,
    configuredCoreOrigin,
    CORE_OPERATION_SPECS,
    normalizeCallerHeaders,
  },
};

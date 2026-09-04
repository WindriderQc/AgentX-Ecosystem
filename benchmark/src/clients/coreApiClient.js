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
const { normalizeModelTag } = require('../../../shared/modelNames');

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const SERVICE_NAME = 'benchmark';
const DEFAULT_TIMEOUT_MS = 10000;
const PIN_RESTORE_TIMEOUT_MS = 600000;
const RECOVERY_OWNER_TTL_MS = PIN_RESTORE_TIMEOUT_MS + 60_000;
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
  CLAIM_RELEASE_RECOVERY: 'benchmark.core-api.claim-release-recovery',
  CLAIMS_ACTIVE: 'benchmark.core-api.claims-active',
  WORKLOAD_ACQUIRE: 'benchmark.core-api.workload-acquire',
  WORKLOAD_HEARTBEAT: 'benchmark.core-api.workload-heartbeat',
  WORKLOAD_RELEASE: 'benchmark.core-api.workload-release',
  WORKLOAD_RELEASE_RECOVERY: 'benchmark.core-api.workload-release-recovery',
  WORKLOAD_RECOVERY_ARM: 'benchmark.core-api.workload-recovery-arm',
  WORKLOAD_RECOVERY_ADOPT: 'benchmark.core-api.workload-recovery-adopt',
  WORKLOAD_RECOVERY_HEARTBEAT: 'benchmark.core-api.workload-recovery-heartbeat',
  WORKLOAD_RECOVERY_ASSERT: 'benchmark.core-api.workload-recovery-assert',
  WORKLOAD_RECOVERY_TRANSITION: 'benchmark.core-api.workload-recovery-transition',
  WORKLOAD_RECOVERY_HOST_RESTORE: 'benchmark.core-api.workload-recovery-host-restore',
  WORKLOAD_RECOVERY_RELEASE: 'benchmark.core-api.workload-recovery-release',
  INFERENCE_GENERATE: 'benchmark.core-api.inference-generate',
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
  [CORE_OPERATIONS.CLAIM_RELEASE_RECOVERY]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim/[^/]+/release-receipt$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
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
  [CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/release-receipt$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_ARM]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/recovery$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_ADOPT]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/adopt$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_HEARTBEAT]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/heartbeat$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_ASSERT]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/assert$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_TRANSITION]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/transition$',
    { maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_HOST_RESTORE]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/restore-hosts$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 64 * 1024, maxResponseBytes: 512 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_RELEASE]: operation(
    'DELETE',
    '^/api/nerve-center/workload-recoveries/[^/]+$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.INFERENCE_GENERATE]: operation(
    'POST',
    '^/api/inference/generate$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 2 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024 }
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

function canonicalRuntimeResident(entry) {
  const expiryMs = entry?.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  return {
    model: entry?.model,
    digest: entry?.digest,
    artifactSize: Number(entry?.artifactSize),
    sizeVram: Number(entry?.sizeVram),
    contextLength: Number(entry?.contextLength),
    keepAlive: Number(entry?.keepAlive),
    expiresAt: Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null,
  };
}

function runtimeSnapshotIdentity(snapshot, residents = snapshot?.residents || []) {
  const canonicalResidents = residents.map(canonicalRuntimeResident)
    .sort((left, right) => left.model.localeCompare(right.model));
  return crypto.createHash('sha256').update(JSON.stringify({
    capturedAt: snapshot?.capturedAt ? new Date(snapshot.capturedAt).toISOString() : null,
    source: snapshot?.source || null,
    exact: snapshot?.exact === true,
    residents: canonicalResidents,
  })).digest('hex');
}

function modelIdentityKey(value) {
  return normalizeModelTag(String(value || '')).toLowerCase();
}

function runtimeResidentComplete(entry) {
  const keepAlive = Number(entry?.keepAlive);
  const expiryMs = entry?.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  const infiniteExpiry = Number.isFinite(expiryMs)
    && new Date(expiryMs).getUTCFullYear() >= 9000;
  return typeof entry?.model === 'string' && entry.model.length > 0
    && typeof entry?.digest === 'string' && entry.digest.length > 0
    && Number.isFinite(Number(entry.artifactSize)) && Number(entry.artifactSize) > 0
    && Number.isFinite(Number(entry.sizeVram)) && Number(entry.sizeVram) >= 0
    && Number.isInteger(Number(entry.contextLength)) && Number(entry.contextLength) > 0
    && (keepAlive === -1 || (Number.isFinite(keepAlive) && keepAlive > 0))
    && Number.isFinite(expiryMs)
    && (keepAlive !== -1 || infiniteExpiry);
}

function exactRuntimeSnapshot(snapshot) {
  const capturedAtMs = Date.parse(snapshot?.capturedAt);
  const residents = snapshot?.residents;
  const residentKeys = Array.isArray(residents)
    ? residents.map(entry => modelIdentityKey(entry?.model))
    : [];
  return snapshot?.exact === true
    && snapshot?.source === 'ollama_ps'
    && Number.isFinite(capturedAtMs)
    && Array.isArray(residents)
    && residents.every(runtimeResidentComplete)
    && residentKeys.every(Boolean)
    && new Set(residentKeys).size === residentKeys.length
    && isSha256Hex(snapshot?.identityDigest)
    && snapshot.identityDigest === runtimeSnapshotIdentity(snapshot);
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
  const expiredModels = Array.isArray(snapshot?.expiredModels)
    ? [...new Set(snapshot.expiredModels.map(String))].sort()
    : null;
  const originalSnapshot = expected.preClaimRuntime;
  const filterEvaluatedAtMs = Date.parse(snapshot?.filterEvaluatedAt);
  const releasedAtMs = Date.parse(receipt?.releasedAt);
  const expectedExcludedKeys = new Set(expectedExclusions.map(modelIdentityKey));
  const afterExplicitExclusions = exactRuntimeSnapshot(originalSnapshot)
    ? originalSnapshot.residents.filter(entry => !expectedExcludedKeys.has(modelIdentityKey(entry.model)))
    : [];
  const expectedExpired = afterExplicitExclusions
    .filter(entry => Number(entry.keepAlive) !== -1 && Date.parse(entry.expiresAt) <= filterEvaluatedAtMs)
    .map(entry => entry.model)
    .sort();
  const expectedResidents = afterExplicitExclusions
    .filter(entry => Number(entry.keepAlive) === -1 || Date.parse(entry.expiresAt) > filterEvaluatedAtMs)
    .map(canonicalRuntimeResident)
    .sort((left, right) => left.model.localeCompare(right.model));
  const actualResidents = Array.isArray(residents)
    ? residents.map(canonicalRuntimeResident).sort((left, right) => left.model.localeCompare(right.model))
    : null;
  const residentsComplete = Array.isArray(residents)
    && residents.every(runtimeResidentComplete)
    && new Set(residents.map(entry => modelIdentityKey(entry.model))).size === residents.length;
  const identityChainExact = isSha256Hex(snapshot?.identityDigest)
    && isSha256Hex(snapshot?.appliedIdentityDigest)
    && exactRuntimeSnapshot(originalSnapshot)
    && snapshot.identityDigest === originalSnapshot.identityDigest
    && snapshot.identityDigest === expected.snapshotIdentity
    && snapshot.capturedAt === new Date(originalSnapshot.capturedAt).toISOString()
    && snapshot.source === originalSnapshot.source
    && Number.isFinite(filterEvaluatedAtMs)
    && filterEvaluatedAtMs >= Date.parse(originalSnapshot.capturedAt)
    && Number.isFinite(releasedAtMs)
    && releasedAtMs >= filterEvaluatedAtMs
    && snapshot.appliedIdentityDigest === runtimeSnapshotIdentity(originalSnapshot, residents)
    && verification?.snapshotIdentity === snapshot.appliedIdentityDigest
    && JSON.stringify(actualResidents) === JSON.stringify(expectedResidents)
    && JSON.stringify(expiredModels) === JSON.stringify(expectedExpired);

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
    && snapshot.excludedModels.length === actualExclusions.length
    && snapshot.expiredModels.length === expiredModels.length
    && Array.isArray(expiredModels)
    && verification?.status === 'ready'
    && verification?.ready === true
    && verification?.verified === true
    && verification?.degraded === false
    && verification?.mode === 'exact_runtime_snapshot'
    && state?.restoredStatus === expected.prevStatus
    && state?.claimCleared === true
    && state?.finalizerCleared === true
    && Number.isFinite(releasedAtMs);
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
  const admission = workloadAdmissionById.get(String(batchId));
  if (!admission?.admissionId || !admission?.generation) {
    const error = new Error('Exact workload admission proof is required before claiming a host');
    error.code = 'WORKLOAD_ADMISSION_REQUIRED';
    throw error;
  }
  claimProofByOwner.set(ownerKey, { claimGeneration });
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_ACQUIRE,
      body: JSON.stringify({
        ...claimOptions,
        batchId,
        claimGeneration,
        admissionId: admission.admissionId,
        admissionGeneration: admission.generation,
        estimatedDurationMs
      })
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
    const preClaimRuntime = nestedClaim?.preClaimRuntime;
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
      && (typeof prevStatus !== 'string'
        || !prevStatus
        || !snapshotExact
        || !isSha256Hex(snapshotIdentity)
        || !exactRuntimeSnapshot(preClaimRuntime)
        || preClaimRuntime.identityDigest !== snapshotIdentity)) {
      const error = new Error('Core claim receipt did not attest an exact pre-claim runtime snapshot');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true) {
      claimProofByOwner.set(ownerKey, {
        claimGeneration,
        prevStatus,
        snapshotIdentity,
        preClaimRuntime: {
          capturedAt: new Date(preClaimRuntime.capturedAt).toISOString(),
          source: preClaimRuntime.source,
          exact: true,
          identityDigest: preClaimRuntime.identityDigest,
          residents: preClaimRuntime.residents.map(canonicalRuntimeResident),
        },
      });
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
      try {
        const cleanup = await releaseBenchmarkClaim(hostUrl, batchId);
        if (cleanup?.released !== true) {
          const cleanupError = new Error(cleanup?.reason || 'Ambiguous claim cleanup was not verified');
          cleanupError.code = 'BENCHMARK_CLAIM_CLEANUP_UNVERIFIED';
          err.cleanupError = cleanupError;
          err.retainAdmission = true;
          throw err;
        }
      } catch (cleanupError) {
        if (cleanupError === err) throw err;
        err.cleanupError = cleanupError;
        err.retainAdmission = true;
        throw err;
      }
    }
    claimProofByOwner.delete(ownerKey);
    throw err;
  }
}

async function heartbeatBenchmarkClaim(hostUrl, batchId, estimatedDurationMs = null, claimOptions = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}/heartbeat`;
  const proof = claimProofByOwner.get(claimOwnerKey(hostUrl, batchId));
  const admission = workloadAdmissionById.get(String(batchId));
  if (!admission?.admissionId || !admission?.generation) {
    return { heartbeat: false, reason: 'exact workload admission proof missing' };
  }
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_HEARTBEAT,
      body: JSON.stringify({
        claimGeneration: proof?.claimGeneration || null,
        admissionId: admission.admissionId,
        admissionGeneration: admission.generation,
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
  const admission = workloadAdmissionById.get(String(batchId));
  if (!admission?.admissionId || !admission?.generation) {
    return { released: false, reason: 'exact workload admission proof missing' };
  }
  const excludedModels = Array.isArray(options.excludedModels) ? options.excludedModels : [];
  const releaseBody = {
      claimGeneration: proof?.claimGeneration || null,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      ...(excludedModels.length > 0
        ? { excludedModels }
        : {})
  };
  const requestRelease = async () => {
    const data = await coreRequest(path, {
      method: 'DELETE',
      operationId: CORE_OPERATIONS.CLAIM_RELEASE,
      timeout: PIN_RESTORE_TIMEOUT_MS,
      body: JSON.stringify(releaseBody)
    });
    return data?.data;
  };
  let result;
  try {
    result = await requestRelease();
  } catch (releaseError) {
    // A transport failure or 5xx after Core's terminal CAS is ambiguous. Ask
    // the same authenticated authority for the durable exact receipt before
    // deciding whether to retry or retain the local fence for recovery.
    try {
      const recovery = await coreRequest(`${path}/release-receipt`, {
        method: 'POST',
        operationId: CORE_OPERATIONS.CLAIM_RELEASE_RECOVERY,
        body: JSON.stringify({
          claimGeneration: proof?.claimGeneration || null,
          admissionId: admission.admissionId,
          admissionGeneration: admission.generation
        })
      });
      const recovered = recovery?.data;
      if (recovered?.released === true) result = recovered;
      else if (recovered?.retryable === true && recovered?.finalizing !== true) result = await requestRelease();
      else throw releaseError;
    } catch (recoveryError) {
      if (recoveryError !== releaseError) releaseError.recoveryError = recoveryError;
      throw releaseError;
    }
  }
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
    snapshotIdentity: proof?.snapshotIdentity || null,
    preClaimRuntime: proof?.preClaimRuntime || null,
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
  const recoveryRequestId = `recovery:${requestId}`;
  const expectedHosts = [...new Set((Array.isArray(options.hosts) ? options.hosts : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))].sort();
  const existing = workloadAdmissionById.get(key);
  if (existing) {
    if (existing.requestId !== requestId
      || existing.kind !== expectedKind
      || (existing.batchId || null) !== expectedBatchId
      || JSON.stringify(existing.hosts || []) !== JSON.stringify(expectedHosts)) {
      const error = new Error('Local workload id already binds a different admission intent');
      error.code = 'WORKLOAD_ADMISSION_CONFLICT';
      throw error;
    }
    // A local receipt is only an identity hint, never current authority. Core
    // may have expired/reaped it and granted maintenance since our last call.
    // Re-attest the exact generation before allowing another mutation to use
    // this workload id.
    const renewed = await heartbeatWorkloadAdmission(key, options.ttlMs || null);
    if (renewed?.heartbeat === true) {
      return { acquired: true, ...existing, expiresAt: renewed.expiresAt || existing.expiresAt, idempotent: true };
    }
    workloadAdmissionById.delete(key);
  }
  const request = async () => coreRequest('/api/nerve-center/workload-admissions', {
    method: 'POST',
    operationId: CORE_OPERATIONS.WORKLOAD_ACQUIRE,
    body: JSON.stringify({
      requestId,
      workloadId: key,
      kind: expectedKind,
      batchId: expectedBatchId,
      hosts: expectedHosts,
      recoveryRequestId,
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
    || (result.batchId || null) !== expectedBatchId
    || JSON.stringify([...(result.hosts || [])].sort()) !== JSON.stringify(expectedHosts)) {
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
    hosts: expectedHosts,
    expiresAt: result.expiresAt || null
  };
  const arm = async () => coreRequest(
    `/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}/recovery`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_ARM,
      body: JSON.stringify({ generation: receipt.generation, recoveryRequestId })
    }
  );
  let armData;
  try {
    armData = await arm();
  } catch (error) {
    try {
      armData = await arm();
    } catch {
      // The caller never receives an admission before recovery quarantine is
      // durably armed, so no Product mutation can start in this gap.
      try {
        await coreRequest(`/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}`, {
          method: 'DELETE',
          operationId: CORE_OPERATIONS.WORKLOAD_RELEASE,
          body: JSON.stringify({ generation: receipt.generation })
        });
      } catch (cleanupError) {
        logger.error('Unarmed workload admission cleanup was not acknowledged', {
          workloadId: key,
          admissionId: receipt.admissionId,
          error: cleanupError.message
        });
        error.cleanupError = cleanupError;
      }
      throw error;
    }
  }
  const armed = armData?.data;
  const exactArm = armed?.armed === true
    && armed.admissionId === receipt.admissionId
    && armed.generation === receipt.generation
    && armed.principal === receipt.principal
    && armed.requestId === receipt.requestId
    && armed.workloadId === receipt.workloadId
    && armed.kind === receipt.kind
    && (armed.batchId || null) === (receipt.batchId || null)
    && JSON.stringify([...(armed.hosts || [])].sort()) === JSON.stringify(receipt.hosts || [])
    && armed.recoveryRequired === true
    && typeof armed.recoveryId === 'string'
    && typeof armed.recoveryGeneration === 'string'
    && armed.recoveryRequestId === recoveryRequestId;
  if (!exactArm) {
    throw Object.assign(new Error(armed?.reason || 'Core recovery quarantine receipt is invalid'), {
      code: 'WORKLOAD_RECOVERY_ARM_REJECTED',
      retainAdmission: true
    });
  }
  Object.assign(receipt, {
    recoveryRequired: true,
    recoveryId: armed.recoveryId,
    recoveryGeneration: armed.recoveryGeneration,
    recoveryRequestId,
    recoveryOwnerId: armed.recoveryOwnerId || null,
    recoveryState: armed.recoveryState,
    recoveryVersion: armed.recoveryVersion
  });
  workloadAdmissionById.set(key, receipt);
  await transitionWorkloadRecovery(key, 'MUTATING', {
    receipt: { contract: 'agentx.workload-recovery/v1', event: 'mutation-started', workloadId: key }
  });
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
      && (result.batchId || null) === (receipt.batchId || null)
      && JSON.stringify([...(result.hosts || [])].sort()) === JSON.stringify(receipt.hosts || [])
      && result.recoveryRequired === receipt.recoveryRequired
      && result.recoveryId === receipt.recoveryId
      && result.recoveryGeneration === receipt.recoveryGeneration
      && result.recoveryState === receipt.recoveryState
      && result.recoveryVersion === receipt.recoveryVersion;
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
  if (receipt.recoveryRequired && receipt.recoveryState !== 'RESTORED') {
    if (!new Set(['VERIFIED', 'RESTORED']).has(receipt.recoveryState)) {
      await transitionWorkloadRecovery(key, 'VERIFIED', {
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'workload-terminal', workloadId: key }
      });
    }
    if (receipt.recoveryState !== 'RESTORED') {
      await transitionWorkloadRecovery(key, 'RESTORED', {
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'authority-restored', workloadId: key }
      });
    }
  }
  const exactIdentity = result => result?.admissionId === receipt.admissionId
    && result.generation === receipt.generation
    && result.principal === receipt.principal
    && result.requestId === receipt.requestId
    && result.workloadId === receipt.workloadId
    && result.kind === receipt.kind
    && (result.batchId || null) === (receipt.batchId || null)
    && JSON.stringify([...(result.hosts || [])].sort()) === JSON.stringify(receipt.hosts || [])
    && (!receipt.recoveryRequired || (
      result.recoveryId === receipt.recoveryId
      && result.recoveryGeneration === receipt.recoveryGeneration
      && result.recoveryState === 'RESTORED'
      && result.recoveryReceipt?.contract === 'agentx.workload-recovery/v1'
    ));
  const exactRelease = result => result?.released === true
    && exactIdentity(result)
    && Number.isFinite(Date.parse(result.releasedAt));
  const requestRelease = () => coreRequest(
    receipt.recoveryRequired
      ? `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}`
      : `/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}`,
    {
      method: 'DELETE',
      operationId: receipt.recoveryRequired
        ? CORE_OPERATIONS.WORKLOAD_RECOVERY_RELEASE
        : CORE_OPERATIONS.WORKLOAD_RELEASE,
      body: JSON.stringify(receipt.recoveryRequired ? {
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId || null
      } : { generation: receipt.generation })
    }
  );
  let data;
  try {
    data = await requestRelease();
  } catch (originalError) {
    try {
      const recovery = await coreRequest(
        `/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}/release-receipt`,
        {
          method: 'POST',
          operationId: CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY,
          body: JSON.stringify({ generation: receipt.generation })
        }
      );
      const recovered = recovery?.data;
      if (recovered?.recovered === true && exactRelease(recovered)) {
        data = recovery;
      } else if (recovered?.recovered === true
        && recovered?.released === false
        && recovered?.retryable === true
        && exactIdentity(recovered)) {
        data = await requestRelease();
      } else {
        throw originalError;
      }
    } catch {
      throw originalError;
    }
  }
  const result = data?.data;
  const exact = exactRelease(result);
  if (!exact) return { released: false, reason: result?.reason || 'Core workload release receipt is invalid' };
  workloadAdmissionById.delete(key);
  return result;
}

function getWorkloadRecoveryIdentity(workloadId) {
  const receipt = workloadAdmissionById.get(String(workloadId || ''));
  if (!receipt?.recoveryRequired) return null;
  return { ...receipt };
}

async function transitionWorkloadRecovery(workloadId, state, options = {}) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt?.recoveryRequired) return { transitioned: false, reason: 'local recovery proof missing' };
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/transition`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_TRANSITION,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId || null,
        expectedVersion: receipt.recoveryVersion,
        state,
        receipt: options.receipt || null
      })
    }
  );
  const result = data?.data;
  const exact = result?.transitioned === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    && (result.recoveryOwnerId || null) === (receipt.recoveryOwnerId || null)
    && result.recoveryState === state
    && result.recoveryVersion === receipt.recoveryVersion + 1;
  if (!exact) {
    const error = new Error(result?.reason || 'Core recovery transition receipt is invalid');
    error.code = 'WORKLOAD_RECOVERY_TRANSITION_REJECTED';
    error.retainAdmission = true;
    throw error;
  }
  receipt.recoveryState = result.recoveryState;
  receipt.recoveryVersion = result.recoveryVersion;
  return result;
}

async function adoptWorkloadRecovery({ workloadId, recoveryId, recoveryRequestId, ownerId }) {
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(recoveryId)}/adopt`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_ADOPT,
      body: JSON.stringify({ recoveryRequestId, ownerId, ttlMs: RECOVERY_OWNER_TTL_MS })
    }
  );
  const result = data?.data;
  if (result?.adopted !== true
    || result.workloadId !== String(workloadId)
    || result.recoveryId !== recoveryId
    || result.recoveryRequestId !== recoveryRequestId
    || result.recoveryOwnerId !== ownerId
    || !result.recoveryGeneration) {
    const error = new Error(result?.reason || 'Core recovery adoption receipt is invalid');
    error.code = 'WORKLOAD_RECOVERY_ADOPTION_REJECTED';
    error.retryable = result?.retryable === true;
    throw error;
  }
  workloadAdmissionById.set(String(workloadId), { ...result });
  return result;
}

async function heartbeatWorkloadRecovery(workloadId, ttlMs = RECOVERY_OWNER_TTL_MS) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt?.recoveryRequired || !receipt.recoveryOwnerId) {
    return { heartbeat: false, reason: 'adopted local recovery proof missing' };
  }
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/heartbeat`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_HEARTBEAT,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId,
        ttlMs
      })
    }
  );
  const result = data?.data;
  const exact = result?.heartbeat === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    && result.recoveryOwnerId === receipt.recoveryOwnerId;
  if (!exact) return { heartbeat: false, reason: result?.reason || 'Core recovery heartbeat receipt is invalid' };
  receipt.recoveryHeartbeatAt = result.recoveryHeartbeatAt || receipt.recoveryHeartbeatAt;
  receipt.recoveryExpiresAt = result.recoveryExpiresAt || receipt.recoveryExpiresAt;
  return result;
}

async function assertWorkloadRecovery(workloadId) {
  const receipt = workloadAdmissionById.get(String(workloadId || ''));
  if (!receipt?.recoveryRequired) return { owned: false, reason: 'local recovery proof missing' };
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/assert`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_ASSERT,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId || null
      })
    }
  );
  const result = data?.data;
  return result?.owned === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    ? result
    : { owned: false, reason: result?.reason || 'Core recovery ownership is invalid' };
}

async function recoverWorkloadAdmissionRelease(identity = {}) {
  const data = await coreRequest(
    `/api/nerve-center/workload-admissions/${encodeURIComponent(identity.admissionId || '')}/release-receipt`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY,
      body: JSON.stringify({ generation: identity.generation })
    }
  );
  const result = data?.data;
  const exact = result?.recovered === true
    && result.released === true
    && result.admissionId === identity.admissionId
    && result.generation === identity.generation
    && result.principal === identity.principal
    && result.workloadId === identity.workloadId
    && result.recoveryId === identity.recoveryId
    && result.recoveryState === 'RESTORED'
    && result.recoveryReceipt?.contract === 'agentx.workload-recovery/v1';
  return exact ? result : {
    recovered: result?.recovered === true,
    released: false,
    retryable: result?.retryable === true,
    reason: result?.reason || 'Core workload recovery receipt is invalid'
  };
}

async function restoreWorkloadRecoveryHosts(workloadId, excludedModelsByHost = {}) {
  const receipt = workloadAdmissionById.get(String(workloadId || ''));
  if (!receipt?.recoveryRequired || !receipt.recoveryOwnerId) {
    return { restored: false, reason: 'adopted local recovery proof missing' };
  }
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/restore-hosts`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_HOST_RESTORE,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId,
        excludedModelsByHost
      })
    }
  );
  const result = data?.data;
  return result?.restored === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    && result.recoveryOwnerId === receipt.recoveryOwnerId
    ? result
    : { restored: false, reason: result?.reason || 'Core recovery host restore receipt is invalid' };
}

function getBenchmarkClaimIdentity(hostUrl, batchId) {
  const claimGeneration = claimProofByOwner.get(claimOwnerKey(hostUrl, batchId))?.claimGeneration;
  const admission = workloadAdmissionById.get(String(batchId || ''));
  if (!claimGeneration || !admission?.admissionId || !admission?.generation) return null;
  return {
    claimBatchId: batchId,
    claimGeneration,
    workloadAdmissionId: admission.admissionId,
    workloadGeneration: admission.generation
  };
}

function getWorkloadAdmissionIdentity(workloadId) {
  const admission = workloadAdmissionById.get(String(workloadId || ''));
  if (!admission?.admissionId || !admission?.generation) return null;
  return {
    workloadAdmissionId: admission.admissionId,
    workloadGeneration: admission.generation
  };
}

async function generateWithWorkloadAdmission(workloadId, request, { signal } = {}) {
  const proof = getWorkloadAdmissionIdentity(workloadId);
  if (!proof) {
    const error = new Error(`Exact workload admission proof is unavailable for ${workloadId || 'unknown'}`);
    error.code = 'WORKLOAD_ADMISSION_REQUIRED';
    throw error;
  }
  const requestedHost = typeof request?.host === 'string' ? request.host.trim() : '';
  const claimProof = requestedHost ? getBenchmarkClaimIdentity(requestedHost, workloadId) : null;
  if (requestedHost && !claimProof) {
    const error = new Error(`Exact benchmark host claim proof is unavailable for ${requestedHost}`);
    error.code = 'BENCHMARK_HOST_CLAIM_REQUIRED';
    throw error;
  }
  const data = await coreRequest('/api/inference/generate', {
    method: 'POST',
    operationId: CORE_OPERATIONS.INFERENCE_GENERATE,
    signal,
    body: JSON.stringify({ ...request, ...proof, ...(claimProof || {}) })
  });
  return data;
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
  getWorkloadAdmissionIdentity,
  generateWithWorkloadAdmission,
  getBenchmarkClaims,
  acquireWorkloadAdmission,
  heartbeatWorkloadAdmission,
  releaseWorkloadAdmission,
  getWorkloadRecoveryIdentity,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  recoverWorkloadAdmissionRelease,
  restoreWorkloadRecoveryHosts,
  CORE_OPERATIONS,
  _internal: {
    classifyCoreOperation,
    configuredCoreOrigin,
    CORE_OPERATION_SPECS,
    normalizeCallerHeaders,
    exactBenchmarkReleaseReceipt,
    runtimeSnapshotIdentity,
  },
};

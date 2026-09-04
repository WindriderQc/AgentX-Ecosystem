'use strict';

const HostProfile = require('../../../models/HostProfile');
const { listModels, listRunning, generate } = require('../../clients/ollamaClient');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const logger = require('../../../config/logger');

const STATUS_TIMEOUT_MS = 4000;
const METADATA_FIELDS = new Set([
  'hostId', 'hostUrl', 'displayName', 'gpu', 'ollama', 'status', 'lastSeenAt', 'cpu', 'modelCount'
]);
const AUTHORITY_FIELDS = new Set(['baseline', 'dedicated', 'reconciliation']);
const AUTHORITY_SERVICES = new Set([
  'profiler-baseline',
  'profiler-release',
  'profiler-recovery'
]);

function hostProfileWriteError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeHostUrlForCompare(hostUrl) {
  return String(hostUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function getConfiguredHost(hostId) {
  return getConfiguredHosts().find(host => String(host.id) === String(hostId)) || null;
}

function maskPendingAuthority(profile) {
  if (!profile) return profile;
  if (new Set(['pending_reconciliation', 'authority_invalidated']).has(profile.baseline?.authorityState)) {
    return { ...profile, baseline: null };
  }
  return profile;
}

function applyConfiguredIdentity(profile, configuredHost) {
  const safeProfile = maskPendingAuthority(profile);
  if (!configuredHost) return safeProfile;

  const previousUrl = normalizeHostUrlForCompare(safeProfile?.hostUrl);
  const configuredUrl = normalizeHostUrlForCompare(configuredHost.url);
  const identityMoved = Boolean(previousUrl && configuredUrl && previousUrl !== configuredUrl);
  const configuredVram = Number(configuredHost.vramMb);

  return {
    ...(safeProfile || {}),
    hostId: configuredHost.id,
    hostUrl: configuredHost.url,
    displayName: configuredHost.name,
    gpu: {
      ...(safeProfile?.gpu || {}),
      ...(Number.isFinite(configuredVram) && configuredVram > 0
        ? { vramTotalMiB: configuredVram }
        : {})
    },
    status: safeProfile?.status || 'unknown',
    // Measurements belong to the physical endpoint, not to a reusable host
    // slot. Do not display a baseline captured before that slot moved.
    ...(identityMoved ? { baseline: null } : {})
  };
}

function hostIdentityChanged(existing, next) {
  if (!existing || !next) return false;

  if (next.hostUrl) {
    const previousUrl = normalizeHostUrlForCompare(existing.hostUrl);
    const nextUrl = normalizeHostUrlForCompare(next.hostUrl);
    if (previousUrl && nextUrl && previousUrl !== nextUrl) return true;
  }

  const previousVram = Number(existing.gpu?.vramTotalMiB);
  const nextVram = Number(next.gpu?.vramTotalMiB);
  return Number.isFinite(previousVram)
    && Number.isFinite(nextVram)
    && previousVram > 0
    && nextVram > 0
    && previousVram !== nextVram;
}

async function getAll() {
  const profiles = await HostProfile.find().lean();
  const configuredHosts = getConfiguredHosts();
  if (!configuredHosts.length) return profiles;

  const profilesById = new Map(profiles.map(profile => [String(profile.hostId), profile]));
  const configuredIds = new Set(configuredHosts.map(host => String(host.id)));

  return [
    ...configuredHosts.map(host => applyConfiguredIdentity(profilesById.get(String(host.id)), host)),
    ...profiles.filter(profile => !configuredIds.has(String(profile.hostId)))
  ];
}

async function getById(hostId) {
  const profile = await HostProfile.findOne({ hostId }).lean();
  return applyConfiguredIdentity(profile, getConfiguredHost(hostId));
}

async function getByUrl(hostUrl) {
  if (!hostUrl) return null;
  const normalized = String(hostUrl).trim().replace(/\/+$/, '');
  const configuredHost = getConfiguredHosts().find(
    host => normalizeHostUrlForCompare(host.url) === normalizeHostUrlForCompare(normalized)
  );
  if (configuredHost) return getById(configuredHost.id);
  return maskPendingAuthority(await HostProfile.findOne({ hostUrl: normalized }).lean());
}

/**
 * Flatten nested plain objects into Mongo dot paths so partial subdocument
 * input merges instead of replacing. Passing `{ cpu: { cores: 16 } }` as a
 * top-level $set used to clobber the whole `cpu` subdocument, silently wiping
 * sibling fields like `cpu.threadOverride`. Arrays and Dates are set as-is.
 */
function flattenToDotPaths(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      flattenToDotPaths(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

async function writeProfile(data, options = {}) {
  options.assertAuthorityActive?.();
  const input = { ...data };
  const configuredHost = getConfiguredHost(input.hostId);
  if (configuredHost) {
    input.hostUrl = configuredHost.url;
    input.displayName = configuredHost.name;
    const configuredVram = Number(configuredHost.vramMb);
    if (Number.isFinite(configuredVram) && configuredVram > 0) {
      input.gpu = { ...(input.gpu || {}), vramTotalMiB: configuredVram };
    }
  }
  if (input.hostUrl) {
    input.hostUrl = await admitOllamaTargetResolved(input.hostUrl, { configuredHosts: getConfiguredHosts() });
  }
  const hasDedicatedInput = Object.prototype.hasOwnProperty.call(input, 'dedicated');
  const dedicated = input.dedicated;
  delete input.dedicated;

  const update = flattenToDotPaths(input);
  // `dedicated` used to be stored as a literal null. Writing dot paths such
  // as dedicated.detectedAt into those legacy rows makes MongoDB reject the
  // whole findAndModify. Replace the complete value atomically instead.
  if (hasDedicatedInput && dedicated != null) update.dedicated = dedicated;
  const operation = { $set: update };
  if (hasDedicatedInput && dedicated == null) operation.$unset = { dedicated: '' };

  const updated = await HostProfile.findOneAndUpdate(
    { hostId: input.hostId, ...(options.filter || {}) },
    operation,
    {
      upsert: options.upsert !== false,
      new: true,
      runValidators: true,
      ...(options.signal ? { signal: options.signal } : {})
    }
  );
  options.assertAuthorityActive?.();
  return updated;
}

async function getByIdForAuthority(hostId) {
  return HostProfile.findOne({ hostId })
    .select([
      '+baseline.persistenceReceipt',
      '+baseline.authorityAdmissionId',
      '+baseline.authorityPrincipal',
      '+baseline.authorityWriteId',
      '+baseline.authorityReconciliationId'
    ].join(' '))
    .lean();
}

function assertAllowedFields(data, allowed, code) {
  const rejected = Object.keys(data || {}).filter(field => !allowed.has(field));
  if (rejected.length) {
    throw hostProfileWriteError(
      `Host profile fields are not writable through this service: ${rejected.join(', ')}`,
      code,
      400
    );
  }
}

function immutableAuthorityProof(data, options) {
  if (!AUTHORITY_SERVICES.has(options.authorityService)) {
    throw hostProfileWriteError(
      'Host profile authority writes require an allowlisted internal service',
      'HOST_PROFILE_AUTHORITY_SERVICE_REQUIRED',
      403
    );
  }
  if (!(options.signal instanceof AbortSignal) || typeof options.assertAuthorityActive !== 'function') {
    throw hostProfileWriteError(
      'Host profile authority writes require a live fenced signal and assertion',
      'HOST_PROFILE_AUTHORITY_FENCE_REQUIRED'
    );
  }
  const reconciliation = data?.reconciliation || {};
  const supplied = options.authorityProof || {};
  const proof = Object.freeze({
    admissionId: String(supplied.admissionId || reconciliation.admissionId || '').trim(),
    generation: String(supplied.generation || reconciliation.admissionGeneration || '').trim(),
    principal: String(supplied.principal || reconciliation.admissionPrincipal || '').trim()
  });
  if (!proof.admissionId || !proof.generation || !proof.principal) {
    throw hostProfileWriteError(
      'Host profile authority proof is incomplete',
      'HOST_PROFILE_AUTHORITY_PROOF_REQUIRED'
    );
  }
  if (data?.reconciliation && (
    String(reconciliation.admissionId || '') !== proof.admissionId
    || String(reconciliation.admissionGeneration || '') !== proof.generation
    || String(reconciliation.admissionPrincipal || '') !== proof.principal
  )) {
    throw hostProfileWriteError(
      'Host profile reconciliation proof does not match the fenced authority',
      'HOST_PROFILE_AUTHORITY_PROOF_MISMATCH'
    );
  }
  return proof;
}

function reconciliationCas(reconciliation, proof) {
  const exact = {
    'reconciliation.admissionId': proof.admissionId,
    'reconciliation.admissionGeneration': proof.generation,
    'reconciliation.admissionPrincipal': proof.principal
  };
  if (reconciliation?.state !== 'prepared') return exact;
  return {
    $or: [
      exact,
      { 'reconciliation.state': 'resolved' },
      { 'reconciliation.state': { $exists: false } }
    ]
  };
}

async function upsertMetadata(data) {
  assertAllowedFields(data, METADATA_FIELDS, 'HOST_PROFILE_METADATA_FIELD_FORBIDDEN');
  return writeProfile(data);
}

async function upsertAuthority(data, options = {}) {
  assertAllowedFields(data, new Set([...METADATA_FIELDS, ...AUTHORITY_FIELDS]), 'HOST_PROFILE_AUTHORITY_FIELD_FORBIDDEN');
  const proof = immutableAuthorityProof(data, options);
  const authorityFilter = options.authorityFilter || (data?.reconciliation
    ? reconciliationCas(data.reconciliation, proof)
    : null);
  if (!authorityFilter || typeof authorityFilter !== 'object' || Array.isArray(authorityFilter)) {
    throw hostProfileWriteError(
      'Host profile authority writes require an exact generation CAS',
      'HOST_PROFILE_AUTHORITY_CAS_REQUIRED'
    );
  }
  try {
    const updated = await writeProfile(data, {
      ...options,
      filter: { ...authorityFilter, ...(options.filter || {}) },
      upsert: data?.reconciliation?.state === 'prepared'
        || (Boolean(data?.baseline) && options.expectedAuthorityGeneration == null)
    });
    if (!updated) {
      throw hostProfileWriteError(
        'Host profile authority generation changed before the write committed',
        'HOST_PROFILE_AUTHORITY_CAS_FAILED'
      );
    }
    return updated;
  } catch (error) {
    if (error?.code === 11000) {
      throw hostProfileWriteError(
        'Host profile authority generation changed before the write committed',
        'HOST_PROFILE_AUTHORITY_CAS_FAILED'
      );
    }
    throw error;
  }
}

/**
 * Detect if a host has dedicated (pinned) models loaded.
 * A model is considered pinned if its expires_at is more than 1 year in the future.
 * @param {Object|null} psData - Raw JSON from Ollama /api/ps
 * @returns {{ model: string, models: string[], expiresAt: Date, vramUsedMiB: number, detectedAt: Date } | null}
 */
function detectDedicated(psData) {
  if (!psData?.models?.length) return null;
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const pinnedModels = psData.models.filter(m => {
    const exp = new Date(m.expires_at);
    return exp.getTime() - now > ONE_YEAR_MS;
  });
  if (!pinnedModels.length) return null;
  const primary = pinnedModels[0];
  const totalVram = pinnedModels.reduce((sum, m) => sum + (m.size_vram || 0), 0);
  return {
    model: primary.name,
    models: pinnedModels.map(m => m.name),
    expiresAt: new Date(primary.expires_at),
    vramUsedMiB: Math.round(totalVram / (1024 * 1024)),
    detectedAt: new Date(),
  };
}

async function checkStatus(hostUrl) {
  try {
    const data = await listModels(hostUrl, { timeoutMs: STATUS_TIMEOUT_MS });
    const raw = data.models || [];
    const models = raw.map(m => m.name);
    const modelDetails = raw.map(m => ({
      name: m.name?.replace(/:latest$/, ''),
      parameterSize: m.details?.parameter_size || '',
      quantization: m.details?.quantization_level || '',
      size: m.size || 0,
    }));

    // Query /api/ps for dedicated model detection (non-fatal)
    let dedicated = null;
    try {
      const psData = await listRunning(hostUrl, { timeoutMs: STATUS_TIMEOUT_MS });
      dedicated = detectDedicated(psData);
    } catch {
      // /api/ps failure is non-fatal — dedicated stays null
    }

    return { status: 'online', models, modelDetails, dedicated };
  } catch (err) {
    return { status: 'offline', models: [], error: err.message, dedicated: null };
  }
}

async function detectHardware(hostUrl) {
  try {
    return await listRunning(hostUrl, { timeoutMs: STATUS_TIMEOUT_MS });
  } catch {
    return null;
  }
}

async function updateStatusMetadata(hostId, status) {
  const update = { status, lastSeenAt: status === 'online' ? new Date() : undefined };
  return HostProfile.findOneAndUpdate({ hostId }, update, { new: true });
}

async function updateBaseline(hostId, baseline, options = {}) {
  const persistenceReceipt = String(baseline.persistenceReceipt || '').trim() || null;
  const proof = immutableAuthorityProof(null, options);
  const expectedGeneration = options.expectedAuthorityGeneration == null
    ? null
    : String(options.expectedAuthorityGeneration);
  return upsertAuthority({
    hostId,
    baseline: {
      referenceModel: baseline.referenceModel || null,
      tokensPerSec: baseline.tokensPerSec ?? null,
      latencyMs: baseline.latencyMs ?? null,
      ttftMs: baseline.ttftMs ?? null,
      ttftMeasurement: baseline.ttftMeasurement || undefined,
      testedAt: baseline.testedAt || new Date(),
      persistenceReceipt,
      authorityAdmissionId: proof.admissionId,
      authorityGeneration: proof.generation,
      authorityPrincipal: proof.principal
    }
  }, {
    ...options,
    authorityProof: proof,
    authorityFilter: expectedGeneration
      ? { 'baseline.authorityGeneration': expectedGeneration }
      : { 'baseline.authorityGeneration': { $exists: false } },
    ...(persistenceReceipt
      ? { filter: { rejectedBaselineReceipts: { $ne: persistenceReceipt } } }
      : {})
  });
}

async function invalidateBaselineReceipt(hostId, persistenceReceipt, priorBaseline = null) {
  const receipt = String(persistenceReceipt || '').trim();
  if (!receipt) throw new Error('baseline persistence receipt is required');
  const fenced = await HostProfile.updateOne(
    { hostId },
    { $addToSet: { rejectedBaselineReceipts: receipt } }
  );
  if (Number(fenced?.matchedCount) !== 1) {
    throw new Error(`Host profile ${hostId} was not found while fencing a baseline receipt`);
  }
  const replacement = priorBaseline
    ? { $set: { baseline: priorBaseline } }
    : { $unset: { baseline: '' } };
  await HostProfile.updateOne(
    { hostId, 'baseline.persistenceReceipt': receipt },
    replacement
  );
  return { invalidated: true, persistenceReceipt: receipt };
}

async function detectCpuCores(hostUrl) {
  try {
    const os = require('os');
    const url = new URL(hostUrl);
    const localHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::'];
    if (localHosts.includes(url.hostname)) {
      return os.cpus().length;
    }
  } catch (err) { /* ignore */ }
  return null;
}

/**
 * Release a pinned model from a host by sending keep_alive: 0.
 * @param {string} hostUrl
 * @param {string} modelName
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function releaseModel(hostUrl, modelName, options = {}) {
  try {
    await generate(hostUrl, { model: modelName, prompt: '', keep_alive: '0', stream: false }, {
      // A client timeout is not a server-terminal unload receipt. Hold the
      // fenced request until Ollama acknowledges completion.
      timeoutMs: 0,
      signal: options.signal
    });
    options.assertClaimActive?.();
    return { success: true, serverTerminalObserved: true, serverTerminalAt: new Date() };
  } catch (err) {
    const error = options.signal?.aborted && options.signal.reason instanceof Error
      ? options.signal.reason
      : err;
    error.code = error.code || 'PROFILER_RELEASE_RECONCILIATION_PENDING';
    error.statusCode = error.statusCode || 503;
    error.retainAdmission = true;
    error.serverTerminalObserved = false;
    throw error;
  }
}

/**
 * Check if a host is dedicated to a different model than the one requested.
 * @param {object} host — HostProfile document (or lean object)
 * @param {string} modelName — model being requested
 * @returns {boolean} true if host is dedicated to a DIFFERENT model
 */
function isDedicatedConflict(host, modelName) {
  const models = host?.dedicated?.models || (host?.dedicated?.model ? [host.dedicated.model] : []);
  if (!models.length) return false;
  return !models.includes(modelName);
}

module.exports = {
  getAll,
  getById,
  getByIdForAuthority,
  getByUrl,
  upsertMetadata,
  upsertAuthority,
  checkStatus,
  updateStatusMetadata,
  updateBaseline,
  invalidateBaselineReceipt,
  detectCpuCores,
  releaseModel,
  detectDedicated,
  isDedicatedConflict,
  hostIdentityChanged,
  _internal: {
    AUTHORITY_SERVICES,
    METADATA_FIELDS,
    immutableAuthorityProof,
    reconciliationCas
  }
};

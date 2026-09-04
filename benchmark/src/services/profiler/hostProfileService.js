'use strict';

const HostProfile = require('../../../models/HostProfile');
const { listModels, listRunning, generate } = require('../../clients/ollamaClient');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const logger = require('../../../config/logger');

const STATUS_TIMEOUT_MS = 4000;

function normalizeHostUrlForCompare(hostUrl) {
  return String(hostUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function getConfiguredHost(hostId) {
  return getConfiguredHosts().find(host => String(host.id) === String(hostId)) || null;
}

function applyConfiguredIdentity(profile, configuredHost) {
  if (!configuredHost) return profile;

  const previousUrl = normalizeHostUrlForCompare(profile?.hostUrl);
  const configuredUrl = normalizeHostUrlForCompare(configuredHost.url);
  const identityMoved = Boolean(previousUrl && configuredUrl && previousUrl !== configuredUrl);
  const configuredVram = Number(configuredHost.vramMb);

  return {
    ...(profile || {}),
    hostId: configuredHost.id,
    hostUrl: configuredHost.url,
    displayName: configuredHost.name,
    gpu: {
      ...(profile?.gpu || {}),
      ...(Number.isFinite(configuredVram) && configuredVram > 0
        ? { vramTotalMiB: configuredVram }
        : {})
    },
    status: profile?.status || 'unknown',
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
  return HostProfile.findOne({ hostUrl: normalized }).lean();
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

async function upsert(data, options = {}) {
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
  const hasHostIdentityInput = Boolean(data?.hostUrl || data?.gpu?.vramTotalMiB);

  if (input?.hostId && hasHostIdentityInput) {
    const existing = await HostProfile.findOne({ hostId: input.hostId }).lean();
    if (hostIdentityChanged(existing, input) && !Object.prototype.hasOwnProperty.call(input, 'baseline')) {
      update.baseline = null;
    }
  }

  const operation = { $set: update };
  if (hasDedicatedInput && dedicated == null) operation.$unset = { dedicated: '' };

  const updated = await HostProfile.findOneAndUpdate(
    { hostId: input.hostId },
    operation,
    { upsert: true, new: true, runValidators: true, ...(options.signal ? { signal: options.signal } : {}) }
  );
  options.assertAuthorityActive?.();
  return updated;
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

async function updateStatus(hostId, status) {
  const update = { status, lastSeenAt: status === 'online' ? new Date() : undefined };
  return HostProfile.findOneAndUpdate({ hostId }, update, { new: true });
}

async function updateBaseline(hostId, baseline, options = {}) {
  return upsert({
    hostId,
    baseline: {
      referenceModel: baseline.referenceModel || null,
      tokensPerSec: baseline.tokensPerSec ?? null,
      latencyMs: baseline.latencyMs ?? null,
      ttftMs: baseline.ttftMs ?? null,
      testedAt: baseline.testedAt || new Date()
    }
  }, options);
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
      timeoutMs: 15000,
      signal: options.signal
    });
    options.assertClaimActive?.();
    return { success: true };
  } catch (err) {
    if (options.signal?.aborted) throw (options.signal.reason instanceof Error ? options.signal.reason : err);
    return { success: false, error: err.message };
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

module.exports = { getAll, getById, getByUrl, upsert, checkStatus, updateStatus, updateBaseline, detectCpuCores, releaseModel, detectDedicated, isDedicatedConflict, hostIdentityChanged };

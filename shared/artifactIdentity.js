'use strict';

const crypto = require('crypto');
const { normalizeModelTag } = require('./modelNames');

const RUNTIME_ARTIFACT_IDENTITY_CONTRACT = 'agentx.runtime-artifact-identity/v1';
const DEFAULT_RUNTIME_ARTIFACT_FRESHNESS_MS = 30_000;
const RUNTIME_ARTIFACT_PROVENANCE = Object.freeze({
  authority: 'agentx-product-benchmark',
  mode: 'live_server_observation',
  tag: 'ollama:/api/tags',
  digest: 'ollama:/api/tags',
  artifactSize: 'ollama:/api/tags',
  residency: 'ollama:/api/ps',
  sizeVram: 'ollama:/api/ps',
  contextLength: 'ollama:/api/ps',
  runtimeVersion: 'ollama:/api/version'
});

function normalizeHostUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function runtimeIdentity(hostProfile = {}, fallbackHostUrl = null) {
  return {
    hostId: hostProfile.hostId || null,
    hostUrl: normalizeHostUrl(hostProfile.hostUrl || fallbackHostUrl),
    gpu: {
      model: hostProfile.gpu?.model || null,
      vramTotalMiB: Number(hostProfile.gpu?.vramTotalMiB) || null,
      computeCapability: hostProfile.gpu?.computeCapability || null,
      driver: hostProfile.gpu?.driver || null
    },
    ollama: {
      version: hostProfile.ollama?.version || null,
      backend: hostProfile.ollama?.backend || null,
      cudaVersion: hostProfile.ollama?.cudaVersion || null
    },
    cpu: {
      cores: Number(hostProfile.cpu?.cores) || null,
      threadOverride: Number(hostProfile.cpu?.threadOverride) || null
    }
  };
}

function buildRuntimeFingerprint(hostProfile = {}, fallbackHostUrl = null) {
  return crypto.createHash('sha256')
    .update(stableSerialize(runtimeIdentity(hostProfile, fallbackHostUrl)))
    .digest('hex');
}

function requiredString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || (allowZero ? normalized < 0 : normalized <= 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  }
  return normalized;
}

function isoTimestamp(value, label) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return timestamp.toISOString();
}

function canonicalSha256Digest(value) {
  const raw = requiredString(value, 'digest').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(raw)) return `sha256:${raw}`;
  if (/^sha256:[a-f0-9]{64}$/.test(raw)) return raw;
  throw new Error('digest must be an exact sha256 Ollama artifact digest');
}

function canonicalRuntimeArtifactIdentity(input = {}) {
  const tag = requiredString(input.tag, 'tag');
  const model = normalizeModelTag(tag);
  const digest = canonicalSha256Digest(input.digest);
  const residentSize = positiveInteger(input.residentSize, 'residentSize');
  const sizeVram = positiveInteger(input.sizeVram, 'sizeVram', { allowZero: true });
  return {
    contract: RUNTIME_ARTIFACT_IDENTITY_CONTRACT,
    model,
    tag,
    hostId: requiredString(input.hostId, 'hostId'),
    hostUrl: normalizeHostUrl(requiredString(input.hostUrl, 'hostUrl')),
    digest,
    artifactSize: positiveInteger(input.artifactSize, 'artifactSize'),
    residentSize,
    sizeVram,
    fullVram: sizeVram === residentSize,
    contextLength: positiveInteger(input.contextLength, 'contextLength'),
    runtimeVersion: requiredString(input.runtimeVersion, 'runtimeVersion')
  };
}

function buildArtifactRuntimeFingerprint(input = {}) {
  return crypto.createHash('sha256')
    .update(stableSerialize(canonicalRuntimeArtifactIdentity(input)))
    .digest('hex');
}

function buildRuntimeArtifactReceipt(input = {}, options = {}) {
  const identity = canonicalRuntimeArtifactIdentity(input);
  const observedAt = isoTimestamp(options.observedAt || new Date(), 'observedAt');
  const freshnessMs = positiveInteger(
    options.freshnessMs ?? DEFAULT_RUNTIME_ARTIFACT_FRESHNESS_MS,
    'freshnessMs'
  );
  const runtimeFingerprint = buildArtifactRuntimeFingerprint(identity);
  const body = {
    ...identity,
    runtimeFingerprint,
    freshness: {
      state: 'fresh',
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + freshnessMs).toISOString(),
      maxAgeMs: freshnessMs
    },
    provenance: { ...RUNTIME_ARTIFACT_PROVENANCE }
  };
  return {
    ...body,
    receiptId: crypto.createHash('sha256').update(stableSerialize(body)).digest('hex')
  };
}

function verifyRuntimeArtifactReceipt(value, options = {}) {
  const reasons = [];
  let rebuilt;
  try {
    rebuilt = buildRuntimeArtifactReceipt(value, {
      observedAt: value?.freshness?.observedAt,
      freshnessMs: value?.freshness?.maxAgeMs
    });
  } catch (error) {
    return { valid: false, fresh: false, reasons: [error.message] };
  }
  // A receipt is a closed canonical object, not a bag of partially checked
  // claims. This catches changes to derived fields (contract/model/fullVram),
  // unknown extra keys, and any other body drift even when the attacker keeps
  // the original fingerprint and receiptId.
  if (stableSerialize(value) !== stableSerialize(rebuilt)) reasons.push('receipt_body_mismatch');
  if (value?.runtimeFingerprint !== rebuilt.runtimeFingerprint) reasons.push('runtime_fingerprint_mismatch');
  if (value?.receiptId !== rebuilt.receiptId) reasons.push('receipt_id_mismatch');
  if (stableSerialize(value?.provenance) !== stableSerialize(RUNTIME_ARTIFACT_PROVENANCE)) {
    reasons.push('provenance_mismatch');
  }
  if (value?.freshness?.state !== 'fresh' || value?.freshness?.expiresAt !== rebuilt.freshness.expiresAt) {
    reasons.push('freshness_contract_mismatch');
  }
  const nowMs = options.now == null ? Date.now() : Date.parse(options.now);
  const skewMs = Number(options.clockSkewMs) >= 0 ? Number(options.clockSkewMs) : 2_000;
  const observedAtMs = Date.parse(rebuilt.freshness.observedAt);
  const expiresAtMs = Date.parse(rebuilt.freshness.expiresAt);
  if (!Number.isFinite(nowMs) || observedAtMs > nowMs + skewMs) reasons.push('observation_from_future');
  if (!Number.isFinite(nowMs) || expiresAtMs < nowMs - skewMs) reasons.push('receipt_stale');
  return {
    valid: reasons.length === 0,
    fresh: !reasons.includes('observation_from_future') && !reasons.includes('receipt_stale'),
    reasons,
    identity: rebuilt
  };
}

function exactModelNamesMatch(left, right) {
  const a = normalizeModelTag(left).toLowerCase();
  const b = normalizeModelTag(right).toLowerCase();
  return Boolean(a && b && a === b);
}

module.exports = {
  DEFAULT_RUNTIME_ARTIFACT_FRESHNESS_MS,
  RUNTIME_ARTIFACT_IDENTITY_CONTRACT,
  RUNTIME_ARTIFACT_PROVENANCE,
  buildArtifactRuntimeFingerprint,
  buildRuntimeArtifactReceipt,
  buildRuntimeFingerprint,
  canonicalSha256Digest,
  canonicalRuntimeArtifactIdentity,
  exactModelNamesMatch,
  normalizeHostUrl,
  runtimeIdentity,
  stableSerialize,
  verifyRuntimeArtifactReceipt
};

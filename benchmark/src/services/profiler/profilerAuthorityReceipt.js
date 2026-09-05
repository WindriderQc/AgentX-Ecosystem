'use strict';

const crypto = require('crypto');

const RECEIPT_VERSION = 3;

function canonicalValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => canonicalValue(item));
  if (typeof value?.toObject === 'function') {
    return canonicalValue(value.toObject({ depopulate: true, getters: false, virtuals: false }));
  }
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId') return String(value);
    return Object.keys(value).sort().reduce((result, key) => {
      const normalized = canonicalValue(value[key]);
      if (normalized !== undefined) result[key] = normalized;
      return result;
    }, {});
  }
  return String(value);
}

function canonicalArtifact(artifact = {}) {
  return canonicalValue({
    model: artifact.model || null,
    hostId: artifact.hostId || null,
    hostUrl: artifact.hostUrl || null,
    digest: artifact.digest || null,
    runtimeFingerprint: artifact.runtimeFingerprint || null,
    registryId: artifact.registryId || null,
    registryDigest: artifact.registryDigest || null,
    registryQualified: artifact.registryQualified === true
  });
}

function canonicalAuthorityPayload({ modelName, hostId, artifact, profile, evidenceId, issuedAt }) {
  return canonicalValue({
    contract: 'agentx.profiler-authority/v3',
    issuedAt,
    evidenceId: evidenceId ? String(evidenceId) : null,
    modelName: modelName || null,
    hostId: hostId || null,
    artifact: canonicalArtifact(artifact),
    // Bind the complete immutable evidence payload. Qualification, failures,
    // context recommendations/maxima, distribution statistics, GPU/spill,
    // curves, stability, matrix, load timing, thinking and future decision
    // fields therefore cannot be changed under a still-valid receipt.
    profile: canonicalValue(profile || {})
  });
}

function receiptDigest(input) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalAuthorityPayload(input)))
    .digest('hex');
}

function createProfilerAuthorityReceipt({ modelName, hostId, artifact, profile, evidenceId, issuedAt = new Date() }) {
  const receiptTime = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  if (!Number.isFinite(receiptTime.getTime())) throw new Error('Profiler authority receipt issuedAt must be a valid timestamp');
  const canonicalIssuedAt = receiptTime.toISOString();
  return {
    version: RECEIPT_VERSION,
    source: 'profiler_pipeline',
    evidenceId: evidenceId ? String(evidenceId) : null,
    digest: receiptDigest({ modelName, hostId, artifact, profile, evidenceId, issuedAt: canonicalIssuedAt }),
    issuedAt: canonicalIssuedAt
  };
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === 64 && b.length === 64 && crypto.timingSafeEqual(a, b);
}

function verifyProfilerAuthorityReceipt(readiness, evidence, { modelName, hostId } = {}) {
  const receipt = readiness?.authorityReceipt;
  if (new Set(['pending_reconciliation', 'authority_invalidated']).has(readiness?.authorityState)
    || new Set(['pending_reconciliation', 'authority_invalidated']).has(evidence?.authorityState)
    || receipt?.source !== 'profiler_pipeline'
    || Number(receipt.version) !== RECEIPT_VERSION
    || !/^[a-f0-9]{64}$/i.test(String(receipt.digest || ''))
    || String(receipt.evidenceId || '') !== String(readiness?.evidenceId || '')
    || !evidence
    || String(readiness?.evidenceId || '') !== String(evidence?._id || '')) {
    return false;
  }
  const expected = receiptDigest({
    modelName: modelName || evidence.modelName,
    hostId: hostId || evidence.hostId,
    artifact: evidence.artifact,
    profile: evidence.profile,
    evidenceId: evidence._id,
    issuedAt: receipt.issuedAt
  });
  return safeDigestEqual(receipt.digest, expected);
}

function hasQualifiedProfilerAuthority(readiness, evidence, context = {}) {
  const evidenceDepth = evidence?.profile?.profileDepth;
  return Boolean(
    readiness?.benchmarkQualified === true
    && !new Set(['pending_reconciliation', 'authority_invalidated']).has(readiness?.authorityState)
    && !new Set(['pending_reconciliation', 'authority_invalidated']).has(evidence?.authorityState)
    && evidence?.profile?.benchmarkQualified === true
    && readiness?.benchmarkQualified === evidence.profile.benchmarkQualified
    && readiness?.stale !== true
    && ['standard', 'full'].includes(readiness?.profileDepth)
    && readiness.profileDepth === evidenceDepth
    && verifyProfilerAuthorityReceipt(readiness, evidence, context)
  );
}

module.exports = {
  RECEIPT_VERSION,
  canonicalValue,
  canonicalArtifact,
  canonicalAuthorityPayload,
  receiptDigest,
  createProfilerAuthorityReceipt,
  verifyProfilerAuthorityReceipt,
  hasQualifiedProfilerAuthority
};

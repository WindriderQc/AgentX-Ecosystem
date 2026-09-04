'use strict';

const crypto = require('crypto');

function canonicalArtifact(artifact = {}) {
  return {
    model: artifact.model || null,
    hostId: artifact.hostId || null,
    hostUrl: artifact.hostUrl || null,
    digest: artifact.digest || null,
    runtimeFingerprint: artifact.runtimeFingerprint || null,
    registryId: artifact.registryId || null,
    registryDigest: artifact.registryDigest || null,
    registryQualified: artifact.registryQualified === true
  };
}

function receiptDigest({ modelName, hostId, artifact, profileDepth, required, passing }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    modelName,
    hostId,
    artifact: canonicalArtifact(artifact),
    profileDepth,
    required: Number(required) || 0,
    passing: Number(passing) || 0
  })).digest('hex');
}

function createProfilerAuthorityReceipt({ modelName, hostId, artifact, profile, evidenceId, issuedAt = new Date() }) {
  const required = Number(profile?.requiredRetainedSamples) || 0;
  const passing = Number(profile?.measurementQuality?.passingSampleCount) || 0;
  return {
    version: 1,
    source: 'profiler_pipeline',
    evidenceId: evidenceId ? String(evidenceId) : null,
    digest: receiptDigest({
      modelName,
      hostId,
      artifact,
      profileDepth: profile?.profileDepth || null,
      required,
      passing
    }),
    issuedAt
  };
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === 64 && b.length === 64 && crypto.timingSafeEqual(a, b);
}

function verifyProfilerAuthorityReceipt(readiness, evidence, { modelName, hostId } = {}) {
  const receipt = readiness?.authorityReceipt;
  if (receipt?.source !== 'profiler_pipeline'
    || Number(receipt.version) !== 1
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
    profileDepth: evidence.profile?.profileDepth,
    required: evidence.profile?.requiredRetainedSamples,
    passing: evidence.profile?.measurementQuality?.passingSampleCount
  });
  return safeDigestEqual(receipt.digest, expected);
}

module.exports = {
  canonicalArtifact,
  receiptDigest,
  createProfilerAuthorityReceipt,
  verifyProfilerAuthorityReceipt
};

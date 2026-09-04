'use strict';

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const {
  verifyProfilerAuthorityReceipt,
  RECEIPT_VERSION
} = require('./profilerAuthorityReceipt');
const { identitiesMatch, resolveArtifactIdentity } = require('./artifactIdentityService');

function mapToObject(value) {
  return value instanceof Map ? Object.fromEntries(value) : (value || {});
}

function authorityFailureReason({ receiptVerified, liveIdentityVerified, evidenceQualified }) {
  if (!receiptVerified) return 'authority_receipt_invalid';
  if (!liveIdentityVerified) return 'live_artifact_identity_unverified';
  if (!evidenceQualified) return 'qualification_projection_mismatch';
  return null;
}

async function projectReadinessEntry(modelName, hostId, rawReadiness, evidenceById, deps = {}) {
  const readiness = rawReadiness?.toObject
    ? rawReadiness.toObject({ getters: false, virtuals: false })
    : { ...(rawReadiness || {}) };
  const evidence = readiness.evidenceId
    ? evidenceById.get(String(readiness.evidenceId)) || null
    : null;
  const verifyReceipt = deps.verifyReceipt || verifyProfilerAuthorityReceipt;
  const resolveIdentity = deps.resolveIdentity || resolveArtifactIdentity;
  const matchIdentities = deps.matchIdentities || identitiesMatch;
  const now = deps.now || (() => new Date());
  const receiptVerified = verifyReceipt(readiness, evidence, { modelName, hostId });
  let liveArtifact = null;
  let liveIdentityVerified = false;
  if (receiptVerified && readiness.artifact?.hostUrl) {
    try {
      liveArtifact = await resolveIdentity(modelName, hostId, readiness.artifact.hostUrl, { refresh: true });
      liveIdentityVerified = matchIdentities(readiness.artifact, liveArtifact)
        && matchIdentities(evidence?.artifact, liveArtifact);
    } catch (_) {
      liveIdentityVerified = false;
    }
  }
  const evidenceQualified = evidence?.profile?.benchmarkQualified === readiness.benchmarkQualified;
  const authorityVerified = receiptVerified && liveIdentityVerified && evidenceQualified;
  const failureReason = authorityFailureReason({ receiptVerified, liveIdentityVerified, evidenceQualified });

  return {
    ...readiness,
    benchmarkQualified: authorityVerified && readiness.benchmarkQualified === true,
    stale: readiness.stale === true || !authorityVerified,
    staleReason: readiness.staleReason || failureReason,
    authorityVerified,
    authority: {
      contract: 'agentx.profiler-readiness/v2',
      receiptVersion: RECEIPT_VERSION,
      receiptVerified,
      liveIdentityVerified,
      evidenceQualified,
      verified: authorityVerified,
      reason: failureReason,
      liveArtifactDigest: liveArtifact?.digest || null,
      checkedAt: now().toISOString()
    }
  };
}

async function projectReadinessProfiles(profiles, deps = {}) {
  const evidenceIds = (profiles || []).flatMap((profile) =>
    Object.values(mapToObject(profile?.readiness))
      .map((entry) => entry?.evidenceId)
      .filter(Boolean)
      .map(String)
  );
  const evidenceModel = deps.evidenceModel || ModelPerformanceProfile;
  const evidenceRows = evidenceIds.length
    ? await evidenceModel.find({ _id: { $in: evidenceIds } }).lean()
    : [];
  const evidenceById = new Map(evidenceRows.map((row) => [String(row._id), row]));
  return Promise.all((profiles || []).map(async (profile) => ({
    ...profile,
    readiness: Object.fromEntries(await Promise.all(
      Object.entries(mapToObject(profile?.readiness)).map(async ([hostId, entry]) => [
        hostId,
        await projectReadinessEntry(profile.name, hostId, entry, evidenceById, deps)
      ])
    ))
  })));
}

module.exports = {
  mapToObject,
  projectReadinessEntry,
  projectReadinessProfiles
};

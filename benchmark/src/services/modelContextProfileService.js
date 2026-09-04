const ModelContextProfile = require('../../models/ModelContextProfile');
const { getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');

// v3 is deliberately distinct from the first additive migration draft. That
// draft could stamp legacy 262K maxima as if they were degradation-derived
// recommendations. Only a fresh probe written by this implementation may
// carry current recommendation authority.
const RECOMMENDATION_EVIDENCE_VERSION = 'context-probe-degradation-v3';

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function isValidTokensPerSec(tokensPerSec) {
  if (tokensPerSec === null || tokensPerSec === undefined) return true;
  const value = Number(tokensPerSec);
  return Number.isFinite(value) && value > 0;
}

function hasValidThroughputEvidence(snapshot) {
  const summaryValues = [
    snapshot?.baselineTokensPerSec,
    snapshot?.atLimitTokensPerSec
  ];
  if (!summaryValues.every(isValidTokensPerSec)) return false;

  return (Array.isArray(snapshot?.steps) ? snapshot.steps : []).every((step) => {
    if (step?.tokensPerSec === null || step?.tokensPerSec === undefined) return true;
    const value = Number(step.tokensPerSec);
    if (!Number.isFinite(value) || value < 0) return false;
    return step.passed ? value > 0 : true;
  });
}

function modelNameCandidates(modelName) {
  const normalized = String(modelName || '').trim().replace(/:latest$/i, '');
  return normalized ? [normalized] : [];
}

function bestStepForSnapshot(snapshot) {
  const tested = positiveInteger(snapshot?.testedNumCtx);
  const steps = Array.isArray(snapshot?.steps) ? snapshot.steps : [];
  return steps.find((step) => positiveInteger(step.numCtx) === tested && step.passed)
    || steps.find((step) => positiveInteger(step.numCtx) === tested)
    || steps.find((step) => step.passed)
    || steps[0]
    || null;
}

function recommendationFor(snapshot, threshold) {
  return (Array.isArray(snapshot?.steps) ? snapshot.steps : [])
    .filter(step => step?.passed
      && Number.isFinite(Number(step.degradationPct))
      && Number(step.degradationPct) <= threshold)
    .reduce((max, step) => Math.max(max, positiveInteger(step.numCtx) || 0), 0) || null;
}

function normalizeContextProfile(profile) {
  if (!profile) return null;
  const maxVerifiedContext = positiveInteger(profile.maxVerifiedContext)
    || positiveInteger(profile.verifiedMaxContext);
  const recommendationsVerified = profile.recommendationStatus === 'verified'
    && profile.recommendationEvidenceVersion === RECOMMENDATION_EVIDENCE_VERSION
    && profile.revalidationRequired !== true
    && profile.stale !== true;
  const recommendedDocumentContext = recommendationsVerified
    ? positiveInteger(profile.recommendedDocumentContext)
    : null;
  const recommendedInteractiveContext = recommendationsVerified
    ? positiveInteger(profile.recommendedInteractiveContext)
    : null;
  const performanceKneeContext = recommendationsVerified
    ? positiveInteger(profile.performanceKneeContext)
    : null;
  const qualityVerifiedContext = profile.qualityContextStatus === 'verified'
    ? positiveInteger(profile.qualityVerifiedContext)
    : null;
  return {
    ...profile,
    maxVerifiedContext,
    verifiedMaxContext: maxVerifiedContext,
    historicalMaxVerifiedContext: positiveInteger(profile.historicalMaxVerifiedContext) || maxVerifiedContext,
    recommendedInteractiveContext,
    recommendedDocumentContext,
    performanceKneeContext,
    performanceKneeDegradationPct: Number(profile.performanceKneeDegradationPct) || 15,
    qualityVerifiedContext,
    qualityContextStatus: qualityVerifiedContext ? 'verified' : 'unknown',
    recommendedContext: recommendedDocumentContext,
    recommendationStatus: recommendationsVerified ? 'verified' : 'unknown',
    revalidationRequired: !recommendationsVerified
  };
}

function hostIdForUrl(hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  return getConfiguredHosts().find((host) => normalizeHostUrl(host.url) === normalized)?.id || null;
}

async function updateFromProbeSnapshot(snapshot, options = {}) {
  options.assertAuthorityActive?.();
  const tested = positiveInteger(snapshot?.testedNumCtx);
  const modelName = String(snapshot?.modelName || '').trim().replace(/:latest$/i, '');
  const hostUrl = normalizeHostUrl(snapshot?.hostUrl);
  const artifactDigest = String(snapshot?.artifactDigest || '').trim();
  const runtimeFingerprint = String(snapshot?.runtimeFingerprint || '').trim();
  if (!modelName || !hostUrl || !artifactDigest || !runtimeFingerprint || !tested || snapshot?.status !== 'completed') {
    return null;
  }
  if (!hasValidThroughputEvidence(snapshot)) {
    return null;
  }

  const identityFilter = { modelName, hostUrl, artifactDigest, runtimeFingerprint };
  const snapshotId = snapshot._id ? String(snapshot._id) : null;
  const existingQuery = ModelContextProfile.findOne(identityFilter);
  if (options.signal && typeof existingQuery.setOptions === 'function') existingQuery.setOptions({ signal: options.signal });
  const existing = await existingQuery.lean();
  options.assertAuthorityActive?.();
  // The current ceiling follows the latest valid revalidation and may move
  // down. The historical maximum remains audit evidence, never runtime policy.
  const maxVerifiedContext = tested;
  const historicalMaxVerifiedContext = Math.max(
    positiveInteger(existing?.historicalMaxVerifiedContext)
      || positiveInteger(existing?.maxVerifiedContext)
      || positiveInteger(existing?.verifiedMaxContext)
      || 0,
    tested
  );
  const interactiveThreshold = Number.isFinite(Number(snapshot.interactiveDegradationThreshold))
    ? Math.min(100, Math.max(0, Number(snapshot.interactiveDegradationThreshold))) : 15;
  const documentThreshold = Number.isFinite(Number(snapshot.documentDegradationThreshold))
    ? Math.min(100, Math.max(0, Number(snapshot.documentDegradationThreshold))) : 30;
  const performanceKneeThreshold = Number.isFinite(Number(snapshot.performanceKneeDegradationThreshold))
    ? Math.min(100, Math.max(0, Number(snapshot.performanceKneeDegradationThreshold))) : 15;
  const boundedRecommendation = value => {
    const recommendation = positiveInteger(value);
    return recommendation ? Math.min(recommendation, maxVerifiedContext) : null;
  };
  const recommendedInteractiveContext = boundedRecommendation(
    positiveInteger(snapshot.recommendedInteractiveContext)
      || recommendationFor(snapshot, interactiveThreshold)
  );
  const recommendedDocumentContext = boundedRecommendation(
    positiveInteger(snapshot.recommendedDocumentContext)
      || recommendationFor(snapshot, documentThreshold)
  );
  const performanceKneeContext = boundedRecommendation(
    positiveInteger(snapshot.performanceKneeContext)
      || recommendationFor(snapshot, performanceKneeThreshold)
  );
  const recommendationsVerified = Boolean(recommendedInteractiveContext && recommendedDocumentContext);
  const recommendedContext = recommendedDocumentContext;
  const step = bestStepForSnapshot(snapshot);
  const verifiedInputTokens = positiveInteger(step?.promptTokens) || null;
  const evidenceTokensPerSec = Number(step?.tokensPerSec ?? snapshot.atLimitTokensPerSec ?? 0) || null;

  const updated = await ModelContextProfile.findOneAndUpdate(
    snapshotId ? { ...identityFilter, rejectedEvidenceIds: { $ne: snapshotId } } : identityFilter,
    {
      $set: {
        modelName,
        hostUrl,
        hostId: snapshot.hostId || hostIdForUrl(hostUrl),
        artifactDigest,
        runtimeFingerprint,
        maxVerifiedContext,
        verifiedMaxContext: maxVerifiedContext,
        historicalMaxVerifiedContext,
        verifiedInputTokens,
        recommendedInteractiveContext,
        recommendedDocumentContext,
        performanceKneeContext,
        performanceKneeDegradationPct: performanceKneeThreshold,
        qualityVerifiedContext: null,
        qualityContextStatus: 'unknown',
        recommendationStatus: recommendationsVerified ? 'verified' : 'unknown',
        recommendationEvidenceVersion: RECOMMENDATION_EVIDENCE_VERSION,
        revalidationRequired: !recommendationsVerified,
        recommendationThresholds: {
          interactiveDegradationPct: interactiveThreshold,
          documentDegradationPct: documentThreshold,
          performanceKneeDegradationPct: performanceKneeThreshold
        },
        recommendedContext,
        modelTheoreticalMax: positiveInteger(snapshot.modelTheoreticalMax),
        source: 'context_probe',
        stale: !recommendationsVerified,
        staleReason: recommendationsVerified ? null : 'context_recommendation_unavailable',
        lastValidatedAt: snapshot.testedAt || new Date(),
        latestEvidence: {
          snapshotId: snapshot._id ? String(snapshot._id) : null,
          testedNumCtx: tested,
          promptFillPct: positiveInteger(snapshot.promptFillPct),
          promptTokens: positiveInteger(step?.promptTokens),
          tokensPerSec: evidenceTokensPerSec,
          vramUsedMiB: positiveInteger(step?.vramUsedMiB ?? snapshot.vramAtLimitMiB),
          gpuPercent: Number(step?.gpuPercent ?? snapshot.gpuPercentAtLimit ?? 0) || null,
          degradationPct: Number(snapshot.degradationPct ?? 0),
          completionTokens: positiveInteger(step?.completionTokens),
          requestedCompletionTokens: positiveInteger(step?.requestedCompletionTokens),
          minCompletionTokens: positiveInteger(step?.minCompletionTokens),
          testDurationMs: positiveInteger(snapshot.testDurationMs),
          testedAt: snapshot.testedAt || new Date(),
          source: 'context_probe'
        }
      }
    },
    { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
  ).lean();
  options.assertAuthorityActive?.();
  return updated;
}

async function findContextProfile(modelName, hostUrl, artifact = {}) {
  const host = normalizeHostUrl(hostUrl);
  const candidates = modelNameCandidates(modelName);
  if (!host || candidates.length === 0 || !artifact.digest || !artifact.runtimeFingerprint) return null;
  const filter = {
    modelName: { $in: candidates },
    hostUrl: host,
    stale: { $ne: true }
  };
  filter.artifactDigest = artifact.digest;
  filter.runtimeFingerprint = artifact.runtimeFingerprint;
  const profile = await ModelContextProfile.findOne(filter).sort({ lastValidatedAt: -1 }).lean();
  return normalizeContextProfile(profile);
}

async function invalidateIfSnapshot(snapshot, reason = 'claim_lost_during_context_authority_write') {
  if (!snapshot?._id) return { modifiedCount: 0 };
  const snapshotId = String(snapshot._id);
  const identityFilter = {
    modelName: String(snapshot.modelName || '').trim().replace(/:latest$/i, ''),
    hostUrl: normalizeHostUrl(snapshot.hostUrl),
    artifactDigest: snapshot.artifactDigest,
    runtimeFingerprint: snapshot.runtimeFingerprint
  };
  const fence = await ModelContextProfile.updateOne(
    identityFilter,
    { $addToSet: { rejectedEvidenceIds: snapshotId } },
    { upsert: true }
  );
  const invalidated = await ModelContextProfile.updateOne(
    { ...identityFilter, 'latestEvidence.snapshotId': snapshotId },
    {
      $set: {
        recommendationStatus: 'unknown',
        revalidationRequired: true,
        stale: true,
        staleReason: reason,
        recommendedInteractiveContext: null,
        recommendedDocumentContext: null,
        performanceKneeContext: null,
        qualityVerifiedContext: null,
        qualityContextStatus: 'unknown',
        recommendedContext: null
      }
    }
  );
  return { fence, invalidated };
}

module.exports = {
  findContextProfile,
  hasValidThroughputEvidence,
  isValidTokensPerSec,
  modelNameCandidates,
  normalizeContextProfile,
  updateFromProbeSnapshot,
  invalidateIfSnapshot,
  RECOMMENDATION_EVIDENCE_VERSION
};

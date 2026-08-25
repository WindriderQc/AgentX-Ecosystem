const ModelContextProfile = require('../../models/ModelContextProfile');
const { getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');

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

function hostIdForUrl(hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  return getConfiguredHosts().find((host) => normalizeHostUrl(host.url) === normalized)?.id || null;
}

async function updateFromProbeSnapshot(snapshot) {
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
  const existing = await ModelContextProfile.findOne(identityFilter).lean();
  const verifiedMaxContext = Math.max(
    positiveInteger(existing?.verifiedMaxContext) || 0,
    tested
  );
  // Keep the legacy field equal to the measured value while downstream
  // consumers migrate to verifiedMaxContext. It is no longer a second,
  // independently capped runtime policy.
  const recommendedContext = verifiedMaxContext;
  const step = bestStepForSnapshot(snapshot);
  const verifiedInputTokens = Math.max(
    positiveInteger(existing?.verifiedInputTokens) || 0,
    positiveInteger(step?.promptTokens) || 0
  ) || null;
  const evidenceTokensPerSec = Number(step?.tokensPerSec ?? snapshot.atLimitTokensPerSec ?? 0) || null;

  return ModelContextProfile.findOneAndUpdate(
    identityFilter,
    {
      $set: {
        modelName,
        hostUrl,
        hostId: snapshot.hostId || hostIdForUrl(hostUrl),
        artifactDigest,
        runtimeFingerprint,
        verifiedMaxContext,
        verifiedInputTokens,
        recommendedContext,
        modelTheoreticalMax: positiveInteger(snapshot.modelTheoreticalMax),
        source: 'context_probe',
        stale: false,
        staleReason: null,
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
    { upsert: true, new: true }
  ).lean();
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
  return ModelContextProfile.findOne(filter).sort({ lastValidatedAt: -1 }).lean();
}

module.exports = {
  findContextProfile,
  hasValidThroughputEvidence,
  isValidTokensPerSec,
  modelNameCandidates,
  updateFromProbeSnapshot
};

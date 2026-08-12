const ModelContextProfile = require('../../models/ModelContextProfile');
const { getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');

const DEFAULT_RECOMMENDED_CONTEXT_CAP = 131072;
const DEFAULT_MAX_SANE_TOKENS_PER_SEC = 10000;

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function recommendedContextCap() {
  return positiveInteger(
    process.env.MODEL_CONTEXT_RECOMMENDED_CAP
      ?? process.env.MODEL_CONTEXT_OPERATIONAL_CAP
      ?? process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP
      ?? DEFAULT_RECOMMENDED_CONTEXT_CAP
  );
}

function maxSaneTokensPerSec() {
  return positiveInteger(
    process.env.MODEL_CONTEXT_MAX_SANE_TOKENS_PER_SEC
      ?? process.env.CONTEXT_PROBE_MAX_SANE_TOKENS_PER_SEC
      ?? DEFAULT_MAX_SANE_TOKENS_PER_SEC
  ) || DEFAULT_MAX_SANE_TOKENS_PER_SEC;
}

function isSaneTokensPerSec(tokensPerSec) {
  if (tokensPerSec === null || tokensPerSec === undefined) return true;
  const value = Number(tokensPerSec);
  return Number.isFinite(value) && value >= 0 && value <= maxSaneTokensPerSec();
}

function hasSaneThroughputEvidence(snapshot) {
  const values = [
    snapshot?.baselineTokensPerSec,
    snapshot?.atLimitTokensPerSec,
    ...(
      Array.isArray(snapshot?.steps)
        ? snapshot.steps.map((step) => step?.tokensPerSec)
        : []
    )
  ];
  return values.every(isSaneTokensPerSec);
}

function modelNameCandidates(modelName) {
  const normalized = String(modelName || '').trim().replace(/:latest$/i, '');
  if (!normalized) return [];
  const slashIdx = normalized.indexOf('/');
  const bare = slashIdx > 0 ? normalized.slice(slashIdx + 1) : null;
  return Array.from(new Set([normalized, bare].filter(Boolean)));
}

function chooseRecommendedContext(verifiedMaxContext) {
  const verified = positiveInteger(verifiedMaxContext);
  if (!verified) return null;
  const cap = recommendedContextCap();
  return cap ? Math.min(verified, cap) : verified;
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
  return getConfiguredHosts().find((host) => host.url === normalized)?.id || null;
}

async function updateFromProbeSnapshot(snapshot) {
  const tested = positiveInteger(snapshot?.testedNumCtx);
  const modelName = String(snapshot?.modelName || '').trim().replace(/:latest$/i, '');
  const hostUrl = normalizeHostUrl(snapshot?.hostUrl);
  if (!modelName || !hostUrl || !tested || snapshot?.status !== 'completed') {
    return null;
  }
  if (!hasSaneThroughputEvidence(snapshot)) {
    return null;
  }

  const existing = await ModelContextProfile.findOne({ modelName, hostUrl }).lean();
  const verifiedMaxContext = Math.max(
    positiveInteger(existing?.verifiedMaxContext) || 0,
    tested
  );
  const recommendedContext = chooseRecommendedContext(verifiedMaxContext);
  const stressCeiling = verifiedMaxContext > recommendedContext ? verifiedMaxContext : null;
  const step = bestStepForSnapshot(snapshot);
  const evidenceTokensPerSec = Number(step?.tokensPerSec ?? snapshot.atLimitTokensPerSec ?? 0) || null;

  return ModelContextProfile.findOneAndUpdate(
    { modelName, hostUrl },
    {
      $set: {
        modelName,
        hostUrl,
        hostId: hostIdForUrl(hostUrl),
        verifiedMaxContext,
        recommendedContext,
        stressCeiling,
        modelTheoreticalMax: positiveInteger(snapshot.modelTheoreticalMax),
        source: 'context_probe',
        stale: false,
        staleReason: null,
        lastValidatedAt: snapshot.testedAt || new Date(),
        latestEvidence: {
          snapshotId: snapshot._id ? String(snapshot._id) : null,
          testedNumCtx: tested,
          promptFillPct: positiveInteger(snapshot.promptFillPct),
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

async function findContextProfile(modelName, hostUrl) {
  const host = normalizeHostUrl(hostUrl);
  const candidates = modelNameCandidates(modelName);
  if (!host || candidates.length === 0) return null;
  return ModelContextProfile.findOne({
    modelName: { $in: candidates },
    hostUrl: host,
    stale: { $ne: true }
  }).lean();
}

module.exports = {
  chooseRecommendedContext,
  findContextProfile,
  hasSaneThroughputEvidence,
  isSaneTokensPerSec,
  modelNameCandidates,
  updateFromProbeSnapshot
};

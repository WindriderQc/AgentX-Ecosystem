const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const { findContextProfile } = require('./modelContextProfileService');
const { normalizeModelTag: normalizeModelName } = require('../../../shared/modelNames');

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function hasInvalidProbeThroughput(probe) {
  const values = [
    probe?.baselineTokensPerSec,
    probe?.atLimitTokensPerSec,
    ...(Array.isArray(probe?.steps) ? probe.steps.map(step => step?.tokensPerSec) : [])
  ];
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    const n = Number(value);
    return !Number.isFinite(n) || n <= 0;
  });
}

function modelNameCandidates(modelName) {
  const normalized = normalizeModelName(modelName);
  return normalized ? [normalized] : [];
}

async function findLatestProbe(modelName, hostUrl, artifact = {}) {
  const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
  const candidates = modelNameCandidates(modelName);
  if (candidates.length === 0 || !artifact.digest || !artifact.runtimeFingerprint) return null;

  const filter = {
    modelName: { $in: candidates },
    status: 'completed'
  };
  if (hostUrl) {
    filter.hostUrl = normalizeHostUrl(hostUrl);
  }
  filter.artifactDigest = artifact.digest;
  filter.runtimeFingerprint = artifact.runtimeFingerprint;

  return ModelContextProbeSnapshot.findOne(filter)
    .sort({ testedAt: -1 })
    .lean();
}

async function resolveModelNumCtxDetails(modelName, opts = {}) {
  // Accept a raw host URL string as second arg for convenience
  if (typeof opts === 'string') {
    opts = { targetHost: opts };
  }
  const fallback = Number.isFinite(Number(opts.fallback)) && Number(opts.fallback) > 0
    ? Number(opts.fallback)
    : null;
  const targetHost = opts.targetHost ? normalizeHostUrl(opts.targetHost) : null;
  // Re-profile callers pass skipPriorProfileArtifacts:true so prior-run results
  // (materialized context profile + latest probe snapshot) don't dictate the pre-probe
  // warm-up ctx — those are exactly what the re-profile is about to replace,
  // and honoring them makes re-profiling impossible whenever the prior run
  // picked a ctx the host can no longer warm up within the timeout.
  const skipPriorProfileArtifacts = opts.skipPriorProfileArtifacts === true;
  const artifactIdentity = opts.artifactIdentity || {};
  const normalizedModel = normalizeModelName(modelName);

  if (!normalizedModel) {
    return {
      num_ctx: fallback,
      source: fallback ? 'caller_fallback' : 'unresolved',
      authoritative: false,
      targetHost
    };
  }

  if (!skipPriorProfileArtifacts) {
    const profile = await findContextProfile(normalizedModel, targetHost, artifactIdentity);
    const verifiedContext = positiveInteger(profile?.maxVerifiedContext)
      || positiveInteger(profile?.verifiedMaxContext)
      || positiveInteger(profile?.recommendedContext);
    if (verifiedContext) {
      return {
        num_ctx: verifiedContext,
        source: 'model_context_profile',
        authoritative: true,
        targetHost: profile.hostUrl || targetHost,
        testedAt: profile.lastValidatedAt || null,
        details: {
          verifiedMaxContext: verifiedContext,
          maxVerifiedContext: verifiedContext,
          recommendedInteractiveContext: positiveInteger(profile?.recommendedInteractiveContext),
          recommendedDocumentContext: positiveInteger(profile?.recommendedDocumentContext),
          verifiedInputTokens: positiveInteger(profile.verifiedInputTokens),
          matchedName: profile.modelName || null
        }
      };
    }

    const probe = await findLatestProbe(normalizedModel, targetHost, artifactIdentity);
    if (probe?.testedNumCtx != null && !hasInvalidProbeThroughput(probe)) {
      return {
        num_ctx: Number(probe.testedNumCtx),
        source: 'benchmark_context_probe',
        authoritative: true,
        targetHost: probe.hostUrl || targetHost,
        testedAt: probe.testedAt || null,
        matchedName: probe.modelName
      };
    }
  }

  return {
    num_ctx: fallback,
    source: fallback ? 'caller_fallback' : 'unresolved',
    authoritative: false,
    targetHost: targetHost || null
  };
}

async function resolveModelNumCtx(modelName, opts = {}) {
  const details = await resolveModelNumCtxDetails(modelName, opts);
  return details.num_ctx;
}

module.exports = {
  normalizeModelName,
  modelNameCandidates,
  resolveModelNumCtxDetails,
  resolveModelNumCtx
};

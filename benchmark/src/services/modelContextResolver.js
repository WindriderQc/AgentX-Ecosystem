const ModelProfile = require('../../models/ModelProfile');
const ModelAdaptation = require('../../models/ModelAdaptation');
const { getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');
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

// Namespace-stripped alias used to match probes/adaptations across variants
// that wrap the same weights with a custom Modelfile (e.g. "ax/gemma4:26b"
// is gemma4:26b with our tuning). Probe ceilings are a property of the
// underlying weights + host, not the namespace, so an adaptation for the
// base name is a valid fallback lookup for the namespaced variant.
function stripModelNamespace(modelName) {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return null;
  const slashIdx = normalized.indexOf('/');
  if (slashIdx <= 0 || slashIdx === normalized.length - 1) return null;
  return normalized.slice(slashIdx + 1);
}

function modelNameCandidates(modelName) {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return [];
  const bare = stripModelNamespace(normalized);
  return bare && bare !== normalized ? [normalized, bare] : [normalized];
}

async function findRegistryEntry(modelName) {
  const candidates = modelNameCandidates(modelName);
  if (candidates.length === 0) return null;

  return ModelProfile.findOne({
    $or: [
      ...candidates.map((name) => ({ name })),
      ...candidates.map((displayName) => ({ displayName }))
    ]
  }).lean();
}

async function findLatestProbe(modelName, hostUrl) {
  const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
  const candidates = modelNameCandidates(modelName);
  if (candidates.length === 0) return null;

  const filter = {
    modelName: { $in: candidates },
    status: 'completed'
  };
  if (hostUrl) {
    filter.hostUrl = normalizeHostUrl(hostUrl);
  }

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
  // (deployed adaptation + latest probe snapshot) don't dictate the pre-probe
  // warm-up ctx — those are exactly what the re-profile is about to replace,
  // and honoring them makes re-profiling impossible whenever the prior run
  // picked a ctx the host can no longer warm up within the timeout.
  const skipPriorProfileArtifacts = opts.skipPriorProfileArtifacts === true;
  const normalizedModel = normalizeModelName(modelName);

  if (!normalizedModel) {
    return {
      num_ctx: fallback,
      source: fallback ? 'caller_fallback' : 'unresolved',
      authoritative: false,
      targetHost
    };
  }

  // Step 0: Check ModelAdaptation (profiler-adapted config — highest priority)
  try {
    if (targetHost && !skipPriorProfileArtifacts) {
      const hosts = getConfiguredHosts();
      const host = hosts.find(h => h.url === targetHost);
      if (host?.id) {
        const candidates = modelNameCandidates(normalizedModel);
        const adaptation = await ModelAdaptation.findOne({
          modelName: { $in: candidates },
          hostId: host.id,
          'deployment.status': 'deployed',
          'staleness.stale': { $ne: true }
        }).lean();
        if (adaptation?.config?.num_ctx) {
          return {
            num_ctx: adaptation.config.num_ctx,
            source: 'profiler_adaptation',
            authoritative: true,
            details: { hostId: host.id, adaptedName: adaptation.adaptedName, matchedName: adaptation.modelName }
          };
        }
      }
    }
  } catch (err) {
    // Fall through to other resolution methods
  }

  const entry = await findRegistryEntry(normalizedModel);
  const sourceHost = normalizeHostUrl(entry?.sourceHost || entry?.host || null);

  if (entry?.executionOverrides?.num_ctx != null) {
    return {
      num_ctx: Number(entry.executionOverrides.num_ctx),
      source: 'override',
      authoritative: true,
      targetHost: targetHost || sourceHost
    };
  }

  if (!skipPriorProfileArtifacts) {
    const profile = await findContextProfile(normalizedModel, targetHost || sourceHost);
    const verifiedContext = positiveInteger(profile?.verifiedMaxContext)
      || positiveInteger(profile?.recommendedContext);
    if (verifiedContext) {
      return {
        num_ctx: verifiedContext,
        source: 'model_context_profile',
        authoritative: true,
        targetHost: profile.hostUrl || targetHost || sourceHost,
        testedAt: profile.lastValidatedAt || null,
        details: {
          verifiedMaxContext: verifiedContext,
          verifiedInputTokens: positiveInteger(profile.verifiedInputTokens),
          matchedName: profile.modelName || null
        }
      };
    }

    const probe = await findLatestProbe(normalizedModel, targetHost || sourceHost);
    if (probe?.testedNumCtx != null && !hasInvalidProbeThroughput(probe)) {
      return {
        num_ctx: Number(probe.testedNumCtx),
        source: 'benchmark_context_probe',
        authoritative: true,
        targetHost: probe.hostUrl || targetHost || sourceHost,
        testedAt: probe.testedAt || null,
        matchedName: probe.modelName
      };
    }
  }

  const legacyContextTest = entry?.contextTest;
  if (legacyContextTest?.testedNumCtx != null && legacyContextTest.status === 'completed') {
    return {
      num_ctx: Number(legacyContextTest.testedNumCtx),
      source: 'legacy_context_test',
      authoritative: true,
      targetHost: targetHost || sourceHost || null
    };
  }

  return {
    num_ctx: fallback,
    source: fallback ? 'caller_fallback' : 'unresolved',
    authoritative: false,
    targetHost: targetHost || sourceHost || null
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

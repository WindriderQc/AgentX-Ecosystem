const ModelProfile = require('../../models/ModelProfile');
const ModelAdaptation = require('../../models/ModelAdaptation');
const { getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const ollamaVramService = require('./ollamaVramService');
const { findContextProfile } = require('./modelContextProfileService');
const { detectOptimalNumCtx, parseParameterCount, parseQuantization } = require('./parameterDetection');

function normalizeModelName(modelName) {
  return String(modelName || '').trim().replace(/:latest$/i, '');
}

const DEFAULT_OPERATIONAL_NUM_CTX_CAP = 98304;
const DEFAULT_MAX_SANE_TOKENS_PER_SEC = 10000;

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function getOperationalNumCtxCap(opts = {}) {
  const raw = opts.operationalCap
    ?? process.env.MODEL_CONTEXT_OPERATIONAL_CAP
    ?? process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP
    ?? DEFAULT_OPERATIONAL_NUM_CTX_CAP;
  const cap = positiveInteger(raw);
  return cap === null ? null : cap;
}

function maxSaneTokensPerSec() {
  return positiveInteger(
    process.env.MODEL_CONTEXT_MAX_SANE_TOKENS_PER_SEC
      ?? process.env.CONTEXT_PROBE_MAX_SANE_TOKENS_PER_SEC
      ?? DEFAULT_MAX_SANE_TOKENS_PER_SEC
  ) || DEFAULT_MAX_SANE_TOKENS_PER_SEC;
}

function hasImplausibleProbeThroughput(probe) {
  const cap = maxSaneTokensPerSec();
  const values = [
    probe?.baselineTokensPerSec,
    probe?.atLimitTokensPerSec,
    ...(Array.isArray(probe?.steps) ? probe.steps.map(step => step?.tokensPerSec) : [])
  ];
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    const n = Number(value);
    return !Number.isFinite(n) || n < 0 || n > cap;
  });
}

function withOperationalCap(result, opts = {}) {
  if (!result || opts.disableOperationalCap === true) return result;
  const cap = getOperationalNumCtxCap(opts);
  const numCtx = positiveInteger(result.num_ctx);
  if (!cap || !numCtx || numCtx <= cap) return result;
  return {
    ...result,
    num_ctx: cap,
    source: `${result.source || 'unknown'}_operational_cap`,
    capped: true,
    operational_cap: cap,
    verified_num_ctx: numCtx
  };
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

async function resolveHostVramMiB(targetHost) {
  const normalizedHost = normalizeHostUrl(targetHost);
  if (!normalizedHost) return null;

  const configuredHost = getConfiguredHosts().find((host) => host.url === normalizedHost);
  if (configuredHost?.vramMb) {
    return configuredHost.vramMb;
  }

  const vram = await ollamaVramService.getHostVram(normalizedHost);
  if (vram?.ok && Number.isFinite(vram.memoryTotalMiBTotal) && vram.memoryTotalMiBTotal > 0) {
    return vram.memoryTotalMiBTotal;
  }

  return null;
}

async function resolveModelNumCtxDetails(modelName, opts = {}) {
  // Accept a raw host URL string as second arg for convenience
  if (typeof opts === 'string') {
    opts = { targetHost: opts };
  }
  const fallback = Number.isFinite(Number(opts.fallback)) ? Number(opts.fallback) : 8192;
  const targetHost = opts.targetHost ? normalizeHostUrl(opts.targetHost) : null;
  // Re-profile callers pass skipPriorProfileArtifacts:true so prior-run results
  // (deployed adaptation + latest probe snapshot) don't dictate the pre-probe
  // warm-up ctx — those are exactly what the re-profile is about to replace,
  // and honoring them makes re-profiling impossible whenever the prior run
  // picked a ctx the host can no longer warm up within the timeout.
  const skipPriorProfileArtifacts = opts.skipPriorProfileArtifacts === true;
  const normalizedModel = normalizeModelName(modelName);

  if (!normalizedModel) {
    return { num_ctx: fallback, source: 'fallback', targetHost };
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
          return withOperationalCap({
            num_ctx: adaptation.config.num_ctx,
            source: 'profiler_adaptation',
            authoritative: true,
            details: { hostId: host.id, adaptedName: adaptation.adaptedName, matchedName: adaptation.modelName }
          }, opts);
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
    if (profile?.recommendedContext != null) {
      return withOperationalCap({
        num_ctx: Number(profile.recommendedContext),
        source: 'model_context_profile',
        authoritative: true,
        targetHost: profile.hostUrl || targetHost || sourceHost,
        testedAt: profile.lastValidatedAt || null,
        details: {
          verifiedMaxContext: profile.verifiedMaxContext || null,
          stressCeiling: profile.stressCeiling || null,
          matchedName: profile.modelName || null
        }
      }, opts);
    }

    const probe = await findLatestProbe(normalizedModel, targetHost || sourceHost);
    if (probe?.testedNumCtx != null && !hasImplausibleProbeThroughput(probe)) {
      return withOperationalCap({
        num_ctx: Number(probe.testedNumCtx),
        source: 'benchmark_context_probe',
        authoritative: true,
        targetHost: probe.hostUrl || targetHost || sourceHost,
        testedAt: probe.testedAt || null,
        matchedName: probe.modelName
      }, opts);
    }
  }

  const effectiveHost = targetHost || sourceHost;
  if (effectiveHost) {
    const hostVramMiB = await resolveHostVramMiB(effectiveHost);
    const detection = detectOptimalNumCtx({
      parameterSize: entry?.parameterSize || parseParameterCount(normalizedModel),
      quantization: entry?.quantization || parseQuantization(normalizedModel),
      modelSizeBytes: entry?.modelSizeBytes || null,
      hostVramMiB
    });
    if (detection?.num_ctx) {
      return withOperationalCap({
        num_ctx: detection.num_ctx,
        source: targetHost && sourceHost && targetHost !== sourceHost
          ? 'target_host_vram_estimate'
          : 'host_vram_estimate',
        authoritative: true,
        targetHost: effectiveHost,
        reason: detection.reason
      }, opts);
    }
  }

  const legacyContextTest = entry?.contextTest;
  if (legacyContextTest?.testedNumCtx != null && legacyContextTest.status === 'completed') {
    return withOperationalCap({
      num_ctx: Number(legacyContextTest.testedNumCtx),
      source: 'legacy_context_test',
      authoritative: true,
      targetHost: targetHost || sourceHost || null
    }, opts);
  }

  if (entry?.executionDefaults?.num_ctx != null) {
    return withOperationalCap({
      num_ctx: Number(entry.executionDefaults.num_ctx),
      source: 'execution_default',
      authoritative: true,
      targetHost: targetHost || sourceHost || null
    }, opts);
  }

  if (entry?.capabilities?.maxContext != null) {
    return withOperationalCap({
      num_ctx: Number(entry.capabilities.maxContext),
      source: 'capabilities_max_context',
      authoritative: true,
      targetHost: targetHost || sourceHost || null
    }, opts);
  }

  // No profile, no probe, no VRAM signal. Callers should treat this as
  // "unprofiled" and either trigger a probe or warn. The hardcoded fallback
  // is a safety floor — it is NOT a recommendation.
  try {
    const logger = require('../../config/logger');
    logger.warn('modelContextResolver fell back to caller-supplied default — model is unprofiled', {
      model: normalizedModel,
      targetHost: targetHost || sourceHost || null,
      fallback
    });
  } catch (_) { /* logger optional */ }

  return {
    num_ctx: fallback,
    source: 'fallback',
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
  resolveHostVramMiB,
  resolveModelNumCtxDetails,
  resolveModelNumCtx
};

'use strict';

/**
 * Model Context Info — resolves a model's effective context window
 * from the Modelfile (the source of truth per 2026-04-18 architecture).
 *
 * Priority:
 *   1. HostPreference pinned context — operator-selected resident runtime
 *   2. Modelfile `PARAMETER num_ctx <N>` — model build default
 *   3. ModelContextProfile workload recommendation — measured exact-artifact
 *      runtime policy (interactive by default; document when requested)
 *   4. Verified/model-declared maxima — capacity inspection only
 *   5. Unresolved (no context is invented)
 *
 * The returned `source` tells the chat UI where the number came from, so we
 * can show a badge ("Modelfile", "Profiled", "Unresolved") and set user
 * expectations. Cached 5 min per (host, model) — Modelfile rarely changes.
 */

const logger = require('../../config/logger');
const { resolveTarget } = require('../helpers/ollamaUtils');
const { modelLookupNames, modelsMatch } = require('../helpers/modelNameNormalization');
const { resolveArtifactIdentity } = require('./artifactIdentityService');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');

const CACHE_TTL_MS = 5 * 60 * 1000;
const RECOMMENDATION_EVIDENCE_VERSION = 'context-probe-degradation-v3';
const cache = new Map(); // key `${host}::${model}` → { value, expiresAt }
let _fetch = null;

async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}

function _setFetch(fn) { _fetch = fn; }

function cacheKey(host, model, artifact = {}, workload = 'interactive') {
  return `${host || ''}::${model || ''}::${artifact.digest || ''}::${artifact.runtimeFingerprint || ''}::${workload}`;
}

function parseNumCtxFromParameters(parametersStr) {
  if (!parametersStr || typeof parametersStr !== 'string') return null;
  const m = parametersStr.match(/^\s*num_ctx\s+(\d+)\s*$/m);
  return m ? parseInt(m[1], 10) : null;
}

function pickContextLengthFromModelInfo(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return null;
}

async function showModelOnHost(hostUrl, model, timeoutMs = 5000) {
  const fetchFn = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${hostUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.debug('[modelContextInfo] /api/show failed', { hostUrl, model, error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromHostPreferencePin(model, hostUrl) {
  if (!hostUrl) return null;
  try {
    const HostPreference = require('../../models/HostPreference');
    const pref = await HostPreference.findOne({ hostUrl })
      .select('pinnedModels displayName')
      .lean();
    const pin = (pref?.pinnedModels || []).find((item) =>
      modelsMatch(item?.model, model) && Number(item?.contextSize) > 0
    );
    if (!pin) return null;
    return {
      num_ctx: Math.round(Number(pin.contextSize)),
      source: 'host_preference_pin',
      pinnedModel: pin.model,
      hostDisplayName: pref.displayName || null
    };
  } catch (err) {
    logger.debug('[modelContextInfo] host preference lookup failed', { model, hostUrl, error: err.message });
    return null;
  }
}

async function fromContextProfile(model, hostUrl, artifact, deps = {}, workload = 'interactive') {
  if (!hostUrl || artifact?.identityQualified !== true || !artifact.digest || !artifact.runtimeFingerprint) {
    return null;
  }
  try {
    let profile;
    if (deps.ModelContextProfile) {
      profile = await deps.ModelContextProfile.findOne({
        modelName: { $in: modelLookupNames(model) },
        hostUrl,
        artifactDigest: artifact.digest,
        runtimeFingerprint: artifact.runtimeFingerprint,
        stale: { $ne: true }
      })
        .select('modelName hostUrl artifactDigest runtimeFingerprint recommendedContext recommendedInteractiveContext recommendedDocumentContext recommendationStatus recommendationEvidenceVersion revalidationRequired maxVerifiedContext verifiedMaxContext historicalMaxVerifiedContext verifiedInputTokens lastValidatedAt source stale')
        .lean();
    } else {
      const client = deps.benchmarkClient || getBenchmarkServiceClient();
      profile = await client.getContextProfile(model, {
        hostUrl,
        artifactDigest: artifact.digest,
        runtimeFingerprint: artifact.runtimeFingerprint
      });
    }
    const verified = Number(profile?.maxVerifiedContext || profile?.verifiedMaxContext);
    if (!Number.isFinite(verified) || verified <= 0) return null;
    const recommendationsVerified = profile?.recommendationStatus === 'verified'
      && profile?.recommendationEvidenceVersion === RECOMMENDATION_EVIDENCE_VERSION
      && profile?.revalidationRequired !== true
      && profile?.stale !== true;
    const interactive = recommendationsVerified ? Number(profile?.recommendedInteractiveContext) : null;
    const document = recommendationsVerified ? Number(profile?.recommendedDocumentContext) : null;
    const selected = workload === 'capacity'
      ? verified
      : workload === 'document'
        ? document
        : interactive;
    return {
      num_ctx: Number.isFinite(selected) && selected > 0 ? Math.round(selected) : null,
      source: `model_context_profile_${workload}`,
      verifiedMaxContext: Math.round(verified),
      maxVerifiedContext: Math.round(verified),
      recommendedInteractiveContext: Number.isFinite(interactive) && interactive > 0 ? Math.round(interactive) : null,
      recommendedDocumentContext: Number.isFinite(document) && document > 0 ? Math.round(document) : null,
      recommendationStatus: recommendationsVerified ? 'verified' : 'unknown',
      revalidationRequired: !recommendationsVerified,
      historicalMaxVerifiedContext: Number(profile?.historicalMaxVerifiedContext) || Math.round(verified),
      verifiedInputTokens: profile.verifiedInputTokens || null,
      profiledAt: profile.lastValidatedAt || null,
      matchedName: profile.modelName || null
    };
  } catch (err) {
    logger.debug('[modelContextInfo] context profile lookup failed', { model, hostUrl, error: err.message });
    return null;
  }
}

/**
 * Resolve context info for a (model, host) pair. Without a host there is no
 * exact runtime artifact to inspect, so no profiled fallback is accepted.
 *
 * @returns {Promise<{ model, host, num_ctx, source, maxContextLength? }>}
 */
async function getContextInfo(model, hostUrlRaw, options = {}) {
  if (!model) throw new Error('model is required');
  const hostUrl = hostUrlRaw ? resolveTarget(hostUrlRaw) : null;
  const artifact = options.artifactIdentity || (hostUrl
    ? await resolveArtifactIdentity(model, hostUrl, options.deps || {})
    : null);
  const workload = ['interactive', 'document', 'capacity'].includes(options.workload)
    ? options.workload
    : 'interactive';
  const key = cacheKey(hostUrl, model, artifact || {}, workload);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let num_ctx = null;
  let source = 'unresolved';
  let maxContextLength = null;
  let profileMeta = null;
  let pinMeta = null;

  if (hostUrl) {
    const pin = await fromHostPreferencePin(model, hostUrl);
    if (pin) {
      num_ctx = pin.num_ctx;
      source = pin.source;
      pinMeta = pin;
    }
  }

  if (hostUrl) {
    const data = await showModelOnHost(hostUrl, model);
    if (data) {
      const parsed = parseNumCtxFromParameters(data.parameters);
      if (!num_ctx && parsed) {
        num_ctx = parsed;
        source = 'modelfile';
      }
      maxContextLength = pickContextLengthFromModelInfo(data.model_info);
    }
  }

  // A measured profile remains evidence even when an operator pin or the
  // resident Modelfile determines the active window.
  const profile = await fromContextProfile(model, hostUrl, artifact, options.deps || {}, workload);
  if (profile) {
    profileMeta = profile;
    if (!num_ctx && Number.isFinite(profile.num_ctx) && profile.num_ctx > 0) {
      num_ctx = profile.num_ctx;
      source = profile.source;
    }
  }

  if (!num_ctx && maxContextLength && workload === 'capacity') {
    num_ctx = maxContextLength;
    source = 'model_capacity';
  }

  const value = {
    model,
    host: hostUrl,
    num_ctx,
    source,
    workload,
    artifactDigest: artifact?.digest || null,
    runtimeFingerprint: artifact?.runtimeFingerprint || null,
    ...(pinMeta?.pinnedModel ? { pinnedModel: pinMeta.pinnedModel } : {}),
    ...(pinMeta?.hostDisplayName ? { hostDisplayName: pinMeta.hostDisplayName } : {}),
    ...(profileMeta?.verifiedMaxContext ? { verifiedMaxContext: profileMeta.verifiedMaxContext } : {}),
    ...(profileMeta?.maxVerifiedContext ? { maxVerifiedContext: profileMeta.maxVerifiedContext } : {}),
    ...(profileMeta?.recommendedInteractiveContext ? { recommendedInteractiveContext: profileMeta.recommendedInteractiveContext } : {}),
    ...(profileMeta?.recommendedDocumentContext ? { recommendedDocumentContext: profileMeta.recommendedDocumentContext } : {}),
    ...(profileMeta?.recommendationStatus ? { recommendationStatus: profileMeta.recommendationStatus } : {}),
    ...(profileMeta?.revalidationRequired !== undefined ? { revalidationRequired: profileMeta.revalidationRequired } : {}),
    ...(profileMeta?.verifiedInputTokens ? { verifiedInputTokens: profileMeta.verifiedInputTokens } : {}),
    ...(profileMeta?.profiledAt ? { profiledAt: profileMeta.profiledAt } : {}),
    ...(profileMeta?.matchedName ? { matchedName: profileMeta.matchedName } : {}),
    ...(maxContextLength ? { maxContextLength } : {})
  };

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function _clearCache() {
  cache.clear();
}

module.exports = { getContextInfo, _clearCache, _setFetch };

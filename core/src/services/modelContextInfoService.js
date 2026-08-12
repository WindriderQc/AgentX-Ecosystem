'use strict';

/**
 * Model Context Info — resolves a model's effective context window
 * from the Modelfile (the source of truth per 2026-04-18 architecture).
 *
 * Priority:
 *   1. HostPreference pinned context — operator-selected resident runtime
 *   2. Modelfile `PARAMETER num_ctx <N>` — model build default
 *   3. ModelContextProfile.recommendedContext — current measured host/model profile
 *   4. model_info `<arch>.context_length` — the model's max capacity
 *   5. ModelRegistry.contextTest.testedNumCtx — legacy profiler-verified
 *   6. ModelRegistry.executionDefaults.num_ctx — registry default
 *   7. Hard fallback (8192)
 *
 * The returned `source` tells the chat UI where the number came from, so we
 * can show a badge ("Modelfile", "Profiled", "Default") and set user
 * expectations. Cached 5 min per (host, model) — Modelfile rarely changes.
 */

const logger = require('../../config/logger');
const { resolveTarget } = require('../helpers/ollamaUtils');
const { modelsMatch } = require('../helpers/modelNameNormalization');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key `${host}::${model}` → { value, expiresAt }
let _fetch = null;

async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}

function _setFetch(fn) { _fetch = fn; }

function cacheKey(host, model) {
  return `${host || ''}::${model || ''}`;
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

function modelLookupNames(model) {
  const raw = String(model || '').trim().replace(/:latest$/i, '');
  if (!raw) return [];
  const slashIdx = raw.indexOf('/');
  const bare = slashIdx > 0 && slashIdx < raw.length - 1 ? raw.slice(slashIdx + 1) : null;
  return Array.from(new Set([raw, bare].filter(Boolean)));
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

async function fromContextProfile(model, hostUrl) {
  if (!hostUrl) return null;
  try {
    const ModelContextProfile = require('../../models/ModelContextProfile');
    const profile = await ModelContextProfile.findOne({
      modelName: { $in: modelLookupNames(model) },
      hostUrl,
      stale: { $ne: true }
    })
      .select('modelName hostUrl recommendedContext verifiedMaxContext stressCeiling lastValidatedAt source')
      .lean();
    const recommended = profile && Number(profile.recommendedContext);
    if (!Number.isFinite(recommended) || recommended <= 0) return null;
    return {
      num_ctx: Math.round(recommended),
      source: 'model_context_profile',
      verifiedMaxContext: profile.verifiedMaxContext || null,
      stressCeiling: profile.stressCeiling || null,
      profiledAt: profile.lastValidatedAt || null,
      matchedName: profile.modelName || null
    };
  } catch (err) {
    logger.debug('[modelContextInfo] context profile lookup failed', { model, hostUrl, error: err.message });
    return null;
  }
}

async function fromRegistry(model) {
  try {
    const ModelRegistry = require('../../models/ModelRegistry');
    const entry = await ModelRegistry.findOne({ modelName: model.replace(/:latest$/, '') })
      .select('contextTest executionDefaults capabilities sourceHost')
      .lean();
    if (!entry) return null;
    const tested = entry.contextTest && entry.contextTest.status === 'completed' && entry.contextTest.testedNumCtx;
    if (tested) return { num_ctx: tested, source: 'profiled' };
    const def = entry.executionDefaults && entry.executionDefaults.num_ctx;
    if (def) return { num_ctx: def, source: 'registry_default' };
    const cap = entry.capabilities && entry.capabilities.maxContext;
    if (cap) return { num_ctx: cap, source: 'registry_capability' };
    return null;
  } catch (err) {
    logger.debug('[modelContextInfo] registry lookup failed', { model, error: err.message });
    return null;
  }
}

/**
 * Resolve context info for a (model, host) pair. Host optional — if omitted,
 * we fall back to registry-only info.
 *
 * @returns {Promise<{ model, host, num_ctx, source, maxContextLength? }>}
 */
async function getContextInfo(model, hostUrlRaw) {
  if (!model) throw new Error('model is required');
  const hostUrl = hostUrlRaw ? resolveTarget(hostUrlRaw) : null;
  const key = cacheKey(hostUrl, model);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let num_ctx = null;
  let source = 'fallback';
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

  if (!num_ctx) {
    const profile = await fromContextProfile(model, hostUrl);
    if (profile) {
      num_ctx = profile.num_ctx;
      source = profile.source;
      profileMeta = profile;
    }
  }

  if (!num_ctx) {
    const reg = await fromRegistry(model);
    if (reg) {
      num_ctx = reg.num_ctx;
      source = reg.source;
    }
  }

  if (!num_ctx && maxContextLength) {
    num_ctx = maxContextLength;
    source = 'model_capacity';
  }

  if (!num_ctx) {
    num_ctx = 8192;
    source = 'fallback';
  }

  const value = {
    model,
    host: hostUrl,
    num_ctx,
    source,
    ...(pinMeta?.pinnedModel ? { pinnedModel: pinMeta.pinnedModel } : {}),
    ...(pinMeta?.hostDisplayName ? { hostDisplayName: pinMeta.hostDisplayName } : {}),
    ...(profileMeta?.verifiedMaxContext ? { verifiedMaxContext: profileMeta.verifiedMaxContext } : {}),
    ...(profileMeta?.stressCeiling ? { stressCeiling: profileMeta.stressCeiling } : {}),
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

'use strict';

const DEFAULT_PUBLIC_URLS = Object.freeze({
  core: 'http://localhost:3080',
  benchmark: 'http://localhost:3081',
  rag: 'http://localhost:3082',
});

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizePublicUrls(source = {}, defaults = DEFAULT_PUBLIC_URLS) {
  return Object.fromEntries(Object.keys(DEFAULT_PUBLIC_URLS).map((key) => [
    key,
    normalizeUrl(source[key] || defaults[key] || ''),
  ]));
}

function getPublicUrls(env = process.env) {
  return normalizePublicUrls({
    core: env.CORE_PUBLIC_URL,
    benchmark: env.BENCHMARK_PUBLIC_URL,
    rag: env.RAG_PUBLIC_URL,
  });
}

function mergePublicUrls(fallback, authority) {
  const merged = { ...normalizePublicUrls(fallback) };
  const normalizedAuthority = normalizePublicUrls(authority, {});
  for (const [key, value] of Object.entries(normalizedAuthority)) {
    if (value) merged[key] = value;
  }
  return merged;
}

/**
 * Resolve Core's browser contract for a composed service. The returned
 * function yields `publicUrls`; its `resolveNavigation` companion yields the
 * validated trusted runtime launchers from the same cached `/api/config`
 * payload, so Benchmark and RAG render exactly the launchers Core renders.
 * Standalone services (no loader) keep environment defaults and no launchers.
 */
function createCorePublicUrlsResolver(options = {}) {
  const env = options.env || process.env;
  const fallback = getPublicUrls(env);
  const loadCoreConfig = options.loadCoreConfig;
  const ttlMs = Number(options.ttlMs || 30_000);
  const timeoutMs = Number(options.timeoutMs || 2_000);
  const enabled = options.enabled !== false && typeof loadCoreConfig === 'function';
  const { normalizeTrustedRuntimeNavItems } = require('./trustedRuntimeNavigation');
  let cached = fallback;
  let cachedNavigation = Object.freeze([]);
  let expiresAt = 0;
  let inFlight = null;

  async function refresh() {
    if (!enabled) return cached;
    const requestOptions = {};
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      requestOptions.signal = AbortSignal.timeout(timeoutMs);
    }
    const payload = await loadCoreConfig(requestOptions);
    cached = mergePublicUrls(fallback, payload?.publicUrls || {});
    cachedNavigation = normalizeTrustedRuntimeNavItems(payload?.navigation?.trustedRuntimeNavItems);
    expiresAt = Date.now() + ttlMs;
    return cached;
  }

  async function resolvePublicUrls() {
    if (!enabled || Date.now() < expiresAt) return cached;
    if (!inFlight) {
      inFlight = refresh()
        .catch(() => {
          expiresAt = Date.now() + Math.min(ttlMs, 5_000);
          return cached;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  resolvePublicUrls.resolveNavigation = async function resolveNavigation() {
    await resolvePublicUrls();
    return cachedNavigation;
  };

  return resolvePublicUrls;
}

module.exports = {
  DEFAULT_PUBLIC_URLS,
  createCorePublicUrlsResolver,
  getPublicUrls,
  mergePublicUrls,
  normalizePublicUrls,
  normalizeUrl,
};

'use strict';

const DEFAULT_PUBLIC_URLS = Object.freeze({
  core: 'http://localhost:3080',
  benchmark: 'http://localhost:3081',
  rag: 'http://localhost:3082',
  data: 'http://localhost:3083',
  hermes: '',
  openclawControl: '',
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
    data: env.DATAAPI_PUBLIC_URL,
    hermes: env.HERMES_PUBLIC_URL || env.HERMES_DASHBOARD_URL,
    openclawControl: env.OPENCLAW_CONTROL_UI_PUBLIC_URL || env.OPENCLAW_GATEWAY_URL,
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

function createCorePublicUrlsResolver(options = {}) {
  const env = options.env || process.env;
  const fallback = getPublicUrls(env);
  const fetchImpl = options.fetchImpl || global.fetch;
  const coreServiceBase = normalizeUrl(
    options.coreServiceUrl || env.CORE_URL || env.CORE_PROXY_URL || ''
  );
  const ttlMs = Number(options.ttlMs || 30_000);
  const timeoutMs = Number(options.timeoutMs || 2_000);
  const enabled = options.enabled !== false && Boolean(coreServiceBase && fetchImpl);
  let cached = fallback;
  let expiresAt = 0;
  let inFlight = null;

  async function refresh() {
    if (!enabled) return cached;
    const requestOptions = { headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      requestOptions.signal = AbortSignal.timeout(timeoutMs);
    }
    const response = await fetchImpl(`${coreServiceBase}/api/config`, requestOptions);
    if (!response.ok) throw new Error(`Core public URL authority returned HTTP ${response.status}`);
    const payload = await response.json();
    cached = mergePublicUrls(fallback, payload?.publicUrls || {});
    expiresAt = Date.now() + ttlMs;
    return cached;
  }

  return async function resolvePublicUrls() {
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
  };
}

module.exports = {
  DEFAULT_PUBLIC_URLS,
  createCorePublicUrlsResolver,
  getPublicUrls,
  mergePublicUrls,
  normalizePublicUrls,
  normalizeUrl,
};

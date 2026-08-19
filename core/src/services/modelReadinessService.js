const logger = require('../../config/logger');
const { getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const { normalizeModelName: canonicalNormalizeModelName } = require('../helpers/modelNameNormalization');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');

const READINESS_STAGE_ORDER = Object.freeze({
  available: 0,
  profiled: 1,
  benchmarked: 2
});

const CACHE_TTL_MS = 60 * 1000;

let readinessCache = null;
let readinessCacheTimestamp = 0;

// Canonical form for registry/profile/routing lookups. Namespaces are part of
// artifact identity; only Ollama's implicit :latest alias is normalized.
const normalizeModelName = canonicalNormalizeModelName;

function normalizeStage(stage) {
  const normalized = String(stage || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(READINESS_STAGE_ORDER, normalized)
    ? normalized
    : 'available';
}

function stageRank(stage) {
  return READINESS_STAGE_ORDER[normalizeStage(stage)] || 0;
}

function resolveTimestamp(entry) {
  return entry?.benchmarkedAt
    || entry?.profiledAt
    || null;
}

function normalizeReadinessEntry(entry, hostId = null, scope = 'missing') {
  const normalized = entry && typeof entry === 'object' ? entry : {};
  const profileDepth = normalized.profileDepth || null;
  return {
    stage: normalizeStage(normalized.stage),
    profiledAt: normalized.profiledAt || null,
    profileDepth,
    benchmarkQualified: normalized.benchmarkQualified === true,
    benchmarkedAt: normalized.benchmarkedAt || null,
    stale: normalized.stale === true,
    hostId: hostId || null,
    scope,
    isReady: ['standard', 'full'].includes(profileDepth)
      && normalized.benchmarkQualified === true
      && normalized.stale !== true
  };
}

function compareReadiness(left, right) {
  const ready = (entry) => Boolean(
    ['standard', 'full'].includes(entry?.profileDepth)
    && entry?.benchmarkQualified === true
    && entry?.stale !== true
  );
  if (ready(left) !== ready(right)) return ready(left) ? -1 : 1;

  if ((left?.stale === true) !== (right?.stale === true)) {
    return left?.stale === true ? 1 : -1;
  }

  if ((left?.benchmarkQualified === true) !== (right?.benchmarkQualified === true)) {
    return left?.benchmarkQualified === true ? -1 : 1;
  }

  const depthRank = { full: 3, standard: 2, quick: 1 };
  const depthDiff = (depthRank[right?.profileDepth] || 0) - (depthRank[left?.profileDepth] || 0);
  if (depthDiff !== 0) return depthDiff;

  const rankDiff = stageRank(right?.stage) - stageRank(left?.stage);
  if (rankDiff !== 0) return rankDiff;

  const leftTs = resolveTimestamp(left);
  const rightTs = resolveTimestamp(right);
  const leftTime = leftTs ? new Date(leftTs).getTime() : 0;
  const rightTime = rightTs ? new Date(rightTs).getTime() : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;

  return 0;
}

function getConfiguredHostMap() {
  return new Map(getConfiguredHosts().map((host) => [host.id, host]));
}

function resolveHostId(hostRef) {
  if (!hostRef) return null;

  const configuredHosts = getConfiguredHostMap();
  const raw = String(hostRef).trim();
  if (!raw) return null;
  if (configuredHosts.has(raw)) return raw;

  const normalized = normalizeHostUrl(raw);
  if (!normalized) return null;

  for (const [hostId, host] of configuredHosts.entries()) {
    if (normalizeHostUrl(host.url) === normalized) return hostId;
  }

  return null;
}

function mapToObject(store) {
  if (!store) return {};
  if (store instanceof Map) return Object.fromEntries(store.entries());
  return store;
}

function getBestReadiness(readinessStore) {
  const entries = Object.entries(mapToObject(readinessStore || {}));
  if (entries.length === 0) {
    return normalizeReadinessEntry(null, null, 'missing');
  }

  const normalizedEntries = entries.map(([hostId, entry]) =>
    normalizeReadinessEntry(entry, hostId, 'host')
  );

  normalizedEntries.sort(compareReadiness);
  return {
    ...normalizedEntries[0],
    scope: 'best'
  };
}

function getHostReadiness(readinessStore, hostId) {
  if (!hostId) return normalizeReadinessEntry(null, null, 'missing');

  const store = mapToObject(readinessStore || {});
  return normalizeReadinessEntry(store[hostId], hostId, store[hostId] ? 'host' : 'missing');
}

async function loadReadinessIndex(options = {}) {
  const useCache = options.useCache !== false;
  if (
    useCache &&
    readinessCache &&
    (Date.now() - readinessCacheTimestamp) < CACHE_TTL_MS
  ) {
    return readinessCache;
  }

  try {
    const client = options.benchmarkClient || getBenchmarkServiceClient();
    const docs = Array.isArray(options.profiles)
      ? options.profiles
      : await client.getReadinessProfiles();

    const index = new Map();
    docs.forEach((doc) => {
      const normalizedName = normalizeModelName(doc?.name);
      if (!normalizedName) return;
      index.set(normalizedName, {
        name: normalizedName,
        readiness: mapToObject(doc?.readiness || {}),
        bestReadiness: getBestReadiness(doc?.readiness || {})
      });
    });

    readinessCache = index;
    readinessCacheTimestamp = Date.now();
    return index;
  } catch (error) {
    logger.warn('Failed to load model readiness index', { error: error.message });
    return new Map();
  }
}

async function getModelReadiness(modelName, hostRef = null, options = {}) {
  const normalizedName = normalizeModelName(modelName);
  if (!normalizedName) {
    return {
      readiness: normalizeReadinessEntry(null, resolveHostId(hostRef), 'missing'),
      bestReadiness: normalizeReadinessEntry(null, null, 'missing')
    };
  }

  const index = await loadReadinessIndex(options);
  const entry = index.get(normalizedName);
  if (!entry) {
    return {
      readiness: normalizeReadinessEntry(null, resolveHostId(hostRef), 'missing'),
      bestReadiness: normalizeReadinessEntry(null, null, 'missing')
    };
  }

  const hostId = resolveHostId(hostRef);
  const readiness = hostId
    ? getHostReadiness(entry.readiness, hostId)
    : { ...entry.bestReadiness };

  return {
    readiness,
    bestReadiness: { ...entry.bestReadiness }
  };
}

function clearReadinessCache() {
  readinessCache = null;
  readinessCacheTimestamp = 0;
}

module.exports = {
  normalizeModelName,
  normalizeStage,
  stageRank,
  compareReadiness,
  resolveHostId,
  loadReadinessIndex,
  getModelReadiness,
  getBestReadiness,
  getHostReadiness,
  clearReadinessCache,
  _normalizeReadinessEntry: normalizeReadinessEntry
};

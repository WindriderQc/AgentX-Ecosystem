/**
 * Benchmark Service Client
 *
 * HTTP client for cross-service calls to agentx-benchmark (port 3081).
 *
 * Features:
 *   - TTL-based in-memory cache (default 5 min) for recommendations
 *   - Graceful degradation when benchmark is offline (stale cache or []).
 *   - Singleton via getBenchmarkServiceClient()
 *
 * Fetch plumbing (URL building, timeout, error handling) is delegated to
 * `helpers/crossServiceClient`.
 */

const logger = require('../../config/logger');
const {
  CrossServiceClientError,
  requestJson: coreRequestJson
} = require('../helpers/crossServiceClient');

const DEFAULT_BENCHMARK_URL = 'http://localhost:3081';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 5000;       // 5 s per request

class BenchmarkServiceClientError extends CrossServiceClientError {
  constructor(message, { status = 500, code = 'BENCHMARK_SERVICE_ERROR', body = null, cause = null } = {}) {
    super(message, { service: 'benchmark', status, code, body, cause });
    this.name = 'BenchmarkServiceClientError';
  }
}

function getBaseUrl() {
  return process.env.BENCHMARK_SERVICE_URL || DEFAULT_BENCHMARK_URL;
}

class BenchmarkServiceClient {
  constructor() {
    // Map<cacheKey, { data, ts }>
    this._cache = new Map();
  }

  async _getEvidence(path, query = {}) {
    return coreRequestJson({
      baseUrl: getBaseUrl(),
      path,
      method: 'GET',
      query,
      timeoutMs: FETCH_TIMEOUT_MS,
      serviceName: 'benchmark',
      errorCode: 'BENCHMARK_EVIDENCE_ERROR',
      onFailure: ({ status, message, url }) => {
        logger.warn('Benchmark evidence unavailable', { status, url, error: message });
        return null;
      }
    });
  }

  /** Read Benchmark-owned host and model evidence without sharing Mongo schemas. */
  async getInferenceEvidence(modelName, hostUrl) {
    if (!modelName || !hostUrl) return null;
    const json = await this._getEvidence(
      `/api/profiler/evidence/inference/${encodeURIComponent(modelName)}`,
      { hostUrl }
    );
    return json?.data || null;
  }

  /** Resolve a Benchmark-owned host identity for exact-artifact qualification. */
  async getHostProfile(hostUrl) {
    if (!hostUrl) return null;
    const json = await this._getEvidence('/api/profiler/evidence/host', { hostUrl });
    return json?.data?.hostProfile || null;
  }

  /** Fetch the compact readiness roster used by Core's model catalog cache. */
  async getReadinessProfiles() {
    const json = await this._getEvidence('/api/profiler/evidence/readiness');
    return Array.isArray(json?.data?.profiles) ? json.data.profiles : [];
  }

  /** Fetch one exact-artifact context profile owned by Benchmark. */
  async getContextProfile(modelName, { hostUrl, artifactDigest, runtimeFingerprint } = {}) {
    if (!modelName || !hostUrl || !artifactDigest || !runtimeFingerprint) return null;
    const json = await this._getEvidence(
      `/api/profiler/evidence/context/${encodeURIComponent(modelName)}`,
      { hostUrl, artifactDigest, runtimeFingerprint }
    );
    return json?.data?.contextProfile || null;
  }

  /**
   * Fetch recommendations for a prompt category.
   *
   * @param {string}  category    - Required prompt category (coding, reasoning, etc.)
   * @param {Object}  [opts]
   * @param {string}  [opts.host]        - Optional host filter
   * @param {number}  [opts.min_quality] - Optional minimum score
   * @param {boolean} [opts.skipCache]   - Force fresh fetch
   * @returns {Promise<Array>} recommendations array (may be empty)
   */
  async getRecommendations(category, opts = {}) {
    if (!category) return [];

    const cacheKey = `rec:${category}:${opts.host || ''}:${opts.min_quality || ''}`;

    // Serve from cache unless caller opts out
    if (!opts.skipCache) {
      const cached = this._cache.get(cacheKey);
      if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
        return cached.data;
      }
    }

    const query = { category };
    if (opts.host) query.host = opts.host;
    if (opts.min_quality != null) query.min_quality = String(opts.min_quality);

    const json = await coreRequestJson({
      baseUrl: getBaseUrl(),
      path: '/api/benchmark/recommend',
      method: 'GET',
      query,
      timeoutMs: FETCH_TIMEOUT_MS,
      serviceName: 'benchmark',
      errorCode: 'BENCHMARK_SERVICE_ERROR',
      onFailure: ({ reason, status, message, url }) => {
        if (reason === 'non-ok') {
          logger.warn('Benchmark recommend returned error', { status, url });
        } else {
          logger.warn('Benchmark service unreachable', { url, error: message });
        }
        return null;
      }
    });

    if (json === null) {
      const stale = this._cache.get(cacheKey);
      return stale ? stale.data : [];
    }

    const recommendations = json?.data?.recommendations || [];

    // Update cache
    this._cache.set(cacheKey, { data: recommendations, ts: Date.now() });

    return recommendations;
  }

  /**
   * Fetch judge-drift snapshot from benchmark service (0129 calibration loop).
   *
   * Returns the raw drift payload produced by benchmark's
   * GET /api/benchmark/drift — overall_status, per-category ρ vs baseline,
   * triggered reasons, thresholds. Degrades gracefully: when benchmark is
   * unreachable or returns non-OK, we return `null` (caller renders a muted
   * "unavailable" cell). No caching — drift is already cheap on the benchmark
   * side and the nerve center polls on a 30 s cadence.
   *
   * @param {Object}  [opts]
   * @param {number}  [opts.perCategory] - Override sample size per category.
   * @returns {Promise<Object|null>} drift payload or null when unreachable.
   */
  async getJudgeDrift(opts = {}) {
    const query = {};
    if (opts.perCategory != null) query.per_category = String(opts.perCategory);

    const json = await coreRequestJson({
      baseUrl: getBaseUrl(),
      path: '/api/benchmark/drift',
      method: 'GET',
      query,
      timeoutMs: FETCH_TIMEOUT_MS,
      serviceName: 'benchmark',
      errorCode: 'BENCHMARK_SERVICE_ERROR',
      onFailure: ({ reason, status, message, url }) => {
        if (reason === 'non-ok') {
          logger.warn('Benchmark drift returned error', { status, url });
        } else {
          logger.warn('Benchmark drift unreachable', { url, error: message });
        }
        return null;
      }
    });

    if (json === null) return null;
    return json?.data || null;
  }

  /**
   * Fetch a benchmark batch by id.
   *
   * Used by Core's benchmark-claim reaper to free host claims as soon as
   * Engine Room marks a batch terminal, instead of waiting for duration-based
   * stale-claim expiry.
   *
   * @param {string} batchId
   * @returns {Promise<Object|null>}
   */
  async getBatch(batchId) {
    if (!batchId) return null;

    const json = await coreRequestJson({
      baseUrl: getBaseUrl(),
      path: `/api/benchmark/batch/${encodeURIComponent(batchId)}`,
      method: 'GET',
      timeoutMs: FETCH_TIMEOUT_MS,
      serviceName: 'benchmark',
      errorCode: 'BENCHMARK_SERVICE_ERROR',
      onFailure: ({ reason, status, message, url }) => {
        if (reason === 'non-ok') {
          logger.warn('Benchmark batch lookup returned error', { status, url, batchId });
        } else {
          logger.warn('Benchmark batch lookup unreachable', { url, batchId, error: message });
        }
        return null;
      }
    });

    if (json === null) return null;
    return json?.data || null;
  }

  /**
   * List recent batches, optionally narrowed by an exact Benchmark-owned tag.
   * Returns null when Benchmark is unavailable so Planning can preserve last-good data.
   */
  async getBatches({ limit = 20, status = '', tag = '' } = {}) {
    const query = { limit: Math.max(1, Math.min(Number(limit) || 20, 100)) };
    if (status) query.status = status;
    if (tag) query.tag = tag;

    const json = await coreRequestJson({
      baseUrl: getBaseUrl(),
      path: '/api/benchmark/batches',
      method: 'GET',
      query,
      timeoutMs: FETCH_TIMEOUT_MS,
      serviceName: 'benchmark',
      errorCode: 'BENCHMARK_SERVICE_ERROR',
      onFailure: ({ status: responseStatus, message, url }) => {
        logger.warn('Benchmark batch list unavailable', { status: responseStatus, url, error: message });
        return null;
      }
    });

    if (json === null) return null;
    return json?.data || null;
  }

  /**
   * Fetch the confidence-weighted generalist leaderboard. Trust scope is fixed
   * here so callers cannot accidentally use exploratory scores as evidence.
   */
  async getTrustedGeneralistLeaderboard({ hostScope = 'current' } = {}) {
    const json = await coreRequestJson({
      baseUrl: getBaseUrl(),
      path: '/api/benchmark/generalist-leaderboard',
      method: 'GET',
      query: {
        axis: 'composite',
        trustScope: 'trusted',
        hostScope,
        includeUnavailableModels: 'true'
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      serviceName: 'benchmark',
      errorCode: 'BENCHMARK_SERVICE_ERROR',
      onFailure: ({ status, message, url }) => {
        logger.warn('Trusted Benchmark leaderboard unavailable', { status, url, error: message });
        return null;
      }
    });

    if (json === null) return null;
    return json?.data || null;
  }

  /**
   * Get all available categories with their top recommendation.
   * Useful for showing a summary of all categories at once.
   * @returns {Promise<Object>} { category: recommendations[] }
   */
  async getAllCategoryRecommendations() {
    const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
    const result = {};

    const fetches = await Promise.allSettled(
      categories.map(cat => this.getRecommendations(cat))
    );

    fetches.forEach((res, i) => {
      result[categories[i]] = res.status === 'fulfilled' ? res.value : [];
    });

    return result;
  }

  /** Clear internal cache (useful for testing) */
  clearCache() {
    this._cache.clear();
  }
}

let client = null;
function getBenchmarkServiceClient() {
  if (!client) client = new BenchmarkServiceClient();
  return client;
}

module.exports = {
  BenchmarkServiceClient,
  BenchmarkServiceClientError,
  getBenchmarkServiceClient
};

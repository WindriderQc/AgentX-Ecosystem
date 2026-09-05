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
  async getInferenceEvidence(modelName, hostUrl, artifact = {}) {
    if (!modelName || !hostUrl) return null;
    const query = { hostUrl };
    if (artifact.hostId && artifact.digest && artifact.runtimeFingerprint) {
      query.hostId = artifact.hostId;
      query.artifactDigest = artifact.digest;
      query.runtimeFingerprint = artifact.runtimeFingerprint;
    }
    const json = await this._getEvidence(
      `/api/profiler/evidence/inference/${encodeURIComponent(modelName)}`,
      query
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
  async getRecommendationView(category, opts = {}) {
    if (!category) return { category: null, trustVerdict: null, recommendations: [] };
    const trustScope = String(opts.trustScope || '').trim().toLowerCase();
    if (!['trusted', 'exploratory'].includes(trustScope)) {
      throw new BenchmarkServiceClientError(
        'trustScope must be explicitly set to trusted or exploratory',
        { status: 400, code: 'TRUST_SCOPE_REQUIRED' }
      );
    }

    const cacheKey = `rec:${trustScope}:${category}:${opts.host || ''}:${opts.min_quality || ''}`;

    // Serve from cache unless caller opts out
    if (!opts.skipCache) {
      const cached = this._cache.get(cacheKey);
      if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
        return cached.data;
      }
    }

    const query = { category, trustScope };
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
      if (!stale) return { category, trustScope, status: 'unreachable', trustVerdict: null, recommendations: [] };
      return {
        ...stale.data,
        status: 'stale',
        trustVerdict: stale.data?.trustVerdict ? {
          ...stale.data.trustVerdict,
          state: 'stale',
          comparable: false,
          qualified: false,
          highConfidenceAllowed: false,
          claim: 'no_qualified_winner',
          qualifiedWinner: null,
          reasons: [...new Set([...(stale.data.trustVerdict.reasons || []), 'stale_cache'])]
        } : null,
        recommendations: (stale.data?.recommendations || []).map((row) => ({
          ...row,
          confidence: 'low',
          evidence_level: 'stale',
          qualified: false
        }))
      };
    }

    const upstreamData = json?.data || {};
    const trustVerdict = upstreamData.trustVerdict || null;
    const phase0Projection = !trustVerdict
      || trustVerdict.contract === 'agentx.benchmark-consumer-trust/v1';
    const view = {
      category,
      trustScope,
      ...upstreamData,
      recommendations: (upstreamData.recommendations || []).map((row) => ({
        ...row,
        confidence: phase0Projection && row.confidence === 'high'
          ? (trustVerdict?.state === 'trusted' ? 'medium' : 'low')
          : row.confidence,
        evidence_level: trustVerdict?.state || row.evidence_level || 'inconclusive',
        qualified: phase0Projection ? false : row.qualified === true
      }))
    };

    // Update cache
    this._cache.set(cacheKey, { data: view, ts: Date.now() });

    return view;
  }

  async getRecommendations(category, opts = {}) {
    const view = await this.getRecommendationView(category, opts);
    return view.recommendations || [];
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
  async getAllCategoryRecommendations({ trustScope } = {}) {
    if (!['trusted', 'exploratory'].includes(String(trustScope || '').toLowerCase())) {
      throw new BenchmarkServiceClientError(
        'trustScope must be explicitly set to trusted or exploratory',
        { status: 400, code: 'TRUST_SCOPE_REQUIRED' }
      );
    }
    const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
    const result = {};

    const fetches = await Promise.allSettled(
      categories.map(cat => this.getRecommendationView(cat, { trustScope }))
    );

    fetches.forEach((res, i) => {
      result[categories[i]] = res.status === 'fulfilled'
        ? res.value
        : { category: categories[i], trustScope, status: 'unavailable', trustVerdict: null, recommendations: [] };
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

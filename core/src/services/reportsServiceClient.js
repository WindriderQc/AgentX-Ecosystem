/**
 * Reports Service Client
 *
 * Thin HTTP client for cross-service calls needed by report aggregation endpoints.
 * Covers the product-owned Benchmark (3081) and RAG (3082) services.
 *
 * Key design principle: ALL methods degrade gracefully — they return null instead
 * of throwing when a service is unreachable. Report endpoints must be able to
 * return partial data when some services are down.
 *
 * Fetch plumbing (URL building, timeout, envelope unwrap, error handling) is
 * delegated to `helpers/crossServiceClient`. This file keeps only the per-report
 * endpoint wrappers and the graceful-degradation policy (onFailure → null +
 * warn log).
 */

const logger = require('../../config/logger');
const { requestJson: coreRequestJson } = require('../helpers/crossServiceClient');

const DEFAULT_BENCHMARK_URL = 'http://localhost:3081';
const DEFAULT_RAG_URL       = 'http://localhost:3082';
const FETCH_TIMEOUT_MS      = 5000;

class ReportsServiceClientError extends Error {
  constructor(message, { status = 500, code = 'REPORTS_SERVICE_ERROR' } = {}) {
    super(message);
    this.name   = 'ReportsServiceClientError';
    this.status = status;
    this.code   = code;
  }
}

function sanitizeEnvUrl(raw, fallback) {
  // Guard against env vars that were restored to literal string 'undefined'
  // (a common pre-existing test hygiene bug) or accidental empty strings.
  if (!raw || raw === 'undefined' || raw === 'null') return fallback;
  return raw;
}

function getBenchmarkBaseUrl() {
  return sanitizeEnvUrl(process.env.BENCHMARK_SERVICE_URL, DEFAULT_BENCHMARK_URL);
}

function getRagBaseUrl() {
  return sanitizeEnvUrl(process.env.RAG_SERVICE_URL, DEFAULT_RAG_URL);
}

function requireTrustScope(trustScope) {
  const normalized = String(trustScope || '').trim().toLowerCase();
  if (!['trusted', 'exploratory'].includes(normalized)) {
    throw new ReportsServiceClientError(
      'trustScope must be explicitly set to trusted or exploratory',
      { status: 400, code: 'TRUST_SCOPE_REQUIRED' }
    );
  }
  return normalized;
}

function unwrapServiceEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.status === 'success' && 'data' in parsed) return parsed.data;
  if (parsed.ok === true && 'data' in parsed) return parsed.data;
  return parsed;
}

/**
 * GET the given path on `baseUrl`, unwrap common service envelopes, and return
 * null on any failure (connection, non-2xx, parse). Mirrors the behaviour of
 * the legacy hand-rolled `fetchJson`.
 */
function fetchJson(baseUrl, path) {
  return coreRequestJson({
    baseUrl,
    path,
    method: 'GET',
    timeoutMs: FETCH_TIMEOUT_MS,
    serviceName: 'reports-downstream',
    unwrap: unwrapServiceEnvelope,
    onFailure: ({ reason, status, message }) => {
      if (reason === 'non-ok') {
        logger.warn('Reports service client: non-OK response', { url: `${baseUrl}${path}`, status });
      } else if (reason === 'timeout') {
        logger.warn('Reports service client: timeout', { url: `${baseUrl}${path}`, message });
      } else {
        logger.warn('Reports service client: connection error', { url: `${baseUrl}${path}`, error: message });
      }
      return null;
    }
  });
}

class ReportsServiceClient {

  // ─── Benchmark (port 3081) ──────────────────────────────────────────────────

  /** GET /api/benchmark/summary */
  async fetchBenchmarkAnalyticsSummary() {
    return fetchJson(getBenchmarkBaseUrl(), '/api/benchmark/summary');
  }

  /** GET /api/benchmark/trends */
  async fetchBenchmarkTrends() {
    return fetchJson(getBenchmarkBaseUrl(), '/api/benchmark/trends');
  }

  /** GET /api/benchmark/generalist-leaderboard */
  async fetchBenchmarkLeaderboard({ trustScope } = {}) {
    const scope = requireTrustScope(trustScope);
    return fetchJson(
      getBenchmarkBaseUrl(),
      `/api/benchmark/generalist-leaderboard?axis=composite&hostScope=current&includeUnavailableModels=true&trustScope=${scope}`
    );
  }

  /** GET /api/benchmark/recommend — returns top recommendations per category */
  async fetchBenchmarkRecommendations({ trustScope } = {}) {
    const scope = requireTrustScope(trustScope);
    const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
    const views = await Promise.all(categories.map((category) => fetchJson(
      getBenchmarkBaseUrl(),
      `/api/benchmark/recommend?category=${encodeURIComponent(category)}&trustScope=${scope}`
    )));
    return {
      trustScope: scope,
      categories: Object.fromEntries(categories.map((category, index) => [category, views[index]])),
      recommendations: views.flatMap((view) => (view?.recommendations || []).slice(0, 1))
    };
  }

  /** GET /api/profiler/dashboard */
  async fetchProfilerDashboard() {
    return fetchJson(getBenchmarkBaseUrl(), '/api/profiler/dashboard');
  }

  // ─── RAG (port 3082) ────────────────────────────────────────────────────────

  /** GET /api/rag/status */
  async fetchRagStatus() {
    return fetchJson(getRagBaseUrl(), '/api/rag/status');
  }

  /** GET /api/rag/metrics */
  async fetchRagMetrics() {
    return fetchJson(getRagBaseUrl(), '/api/rag/metrics');
  }

}

let client = null;
function getReportsServiceClient() {
  if (!client) client = new ReportsServiceClient();
  return client;
}

module.exports = {
  ReportsServiceClient,
  ReportsServiceClientError,
  getReportsServiceClient
};

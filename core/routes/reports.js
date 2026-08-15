/**
 * Reports Routes
 *
 * Provides compiled report endpoints for operational visibility.
 * Current routes:
 *   GET /morning-brief — daily ops summary (alerts, analytics, performance)
 *
 * Future routes (added by subsequent tasks):
 *   GET /daily-digest
 *   GET /weekly-review
 *   GET /system-status
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const Alert = require('../models/Alert');
const Conversation = require('../models/Conversation');
const InferenceLog = require('../models/InferenceLog');
const { getReportsServiceClient } = require('../src/services/reportsServiceClient');
const planningReviewService = require('../src/services/planningReviewService');
const memoryReviewService = require('../src/services/memoryReview/memoryReviewService');

// Wall-clock cap for every Mongo operation in this file. If the DB is slow or
// an aggregation is unindexed, Mongoose throws instead of hanging — safe()
// converts the error to a fallback payload. Without this, a single slow
// $size:'$messages' scan on Conversation can hang the endpoint for an hour
// (observed 2026-04-17 on morning-briefing cron).
const DB_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses a period string like "24h" or "7d" into milliseconds.
 * Defaults to 24 hours if the string is unrecognised.
 * @param {string} period
 * @returns {number} milliseconds
 */
function parsePeriod(period) {
  if (!period || typeof period !== 'string') return 24 * 60 * 60 * 1000;

  const match = period.match(/^(\d+)(h|d)$/i);
  if (!match) return 24 * 60 * 60 * 1000;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;

  return 24 * 60 * 60 * 1000;
}

/**
 * Runs an async function and returns the fallback value on any error.
 * Used to give morning-brief partial-failure tolerance.
 * @param {Function} fn - async function to run
 * @param {*} fallback - value returned on error
 * @returns {Promise<*>}
 */
async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger.warn('[reports] safe() caught error:', err.message);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

/**
 * Gathers alert counts and a recent sample for the given time window.
 * @param {Date} since
 * @returns {Promise<{active:number, critical:number, warning:number, recent:Array}>}
 */
async function gatherAlerts(since) {
  const baseFilter = { status: 'active', createdAt: { $gte: since } };

  const [active, critical, warning, recent] = await Promise.all([
    Alert.countDocuments(baseFilter).maxTimeMS(DB_TIMEOUT_MS),
    Alert.countDocuments({ ...baseFilter, severity: 'critical' }).maxTimeMS(DB_TIMEOUT_MS),
    Alert.countDocuments({ ...baseFilter, severity: 'warning' }).maxTimeMS(DB_TIMEOUT_MS),
    Alert.find(baseFilter).sort({ createdAt: -1 }).limit(5).maxTimeMS(DB_TIMEOUT_MS).lean()
  ]);

  return { active, critical, warning, recent };
}

/**
 * Gathers conversation and message counts plus total cost for the window.
 * @param {Date} since
 * @returns {Promise<{conversations:number, messages:number, cost_usd:number}>}
 */
async function gatherAnalytics(since) {
  const match = { createdAt: { $gte: since } };

  const [conversations, agg] = await Promise.all([
    Conversation.countDocuments(match).maxTimeMS(DB_TIMEOUT_MS),
    Conversation.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          messages: { $sum: { $size: '$messages' } },
          totalCost: { $sum: { $ifNull: ['$totalCost.sum', 0] } }
        }
      }
    ]).option({ maxTimeMS: DB_TIMEOUT_MS })
  ]);

  const row = agg[0] || {};
  return {
    conversations,
    messages: row.messages || 0,
    cost_usd: row.totalCost != null ? parseFloat(row.totalCost.toFixed(4)) : 0
  };
}

/**
 * Gathers inference performance metrics for the window.
 * @param {Date} since
 * @returns {Promise<{avg_latency_ms:number, requests:number, error_rate:number}>}
 */
async function gatherPerformance(since) {
  const agg = await InferenceLog.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: null,
        avgLatency: { $avg: '$durationMs' },
        count: { $sum: 1 },
        errors: {
          $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] }
        }
      }
    }
  ]).option({ maxTimeMS: DB_TIMEOUT_MS });

  const row = agg[0];
  if (!row) return { avg_latency_ms: 0, requests: 0, error_rate: 0 };

  const errorRate = row.count > 0
    ? parseFloat((row.errors / row.count).toFixed(4))
    : 0;

  return {
    avg_latency_ms: Math.round(row.avgLatency || 0),
    requests: row.count,
    error_rate: errorRate
  };
}

// ---------------------------------------------------------------------------
// Summary composer
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable one-liner from gathered report data.
 * @param {object} alerts
 * @param {object} analytics
 * @param {object} performance
 * @returns {string}
 */
function composeMorningBriefSummary(alerts, analytics, performance, memoryReview) {
  const parts = [];

  if (alerts && !alerts.error) {
    if (alerts.critical > 0) {
      parts.push(`${alerts.critical} critical alert${alerts.critical !== 1 ? 's' : ''}.`);
    } else if (alerts.warning > 0) {
      parts.push(`${alerts.warning} warning${alerts.warning !== 1 ? 's' : ''}.`);
    } else {
      parts.push('No active alerts.');
    }
  }

  if (analytics && !analytics.error) {
    const cost = analytics.cost_usd > 0 ? ` ($${analytics.cost_usd.toFixed(2)})` : '';
    parts.push(`${analytics.messages} messages processed${cost}.`);
  }

  if (performance && !performance.error) {
    parts.push(`Avg latency ${performance.avg_latency_ms}ms.`);
  }

  if (memoryReview && !memoryReview.error && memoryReview.pending > 0) {
    parts.push(`${memoryReview.pending} Dreaming candidate${memoryReview.pending === 1 ? '' : 's'} awaiting review.`);
  }
  if (memoryReview && !memoryReview.error && memoryReview.attention) {
    parts.push('Dreaming reconciliation needs attention.');
  }

  return parts.join(' ') || 'No data available.';
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /morning-brief
 *
 * Returns a compiled morning operations brief.
 * Query params:
 *   - period (string, default "24h") — e.g. "24h", "12h", "7d"
 */
router.get('/morning-brief', async (req, res) => {
  const { period = '24h' } = req.query;
  const ms = parsePeriod(period);
  const since = new Date(Date.now() - ms);

  const alertFallback = { active: 0, critical: 0, warning: 0, recent: [], error: 'unavailable' };
  const analyticsFallback = { conversations: 0, messages: 0, cost_usd: 0, error: 'unavailable' };
  const performanceFallback = { avg_latency_ms: 0, requests: 0, error_rate: 0, error: 'unavailable' };
  const memoryReviewFallback = { runId: null, pending: 0, total: 0, attention: false, error: 'unavailable' };

  const [alerts, analytics, performance, memoryReview] = await Promise.all([
    safe(() => gatherAlerts(since), alertFallback),
    safe(() => gatherAnalytics(since), analyticsFallback),
    safe(() => gatherPerformance(since), performanceFallback),
    safe(() => memoryReviewService.buildDigest({ includeStatements: false }), memoryReviewFallback)
  ]);

  const summary = composeMorningBriefSummary(alerts, analytics, performance, memoryReview);

  logger.info(`[reports] morning-brief generated (period=${period})`);

  res.json({
    status: 'success',
    data: {
      report: 'morning-brief',
      generated: new Date().toISOString(),
      period,
      alerts,
      analytics,
      performance,
      memoryReview,
      summary
    }
  });
});

/**
 * Gathers cost breakdown by model for the given time window.
 * @param {Date} since
 * @returns {Promise<Array<{model:string, cost:number, messages:number}>>}
 */
async function gatherCostByModel(since) {
  const rows = await Conversation.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$model',
        cost: { $sum: { $ifNull: ['$totalCost.sum', 0] } },
        messages: { $sum: { $size: '$messages' } }
      }
    },
    { $sort: { cost: -1 } },
    { $limit: 10 }
  ]).option({ maxTimeMS: DB_TIMEOUT_MS });

  return rows.map(r => ({
    model: r._id || 'unknown',
    cost: parseFloat((r.cost || 0).toFixed(4)),
    messages: r.messages || 0
  }));
}

// ---------------------------------------------------------------------------
// Daily digest summary composer
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable summary from all daily-digest sections.
 * @param {object} analytics
 * @param {object} performance
 * @param {object|null} benchmark
 * @param {object|null} rag
 * @returns {string}
 */
function composeDailyDigestSummary(analytics, performance, benchmark, rag) {
  const parts = [];

  if (analytics && !analytics.error) {
    const cost = analytics.cost_usd > 0 ? ` ($${analytics.cost_usd.toFixed(2)})` : '';
    parts.push(`${analytics.conversations} conversation${analytics.conversations !== 1 ? 's' : ''}, ${analytics.messages} messages${cost}.`);
  }

  if (performance && !performance.error) {
    parts.push(`Avg latency ${performance.avg_latency_ms}ms, error rate ${(performance.error_rate * 100).toFixed(1)}%.`);
  }

  if (benchmark && benchmark.status !== 'unreachable') {
    const topEntry = Array.isArray(benchmark.leaderboard) ? benchmark.leaderboard[0] : null;
    const topModel = benchmark.top_model || benchmark.topModel || topEntry?.model || topEntry?.name || null;
    const score = topEntry?.generalistScore ?? topEntry?.avg_quality ?? topEntry?.quality_score ?? topEntry?.score ?? null;
    const topModelText = topModel
      ? ` Top model: ${topModel}${Number.isFinite(Number(score)) ? ` (${Number(score).toFixed(1)})` : ''}.`
      : '';
    if (benchmark.batches != null) {
      parts.push(`Benchmark: ${benchmark.batches} batch${benchmark.batches !== 1 ? 'es' : ''}.${topModelText}`);
    } else if (benchmark.total_tests != null) {
      parts.push(`Benchmark: ${benchmark.total_tests} test${benchmark.total_tests !== 1 ? 's' : ''}.${topModelText}`);
    } else {
      parts.push(`Benchmark: reachable.${topModelText}`);
    }
  } else {
    parts.push('Benchmark: unreachable.');
  }

  if (rag && rag.status !== 'unreachable') {
    const ragStatus = rag.status || (rag.healthy === true ? 'healthy' : (rag.healthy === false ? 'degraded' : 'unknown'));
    const documents = rag.documents ?? rag.documentCount ?? rag.totals?.documents ?? 0;
    parts.push(`RAG: ${ragStatus}, ${documents} documents.`);
  } else {
    parts.push('RAG: unreachable.');
  }

  return parts.join(' ') || 'No data available.';
}

// ---------------------------------------------------------------------------
// Daily digest route
// ---------------------------------------------------------------------------

/**
 * GET /daily-digest
 *
 * Returns a full cross-service daily digest combining local analytics,
 * performance metrics, benchmark results, and RAG status.
 * Query params:
 *   - period (string, default "24h") — e.g. "24h", "12h", "7d"
 */
router.get('/daily-digest', async (req, res) => {
  const { period = '24h' } = req.query;
  const ms = parsePeriod(period);
  const since = new Date(Date.now() - ms);
  const svc = getReportsServiceClient();

  const analyticsFallback = { conversations: 0, messages: 0, cost_usd: 0, cost_by_model: [], error: 'unavailable' };
  const performanceFallback = { avg_latency_ms: 0, requests: 0, error_rate: 0, error: 'unavailable' };

  const [analyticsBase, costByModel, performance, benchmarkRaw, ragStatusRaw, ragMetricsRaw] = await Promise.all([
    safe(() => gatherAnalytics(since), analyticsFallback),
    safe(() => gatherCostByModel(since), []),
    safe(() => gatherPerformance(since), performanceFallback),
    safe(() => svc.fetchBenchmarkAnalyticsSummary(), null),
    safe(() => svc.fetchRagStatus(), null),
    safe(() => svc.fetchRagMetrics(), null)
  ]);

  const analytics = { ...analyticsBase, cost_by_model: costByModel };
  const benchmark = benchmarkRaw !== null ? benchmarkRaw : { status: 'unreachable' };
  const rag = (ragStatusRaw !== null || ragMetricsRaw !== null)
    ? {
        ...(ragStatusRaw || {}),
        ...(ragMetricsRaw || {}),
        documents: ragMetricsRaw?.totals?.documents ?? ragStatusRaw?.documents ?? ragStatusRaw?.documentCount ?? 0
      }
    : { status: 'unreachable' };

  const summary = composeDailyDigestSummary(analytics, performance, benchmark, rag);

  logger.info(`[reports] daily-digest generated (period=${period})`);

  res.json({
    status: 'success',
    data: {
      report: 'daily-digest',
      generated: new Date().toISOString(),
      period,
      analytics,
      performance,
      benchmark,
      rag,
      summary
    }
  });
});

// ---------------------------------------------------------------------------
// Weekly cost gathering
// ---------------------------------------------------------------------------

/**
 * Gathers total cost and message count for the given time window.
 * @param {Date} since
 * @returns {Promise<{this_period_usd:number, messages:number}>}
 */
async function gatherWeeklyCosts(since) {
  const agg = await Conversation.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        totalCost: { $sum: { $ifNull: ['$totalCost.sum', 0] } },
        messages: { $sum: { $size: '$messages' } }
      }
    }
  ]).option({ maxTimeMS: DB_TIMEOUT_MS });

  const row = agg[0] || {};
  return {
    this_period_usd: row.totalCost != null ? parseFloat(row.totalCost.toFixed(4)) : 0,
    messages: row.messages || 0
  };
}

function normalizeWeeklyArrayPayload(value, wrapperKeys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];

  for (const key of wrapperKeys) {
    if (Array.isArray(value[key])) return value[key];
  }

  return [];
}

function normalizeWeeklyTrendsPayload(value) {
  if (!value) return null;
  if (Array.isArray(value)) return { trends: value, count: value.length };
  if (typeof value !== 'object') return null;

  if (value.trends && typeof value.trends === 'object' && !Array.isArray(value.trends)) {
    return {
      ...value.trends,
      period: value.trends.period ?? value.period,
      model: value.trends.model ?? value.model
    };
  }

  if (Array.isArray(value.trends)) {
    return {
      ...value,
      count: value.trends.length
    };
  }

  return value;
}

// ---------------------------------------------------------------------------
// Weekly review summary composer
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable summary from weekly-review sections.
 * @param {object|null} benchmark
 * @param {object} costs
 * @param {object|null} profiler
 * @param {object|null} planning
 * @returns {string}
 */
function composeWeeklyReviewSummary(benchmark, costs, profiler, planning) {
  const parts = [];

  if (benchmark && benchmark.status !== 'unreachable') {
    const leaderboard = normalizeWeeklyArrayPayload(benchmark.leaderboard, ['leaderboard', 'top', 'items', 'results', 'data']);
    const trends = normalizeWeeklyTrendsPayload(benchmark.trends);
    const topModel = leaderboard[0]
      ? ` Top model: ${leaderboard[0].model || leaderboard[0].name || 'unknown'}.`
      : '';
    const trendNote = trends ? ' Trends available.' : '';
    parts.push(`Benchmark reachable.${topModel}${trendNote}`);
  } else {
    parts.push('Benchmark: unreachable.');
  }

  if (costs) {
    parts.push(`Week cost: $${(costs.this_period_usd || 0).toFixed(2)}, ${costs.messages || 0} messages.`);
  }

  if (profiler && profiler.status !== 'unreachable') {
    const healthy = profiler.hosts_healthy != null ? ` ${profiler.hosts_healthy} host${profiler.hosts_healthy !== 1 ? 's' : ''} healthy.` : '';
    parts.push(`Profiler reachable.${healthy}`);
  } else {
    parts.push('Profiler: unreachable.');
  }

  if (planning?.summary) {
    parts.push(planning.summary);
  } else {
    parts.push('Planning: unavailable.');
  }

  return parts.join(' ') || 'No data available.';
}

// ---------------------------------------------------------------------------
// Weekly review route
// ---------------------------------------------------------------------------

/**
 * GET /weekly-review
 *
 * Returns a weekly operations review combining local cost data with
 * benchmark trends, leaderboard, recommendations, and profiler status.
 * Query params:
 *   - period (string, default "7d") — e.g. "7d", "14d"
 */
router.get('/weekly-review', async (req, res) => {
  const { period = '7d' } = req.query;
  const ms = parsePeriod(period);
  const since = new Date(Date.now() - ms);
  const svc = getReportsServiceClient();

  const [costsRaw, trendsRaw, leaderboardRaw, recommendationsRaw, profilerRaw, planning] = await Promise.all([
    safe(() => gatherWeeklyCosts(since), { this_period_usd: 0, messages: 0 }),
    safe(() => svc.fetchBenchmarkTrends(), null),
    safe(() => svc.fetchBenchmarkLeaderboard(), null),
    safe(() => svc.fetchBenchmarkRecommendations(), null),
    safe(() => svc.fetchProfilerDashboard(), null),
    safe(() => planningReviewService.buildWeeklyReview({ since }), {
      status: 'unreachable',
      summary: 'Planning: unavailable.'
    })
  ]);

  const allBenchmarkNull = trendsRaw === null && leaderboardRaw === null && recommendationsRaw === null;
  const benchmark = allBenchmarkNull
    ? { status: 'unreachable' }
    : {
        trends: normalizeWeeklyTrendsPayload(trendsRaw),
        leaderboard: normalizeWeeklyArrayPayload(leaderboardRaw, ['leaderboard', 'top', 'items', 'results', 'data']),
        recommendations: normalizeWeeklyArrayPayload(recommendationsRaw, ['recommendations', 'items', 'results', 'data'])
      };

  const profiler = profilerRaw !== null ? profilerRaw : { status: 'unreachable' };
  const costs = costsRaw;

  const summary = composeWeeklyReviewSummary(benchmark, costs, profiler, planning);

  logger.info(`[reports] weekly-review generated (period=${period})`);

  res.json({
    status: 'success',
    data: {
      report: 'weekly-review',
      generated: new Date().toISOString(),
      period,
      benchmark,
      costs,
      profiler,
      planning,
      summary
    }
  });
});

// ---------------------------------------------------------------------------
// System status summary composer
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable one-liner for system-status.
 * @param {object} services — { core, benchmark, rag }
 * @returns {string}
 */
function composeSystemStatusSummary(services) {
  const names = Object.keys(services);
  const total = names.length;
  const unreachable = names.filter(n => services[n].status === 'unreachable');

  if (unreachable.length === 0) {
    return `All ${total} services operational.`;
  }

  return `${unreachable.length}/${total} services unreachable: ${unreachable.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// System status route
// ---------------------------------------------------------------------------

/**
 * GET /system-status
 *
 * Returns a live liveness check across the three product services.
 * Core is always ok (if we're responding, we're up).
 * Benchmark and RAG are pinged via the service client.
 */
router.get('/system-status', async (req, res) => {
  const svc = getReportsServiceClient();

  const [benchmarkRaw, ragRaw] = await Promise.all([
    safe(() => svc.fetchBenchmarkAnalyticsSummary(), null),
    safe(() => svc.fetchRagStatus(), null)
  ]);

  const services = {
    core:      { status: 'ok' },
    benchmark: benchmarkRaw !== null ? { ...benchmarkRaw, status: 'ok' } : { status: 'unreachable' },
    rag:       ragRaw       !== null ? { ...ragRaw,       status: 'ok' } : { status: 'unreachable' }
  };

  const summary = composeSystemStatusSummary(services);

  logger.info('[reports] system-status generated');

  res.json({
    status: 'success',
    data: {
      report: 'system-status',
      generated: new Date().toISOString(),
      services,
      summary
    }
  });
});

module.exports = router;

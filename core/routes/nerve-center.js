/**
 * Nerve Center API Routes
 *
 * Unified intelligence, routing config, failover controls,
 * Host preferences, and health feed for the Nerve Center UI.
 *
 * Nerve Center endpoints under /api/nerve-center/
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');

const {
  getAllModelsHealth,
  getFailoverStatus,
  switchHost,
  resetToPrimary
} = require('../src/services/modelRouter');

const {
  HOSTS,
  TASK_MODELS,
  buildRouterConfigPayload,
  resetTaskModelOverride,
  saveTaskModelOverride
} = require('../src/services/modelRouterConfig');
const hostPrefService = require('../src/services/hostPreferenceService');
const { modelsMatch } = require('../src/helpers/modelNameNormalization');
const alertService = require('../src/services/alertService');
const { getObservedFailoverStatus } = require('../src/services/failoverStatusService');
const { buildEcosystemSnapshot: buildProductEcosystemSnapshot } = require('../src/services/ecosystemSnapshotService');
const portalStatusService = require('../src/services/portalStatusService');
const systemHealth = require('../src/systemHealth');
const { calculateMessageCost } = require('../src/services/costCalculator');
const InferenceLog = require('../models/InferenceLog');
const {
  projectInferenceLog,
  projectInferenceLogs
} = require('../src/services/routing/inferenceLogReadProjection');
const { describeHost } = require('../src/services/hostIdentityService');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { projectHealthFeed } = require('../src/services/alertFeedProjection');
const { projectHostPreferencesForRead } = require('../src/services/hostPreferencePublicProjection');
const { requireOperatorUiAccess, operatorRequestIdentity } = require('../src/middleware/operatorAccess');
const { runRuntimeMutation } = require('../src/services/runtimeMutationLeaseService');

// ========================================
// Helpers
// ========================================

/**
 * Build the bundled intelligence summary used by the chat side panel.
 * Exported so unit tests can verify the shape without HTTP.
 */
async function buildIntelligenceSummary() {
  const [clusterHealth, failoverStatus, hostPreferences, activeAlertSnapshot, routingLog] =
    await Promise.all([
      getAllModelsHealth(),
      getObservedFailoverStatus(getFailoverStatus()),
      hostPrefService.getAll(),
      alertService.getAlertSnapshot({
        limit: 5,
        filters: { status: 'active' },
        sort: 'recency'
      }),
      InferenceLog.find()
        .sort({ timestamp: -1 })
        .limit(10)
        .lean()
    ]);

  return {
    cluster: clusterHealth,
    routing: failoverStatus,
    hostPreferences: projectHostPreferencesForRead(hostPreferences),
    alerts: activeAlertSnapshot.alerts,
    alertSummary: activeAlertSnapshot.summary,
    recentRouting: projectInferenceLogs(routingLog)
  };
}

/**
 * Return the current routing configuration as plain JSON.
 * Exported for unit-test verification.
 */
async function getRoutingConfig() {
  return buildRouterConfigPayload();
}

async function buildEcosystemSnapshot(options = {}) {
  return buildProductEcosystemSnapshot({
    buildIntelligence: buildIntelligenceSummary,
    buildRoutingConfig: getRoutingConfig,
    buildServiceStatus: options.buildServiceStatus
      || (() => portalStatusService.getPortalStatus(systemHealth)),
    now: options.now
  });
}

function resolveHostUrl(hostKey) {
  const hostUrl = HOSTS[hostKey];
  if (!hostUrl) {
    const err = new Error(`Unknown hostKey: ${hostKey}. Valid keys: ${Object.keys(HOSTS).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  return hostUrl;
}

async function buildInferenceStats(now = new Date()) {
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);

  const logs = await InferenceLog.find({
    timestamp: { $gte: startOfToday }
  }).lean();

  let totalCost = 0;
  const byCaller = {};
  const byStatus = {};
  for (const log of logs) {
    const caller = log.caller || 'unknown';
    const status = log.status || 'unknown';
    byCaller[caller] = (byCaller[caller] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    const promptTokens = log.tokensIn || 0;
    const completionTokens = log.tokensOut || 0;
    const cost = await calculateMessageCost(log.model, {
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      }
    });
    totalCost += cost.totalCost || 0;
  }

  return {
    count: logs.length,
    totalCost: parseFloat(totalCost.toFixed(6)),
    nonSuccessCount: logs.filter(log => log.status !== 'success').length,
    byCaller,
    byStatus,
    observedAt: now.toISOString(),
    scope: 'All internal inference-log records since 00:00 UTC; this is not a conversation count.'
  };
}

function parseAnalyticsWindowHours(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return Math.min(parsed, 24 * 7);
}

function roundMetric(value) {
  return Number.isFinite(value) ? parseFloat(value.toFixed(1)) : null;
}

function buildDistribution(items, keyField, valueField = 'count') {
  return [...items.entries()]
    .map(([key, stats]) => ({
      [keyField]: key,
      [valueField]: stats.count,
      avgDurationMs: roundMetric(stats.durationTotal / stats.count),
      avgClassificationMs: stats.classificationCount > 0
        ? roundMetric(stats.classificationTotal / stats.classificationCount)
        : null,
      autoRouted: stats.autoRouted,
      percentage: 0
    }))
    .sort((left, right) => right[valueField] - left[valueField]);
}

async function buildRoutingAnalytics(windowHours = 24, now = new Date()) {
  const safeWindowHours = parseAnalyticsWindowHours(windowHours);
  const since = new Date(now.getTime() - safeWindowHours * 60 * 60 * 1000);
  const logs = await InferenceLog.find({
    timestamp: { $gte: since },
    caller: 'chat'
  })
    .sort({ timestamp: -1 })
    .limit(500)
    .lean();

  const summary = {
    windowHours: safeWindowHours,
    since: since.toISOString(),
    totalRequests: logs.length,
    autoRoutedCount: 0,
    avgDurationMs: null,
    avgClassificationMs: null,
    avgTotalForClassifiedMs: null,
    classificationOverheadPct: null,
    classificationSamples: 0
  };

  if (logs.length === 0) {
    return {
      summary,
      taskDistribution: [],
      modelDistribution: [],
      hostDistribution: []
    };
  }

  const taskBuckets = new Map();
  const modelBuckets = new Map();
  const hostBuckets = new Map();
  let durationTotal = 0;
  let classificationTotal = 0;
  let classifiedDurationTotal = 0;

  for (const log of logs) {
    const taskType = log.taskType || 'unclassified';
    const model = log.routedModel || log.model || 'unknown';
    const host = log.routedHost || log.hostKey || 'unknown';
    const durationMs = Number(log.durationMs) || 0;
    const classificationMs = Number(log.classificationMs) || 0;
    const autoRouted = log.autoRouted === true;

    durationTotal += durationMs;
    classificationTotal += classificationMs;
    if (classificationMs > 0) {
      summary.classificationSamples += 1;
      classifiedDurationTotal += durationMs;
    }
    if (autoRouted) summary.autoRoutedCount += 1;

    if (!taskBuckets.has(taskType)) {
      taskBuckets.set(taskType, { count: 0, durationTotal: 0, classificationTotal: 0, classificationCount: 0, autoRouted: 0 });
    }
    if (!modelBuckets.has(model)) {
      modelBuckets.set(model, { count: 0, durationTotal: 0, classificationTotal: 0, classificationCount: 0, autoRouted: 0 });
    }
    if (!hostBuckets.has(host)) {
      hostBuckets.set(host, { count: 0, durationTotal: 0, classificationTotal: 0, classificationCount: 0, autoRouted: 0 });
    }

    for (const bucket of [taskBuckets.get(taskType), modelBuckets.get(model), hostBuckets.get(host)]) {
      bucket.count += 1;
      bucket.durationTotal += durationMs;
      bucket.classificationTotal += classificationMs;
      bucket.classificationCount += classificationMs > 0 ? 1 : 0;
      bucket.autoRouted += autoRouted ? 1 : 0;
    }
  }

  summary.avgDurationMs = roundMetric(durationTotal / logs.length);
  summary.avgClassificationMs = summary.classificationSamples > 0
    ? roundMetric(classificationTotal / summary.classificationSamples)
    : null;
  summary.avgTotalForClassifiedMs = summary.classificationSamples > 0
    ? roundMetric(classifiedDurationTotal / summary.classificationSamples)
    : null;
  summary.classificationOverheadPct = classifiedDurationTotal > 0
    ? roundMetric((classificationTotal / classifiedDurationTotal) * 100)
    : null;

  const taskDistribution = buildDistribution(taskBuckets, 'taskType');
  const modelDistribution = buildDistribution(modelBuckets, 'model');
  const hostDistribution = buildDistribution(hostBuckets, 'host');

  for (const entry of [...taskDistribution, ...modelDistribution, ...hostDistribution]) {
    entry.percentage = roundMetric((entry.count / logs.length) * 100);
  }

  summary.autoRoutedPct = roundMetric((summary.autoRoutedCount / logs.length) * 100);

  return {
    summary,
    taskDistribution,
    modelDistribution,
    hostDistribution
  };
}

// ========================================
// 1. GET /intelligence — bundled summary
// ========================================

router.get('/intelligence', async (_req, res) => {
  try {
    const data = await buildIntelligenceSummary();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] intelligence fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Product-owned, fail-closed snapshot for operator surfaces. Personal runtime
// evidence is composed by trusted extensions and does not cross this boundary.
router.get('/ecosystem', async (_req, res) => {
  try {
    const data = await buildEcosystemSnapshot();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] ecosystem snapshot failed', { error: err.message });
    res.status(503).json({
      status: 'error',
      code: 'ECOSYSTEM_SNAPSHOT_UNAVAILABLE',
      message: 'Ecosystem snapshot is unavailable.'
    });
  }
});

// Compatibility alias for callers that expect a generic Nerve Center status
// endpoint instead of the older "intelligence" name.
router.get('/status', async (_req, res) => {
  try {
    const data = await buildIntelligenceSummary();
    res.json({ status: 'success', data, meta: { aliasFor: '/intelligence' } });
  } catch (err) {
    logger.error('[NerveCenter] status alias fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 2. GET /routing/config
// ========================================

router.get('/routing/config', async (_req, res) => {
  try {
    const data = await getRoutingConfig();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] routing config fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 3. PUT /routing/config — update in-memory
// ========================================

router.put('/routing/config', requireOperatorUiAccess, async (req, res) => {
  try {
    const { taskModels } = req.body || {};

    await runRuntimeMutation({
      principal: operatorRequestIdentity(req),
      scope: 'router-task-config:bulk-update'
    }, async () => {
      if (taskModels && typeof taskModels === 'object') {
        for (const [taskType, entry] of Object.entries(taskModels)) {
          if (entry?.resetToDefault === true) {
            await resetTaskModelOverride(taskType);
          } else {
            await saveTaskModelOverride(taskType, entry);
          }
        }
      }
    });

    res.json({
      status: 'success',
      data: await getRoutingConfig()
    });
  } catch (err) {
    logger.error('[NerveCenter] routing config update failed', { error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 4. GET /routing/log — recent inference routing decisions
// ========================================

router.get('/routing/log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const query = {};

    if (req.query.taskType) query.taskType = req.query.taskType;
    if (req.query.model) query.model = req.query.model;
    if (req.query.host) query.host = req.query.host;

    const logs = await InferenceLog.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json({ status: 'success', data: projectInferenceLogs(logs) });
  } catch (err) {
    logger.error('[NerveCenter] routing log fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/routing/analytics', async (req, res) => {
  try {
    const data = await buildRoutingAnalytics(req.query.hours);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] routing analytics fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 5. POST /failover — trigger manual failover
// ========================================

router.post('/failover', (req, res) => {
  try {
    const { hostUrl, reason } = req.body;

    if (!hostUrl) {
      return res.status(400).json({ status: 'error', message: 'hostUrl is required' });
    }

    switchHost(hostUrl, reason || 'manual_nerve_center');
    emitBuddyEvent('host_offline', 'infrastructure', 'Failover triggered', 'high');

    logger.info('[NerveCenter] manual failover triggered', { hostUrl, reason });

    res.json({
      status: 'success',
      data: getFailoverStatus()
    });
  } catch (err) {
    logger.error('[NerveCenter] failover failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 6. POST /failover/reset — reset to primary
// ========================================

router.post('/failover/reset', (_req, res) => {
  try {
    resetToPrimary('nerve_center_reset');
    emitBuddyEvent('failover_triggered', 'infrastructure', 'Failover reset to primary host', 'high');

    logger.info('[NerveCenter] failover reset to primary');

    res.json({
      status: 'success',
      data: getFailoverStatus()
    });
  } catch (err) {
    logger.error('[NerveCenter] failover reset failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Host-preferences endpoints (pin management, benchmark claims, list with
// live status, update, reload) extracted to routes/nerve-center-host-preferences.js
// in task 0193. Mounted alongside this router in src/app.js.

/**
 * GET /inference-health
 * Consolidated snapshot for the Nerve Center "Inference Health" section:
 *   - hostGate admission queue state
 *   - active benchmark claims (with age)
 *   - watchdog probe summary + last 10 events
 *   - num_ctx drift aggregation from InferenceLog (last 15 min by default)
 *
 * Optional query:
 *   driftWindowMs  — override the aggregation window (default 900000 = 15 min)
 */
router.get('/inference-health', async (req, res) => {
  try {
    const { getInferenceHealth } = require('../src/services/inferenceHealthService');
    const driftWindowMs = req.query.driftWindowMs ? Number(req.query.driftWindowMs) : undefined;
    const data = await getInferenceHealth({ driftWindowMs });
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] inference-health failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// GET /inference-stats — current-day count + cost
// ========================================

router.get('/inference-stats', async (_req, res) => {
  try {
    const data = await buildInferenceStats();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] inference stats failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 12. GET /health/feed — unified event feed
// ========================================

router.get('/health/feed', async (req, res) => {
  try {
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 30, 1), 100);
    const candidateLimit = Math.min(limit * 5, 500);

    const [recentAlertSnapshot, activeAlertSnapshot, errorLogs] = await Promise.all([
      alertService.getAlertSnapshot({
        limit: candidateLimit,
        maxLimit: 500,
        sort: 'recency'
      }),
      alertService.getAlertSnapshot({
        limit: 500,
        maxLimit: 500,
        filters: { status: 'active' },
        sort: 'recency'
      }),
      InferenceLog.find({
        $or: [
          { status: 'error' },
          { status: 'timeout' },
          { fallbackUsed: true }
        ]
      })
        .sort({ timestamp: -1 })
        .limit(candidateLimit)
        .lean()
    ]);

    const projection = projectHealthFeed({
      alerts: [...activeAlertSnapshot.alerts, ...recentAlertSnapshot.alerts],
      inferenceLogs: projectInferenceLogs(errorLogs || []),
      limit
    });

    res.json({
      status: 'success',
      data: projection.events,
      meta: {
        ...projection.meta,
        activeAlertCount: activeAlertSnapshot.summary.activeCount,
        activeAlertBasis: activeAlertSnapshot.summary.basis.activePredicate,
        alertSnapshotObservedAt: activeAlertSnapshot.summary.observedAt
      }
    });
  } catch (err) {
    logger.error('[NerveCenter] health feed failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 13. GET /inference/routing-config — task models + host preference state
// ========================================

router.get('/inference/routing-config', async (_req, res) => {
  try {
    const allPrefs = await hostPrefService.getAll();
    const prefByUrl = new Map(allPrefs.map(p => [p.hostUrl, p]));

    const hosts = {};
    for (const [key, url] of Object.entries(HOSTS)) {
      if (!url) continue;
      const pref = prefByUrl.get(url) || {};
      const pinnedNames = hostPrefService.getPinnedModelNames(pref);
      hosts[key] = {
        url,
        name: describeHost(url, key).displayName,
        role: key,
        ip: describeHost(url, key).ip,
        pinnedModels: pinnedNames,
        maxConcurrentModels: pref.maxConcurrentModels || 1,
      };
    }

    res.json({
      status: 'success',
      data: {
        taskModels: TASK_MODELS,
        hosts,
      }
    });
  } catch (err) {
    logger.error('[NerveCenter] inference routing-config fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 14. PUT /inference/routing-config/:taskType — update a task-model assignment
// ========================================

router.put('/inference/routing-config/:taskType', requireOperatorUiAccess, async (req, res) => {
  try {
    const { taskType } = req.params;
    const state = await runRuntimeMutation({
      principal: operatorRequestIdentity(req),
      scope: `router-task-config:${taskType}`
    }, () => req.body?.resetToDefault === true
      ? resetTaskModelOverride(taskType)
      : saveTaskModelOverride(taskType, req.body || {}));

    logger.info('[NerveCenter] inference routing-config updated', { taskType });

    res.json({ status: 'success', data: { taskType, ...state } });
  } catch (err) {
    logger.error('[NerveCenter] inference routing-config update failed', { error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 15. GET /inference/heatmap — utilization heatmap data
// ========================================

router.get('/inference/heatmap', async (req, res) => {
  try {
    const { getUtilizationHeatmap } = require('../src/services/hostUsageAggregator');
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const heatmap = await getUtilizationHeatmap(days);
    res.json({ status: 'success', data: heatmap });
  } catch (err) {
    logger.error('[NerveCenter] heatmap fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 16. GET /inference/gpu-status — live GPU telemetry for fleet cards
// ========================================

router.get('/inference/gpu-status', async (req, res) => {
  try {
    const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');
    const ollamaVramService = require('../src/services/ollamaVramService');
    const rows = await ollamaVramService.getVramForHosts(getConfiguredHosts());
    const data = rows.map((host) => ({
      hostId: host.id,
      hostname: host.name || host.id,
      ip: '',
      ollamaHostKey: host.id,
      gpuName: '',
      temperature: null,
      utilization: null,
      gpuCount: 0,
      gpus: [],
      vramTotalMiB: host.memoryTotalMiBTotal || 0,
      vramUsedMiB: host.memoryUsedMiBTotal || 0,
      source: host._source || 'none'
    }));

    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] gpu-status fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// 17. GET /inference/activity — recent inference telemetry
// ========================================

router.get('/inference/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filter = {};

    if (req.query.host) filter.host = req.query.host;
    if (req.query.model) filter.model = req.query.model;
    if (req.query.caller) filter.caller = req.query.caller;
    if (req.query.status) filter.status = req.query.status;

    const logs = await InferenceLog.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    const presentedLogs = logs.map(log => {
      const projected = projectInferenceLog(log);
      return {
        ...projected,
        hostIdentity: describeHost(projected?.host, projected?.hostKey)
      };
    });

    // Aggregate stats for last hour
    const oneHourAgo = new Date(Date.now() - 3600000);
    const recentFilter = { ...filter, timestamp: { $gte: oneHourAgo } };
    const stats = await InferenceLog.aggregate([
      { $match: recentFilter },
      { $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        avgLatencyMs: { $avg: '$durationMs' },
        errorCount: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } },
        byHost: { $push: '$host' },
        byModel: { $push: '$model' },
      }}
    ]);

    const hourStats = stats[0] || { totalCalls: 0, avgLatencyMs: null, errorCount: 0 };
    const nonSuccessRate = hourStats.totalCalls > 0
      ? Number((hourStats.errorCount / hourStats.totalCalls * 100).toFixed(1))
      : null;

    res.json({
      status: 'success',
      data: {
        logs: presentedLogs,
        stats: {
          lastHour: {
            totalCalls: hourStats.totalCalls,
            avgLatencyMs: hourStats.totalCalls > 0 ? Math.round(hourStats.avgLatencyMs || 0) : null,
            nonSuccessCount: hourStats.errorCount,
            nonSuccessRate,
            errorRate: nonSuccessRate,
            observedAt: new Date().toISOString(),
          }
        }
      }
    });
  } catch (err) {
    logger.error('[NerveCenter] inference activity fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// RAG service proxy
// ========================================

const RAG_SERVICE_URL = (process.env.RAG_SERVICE_URL || 'http://localhost:3082').replace(/\/+$/, '');
const RAG_EVIDENCE_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.RAG_EVIDENCE_TIMEOUT_MS) || 5000, 500),
  15000
);

router.get('/rag/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const operatorToken = String(process.env.AGENTX_OPERATOR_TOKEN || '').trim();
        const response = await fetch(`${RAG_SERVICE_URL}/api/rag/status/refresh`, {
          method: 'POST',
          headers: operatorToken ? { 'X-AgentX-Operator-Token': operatorToken } : {},
          signal: AbortSignal.timeout(RAG_EVIDENCE_TIMEOUT_MS)
        });
        const data = await response.json();
        const payload = data?.data || data;
        if (!response.ok || data?.ok === false || !payload || typeof payload !== 'object') {
          throw new Error(`RAG readiness probe failed with status ${response.status}`);
        }
        res.json({
          status: 'success',
          data: payload,
          meta: { proxiedAt: new Date().toISOString(), source: 'rag.status.refresh' }
        });
    } catch (err) {
        logger.warn('[NerveCenter] RAG readiness evidence unavailable', { error: err.message });
        res.status(502).json({
          status: 'error',
          code: 'RAG_STATUS_UNAVAILABLE',
          message: 'RAG readiness evidence is unavailable.'
        });
    }
});

router.get('/rag/documents', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const requestedLimit = parseInt(req.query.limit, 10);
        const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1), 100);
        const response = await fetch(`${RAG_SERVICE_URL}/api/rag/documents?limit=${limit}`, {
          signal: AbortSignal.timeout(RAG_EVIDENCE_TIMEOUT_MS)
        });
        const data = await response.json();
        const payload = data?.data || data;
        if (!response.ok || data?.ok === false || !payload || typeof payload !== 'object') {
          throw new Error(`RAG document probe failed with status ${response.status}`);
        }
        res.json({
          status: 'success',
          data: payload,
          meta: { proxiedAt: new Date().toISOString(), source: 'rag.documents' }
        });
    } catch (err) {
        logger.warn('[NerveCenter] RAG document evidence unavailable', { error: err.message });
        res.status(502).json({
          status: 'error',
          code: 'RAG_DOCUMENTS_UNAVAILABLE',
          message: 'RAG document evidence is unavailable.'
        });
    }
});

// Sub-router: Nestor Fastlane / two-level routing config summary
// Sub-router: host preferences (pin management, benchmark claims) — extracted in 0193
router.use('/', require('./nerve-center-host-preferences'));

module.exports = router;
module.exports.buildIntelligenceSummary = buildIntelligenceSummary;
module.exports.buildEcosystemSnapshot = buildEcosystemSnapshot;
module.exports.getRoutingConfig = getRoutingConfig;
module.exports.buildInferenceStats = buildInferenceStats;
module.exports.buildRoutingAnalytics = buildRoutingAnalytics;

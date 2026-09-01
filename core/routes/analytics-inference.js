/**
 * Inference Analytics Routes
 *
 * Why this exists: the legacy Analytics page reads the `conversations`
 * collection, which is written only by conversationPersistence.js from
 * POST /api/chat and /api/chat/stream. Every other lane — the inference
 * dispatcher, embeddings, agent, and pipeline traffic — writes
 * `inferencelogs` and never touches
 * `conversations`. Chat is a low-single-digit percentage of real platform
 * traffic, so the legacy page is structurally blind to how the ecosystem is
 * actually used.
 *
 * This router reports the real substrate: `inferencelogs`.
 *
 * Deliberate design decision — local inference is reported in COMPUTE, not
 * dollars. Ollama calls have no per-token price; emitting a fabricated
 * $0.00 (or worse, a made-up rate) would be inventing a number. Dollar
 * figures are produced ONLY for models whose provider prefix is a known
 * cloud vendor, via the same allowlist the budget service uses.
 *
 * Mounted at /api/analytics/inference by routes/analytics.js.
 */

const express = require('express');
const router = express.Router();

const InferenceLog = require('../models/InferenceLog');
const {
  projectInferenceLog,
  projectInferenceLogs
} = require('../src/services/routing/inferenceLogReadProjection');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const { isCloudCall, modelProvider } = require('../src/services/budgetAccountingService');
const { resolvePricing } = require('../src/services/costCalculator');

const WINDOWS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90
};

function resolveWindow(raw) {
  const key = WINDOWS[raw] ? raw : '7d';
  const to = new Date();
  const from = new Date(to.getTime() - WINDOWS[key] * 60 * 60 * 1000);
  return { key, from, to };
}

const round = (n, d = 2) => {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const rate = (part, total) => (total > 0 ? round((part / total) * 100) : 0);

const LOG_FILTER_FIELDS = [
  'caller',
  'callerDetail',
  'consumerContract',
  'runtime',
  'workItemId',
  'correlationId',
  'taskType',
  'model',
  'host'
];
const LOG_STATUSES = new Set(['success', 'error', 'timeout']);

function boundedText(value, max = 200) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : '';
}

function parseDateFilter(value, name) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${name} must be a valid ISO-8601 timestamp`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function buildLogQuery(query = {}) {
  const filter = {};
  for (const field of LOG_FILTER_FIELDS) {
    const value = boundedText(query[field]);
    if (value) filter[field] = value;
  }

  const statuses = boundedText(query.status, 100)
    .split(',')
    .map(status => status.trim())
    .filter(Boolean);
  if (statuses.some(status => !LOG_STATUSES.has(status))) {
    const error = new Error('status must contain only success, error, or timeout');
    error.statusCode = 400;
    throw error;
  }
  if (statuses.length === 1) filter.status = statuses[0];
  else if (statuses.length > 1) filter.status = { $in: [...new Set(statuses)] };

  const from = parseDateFilter(query.from, 'from');
  const to = parseDateFilter(query.to, 'to');
  const endExclusive = query.endExclusive == null || query.endExclusive === ''
    ? false
    : String(query.endExclusive).toLowerCase() === 'true';
  if (query.endExclusive != null && query.endExclusive !== ''
      && !['true', 'false'].includes(String(query.endExclusive).toLowerCase())) {
    const error = new Error('endExclusive must be true or false');
    error.statusCode = 400;
    throw error;
  }
  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = from;
    if (to) filter.timestamp[endExclusive ? '$lt' : '$lte'] = to;
  }
  if (from && to && from > to) {
    const error = new Error('from must be earlier than or equal to to');
    error.statusCode = 400;
    throw error;
  }
  return filter;
}

/**
 * GET /api/analytics/inference/logs
 *
 * Canonical, filterable and paged read API over inferencelogs. The collection
 * timestamps on `timestamp`; `createdAt` is intentionally not consulted.
 */
router.get('/logs', async (req, res) => {
  try {
    const filter = buildLogQuery(req.query);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      InferenceLog.find(filter)
        .sort({ timestamp: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      InferenceLog.countDocuments(filter)
    ]);

    envelope.success(res, {
      source: 'inferencelogs',
      timestampField: 'timestamp',
      filters: {
        status: req.query.status || null,
        caller: req.query.caller || null,
        callerDetail: req.query.callerDetail || null,
        consumerContract: req.query.consumerContract || null,
        runtime: req.query.runtime || null,
        workItemId: req.query.workItemId || null,
        correlationId: req.query.correlationId || null,
        taskType: req.query.taskType || null,
        model: req.query.model || null,
        host: req.query.host || null,
        from: req.query.from || null,
        to: req.query.to || null,
        endExclusive: String(req.query.endExclusive || '').toLowerCase() === 'true',
      },
      items: projectInferenceLogs(items),
      pagination: {
        page,
        pageSize,
        total,
        pages: total > 0 ? Math.ceil(total / pageSize) : 0,
        hasNext: skip + items.length < total,
      }
    });
  } catch (err) {
    logger.error('Inference log query failed', { error: err.message });
    envelope.error(res, err.statusCode || 500, err.message);
  }
});

/**
 * Estimated USD for a cloud model's token counts.
 * Returns null — never 0 — when no pricing can be resolved, so the UI can
 * say "unpriced" instead of implying the calls were free.
 */
async function estimateCloudCost(model, tokensIn, tokensOut) {
  try {
    const provider = modelProvider(model);
    const modelName = String(model || '').slice(`${provider}/`.length);
    const pricing = await resolvePricing(provider, modelName);
    if (!pricing) return null;
    const promptRate = Number(pricing.promptTokenCost);
    const completionRate = Number(pricing.completionTokenCost);
    if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return null;
    if (promptRate === 0 && completionRate === 0) return null;
    return ((tokensIn / 1e6) * promptRate) + ((tokensOut / 1e6) * completionRate);
  } catch (err) {
    logger.warn('Cloud cost estimate failed', { model, error: err.message });
    return null;
  }
}

/**
 * GET /api/analytics/inference/summary?window=24h|7d|30d|90d
 *
 * One call returns everything the Analytics page needs. Deliberately a
 * single round trip: the page previously fired six overlapping requests at
 * two collections and still rendered zeros.
 */
router.get('/summary', async (req, res) => {
  try {
    const { key, from, to } = resolveWindow(req.query.window);
    const match = { timestamp: { $gte: from, $lte: to } };

    const groupMetrics = {
      calls: { $sum: 1 },
      errors: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 0, 1] } },
      tokensIn: { $sum: { $ifNull: ['$tokensIn', 0] } },
      tokensOut: { $sum: { $ifNull: ['$tokensOut', 0] } },
      durationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
      fallbacks: { $sum: { $cond: ['$fallbackUsed', 1, 0] } },
      classificationMs: { $sum: { $ifNull: ['$classificationMs', 0] } },
      classifiedCalls: { $sum: { $cond: [{ $gt: ['$classificationMs', 0] }, 1, 0] } },
      classifiedDurationMs: {
        $sum: { $cond: [{ $gt: ['$classificationMs', 0] }, { $ifNull: ['$durationMs', 0] }, 0] }
      }
    };

    const [facet] = await InferenceLog.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [{ $group: { _id: null, ...groupMetrics } }],
          byModel: [
            { $group: { _id: '$model', ...groupMetrics, hosts: { $addToSet: '$host' } } },
            { $sort: { calls: -1 } },
            { $limit: 40 }
          ],
          byCaller: [{ $group: { _id: '$caller', ...groupMetrics } }, { $sort: { calls: -1 } }],
          // callerDetail is caller-controlled legacy text and may contain a
          // token-shaped payload. Aggregate only the server-attested contract
          // label at this public/operator boundary.
          byConsumerContract: [{ $group: { _id: { $ifNull: ['$consumerContract', 'unknown'] }, ...groupMetrics } }, { $sort: { calls: -1 } }],
          byTaskType: [{ $group: { _id: { $ifNull: ['$taskType', 'unknown'] }, ...groupMetrics } }, { $sort: { calls: -1 } }],
          byFallbackUsed: [{ $group: { _id: '$fallbackUsed', ...groupMetrics } }, { $sort: { calls: -1 } }],
          byDegraded: [{ $group: { _id: { $ifNull: ['$routeDecision.degraded', false] }, ...groupMetrics } }, { $sort: { calls: -1 } }],
          byRuntime: [{ $group: { _id: '$runtime', ...groupMetrics } }, { $sort: { calls: -1 } }],
          byHost: [{ $group: { _id: '$host', ...groupMetrics } }, { $sort: { calls: -1 } }],
          byDay: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
                ...groupMetrics
              }
            },
            { $sort: { _id: 1 } }
          ],
          byDayCaller: [
            {
              $group: {
                _id: {
                  date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
                  caller: '$caller'
                },
                calls: { $sum: 1 }
              }
            },
            { $sort: { '_id.date': 1 } }
          ],
          topErrors: [
            { $match: { status: { $ne: 'success' } } },
            // Legacy `error` values can contain an entire upstream body. Group
            // by the closed status enum instead; the response keeps its
            // existing `error` field but it is now a stable machine bucket.
            { $group: { _id: { model: '$model', status: '$status' }, calls: { $sum: 1 } } },
            { $sort: { calls: -1 } },
            { $limit: 10 }
          ]
        }
      }
    ]);

    const t = facet?.totals?.[0] || {
      calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, durationMs: 0, fallbacks: 0
    };

    const shape = (row, labelKey) => {
      const calls = row.calls || 0;
      const tokensOut = row.tokensOut || 0;
      const seconds = (row.durationMs || 0) / 1000;
      return {
        [labelKey]: row._id ?? 'unknown',
        calls,
        errors: row.errors || 0,
        errorRate: rate(row.errors || 0, calls),
        tokensIn: row.tokensIn || 0,
        tokensOut,
        totalTokens: (row.tokensIn || 0) + tokensOut,
        inferenceSeconds: round(seconds),
        avgLatencyMs: calls > 0 ? Math.round((row.durationMs || 0) / calls) : 0,
        avgClassificationMs: row.classifiedCalls > 0
          ? Math.round((row.classificationMs || 0) / row.classifiedCalls)
          : 0,
        // Real generation throughput, the number that actually tells you
        // whether a model is worth its VRAM.
        tokensOutPerSecond: seconds > 0 ? round(tokensOut / seconds) : 0
      };
    };

    const byModel = await Promise.all(
      (facet?.byModel || []).map(async (row) => {
        const base = shape(row, 'model');
        // Classify on model AND host: OpenRouter serves models whose prefix
        // is the model vendor (z-ai/...), not the billing provider.
        const cloud = isCloudCall({ model: row._id, hosts: row.hosts || [] });
        return {
          ...base,
          hosts: row.hosts || [],
          provider: modelProvider(row._id),
          isCloud: cloud,
          // null for local models: local inference has no per-token price.
          estimatedCostUsd: cloud
            ? await estimateCloudCost(row._id, base.tokensIn, base.tokensOut)
            : null
        };
      })
    );

    const cloudModels = byModel.filter((m) => m.isCloud);
    const localModels = byModel.filter((m) => !m.isCloud);
    const sum = (rows, field) => rows.reduce((acc, r) => acc + (r[field] || 0), 0);
    const pricedCloud = cloudModels.filter((m) => Number.isFinite(m.estimatedCostUsd));

    const totalSeconds = (t.durationMs || 0) / 1000;

    envelope.success(res, {
      window: { key, from, to },
      source: 'inferencelogs',
      scope: 'Every AgentX-routed inference call: chat, proxy, embedding, classification, benchmark.',
      totals: {
        calls: t.calls,
        errors: t.errors,
        errorRate: rate(t.errors, t.calls),
        fallbackCalls: t.fallbacks,
        fallbackRate: rate(t.fallbacks, t.calls),
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        totalTokens: t.tokensIn + t.tokensOut,
        inferenceSeconds: round(totalSeconds),
        inferenceHours: round(totalSeconds / 3600),
        avgLatencyMs: t.calls > 0 ? Math.round((t.durationMs || 0) / t.calls) : 0,
        classifiedCalls: t.classifiedCalls || 0,
        avgClassificationMs: t.classifiedCalls > 0
          ? Math.round((t.classificationMs || 0) / t.classifiedCalls)
          : 0,
        avgTotalForClassifiedMs: t.classifiedCalls > 0
          ? Math.round((t.classifiedDurationMs || 0) / t.classifiedCalls)
          : 0,
        classificationOverheadPct: rate(t.classificationMs || 0, t.classifiedDurationMs || 0),
        tokensOutPerSecond: totalSeconds > 0 ? round(t.tokensOut / totalSeconds) : 0,
        callsPerDay: round(t.calls / (WINDOWS[key] / 24), 1)
      },
      local: {
        models: localModels.length,
        calls: sum(localModels, 'calls'),
        totalTokens: sum(localModels, 'totalTokens'),
        inferenceHours: round(sum(localModels, 'inferenceSeconds') / 3600),
        note: 'Local inference is accounted in compute, not currency. No per-token price exists for it.'
      },
      cloud: {
        models: cloudModels.length,
        calls: sum(cloudModels, 'calls'),
        totalTokens: sum(cloudModels, 'totalTokens'),
        estimatedCostUsd: pricedCloud.length > 0 ? round(sum(pricedCloud, 'estimatedCostUsd'), 4) : null,
        unpricedModels: cloudModels.filter((m) => !Number.isFinite(m.estimatedCostUsd)).map((m) => m.model),
        note: pricedCloud.length === cloudModels.length
          ? 'All cloud models resolved a price.'
          : 'Some cloud models have no configured price; their spend is excluded rather than guessed.'
      },
      byModel,
      byCaller: (facet?.byCaller || []).map((r) => shape(r, 'caller')),
      byConsumerContract: (facet?.byConsumerContract || []).map((r) => {
        const projected = projectInferenceLog({ consumerContract: r._id });
        return shape({ ...r, _id: projected?.consumerContract || 'unknown' }, 'consumerContract');
      }),
      byTaskType: (facet?.byTaskType || []).map((r) => shape(r, 'taskType')),
      byFallbackUsed: (facet?.byFallbackUsed || []).map((r) => shape(r, 'fallbackUsed')),
      byDegraded: (facet?.byDegraded || []).map((r) => shape(r, 'degraded')),
      byRuntime: (facet?.byRuntime || []).map((r) => shape(r, 'runtime')),
      byHost: (facet?.byHost || []).map((r) => shape(r, 'host')),
      byDay: (facet?.byDay || []).map((r) => shape(r, 'date')),
      // Daily volume crossed with caller, for the stacked series on the page.
      byDayCaller: (facet?.byDayCaller || []).map((r) => ({
        date: r._id?.date,
        caller: r._id?.caller || 'unknown',
        calls: r.calls
      })),
      topErrors: (facet?.topErrors || []).map((r) => {
        const projected = projectInferenceLog({
          model: r._id?.model,
          status: r._id?.status,
        });
        return {
          model: projected?.model || 'unknown',
          error: projected?.status || 'error',
          calls: r.calls
        };
      }),
      currency: process.env.COST_CURRENCY || 'USD'
    });
  } catch (err) {
    logger.error('Inference analytics summary failed', { error: err.message, stack: err.stack });
    envelope.error(res, 500, err.message);
  }
});

module.exports = router;
module.exports.buildLogQuery = buildLogQuery;

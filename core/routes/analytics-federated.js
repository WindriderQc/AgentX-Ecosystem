/**
 * Federated Cost & Consumption (task 0166)
 *
 * Returns local Ollama conversations and AgentX-routed cloud inference
 * side-by-side WITHOUT merging. OpenClaw's native Usage view remains the
 * authority for provider plans, balances, and traffic that bypasses AgentX.
 *
 * Extracted from `routes/analytics.js` in task 0188 to keep that file
 * under the 700-line cap. Mounted at `/api/analytics` alongside it.
 */

const express = require('express');
const router = express.Router();
const InferenceLog = require('../models/InferenceLog');
const logger = require('../config/logger');
const { isCloudCall, modelProvider } = require('../src/services/budgetAccountingService');
const { calculateMessageCost } = require('../src/services/costCalculator');
const {
  ingestCodexUsage,
  readCodexSubscriptionValue,
  tokenAllowed: codexUsageTokenAllowed,
} = require('../src/services/codexUsageService');

const FEDERATED_WINDOWS = {
  '1h':  { ms: 60 * 60 * 1000 },
  '24h': { ms: 24 * 60 * 60 * 1000 },
  '7d':  { ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { ms: 30 * 24 * 60 * 60 * 1000 },
  'all': { ms: null },
};

function resolveFederatedWindow(raw) {
  const key = String(raw || '7d').toLowerCase();
  return FEDERATED_WINDOWS[key] ? { key, ...FEDERATED_WINDOWS[key] } : { key: '7d', ...FEDERATED_WINDOWS['7d'] };
}

async function aggregateProviderBucket(window, agentId) {
  const toDate = new Date();
  const fromDate = window.ms ? new Date(toDate.getTime() - window.ms) : new Date(0);
  const match = { timestamp: { $gte: fromDate, $lte: toDate } };
  if (agentId) match.callerDetail = agentId;
  const rows = await InferenceLog.aggregate([
    { $match: match },
    { $group: {
      _id: { model: '$model', agentId: '$callerDetail' },
      requests: { $sum: 1 },
      promptTokens: { $sum: { $ifNull: ['$tokensIn', 0] } },
      completionTokens: { $sum: { $ifNull: ['$tokensOut', 0] } },
      hosts: { $addToSet: '$host' },
    } },
  ]);
  // Host-aware: OpenRouter serves models whose prefix names the model vendor
  // (z-ai/...), not the biller, so a prefix-only test filed real cloud spend
  // as local and reported $0.
  const cloudRows = rows.filter((row) => isCloudCall({ model: row?._id?.model, hosts: row?.hosts || [] }));
  const priced = await Promise.all(cloudRows.map(async (row) => {
    const model = row._id.model;
    const totalTokens = Number(row.promptTokens || 0) + Number(row.completionTokens || 0);
    const cost = await calculateMessageCost(model, {
      usage: {
        promptTokens: Number(row.promptTokens || 0),
        completionTokens: Number(row.completionTokens || 0),
        totalTokens,
      },
    });
    return {
      model,
      provider: modelProvider(model),
      agentId: row._id.agentId || 'unknown',
      sessions: Number(row.requests || 0),
      promptTokens: Number(row.promptTokens || 0),
      completionTokens: Number(row.completionTokens || 0),
      totalTokens,
      // No configured price is NOT zero spend. Null lets the UI say 'unpriced'
      // instead of reporting real OpenRouter traffic as free.
      estimatedSpendUsd: cost.pricingSource?.source && cost.pricingSource.source !== 'default'
        ? Number(cost.totalCost || 0)
        : null,
      pricingSource: cost.pricingSource?.source || 'unconfigured',
      source: 'agentx-cloud',
    };
  }));
  const mergeRows = (key) => Object.values(priced.reduce((acc, row) => {
    const id = row[key];
    acc[id] ||= {
      [key]: id,
      provider: key === 'model' ? row.provider : undefined,
      sessions: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      // null until a priced row contributes, so an unpriced model does not
      // render as $0.0000 alongside real traffic.
      estimatedSpendUsd: null,
      source: 'agentx-cloud',
    };
    for (const field of ['sessions', 'promptTokens', 'completionTokens', 'totalTokens']) {
      acc[id][field] += row[field];
    }
    // Unpriced rows keep the group null rather than dragging it to a fake 0.
    if (Number.isFinite(row.estimatedSpendUsd)) {
      acc[id].estimatedSpendUsd = (acc[id].estimatedSpendUsd || 0) + row.estimatedSpendUsd;
    }
    return acc;
  }, {})).sort((left, right) => right.totalTokens - left.totalTokens);
  const totals = priced.reduce((acc, row) => {
    for (const field of ['sessions', 'promptTokens', 'completionTokens', 'totalTokens']) {
      acc[field] += row[field];
    }
    if (Number.isFinite(row.estimatedSpendUsd)) {
      acc.estimatedSpendUsd = (acc.estimatedSpendUsd || 0) + row.estimatedSpendUsd;
    }
    return acc;
  }, { sessions: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedSpendUsd: null });
  totals.unpricedModels = priced.filter((r) => !Number.isFinite(r.estimatedSpendUsd)).map((r) => r.model);
  return {
    source: 'agentx-cloud',
    scope: 'agentx-routed-calls',
    authorityNote: 'OpenClaw Usage remains authoritative for native provider plans and balances.',
    window: window.key,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    totals,
    estimatedSpendUsd: totals.estimatedSpendUsd,
    byModel: mergeRows('model'),
    byAgent: mergeRows('agentId'),
    asOfMs: toDate.getTime(),
  };
}

/**
 * Aggregate local Ollama inference (InferenceLog) for the federated view.
 * Local usage is denominated in calls, tokens and compute time, never dollars:
 * owned hardware has no per-token price. Previously read Conversation, which
 * only the chat UI writes, so the panel missed every agent/proxy/embedding call.
 * (legacy note follows)
 * for the federated view. Kept tight on purpose — the rich shape lives in
 * /api/analytics/costs and /api/analytics/stats; this is a compact bucket
 * sized to sit next to the AgentX-routed cloud bucket on one page.
 */
async function aggregateLocalBucket(window, agentId) {
  const toDate = new Date();
  const fromDate = window.ms ? new Date(toDate.getTime() - window.ms) : new Date(0);
  const match = { timestamp: { $gte: fromDate, $lte: toDate } };
  if (agentId) match.callerDetail = agentId;

  const rows = await InferenceLog.aggregate([
    { $match: match },
    { $group: {
      _id: '$model',
      calls: { $sum: 1 },
      promptTokens: { $sum: { $ifNull: ['$tokensIn', 0] } },
      completionTokens: { $sum: { $ifNull: ['$tokensOut', 0] } },
      durationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
      hosts: { $addToSet: '$host' },
    } },
    { $sort: { calls: -1 } },
  ]);

  const localRows = rows.filter((row) => !isCloudCall({ model: row?._id, hosts: row?.hosts || [] }));

  const byModel = localRows.map((row) => ({
    model: row._id || 'unknown',
    calls: Number(row.calls || 0),
    promptTokens: Number(row.promptTokens || 0),
    completionTokens: Number(row.completionTokens || 0),
    totalTokens: Number(row.promptTokens || 0) + Number(row.completionTokens || 0),
    inferenceSeconds: Math.round((row.durationMs || 0) / 100) / 10,
    // Owned hardware has no per-token price. Null, never 0 — a zero here would
    // read as 'ran for free' rather than 'not denominated in dollars'.
    totalCost: null,
    source: 'local',
    provider: 'ollama',
  }));

  const totals = byModel.reduce((acc, row) => {
    acc.calls += row.calls;
    acc.promptTokens += row.promptTokens;
    acc.completionTokens += row.completionTokens;
    acc.totalTokens += row.totalTokens;
    acc.inferenceSeconds += row.inferenceSeconds;
    return acc;
  }, { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, inferenceSeconds: 0 });
  totals.models = byModel.length;
  totals.inferenceHours = Math.round((totals.inferenceSeconds / 3600) * 100) / 100;
  totals.totalCost = null;

  return {
    source: 'local',
    // Was Conversation, which only the chat UI writes. The panel is labelled
    // 'Local inference (AgentX -> Ollama)' yet every agent, proxy and embedding
    // call was missing from it. Now reads inferencelogs, the real local lane.
    basis: 'inferencelogs',
    window: window.key,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    totals,
    byModel,
  };
}

/**
 * GET /api/analytics/federated
 *
 * Query params:
 *   - window  ('1h' | '24h' | '7d' | '30d' | 'all', default '7d')
 *   - agentId (optional, filters both AgentX-owned buckets)
 *
 * Response shape:
 *   {
 *     status: 'success',
 *     window, from, to,
 *     local: { source: 'local', totals, byModel: [...] },
 *     providers: { source: 'agentx-cloud', scope, totals, byModel, byAgent },
 *     provider_status: 'ok' | 'unavailable'
 *   }
 *
 * Each bucket soft-fails independently so partial analytics remain usable.
 */
router.get('/federated', async (req, res) => {
  const window = resolveFederatedWindow(req.query.window);
  const agentId = req.query.agentId ? String(req.query.agentId) : null;

  const [localResult, providerResult, subscriptionResult] = await Promise.allSettled([
    aggregateLocalBucket(window, agentId),
    aggregateProviderBucket(window, agentId),
    readCodexSubscriptionValue(),
  ]);

  let local = null;
  let localError = null;
  if (localResult.status === 'fulfilled') {
    local = localResult.value;
  } else {
    localError = localResult.reason?.message || String(localResult.reason);
    logger.error('Federated analytics: local aggregation failed', { error: localError });
  }

  let providers = null;
  let providerStatus = 'unavailable';
  let providerError;
  if (providerResult.status === 'fulfilled') {
    providers = providerResult.value;
    providerStatus = 'ok';
  } else {
    providerError = providerResult.reason?.message || String(providerResult.reason);
    logger.info('Federated analytics: provider aggregation failed', { error: providerError });
  }

  // Soft-fail if local aggregation died — return whatever we have rather
  // than a 500. The UI can render a banner on the local side too.
  res.json({
    status: 'success',
    window: window.key,
    from: local?.from || null,
    to: local?.to || null,
    local,
    local_error: localError,
    providers,
    provider_status: providerStatus,
    provider_scope: 'agentx-routed-calls',
    codexSubscription: subscriptionResult.status === 'fulfilled' ? subscriptionResult.value : null,
    ...(subscriptionResult.status === 'rejected'
      ? { codex_subscription_error: subscriptionResult.reason?.message || String(subscriptionResult.reason) }
      : {}),
    ...(providerError ? { provider_error: providerError } : {}),
    currency: process.env.COST_CURRENCY || 'USD',
  });
});

router.get('/codex-subscription-value', async (_req, res) => {
  try {
    res.json({ status: 'success', data: await readCodexSubscriptionValue() });
  } catch (err) {
    logger.error('Codex subscription value query failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Codex subscription value unavailable' });
  }
});

router.post('/codex-usage', async (req, res) => {
  if (!codexUsageTokenAllowed(req)) {
    return res.status(401).json({ status: 'error', message: 'Valid Codex usage token required' });
  }
  try {
    const result = await ingestCodexUsage(req.body);
    const value = await readCodexSubscriptionValue();
    return res.json({ status: 'success', ok: true, result, value });
  } catch (err) {
    logger.warn('Codex usage ingest rejected', { error: err.message });
    return res.status(400).json({ status: 'error', message: err.message });
  }
});

module.exports = router;

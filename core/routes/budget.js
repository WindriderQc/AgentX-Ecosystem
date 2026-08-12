/**
 * @file budget.js
 * @description Budget status API — token usage summaries and health indicator
 * @service core
 */

const express = require('express');
const router = express.Router();
const InferenceLog = require('../models/InferenceLog');
const logger = require('../config/logger');
const { normalizeBudgetHealth, recommendEscalation } = require('../src/services/nestorEscalationPolicyService');
const { buildCloudBudget } = require('../src/services/budgetAccountingService');

const DAILY_TOKEN_LIMIT = parseInt(process.env.DAILY_TOKEN_LIMIT || '500000', 10);
// Billable-only ceiling. Local Ollama tokens are free, so the cloud gate needs
// its own (much smaller) limit rather than sharing the whole-fleet budget.
const CLOUD_DAILY_TOKEN_LIMIT = parseInt(
  process.env.CLOUD_DAILY_TOKEN_LIMIT || String(DAILY_TOKEN_LIMIT),
  10
);

function parseHours(value) {
  return Math.min(Math.max(parseInt(value, 10) || 24, 1), 720);
}

async function buildBudgetStatus(hoursInput) {
  const hours = parseHours(hoursInput);
  const since = new Date(Date.now() - hours * 3600_000);
  const period = `${hours}h`;

  const matchStage = { $match: { timestamp: { $gte: since } } };

  const [totals, byModel, byCaller] = await Promise.all([
    InferenceLog.aggregate([
      matchStage,
      { $group: {
        _id: null,
        total_requests: { $sum: 1 },
        total_prompt_tokens: { $sum: '$tokensIn' },
        total_completion_tokens: { $sum: '$tokensOut' }
      }}
    ]),
    InferenceLog.aggregate([
      matchStage,
      { $group: {
        _id: '$model',
        requests: { $sum: 1 },
        tokens: { $sum: { $add: ['$tokensIn', '$tokensOut'] } }
      }}
    ]),
    InferenceLog.aggregate([
      matchStage,
      { $group: {
        _id: { caller: '$caller', detail: '$callerDetail' },
        requests: { $sum: 1 },
        tokens: { $sum: { $add: ['$tokensIn', '$tokensOut'] } }
      }}
    ])
  ]);

  const t = totals[0] || { total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0 };
  const totalTokens = t.total_prompt_tokens + t.total_completion_tokens;

  const scaledLimit = Math.round(DAILY_TOKEN_LIMIT * (hours / 24));
  const ratio = scaledLimit > 0 ? totalTokens / scaledLimit : 0;
  const budget_health = ratio < 0.7 ? 'green' : ratio < 0.9 ? 'yellow' : 'red';

  const by_model = {};
  for (const m of byModel) {
    by_model[m._id || 'unknown'] = { requests: m.requests, tokens: m.tokens };
  }

  const by_caller = {};
  for (const c of byCaller) {
    const key = [c._id.caller, c._id.detail].filter(Boolean).join('/') || 'unknown';
    by_caller[key] = { requests: c.requests, tokens: c.tokens };
  }

  const cloudBudget = buildCloudBudget({
    rows: byModel,
    hours,
    cloudDailyLimit: CLOUD_DAILY_TOKEN_LIMIT
  });

  return {
    period,
    total_requests: t.total_requests,
    total_prompt_tokens: t.total_prompt_tokens,
    total_completion_tokens: t.total_completion_tokens,
    by_model,
    by_caller,
    budget_health,
    daily_limit: DAILY_TOKEN_LIMIT,
    scaled_limit: scaledLimit,
    usage_ratio: Math.round(ratio * 1000) / 1000,
    ...cloudBudget
  };
}

function buildSyntheticBudgetStatus(budgetHealth) {
  return {
    period: 'manual',
    total_requests: null,
    total_prompt_tokens: null,
    total_completion_tokens: null,
    by_model: {},
    by_caller: {},
    budget_health: normalizeBudgetHealth(budgetHealth),
    daily_limit: DAILY_TOKEN_LIMIT,
    scaled_limit: null,
    usage_ratio: null,
    source: 'query'
  };
}

/**
 * GET /api/budget/status
 * Returns token burn summary for the last 24h (or ?hours=N) with budget health.
 */
router.get('/status', async (req, res) => {
  try {
    res.json(await buildBudgetStatus(req.query.hours));
  } catch (err) {
    logger.error('Budget status query failed', { error: err.message });
    res.status(500).json({ error: 'Budget status unavailable' });
  }
});

/**
 * GET /api/budget/escalation-recommendation
 * Returns the Nestor Answer-Heavy cloud escalation gate for the live budget status.
 * Optional ?budget_health=green|yellow|red exercises the pure policy mapping.
 */
router.get('/escalation-recommendation', async (req, res) => {
  try {
    const budgetStatus = req.query.budget_health
      ? buildSyntheticBudgetStatus(req.query.budget_health)
      : await buildBudgetStatus(req.query.hours);

    res.json({
      ...budgetStatus,
      escalation: recommendEscalation(budgetStatus)
    });
  } catch (err) {
    logger.error('Budget escalation recommendation failed', { error: err.message });
    res.status(500).json({ error: 'Budget escalation recommendation unavailable' });
  }
});

module.exports = router;

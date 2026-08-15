'use strict';

const crypto = require('crypto');
const {
  CodexUsageEvent,
  CodexUsageWatermark,
  CodexAccountSnapshot,
} = require('../../models/CodexUsage');

const MAX_SESSIONS = 2000;

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : min;
}

function nullable(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function bounded(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeLimit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usedPercent = nullable(value.usedPercent, 0, 100);
  const windowMinutes = nullable(value.windowMinutes, 1, 525_600);
  const resetsAtMs = nullable(value.resetsAtMs, 0, 9_999_999_999_999);
  return usedPercent === null && windowMinutes === null && resetsAtMs === null
    ? null
    : { usedPercent, windowMinutes, resetsAtMs };
}

function normalizePayload(value) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (Number(payload.version) !== 1) throw new Error('Unsupported Codex usage contract version');
  if (payload.source !== 'codex-local') throw new Error('Codex usage source must be codex-local');
  const hostId = bounded(payload.hostId, 96);
  if (!hostId || !/^[a-zA-Z0-9._-]+$/.test(hostId)) throw new Error('Codex usage hostId is invalid');
  const rawSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (rawSessions.length > MAX_SESSIONS) throw new Error(`Codex usage payload exceeds ${MAX_SESSIONS} sessions`);
  const seen = new Set();
  const sessions = rawSessions.flatMap((row) => {
    const sessionKey = bounded(row?.sessionKey, 128);
    const updatedAtMs = nullable(row?.updatedAtMs, 1, 9_999_999_999_999);
    if (!sessionKey || !/^[a-f0-9]{32,128}$/i.test(sessionKey) || seen.has(sessionKey) || updatedAtMs === null) return [];
    seen.add(sessionKey);
    return [{
      sessionKey,
      startedAtMs: nullable(row.startedAtMs, 1, 9_999_999_999_999),
      updatedAtMs,
      model: bounded(row.model, 160),
      inputTokens: finite(row.inputTokens),
      cachedInputTokens: finite(row.cachedInputTokens),
      outputTokens: finite(row.outputTokens),
      reasoningOutputTokens: finite(row.reasoningOutputTokens),
      totalTokens: finite(row.totalTokens),
    }];
  });
  const account = payload.account && typeof payload.account === 'object' ? {
    planType: bounded(payload.account.planType, 80),
    primary: normalizeLimit(payload.account.primary),
    secondary: normalizeLimit(payload.account.secondary),
    credits: payload.account.credits && typeof payload.account.credits === 'object' ? {
      hasCredits: payload.account.credits.hasCredits === true,
      unlimited: payload.account.credits.unlimited === true,
      balance: bounded(payload.account.credits.balance, 64),
    } : null,
  } : null;
  return {
    hostId,
    observedAtMs: nullable(payload.observedAtMs, 1, 9_999_999_999_999) || Date.now(),
    sessions,
    account,
    scan: payload.scan && typeof payload.scan === 'object' ? payload.scan : null,
  };
}

function eventId(hostId, sessionKey, observedAtMs, totalTokens) {
  return crypto.createHash('sha256').update(`${hostId}:${sessionKey}:${observedAtMs}:${totalTokens}`).digest('hex');
}

async function ingestCodexUsage(value, models = {}) {
  const payload = normalizePayload(value);
  const Event = models.Event || CodexUsageEvent;
  const Watermark = models.Watermark || CodexUsageWatermark;
  const Account = models.Account || CodexAccountSnapshot;
  const existingRows = await Watermark.find({ hostId: payload.hostId }).lean();
  const existingByKey = new Map(existingRows.map((row) => [row.sessionKey, row]));
  const now = Date.now();
  const eventOps = [];
  const watermarkOps = [];
  let resetSessions = 0;

  for (const session of payload.sessions) {
    const existing = existingByKey.get(session.sessionKey);
    const reset = Boolean(existing) && (
      existing.inputTokens > session.inputTokens ||
      existing.cachedInputTokens > session.cachedInputTokens ||
      existing.outputTokens > session.outputTokens ||
      existing.reasoningOutputTokens > session.reasoningOutputTokens ||
      existing.totalTokens > session.totalTokens ||
      String(existing.model || '') !== String(session.model || '')
    );
    const delta = (field) => existing && !reset ? Math.max(0, session[field] - Number(existing[field] || 0)) : session[field];
    const inputTokens = delta('inputTokens');
    const cachedInputTokens = delta('cachedInputTokens');
    const outputTokens = delta('outputTokens');
    const reasoningOutputTokens = delta('reasoningOutputTokens');
    const totalTokens = Math.max(delta('totalTokens'), inputTokens + outputTokens);
    if (inputTokens || outputTokens || reasoningOutputTokens || totalTokens) {
      eventOps.push({ updateOne: {
        filter: { eventId: eventId(payload.hostId, session.sessionKey, session.updatedAtMs, session.totalTokens) },
        update: { $setOnInsert: {
          hostId: payload.hostId,
          sessionKey: session.sessionKey,
          observedAtMs: session.updatedAtMs,
          model: session.model,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens,
          totalTokens,
          source: existing ? (reset ? 'codex-local-reset' : 'codex-local-delta') : 'codex-local-backfill',
        } },
        upsert: true,
      } });
      if (reset) resetSessions += 1;
    }
    watermarkOps.push({ updateOne: {
      filter: { hostId: payload.hostId, sessionKey: session.sessionKey },
      update: { $set: { ...session, hostId: payload.hostId, lastSeenAtMs: now, lastUpdatedAtMs: session.updatedAtMs } },
      upsert: true,
    } });
  }

  const [eventResult] = await Promise.all([
    eventOps.length ? Event.bulkWrite(eventOps, { ordered: false }) : null,
    watermarkOps.length ? Watermark.bulkWrite(watermarkOps, { ordered: false }) : null,
    payload.account ? Account.updateOne(
      { snapshotId: eventId(payload.hostId, 'account', payload.observedAtMs, 0) },
      { $setOnInsert: { hostId: payload.hostId, observedAtMs: payload.observedAtMs, account: payload.account, scan: payload.scan } },
      { upsert: true }
    ) : null,
  ]);
  return {
    hostId: payload.hostId,
    acceptedSessions: payload.sessions.length,
    insertedEvents: Number(eventResult?.upsertedCount || 0),
    resetSessions,
    observedAtMs: payload.observedAtMs,
  };
}

async function readTotals(sinceMs, Event = CodexUsageEvent) {
  const rows = await Event.aggregate([
    { $match: { observedAtMs: { $gte: sinceMs } } },
    { $group: {
      _id: null,
      sessions: { $addToSet: { $concat: ['$hostId', ':', '$sessionKey'] } },
      activeDays: { $addToSet: { $dateToString: { date: { $toDate: '$observedAtMs' }, format: '%Y-%m-%d' } } },
      inputTokens: { $sum: '$inputTokens' },
      cachedInputTokens: { $sum: '$cachedInputTokens' },
      outputTokens: { $sum: '$outputTokens' },
      reasoningOutputTokens: { $sum: '$reasoningOutputTokens' },
      totalTokens: { $sum: '$totalTokens' },
    } },
    { $project: {
      _id: 0,
      sessions: { $size: '$sessions' },
      activeDays: { $size: '$activeDays' },
      inputTokens: 1,
      cachedInputTokens: 1,
      outputTokens: 1,
      reasoningOutputTokens: 1,
      totalTokens: 1,
    } },
  ]);
  return rows[0] || { sessions: 0, activeDays: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function valueSignal(totals, usedPercent) {
  if (!totals.sessions || !totals.totalTokens) return ['awaiting-data', 'Sync local Codex counters to begin measuring subscription value.'];
  if ((usedPercent || 0) >= 65 || totals.activeDays >= 12 || totals.totalTokens >= 10_000_000) return ['strong', 'High entitlement use: the subscription is carrying sustained Codex work.'];
  if ((usedPercent || 0) >= 25 || totals.activeDays >= 5 || totals.totalTokens >= 2_000_000) return ['active', 'Meaningful usage is accumulating; value improves as active days and quota use rise.'];
  return ['light', 'Usage is currently light relative to a recurring monthly subscription.'];
}

async function readCodexSubscriptionValue(now = Date.now(), models = {}) {
  const Event = models.Event || CodexUsageEvent;
  const Watermark = models.Watermark || CodexUsageWatermark;
  const Account = models.Account || CodexAccountSnapshot;
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const [currentMonth, last7d, allTime, latestAccount, hosts, latestWatermark] = await Promise.all([
    readTotals(monthStart, Event),
    readTotals(now - 7 * 86_400_000, Event),
    readTotals(0, Event),
    Account.findOne({}).sort({ observedAtMs: -1 }).lean(),
    Watermark.distinct('hostId'),
    Watermark.findOne({}).sort({ lastSeenAtMs: -1 }).select('lastSeenAtMs').lean(),
  ]);
  const monthlyCost = finite(process.env.CODEX_SUBSCRIPTION_MONTHLY_USD || 20);
  const [signal, message] = valueSignal(last7d, latestAccount?.account?.primary?.usedPercent);
  return {
    available: allTime.sessions > 0,
    sourceLabel: 'Codex local counters',
    privacyLabel: 'Counters and entitlement metadata only; prompts are never ingested.',
    lastSyncedAtMs: Math.max(Number(latestAccount?.observedAtMs || 0), Number(latestWatermark?.lastSeenAtMs || 0)) || null,
    hosts: hosts.length,
    plan: {
      name: process.env.CODEX_SUBSCRIPTION_PLAN_NAME || 'ChatGPT Plus',
      internalType: latestAccount?.account?.planType || null,
      monthlyCostUsd: monthlyCost,
      priceSourceUrl: 'https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus',
    },
    quota: latestAccount?.account ? {
      primary: latestAccount.account.primary || null,
      secondary: latestAccount.account.secondary || null,
      credits: latestAccount.account.credits || null,
    } : { primary: null, secondary: null, credits: null },
    currentMonth,
    last7d,
    allTime,
    effectiveCostPer1MTokensUsd: currentMonth.totalTokens ? (monthlyCost / currentMonth.totalTokens) * 1_000_000 : null,
    cachedInputPct: currentMonth.inputTokens ? Math.round((currentMonth.cachedInputTokens / currentMonth.inputTokens) * 1000) / 10 : 0,
    valueSignal: signal,
    valueMessage: message,
    apiEquivalentUsd: null,
    apiEquivalentReason: 'Codex subscription model labels do not have a verified public API price mapping, so no savings figure is invented.',
  };
}

function tokenAllowed(req) {
  const expected = String(
    process.env.AGENTX_CODEX_USAGE_TOKEN || ''
  ).trim();
  if (!expected) return false;
  const actual = String(req.get('x-agentx-codex-usage-token') || '').trim();
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

module.exports = {
  ingestCodexUsage,
  normalizePayload,
  readCodexSubscriptionValue,
  readTotals,
  tokenAllowed,
  valueSignal,
};

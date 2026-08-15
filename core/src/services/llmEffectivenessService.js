'use strict';

const LlmOutcome = require('../../models/LlmOutcome');
const InferenceLog = require('../../models/InferenceLog');
const PipelineTask = require('../../models/PipelineTask');
const {
  RUNTIMES,
  boundedIdentifier,
  inferRuntime,
  positiveAttempt,
} = require('../helpers/llmTelemetryContext');

const VERDICTS = new Set(['success', 'partial', 'failure', 'abandoned']);
const OUTCOME_TYPES = new Set(['task', 'deployment', 'incident', 'benchmark', 'document', 'conversation', 'other']);
const VERIFICATION_METHODS = new Set(['none', 'automated-tests', 'operator-review', 'deployment', 'benchmark', 'external']);
const USAGE_SOURCES = new Set(['none', 'reported', 'agentx-inference', 'external', 'codex', 'provider']);
const FORBIDDEN_PAYLOAD_KEYS = new Set(['prompt', 'response', 'content', 'messages', 'transcript', 'tooloutput', 'tool_output']);
const WINDOW_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nullableNonNegative(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function percentage(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function normalizeWindow(value, now = Date.now()) {
  const key = String(value || '7d').toLowerCase();
  if (key === 'all') return { key, from: new Date(0), to: new Date(now) };
  const ms = WINDOW_MS[key] || WINDOW_MS['7d'];
  return { key: WINDOW_MS[key] ? key : '7d', from: new Date(now - ms), to: new Date(now) };
}

function rejectSensitivePayload(input) {
  for (const key of Object.keys(input || {})) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      const error = new Error(`Outcome payload must not include ${key}`);
      error.status = 400;
      error.code = 'SENSITIVE_OUTCOME_PAYLOAD';
      throw error;
    }
  }
}

function normalizeOutcomeInput(input = {}) {
  rejectSensitivePayload(input);
  const outcomeId = boundedIdentifier(input.outcomeId);
  if (!outcomeId) {
    const error = new Error('outcomeId is required for idempotent reporting');
    error.status = 400;
    error.code = 'OUTCOME_ID_REQUIRED';
    throw error;
  }
  const requestedRuntime = String(input.runtime || '').trim().toLowerCase();
  if (!RUNTIMES.has(requestedRuntime)) {
    const error = new Error('runtime is invalid');
    error.status = 400;
    error.code = 'INVALID_RUNTIME';
    throw error;
  }
  const runtime = requestedRuntime;
  const verdict = String(input.verdict || '').toLowerCase();
  if (!VERDICTS.has(verdict)) {
    const error = new Error(`verdict must be one of ${[...VERDICTS].join('|')}`);
    error.status = 400;
    error.code = 'INVALID_VERDICT';
    throw error;
  }
  const usage = input.usage && typeof input.usage === 'object' ? input.usage : {};
  rejectSensitivePayload(usage);
  const hasUsageValues = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.totalTokens,
    usage.costUsd,
    usage.inferenceMs,
  ].some((value) => nullableNonNegative(value) != null && Number(value) > 0);
  const requestedUsageSource = String(usage.source || '').toLowerCase();
  const usageSource = USAGE_SOURCES.has(requestedUsageSource)
    ? requestedUsageSource
    : (hasUsageValues ? 'reported' : 'none');
  const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
  if (Number.isNaN(completedAt.getTime())) {
    const error = new Error('completedAt must be a valid timestamp');
    error.status = 400;
    error.code = 'INVALID_COMPLETED_AT';
    throw error;
  }

  return {
    outcomeId,
    workItemId: boundedIdentifier(input.workItemId),
    correlationId: boundedIdentifier(input.correlationId),
    runtime,
    source: String(input.source || `${runtime}-reported`).trim().slice(0, 80),
    outcomeType: OUTCOME_TYPES.has(String(input.outcomeType || '').toLowerCase())
      ? String(input.outcomeType).toLowerCase()
      : 'task',
    verdict,
    verified: input.verified === true,
    verificationMethod: VERIFICATION_METHODS.has(String(input.verificationMethod || '').toLowerCase())
      ? String(input.verificationMethod).toLowerCase()
      : 'none',
    qualityScore: input.qualityScore == null
      ? null
      : Math.min(1, finiteNonNegative(input.qualityScore)),
    attempts: input.attempts == null ? null : positiveAttempt(input.attempts),
    reworkCount: input.reworkCount == null ? null : Math.round(finiteNonNegative(input.reworkCount)),
    humanInterventionMinutes: input.humanInterventionMinutes == null
      ? null
      : finiteNonNegative(input.humanInterventionMinutes),
    usage: {
      source: usageSource,
      inputTokens: finiteNonNegative(usage.inputTokens),
      outputTokens: finiteNonNegative(usage.outputTokens),
      cachedInputTokens: finiteNonNegative(usage.cachedInputTokens),
      totalTokens: finiteNonNegative(
        usage.totalTokens,
        finiteNonNegative(usage.inputTokens) + finiteNonNegative(usage.outputTokens),
      ),
      costUsd: nullableNonNegative(usage.costUsd),
      inferenceMs: finiteNonNegative(usage.inferenceMs),
    },
    evidenceRefs: Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.map((value) => String(value).trim().slice(0, 500)).filter(Boolean).slice(0, 20)
      : [],
    reportedBy: String(input.reportedBy || 'unknown').trim().slice(0, 120),
    completedAt,
  };
}

async function upsertOutcome(input) {
  const outcome = normalizeOutcomeInput(input);
  return LlmOutcome.findOneAndUpdate(
    { outcomeId: outcome.outcomeId },
    { $set: outcome },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

function pipelineRuntime(assignee) {
  const value = String(assignee || '').toLowerCase();
  if (value.includes('codex')) return 'codex';
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('agentx') || value.includes('terminal-ops')) return 'agentx';
  return 'other';
}

function derivePipelineOutcomes(tasks = [], explicitWorkItems = new Set()) {
  return tasks.flatMap((task) => {
    const workItemId = boundedIdentifier(task.pipelineId);
    const runtime = pipelineRuntime(task.assignee);
    const status = String(task.status || '');
    if (!workItemId || explicitWorkItems.has(workItemId) || runtime === 'other' || !['done', 'review', 'blocked'].includes(status)) return [];
    return [{
      outcomeId: `pipeline:${workItemId}`,
      workItemId,
      correlationId: null,
      runtime,
      source: 'pipeline-derived',
      outcomeType: 'task',
      verdict: status === 'done' ? 'success' : (status === 'blocked' ? 'failure' : 'partial'),
      verified: status === 'done',
      verificationMethod: status === 'done' ? 'operator-review' : 'none',
      qualityScore: null,
      attempts: null,
      reworkCount: null,
      humanInterventionMinutes: null,
      usage: { source: 'none', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, costUsd: null, inferenceMs: 0 },
      evidenceRefs: [`pipeline:${workItemId}`],
      reportedBy: task.assignee,
      completedAt: new Date(task.updatedAt || task.createdAt || Date.now()),
      derived: true,
    }];
  });
}

function normalizedLog(log) {
  const tokensIn = finiteNonNegative(log.tokensIn);
  const tokensOut = finiteNonNegative(log.tokensOut);
  return {
    id: String(log._id || log.id || `${log.correlationId || ''}:${log.timestamp || ''}:${log.model || ''}`),
    runtime: inferRuntime(log.runtime || log.callerDetail, 'agentx'),
    caller: String(log.caller || 'unknown'),
    workItemId: boundedIdentifier(log.workItemId),
    correlationId: boundedIdentifier(log.correlationId),
    tokensIn,
    tokensOut,
    totalTokens: tokensIn + tokensOut,
    inferenceMs: finiteNonNegative(log.durationMs),
    status: String(log.status || 'success'),
    fallbackUsed: log.fallbackUsed === true,
  };
}

function signalFor(summary) {
  if (summary.reportedOutcomes === 0) {
    return { signal: 'awaiting-outcomes', confidence: 'low', message: 'No verified outcome reports exist in this window yet.' };
  }
  if ((summary.attributionCoveragePct ?? 0) < 50) {
    return { signal: 'low-attribution', confidence: summary.reportedOutcomes >= 3 ? 'medium' : 'low', message: 'Outcomes are visible, but most usage is not yet linked to work items.' };
  }
  const productive = summary.productivityRatePct ?? 0;
  const rework = summary.reworkRatePct ?? 0;
  if (productive >= 80 && rework <= 20) {
    return { signal: 'productive', confidence: summary.reportedOutcomes >= 10 ? 'high' : 'medium', message: 'Verified output and attributed usage show productive LLM work.' };
  }
  return { signal: 'needs-attention', confidence: summary.reportedOutcomes >= 10 ? 'high' : 'medium', message: 'Attributed work shows material failure, rework, or abandoned outcomes.' };
}

function buildEffectivenessSnapshot({ outcomes = [], pipelineTasks = [], inferenceLogs = [], window }) {
  const explicit = outcomes.map((row) => ({ ...row, completedAt: new Date(row.completedAt) }));
  const explicitWorkItems = new Set(explicit.map((row) => boundedIdentifier(row.workItemId)).filter(Boolean));
  const combined = [...explicit, ...derivePipelineOutcomes(pipelineTasks, explicitWorkItems)];
  const logs = inferenceLogs.map(normalizedLog);
  const usedLogIds = new Set();
  const runtimeRows = new Map();
  const ensureRuntime = (runtime) => {
    if (!runtimeRows.has(runtime)) runtimeRows.set(runtime, {
      runtime,
      outcomes: 0,
      verifiedOutcomes: 0,
      productiveOutcomes: 0,
      attributedOutcomes: 0,
      tokens: 0,
      costUsd: 0,
      costSamples: 0,
      inferenceMs: 0,
      reworkCount: 0,
      humanInterventionMinutes: 0,
    });
    return runtimeRows.get(runtime);
  };

  let verifiedOutcomes = 0;
  let productiveOutcomes = 0;
  let attributedOutcomes = 0;
  let attributedProductiveOutcomes = 0;
  let firstPassEligible = 0;
  let firstPassSuccesses = 0;
  let reworkEligible = 0;
  let reworkedOutcomes = 0;
  let abandonedOutcomes = 0;
  let attributedTokens = 0;
  let attributedInferenceMs = 0;
  let attributedCostUsd = 0;
  let costSamples = 0;
  let humanInterventionSamples = 0;
  let humanInterventionMinutes = 0;

  for (const outcome of combined) {
    const runtime = inferRuntime(outcome.runtime, 'other');
    const row = ensureRuntime(runtime);
    row.outcomes += 1;
    const verified = outcome.verified === true;
    const productive = verified && outcome.verdict === 'success';
    if (verified) { verifiedOutcomes += 1; row.verifiedOutcomes += 1; }
    if (productive) { productiveOutcomes += 1; row.productiveOutcomes += 1; }
    if (outcome.attempts != null && Number.isFinite(Number(outcome.attempts))) {
      firstPassEligible += 1;
      if (productive && Number(outcome.attempts) === 1 && finiteNonNegative(outcome.reworkCount) === 0) firstPassSuccesses += 1;
    }
    if (outcome.reworkCount != null && Number.isFinite(Number(outcome.reworkCount))) {
      reworkEligible += 1;
      if (finiteNonNegative(outcome.reworkCount) > 0) reworkedOutcomes += 1;
      row.reworkCount += finiteNonNegative(outcome.reworkCount);
    }
    if (outcome.verdict === 'abandoned') abandonedOutcomes += 1;
    if (outcome.humanInterventionMinutes != null && Number.isFinite(Number(outcome.humanInterventionMinutes))) {
      const intervention = finiteNonNegative(outcome.humanInterventionMinutes);
      humanInterventionSamples += 1;
      humanInterventionMinutes += intervention;
      row.humanInterventionMinutes += intervention;
    }

    const reportedUsage = outcome.usage || {};
    const hasReportedUsage = reportedUsage.source && reportedUsage.source !== 'none';
    let usage;
    if (hasReportedUsage) {
      usage = {
        totalTokens: finiteNonNegative(reportedUsage.totalTokens),
        inferenceMs: finiteNonNegative(reportedUsage.inferenceMs),
        costUsd: nullableNonNegative(reportedUsage.costUsd),
      };
    } else {
      const matches = logs.filter((log) => {
        if (usedLogIds.has(log.id)) return false;
        return (outcome.workItemId && log.workItemId === outcome.workItemId)
          || (outcome.correlationId && log.correlationId === outcome.correlationId);
      });
      usage = matches.reduce((acc, log) => {
        usedLogIds.add(log.id);
        acc.totalTokens += log.totalTokens;
        acc.inferenceMs += log.inferenceMs;
        return acc;
      }, { totalTokens: 0, inferenceMs: 0, costUsd: null });
    }
    const attributed = hasReportedUsage || usage.totalTokens > 0 || usage.inferenceMs > 0 || usage.costUsd != null;
    if (attributed) {
      attributedOutcomes += 1;
      if (productive) attributedProductiveOutcomes += 1;
      row.attributedOutcomes += 1;
      attributedTokens += usage.totalTokens;
      attributedInferenceMs += usage.inferenceMs;
      row.tokens += usage.totalTokens;
      row.inferenceMs += usage.inferenceMs;
      if (usage.costUsd != null) {
        attributedCostUsd += usage.costUsd;
        costSamples += 1;
        row.costUsd += usage.costUsd;
        row.costSamples += 1;
      }
    }
  }

  const totalInferenceTokens = logs.reduce((sum, log) => sum + log.totalTokens, 0);
  const unmatched = logs.filter((log) => !usedLogIds.has(log.id));
  const unattributedTokens = unmatched.reduce((sum, log) => sum + log.totalTokens, 0);
  // Embeddings and classification are infrastructure: they serve retrieval and
  // routing, not a work item, and can never be attributed to an outcome. Rolling
  // them into "unattributed" made the figure read as 100% waste when most of it
  // is simply not the kind of call that belongs to a task. Split them out so the
  // remaining number is the one worth acting on.
  const isUnattributable = (log) => log.caller === 'embedding' || log.caller === 'classification';
  const unattributableTokens = unmatched.filter(isUnattributable).reduce((sum, log) => sum + log.totalTokens, 0);
  const unlinkedWorkTokens = unattributedTokens - unattributableTokens;
  const failedInferenceCalls = logs.filter((log) => log.status !== 'success').length;
  const fallbackCalls = logs.filter((log) => log.fallbackUsed).length;
  const summary = {
    reportedOutcomes: combined.length,
    verifiedOutcomes,
    productiveOutcomes,
    verificationRatePct: percentage(verifiedOutcomes, combined.length),
    productivityRatePct: percentage(productiveOutcomes, combined.length),
    attributionCoveragePct: percentage(attributedOutcomes, combined.length),
    firstPassSuccessRatePct: percentage(firstPassSuccesses, firstPassEligible),
    reworkRatePct: percentage(reworkedOutcomes, reworkEligible),
    // Each per-outcome ratio is computed over the sample that actually has the
    // input it needs, and ships its own denominator alongside.
    //
    // These used to require coverage across EVERY outcome in the window. That
    // gate is unreachable: derivePipelineOutcomes hard-codes costUsd and
    // humanInterventionMinutes to null, so costSamples and
    // humanInterventionSamples can never equal combined.length and those two
    // tiles rendered a dash permanently, however good attribution got.
    // Dividing attributed-only numerators by the FULL productive count was also
    // wrong on its own terms: it understated every ratio once coverage slipped
    // below 100%. An honest ratio over a stated subset beats a number that
    // never appears; attributionCoveragePct and the sample-size fields below
    // tell the reader how much of the window each figure rests on.
    tokensPerProductiveOutcome: attributedProductiveOutcomes > 0
      ? Math.round(attributedTokens / attributedProductiveOutcomes)
      : null,
    costPerProductiveOutcomeUsd: costSamples > 0 && attributedProductiveOutcomes > 0
      ? attributedCostUsd / attributedProductiveOutcomes
      : null,
    inferenceMinutesPerProductiveOutcome: attributedProductiveOutcomes > 0
      ? Math.round((attributedInferenceMs / 60_000 / attributedProductiveOutcomes) * 10) / 10
      : null,
    humanMinutesPerProductiveOutcome: humanInterventionSamples > 0 && productiveOutcomes > 0
      ? Math.round((humanInterventionMinutes / productiveOutcomes) * 10) / 10
      : null,
    // Denominators behind the four ratios above, so a reader sees the sample
    // rather than assuming the figures cover the whole window.
    attributedProductiveOutcomes,
    perOutcomeSampleSize: attributedProductiveOutcomes,
    costSampleSize: costSamples,
    humanInterventionSampleSize: humanInterventionSamples,
  };
  const signal = signalFor(summary);

  return {
    ok: true,
    asOf: new Date().toISOString(),
    window: { key: window.key, from: window.from.toISOString(), to: window.to.toISOString() },
    signal,
    summary,
    waste: {
      inferenceCalls: logs.length,
      failedInferenceCalls,
      failedInferenceRatePct: percentage(failedInferenceCalls, logs.length),
      fallbackCalls,
      fallbackRatePct: percentage(fallbackCalls, logs.length),
      reworkedOutcomes,
      abandonedOutcomes,
      totalInferenceTokens,
      unattributedTokens,
      unattributedTokenPct: percentage(unattributedTokens, totalInferenceTokens),
      // Of the unattributed total, how much is infrastructure (embedding /
      // classification) versus real work that simply carries no work item.
      unattributableTokens,
      unlinkedWorkTokens,
      unlinkedWorkTokenPct: percentage(unlinkedWorkTokens, totalInferenceTokens),
    },
    byRuntime: [...runtimeRows.values()].map((row) => ({
      ...row,
      attributionCoveragePct: percentage(row.attributedOutcomes, row.outcomes),
      productivityRatePct: percentage(row.productiveOutcomes, row.outcomes),
      costUsd: row.costSamples > 0 ? row.costUsd : null,
    })).sort((a, b) => b.outcomes - a.outcomes || a.runtime.localeCompare(b.runtime)),
    coverage: {
      outcomeSources: [...new Set(combined.map((row) => row.source))].sort(),
      usageAttribution: 'Each outcome uses reported source-owned usage OR matching AgentX inference logs, never both.',
      pipelineDerivedOutcomes: combined.filter((row) => row.derived).length,
      explicitOutcomes: explicit.length,
      firstPassSampleSize: firstPassEligible,
      reworkSampleSize: reworkEligible,
      costSampleSize: costSamples,
      humanInterventionSampleSize: humanInterventionSamples,
    },
  };
}

async function readEffectivenessSnapshot({ window: rawWindow = '7d', runtime = null } = {}) {
  const window = normalizeWindow(rawWindow);
  const outcomeQuery = { completedAt: { $gte: window.from, $lte: window.to } };
  const logQuery = { timestamp: { $gte: window.from, $lte: window.to } };
  if (runtime && RUNTIMES.has(runtime)) {
    outcomeQuery.runtime = runtime;
  }
  const [outcomes, pipelineTasks, inferenceLogs] = await Promise.all([
    LlmOutcome.find(outcomeQuery).sort({ completedAt: -1 }).limit(5000).lean(),
    PipelineTask.find({ status: { $in: ['done', 'review', 'blocked'] }, updatedAt: { $gte: window.from, $lte: window.to } })
      .select('pipelineId status assignee createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(5000)
      .lean(),
    InferenceLog.find(logQuery)
      .select('_id runtime caller workItemId correlationId callerDetail tokensIn tokensOut durationMs status fallbackUsed timestamp')
      .sort({ timestamp: -1 })
      .limit(50_000)
      .lean(),
  ]);
  const filteredPipelineTasks = runtime
    ? pipelineTasks.filter((task) => pipelineRuntime(task.assignee) === runtime)
    : pipelineTasks;
  const filteredInferenceLogs = runtime
    ? inferenceLogs.filter((log) => inferRuntime(log.runtime || log.callerDetail, 'agentx') === runtime)
    : inferenceLogs;
  return buildEffectivenessSnapshot({
    outcomes,
    pipelineTasks: filteredPipelineTasks,
    inferenceLogs: filteredInferenceLogs,
    window,
  });
}

module.exports = {
  buildEffectivenessSnapshot,
  derivePipelineOutcomes,
  normalizeOutcomeInput,
  normalizeWindow,
  pipelineRuntime,
  readEffectivenessSnapshot,
  signalFor,
  upsertOutcome,
};

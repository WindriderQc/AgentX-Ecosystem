'use strict';

/**
 * Lane observability (task 0465).
 *
 * Produces privacy-bounded evidence for inference-contract failures, claim/pin
 * lifecycle failures, and latency drift. It is observation-only: this module
 * never selects a route, changes a pin, releases a claim, or warms a model.
 */

const crypto = require('crypto');
const Alert = require('../../models/Alert');
const AlertRule = require('../../models/AlertRule');
const InferenceLog = require('../../models/InferenceLog');
const alertService = require('./alertService');
const logger = require('../../config/logger');

const SCHEMA_VERSION = 'agentx.lane-observability.v1';
const METRICS = Object.freeze({
  CONTEXT_MISMATCH: 'lane_context_mismatch',
  OUTPUT_CONTRACT_FAILURE: 'lane_output_contract_failure',
  CLAIM_RELEASE_FAILURE: 'benchmark_claim_release_failure',
  PIN_RESTORE_FAILURE: 'pin_restore_failure',
  LATENCY_DRIFT: 'lane_latency_drift',
});
const RULE_IDS = Object.freeze([
  'lane-context-mismatch',
  'lane-output-contract-failure',
  'benchmark-claim-release-failure',
  'pin-restore-failure',
  'lane-latency-drift',
]);
const LATENCY_POLICY = Object.freeze({
  scanIntervalMs: 5 * 60 * 1000,
  recentWindowMs: 60 * 60 * 1000,
  baselineWindowMs: 24 * 60 * 60 * 1000,
  minRecentSamples: 3,
  minBaselineSamples: 12,
  ratio: 1.75,
  minDeltaMs: 5000,
  maxRows: 5000,
});

let firstScanTimer = null;
let scanInterval = null;
let lastLatencyScan = {
  status: 'not_run',
  scannedAt: null,
  groupsEvaluated: 0,
  drifts: 0,
  alertsMatched: 0,
};

function bounded(value, max = 200) {
  if (value == null) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function contractIdentity(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const budget = contract.contextBudget || {};
  return {
    version: contract.version || null,
    artifact: {
      model: contract.artifact?.model || null,
      digest: contract.artifact?.digest || null,
      host: contract.artifact?.host || null,
      hostId: contract.artifact?.hostId || null,
    },
    qualification: contract.qualification || null,
    capabilities: contract.capabilities || null,
    context: {
      windowTokens: budget.windowTokens || null,
      source: budget.source || null,
      resolvedWindowTokens: budget.resolvedWindowTokens || null,
      resolvedSource: budget.resolvedSource || null,
      validatedWindowTokens: budget.validatedWindowTokens || null,
      reservedOutputTokens: budget.output?.reservedTokens || null,
      enforcement: budget.enforcement || null,
    },
  };
}

function contractFingerprint(contract) {
  const identity = contractIdentity(contract);
  if (!identity) return null;
  return crypto.createHash('sha256').update(stableSerialize(identity)).digest('hex');
}

function summarizeOllamaOutcome(data = {}) {
  const visible = data?.message?.content ?? data?.response ?? '';
  const thinking = data?.message?.thinking
    ?? data?.thinking
    ?? data?.reasoning
    ?? data?.reasoning_content
    ?? '';
  const finishReason = bounded(
    data?.done_reason ?? data?.stop_reason ?? data?.finish_reason,
    64
  );
  const incomplete = data?.done === false;
  const lengthStop = /^(length|max(?:imum)?[_ -]?(?:tokens|context)|token_limit)$/i.test(finishReason || '');
  return {
    visibleFinal: typeof visible === 'string' && visible.trim().length > 0,
    thinkingOnly: !(typeof visible === 'string' && visible.trim())
      && typeof thinking === 'string' && thinking.trim().length > 0,
    completed: data?.done !== false,
    truncated: incomplete || lengthStop,
    finishReason,
  };
}

function provenance(input = {}) {
  const decision = input.routeDecision || {};
  const contract = input.contract || null;
  const actual = decision.actual || {};
  const attribution = decision.attribution || {};
  return {
    host: bounded(input.host || contract?.artifact?.host || actual.hostUrl),
    hostKey: bounded(input.hostKey || actual.host, 64),
    model: bounded(input.model || contract?.artifact?.model || actual.model),
    lane: bounded(input.lane || decision.intent?.taskType, 64),
    taskType: bounded(input.taskType || decision.intent?.taskType, 64),
    caller: bounded(input.caller || attribution.caller, 64),
    artifactDigest: bounded(contract?.artifact?.digest, 160),
    contractFingerprint: contractFingerprint(contract),
    optionsFingerprint: bounded(decision.optionsFingerprint, 64),
    campaignId: bounded(
      input.campaignId || input.workItemId || attribution.workItemId,
      160
    ),
    correlationId: bounded(input.correlationId || decision.correlationId, 160),
    telemetryId: bounded(input.telemetryId, 64),
  };
}

function buildEvent(metric, input, details) {
  const prov = provenance(input);
  const component = prov.hostKey || prov.host || 'inference';
  return {
    component,
    metric,
    value: details.value,
    threshold: details.threshold,
    source: 'lane-observability',
    additionalData: {
      schemaVersion: SCHEMA_VERSION,
      detector: details.detector,
      incidentKey: details.incidentKey,
      host: prov.host,
      hostKey: prov.hostKey,
      model: prov.model,
      lane: prov.lane,
      taskType: prov.taskType,
      caller: prov.caller,
      artifactDigest: prov.artifactDigest,
      contractFingerprint: prov.contractFingerprint,
      optionsFingerprint: prov.optionsFingerprint,
      campaignId: prov.campaignId,
      correlationId: prov.correlationId,
      telemetryId: prov.telemetryId,
      failureKind: details.failureKind || null,
      failureCode: details.failureCode || null,
      remediation: details.remediation,
      evidence: details.evidence || {},
    },
  };
}

function buildInferenceEvents(input = {}) {
  const events = [];
  const contract = input.contract || null;
  const budget = contract?.contextBudget || {};
  const validated = positiveNumber(budget.validatedWindowTokens);
  const windowTokens = positiveNumber(budget.windowTokens);
  const fingerprint = contractFingerprint(contract) || 'unresolved-contract';

  if (validated && windowTokens && windowTokens > validated) {
    events.push(buildEvent(METRICS.CONTEXT_MISMATCH, input, {
      detector: 'context_mismatch',
      incidentKey: `contract:${fingerprint}`,
      value: windowTokens,
      threshold: validated,
      remediation: 'Compare runtime num_ctx with the validated artifact-host contract; change it only through the approved pin or runtime-config workflow.',
      evidence: {
        runtimeWindowTokens: windowTokens,
        validatedWindowTokens: validated,
        resolvedWindowTokens: positiveNumber(budget.resolvedWindowTokens),
        contextSource: bounded(budget.source, 64),
        resolvedSource: bounded(budget.resolvedSource, 64),
      },
    }));
  }

  const outcome = input.outcome || null;
  const status = input.status || 'success';
  const transformations = budget.transformations || {};
  const contextTruncation = transformations.truncation?.applied === true
    || transformations.upstreamTruncationRisk === true;
  const outcomeTruncation = outcome?.truncated === true || outcome?.completed === false;
  const noVisibleFinal = status === 'success' && outcome?.visibleFinal === false;
  if (contextTruncation || outcomeTruncation || noVisibleFinal) {
    const failureKinds = [
      ...(contextTruncation || outcomeTruncation ? ['truncation'] : []),
      ...(noVisibleFinal ? ['no_visible_final'] : []),
    ];
    events.push(buildEvent(METRICS.OUTPUT_CONTRACT_FAILURE, input, {
      detector: 'output_contract',
      incidentKey: `contract:${fingerprint}`,
      failureKind: failureKinds.join('+'),
      value: noVisibleFinal ? 0 : (positiveNumber(budget.input?.overflowTokens) || 1),
      threshold: noVisibleFinal ? 1 : 0,
      remediation: 'Inspect the artifact-host contract and output budget; rerun only after context and visible-final requirements are verified.',
      evidence: {
        failureKinds,
        inputOverflowTokens: Number(budget.input?.overflowTokens) || 0,
        truncationApplied: transformations.truncation?.applied === true,
        upstreamTruncationRisk: transformations.upstreamTruncationRisk === true,
        completed: outcome?.completed !== false,
        thinkingOnly: outcome?.thinkingOnly === true,
        finishReason: bounded(outcome?.finishReason, 64),
      },
    }));
  }

  return events;
}

async function evaluateEvents(events) {
  let matched = 0;
  for (const event of events) {
    const alerts = await alertService.evaluateEvent(event);
    matched += Array.isArray(alerts) ? alerts.length : 0;
  }
  return { emitted: events.length, matched };
}

async function observeInference(input = {}) {
  try {
    return await evaluateEvents(buildInferenceEvents(input));
  } catch (err) {
    logger.warn('[LaneObservability] inference observation failed (non-fatal)', { error: err.message });
    return { emitted: 0, matched: 0, error: true };
  }
}

function failureCode(error) {
  const text = String(error || '').toLowerCase();
  if (/timeout|aborted/.test(text)) return 'timeout';
  if (/econn|connect|unreach|offline/.test(text)) return 'host_unreachable';
  if (/context|resident|verif/.test(text)) return 'residency_verification_failed';
  if (/belong|owner|claim/.test(text)) return 'claim_owner_conflict';
  if (/no pinned/.test(text)) return 'pin_not_configured';
  if (/model.+(?:missing|not found)|(?:missing|not found).+model/.test(text)) return 'artifact_missing';
  return 'operation_failed';
}

async function observeLifecycleFailure(metric, input = {}) {
  try {
    const code = bounded(input.failureCode, 64) || failureCode(input.error);
    const campaignId = bounded(input.campaignId || input.batchId, 160);
    const models = (Array.isArray(input.models) ? input.models : [input.model])
      .map((model) => bounded(model))
      .filter(Boolean)
      .slice(0, 8);
    const remediation = metric === METRICS.CLAIM_RELEASE_FAILURE
      ? 'Verify the current claim owner, heartbeat, and batch status; release only through the benchmark-claim lifecycle.'
      : 'Check Ollama reachability, pinned artifact/context residency, and VRAM; retry the existing restore path after the cause is corrected.';
    const event = buildEvent(metric, {
      ...input,
      model: models[0] || null,
      campaignId,
    }, {
      detector: metric === METRICS.CLAIM_RELEASE_FAILURE ? 'claim_release' : 'pin_restore',
      incidentKey: `${campaignId || 'no-campaign'}:${bounded(input.host, 200) || 'unknown-host'}`,
      failureCode: code,
      value: 1,
      threshold: 0,
      remediation,
      evidence: {
        failureCode: code,
        models,
        source: bounded(input.source, 80),
      },
    });
    return evaluateEvents([event]);
  } catch (err) {
    logger.warn('[LaneObservability] lifecycle observation failed (non-fatal)', { error: err.message });
    return { emitted: 0, matched: 0, error: true };
  }
}

function observeClaimReleaseFailure(input) {
  return observeLifecycleFailure(METRICS.CLAIM_RELEASE_FAILURE, input);
}

function observePinRestoreFailure(input) {
  return observeLifecycleFailure(METRICS.PIN_RESTORE_FAILURE, input);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function latencyGroupKey(row) {
  const taskType = row.routeDecision?.intent?.taskType || row.taskType || 'unknown';
  return [row.caller || 'unknown', taskType, row.model || 'unknown', row.host || 'unknown'].join('|');
}

function findLatencyDrifts(rows, options = {}) {
  const nowMs = new Date(options.now || Date.now()).getTime();
  const policy = { ...LATENCY_POLICY, ...(options.policy || {}) };
  const recentCutoff = nowMs - policy.recentWindowMs;
  const baselineCutoff = recentCutoff - policy.baselineWindowMs;
  const groups = new Map();

  for (const row of rows || []) {
    const at = new Date(row.timestamp).getTime();
    const duration = positiveNumber(row.durationMs);
    if (!duration || !Number.isFinite(at) || at < baselineCutoff || at > nowMs) continue;
    const key = latencyGroupKey(row);
    const group = groups.get(key) || { key, recent: [], baseline: [], rows: [] };
    if (at >= recentCutoff) {
      group.recent.push(duration);
      group.rows.push(row);
    } else {
      group.baseline.push(duration);
    }
    groups.set(key, group);
  }

  const drifts = [];
  for (const group of groups.values()) {
    if (group.recent.length < policy.minRecentSamples
      || group.baseline.length < policy.minBaselineSamples) continue;
    const recentMedianMs = percentile(group.recent, 0.5);
    const baselineMedianMs = percentile(group.baseline, 0.5);
    const thresholdMs = Math.max(
      Math.round(baselineMedianMs * policy.ratio),
      baselineMedianMs + policy.minDeltaMs
    );
    if (recentMedianMs < thresholdMs) continue;
    const sample = group.rows[0] || {};
    const campaigns = new Set(group.rows.map((row) => row.workItemId).filter(Boolean));
    drifts.push({
      key: group.key,
      host: sample.host,
      hostKey: sample.hostKey,
      model: sample.model,
      caller: sample.caller,
      taskType: sample.routeDecision?.intent?.taskType || sample.taskType || null,
      routeDecision: sample.routeDecision,
      campaignId: campaigns.size === 1 ? [...campaigns][0] : null,
      recentSamples: group.recent.length,
      baselineSamples: group.baseline.length,
      recentMedianMs,
      recentP95Ms: percentile(group.recent, 0.95),
      baselineMedianMs,
      baselineP95Ms: percentile(group.baseline, 0.95),
      thresholdMs,
      ratio: baselineMedianMs > 0
        ? Number((recentMedianMs / baselineMedianMs).toFixed(2))
        : null,
    });
  }
  return { groupsEvaluated: groups.size, drifts };
}

async function loadLatencyRows(now = new Date()) {
  const from = new Date(
    now.getTime() - LATENCY_POLICY.recentWindowMs - LATENCY_POLICY.baselineWindowMs
  );
  return InferenceLog.find({
    timestamp: { $gte: from, $lte: now },
    status: 'success',
    durationMs: { $gt: 0 },
  })
    .select('timestamp durationMs host hostKey model caller taskType workItemId routeDecision')
    .sort({ timestamp: -1 })
    .limit(LATENCY_POLICY.maxRows)
    .lean();
}

async function scanLatencyDrift(options = {}) {
  const now = new Date(options.now || Date.now());
  try {
    const rows = options.rows || await loadLatencyRows(now);
    const result = findLatencyDrifts(rows, { now, policy: options.policy });
    let alertsMatched = 0;
    for (const drift of result.drifts) {
      const event = buildEvent(METRICS.LATENCY_DRIFT, drift, {
        detector: 'latency_drift',
        incidentKey: drift.key,
        value: drift.recentMedianMs,
        threshold: drift.thresholdMs,
        remediation: 'Compare the recent lane sample with its prior 24-hour baseline; check load, residency, and artifact identity before changing routing.',
        evidence: {
          recentSamples: drift.recentSamples,
          baselineSamples: drift.baselineSamples,
          recentMedianMs: drift.recentMedianMs,
          recentP95Ms: drift.recentP95Ms,
          baselineMedianMs: drift.baselineMedianMs,
          baselineP95Ms: drift.baselineP95Ms,
          ratio: drift.ratio,
        },
      });
      const evaluation = await evaluateEvents([event]);
      alertsMatched += evaluation.matched;
    }
    lastLatencyScan = {
      status: 'ok',
      scannedAt: now.toISOString(),
      groupsEvaluated: result.groupsEvaluated,
      drifts: result.drifts.length,
      alertsMatched,
    };
    return { ...lastLatencyScan, candidates: result.drifts };
  } catch (err) {
    lastLatencyScan = {
      status: 'error',
      scannedAt: now.toISOString(),
      groupsEvaluated: 0,
      drifts: 0,
      alertsMatched: 0,
    };
    logger.warn('[LaneObservability] latency scan failed', { error: err.message });
    return { ...lastLatencyScan };
  }
}

async function getStatusProjection() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [rules, alerts, coverage] = await Promise.all([
    AlertRule.find({ ruleId: { $in: RULE_IDS } })
      .select('ruleId name enabled severity channels renotifyMs description builtIn updatedAt')
      .sort({ ruleId: 1 })
      .lean(),
    Alert.find({ ruleId: { $in: RULE_IDS }, lastOccurrence: { $gte: since } })
      .select('ruleId severity status title message context fingerprint occurrenceCount notificationCount lastOccurrence delivery.local_log.sent delivery.local_log.sentAt')
      .sort({ lastOccurrence: -1 })
      .limit(50)
      .lean(),
    InferenceLog.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        attributed: { $sum: { $cond: [{ $eq: ['$routeDecision.decisionVersion', 1] }, 1, 0] } },
        fallback: { $sum: { $cond: ['$fallbackUsed', 1, 0] } },
        errors: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 0, 1] } },
      } },
    ]),
  ]);
  const totals = coverage?.[0] || { total: 0, attributed: 0, fallback: 0, errors: 0 };
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'observe_only',
    mutationBoundary: 'alerts_only',
    detectors: {
      metrics: METRICS,
      latencyPolicy: LATENCY_POLICY,
      lastLatencyScan,
    },
    inferenceCoverage24h: {
      ...totals,
      attributionRatePct: totals.total > 0
        ? Number(((totals.attributed / totals.total) * 100).toFixed(2))
        : 0,
    },
    rules,
    recentAlerts: alerts,
  };
}

function start() {
  if (firstScanTimer || scanInterval) return;
  const run = () => scanLatencyDrift().catch(() => {});
  firstScanTimer = setTimeout(() => {
    firstScanTimer = null;
    run();
  }, 60_000);
  scanInterval = setInterval(run, LATENCY_POLICY.scanIntervalMs);
  if (typeof firstScanTimer.unref === 'function') firstScanTimer.unref();
  if (typeof scanInterval.unref === 'function') scanInterval.unref();
}

function stop() {
  if (firstScanTimer) clearTimeout(firstScanTimer);
  if (scanInterval) clearInterval(scanInterval);
  firstScanTimer = null;
  scanInterval = null;
}

module.exports = {
  SCHEMA_VERSION,
  METRICS,
  RULE_IDS,
  LATENCY_POLICY,
  buildInferenceEvents,
  contractFingerprint,
  findLatencyDrifts,
  getStatusProjection,
  observeClaimReleaseFailure,
  observeInference,
  observePinRestoreFailure,
  scanLatencyDrift,
  summarizeOllamaOutcome,
  start,
  stop,
};

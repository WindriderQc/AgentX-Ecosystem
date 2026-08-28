'use strict';

/**
 * Public/operator read projection for InferenceLog.
 *
 * Old rows predate the payload-free routing contracts and may contain prompt,
 * message, response, or raw option previews inside Mixed fields. Never return a
 * Mongo row by spreading it. This explicit projection is the single boundary
 * used by every API that exposes individual inference rows.
 */

const {
  DECISION_MODES,
  normalizeHostKey,
  normalizeHostOriginUrl,
  normalizeOptionsFingerprint,
  normalizeStableReasonCode,
  projectRouteDecision,
} = require('./routeDecision');
const { sanitizeRoutingTrace } = require('./inferenceTelemetry');

const CALLERS = new Set(['chat', 'benchmark', 'embedding', 'classification', 'proxy', 'unknown']);
const RUNTIMES = new Set(['agentx', 'codex', 'claude-code', 'external', 'other']);
const STATUSES = new Set(['success', 'error', 'timeout']);
const LANES = new Set(['direct', 'interactive', 'automated']);
const MODES = new Set(Object.values(DECISION_MODES));
const NUM_CTX_SOURCES = new Set([
  'caller', 'modelfile', 'override', 'target_host_vram_estimate', 'context_test',
  'execution_default', 'fallback', 'host_preference_pin', 'profile', 'unresolved', 'n/a',
]);

function enumValue(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function operationalIdentifier(value, max = 200) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(trimmed)
    ? trimmed
    : null;
}

function safeOriginUrl(value) {
  return normalizeHostOriginUrl(value);
}

function safeHost(value) {
  const origin = safeOriginUrl(value);
  if (origin) return origin;
  if (typeof value !== 'string') return null;
  return normalizeHostKey(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function isCancellationEvidence(row) {
  const values = [
    row?.error,
    row?.fallbackReason,
    row?.routeDecision?.outcome?.code,
    row?.routeDecision?.outcome?.reasonCode,
  ];
  return values.some(value => typeof value === 'string' && (
    value === 'caller_disconnected'
    || /\bcancel(?:ed|led|lation)\b/i.test(value)
  ));
}

function safeTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

function stableReasonCode(value) {
  return normalizeStableReasonCode(value);
}

function sanitizeDecisionForRead(value) {
  const decidedAt = safeTimestamp(value?.decidedAt);
  const optionsFingerprint = normalizeOptionsFingerprint(value?.optionsFingerprint);
  const decision = projectRouteDecision(value);
  if (!decision) return null;

  // The builder supplies defaults for new writes. A read projection must not
  // invent a current timestamp or a default-options fingerprint for a malformed
  // legacy row because that would make retained junk look authoritative.
  decision.decidedAt = decidedAt;
  decision.optionsFingerprint = optionsFingerprint;
  decision.configVersion = operationalIdentifier(decision.configVersion, 64);
  decision.correlationId = operationalIdentifier(decision.correlationId, 160);
  decision.attribution.caller = enumValue(decision.attribution.caller, CALLERS) || 'unknown';
  // callerDetail is caller-controlled free text in legacy rows. It cannot be
  // distinguished reliably from a token-shaped payload at a public boundary.
  decision.attribution.callerDetail = null;
  decision.attribution.service = decision.attribution.service === 'core' ? 'core' : null;
  decision.attribution.runtime = enumValue(decision.attribution.runtime, RUNTIMES);
  decision.attribution.agentId = operationalIdentifier(decision.attribution.agentId, 160);
  decision.attribution.consumerContract = operationalIdentifier(decision.attribution.consumerContract, 160);
  decision.attribution.workItemId = operationalIdentifier(decision.attribution.workItemId, 160);
  decision.intent.taskType = operationalIdentifier(decision.intent.taskType, 64);
  decision.intent.profile = operationalIdentifier(decision.intent.profile, 64);
  decision.intent.mode = enumValue(decision.intent.mode, MODES) || DECISION_MODES.CHARACTERIZED;
  decision.policy.requested = operationalIdentifier(decision.policy.requested, 64);
  decision.policy.effective = operationalIdentifier(decision.policy.effective, 64);
  decision.policy.lane = enumValue(decision.policy.lane, LANES);

  for (const targetName of ['requested', 'primary', 'selected', 'actual']) {
    decision[targetName].model = operationalIdentifier(decision[targetName].model, 200);
    decision[targetName].host = normalizeHostKey(decision[targetName].host);
    decision[targetName].hostUrl = safeOriginUrl(decision[targetName].hostUrl);
  }
  decision.rejections = decision.rejections.map((rejection) => ({
    ...rejection,
    model: operationalIdentifier(rejection.model, 200),
    host: normalizeHostKey(rejection.host),
    hostUrl: safeOriginUrl(rejection.hostUrl),
  }));
  return decision;
}

function projectInferenceLog(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const projected = {
    ...(Object.prototype.hasOwnProperty.call(row, '_id') && { _id: operationalIdentifier(row._id, 100) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'host') && { host: safeHost(row.host) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'hostKey') && { hostKey: normalizeHostKey(row.hostKey) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'model') && { model: operationalIdentifier(row.model, 200) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'caller') && { caller: enumValue(row.caller, CALLERS) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'callerDetail') && { callerDetail: null }),
    ...(Object.prototype.hasOwnProperty.call(row, 'consumerContract') && { consumerContract: operationalIdentifier(row.consumerContract, 160) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'runtime') && { runtime: enumValue(row.runtime, RUNTIMES) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'correlationId') && { correlationId: operationalIdentifier(row.correlationId, 160) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'workItemId') && { workItemId: operationalIdentifier(row.workItemId, 160) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'attempt') && { attempt: finiteNumber(row.attempt) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'taskType') && { taskType: operationalIdentifier(row.taskType, 64) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'routed') && { routed: booleanOrNull(row.routed) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'autoRouted') && { autoRouted: booleanOrNull(row.autoRouted) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'classificationMs') && { classificationMs: finiteNumber(row.classificationMs) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'routedModel') && { routedModel: operationalIdentifier(row.routedModel, 200) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'routedHost') && { routedHost: normalizeHostKey(row.routedHost) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'routedHostUrl') && { routedHostUrl: safeOriginUrl(row.routedHostUrl) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'fallbackUsed') && { fallbackUsed: booleanOrNull(row.fallbackUsed) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'swapped') && { swapped: booleanOrNull(row.swapped) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'num_ctx') && { num_ctx: finiteNumber(row.num_ctx) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'num_ctx_source') && { num_ctx_source: enumValue(row.num_ctx_source, NUM_CTX_SOURCES) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'estimatedInputTokensAtDispatch') && { estimatedInputTokensAtDispatch: finiteNumber(row.estimatedInputTokensAtDispatch) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'tokensIn') && { tokensIn: finiteNumber(row.tokensIn) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'tokensOut') && { tokensOut: finiteNumber(row.tokensOut) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'durationMs') && { durationMs: finiteNumber(row.durationMs) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'status') && { status: enumValue(row.status, STATUSES) }),
    ...(Object.prototype.hasOwnProperty.call(row, 'timestamp') && { timestamp: safeTimestamp(row.timestamp) }),
    ...(isCancellationEvidence(row) && { cancelled: true }),
  };

  if (Object.prototype.hasOwnProperty.call(row, 'fallbackReason')) {
    projected.fallbackReason = stableReasonCode(row.fallbackReason);
  }
  if (Object.prototype.hasOwnProperty.call(row, 'error')) {
    // Error messages can contain arbitrary upstream bodies. Keep the response
    // shape but never return the retained message from a legacy row.
    projected.error = null;
  }
  if (Object.prototype.hasOwnProperty.call(row, 'routingTrace')) {
    projected.routingTrace = sanitizeRoutingTrace(row.routingTrace, { fingerprintRawOptions: false });
  }
  if (Object.prototype.hasOwnProperty.call(row, 'routeDecision')) {
    projected.routeDecision = sanitizeDecisionForRead(row.routeDecision);
  }
  return projected;
}

function projectInferenceLogs(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(projectInferenceLog).filter(Boolean);
}

module.exports = {
  projectInferenceLog,
  projectInferenceLogs,
  sanitizeDecisionForRead,
  stableReasonCode,
};

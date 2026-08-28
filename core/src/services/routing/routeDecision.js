'use strict';

/**
 * RouteDecision v1 — the versioned record of *why* a request went where it went.
 *
 * Task 0519. This module is the contract only: it defines stable field names,
 * normalizes an existing routing result into them, and refuses to carry
 * payload. It performs no selection and no I/O, so adopting it cannot change
 * which model or host a request lands on.
 *
 * Why a contract before the routing work: 0521/0522 rewrite selection and 0465
 * builds alerting on top of it. Both need names that are stable *before* the
 * behaviour underneath them moves. Today `routeRequest` returns four different
 * ad-hoc object shapes depending on which branch it took, which is exactly the
 * thing that makes routing unobservable.
 *
 * Field groups follow the request's own story:
 *   requested -> primary -> selected -> actual
 * `requested` is what the caller asked for (often nothing), `primary` is policy's
 * first choice, `selected` is what routing picked, and `actual` is what finally
 * served after any fallback. Collapsing these is what makes a fallback invisible
 * in aggregate: you see where traffic landed, never where it was meant to land.
 *
 * PRIVACY: a RouteDecision must never carry prompts, messages, transcripts, or
 * completions. `assertNoPayload` enforces that and is exercised by tests.
 */

const crypto = require('crypto');
const { boundedIdentifier, inferRuntime, positiveAttempt } = require('../../helpers/llmTelemetryContext');

const ROUTE_DECISION_VERSION = 1;

/**
 * Why a candidate was not selected. Stable strings — 0465 alerting and any
 * dashboard will group on these, so treat them as an API: add freely, never
 * rename or repurpose. `unknown` is the honest answer for decisions
 * characterized from paths that did not record a reason.
 */
const REJECTION_REASONS = Object.freeze({
  HOST_UNCONFIGURED: 'host_unconfigured',
  HOST_OFFLINE: 'host_offline',
  HOST_DRAINING: 'host_draining',
  HOST_BUSY: 'host_busy',
  MODEL_NOT_RESIDENT: 'model_not_resident',
  MODEL_NOT_INSTALLED: 'model_not_installed',
  INSUFFICIENT_VRAM: 'insufficient_vram',
  CONTEXT_TOO_SMALL: 'context_too_small',
  CAPABILITY_UNQUALIFIED: 'capability_unqualified',
  POLICY_EXCLUDED: 'policy_excluded',
  BENCHMARK_CLAIMED: 'benchmark_claimed',
  UNKNOWN: 'unknown',
});

const VALID_REJECTION_REASONS = new Set(Object.values(REJECTION_REASONS));

/** Selection modes. `characterized` marks a decision reconstructed from a legacy path. */
const DECISION_MODES = Object.freeze({
  EXPLICIT_MODEL: 'explicit_model',
  EXPLICIT_TASK: 'explicit_task',
  CLASSIFIED: 'classified',
  SHORT_CIRCUIT: 'classifier_short_circuit',
  DEFAULT: 'default',
  CHARACTERIZED: 'characterized',
});

/**
 * Terminal stages and outcome codes for the observable request path.
 *
 * These describe facts that have already been decided; they never participate
 * in selection. Keep the strings stable so response headers, structured logs,
 * and persisted inference attempts can be joined without parsing prose.
 */
const ROUTE_OUTCOME_STAGES = Object.freeze({
  VALIDATION: 'validation',
  POLICY: 'policy',
  SELECTION: 'selection',
  ADMISSION: 'admission',
  QUALIFICATION: 'qualification',
  EXECUTION: 'execution',
  FALLBACK: 'fallback',
  UNKNOWN: 'unknown',
});

const ROUTE_OUTCOME_CODES = Object.freeze({
  ROUTE_SELECTED: 'route_selected',
  EXECUTION_SUCCEEDED: 'execution_succeeded',
  REQUEST_TARGET_REQUIRED: 'request_target_required',
  REQUEST_PAYLOAD_REQUIRED: 'request_payload_required',
  HOST_OVERRIDE_REJECTED: 'host_override_rejected',
  DIRECT_MODEL_REQUIRED: 'direct_model_required',
  NO_HOST_AVAILABLE: 'no_host_available',
  BENCHMARK_CLAIMED: 'benchmark_claimed',
  ADAPTED_MODEL_RETIRED: 'adapted_model_retired',
  MODEL_PROFILE_REQUIRED: 'model_profile_required',
  ARTIFACT_QUALIFICATION_REQUIRED: 'artifact_qualification_required',
  PRE_DISPATCH_ERROR: 'pre_dispatch_error',
  CALLER_DISCONNECTED: 'caller_disconnected',
  UPSTREAM_ERROR: 'upstream_error',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  RESPONSE_PROCESSING_ERROR: 'response_processing_error',
  FALLBACK_SUCCEEDED: 'fallback_succeeded',
  FALLBACK_FAILED: 'fallback_failed',
  FALLBACK_REFUSED: 'fallback_refused',
  UNKNOWN: 'unknown',
});

const VALID_OUTCOME_STAGES = new Set(Object.values(ROUTE_OUTCOME_STAGES));
const VALID_OUTCOME_CODES = new Set(Object.values(ROUTE_OUTCOME_CODES));

/**
 * Values that are safe to expose as machine-readable reason codes.
 *
 * Older telemetry fields accepted prose and occasionally retained upstream
 * response bodies. A syntactic snake_case check is not sufficient because a
 * prompt can also be snake_case. Keep this vocabulary closed and extend it
 * deliberately when a new operational condition is introduced.
 */
const STABLE_REASON_CODES = new Set([
  ...Object.values(REJECTION_REASONS),
  ...Object.values(ROUTE_OUTCOME_CODES),
  'connection_failure',
  'pre_response_timeout',
  'upstream_unavailable',
  'missing_artifact_verified',
  'fallback_disabled',
  'lane_out_of_scope',
  'stream_already_started',
  'already_retried',
  'failure_not_retryable',
  'status_not_approved',
  'retry_execution_failed',
  'artifact_not_verified',
  'cross_model_route_not_managed',
  'cross_model_not_qualified',
  'no_local_candidate',
  'cloud_not_automatic',
  'classifier_skipped_equivalent_model_and_host',
  'host_swapping',
  'host_restoring',
  'actual_route_fallback',
  'invalid_upstream_response',
  'ollama_timeout',
  'ollama_upstream_error',
  'ollama_unavailable',
  'model_unavailable',
  'no_unclaimed_ollama_host',
  'benchmark_claim_active',
  'inference_pre_dispatch_error',
  'abort_error',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'ehostunreach',
  'enetunreach',
]);

const SELECTION_SOURCE_BASES = new Set([
  'model_router',
  'model-router',
  'model_target',
  'task_router',
  'scheduler',
  'scheduler-blocked',
  'fallback',
  'configured',
  'configured_host',
  'host_preference_pin',
  'host_override',
  'trusted_host_override',
]);
const SELECTION_SOURCE_SUFFIXES = new Set([
  'pin-ctx',
  'degraded-fallback',
  'degraded-cross-model',
]);

const OPERATIONAL_RUNTIME_OPTION_KEYS = new Set([
  'frequency_penalty', 'low_vram', 'main_gpu', 'min_p', 'mirostat',
  'mirostat_eta', 'mirostat_tau', 'num_batch', 'num_ctx', 'num_gpu',
  'num_predict', 'num_thread', 'numa', 'penalize_newline',
  'presence_penalty', 'repeat_last_n', 'repeat_penalty', 'seed',
  'temperature', 'tfs_z', 'top_k', 'top_p', 'typical_p', 'use_mlock',
  'use_mmap', 'vocab_only',
]);

/**
 * Keys that must never appear in a decision, at any depth. Prompt text leaking
 * into routing telemetry would quietly turn a 30-day operational log into a
 * 30-day transcript archive.
 */
const FORBIDDEN_KEYS = Object.freeze([
  'prompt', 'prompts', 'message', 'messages', 'transcript', 'transcripts',
  'completion', 'completions', 'response', 'content', 'text', 'input', 'output',
  'system', 'context',
]);

function trimmedOrNull(value, max = 200) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function nonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function normalizeHostKey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(normalized)
    ? normalized
    : null;
}

function normalizeHostOriginUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && parsed.pathname === '/'
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** A model+host pair. Always present as an object so consumers need no null checks. */
function target(model, host, hostUrl) {
  return {
    model: trimmedOrNull(model),
    host: normalizeHostKey(host),
    hostUrl: normalizeHostOriginUrl(hostUrl),
  };
}

function normalizeRejections(rejections) {
  if (!Array.isArray(rejections)) return [];
  return rejections.slice(0, 50).map((entry) => {
    const reason = trimmedOrNull(entry?.reason, 64);
    return {
      ...target(entry?.model, entry?.host, entry?.hostUrl),
      reason: VALID_REJECTION_REASONS.has(reason) ? reason : REJECTION_REASONS.UNKNOWN,
    };
  });
}

function normalizeStableReasonCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (STABLE_REASON_CODES.has(normalized)) return normalized;
  if (/^upstream_(?:http|status)_[1-5][0-9]{2}$/.test(normalized)) return normalized;
  if (/^fetch_timeout_[1-9][0-9]{0,8}ms$/.test(normalized)) return normalized;
  return null;
}

function normalizeSelectionSource(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('+');
  if (!SELECTION_SOURCE_BASES.has(parts[0])) return null;
  if (parts.length > 3 || parts.slice(1).some((part) => !SELECTION_SOURCE_SUFFIXES.has(part))) {
    return null;
  }
  return parts.join('+');
}

function normalizeOptionsFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{16}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function normalizeOutcome(input = {}) {
  const stage = trimmedOrNull(input.stage, 32);
  const code = trimmedOrNull(input.code, 64);
  return {
    stage: VALID_OUTCOME_STAGES.has(stage) ? stage : ROUTE_OUTCOME_STAGES.UNKNOWN,
    code: VALID_OUTCOME_CODES.has(code) ? code : ROUTE_OUTCOME_CODES.UNKNOWN,
    reasonCode: normalizeStableReasonCode(input.reasonCode),
  };
}

/**
 * Stable fingerprint of the runtime options actually sent upstream.
 *
 * Options are what make an otherwise identical (model, host) pair behave
 * differently — a `num_ctx` change forces a runner rebuild and a multi-minute
 * stall. Comparing whole option objects across requests is noisy, so we hash a
 * canonical key-sorted form: equal fingerprint means equal effective runtime.
 *
 * Only an explicit set of operational boolean/numeric knobs participates.
 * Content-bearing strings and arrays (for example stop sequences or grammars)
 * are ignored, so the digest cannot become an equality oracle for payload.
 */
function fingerprintRuntimeOptions(options) {
  const normalized = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const keys = Object.keys(normalized)
    .filter((key) => OPERATIONAL_RUNTIME_OPTION_KEYS.has(key))
    .filter((key) => typeof normalized[key] === 'boolean'
      || (typeof normalized[key] === 'number' && Number.isFinite(normalized[key])))
    .sort();
  const canonical = keys.length
    ? keys.map((key) => `${key}=${JSON.stringify(normalized[key])}`).join('\u0000')
    : '__agentx_runtime_defaults__';
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Throw if a decision carries request or response payload.
 *
 * Deliberately strict and recursive. A privacy guarantee that is only honoured
 * by the code path that existed when it was written is not a guarantee.
 */
function assertNoPayload(decision, path = 'routeDecision') {
  if (decision == null || typeof decision !== 'object') return;
  if (Array.isArray(decision)) {
    decision.forEach((entry, index) => assertNoPayload(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(decision)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      const err = new Error(`RouteDecision must not carry payload: ${path}.${key}`);
      err.code = 'ROUTE_DECISION_PAYLOAD_LEAK';
      throw err;
    }
    assertNoPayload(value, `${path}.${key}`);
  }
}

/**
 * Build a RouteDecision v1.
 *
 * Every field is normalized here rather than at the call sites, so a caller that
 * knows less simply produces a decision with more nulls — never a differently
 * shaped one. That is what lets 0465 alert on `actual.host` without first
 * asking which code path produced the row.
 */
function buildRouteDecision(input = {}) {
  const selected = target(
    input.selectedModel ?? input.model,
    input.selectedHost ?? input.host,
    input.selectedHostUrl ?? input.hostUrl ?? input.target,
  );

  // `actual` defaults to `selected`: with no fallback they are the same, and a
  // null `actual` would force every consumer to re-implement that fallback rule.
  const actual = target(
    input.actualModel ?? selected.model,
    input.actualHost ?? selected.host,
    input.actualHostUrl ?? selected.hostUrl,
  );

  const fallbackUsed = Boolean(input.fallbackUsed)
    || actual.model !== selected.model
    || actual.hostUrl !== selected.hostUrl;

  const decision = {
    decisionVersion: ROUTE_DECISION_VERSION,
    configVersion: trimmedOrNull(input.configVersion, 64),
    correlationId: boundedIdentifier(input.correlationId),
    decidedAt: (input.decidedAt instanceof Date ? input.decidedAt : new Date()).toISOString(),

    attribution: {
      caller: trimmedOrNull(input.caller, 64) || 'unknown',
      callerDetail: boundedIdentifier(input.callerDetail),
      service: trimmedOrNull(input.service, 64) || 'core',
      runtime: inferRuntime(input.runtime || input.callerDetail, 'agentx'),
      agentId: boundedIdentifier(input.agentId),
      consumerContract: boundedIdentifier(input.consumerContract),
      workItemId: boundedIdentifier(input.workItemId),
    },

    intent: {
      taskType: trimmedOrNull(input.taskType, 64),
      profile: trimmedOrNull(input.profile, 64),
      mode: trimmedOrNull(input.mode, 32) || DECISION_MODES.CHARACTERIZED,
    },

    selectionSource: normalizeSelectionSource(input.selectionSource),
    policy: {
      requested: trimmedOrNull(input.requestedPolicy, 64),
      effective: trimmedOrNull(input.effectivePolicy, 64),
      lane: trimmedOrNull(input.effectiveLane, 32),
      downgraded: Boolean(input.policyDowngraded),
    },
    outcome: normalizeOutcome({
      stage: input.outcomeStage,
      code: input.outcomeCode,
      reasonCode: input.outcomeReasonCode,
    }),

    requested: target(input.requestedModel, input.requestedHost, input.requestedHostUrl),
    primary: target(input.primaryModel, input.primaryHost, input.primaryHostUrl),
    selected,
    actual,

    rejections: normalizeRejections(input.rejections),
    optionsFingerprint: normalizeOptionsFingerprint(input.optionsFingerprint)
      || fingerprintRuntimeOptions(input.runtimeOptions),

    attempt: positiveAttempt(input.attempt),
    fallbackUsed,
    fallbackReason: normalizeStableReasonCode(input.fallbackReason),
    degraded: Boolean(input.degraded),
    degradedReason: normalizeStableReasonCode(input.degradedReason),

    latency: {
      classificationMs: nonNegativeInt(input.classificationMs),
      decisionMs: nonNegativeInt(input.decisionMs),
      totalMs: nonNegativeInt(input.totalMs ?? input.durationMs),
    },
  };

  assertNoPayload(decision);
  return decision;
}

/**
 * Convert an existing decision-shaped value back through the strict v1
 * builder. This is intentionally an allowlist: legacy rows and hand-built
 * caller objects may contain fields that were never part of RouteDecision.
 */
function projectRouteDecision(decision, overrides = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null;

  const decidedAt = decision.decidedAt instanceof Date
    ? decision.decidedAt
    : (Number.isNaN(new Date(decision.decidedAt).getTime()) ? undefined : new Date(decision.decidedAt));

  return buildRouteDecision({
    configVersion: decision.configVersion,
    correlationId: decision.correlationId,
    decidedAt,
    caller: decision.attribution?.caller,
    callerDetail: decision.attribution?.callerDetail,
    service: decision.attribution?.service,
    runtime: decision.attribution?.runtime,
    agentId: decision.attribution?.agentId,
    consumerContract: decision.attribution?.consumerContract,
    workItemId: decision.attribution?.workItemId,
    taskType: decision.intent?.taskType,
    profile: decision.intent?.profile,
    mode: decision.intent?.mode,
    selectionSource: decision.selectionSource,
    requestedPolicy: decision.policy?.requested,
    effectivePolicy: decision.policy?.effective,
    effectiveLane: decision.policy?.lane,
    policyDowngraded: decision.policy?.downgraded,
    outcomeStage: decision.outcome?.stage,
    outcomeCode: decision.outcome?.code,
    outcomeReasonCode: decision.outcome?.reasonCode,
    requestedModel: decision.requested?.model,
    requestedHost: decision.requested?.host,
    requestedHostUrl: decision.requested?.hostUrl,
    primaryModel: decision.primary?.model,
    primaryHost: decision.primary?.host,
    primaryHostUrl: decision.primary?.hostUrl,
    selectedModel: decision.selected?.model,
    selectedHost: decision.selected?.host,
    selectedHostUrl: decision.selected?.hostUrl,
    actualModel: decision.actual?.model,
    actualHost: decision.actual?.host,
    actualHostUrl: decision.actual?.hostUrl,
    rejections: decision.rejections,
    optionsFingerprint: decision.optionsFingerprint,
    attempt: decision.attempt,
    fallbackUsed: decision.fallbackUsed,
    fallbackReason: decision.fallbackReason,
    degraded: decision.degraded,
    degradedReason: decision.degradedReason,
    classificationMs: decision.latency?.classificationMs,
    decisionMs: decision.latency?.decisionMs,
    totalMs: decision.latency?.totalMs,
    ...overrides,
  });
}

/**
 * Turn a pre-execution selection decision into the terminal fact persisted for
 * a completed attempt. This never participates in routing; it only corrects
 * telemetry after the upstream attempt has succeeded, failed, or timed out.
 */
function finalizeRouteDecision(decision, {
  status, durationMs, reasonCode, outcomeStage, outcomeCode
} = {}) {
  if (!decision) return null;

  const terminalCode = outcomeCode || (status === 'success'
    ? ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED
    : status === 'timeout'
      ? ROUTE_OUTCOME_CODES.UPSTREAM_TIMEOUT
      : status === 'error'
        ? ROUTE_OUTCOME_CODES.UPSTREAM_ERROR
        : decision.outcome?.code);

  return projectRouteDecision(decision, {
    outcomeStage: outcomeStage || ROUTE_OUTCOME_STAGES.EXECUTION,
    outcomeCode: terminalCode,
    outcomeReasonCode: normalizeStableReasonCode(reasonCode ?? decision.outcome?.reasonCode),
    totalMs: durationMs ?? decision.latency?.totalMs,
  });
}

/**
 * Characterize a legacy `modelRouter.routeRequest` result as a RouteDecision.
 *
 * 0519 is explicitly "characterize existing paths without changing selection",
 * so this is a read-only adapter over the four shapes `routeRequest` currently
 * returns. It infers `mode` from the flags those branches already set rather
 * than requiring them to be rewritten.
 */
function characterizeRouteRequest(result = {}, context = {}) {
  let mode = DECISION_MODES.DEFAULT;
  if (result.taskType === 'user_specified') mode = DECISION_MODES.EXPLICIT_MODEL;
  else if (result.shortCircuited) mode = DECISION_MODES.SHORT_CIRCUIT;
  else if (result.autoRouted) mode = DECISION_MODES.CLASSIFIED;
  else if (result.routed) mode = DECISION_MODES.EXPLICIT_TASK;

  // A host mid-swap is a real degraded state the old shape only hinted at with
  // a loose `hostBusy` flag; name it so it can be alerted on.
  const degraded = Boolean(result.hostBusy);

  return buildRouteDecision({
    ...context,
    mode,
    taskType: result.taskType,
    selectionSource: result.source || 'model_router',
    outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
    outcomeCode: ROUTE_OUTCOME_CODES.ROUTE_SELECTED,
    selectedModel: result.model,
    selectedHost: result.host,
    selectedHostUrl: result.target,
    requestedModel: mode === DECISION_MODES.EXPLICIT_MODEL ? result.model : context.requestedModel,
    classificationMs: result.classificationMs,
    degraded,
    degradedReason: result.shortCircuitReason
      || (degraded ? `host_${trimmedOrNull(result.hostStatus, 32) || 'busy'}` : null),
    rejections: degraded
      ? [{ model: result.model, host: result.host, reason: REJECTION_REASONS.HOST_BUSY }]
      : context.rejections,
  });
}

module.exports = {
  ROUTE_DECISION_VERSION,
  REJECTION_REASONS,
  DECISION_MODES,
  ROUTE_OUTCOME_STAGES,
  ROUTE_OUTCOME_CODES,
  FORBIDDEN_KEYS,
  buildRouteDecision,
  projectRouteDecision,
  finalizeRouteDecision,
  characterizeRouteRequest,
  fingerprintRuntimeOptions,
  normalizeOptionsFingerprint,
  normalizeHostKey,
  normalizeHostOriginUrl,
  normalizeSelectionSource,
  normalizeStableReasonCode,
  assertNoPayload,
};

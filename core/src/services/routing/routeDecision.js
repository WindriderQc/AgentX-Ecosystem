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
  DEFAULT: 'default',
  CHARACTERIZED: 'characterized',
});

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

/** A model+host pair. Always present as an object so consumers need no null checks. */
function target(model, host, hostUrl) {
  return {
    model: trimmedOrNull(model),
    host: trimmedOrNull(host, 64),
    hostUrl: trimmedOrNull(hostUrl),
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

/**
 * Stable fingerprint of the runtime options actually sent upstream.
 *
 * Options are what make an otherwise identical (model, host) pair behave
 * differently — a `num_ctx` change forces a runner rebuild and a multi-minute
 * stall. Comparing whole option objects across requests is noisy, so we hash a
 * canonical key-sorted form: equal fingerprint means equal effective runtime.
 *
 * Values are stringified, never inspected, and the digest is truncated: this is
 * an equality token, not a secret and not a reversible record.
 */
function fingerprintRuntimeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const keys = Object.keys(options).filter((key) => options[key] !== undefined).sort();
  if (!keys.length) return null;
  const canonical = keys.map((key) => `${key}=${JSON.stringify(options[key])}`).join('\u0000');
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

    requested: target(input.requestedModel, input.requestedHost, input.requestedHostUrl),
    primary: target(input.primaryModel, input.primaryHost, input.primaryHostUrl),
    selected,
    actual,

    rejections: normalizeRejections(input.rejections),
    optionsFingerprint: input.optionsFingerprint
      ? trimmedOrNull(input.optionsFingerprint, 64)
      : fingerprintRuntimeOptions(input.runtimeOptions),

    attempt: positiveAttempt(input.attempt),
    fallbackUsed,
    fallbackReason: trimmedOrNull(input.fallbackReason, 200),
    degraded: Boolean(input.degraded),
    degradedReason: trimmedOrNull(input.degradedReason, 200),

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
  else if (result.autoRouted) mode = DECISION_MODES.CLASSIFIED;
  else if (result.routed) mode = DECISION_MODES.EXPLICIT_TASK;

  // A host mid-swap is a real degraded state the old shape only hinted at with
  // a loose `hostBusy` flag; name it so it can be alerted on.
  const degraded = Boolean(result.hostBusy);

  return buildRouteDecision({
    ...context,
    mode,
    taskType: result.taskType,
    selectedModel: result.model,
    selectedHost: result.host,
    selectedHostUrl: result.target,
    requestedModel: mode === DECISION_MODES.EXPLICIT_MODEL ? result.model : context.requestedModel,
    classificationMs: result.classificationMs,
    degraded,
    degradedReason: degraded ? `host_${trimmedOrNull(result.hostStatus, 32) || 'busy'}` : null,
    rejections: degraded
      ? [{ model: result.model, host: result.host, reason: REJECTION_REASONS.HOST_BUSY }]
      : context.rejections,
  });
}

module.exports = {
  ROUTE_DECISION_VERSION,
  REJECTION_REASONS,
  DECISION_MODES,
  FORBIDDEN_KEYS,
  buildRouteDecision,
  characterizeRouteRequest,
  fingerprintRuntimeOptions,
  assertNoPayload,
};

// memoryReview/policy.js — vocabulary, bounds, mode gate, and strict payload
// validation for the Ecosystem Memory Review capability.
//
// Mirrors scripts/memory_review/schema.py (the collector-side copy). If you
// change an enum or bound, change both and the tests that pin them.
// Memory-review policy boundary.

const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const POLICY_VERSION = 'memory-policy-v2.0';

const RUNTIMES = ['agentx', 'claude-code', 'codex', 'external'];
const RECONCILIATION_GRACE_MINUTES = 120;

// Older private compositions could persist their adapter-local runtime name
// before the public boundary was narrowed to the generic `external` owner.
// New API writes are still validated strictly against RUNTIMES; this read-side
// normalization exists only so durable historical rows cannot reintroduce
// retired private runtime categories into current Product health.
function publicRuntime(runtime) {
  const value = String(runtime || '').trim();
  if (!value) return null;
  return RUNTIMES.includes(value) ? value : 'external';
}

const TRUST_ELIGIBLE = [
  'explicit_owner_instruction',
  'explicit_memory_request',
  'authenticated_owner_statement',
  'repeated_owner_preference',
  'verified_runtime_evidence',
  'observed_project_event',
  'verified_git_or_test_outcome',
];
const TRUST_INELIGIBLE = [
  'assistant_claim', 'tool_output', 'recalled_context', 'cron_or_automation',
  'subagent', 'non_owner_user', 'pasted_or_attached_content',
  'web_or_email_content', 'unknown', 'system',
];
const TRUST_CLASSES = [...TRUST_ELIGIBLE, ...TRUST_INELIGIBLE];

// V2 admits authenticated owner observations from scoped producer collectors,
// while keeping generic role=user assertions ineligible. Admission is not
// promotion: Core still separates explicit facts, recurrent inferences,
// project events, and human exceptions through automationDecision().
const CENTRAL_SUBMISSION_TRUST = [
  'explicit_memory_request',
  'authenticated_owner_statement',
  'verified_runtime_evidence',
  'observed_project_event',
  'verified_git_or_test_outcome',
];

const CANDIDATE_TYPES = [
  'preference', 'durable_fact', 'decision', 'correction', 'procedure',
  'inferred_pattern', 'project_event', 'reusable_skill_candidate', 'session_summary', 'duplicate', 'stale_memory',
  'contradiction', 'task_or_followup', 'governed_source_change', 'ephemeral',
  'sensitive_or_secret', 'unsupported',
];

const TARGET_KINDS = [
  'shared_fact', 'soft_memory', 'artifact', 'runtime_local', 'skill_draft',
  'pipeline_task', 'git_change', 'ignore',
];

// The synthesis model may classify and suggest scope, but it cannot route a
// candidate to an arbitrary write adapter. Core owns this deterministic
// type-to-target membrane and rechecks it again immediately before apply.
const TARGETS_BY_TYPE = Object.freeze({
  preference: ['shared_fact', 'runtime_local'],
  durable_fact: ['shared_fact', 'runtime_local'],
  decision: ['shared_fact', 'runtime_local'],
  correction: ['shared_fact', 'runtime_local'],
  inferred_pattern: ['soft_memory'],
  project_event: ['artifact'],
  procedure: ['artifact'],
  reusable_skill_candidate: ['skill_draft'],
  session_summary: ['artifact'],
  duplicate: ['ignore'],
  stale_memory: ['ignore'],
  contradiction: ['ignore'],
  task_or_followup: ['pipeline_task'],
  governed_source_change: ['git_change'],
  ephemeral: ['ignore'],
  sensitive_or_secret: ['ignore'],
  unsupported: ['ignore'],
});

// Which target kinds have a semantic apply adapter at all. runtime_local /
// git_change / skill_draft never write anywhere in this build: their "apply"
// produces a proposal payload or a pipeline task, handled in applyService.
const APPLY_ADAPTERS = ['shared_fact', 'soft_memory', 'artifact', 'pipeline_task', 'runtime_local', 'git_change', 'skill_draft'];

const MEMORY_SCOPES = ['project', 'ecosystem', 'workflow', 'owner', 'household', 'private_domain'];
const SENSITIVITY_LEVELS = ['normal', 'private', 'highly_private'];
const IMPACT_LEVELS = ['context_only', 'behavior_changing', 'operational'];
const STABILITY_LEVELS = ['transient', 'episodic', 'durable'];
const AUTOMATION_DISPOSITIONS = ['auto_apply', 'soft_store', 'review', 'ignore'];

const RUN_STATUSES = [
  'collecting', 'synthesizing', 'ready_for_review', 'partially_reviewed',
  'completed', 'failed',
];
const CANDIDATE_STATUSES = [
  'proposed', 'approved', 'auto_approved', 'rejected', 'edited', 'deferred',
  'parked', 'shadowed', 'applying', 'applied', 'apply_failed',
];
const REVIEW_ACTIONS = ['approve', 'reject', 'defer', 'edit_approve'];

// Bounds — raw transcript payloads must be structurally impossible.
const LIMITS = Object.freeze({
  OBSERVATION_TEXT_MAX: 1200,
  EXCERPT_MAX: 280,
  STATEMENT_MAX: 500,
  RATIONALE_MAX: 500,
  MAX_OBSERVATIONS_PER_BATCH: 200,
  MAX_OBSERVATIONS_PER_RUN: 500,
  MAX_CANDIDATES_PER_RUN: 30,
  MAX_EVIDENCE_PER_CANDIDATE: 20,
  MAX_DEDUP_CONTEXT_LINES: 60,
  MAX_AUDIT_ENTRIES: 400,
  MAX_REVIEW_EXCEPTIONS: 5,
});

// Server mode gate. Missing/invalid env NEVER implies apply.
function serverMode() {
  const raw = String(process.env.MEMORY_REVIEW_MODE || '').trim().toLowerCase();
  return ['shadow', 'review', 'apply'].includes(raw) ? raw : 'shadow';
}

// A standing policy replaces per-item approval only for reversible, bounded
// writes. Both switches are required for real automation. `shadow` evaluates
// and records policy decisions without writing; invalid/missing values fail
// closed to `off`.
function automationMode() {
  const raw = String(process.env.MEMORY_REVIEW_AUTOMATION_MODE || '').trim().toLowerCase();
  return ['off', 'shadow', 'safe'].includes(raw) ? raw : 'off';
}

function reviewExceptionBudget() {
  const raw = Number(process.env.MEMORY_REVIEW_EXCEPTION_BUDGET);
  if (!Number.isFinite(raw)) return LIMITS.MAX_REVIEW_EXCEPTIONS;
  return Math.max(1, Math.min(LIMITS.MAX_REVIEW_EXCEPTIONS, Math.trunc(raw)));
}

function normalizeText(text) {
  return String(text == null ? '' : text).normalize('NFC').replace(/\s+/g, ' ').trim();
}

function contentHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text).toLowerCase()).digest('hex');
}

function candidateId(type, statement) {
  return crypto.createHash('sha256')
    .update(`${type}\n${normalizeText(statement).toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

function cleanRunKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80);
}

// Reconciliation state is derived from the run itself. It deliberately adds
// no second timer, queue, or persistence model: the UI, digest, and scheduler
// all consume the same deterministic interpretation of an unfinished run.
function reconciliationStatus(run, now = new Date()) {
  const status = String(run?.status || '');
  const active = ['collecting', 'synthesizing'].includes(status);
  const contributedRuntimes = [...new Set((run?.collectors || [])
    .map((collector) => publicRuntime(collector.runtime))
    .filter(Boolean))];
  const missingRuntimes = RUNTIMES.filter((runtime) => !contributedRuntimes.includes(runtime));
  const createdAt = run?.createdAt ? new Date(run.createdAt) : null;
  const nowAt = new Date(now);
  const ageMinutes = createdAt && Number.isFinite(createdAt.getTime()) && Number.isFinite(nowAt.getTime())
    ? Math.max(0, Math.floor((nowAt.getTime() - createdAt.getTime()) / 60000))
    : null;
  return {
    active,
    stage: status || null,
    ageMinutes,
    overdue: active && ageMinutes != null && ageMinutes >= RECONCILIATION_GRACE_MINUTES,
    contributedRuntimes,
    missingRuntimes,
  };
}

class MemoryReviewError extends Error {
  constructor(message, { status = 400, code = 'MEMORY_REVIEW_ERROR' } = {}) {
    super(message);
    this.name = 'MemoryReviewError';
    this.status = status;
    this.code = code;
  }
}

function assertKnownKeys(obj, allowed, where) {
  const extra = Object.keys(obj || {}).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw new MemoryReviewError(`${where} has unknown fields: ${extra.join(', ')}`, {
      code: 'MEMORY_REVIEW_UNKNOWN_FIELDS',
    });
  }
}

function validateTargetForType(type, target, where = 'candidate.target') {
  const allowed = TARGETS_BY_TYPE[type] || [];
  if (!allowed.includes(target.kind)) {
    throw new MemoryReviewError(
      `${where}.kind '${target.kind}' is not allowed for candidate type '${type}'`,
      { code: 'MEMORY_REVIEW_TARGET_POLICY' }
    );
  }
  if (target.kind === 'runtime_local' && !RUNTIMES.includes(target.runtime)) {
    throw new MemoryReviewError(`${where}.runtime is required for runtime_local`, {
      code: 'MEMORY_REVIEW_TARGET_POLICY',
    });
  }
  if (target.kind !== 'runtime_local' && target.runtime != null) {
    throw new MemoryReviewError(`${where}.runtime is only valid for runtime_local`, {
      code: 'MEMORY_REVIEW_TARGET_POLICY',
    });
  }
  return target;
}

const OBSERVATION_KEYS = [
  'runtime', 'host', 'agentOrProfile', 'project', 'sessionId', 'eventId',
  'observedAt', 'trust', 'taints', 'text', 'sourceRef', 'contentHash',
];

// Fields whose presence marks a raw-transcript-style payload. The API refuses
// them outright — collectors sanitize at the edge; the center never accepts raw.
const TRANSCRIPT_SHAPE_KEYS = [
  'transcript', 'messages', 'events', 'conversation', 'history', 'raw', 'jsonl',
];

function validateObservation(input, index) {
  const where = `observations[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MemoryReviewError(`${where} must be an object`);
  }
  for (const key of TRANSCRIPT_SHAPE_KEYS) {
    if (key in input) {
      throw new MemoryReviewError(
        `${where}.${key}: raw transcript payloads are not accepted`,
        { code: 'MEMORY_REVIEW_RAW_TRANSCRIPT_REFUSED' }
      );
    }
  }
  assertKnownKeys(input, OBSERVATION_KEYS, where);
  if (!RUNTIMES.includes(input.runtime)) {
    throw new MemoryReviewError(`${where}.runtime invalid`);
  }
  if (!TRUST_CLASSES.includes(input.trust)) {
    throw new MemoryReviewError(`${where}.trust invalid`);
  }
  if (!CENTRAL_SUBMISSION_TRUST.includes(input.trust)) {
    throw new MemoryReviewError(
      `${where}.trust '${input.trust}' is not eligible for central submission`,
      { code: 'MEMORY_REVIEW_INELIGIBLE_TRUST' }
    );
  }
  const text = String(input.text || '');
  if (!text.trim()) throw new MemoryReviewError(`${where}.text is required`);
  if (text.length > LIMITS.OBSERVATION_TEXT_MAX) {
    throw new MemoryReviewError(
      `${where}.text exceeds ${LIMITS.OBSERVATION_TEXT_MAX} chars`,
      { code: 'MEMORY_REVIEW_OVERSIZE' }
    );
  }
  return {
    runtime: input.runtime,
    host: String(input.host || 'unknown-host').slice(0, 64),
    agentOrProfile: input.agentOrProfile ? String(input.agentOrProfile).slice(0, 64) : null,
    project: input.project ? String(input.project).slice(0, 128) : null,
    sessionId: String(input.sessionId || '').slice(0, 128),
    eventId: String(input.eventId || '').slice(0, 128),
    observedAt: String(input.observedAt || '').slice(0, 40),
    trust: input.trust,
    taints: Array.isArray(input.taints) ? input.taints.map((t) => String(t).slice(0, 40)).slice(0, 8) : [],
    text: text.trim(),
    sourceRef: String(input.sourceRef || '').slice(0, 256),
    contentHash: contentHash(text),
  };
}

const CANDIDATE_KEYS = [
  'type', 'statement', 'rationale', 'target', 'evidenceRefs', 'confidence', 'conflicts',
  'scope', 'sensitivity', 'impact', 'stability', 'validFrom', 'validTo', 'memoryKey',
];
const TARGET_KEYS = ['kind', 'runtime', 'topic'];

function boundedEnum(value, allowed, fallback, where) {
  if (value == null || value === '') return fallback;
  if (!allowed.includes(value)) throw new MemoryReviewError(`${where} invalid: ${value}`);
  return value;
}

function boundedIsoDate(value, where) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const parsed = new Date(raw);
  if (raw.length > 40 || !Number.isFinite(parsed.getTime())) {
    throw new MemoryReviewError(`${where} must be an ISO date/time`);
  }
  return parsed.toISOString();
}

function defaultImpact(type) {
  return ['task_or_followup', 'governed_source_change', 'reusable_skill_candidate'].includes(type)
    ? 'behavior_changing' : 'context_only';
}

function defaultStability(type) {
  if (type === 'inferred_pattern') return 'transient';
  if (['project_event', 'session_summary'].includes(type)) return 'episodic';
  return 'durable';
}

function validateCandidateInput(input, index, knownObservationIds) {
  const where = `candidates[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MemoryReviewError(`${where} must be an object`);
  }
  assertKnownKeys(input, CANDIDATE_KEYS, where);
  if (!CANDIDATE_TYPES.includes(input.type)) {
    throw new MemoryReviewError(`${where}.type invalid: ${input.type}`);
  }
  const statement = normalizeText(input.statement);
  if (!statement) throw new MemoryReviewError(`${where}.statement is required`);
  if (statement.length > LIMITS.STATEMENT_MAX) {
    throw new MemoryReviewError(`${where}.statement exceeds ${LIMITS.STATEMENT_MAX} chars`);
  }
  const target = input.target || {};
  assertKnownKeys(target, TARGET_KEYS, `${where}.target`);
  if (!TARGET_KINDS.includes(target.kind)) {
    throw new MemoryReviewError(`${where}.target.kind invalid: ${target.kind}`);
  }
  if (target.runtime != null && !RUNTIMES.includes(target.runtime)) {
    throw new MemoryReviewError(`${where}.target.runtime invalid`);
  }
  validateTargetForType(input.type, target, `${where}.target`);
  const refs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(String) : [];
  if (!refs.length) throw new MemoryReviewError(`${where}.evidenceRefs must be non-empty`);
  for (const ref of refs) {
    if (!knownObservationIds.has(ref)) {
      throw new MemoryReviewError(`${where} cites unknown evidence ref ${ref}`, {
        code: 'MEMORY_REVIEW_UNKNOWN_EVIDENCE',
      });
    }
  }
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new MemoryReviewError(`${where}.confidence must be within [0,1]`);
  }
  const scope = boundedEnum(input.scope, MEMORY_SCOPES, 'project', `${where}.scope`);
  const defaultSensitivity = ['owner', 'household', 'private_domain'].includes(scope) ? 'private' : 'normal';
  const validFrom = boundedIsoDate(input.validFrom, `${where}.validFrom`);
  const validTo = boundedIsoDate(input.validTo, `${where}.validTo`);
  if (validFrom && validTo && new Date(validTo) <= new Date(validFrom)) {
    throw new MemoryReviewError(`${where}.validTo must be later than validFrom`);
  }
  return {
    type: input.type,
    statement,
    rationale: normalizeText(input.rationale).slice(0, LIMITS.RATIONALE_MAX),
    target: {
      kind: target.kind,
      runtime: target.runtime || null,
      topic: target.topic ? normalizeText(target.topic).slice(0, 64) : null,
    },
    evidenceRefs: refs.slice(0, LIMITS.MAX_EVIDENCE_PER_CANDIDATE),
    confidence: Math.round(confidence * 1000) / 1000,
    scope,
    sensitivity: boundedEnum(
      input.sensitivity, SENSITIVITY_LEVELS, defaultSensitivity, `${where}.sensitivity`
    ),
    impact: boundedEnum(input.impact, IMPACT_LEVELS, defaultImpact(input.type), `${where}.impact`),
    stability: boundedEnum(
      input.stability, STABILITY_LEVELS, defaultStability(input.type), `${where}.stability`
    ),
    validFrom,
    validTo,
    memoryKey: cleanRunKey(input.memoryKey || '').slice(0, 80) || null,
    conflicts: (Array.isArray(input.conflicts) ? input.conflicts : [])
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        authority: String(c.authority || 'prior_review').slice(0, 32),
        sourceRef: String(c.sourceRef || '').slice(0, 200),
        summary: normalizeText(c.summary).slice(0, 300),
      }))
      .slice(0, 5),
  };
}

function evidenceTrusts(candidate) {
  return [...new Set((candidate.evidence || []).map((item) => item.trust).filter(Boolean))];
}

function evidenceClass(candidate) {
  const trusts = evidenceTrusts(candidate);
  if (trusts.includes('explicit_memory_request')) return 'explicit';
  if (trusts.includes('authenticated_owner_statement') || trusts.includes('repeated_owner_preference')) {
    return 'owner_observed';
  }
  if (trusts.includes('verified_runtime_evidence')) return 'runtime_verified';
  if (trusts.includes('observed_project_event') || trusts.includes('verified_git_or_test_outcome')) {
    return 'project_observed';
  }
  return 'unknown';
}

// The model proposes meaning; Core alone decides what may happen. This policy
// intentionally automates only reversible RAG upserts. Anything private,
// conflicting, behavior-changing, operational, or governance-bearing remains
// a small human exception.
function automationDecision(candidate) {
  const klass = evidenceClass(candidate);
  const conflicts = candidate.conflicts || [];
  const confidence = Number(candidate.confidence || 0);
  const recurrence = candidate.recurrence || {};
  const observationCount = Number(recurrence.observationCount || 0);
  const independentSessions = Number(recurrence.independentSessions || 0);
  const ignoreTypes = ['duplicate', 'ephemeral', 'sensitive_or_secret', 'unsupported'];

  if (ignoreTypes.includes(candidate.type) || candidate.target?.kind === 'ignore'
      && !['contradiction', 'stale_memory'].includes(candidate.type)) {
    return { disposition: 'ignore', evidenceClass: klass, reason: `type:${candidate.type}` };
  }
  if (conflicts.length || ['contradiction', 'stale_memory'].includes(candidate.type)) {
    return { disposition: 'review', evidenceClass: klass, reason: 'conflict-or-temporal-dispute' };
  }
  if (candidate.sensitivity !== 'normal') {
    return { disposition: 'review', evidenceClass: klass, reason: `sensitivity:${candidate.sensitivity}` };
  }
  if (candidate.impact !== 'context_only' || candidate.risk?.governance !== 'none') {
    return { disposition: 'review', evidenceClass: klass, reason: `impact:${candidate.impact}` };
  }
  if (candidate.type === 'inferred_pattern' && candidate.target?.kind === 'soft_memory') {
    if (confidence >= 0.65 && (independentSessions >= 2 || observationCount >= 2)) {
      return { disposition: 'soft_store', evidenceClass: klass, reason: 'recurrent-bounded-inference' };
    }
    return { disposition: 'ignore', evidenceClass: klass, reason: 'weak-or-single-use-inference' };
  }
  if (candidate.type === 'project_event' && candidate.target?.kind === 'artifact'
      && klass === 'project_observed' && confidence >= 0.75) {
    return { disposition: 'auto_apply', evidenceClass: klass, reason: 'verified-project-event' };
  }
  if (candidate.target?.kind === 'artifact'
      && ['runtime_verified', 'project_observed'].includes(klass) && confidence >= 0.8) {
    return { disposition: 'auto_apply', evidenceClass: klass, reason: 'verified-episodic-context' };
  }
  if (candidate.target?.kind === 'shared_fact' && klass === 'explicit' && confidence >= 0.8) {
    return { disposition: 'auto_apply', evidenceClass: klass, reason: 'explicit-memory-intent' };
  }
  if (candidate.target?.kind === 'shared_fact' && klass === 'owner_observed') {
    if (candidate.type === 'preference' && confidence >= 0.85
        && (independentSessions >= 2 || observationCount >= 2)) {
      return { disposition: 'auto_apply', evidenceClass: klass, reason: 'recurrent-owner-preference' };
    }
    if (['durable_fact', 'correction'].includes(candidate.type) && confidence >= 0.9) {
      return { disposition: 'auto_apply', evidenceClass: klass, reason: 'high-confidence-owner-fact' };
    }
  }
  return { disposition: 'review', evidenceClass: klass, reason: 'outside-safe-standing-policy' };
}

module.exports = {
  SCHEMA_VERSION,
  POLICY_VERSION,
  RUNTIMES,
  publicRuntime,
  RECONCILIATION_GRACE_MINUTES,
  TRUST_ELIGIBLE,
  TRUST_INELIGIBLE,
  TRUST_CLASSES,
  CENTRAL_SUBMISSION_TRUST,
  CANDIDATE_TYPES,
  TARGET_KINDS,
  TARGETS_BY_TYPE,
  APPLY_ADAPTERS,
  MEMORY_SCOPES,
  SENSITIVITY_LEVELS,
  IMPACT_LEVELS,
  STABILITY_LEVELS,
  AUTOMATION_DISPOSITIONS,
  RUN_STATUSES,
  CANDIDATE_STATUSES,
  REVIEW_ACTIONS,
  LIMITS,
  serverMode,
  automationMode,
  reviewExceptionBudget,
  normalizeText,
  contentHash,
  candidateId,
  cleanRunKey,
  reconciliationStatus,
  MemoryReviewError,
  assertKnownKeys,
  validateTargetForType,
  validateObservation,
  validateCandidateInput,
  evidenceClass,
  automationDecision,
};

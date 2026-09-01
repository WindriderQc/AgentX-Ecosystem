'use strict';

const { fingerprint, DATA_CLASSIFICATIONS } = require('./workerContract');

const PIPELINE_AUTOMATION_SCHEMA = 'agentx.pipeline-automation/v1';
const AUTOMATION_MODES = new Set(['manual', 'review_only']);
const HUMAN_GATES = new Set(['review', 'merge', 'deploy', 'protected_change']);
const CHANGE_OPERATIONS = new Set(['create', 'update', 'delete']);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function automationError(message, code = 'INVALID_AUTOMATION_INTENT') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw automationError(`${name} must be an object`);
  }
  return value;
}

function identifier(value, name, max = 160) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || !IDENTIFIER_RE.test(normalized)) {
    throw automationError(`${name} must be a bounded identifier`);
  }
  return normalized;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw automationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function sortedUnique(values, name, normalize, { minItems = 1, maxItems = 64 } = {}) {
  if (!Array.isArray(values) || values.length < minItems || values.length > maxItems) {
    throw automationError(`${name} must contain between ${minItems} and ${maxItems} entries`);
  }
  const normalized = values.map((value, index) => normalize(value, `${name}[${index}]`));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    throw automationError(`${name} must not contain duplicates`);
  }
  return unique;
}

function repositoryPath(value, name) {
  const normalized = String(value || '').trim();
  if (
    !normalized
    || normalized.length > 300
    || normalized.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw automationError(`${name} must be an unambiguous repository-relative POSIX path`);
  }
  return normalized;
}

function repositoryPrefix(value, name) {
  return repositoryPath(String(value || '').trim().replace(/\/+$/, ''), name);
}

function normalizePipelineAutomationIntent(rawValue) {
  const raw = object(rawValue, 'automation');
  if (raw.schema !== PIPELINE_AUTOMATION_SCHEMA) {
    throw automationError(`automation.schema must be ${PIPELINE_AUTOMATION_SCHEMA}`, 'UNSUPPORTED_AUTOMATION_SCHEMA');
  }
  const mode = String(raw.mode || '').trim();
  if (!AUTOMATION_MODES.has(mode)) {
    throw automationError('automation.mode must be manual or review_only');
  }

  if (mode === 'manual') {
    const normalized = { schema: PIPELINE_AUTOMATION_SCHEMA, mode };
    const computed = fingerprint(normalized);
    if (raw.fingerprint && raw.fingerprint !== computed) {
      throw automationError('automation fingerprint does not match normalized intent', 'AUTOMATION_FINGERPRINT_MISMATCH');
    }
    return { ...normalized, fingerprint: computed };
  }

  const budgetsRaw = object(raw.budgets, 'automation.budgets');
  const humanGates = sortedUnique(
    raw.humanGates,
    'automation.humanGates',
    (value, name) => {
      const gate = identifier(value, name, 80);
      if (!HUMAN_GATES.has(gate)) throw automationError(`${name} is not a supported human gate`);
      return gate;
    },
    { minItems: 3, maxItems: HUMAN_GATES.size }
  );
  for (const required of ['review', 'merge', 'deploy']) {
    if (!humanGates.includes(required)) {
      throw automationError(`automation.humanGates must include ${required}`, 'AUTOMATION_HUMAN_GATE_REQUIRED');
    }
  }

  const normalized = {
    schema: PIPELINE_AUTOMATION_SCHEMA,
    mode,
    policyRef: identifier(raw.policyRef, 'automation.policyRef'),
    dataClassification: (() => {
      const value = identifier(raw.dataClassification, 'automation.dataClassification', 80);
      if (!DATA_CLASSIFICATIONS.includes(value)) {
        throw automationError('automation.dataClassification is not supported');
      }
      return value;
    })(),
    operations: sortedUnique(
      raw.operations,
      'automation.operations',
      (value, name) => {
        const operation = identifier(value, name, 40);
        if (!CHANGE_OPERATIONS.has(operation)) throw automationError(`${name} is not a supported change operation`);
        return operation;
      },
      { minItems: 1, maxItems: CHANGE_OPERATIONS.size }
    ),
    scope: sortedUnique(raw.scope, 'automation.scope', repositoryPath, { minItems: 1, maxItems: 30 }),
    lockKeys: sortedUnique(
      raw.lockKeys,
      'automation.lockKeys',
      (value, name) => identifier(value, name, 240),
      { minItems: 1, maxItems: 30 }
    ),
    executionProfile: identifier(raw.executionProfile, 'automation.executionProfile'),
    verificationProfile: identifier(raw.verificationProfile, 'automation.verificationProfile'),
    budgets: {
      maxDurationMs: integer(budgetsRaw.maxDurationMs, 'automation.budgets.maxDurationMs', {
        min: 1,
        max: 604_800_000,
      }),
      maxAttempts: integer(budgetsRaw.maxAttempts, 'automation.budgets.maxAttempts', { min: 1, max: 10 }),
      maxCostNanodollars: integer(
        budgetsRaw.maxCostNanodollars,
        'automation.budgets.maxCostNanodollars',
        { min: 0, max: 9_000_000_000_000_000 }
      ),
    },
    humanGates,
  };
  const computed = fingerprint(normalized);
  if (raw.fingerprint && raw.fingerprint !== computed) {
    throw automationError('automation fingerprint does not match normalized intent', 'AUTOMATION_FINGERPRINT_MISMATCH');
  }
  return { ...normalized, fingerprint: computed };
}

function pathIsProtected(path, protectedPathPrefixes) {
  return protectedPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function automationAdmissionReasons(task = {}, context = {}) {
  const reasons = [];
  let automation = null;
  try {
    if (task.automation) automation = normalizePipelineAutomationIntent(task.automation);
  } catch (error) {
    reasons.push({ code: 'automation_invalid', detail: error.message });
  }

  if (!automation) reasons.push({ code: 'automation_missing', detail: 'structured automation intent is absent' });
  else if (automation.mode !== 'review_only') reasons.push({ code: 'automation_manual', detail: 'task is explicitly manual-only' });

  if (task.status !== 'queued' || task.assignee) {
    reasons.push({ code: 'task_unavailable', detail: 'task is not queued and unassigned' });
  }
  if (String(task.risk || '').toLowerCase() !== 'low') {
    reasons.push({ code: 'risk_not_low', detail: 'autonomous coding requires explicit low risk' });
  }

  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  if (task.notBefore && new Date(task.notBefore).getTime() > now.getTime()) {
    reasons.push({ code: 'not_before', detail: `task is deferred until ${new Date(task.notBefore).toISOString()}` });
  }

  const dependencyStatuses = context.dependencyStatuses instanceof Map
    ? context.dependencyStatuses
    : new Map(Object.entries(context.dependencyStatuses || {}));
  const incomplete = (task.dependsOn || []).filter((id) => dependencyStatuses.get(id) !== 'done');
  if (incomplete.length) {
    reasons.push({ code: 'dependencies_incomplete', detail: `incomplete dependencies: ${incomplete.join(',')}` });
  }

  if (automation?.mode === 'review_only') {
    const attemptCount = Number(task.automationAttemptCount || 0);
    if (attemptCount >= automation.budgets.maxAttempts) {
      reasons.push({ code: 'attempt_budget_exhausted', detail: 'maximum autonomous attempts reached' });
    }

    const activeLockKeys = new Set(context.activeLockKeys || []);
    const conflicts = automation.lockKeys.filter((key) => activeLockKeys.has(key));
    if (conflicts.length) {
      reasons.push({ code: 'resource_lock_conflict', detail: `active locks: ${conflicts.join(',')}` });
    }

    const protectedPathPrefixes = (context.protectedPathPrefixes || []).map((value, index) => (
      repositoryPrefix(value, `protectedPathPrefixes[${index}]`)
    ));
    const protectedPaths = automation.scope.filter((path) => pathIsProtected(path, protectedPathPrefixes));
    if (protectedPaths.length) {
      reasons.push({ code: 'protected_scope', detail: `protected paths: ${protectedPaths.join(',')}` });
    }
  }

  return reasons;
}

module.exports = {
  PIPELINE_AUTOMATION_SCHEMA,
  normalizePipelineAutomationIntent,
  automationAdmissionReasons,
};

'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('./artifactIdentity');

const WORKER_ENVELOPE_SCHEMA = 'agentx.worker-envelope/v1';
const WORKER_RECEIPT_SCHEMA = 'agentx.worker-receipt/v1';
const SCHEMA_VERSION = 1;

const EXECUTION_PROFILES = Object.freeze(['portable', 'native-ceiling']);
const DATA_CLASSIFICATIONS = Object.freeze(['public', 'internal', 'confidential', 'restricted']);
const FINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'timed_out', 'policy_blocked']);
const FAILURE_CLASSIFICATIONS = Object.freeze([
  'harness_error',
  'adapter_error',
  'provider_error',
  'model_error',
  'tool_error',
  'policy_violation',
  'budget_exceeded',
  'timeout',
  'cancelled',
  'invalid_result',
  'infrastructure_error',
  'unknown',
]);

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('OBJECT_REQUIRED', `${name} must be an object`);
  }
  return value;
}

function requiredText(value, name, max = 240) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw contractError('FIELD_REQUIRED', `${name} is required`);
  if (text.length > max) throw contractError('FIELD_TOO_LONG', `${name} must be at most ${max} characters`);
  return text;
}

function optionalText(value, name, max = 240) {
  if (value == null || value === '') return null;
  return requiredText(value, name, max);
}

function identifier(value, name, max = 180) {
  const text = requiredText(value, name, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/.test(text)) {
    throw contractError('INVALID_IDENTIFIER', `${name} must be a logical identifier, not an address or path`);
  }
  return text;
}

function modelIdentifier(value, name, max = 240) {
  const text = requiredText(value, name, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/+\-]*$/.test(text)
    || /:\/\//.test(text)
    || /^[a-zA-Z]:\//.test(text)
    || text.includes('\\')
    || text.includes('/../')
    || text.endsWith('/..')) {
    throw contractError('INVALID_IDENTIFIER', `${name} must be an exact model identifier, not an address or path`);
  }
  return text;
}

function optionalIdentifier(value, name, max = 180) {
  if (value == null || value === '') return null;
  return identifier(value, name, max);
}

function enumValue(value, name, allowed) {
  const normalized = requiredText(value, name, 80).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw contractError('INVALID_ENUM', `${name} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function boolean(value, name, defaultValue) {
  if (value == null && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'boolean') throw contractError('INVALID_BOOLEAN', `${name} must be a boolean`);
  return value;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw contractError('INVALID_BUDGET', `${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function metricInteger(value, name, options = {}) {
  try {
    return integer(value, name, options);
  } catch (error) {
    if (error.code === 'INVALID_BUDGET') error.code = 'INVALID_METRIC';
    throw error;
  }
}

function hexFingerprint(value, name) {
  const text = requiredText(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw contractError('INVALID_FINGERPRINT', `${name} must be a 64-character SHA-256 fingerprint`);
  }
  return text;
}

function optionalDigest(value, name) {
  if (value == null || value === '') return null;
  const text = requiredText(value, name, 240).toLowerCase();
  if (!/^(?:[a-z0-9][a-z0-9._-]*:)?[a-f0-9]{32,}$/.test(text)) {
    throw contractError('INVALID_DIGEST', `${name} must be a hexadecimal digest with an optional algorithm prefix`);
  }
  return text;
}

function sortedUnique(values, name, normalizer) {
  const normalized = (Array.isArray(values) ? values : []).map((value, index) => normalizer(value, `${name}[${index}]`));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw contractError('DUPLICATE_VALUE', `${name} must not contain duplicates`);
  return unique;
}

function verifyFingerprint(rawValue, computed, name, mismatchCode) {
  if (rawValue == null || rawValue === '') return computed;
  if (hexFingerprint(rawValue, name) !== computed) {
    throw contractError(mismatchCode, `${name} does not match the normalized contract`);
  }
  return computed;
}

function normalizeSelection(rawValue, name, { provider = false } = {}) {
  const raw = object(rawValue, name);
  const constraints = sortedUnique(raw.constraints, `${name}.constraints`, (value, field) => identifier(value, field, 120));
  const normalized = {
    ...(provider ? { provider: optionalIdentifier(raw.provider, `${name}.provider`, 120) } : {}),
    id: raw.id == null || raw.id === ''
      ? null
      : (provider ? modelIdentifier(raw.id, `${name}.id`, 240) : identifier(raw.id, `${name}.id`, 180)),
    version: optionalIdentifier(raw.version, `${name}.version`, 120),
    digest: provider ? optionalDigest(raw.digest, `${name}.digest`) : null,
    constraints,
  };
  if (!normalized.id && constraints.length === 0) {
    throw contractError('SELECTION_REQUIRED', `${name} requires an exact id or at least one constraint`);
  }
  return normalized;
}

function normalizeTools(rawValue) {
  const raw = object(rawValue, 'tools');
  const allowed = (Array.isArray(raw.allowed) ? raw.allowed : []).map((entry, index) => {
    const tool = object(entry, `tools.allowed[${index}]`);
    return {
      name: identifier(tool.name, `tools.allowed[${index}].name`, 160),
      version: optionalIdentifier(tool.version, `tools.allowed[${index}].version`, 120),
      schemaFingerprint: hexFingerprint(tool.schemaFingerprint, `tools.allowed[${index}].schemaFingerprint`),
    };
  }).sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  const keys = allowed.map((tool) => `${tool.name}\0${tool.version || ''}`);
  if (new Set(keys).size !== keys.length) {
    throw contractError('DUPLICATE_TOOL', 'tools.allowed must not repeat a tool name and version');
  }
  const computed = fingerprint(allowed);
  return {
    allowed,
    schemaFingerprint: verifyFingerprint(raw.schemaFingerprint, computed, 'tools.schemaFingerprint', 'TOOLS_FINGERPRINT_MISMATCH'),
  };
}

function normalizePolicies(rawValue) {
  const raw = object(rawValue, 'policies');
  const filesystemRaw = object(raw.filesystem, 'policies.filesystem');
  const networkRaw = object(raw.network, 'policies.network');
  const outputRaw = object(raw.output, 'policies.output');
  const filesystemMode = enumValue(filesystemRaw.mode, 'policies.filesystem.mode', ['none', 'read_only', 'workspace_write']);
  const allowedOperations = sortedUnique(
    filesystemRaw.allowedOperations,
    'policies.filesystem.allowedOperations',
    (value, name) => enumValue(value, name, ['read', 'list', 'create', 'update', 'delete', 'execute'])
  );
  if (filesystemMode === 'none' && allowedOperations.length > 0) {
    throw contractError('FILESYSTEM_POLICY_CONFLICT', 'filesystem mode none cannot allow operations');
  }
  if (filesystemMode === 'read_only' && allowedOperations.some((operation) => !['read', 'list'].includes(operation))) {
    throw contractError('FILESYSTEM_POLICY_CONFLICT', 'read_only filesystem policy may allow only read and list');
  }
  const networkMode = enumValue(networkRaw.mode, 'policies.network.mode', ['none', 'allowlist']);
  const allowedDestinations = sortedUnique(
    networkRaw.allowedDestinations,
    'policies.network.allowedDestinations',
    (value, name) => identifier(value, name, 160)
  );
  if ((networkMode === 'none') !== (allowedDestinations.length === 0)) {
    throw contractError('NETWORK_POLICY_CONFLICT', 'network destinations must be empty only when network mode is none');
  }
  const policies = {
    filesystem: {
      mode: filesystemMode,
      workspaceOnly: boolean(filesystemRaw.workspaceOnly, 'policies.filesystem.workspaceOnly', true),
      allowedOperations,
    },
    network: { mode: networkMode, allowedDestinations },
    output: {
      mode: enumValue(outputRaw.mode, 'policies.output.mode', ['result_only', 'patch_and_artifacts']),
      maxBytes: integer(outputRaw.maxBytes, 'policies.output.maxBytes', { min: 1, max: 10_000_000_000 }),
      publicProjection: enumValue(
        outputRaw.publicProjection || 'allowlist_only',
        'policies.output.publicProjection',
        ['allowlist_only']
      ),
    },
  };
  const computed = fingerprint(policies);
  return {
    ...policies,
    fingerprint: verifyFingerprint(raw.fingerprint, computed, 'policies.fingerprint', 'POLICIES_FINGERPRINT_MISMATCH'),
  };
}

function normalizeResultContract(rawValue) {
  const raw = object(rawValue, 'resultContract');
  const format = enumValue(raw.format, 'resultContract.format', ['text', 'json', 'patch', 'artifact_manifest']);
  return {
    format,
    schemaFingerprint: raw.schemaFingerprint == null ? null : hexFingerprint(raw.schemaFingerprint, 'resultContract.schemaFingerprint'),
    requiredEvidence: sortedUnique(
      raw.requiredEvidence,
      'resultContract.requiredEvidence',
      (value, name) => enumValue(value, name, ['patch', 'artifact', 'tests'])
    ),
  };
}

function normalizeWorkerEnvelope(rawValue = {}) {
  const raw = object(rawValue, 'envelope');
  if (raw.schema !== WORKER_ENVELOPE_SCHEMA) {
    throw contractError('UNSUPPORTED_SCHEMA', `envelope.schema must be ${WORKER_ENVELOPE_SCHEMA}`);
  }
  if (Number(raw.schemaVersion) !== SCHEMA_VERSION) {
    throw contractError('UNSUPPORTED_SCHEMA_VERSION', `envelope.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const taskRaw = object(raw.task, 'task');
  const workRaw = object(raw.work, 'work');
  const workspaceRaw = object(raw.workspace, 'workspace');
  const selectionRaw = object(raw.selection, 'selection');
  const promptRaw = object(raw.prompt, 'prompt');
  const budgetsRaw = object(raw.budgets, 'budgets');
  const description = optionalText(workRaw.description, 'work.description', 4000);
  const reference = optionalIdentifier(workRaw.reference, 'work.reference', 240);
  if (!description && !reference) throw contractError('WORK_REQUIRED', 'work requires a description or logical reference');
  const normalized = {
    schema: WORKER_ENVELOPE_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    task: {
      id: identifier(taskRaw.id, 'task.id', 180),
      correlationId: identifier(taskRaw.correlationId, 'task.correlationId', 180),
    },
    work: { description, reference },
    workspace: {
      id: identifier(workspaceRaw.id, 'workspace.id', 180),
      kind: enumValue(workspaceRaw.kind || 'logical', 'workspace.kind', ['logical', 'ephemeral', 'repository']),
    },
    dataClassification: enumValue(raw.dataClassification, 'dataClassification', DATA_CLASSIFICATIONS),
    executionProfile: enumValue(raw.executionProfile, 'executionProfile', EXECUTION_PROFILES),
    selection: {
      harness: normalizeSelection(selectionRaw.harness, 'selection.harness'),
      model: normalizeSelection(selectionRaw.model, 'selection.model', { provider: true }),
    },
    prompt: {
      reference: optionalIdentifier(promptRaw.reference, 'prompt.reference', 240),
      fingerprint: hexFingerprint(promptRaw.fingerprint, 'prompt.fingerprint'),
    },
    tools: normalizeTools(raw.tools),
    budgets: {
      maxDurationMs: integer(budgetsRaw.maxDurationMs, 'budgets.maxDurationMs', { min: 1, max: 604_800_000 }),
      maxTokens: integer(budgetsRaw.maxTokens, 'budgets.maxTokens', { min: 1, max: 1_000_000_000 }),
      maxCostNanodollars: integer(budgetsRaw.maxCostNanodollars, 'budgets.maxCostNanodollars'),
      maxTurns: integer(budgetsRaw.maxTurns, 'budgets.maxTurns', { min: 1, max: 100_000 }),
      maxToolCalls: integer(budgetsRaw.maxToolCalls, 'budgets.maxToolCalls', { min: 0, max: 1_000_000 }),
    },
    policies: normalizePolicies(raw.policies),
    resultContract: normalizeResultContract(raw.resultContract),
  };
  return {
    ...normalized,
    fingerprint: verifyFingerprint(raw.fingerprint, fingerprint(normalized), 'envelope.fingerprint', 'ENVELOPE_FINGERPRINT_MISMATCH'),
  };
}

function normalizeVersionedIdentity(rawValue, name) {
  const raw = object(rawValue, name);
  return {
    name: identifier(raw.name, `${name}.name`, 180),
    version: identifier(raw.version, `${name}.version`, 120),
  };
}

function normalizeReceiptIdentity(rawValue) {
  const raw = object(rawValue, 'identity');
  const provider = normalizeVersionedIdentity(raw.provider, 'identity.provider');
  const modelRaw = object(raw.model, 'identity.model');
  const api = normalizeVersionedIdentity(raw.api, 'identity.api');
  const environmentRaw = object(raw.environment, 'identity.environment');
  return {
    harness: normalizeVersionedIdentity(raw.harness, 'identity.harness'),
    adapter: normalizeVersionedIdentity(raw.adapter, 'identity.adapter'),
    provider,
    model: {
      name: modelIdentifier(modelRaw.name, 'identity.model.name', 240),
      version: identifier(modelRaw.version, 'identity.model.version', 160),
      digest: optionalDigest(modelRaw.digest, 'identity.model.digest'),
      runtimeFingerprint: modelRaw.runtimeFingerprint == null
        ? null
        : hexFingerprint(modelRaw.runtimeFingerprint, 'identity.model.runtimeFingerprint'),
    },
    api,
    environment: {
      id: identifier(environmentRaw.id, 'identity.environment.id', 180),
      version: identifier(environmentRaw.version, 'identity.environment.version', 120),
      fingerprint: hexFingerprint(environmentRaw.fingerprint, 'identity.environment.fingerprint'),
    },
  };
}

function verifyReceiptSelection(identity, envelope) {
  const harness = envelope.selection.harness;
  const model = envelope.selection.model;
  const mismatches = [];
  if (harness.id && harness.id !== identity.harness.name) mismatches.push('harness.id');
  if (harness.version && harness.version !== identity.harness.version) mismatches.push('harness.version');
  if (model.provider && model.provider !== identity.provider.name) mismatches.push('model.provider');
  if (model.id && model.id !== identity.model.name) mismatches.push('model.id');
  if (model.version && model.version !== identity.model.version) mismatches.push('model.version');
  if (model.digest && model.digest !== identity.model.digest) mismatches.push('model.digest');
  if (mismatches.length > 0) {
    throw contractError(
      'RECEIPT_SELECTION_MISMATCH',
      `receipt identity does not match exact envelope selection: ${mismatches.join(', ')}`
    );
  }
}

function normalizeCountedEntries(values, name, fields) {
  const entries = (Array.isArray(values) ? values : []).map((value, index) => {
    const raw = object(value, `${name}[${index}]`);
    const normalized = {};
    for (const field of fields) normalized[field] = identifier(raw[field], `${name}[${index}].${field}`, 160);
    normalized.count = metricInteger(raw.count == null ? 1 : raw.count, `${name}[${index}].count`, { min: 1, max: 1_000_000 });
    return normalized;
  }).sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  const keys = entries.map((entry) => fields.map((field) => entry[field]).join('\0'));
  if (new Set(keys).size !== keys.length) throw contractError('DUPLICATE_VALUE', `${name} must not contain duplicate identities`);
  return entries;
}

function normalizeEvidenceReferences(rawValue) {
  const raw = object(rawValue || {}, 'evidence');
  const reference = (entry, name, extra = false) => {
    const item = object(entry, name);
    return {
      id: identifier(item.id, `${name}.id`, 200),
      ...(extra ? { status: enumValue(item.status, `${name}.status`, ['passed', 'failed', 'skipped']) } : {}),
      digest: optionalDigest(item.digest, `${name}.digest`),
    };
  };
  const list = (value, name, extra = false) => (Array.isArray(value) ? value : [])
    .map((entry, index) => reference(entry, `${name}[${index}]`, extra))
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  return {
    patches: list(raw.patches, 'evidence.patches'),
    artifacts: list(raw.artifacts, 'evidence.artifacts'),
    tests: list(raw.tests, 'evidence.tests', true),
  };
}

function normalizeWorkerReceipt(rawValue = {}, options = {}) {
  const raw = object(rawValue, 'receipt');
  if (raw.schema !== WORKER_RECEIPT_SCHEMA) {
    throw contractError('UNSUPPORTED_SCHEMA', `receipt.schema must be ${WORKER_RECEIPT_SCHEMA}`);
  }
  if (Number(raw.schemaVersion) !== SCHEMA_VERSION) {
    throw contractError('UNSUPPORTED_SCHEMA_VERSION', `receipt.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const fingerprintsRaw = object(raw.fingerprints, 'fingerprints');
  const usageRaw = object(raw.usage, 'usage');
  const resultRaw = object(raw.result, 'result');
  const identity = normalizeReceiptIdentity(raw.identity);
  const profile = enumValue(raw.executionProfile, 'executionProfile', EXECUTION_PROFILES);
  const fingerprints = {
    prompt: hexFingerprint(fingerprintsRaw.prompt, 'fingerprints.prompt'),
    tools: hexFingerprint(fingerprintsRaw.tools, 'fingerprints.tools'),
    policies: hexFingerprint(fingerprintsRaw.policies, 'fingerprints.policies'),
    envelope: hexFingerprint(fingerprintsRaw.envelope, 'fingerprints.envelope'),
  };
  const envelope = options.envelope ? normalizeWorkerEnvelope(options.envelope) : null;
  if (envelope) {
    const expected = {
      prompt: envelope.prompt.fingerprint,
      tools: envelope.tools.schemaFingerprint,
      policies: envelope.policies.fingerprint,
      envelope: envelope.fingerprint,
    };
    if (profile !== envelope.executionProfile || stableSerialize(fingerprints) !== stableSerialize(expected)) {
      throw contractError('RECEIPT_ENVELOPE_MISMATCH', 'receipt profile and fingerprints must match the normalized envelope');
    }
    verifyReceiptSelection(identity, envelope);
  }
  const finalState = enumValue(raw.finalState, 'finalState', FINAL_STATES);
  const failureRaw = raw.failure == null ? {} : object(raw.failure, 'failure');
  const failure = {
    classification: failureRaw.classification == null
      ? null
      : enumValue(failureRaw.classification, 'failure.classification', FAILURE_CLASSIFICATIONS),
    code: optionalIdentifier(failureRaw.code, 'failure.code', 160),
  };
  if (finalState === 'succeeded' && (failure.classification || failure.code)) {
    throw contractError('SUCCESS_HAS_FAILURE', 'a succeeded receipt cannot contain failure classification');
  }
  if (finalState !== 'succeeded' && !failure.classification) {
    throw contractError('FAILURE_CLASSIFICATION_REQUIRED', 'a non-success receipt requires failure.classification');
  }
  const inputTokens = metricInteger(usageRaw.inputTokens, 'usage.inputTokens');
  const outputTokens = metricInteger(usageRaw.outputTokens, 'usage.outputTokens');
  const totalTokens = metricInteger(usageRaw.totalTokens, 'usage.totalTokens');
  if (totalTokens !== inputTokens + outputTokens) {
    throw contractError('TOKEN_TOTAL_MISMATCH', 'usage.totalTokens must equal inputTokens plus outputTokens');
  }
  const usage = {
    durationMs: metricInteger(usageRaw.durationMs, 'usage.durationMs'),
    inputTokens,
    outputTokens,
    totalTokens,
    costNanodollars: metricInteger(usageRaw.costNanodollars, 'usage.costNanodollars'),
    turns: metricInteger(usageRaw.turns, 'usage.turns'),
    toolCalls: metricInteger(usageRaw.toolCalls, 'usage.toolCalls'),
  };
  const result = {
    contractSatisfied: boolean(resultRaw.contractSatisfied, 'result.contractSatisfied'),
    fingerprint: resultRaw.fingerprint == null ? null : hexFingerprint(resultRaw.fingerprint, 'result.fingerprint'),
  };
  const evidence = normalizeEvidenceReferences(raw.evidence);
  if (finalState === 'succeeded' && !result.contractSatisfied) {
    throw contractError('SUCCESS_RESULT_UNSATISFIED', 'a succeeded receipt must satisfy its result contract');
  }
  if (finalState !== 'succeeded' && result.contractSatisfied) {
    throw contractError('FAILURE_RESULT_SATISFIED', 'a non-success receipt cannot claim that its result contract was satisfied');
  }
  if (envelope && finalState === 'succeeded') {
    const exceeded = [
      ['durationMs', 'maxDurationMs'],
      ['totalTokens', 'maxTokens'],
      ['costNanodollars', 'maxCostNanodollars'],
      ['turns', 'maxTurns'],
      ['toolCalls', 'maxToolCalls'],
    ].filter(([usageField, budgetField]) => usage[usageField] > envelope.budgets[budgetField]);
    if (exceeded.length > 0) {
      throw contractError(
        'SUCCESS_EXCEEDS_BUDGET',
        `a succeeded receipt exceeds envelope budget: ${exceeded.map(([, budgetField]) => budgetField).join(', ')}`
      );
    }
    const evidenceCounts = {
      patch: evidence.patches.length,
      artifact: evidence.artifacts.length,
      tests: evidence.tests.length,
    };
    const missingEvidence = envelope.resultContract.requiredEvidence
      .filter((kind) => evidenceCounts[kind] === 0);
    if (missingEvidence.length > 0) {
      throw contractError(
        'SUCCESS_MISSING_EVIDENCE',
        `a succeeded receipt is missing required evidence: ${missingEvidence.join(', ')}`
      );
    }
  }
  const executionTupleFingerprint = fingerprint({ identity, fingerprints: {
    prompt: fingerprints.prompt,
    tools: fingerprints.tools,
    policies: fingerprints.policies,
  } });
  const normalized = {
    schema: WORKER_RECEIPT_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    executionProfile: profile,
    identity,
    fingerprints,
    executionTupleFingerprint: verifyFingerprint(
      raw.executionTupleFingerprint,
      executionTupleFingerprint,
      'receipt.executionTupleFingerprint',
      'EXECUTION_TUPLE_FINGERPRINT_MISMATCH'
    ),
    finalState,
    failure,
    usage,
    toolErrors: normalizeCountedEntries(raw.toolErrors, 'toolErrors', ['tool', 'code']),
    humanInterventions: normalizeCountedEntries(raw.humanInterventions, 'humanInterventions', ['kind']),
    evidence,
    violations: normalizeCountedEntries(raw.violations, 'violations', ['category', 'code']),
    result,
  };
  return {
    ...normalized,
    fingerprint: verifyFingerprint(raw.fingerprint, fingerprint(normalized), 'receipt.fingerprint', 'RECEIPT_FINGERPRINT_MISMATCH'),
  };
}

function projectWorkerReceiptPublic(rawValue, options = {}) {
  const receipt = normalizeWorkerReceipt(rawValue, options);
  return {
    schema: receipt.schema,
    schemaVersion: receipt.schemaVersion,
    executionProfile: receipt.executionProfile,
    identity: {
      harness: receipt.identity.harness,
      adapter: receipt.identity.adapter,
      provider: receipt.identity.provider,
      model: receipt.identity.model,
      api: receipt.identity.api,
      environment: { fingerprint: receipt.identity.environment.fingerprint },
    },
    fingerprints: receipt.fingerprints,
    executionTupleFingerprint: receipt.executionTupleFingerprint,
    finalState: receipt.finalState,
    failure: receipt.failure,
    usage: receipt.usage,
    toolErrors: receipt.toolErrors,
    humanInterventions: receipt.humanInterventions,
    evidence: receipt.evidence,
    violations: receipt.violations,
    result: receipt.result,
    fingerprint: receipt.fingerprint,
  };
}

module.exports = {
  DATA_CLASSIFICATIONS,
  EXECUTION_PROFILES,
  FAILURE_CLASSIFICATIONS,
  FINAL_STATES,
  SCHEMA_VERSION,
  WORKER_ENVELOPE_SCHEMA,
  WORKER_RECEIPT_SCHEMA,
  fingerprint,
  normalizeWorkerEnvelope,
  normalizeWorkerReceipt,
  projectWorkerReceiptPublic,
};

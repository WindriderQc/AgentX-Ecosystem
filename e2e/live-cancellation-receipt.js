'use strict';

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_KIND = 'agentx.live-cancellation-observation';
const EVIDENCE_MODE = 'live-isolated-socket';
const EXPECTED_PROFILE = 'full';
const EXPECTED_VERSION = require('../benchmark/package.json').version;
const ASSERTION_IDS = Object.freeze([
  'socket-open-before-stop',
  'socket-closed-within-budget',
  'no-next-prompt',
  'batch-stopped',
  'claim-released',
  'service-identities-stable',
  'isolated-topology',
]);
const EXPECTED_TOPOLOGY_SERVICES = Object.freeze([
  'agentx-benchmark',
  'agentx-core',
  'mongo',
  'ollama-fixture',
]);
const FAILURE_CODES = Object.freeze([
  'BENCHMARK_HEALTH_UNAVAILABLE',
  'BENCHMARK_IDENTITY_MISMATCH',
  'BATCH_START_CONTRACT_MISMATCH',
  'BATCH_START_FAILED',
  'CLAIM_NOT_OBSERVED',
  'CLAIM_RELEASE_NOT_OBSERVED',
  'CORE_HEALTH_UNAVAILABLE',
  'CORE_IDENTITY_MISMATCH',
  'FIXTURE_CONTRACT_MISMATCH',
  'FIXTURE_HEALTH_UNAVAILABLE',
  'FIXTURE_NOT_FRESH',
  'FIRST_PROMPT_NOT_OBSERVED',
  'ISOLATED_TOPOLOGY_MISMATCH',
  'NEXT_PROMPT_STARTED',
  'QUIESCENCE_NOT_OBSERVED',
  'RECEIPT_VALIDATION_FAILED',
  'SERVICE_IDENTITY_DRIFT',
  'SOCKET_CLOSE_BUDGET_EXCEEDED',
  'SOCKET_CLOSE_NOT_OBSERVED',
  'STOP_FAILED',
  'TERMINAL_STATE_MISMATCH',
  'TERMINAL_STATE_NOT_OBSERVED',
  'UNEXPECTED_DRIVER_FAILURE',
]);
const FAILURE_CODE_SET = new Set(FAILURE_CODES);
const PASS_ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'status',
  'evidenceMode',
  'buildRevision',
  'scenarioHash',
  'generatedAt',
  'budget',
  'topology',
  'identities',
  'chain',
  'cancellation',
  'terminal',
  'quiescence',
  'assertions',
  'summary',
  'privacy',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function exactIdentity(identity, service, revision) {
  return sameKeys(identity, ['service', 'version', 'profile', 'revision'])
    && identity.service === service
    && identity.version === EXPECTED_VERSION
    && identity.profile === EXPECTED_PROFILE
    && identity.revision === revision;
}

function identitiesMatch(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function observationState(values) {
  return values.some((value) => value === null || value === undefined)
    ? 'not-observed'
    : null;
}

function deriveAssertionStatuses(receipt) {
  const chain = receipt?.chain || {};
  const cancellation = receipt?.cancellation || {};
  const terminal = receipt?.terminal || {};
  const quiescence = receipt?.quiescence || {};
  const budget = receipt?.budget || {};
  const topology = receipt?.topology || {};
  const identities = receipt?.identities || {};

  const socketOpenMissing = observationState([
    chain.batchHash,
    chain.totalTests,
    chain.firstPromptState,
    chain.claimObservedBeforeStop,
    chain.fixtureEndpointTemplate,
    chain.fixtureRequestId,
    chain.fixtureSocketId,
    chain.socketOpenBeforeStop,
  ]);
  const socketOpenPass = /^[a-f0-9]{12}$/.test(chain.batchHash || '')
    && chain.totalTests === 2
    && chain.firstPromptState === 'executing'
    && chain.claimObservedBeforeStop === true
    && chain.fixtureEndpointTemplate === '/api/chat'
    && boundedInteger(chain.fixtureRequestId, 1, Number.MAX_SAFE_INTEGER)
    && boundedInteger(chain.fixtureSocketId, 1, Number.MAX_SAFE_INTEGER)
    && chain.socketOpenBeforeStop === true;

  const socketCloseMissing = observationState([
    cancellation.stopHttpStatus,
    cancellation.socketClosed,
    cancellation.socketCloseObservedMs,
    cancellation.socketCloseBudgetMs,
    cancellation.withinBudget,
  ]);
  const socketClosePass = cancellation.stopHttpStatus === 200
    && cancellation.socketClosed === true
    && boundedInteger(cancellation.socketCloseObservedMs, 0, 60_000)
    && cancellation.socketCloseBudgetMs === budget.socketCloseMs
    && cancellation.socketCloseObservedMs <= budget.socketCloseMs
    && cancellation.withinBudget === true;

  const quiescenceMissing = observationState([
    quiescence.durationMs,
    quiescence.firstPromptStarts,
    quiescence.secondPromptStarts,
    quiescence.promptStartsAfterCancel,
  ]);
  const quiescencePass = boundedInteger(quiescence.durationMs, budget.quiescenceMs, 120_000)
    && quiescence.firstPromptStarts === 1
    && quiescence.secondPromptStarts === 0
    && quiescence.promptStartsAfterCancel === 0;

  const terminalMissing = observationState([
    terminal.batchStatus,
    terminal.currentTestStage,
    terminal.activeSlotCleared,
    terminal.completed,
    terminal.failed,
    terminal.resultCount,
    terminal.checkpointCount,
  ]);
  const terminalPass = terminal.batchStatus === 'stopped'
    && terminal.currentTestStage === 'idle'
    && terminal.activeSlotCleared === true
    && terminal.completed === 0
    && terminal.failed === 0
    && terminal.resultCount === 0
    && terminal.checkpointCount === 0;

  const claimMissing = observationState([
    chain.claimObservedBeforeStop,
    terminal.claimCount,
    terminal.claimReleaseObservedMs,
  ]);
  const claimPass = chain.claimObservedBeforeStop === true
    && terminal.claimCount === 0
    && boundedInteger(terminal.claimReleaseObservedMs, 0, budget.settleMs);

  const identityMissing = observationState([
    identities.before?.core,
    identities.before?.benchmark,
    identities.after?.core,
    identities.after?.benchmark,
    identities.stable,
  ]);
  const identityPass = exactIdentity(identities.before?.core, 'agentx-core', receipt?.buildRevision)
    && exactIdentity(identities.before?.benchmark, 'agentx-benchmark', receipt?.buildRevision)
    && exactIdentity(identities.after?.core, 'agentx-core', receipt?.buildRevision)
    && exactIdentity(identities.after?.benchmark, 'agentx-benchmark', receipt?.buildRevision)
    && identitiesMatch(identities.before, identities.after)
    && identities.stable === true;

  const topologyMissing = observationState([
    topology.composeConfigHash,
    topology.services,
    topology.internalNetwork,
    topology.publishedPortCount,
    topology.persistentVolumeCount,
    topology.hostGateway,
    topology.ollamaTarget,
  ]);
  const topologyPass = /^[a-f0-9]{64}$/.test(topology.composeConfigHash || '')
    && JSON.stringify(topology.services) === JSON.stringify(EXPECTED_TOPOLOGY_SERVICES)
    && topology.internalNetwork === true
    && topology.publishedPortCount === 0
    && topology.persistentVolumeCount === 0
    && topology.hostGateway === false
    && topology.ollamaTarget === 'isolated-fixture';

  const status = (missing, pass) => missing || (pass ? 'pass' : 'fail');
  return Object.freeze([
    Object.freeze({ id: ASSERTION_IDS[0], status: status(socketOpenMissing, socketOpenPass) }),
    Object.freeze({ id: ASSERTION_IDS[1], status: status(socketCloseMissing, socketClosePass) }),
    Object.freeze({ id: ASSERTION_IDS[2], status: status(quiescenceMissing, quiescencePass) }),
    Object.freeze({ id: ASSERTION_IDS[3], status: status(terminalMissing, terminalPass) }),
    Object.freeze({ id: ASSERTION_IDS[4], status: status(claimMissing, claimPass) }),
    Object.freeze({ id: ASSERTION_IDS[5], status: status(identityMissing, identityPass) }),
    Object.freeze({ id: ASSERTION_IDS[6], status: status(topologyMissing, topologyPass) }),
  ]);
}

function inferredFailureCodes(assertions) {
  const byAssertion = Object.freeze({
    'socket-open-before-stop': 'FIRST_PROMPT_NOT_OBSERVED',
    'socket-closed-within-budget': 'SOCKET_CLOSE_NOT_OBSERVED',
    'no-next-prompt': 'QUIESCENCE_NOT_OBSERVED',
    'batch-stopped': 'TERMINAL_STATE_NOT_OBSERVED',
    'claim-released': 'CLAIM_RELEASE_NOT_OBSERVED',
    'service-identities-stable': 'SERVICE_IDENTITY_DRIFT',
    'isolated-topology': 'ISOLATED_TOPOLOGY_MISMATCH',
  });
  return assertions
    .filter((assertion) => assertion.status !== 'pass')
    .map((assertion) => byAssertion[assertion.id]);
}

function normalizedFailureCodes(value, assertions) {
  const supplied = Array.isArray(value) ? value : [];
  const combined = [...supplied, ...inferredFailureCodes(assertions)];
  return Object.freeze([...new Set(combined.filter((code) => FAILURE_CODE_SET.has(code)))].sort());
}

function createLiveCancellationReceipt(input = {}) {
  const draft = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    status: 'fail',
    evidenceMode: EVIDENCE_MODE,
    buildRevision: input.buildRevision ?? null,
    scenarioHash: input.scenarioHash ?? null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    budget: input.budget ?? null,
    topology: input.topology ?? null,
    identities: input.identities ?? null,
    chain: input.chain ?? null,
    cancellation: input.cancellation ?? null,
    terminal: input.terminal ?? null,
    quiescence: input.quiescence ?? null,
  };
  const assertions = deriveAssertionStatuses(draft);
  const failed = assertions.filter((assertion) => assertion.status !== 'pass').length;
  const failureCodes = normalizedFailureCodes(input.failureCodes, assertions);

  const receipt = {
    schemaVersion: draft.schemaVersion,
    kind: draft.kind,
    status: failed === 0 ? 'pass' : 'fail',
    evidenceMode: draft.evidenceMode,
    buildRevision: draft.buildRevision,
    scenarioHash: draft.scenarioHash,
    generatedAt: draft.generatedAt,
    budget: draft.budget,
    topology: draft.topology,
    identities: draft.identities,
    chain: draft.chain,
    cancellation: draft.cancellation,
    terminal: draft.terminal,
    quiescence: draft.quiescence,
    assertions,
    ...(failed > 0 || failureCodes.length > 0 ? { failureCodes } : {}),
    summary: Object.freeze({
      expected: ASSERTION_IDS.length,
      passed: ASSERTION_IDS.length - failed,
      failed,
    }),
    privacy: Object.freeze({
      addressesIncluded: false,
      rawPromptsIncluded: false,
      rawResponsesIncluded: false,
      batchIdentifiersIncluded: false,
      secretsIncluded: false,
    }),
  };
  return Object.freeze(receipt);
}

function privacyIssues(receipt) {
  const issues = [];
  const forbiddenKeys = new Set([
    'authorization',
    'batchId',
    'hostUrl',
    'origin',
    'password',
    'promptId',
    'promptIds',
    'rawPrompt',
    'rawResponse',
    'scenarioRunId',
    'secret',
    'token',
    'url',
  ]);
  const inspect = (value, path = '$') => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) issues.push(`${path}.${key} is a forbidden receipt field`);
        inspect(entry, `${path}.${key}`);
      }
      return;
    }
    if (typeof value !== 'string') return;
    if (/\b(?:https?|wss?):\/\//i.test(value)) issues.push(`${path} contains a URL`);
    if (/(?:^|[^\d])(?:\d{1,3}\.){3}\d{1,3}(?:[^\d]|$)/.test(value)
        || /(?:^|[\s[(])(?:(?:[A-Fa-f0-9]{1,4}:){2,}[A-Fa-f0-9:]{0,39}|::1)(?=$|[\s)\]])/.test(value)) {
      issues.push(`${path} contains an IP address`);
    }
    if (/\b[A-Fa-f0-9]{24}\b/.test(value) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(value)) {
      issues.push(`${path} contains a raw identifier`);
    }
    if (/AGENTX_LIVE_CANCEL_PROMPT_[12]|(?:^|[^a-z0-9])prompt-[12](?:[^a-z0-9]|$)/i.test(value)) {
      issues.push(`${path} contains a fixture sentinel`);
    }
    if (/\bBearer\s+\S+|X-AgentX-[A-Za-z-]*Token|(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]/i.test(value)) {
      issues.push(`${path} contains secret material`);
    }
  };
  inspect(receipt);
  return issues;
}

function validateLiveCancellationReceipt(receipt) {
  const errors = [];
  const expectedRootKeys = receipt?.status === 'fail'
    ? [...PASS_ROOT_KEYS.slice(0, 15), 'failureCodes', ...PASS_ROOT_KEYS.slice(15)]
    : [...PASS_ROOT_KEYS];
  if (!sameKeys(receipt, expectedRootKeys)) errors.push('receipt root fields or field order are invalid');
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) errors.push('schemaVersion must be 1');
  if (receipt?.kind !== RECEIPT_KIND) errors.push('kind is invalid');
  if (!['pass', 'fail'].includes(receipt?.status)) errors.push('status must be pass or fail');
  if (receipt?.evidenceMode !== EVIDENCE_MODE) errors.push('evidenceMode is invalid');
  if (!/^[a-f0-9]{40}$/.test(receipt?.buildRevision || '')) errors.push('buildRevision must be an exact commit SHA');
  if (!/^[a-f0-9]{12}$/.test(receipt?.scenarioHash || '')) errors.push('scenarioHash must be a bounded SHA-256 projection');
  if (!canonicalTimestamp(receipt?.generatedAt)) errors.push('generatedAt must be a canonical timestamp');

  if (!sameKeys(receipt?.budget, ['socketCloseMs', 'settleMs', 'quiescenceMs'])) {
    errors.push('budget shape is invalid');
  } else {
    if (!boundedInteger(receipt.budget.socketCloseMs, 1, 1_000)) errors.push('socketCloseMs must be between 1 and 1000');
    if (!boundedInteger(receipt.budget.settleMs, 1, 30_000)) errors.push('settleMs must be between 1 and 30000');
    if (!boundedInteger(receipt.budget.quiescenceMs, 2_500, 30_000)) errors.push('quiescenceMs must be between 2500 and 30000');
  }
  if (!sameKeys(receipt?.topology, [
    'composeConfigHash', 'services', 'internalNetwork', 'publishedPortCount',
    'persistentVolumeCount', 'hostGateway', 'ollamaTarget',
  ])) errors.push('topology shape is invalid');
  if (!sameKeys(receipt?.identities, ['before', 'after', 'stable'])
      || !sameKeys(receipt?.identities?.before, ['core', 'benchmark'])
      || !sameKeys(receipt?.identities?.after, ['core', 'benchmark'])) {
    errors.push('identities shape is invalid');
  }
  if (!sameKeys(receipt?.chain, [
    'batchHash', 'totalTests', 'firstPromptState', 'claimObservedBeforeStop',
    'fixtureEndpointTemplate', 'fixtureRequestId', 'fixtureSocketId', 'socketOpenBeforeStop',
  ])) errors.push('chain shape is invalid');
  if (!sameKeys(receipt?.cancellation, [
    'stopHttpStatus', 'socketClosed', 'socketCloseObservedMs', 'socketCloseBudgetMs', 'withinBudget',
  ])) errors.push('cancellation shape is invalid');
  if (!sameKeys(receipt?.terminal, [
    'batchStatus', 'currentTestStage', 'activeSlotCleared', 'completed', 'failed',
    'resultCount', 'checkpointCount', 'claimCount', 'claimReleaseObservedMs',
  ])) errors.push('terminal shape is invalid');
  if (!sameKeys(receipt?.quiescence, [
    'durationMs', 'firstPromptStarts', 'secondPromptStarts', 'promptStartsAfterCancel',
  ])) errors.push('quiescence shape is invalid');

  const recomputed = deriveAssertionStatuses(receipt);
  if (JSON.stringify(receipt?.assertions) !== JSON.stringify(recomputed)) {
    errors.push('assertions are inconsistent with retained evidence');
  }
  const failed = recomputed.filter((assertion) => assertion.status !== 'pass').length;
  const expectedStatus = failed === 0 ? 'pass' : 'fail';
  if (receipt?.status !== expectedStatus) errors.push('status is inconsistent with recomputed assertions');
  if (!sameKeys(receipt?.summary, ['expected', 'passed', 'failed'])
      || receipt.summary.expected !== ASSERTION_IDS.length
      || receipt.summary.passed !== ASSERTION_IDS.length - failed
      || receipt.summary.failed !== failed) {
    errors.push('summary is inconsistent with recomputed assertions');
  }
  if (receipt?.status === 'pass' && Object.hasOwn(receipt, 'failureCodes')) {
    errors.push('pass receipts must not contain failureCodes');
  }
  if (receipt?.status === 'fail') {
    if (!Array.isArray(receipt.failureCodes) || receipt.failureCodes.length === 0) {
      errors.push('fail receipts require at least one closed failureCode');
    } else {
      if (receipt.failureCodes.some((code) => !FAILURE_CODE_SET.has(code))) errors.push('failureCodes contains an unknown code');
      if (JSON.stringify(receipt.failureCodes) !== JSON.stringify([...new Set(receipt.failureCodes)].sort())) {
        errors.push('failureCodes must be unique and sorted');
      }
    }
  }

  if (!sameKeys(receipt?.privacy, [
    'addressesIncluded', 'rawPromptsIncluded', 'rawResponsesIncluded',
    'batchIdentifiersIncluded', 'secretsIncluded',
  ])) {
    errors.push('privacy shape is invalid');
  } else {
    for (const value of Object.values(receipt.privacy)) {
      if (value !== false) errors.push('all privacy inclusion flags must be false');
    }
  }
  errors.push(...privacyIssues(receipt));
  return errors;
}

module.exports = {
  ASSERTION_IDS,
  EVIDENCE_MODE,
  EXPECTED_PROFILE,
  EXPECTED_TOPOLOGY_SERVICES,
  EXPECTED_VERSION,
  FAILURE_CODES,
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  createLiveCancellationReceipt,
  deriveAssertionStatuses,
  privacyIssues,
  validateLiveCancellationReceipt,
};

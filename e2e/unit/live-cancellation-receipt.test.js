'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ASSERTION_IDS,
  RECEIPT_KIND,
  createLiveCancellationReceipt,
  validateLiveCancellationReceipt,
} = require('../live-cancellation-receipt');

const REVISION = 'a'.repeat(40);
const TOPOLOGY_HASH = 'b'.repeat(64);

function identity(service) {
  return {
    service,
    version: require('../../benchmark/package.json').version,
    profile: 'full',
    revision: REVISION,
  };
}

function passInput() {
  const before = {
    core: identity('agentx-core'),
    benchmark: identity('agentx-benchmark'),
  };
  return {
    buildRevision: REVISION,
    scenarioHash: 'c'.repeat(12),
    generatedAt: '2026-08-28T20:00:00.000Z',
    budget: { socketCloseMs: 1_000, settleMs: 5_000, quiescenceMs: 2_500 },
    topology: {
      composeConfigHash: TOPOLOGY_HASH,
      services: ['agentx-benchmark', 'agentx-core', 'mongo', 'ollama-fixture'],
      internalNetwork: true,
      publishedPortCount: 0,
      persistentVolumeCount: 0,
      hostGateway: false,
      ollamaTarget: 'isolated-fixture',
    },
    identities: {
      before,
      after: JSON.parse(JSON.stringify(before)),
      stable: true,
    },
    chain: {
      batchHash: 'd'.repeat(12),
      totalTests: 2,
      firstPromptState: 'executing',
      claimObservedBeforeStop: true,
      fixtureEndpointTemplate: '/api/chat',
      fixtureRequestId: 7,
      fixtureSocketId: 11,
      socketOpenBeforeStop: true,
    },
    cancellation: {
      stopHttpStatus: 200,
      socketClosed: true,
      socketCloseObservedMs: 73,
      socketCloseBudgetMs: 1_000,
      withinBudget: true,
    },
    terminal: {
      batchStatus: 'stopped',
      currentTestStage: 'idle',
      activeSlotCleared: true,
      completed: 0,
      failed: 0,
      resultCount: 0,
      checkpointCount: 0,
      claimCount: 0,
      claimReleaseObservedMs: 91,
    },
    quiescence: {
      durationMs: 2_500,
      firstPromptStarts: 1,
      secondPromptStarts: 0,
      promptStartsAfterCancel: 0,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('accepts the exact privacy-safe live cancellation pass receipt', () => {
  const receipt = createLiveCancellationReceipt(passInput());

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, RECEIPT_KIND);
  assert.equal(receipt.status, 'pass');
  assert.deepEqual(receipt.assertions.map((entry) => entry.id), ASSERTION_IDS);
  assert.deepEqual(receipt.assertions.map((entry) => entry.status), Array(7).fill('pass'));
  assert.deepEqual(receipt.summary, { expected: 7, passed: 7, failed: 0 });
  assert.equal(Object.hasOwn(receipt, 'failureCodes'), false);
  assert.deepEqual(validateLiveCancellationReceipt(receipt), []);
});

test('recomputes assertion, overall status, and summary consistency', () => {
  const receipt = clone(createLiveCancellationReceipt(passInput()));
  receipt.cancellation.socketCloseObservedMs = 1_001;

  const errors = validateLiveCancellationReceipt(receipt).join('\n');
  assert.match(errors, /assertions are inconsistent/);
  assert.match(errors, /status is inconsistent/);
  assert.match(errors, /summary is inconsistent/);
});

test('accepts a null-safe failure receipt with only closed failure codes', () => {
  const input = passInput();
  input.chain = Object.fromEntries(Object.keys(input.chain).map((key) => [key, null]));
  input.cancellation = {
    stopHttpStatus: null,
    socketClosed: null,
    socketCloseObservedMs: null,
    socketCloseBudgetMs: 1_000,
    withinBudget: null,
  };
  input.terminal = Object.fromEntries(Object.keys(input.terminal).map((key) => [key, null]));
  input.quiescence = Object.fromEntries(Object.keys(input.quiescence).map((key) => [key, null]));
  input.failureCodes = ['BATCH_START_FAILED'];

  const receipt = createLiveCancellationReceipt(input);
  assert.equal(receipt.status, 'fail');
  assert(receipt.assertions.some((entry) => entry.status === 'not-observed'));
  assert(receipt.failureCodes.includes('BATCH_START_FAILED'));
  assert.deepEqual(validateLiveCancellationReceipt(receipt), []);
});

test('rejects unknown, duplicate, or missing failure codes', () => {
  const failureInput = passInput();
  failureInput.cancellation.socketClosed = false;
  failureInput.cancellation.withinBudget = false;
  failureInput.failureCodes = ['STOP_FAILED'];
  const validFailure = createLiveCancellationReceipt(failureInput);
  for (const codes of [[], ['NOT_A_CLOSED_CODE'], ['STOP_FAILED', 'STOP_FAILED']]) {
    const receipt = clone(validFailure);
    receipt.failureCodes = codes;
    assert.notDeepEqual(validateLiveCancellationReceipt(receipt), []);
  }
});

test('rejects URLs, IP addresses, secret material, raw ids, and fixture sentinels', () => {
  const cases = [
    ['http://private.invalid/path', /URL/],
    ['peer 127.0.0.1', /IP address/],
    ['peer ::1', /IP address/],
    ['Bearer super-sensitive-value', /secret material/],
    ['66d000000000000000000001', /raw identifier/],
    ['AGENTX_LIVE_CANCEL_PROMPT_1', /fixture sentinel/],
    ['prompt-2', /fixture sentinel/],
  ];
  for (const [unsafe, expected] of cases) {
    const receipt = clone(createLiveCancellationReceipt(passInput()));
    receipt.chain.batchHash = unsafe;
    assert.match(validateLiveCancellationReceipt(receipt).join('\n'), expected, unsafe);
  }
});

test('rejects forbidden raw identifier fields even when their values are hashed', () => {
  const receipt = clone(createLiveCancellationReceipt(passInput()));
  receipt.chain.batchId = 'e'.repeat(12);

  assert.match(validateLiveCancellationReceipt(receipt).join('\n'), /forbidden receipt field/);
});

test('allows correlated positive fixture request and socket integers without leaking sentinels', () => {
  const receipt = createLiveCancellationReceipt(passInput());
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.chain.fixtureRequestId, 7);
  assert.equal(receipt.chain.fixtureSocketId, 11);
  assert.doesNotMatch(serialized, /AGENTX_LIVE_CANCEL_PROMPT|prompt-[12]/i);
  assert.deepEqual(validateLiveCancellationReceipt(receipt), []);
});

test('fails the exact isolated topology and stable identity assertions on drift', () => {
  const input = passInput();
  input.topology.hostGateway = true;
  input.identities.after.core.revision = 'f'.repeat(40);

  const receipt = createLiveCancellationReceipt(input);
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.assertions.find((entry) => entry.id === 'isolated-topology').status, 'fail');
  assert.equal(receipt.assertions.find((entry) => entry.id === 'service-identities-stable').status, 'fail');
  assert.deepEqual(validateLiveCancellationReceipt(receipt), []);
});

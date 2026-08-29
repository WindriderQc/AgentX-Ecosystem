'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_JSON_BYTES,
  PROMPT_IDS,
  RequestDeadlineError,
  boundedJsonRequest,
  fixtureObservation,
  parseArgs,
  runCli,
  startPayload,
  validFixtureState,
  verifyLiveCancellation,
} = require('../run-live-cancellation');
const { validateLiveCancellationReceipt } = require('../live-cancellation-receipt');

const REVISION = 'a'.repeat(40);
const TOPOLOGY_HASH = 'b'.repeat(64);
const BATCH_ID = '66e000000000000000000001';

function argv(overrides = {}) {
  const values = {
    '--benchmark-origin': 'http://127.0.0.1:3181',
    '--core-origin': 'http://127.0.0.1:3180',
    '--fixture-control-origin': 'http://127.0.0.1:11435',
    '--expected-revision': REVISION,
    '--expected-profile': 'full',
    '--scenario-run-id': 'live-cancel-test-run',
    '--topology-sha256': TOPOLOGY_HASH,
    '--socket-close-budget-ms': '1000',
    '--start-timeout-ms': '30000',
    '--settle-timeout-ms': '5000',
    '--quiescence-ms': '2500',
    '--output': 'test-results/live-cancellation.json',
    ...overrides,
  };
  return Object.entries(values).flat();
}

function fixtureState({ stopped = false } = {}) {
  const common = { requestId: 4, socketId: 9, sentinel: 'prompt-1' };
  return {
    schemaVersion: 1,
    fixture: 'agentx-live-cancellation-ollama',
    counters: { prompt1Starts: 1, prompt2Starts: 0, otherGenerationStarts: 2 },
    active: stopped ? [] : [{
      ...common,
      endpoint: '/api/chat',
      headersSent: true,
      socketOpen: true,
    }],
    events: [
      { ordinal: 1, type: 'request-start', ...common, at: '2026-08-28T20:00:00.000Z' },
      { ordinal: 2, type: 'response-headers', ...common, at: '2026-08-28T20:00:00.001Z' },
      ...(stopped ? [
        { ordinal: 3, type: 'response-close', ...common, at: '2026-08-28T20:00:00.010Z' },
        { ordinal: 4, type: 'socket-close', ...common, at: '2026-08-28T20:00:00.011Z' },
      ] : []),
    ],
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('parses only the bounded exact live-gate CLI contract', () => {
  const options = parseArgs(argv());

  assert.equal(options.expectedRevision, REVISION);
  assert.equal(options.expectedProfile, 'full');
  assert.equal(options.socketCloseBudgetMs, 1_000);
  assert.equal(options.startTimeoutMs, 30_000);
  assert.equal(options.settleTimeoutMs, 5_000);
  assert.equal(options.quiescenceMs, 2_500);
  assert.equal(options.fixtureControlOrigin, 'http://127.0.0.1:11435');
});

test('rejects ambiguous, unsafe, or weakened CLI inputs', () => {
  assert.throws(() => parseArgs([...argv(), '--output', 'again.json']), /duplicate argument/);
  assert.throws(() => parseArgs([...argv(), '--unknown', 'value']), /too many command-line arguments|unknown argument/);
  assert.throws(() => parseArgs(argv({ '--expected-revision': 'working-tree' })), /40-character commit SHA/);
  assert.throws(() => parseArgs(argv({ '--expected-profile': 'demo' })), /must be full/);
  assert.throws(() => parseArgs(argv({ '--fixture-control-origin': 'http://0.0.0.0:11435' })), /loopback control plane/);
  assert.throws(() => parseArgs(argv({ '--benchmark-origin': 'http://user:pass@127.0.0.1:3181' })), /credentials/);
  assert.throws(() => parseArgs(argv({ '--core-origin': 'http://127.0.0.1:3180/api' })), /path/);
  assert.throws(() => parseArgs(argv({ '--socket-close-budget-ms': '1001' })), /between 1 and 1000/);
  assert.throws(() => parseArgs(argv({ '--quiescence-ms': '2499' })), /between 2500 and 30000/);
});

test('uses the exact two seeded prompt ids and isolated launch payload', () => {
  assert.deepEqual(PROMPT_IDS, [
    '66d000000000000000000001',
    '66d000000000000000000002',
  ]);
  assert.deepEqual(startPayload(), {
    host: 'http://ollama-fixture:11434',
    models: ['agentx-cancel-fixture:1'],
    levels: [1],
    prompt_ids: [...PROMPT_IDS],
    run_name: 'Agent X live cancellation',
    judge_config: {
      host: 'http://ollama-fixture:11434',
      model: 'agentx-cancel-judge:1',
      think: false,
    },
    execution_config: {
      force_num_ctx: 4096,
      response_max_tokens: 256,
      response_mode: 'final_only',
      api_mode: 'chat',
      think: false,
      repeats: 1,
      per_test_timeout_ms: 30_000,
    },
    execution_mode: 'latency',
  });
});

test('owns its deadline when fetch ignores AbortSignal', async () => {
  const started = Date.now();
  await assert.rejects(
    boundedJsonRequest({
      fetchImpl: async () => new Promise(() => {}),
      origin: 'http://127.0.0.1:3180',
      requestPath: '/health',
      timeoutMs: 15,
    }),
    RequestDeadlineError
  );
  assert(Date.now() - started < 500);
});

test('rejects a declared or streamed JSON body over the fixed byte limit', async () => {
  await assert.rejects(
    boundedJsonRequest({
      fetchImpl: async () => json({}, 200, { 'Content-Length': String(MAX_JSON_BYTES + 1) }),
      origin: 'http://127.0.0.1:3180',
      requestPath: '/health',
      timeoutMs: 100,
    }),
    (error) => error.code === 'RESPONSE_TOO_LARGE'
  );

  const oversized = `"${'x'.repeat(32)}"`;
  await assert.rejects(
    boundedJsonRequest({
      fetchImpl: async () => new Response(oversized),
      origin: 'http://127.0.0.1:3180',
      requestPath: '/health',
      timeoutMs: 100,
      maxBytes: 8,
    }),
    (error) => error.code === 'RESPONSE_TOO_LARGE'
  );
});

test('requires exact ordered fixture events and correlates the stalled socket', () => {
  const state = fixtureState();
  assert.equal(validFixtureState(state), true);
  assert.deepEqual(fixtureObservation(state), {
    requestId: 4,
    socketId: 9,
    endpoint: '/api/chat',
    maxOrdinal: 2,
  });

  const unordered = structuredClone(state);
  unordered.events.reverse();
  assert.equal(validFixtureState(unordered), false);
  const wrongSocket = structuredClone(state);
  wrongSocket.events[1].socketId = 10;
  assert.equal(fixtureObservation(wrongSocket), null);
});

test('runs the exact causal chain and returns a recomputed privacy-safe pass receipt', async () => {
  let started = false;
  let stopped = false;
  let stateReads = 0;
  let clock = 0;
  const serviceIdentity = (service) => ({
    ok: true,
    status: 'ok',
    service,
    version: require('../../benchmark/package.json').version,
    profile: 'full',
    revision: REVISION,
    ts: '2026-08-28T20:00:00.000Z',
  });
  const fetchImpl = async (input, options = {}) => {
    const target = new URL(input);
    const key = `${options.method || 'GET'} ${target.origin}${target.pathname}`;
    if (key === 'GET http://127.0.0.1:3180/health') return json(serviceIdentity('agentx-core'));
    if (key === 'GET http://127.0.0.1:3181/health') return json(serviceIdentity('agentx-benchmark'));
    if (key === 'GET http://127.0.0.1:11435/health') {
      return json({ schemaVersion: 1, ok: true, fixture: 'agentx-live-cancellation-ollama' });
    }
    if (key === 'GET http://127.0.0.1:11435/state') {
      stateReads += 1;
      if (!started) {
        return json({
          schemaVersion: 1,
          fixture: 'agentx-live-cancellation-ollama',
          counters: { prompt1Starts: 0, prompt2Starts: 0, otherGenerationStarts: 0 },
          active: [],
          events: [],
        });
      }
      return json(fixtureState({ stopped }));
    }
    if (key === 'GET http://127.0.0.1:3180/api/nerve-center/host-preferences/benchmark-claims/active') {
      const claims = started && !stopped ? [{ batchId: BATCH_ID }] : [];
      return json({ status: 'success', data: { claims, count: claims.length } });
    }
    if (key === 'POST http://127.0.0.1:3181/api/benchmark/batch') {
      assert.equal(options.headers.Origin, undefined);
      started = true;
      return json({ status: 'success', data: { batch_id: BATCH_ID, total_tests: 2 } });
    }
    if (key === `GET http://127.0.0.1:3181/api/benchmark/batch/${BATCH_ID}`) {
      return json({
        status: 'success',
        data: stopped ? {
          status: 'stopped',
          current_test: { stage: 'idle' },
          active_slot: null,
          completed: 0,
          failed: 0,
          results_meta: { total: 0 },
          checkpoint: { completed_pairs: [] },
        } : {
          status: 'running',
          current_test: { stage: 'executing' },
          active_slot: 'benchmark_singleton',
          completed: 0,
          failed: 0,
          results_meta: { total: 0 },
          checkpoint: { completed_pairs: [] },
        },
      });
    }
    if (key === `POST http://127.0.0.1:3181/api/benchmark/batch/${BATCH_ID}/stop`) {
      assert.equal(options.headers.Origin, undefined);
      stopped = true;
      return json({
        status: 'success',
        data: { batch_id: BATCH_ID, status: 'stopped' },
      });
    }
    throw new Error(`unexpected mock route: ${key}`);
  };
  const options = parseArgs(argv());
  const receipt = await verifyLiveCancellation(options, {
    fetchImpl,
    monotonicNow: () => clock,
    delayImpl: async (milliseconds) => { clock += milliseconds; },
    now: () => new Date('2026-08-28T20:00:05.000Z'),
  });

  assert.equal(stateReads >= 4, true);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.chain.batchHash.length, 12);
  assert.equal(receipt.chain.fixtureRequestId, 4);
  assert.equal(receipt.chain.fixtureSocketId, 9);
  assert.equal(receipt.terminal.resultCount, 0);
  assert.equal(receipt.terminal.checkpointCount, 0);
  assert.equal(receipt.quiescence.durationMs, 2_500);
  assert.deepEqual(validateLiveCancellationReceipt(receipt), []);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(BATCH_ID));
  assert.doesNotMatch(JSON.stringify(receipt), /127\.0\.0\.1|ollama-fixture:11434|prompt-[12]/i);
});

test('returns a valid privacy-safe failure receipt with closed codes', async () => {
  const serviceIdentity = (service) => ({
    ok: true,
    status: 'ok',
    service,
    version: require('../../benchmark/package.json').version,
    profile: 'full',
    revision: REVISION,
    ts: '2026-08-28T20:00:00.000Z',
  });
  const fetchImpl = async (input) => {
    const target = new URL(input);
    if (target.origin === 'http://127.0.0.1:3180' && target.pathname === '/health') {
      return json(serviceIdentity('agentx-core'));
    }
    if (target.origin === 'http://127.0.0.1:3181' && target.pathname === '/health') {
      return json(serviceIdentity('agentx-benchmark'));
    }
    if (target.origin === 'http://127.0.0.1:11435' && target.pathname === '/health') {
      return json({ status: 'unavailable' }, 503);
    }
    throw new Error('unexpected route');
  };

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-live-cancel-'));
  const outputPath = path.join(directory, 'failure.json');
  try {
    await assert.rejects(
      runCli(argv({ '--output': outputPath }), {
        fetchImpl,
        now: () => new Date('2026-08-28T20:00:05.000Z'),
      }),
      (error) => {
        const receipt = error.receipt;
        assert.equal(receipt.status, 'fail');
        assert(receipt.failureCodes.includes('FIXTURE_HEALTH_UNAVAILABLE'));
        assert(receipt.failureCodes.every((code) => /^[A-Z][A-Z_]+$/.test(code)));
        assert.deepEqual(validateLiveCancellationReceipt(receipt), []);
        return true;
      }
    );
    const serialized = fs.readFileSync(outputPath, 'utf8');
    const persisted = JSON.parse(serialized);
    assert.equal(persisted.status, 'fail');
    assert.deepEqual(validateLiveCancellationReceipt(persisted), []);
    assert.doesNotMatch(serialized, /https?:\/\/|127\.0\.0\.1|66d000|prompt-[12]|Bearer/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

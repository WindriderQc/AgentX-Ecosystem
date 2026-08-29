'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  FAILURE_CODES,
  EXPECTED_PROFILE,
  EXPECTED_VERSION,
  createLiveCancellationReceipt,
  validateLiveCancellationReceipt,
} = require('./live-cancellation-receipt');

const DEFAULTS = Object.freeze({
  benchmarkOrigin: 'http://127.0.0.1:3181',
  coreOrigin: 'http://127.0.0.1:3180',
  fixtureControlOrigin: 'http://127.0.0.1:11435',
  socketCloseBudgetMs: 1_000,
  startTimeoutMs: 30_000,
  settleTimeoutMs: 5_000,
  quiescenceMs: 2_500,
});
const FIXTURE_IDENTITY = 'agentx-live-cancellation-ollama';
const EXECUTION_MODEL = 'agentx-cancel-fixture:1';
const JUDGE_MODEL = 'agentx-cancel-judge:1';
const OLLAMA_FIXTURE_ORIGIN = 'http://ollama-fixture:11434';
const PROMPT_IDS = Object.freeze([
  '66d000000000000000000001',
  '66d000000000000000000002',
]);
const MAX_JSON_BYTES = 512 * 1024;
const POLL_INTERVAL_MS = 25;
const FAILURE_CODE_SET = new Set(FAILURE_CODES);

class LiveCancellationObservationError extends Error {
  constructor(receipt) {
    super(`live cancellation observation failed: ${receipt.failureCodes.join(', ')}`);
    this.name = 'LiveCancellationObservationError';
    this.receipt = receipt;
  }
}

class RequestDeadlineError extends Error {
  constructor() {
    super('bounded request deadline exceeded');
    this.name = 'RequestDeadlineError';
    this.code = 'REQUEST_DEADLINE_EXCEEDED';
  }
}

class PollDeadlineError extends Error {
  constructor(lastValue) {
    super('bounded observation deadline exceeded');
    this.name = 'PollDeadlineError';
    this.code = 'OBSERVATION_DEADLINE_EXCEEDED';
    this.lastValue = lastValue;
  }
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function normalizeOrigin(value, label, { fixtureControl = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} must be a valid HTTP origin`);
  }
  required(['http:', 'https:'].includes(parsed.protocol), `${label} must use HTTP or HTTPS`);
  required(!parsed.username && !parsed.password, `${label} must not contain credentials`);
  required((parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash,
    `${label} must not contain a path, query, or fragment`);
  if (fixtureControl) {
    required(parsed.protocol === 'http:', 'fixture control origin must use HTTP');
    required(parsed.hostname === '127.0.0.1' && parsed.port === '11435',
      'fixture control origin must be the isolated loopback control plane');
  }
  return parsed.origin;
}

function parseInteger(value, label, minimum, maximum) {
  required(/^\d+$/.test(String(value || '')), `${label} must be an integer`);
  const parsed = Number(value);
  required(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function parseArgs(argv) {
  required(Array.isArray(argv) && argv.length <= 64, 'too many command-line arguments');
  const raw = {
    benchmarkOrigin: DEFAULTS.benchmarkOrigin,
    coreOrigin: DEFAULTS.coreOrigin,
    fixtureControlOrigin: DEFAULTS.fixtureControlOrigin,
    socketCloseBudgetMs: DEFAULTS.socketCloseBudgetMs,
    startTimeoutMs: DEFAULTS.startTimeoutMs,
    settleTimeoutMs: DEFAULTS.settleTimeoutMs,
    quiescenceMs: DEFAULTS.quiescenceMs,
  };
  const flags = Object.freeze({
    '--benchmark-origin': 'benchmarkOrigin',
    '--core-origin': 'coreOrigin',
    '--fixture-control-origin': 'fixtureControlOrigin',
    '--expected-revision': 'expectedRevision',
    '--expected-profile': 'expectedProfile',
    '--scenario-run-id': 'scenarioRunId',
    '--topology-sha256': 'topologySha256',
    '--socket-close-budget-ms': 'socketCloseBudgetMs',
    '--start-timeout-ms': 'startTimeoutMs',
    '--settle-timeout-ms': 'settleTimeoutMs',
    '--quiescence-ms': 'quiescenceMs',
    '--output': 'outputPath',
  });
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    required(Object.hasOwn(flags, flag), `unknown argument: ${flag}`);
    required(!seen.has(flag), `duplicate argument: ${flag}`);
    const value = argv[index + 1];
    required(value !== undefined && !String(value).startsWith('--'), `${flag} requires a value`);
    required(String(value).length <= 4_096, `${flag} value is too long`);
    seen.add(flag);
    raw[flags[flag]] = value;
    index += 1;
  }

  raw.benchmarkOrigin = normalizeOrigin(raw.benchmarkOrigin, 'benchmark origin');
  raw.coreOrigin = normalizeOrigin(raw.coreOrigin, 'core origin');
  raw.fixtureControlOrigin = normalizeOrigin(raw.fixtureControlOrigin, 'fixture control origin', { fixtureControl: true });
  raw.socketCloseBudgetMs = parseInteger(raw.socketCloseBudgetMs, 'socket close budget', 1, 1_000);
  raw.startTimeoutMs = parseInteger(raw.startTimeoutMs, 'start timeout', 1, 120_000);
  raw.settleTimeoutMs = parseInteger(raw.settleTimeoutMs, 'settle timeout', 1, 30_000);
  raw.quiescenceMs = parseInteger(raw.quiescenceMs, 'quiescence', 2_500, 30_000);

  raw.expectedRevision = String(raw.expectedRevision || '').trim().toLowerCase();
  required(/^[a-f0-9]{40}$/.test(raw.expectedRevision),
    'expected revision is required and must be a 40-character commit SHA');
  raw.expectedProfile = String(raw.expectedProfile || '').trim().toLowerCase();
  required(raw.expectedProfile === EXPECTED_PROFILE, `expected profile is required and must be ${EXPECTED_PROFILE}`);
  raw.scenarioRunId = String(raw.scenarioRunId || '').trim();
  required(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(raw.scenarioRunId),
    'scenario run id is required and must be bounded');
  raw.topologySha256 = String(raw.topologySha256 || '').trim().toLowerCase();
  required(/^[a-f0-9]{64}$/.test(raw.topologySha256),
    'topology sha256 is required and must be 64 lowercase hexadecimal characters');
  raw.outputPath = String(raw.outputPath || '').trim();
  required(raw.outputPath.length > 0 && raw.outputPath.length <= 4_096, 'output is required and must be bounded');
  return Object.freeze(raw);
}

async function readBoundedJson(response, { maxBytes = MAX_JSON_BYTES } = {}) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error('bounded JSON response is too large');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }

  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      const error = new Error('bounded JSON response is too large');
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    chunks.push(bytes);
  };

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch {}
      throw error;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  } else if (response?.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) append(chunk);
  } else if (typeof response?.arrayBuffer === 'function') {
    append(new Uint8Array(await response.arrayBuffer()));
  } else {
    throw new Error('bounded JSON response body is unavailable');
  }

  const text = Buffer.concat(chunks, size).toString('utf8');
  if (!text.trim()) throw new Error('bounded JSON response body is empty');
  return JSON.parse(text);
}

async function boundedJsonRequest({
  fetchImpl,
  origin,
  requestPath,
  method = 'GET',
  headers = {},
  body,
  timeoutMs,
  maxBytes = MAX_JSON_BYTES,
  monotonicNow = monotonicMilliseconds,
}) {
  required(typeof fetchImpl === 'function', 'fetch implementation is required');
  required(typeof requestPath === 'string' && requestPath.startsWith('/') && !requestPath.startsWith('//'),
    'request path must be an origin-relative absolute path');
  required(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'request timeout is invalid');
  const controller = new AbortController();
  const started = monotonicNow();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new RequestDeadlineError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const operation = (async () => {
    const requestHeaders = { Accept: 'application/json', ...headers };
    let serializedBody;
    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(body);
      required(Buffer.byteLength(serializedBody, 'utf8') <= 64 * 1024, 'request JSON body is too large');
    }
    const response = await fetchImpl(new URL(requestPath, origin), {
      method,
      headers: requestHeaders,
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    const parsedBody = await readBoundedJson(response, { maxBytes });
    return Object.freeze({
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
      body: parsedBody,
      durationMs: Math.max(0, Math.round(monotonicNow() - started)),
    });
  })();

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollUntil({
  load,
  accept,
  timeoutMs,
  intervalMs = POLL_INTERVAL_MS,
  monotonicNow = monotonicMilliseconds,
  delayImpl = delay,
}) {
  const started = monotonicNow();
  let lastValue = null;
  let lastError = null;
  while (true) {
    const elapsed = monotonicNow() - started;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      const error = new PollDeadlineError(lastValue);
      error.lastError = lastError;
      throw error;
    }
    try {
      lastValue = await load(Math.max(1, Math.ceil(remaining)));
      lastError = null;
      if (accept(lastValue)) {
        return Object.freeze({
          value: lastValue,
          observedMs: Math.max(0, Math.round(monotonicNow() - started)),
        });
      }
    } catch (error) {
      if (error?.code === 'FIXTURE_CONTRACT_MISMATCH') throw error;
      lastError = error;
    }
    const nextRemaining = timeoutMs - (monotonicNow() - started);
    if (nextRemaining <= 0) continue;
    await delayImpl(Math.min(intervalMs, Math.max(1, Math.floor(nextRemaining))));
  }
}

function hashProjection(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function canonicalTimestamp(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  required(Number.isFinite(time), 'clock returned an invalid timestamp');
  return new Date(time).toISOString();
}

function exactObjectKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validFixtureState(body) {
  if (!exactObjectKeys(body, ['schemaVersion', 'fixture', 'counters', 'active', 'events'])) return false;
  if (body.schemaVersion !== 1 || body.fixture !== FIXTURE_IDENTITY) return false;
  if (!exactObjectKeys(body.counters, ['prompt1Starts', 'prompt2Starts', 'otherGenerationStarts'])) return false;
  if (!Object.values(body.counters).every((value) => Number.isInteger(value) && value >= 0)) return false;
  if (!Array.isArray(body.active) || body.active.length > 16) return false;
  if (!Array.isArray(body.events) || body.events.length > 100) return false;
  const activeOkay = body.active.every((entry) => exactObjectKeys(entry, [
    'requestId', 'socketId', 'sentinel', 'endpoint', 'headersSent', 'socketOpen',
  ])
    && Number.isInteger(entry.requestId) && entry.requestId > 0
    && Number.isInteger(entry.socketId) && entry.socketId > 0
    && ['prompt-1', 'prompt-2', 'other'].includes(entry.sentinel)
    && ['/api/chat', '/api/generate'].includes(entry.endpoint)
    && typeof entry.headersSent === 'boolean'
    && typeof entry.socketOpen === 'boolean');
  if (!activeOkay) return false;
  let previousOrdinal = 0;
  for (const event of body.events) {
    if (!exactObjectKeys(event, ['ordinal', 'type', 'requestId', 'socketId', 'sentinel', 'at'])) return false;
    if (!Number.isInteger(event.ordinal) || event.ordinal <= previousOrdinal) return false;
    previousOrdinal = event.ordinal;
    if (!['request-start', 'response-headers', 'response-close', 'socket-close'].includes(event.type)) return false;
    if (!Number.isInteger(event.requestId) || event.requestId <= 0) return false;
    if (!Number.isInteger(event.socketId) || event.socketId <= 0) return false;
    if (!['prompt-1', 'prompt-2', 'other'].includes(event.sentinel)) return false;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== event.at) return false;
  }
  return true;
}

function fixtureObservation(body) {
  if (!validFixtureState(body)) {
    const error = new Error('fixture state contract mismatch');
    error.code = 'FIXTURE_CONTRACT_MISMATCH';
    throw error;
  }
  const candidates = body.active.filter((entry) => entry.sentinel === 'prompt-1');
  if (candidates.length !== 1) return null;
  const active = candidates[0];
  const matchingEvents = body.events.filter((event) => (
    event.requestId === active.requestId && event.socketId === active.socketId
  ));
  if (!matchingEvents.some((event) => event.type === 'request-start' && event.sentinel === 'prompt-1')) return null;
  if (!matchingEvents.some((event) => event.type === 'response-headers' && event.sentinel === 'prompt-1')) return null;
  if (body.counters.prompt1Starts !== 1 || body.counters.prompt2Starts !== 0) return null;
  if (active.endpoint !== '/api/chat' || active.headersSent !== true || active.socketOpen !== true) return null;
  return Object.freeze({
    requestId: active.requestId,
    socketId: active.socketId,
    endpoint: active.endpoint,
    maxOrdinal: body.events.length ? body.events.at(-1).ordinal : 0,
  });
}

function projectIdentity(body) {
  if (!isPlainObject(body)) return null;
  return Object.freeze({
    service: typeof body.service === 'string' ? body.service : null,
    version: typeof body.version === 'string' ? body.version : null,
    profile: typeof body.profile === 'string' ? body.profile : null,
    revision: typeof body.revision === 'string' ? body.revision : null,
  });
}

function exactIdentity(identity, service, revision) {
  return identity?.service === service
    && identity?.version === EXPECTED_VERSION
    && identity?.profile === EXPECTED_PROFILE
    && identity?.revision === revision;
}

function claimEnvelope(body) {
  const claims = body?.data?.claims;
  const count = body?.data?.count;
  if (body?.status !== 'success' || !Array.isArray(claims)
      || !Number.isInteger(count) || count < 0 || count !== claims.length) return null;
  return Object.freeze({ claims, count });
}

function terminalProjection(body) {
  const data = body?.data;
  if (body?.status !== 'success' || !isPlainObject(data)) return null;
  return Object.freeze({
    batchStatus: typeof data.status === 'string' ? data.status : null,
    currentTestStage: typeof data.current_test?.stage === 'string' ? data.current_test.stage : null,
    activeSlotCleared: data.active_slot === null,
    completed: Number.isInteger(data.completed) ? data.completed : null,
    failed: Number.isInteger(data.failed) ? data.failed : null,
    resultCount: Number.isInteger(data.results_meta?.total) ? data.results_meta.total : null,
    checkpointCount: Array.isArray(data.checkpoint?.completed_pairs)
      ? data.checkpoint.completed_pairs.length
      : null,
  });
}

function terminalPass(projection) {
  return projection?.batchStatus === 'stopped'
    && projection.currentTestStage === 'idle'
    && projection.activeSlotCleared === true
    && projection.completed === 0
    && projection.failed === 0
    && projection.resultCount === 0
    && projection.checkpointCount === 0;
}

function createEvidence(config) {
  return {
    buildRevision: config.expectedRevision,
    scenarioHash: hashProjection(config.scenarioRunId),
    generatedAt: null,
    budget: {
      socketCloseMs: config.socketCloseBudgetMs,
      settleMs: config.settleTimeoutMs,
      quiescenceMs: config.quiescenceMs,
    },
    topology: {
      composeConfigHash: config.topologySha256,
      services: ['agentx-benchmark', 'agentx-core', 'mongo', 'ollama-fixture'],
      internalNetwork: true,
      publishedPortCount: 0,
      persistentVolumeCount: 0,
      hostGateway: false,
      ollamaTarget: 'isolated-fixture',
    },
    identities: {
      before: { core: null, benchmark: null },
      after: { core: null, benchmark: null },
      stable: null,
    },
    chain: {
      batchHash: null,
      totalTests: null,
      firstPromptState: null,
      claimObservedBeforeStop: null,
      fixtureEndpointTemplate: null,
      fixtureRequestId: null,
      fixtureSocketId: null,
      socketOpenBeforeStop: null,
    },
    cancellation: {
      stopHttpStatus: null,
      socketClosed: null,
      socketCloseObservedMs: null,
      socketCloseBudgetMs: config.socketCloseBudgetMs,
      withinBudget: null,
    },
    terminal: {
      batchStatus: null,
      currentTestStage: null,
      activeSlotCleared: null,
      completed: null,
      failed: null,
      resultCount: null,
      checkpointCount: null,
      claimCount: null,
      claimReleaseObservedMs: null,
    },
    quiescence: {
      durationMs: null,
      firstPromptStarts: null,
      secondPromptStarts: null,
      promptStartsAfterCancel: null,
    },
  };
}

function startPayload() {
  return {
    host: OLLAMA_FIXTURE_ORIGIN,
    models: [EXECUTION_MODEL],
    levels: [1],
    prompt_ids: [...PROMPT_IDS],
    run_name: 'Agent X live cancellation',
    judge_config: {
      host: OLLAMA_FIXTURE_ORIGIN,
      model: JUDGE_MODEL,
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
  };
}

function writeReceipt(outputPath, receipt) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return resolved;
}

async function executeLiveCancellation(options, dependencies = {}) {
  const config = Object.freeze({ ...options });
  const fetchImpl = dependencies.fetchImpl || fetch;
  const monotonicNow = dependencies.monotonicNow || monotonicMilliseconds;
  const wallNow = dependencies.now || (() => new Date());
  const delayImpl = dependencies.delayImpl || delay;
  const evidence = createEvidence(config);
  const failureCodes = new Set();
  let batchId = null;
  let fixtureChain = null;
  let preStopMaxOrdinal = null;
  let stopStartedAt = null;

  const addFailure = (code) => {
    failureCodes.add(FAILURE_CODE_SET.has(code) ? code : 'UNEXPECTED_DRIVER_FAILURE');
  };
  const request = (origin, requestPath, requestOptions = {}) => boundedJsonRequest({
    fetchImpl,
    origin,
    requestPath,
    timeoutMs: requestOptions.timeoutMs || config.settleTimeoutMs,
    monotonicNow,
    ...requestOptions,
  });
  const readFixtureState = async (timeoutMs = config.settleTimeoutMs) => {
    const response = await request(config.fixtureControlOrigin, '/state', { timeoutMs });
    if (response.httpStatus !== 200 || !validFixtureState(response.body)) {
      const error = new Error('fixture state contract mismatch');
      error.code = 'FIXTURE_CONTRACT_MISMATCH';
      throw error;
    }
    return response.body;
  };
  const readBatch = (id, timeoutMs = config.settleTimeoutMs) => request(
    config.benchmarkOrigin,
    `/api/benchmark/batch/${encodeURIComponent(id)}`,
    { timeoutMs }
  );
  const readClaims = (timeoutMs = config.settleTimeoutMs) => request(
    config.coreOrigin,
    '/api/nerve-center/host-preferences/benchmark-claims/active',
    { timeoutMs }
  );

  async function collectIdentities(phase, { failClosed = true } = {}) {
    const settled = await Promise.allSettled([
      request(config.coreOrigin, '/health'),
      request(config.benchmarkOrigin, '/health'),
    ]);
    const specs = [
      { key: 'core', service: 'agentx-core', unavailable: 'CORE_HEALTH_UNAVAILABLE', mismatch: 'CORE_IDENTITY_MISMATCH' },
      { key: 'benchmark', service: 'agentx-benchmark', unavailable: 'BENCHMARK_HEALTH_UNAVAILABLE', mismatch: 'BENCHMARK_IDENTITY_MISMATCH' },
    ];
    let okay = true;
    specs.forEach((spec, index) => {
      const result = settled[index];
      if (result.status !== 'fulfilled' || result.value.httpStatus !== 200 || result.value.body?.ok !== true) {
        addFailure(spec.unavailable);
        okay = false;
        return;
      }
      const identity = projectIdentity(result.value.body);
      evidence.identities[phase][spec.key] = identity;
      if (!exactIdentity(identity, spec.service, config.expectedRevision)) {
        addFailure(spec.mismatch);
        okay = false;
      }
    });
    if (!okay && failClosed) return false;
    return okay;
  }

  let setupOkay = await collectIdentities('before');
  if (setupOkay) {
    try {
      const fixtureHealth = await request(config.fixtureControlOrigin, '/health');
      if (fixtureHealth.httpStatus !== 200) {
        addFailure('FIXTURE_HEALTH_UNAVAILABLE');
        setupOkay = false;
      } else if (!exactObjectKeys(fixtureHealth.body, ['schemaVersion', 'ok', 'fixture'])
          || fixtureHealth.body.schemaVersion !== 1
          || fixtureHealth.body.ok !== true
          || fixtureHealth.body.fixture !== FIXTURE_IDENTITY) {
        addFailure('FIXTURE_CONTRACT_MISMATCH');
        setupOkay = false;
      }
    } catch {
      addFailure('FIXTURE_HEALTH_UNAVAILABLE');
      setupOkay = false;
    }
  }

  if (setupOkay) {
    const initial = await Promise.allSettled([readFixtureState(), readClaims()]);
    if (initial[0].status !== 'fulfilled') {
      addFailure(initial[0].reason?.code === 'FIXTURE_CONTRACT_MISMATCH'
        ? 'FIXTURE_CONTRACT_MISMATCH'
        : 'FIXTURE_HEALTH_UNAVAILABLE');
      setupOkay = false;
    } else {
      const state = initial[0].value;
      const fresh = state.counters.prompt1Starts === 0
        && state.counters.prompt2Starts === 0
        && state.counters.otherGenerationStarts === 0
        && state.active.length === 0
        && state.events.length === 0;
      if (!fresh) {
        addFailure('FIXTURE_NOT_FRESH');
        setupOkay = false;
      }
    }
    if (initial[1].status !== 'fulfilled') {
      addFailure('CLAIM_NOT_OBSERVED');
      setupOkay = false;
    } else {
      const claims = claimEnvelope(initial[1].value.body);
      if (initial[1].value.httpStatus !== 200 || !claims || claims.count !== 0) {
        addFailure('FIXTURE_NOT_FRESH');
        setupOkay = false;
      }
    }
  }

  if (setupOkay) {
    try {
      const startedAt = monotonicNow();
      const startResponse = await request(config.benchmarkOrigin, '/api/benchmark/batch', {
        method: 'POST',
        body: startPayload(),
        timeoutMs: config.startTimeoutMs,
      });
      const startData = startResponse.body?.data;
      if (startResponse.httpStatus !== 200
          || startResponse.body?.status !== 'success'
          || !/^[a-f0-9]{24}$/.test(startData?.batch_id || '')
          || startData?.total_tests !== 2) {
        addFailure('BATCH_START_CONTRACT_MISMATCH');
      } else {
        batchId = startData.batch_id;
        evidence.chain.batchHash = hashProjection(batchId);
        evidence.chain.totalTests = startData.total_tests;
        const remainingStartBudget = () => Math.max(1, Math.ceil(
          config.startTimeoutMs - (monotonicNow() - startedAt)
        ));
        try {
          const first = await pollUntil({
            timeoutMs: remainingStartBudget(),
            monotonicNow,
            delayImpl,
            load: (remaining) => readFixtureState(Math.min(config.settleTimeoutMs, remaining)),
            accept: (state) => Boolean(fixtureObservation(state)),
          });
          fixtureChain = fixtureObservation(first.value);
        } catch (error) {
          addFailure(error?.code === 'FIXTURE_CONTRACT_MISMATCH'
            ? 'FIXTURE_CONTRACT_MISMATCH'
            : 'FIRST_PROMPT_NOT_OBSERVED');
        }

        if (fixtureChain) {
          let latestCausal = null;
          try {
            const causal = await pollUntil({
              timeoutMs: remainingStartBudget(),
              monotonicNow,
              delayImpl,
              load: async (remaining) => {
                const timeoutMs = Math.min(config.settleTimeoutMs, remaining);
                const [batch, claims] = await Promise.all([
                  readBatch(batchId, timeoutMs),
                  readClaims(timeoutMs),
                ]);
                const projection = terminalProjection(batch.body);
                const claimData = claimEnvelope(claims.body);
                return { batch, projection, claims: claimData };
              },
              accept: (value) => value.batch.httpStatus === 200
                && value.projection?.batchStatus === 'running'
                && value.projection?.currentTestStage === 'executing'
                && value.claims
                && value.claims.claims.some((claim) => claim?.batchId === batchId),
            });
            latestCausal = causal.value;
          } catch (error) {
            latestCausal = error?.lastValue || null;
            if (latestCausal?.projection?.currentTestStage !== 'executing') addFailure('FIRST_PROMPT_NOT_OBSERVED');
            if (!latestCausal?.claims?.claims?.some((claim) => claim?.batchId === batchId)) addFailure('CLAIM_NOT_OBSERVED');
          }
          if (latestCausal?.projection?.currentTestStage === 'executing') {
            evidence.chain.firstPromptState = 'executing';
          }
          if (latestCausal?.claims?.claims?.some((claim) => claim?.batchId === batchId)) {
            evidence.chain.claimObservedBeforeStop = true;
          }

          try {
            const immediatelyBeforeStop = await readFixtureState();
            const exact = fixtureObservation(immediatelyBeforeStop);
            if (exact
                && exact.requestId === fixtureChain.requestId
                && exact.socketId === fixtureChain.socketId) {
              fixtureChain = exact;
              preStopMaxOrdinal = exact.maxOrdinal;
              evidence.chain.fixtureEndpointTemplate = exact.endpoint;
              evidence.chain.fixtureRequestId = exact.requestId;
              evidence.chain.fixtureSocketId = exact.socketId;
              evidence.chain.socketOpenBeforeStop = true;
            } else {
              addFailure('FIRST_PROMPT_NOT_OBSERVED');
            }
          } catch (error) {
            addFailure(error?.code === 'FIXTURE_CONTRACT_MISMATCH'
              ? 'FIXTURE_CONTRACT_MISMATCH'
              : 'FIRST_PROMPT_NOT_OBSERVED');
          }
        }
      }
    } catch {
      addFailure('BATCH_START_FAILED');
    }
  }

  if (batchId) {
    if (preStopMaxOrdinal === null) {
      try {
        const state = await readFixtureState();
        preStopMaxOrdinal = state.events.length ? state.events.at(-1).ordinal : 0;
      } catch {}
    }
    stopStartedAt = monotonicNow();
    const stopPromise = request(
      config.benchmarkOrigin,
      `/api/benchmark/batch/${encodeURIComponent(batchId)}/stop`,
      {
        method: 'POST',
        body: {},
        timeoutMs: config.settleTimeoutMs,
      }
    );
    const closePromise = fixtureChain && preStopMaxOrdinal !== null
      ? pollUntil({
        timeoutMs: config.socketCloseBudgetMs,
        monotonicNow,
        delayImpl,
        load: (remaining) => readFixtureState(Math.min(config.settleTimeoutMs, remaining)),
        accept: (state) => {
          const closeEvent = state.events.find((event) => (
            event.ordinal > preStopMaxOrdinal
            && event.type === 'socket-close'
            && event.requestId === fixtureChain.requestId
            && event.socketId === fixtureChain.socketId
            && event.sentinel === 'prompt-1'
          ));
          const stillOpen = state.active.some((entry) => (
            entry.requestId === fixtureChain.requestId
            && entry.socketId === fixtureChain.socketId
            && entry.socketOpen === true
          ));
          return Boolean(closeEvent) && !stillOpen;
        },
      })
      : Promise.reject(new PollDeadlineError(null));
    const [stopOutcome, closeOutcome] = await Promise.allSettled([stopPromise, closePromise]);
    if (stopOutcome.status === 'fulfilled') {
      const response = stopOutcome.value;
      evidence.cancellation.stopHttpStatus = response.httpStatus;
      if (response.httpStatus !== 200
          || response.body?.status !== 'success'
          || response.body?.data?.batch_id !== batchId
          || response.body?.data?.status !== 'stopped') {
        addFailure('STOP_FAILED');
      }
    } else {
      addFailure('STOP_FAILED');
    }
    if (closeOutcome.status === 'fulfilled') {
      const observedMs = Math.max(0, closeOutcome.value.observedMs);
      evidence.cancellation.socketClosed = true;
      evidence.cancellation.socketCloseObservedMs = observedMs;
      evidence.cancellation.withinBudget = observedMs <= config.socketCloseBudgetMs;
      if (!evidence.cancellation.withinBudget) addFailure('SOCKET_CLOSE_BUDGET_EXCEEDED');
    } else {
      evidence.cancellation.socketClosed = false;
      evidence.cancellation.socketCloseObservedMs = config.socketCloseBudgetMs;
      evidence.cancellation.withinBudget = false;
      addFailure('SOCKET_CLOSE_NOT_OBSERVED');
    }

    let terminalLast = null;
    let claimReleaseObservedMs = null;
    try {
      const settled = await pollUntil({
        timeoutMs: config.settleTimeoutMs,
        monotonicNow,
        delayImpl,
        load: async (remaining) => {
          const timeoutMs = Math.min(config.settleTimeoutMs, remaining);
          const outcomes = await Promise.allSettled([
            readBatch(batchId, timeoutMs),
            readClaims(timeoutMs),
          ]);
          const batchResponse = outcomes[0].status === 'fulfilled' ? outcomes[0].value : null;
          const claimsResponse = outcomes[1].status === 'fulfilled' ? outcomes[1].value : null;
          const projection = batchResponse?.httpStatus === 200
            ? terminalProjection(batchResponse.body)
            : null;
          const claims = claimsResponse?.httpStatus === 200
            ? claimEnvelope(claimsResponse.body)
            : null;
          if (claims?.count === 0 && claimReleaseObservedMs === null) {
            claimReleaseObservedMs = Math.max(0, Math.round(monotonicNow() - stopStartedAt));
          }
          return { projection, claims };
        },
        accept: (value) => terminalPass(value.projection) && value.claims?.count === 0,
      });
      terminalLast = settled.value;
    } catch (error) {
      terminalLast = error?.lastValue || null;
    }
    if (terminalLast?.projection) Object.assign(evidence.terminal, terminalLast.projection);
    if (terminalLast?.claims) {
      evidence.terminal.claimCount = terminalLast.claims.count;
      if (terminalLast.claims.count === 0) {
        evidence.terminal.claimReleaseObservedMs = claimReleaseObservedMs;
      }
    }
    if (!terminalPass(terminalLast?.projection)) {
      addFailure(terminalLast?.projection ? 'TERMINAL_STATE_MISMATCH' : 'TERMINAL_STATE_NOT_OBSERVED');
    }
    if (terminalLast?.claims?.count !== 0) addFailure('CLAIM_RELEASE_NOT_OBSERVED');

    if (preStopMaxOrdinal !== null) {
      try {
        while ((monotonicNow() - stopStartedAt) < config.quiescenceMs) {
          const remaining = config.quiescenceMs - (monotonicNow() - stopStartedAt);
          await delayImpl(Math.max(1, Math.ceil(remaining)));
        }
        const finalState = await readFixtureState();
        const durationMs = Math.max(config.quiescenceMs, Math.floor(monotonicNow() - stopStartedAt));
        const startsAfter = finalState.events.filter((event) => (
          event.ordinal > preStopMaxOrdinal && event.type === 'request-start'
        )).length;
        evidence.quiescence.durationMs = durationMs;
        evidence.quiescence.firstPromptStarts = finalState.counters.prompt1Starts;
        evidence.quiescence.secondPromptStarts = finalState.counters.prompt2Starts;
        evidence.quiescence.promptStartsAfterCancel = startsAfter;
        if (finalState.counters.prompt1Starts !== 1
            || finalState.counters.prompt2Starts !== 0
            || startsAfter !== 0) {
          addFailure('NEXT_PROMPT_STARTED');
        }
      } catch (error) {
        addFailure(error?.code === 'FIXTURE_CONTRACT_MISMATCH'
          ? 'FIXTURE_CONTRACT_MISMATCH'
          : 'QUIESCENCE_NOT_OBSERVED');
      }
    } else {
      addFailure('QUIESCENCE_NOT_OBSERVED');
    }
  }

  await collectIdentities('after', { failClosed: false });
  const before = evidence.identities.before;
  const after = evidence.identities.after;
  const allIdentitiesPresent = before.core && before.benchmark && after.core && after.benchmark;
  evidence.identities.stable = allIdentitiesPresent
    ? JSON.stringify(before) === JSON.stringify(after)
    : null;
  if (allIdentitiesPresent && evidence.identities.stable !== true) addFailure('SERVICE_IDENTITY_DRIFT');

  evidence.generatedAt = canonicalTimestamp(wallNow());
  let receipt = createLiveCancellationReceipt({ ...evidence, failureCodes: [...failureCodes] });
  let validationErrors = validateLiveCancellationReceipt(receipt);
  if (validationErrors.length > 0) {
    const emergency = createEvidence(config);
    emergency.generatedAt = canonicalTimestamp(wallNow());
    receipt = createLiveCancellationReceipt({
      ...emergency,
      failureCodes: ['RECEIPT_VALIDATION_FAILED'],
    });
    validationErrors = validateLiveCancellationReceipt(receipt);
  }
  if (validationErrors.length > 0) {
    throw new Error('could not construct a valid privacy-safe live cancellation receipt');
  }
  if (receipt.status === 'fail') throw new LiveCancellationObservationError(receipt);
  return receipt;
}

async function verifyLiveCancellation(options, dependencies = {}) {
  try {
    return await executeLiveCancellation(options, dependencies);
  } catch (error) {
    if (error instanceof LiveCancellationObservationError) throw error;
    try {
      const emergency = createEvidence(options);
      const now = dependencies.now || (() => new Date());
      emergency.generatedAt = canonicalTimestamp(now());
      const receipt = createLiveCancellationReceipt({
        ...emergency,
        failureCodes: ['UNEXPECTED_DRIVER_FAILURE'],
      });
      if (validateLiveCancellationReceipt(receipt).length === 0) {
        throw new LiveCancellationObservationError(receipt);
      }
    } catch (receiptError) {
      if (receiptError instanceof LiveCancellationObservationError) throw receiptError;
    }
    throw error;
  }
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  try {
    const receipt = await verifyLiveCancellation(options, dependencies);
    writeReceipt(options.outputPath, receipt);
    return receipt;
  } catch (error) {
    if (error?.receipt) writeReceipt(options.outputPath, error.receipt);
    throw error;
  }
}

if (require.main === module) {
  runCli()
    .then((receipt) => {
      process.stdout.write(
        `live cancellation passed: scenario=${receipt.scenarioHash} assertions=${receipt.summary.passed}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULTS,
  FIXTURE_IDENTITY,
  JUDGE_MODEL,
  EXECUTION_MODEL,
  MAX_JSON_BYTES,
  OLLAMA_FIXTURE_ORIGIN,
  POLL_INTERVAL_MS,
  PROMPT_IDS,
  LiveCancellationObservationError,
  RequestDeadlineError,
  boundedJsonRequest,
  fixtureObservation,
  hashProjection,
  parseArgs,
  pollUntil,
  readBoundedJson,
  runCli,
  startPayload,
  validFixtureState,
  verifyLiveCancellation,
  writeReceipt,
};

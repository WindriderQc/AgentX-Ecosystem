'use strict';

/**
 * Sequential three-host Qwen3.5 9B thinking A/B runner.
 *
 * This is intentionally small and resumable: the benchmark service only allows
 * one active batch at a time, and Host Alpha has a pinned production model that
 * must be restored after temporary benchmark use.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.BENCHMARK_API_BASE || 'http://192.0.2.99:3081';
const CORE_BASE = process.env.CORE_API_BASE || 'http://192.0.2.99:3080';
const POLL_MS = Number(process.env.POLL_BATCH_MS || 30000);
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 0);

const PROMPT_IDS = [
  '6a305e8bbdf02fd3c6a90305',
  '6a305e8bbdf02fd3c6a9031d',
  '6a305e8bbdf02fd3c6a90338',
  '6a305e8bbdf02fd3c6a90344',
  '6955f1e99856c085ae977e0e'
];

const JUDGE_CONFIG = {
  host: 'http://192.0.2.99:11434',
  model: 'qwen2.5:14b-instruct-q4_K_M',
  num_ctx: 8192,
  num_predict: 2048,
  think: false
};

const EXECUTION_BASE = {
  force_num_ctx: 32768,
  response_max_tokens: 8192,
  api_mode: 'chat',
  temperature: 0.2,
  seed: 42,
  answer_contract_mode: 'auto',
  include_length_hint: true
};

const CASES = [
  {
    id: 'host-beta_qwen35_9b_think_false',
    hostLabel: 'Host Beta',
    host: 'http://192.0.2.12:11434',
    model: 'ax/qwen3.5:9b',
    think: false
  },
  {
    id: 'host-beta_qwen35_9b_think_true',
    hostLabel: 'Host Beta',
    host: 'http://192.0.2.12:11434',
    model: 'ax/qwen3.5:9b',
    think: true
  },
  {
    id: 'host-gamma_qwen35_9b_think_false',
    hostLabel: 'Host Gamma',
    host: 'http://192.0.2.99:11434',
    model: 'ax/Qwen3.5:9b',
    think: false
  },
  {
    id: 'host-gamma_qwen35_9b_think_true',
    hostLabel: 'Host Gamma',
    host: 'http://192.0.2.99:11434',
    model: 'ax/Qwen3.5:9b',
    think: true
  },
  {
    id: 'host-alpha_qwen35_9b_think_false',
    hostLabel: 'Host Alpha',
    host: 'http://192.0.2.199:11434',
    model: 'ax/Qwen3.5:9b',
    think: false
  },
  {
    id: 'host-alpha_qwen35_9b_think_true',
    hostLabel: 'Host Alpha',
    host: 'http://192.0.2.199:11434',
    model: 'ax/Qwen3.5:9b',
    think: true
  }
];

const repoRoot = path.resolve(__dirname, '..');
const statePath = process.env.STATE_PATH || path.join(repoRoot, 'logs', 'three-host-thinking-ab-2026-07-08-state.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {
      startedAt: now(),
      apiBase: API_BASE,
      promptIds: PROMPT_IDS,
      judgeConfig: JUDGE_CONFIG,
      executionBase: EXECUTION_BASE,
      cases: {}
    };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: now() }, null, 2));
}

function log(message, data = null) {
  const line = data ? `${now()} ${message} ${JSON.stringify(data)}` : `${now()} ${message}`;
  console.log(line);
}

async function request(method, route, body = null, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
  try {
    const res = await fetch(`${API_BASE}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(payload?.error || payload?.message || `HTTP ${res.status}`);
      err.statusCode = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function coreRequest(method, route, body = null, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const res = await fetch(`${CORE_BASE}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(payload?.message || payload?.error || `HTTP ${res.status}`);
      err.statusCode = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function batchBody(testCase) {
  const thinkLabel = testCase.think ? 'think true' : 'think false';
  const runStamp = now().replace(/[:.]/g, '-');
  return {
    host: testCase.host,
    models: [testCase.model],
    levels: [5],
    prompt_ids: PROMPT_IDS,
    run_name: `Qwen3.5 9B thinking A/B | ${testCase.hostLabel} | ${thinkLabel} | ${runStamp}`,
    description: `Three-host Qwen3.5 9B with/without-thinking comparison. Host=${testCase.hostLabel}; think=${testCase.think}.`,
    tags: [
      'thinking-ab',
      'three-host',
      'qwen35-9b',
      testCase.hostLabel.toLowerCase(),
      testCase.think ? 'think-true' : 'think-false'
    ],
    judge_config: JUDGE_CONFIG,
    execution_config: {
      ...EXECUTION_BASE,
      think: testCase.think
    },
    execution_mode: 'latency'
  };
}

async function preflight(testCase) {
  const body = {
    targets: [{ host: testCase.host, model: testCase.model }],
    judge_config: JUDGE_CONFIG,
    levels: [5],
    prompt_ids: PROMPT_IDS,
    execution_config: {
      ...EXECUTION_BASE,
      think: testCase.think
    }
  };
  const payload = await request('POST', '/api/benchmark/preflight', body, { timeoutMs: 120000 });
  const data = payload?.data || {};
  if (!data.ready) {
    const err = new Error(`Preflight failed: ${(data.issues || []).join('; ') || 'not ready'}`);
    err.payload = data;
    throw err;
  }
  if (data.warnings?.length) {
    log('Preflight warnings', { caseId: testCase.id, warnings: data.warnings });
  }
  return data;
}

async function waitForNoActiveBatch() {
  for (;;) {
    const payload = await request('GET', '/api/benchmark/batches/active', null, { timeoutMs: 30000 });
    const active = payload?.data || [];
    if (!active.length) return;
    log('Waiting for active batch', active.map(batch => ({
      id: batch._id,
      runName: batch.run_name,
      status: batch.status,
      completed: batch.completed,
      total: batch.total_tests,
      activity: batch.activity_status
    })));
    await sleep(POLL_MS);
  }
}

async function waitForCoreHostReady(testCase) {
  for (;;) {
    const payload = await coreRequest('GET', '/api/nerve-center/host-preferences', null, { timeoutMs: 30000 });
    const prefs = Array.isArray(payload) ? payload : (payload?.data || []);
    const pref = prefs.find(entry => String(entry.hostUrl || '').replace(/\/+$/, '') === testCase.host.replace(/\/+$/, ''));
    if (!pref) return;

    const activeClaim = pref.benchmarkClaim?.batchId || null;
    const status = String(pref.status || '').toLowerCase();
    const online = pref.live?.online !== false;
    const restoring = status === 'restoring' || status === 'pin_restore' || status === 'loading_default';
    if (!activeClaim && !restoring && online) return;

    log('Waiting for core host readiness', {
      caseId: testCase.id,
      host: testCase.host,
      status: pref.status,
      activeClaim,
      online,
      loadedModels: pref.loadedModels || pref.live?.runningModels?.map(model => model.name) || []
    });
    await sleep(POLL_MS);
  }
}

async function startBatch(testCase, entry) {
  await waitForNoActiveBatch();
  await waitForCoreHostReady(testCase);
  for (;;) {
    try {
      const payload = await request('POST', '/api/benchmark/batch', batchBody(testCase), { timeoutMs: 180000 });
      const batchId = payload?.data?.batch_id || payload?.data?.batchId || payload?.data?._id;
      if (!batchId) throw new Error(`Batch start did not return an id: ${JSON.stringify(payload?.data || {})}`);
      entry.batchId = batchId;
      entry.batchStatus = 'running';
      entry.batchStartedAt = now();
      log('Batch started', { caseId: testCase.id, batchId });
      return batchId;
    } catch (err) {
      if (err.statusCode === 409) {
        log('Batch start blocked', { caseId: testCase.id, error: err.message, payload: err.payload || null });
        await sleep(POLL_MS);
        continue;
      }
      throw err;
    }
  }
}

async function waitBatch(testCase, batchId, entry) {
  const badTerminal = new Set(['failed', 'stopped', 'interrupted']);
  for (;;) {
    const payload = await request('GET', `/api/benchmark/batch/${batchId}`, null, { timeoutMs: 60000 });
    const batch = payload?.data?.batch || payload?.data || {};
    entry.batchStatus = batch.status;
    entry.completed = batch.completed;
    entry.failed = batch.failed;
    entry.totalTests = batch.total_tests;
    entry.judgeStatus = batch.judge_status;
    entry.judgeCompleted = batch.judge_completed;
    entry.judgeTotal = batch.judge_total || batch.judge_total_effective;
    writeState(globalState);

    log('Batch progress', {
      caseId: testCase.id,
      batchId,
      status: batch.status,
      completed: batch.completed,
      total: batch.total_tests,
      judgeStatus: batch.judge_status,
      judgeCompleted: batch.judge_completed,
      judgeTotal: batch.judge_total || batch.judge_total_effective
    });

    if (badTerminal.has(batch.status)) {
      throw new Error(`Batch ended with status ${batch.status}`);
    }

    const judgeTotal = Number(batch.judge_total || batch.judge_total_effective || 0);
    const judgeCompleted = Number(batch.judge_completed || 0);
    const judgeDone = judgeTotal > 0
      && judgeCompleted >= judgeTotal
      && !['pending', 'running', 'none'].includes(String(batch.judge_status || '').toLowerCase());
    if (batch.status === 'completed' && judgeDone) return;

    await sleep(POLL_MS);
  }
}

let globalState = null;

async function runCase(testCase, state) {
  const entry = state.cases[testCase.id] || {
    hostLabel: testCase.hostLabel,
    host: testCase.host,
    model: testCase.model,
    think: testCase.think
  };
  state.cases[testCase.id] = entry;
  if (entry.status === 'completed') {
    log('Skipping completed case', { caseId: testCase.id, batchId: entry.batchId });
    return;
  }
  if (entry.status === 'failed') {
    entry.previousAttempts = entry.previousAttempts || [];
    if (entry.batchId) {
      entry.previousAttempts.push({
        batchId: entry.batchId,
        batchStatus: entry.batchStatus,
        error: entry.error,
        failedAt: entry.failedAt
      });
    }
    delete entry.batchId;
    delete entry.batchStatus;
    delete entry.batchStartedAt;
    delete entry.error;
    delete entry.payload;
    delete entry.failedAt;
    entry.preflightReady = false;
    log('Retrying failed case with fresh batch', { caseId: testCase.id, previousAttempts: entry.previousAttempts });
  }

  entry.status = 'running';
  entry.startedAt = entry.startedAt || now();
  writeState(state);

  try {
    if (!entry.preflightReady) {
      const preflightData = await preflight(testCase);
      entry.preflightReady = true;
      entry.preflightWarnings = preflightData.warnings || [];
      writeState(state);
    }

    const batchId = entry.batchId || await startBatch(testCase, entry);
    writeState(state);
    await waitBatch(testCase, batchId, entry);

    entry.status = 'completed';
    entry.completedAt = now();
    writeState(state);
    log('Case completed', { caseId: testCase.id, batchId });
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
    entry.payload = err.payload || null;
    entry.failedAt = now();
    writeState(state);
    log('Case failed', { caseId: testCase.id, error: err.message, payload: err.payload || null });
    throw err;
  }
}

async function main() {
  if (START_DELAY_MS > 0) await sleep(START_DELAY_MS);
  globalState = readState();
  globalState.apiBase = API_BASE;
  globalState.promptIds = PROMPT_IDS;
  globalState.judgeConfig = JUDGE_CONFIG;
  globalState.executionBase = EXECUTION_BASE;
  writeState(globalState);
  log('Three-host thinking A/B runner started', { apiBase: API_BASE, statePath });

  for (const testCase of CASES) {
    await runCase(testCase, globalState);
  }

  globalState.status = 'completed';
  globalState.completedAt = now();
  writeState(globalState);
  log('Three-host thinking A/B runner completed', { statePath });
}

main().catch(err => {
  log('Runner failed', { error: err.message, payload: err.payload || null });
  process.exitCode = 1;
});

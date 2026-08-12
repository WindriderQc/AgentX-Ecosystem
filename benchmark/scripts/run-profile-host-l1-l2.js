'use strict';

/**
 * Sequential Host Beta profile + L1/L2 benchmark runner.
 *
 * Profiles raw generation models on Host Beta, deploys adapted ax/ artifacts via
 * the standard profiler pipeline, then benchmarks each adapted model on levels
 * 1 and 2. State is persisted so the runner can be restarted without repeating
 * completed models.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.BENCHMARK_API_BASE || 'http://localhost:3081';
const HOST_ID = process.env.AGENTX_PROFILE_HOST_ID || 'primary';
const HOST_URL = process.env.AGENTX_PROFILE_HOST_URL || 'http://192.0.2.12:11434';
const PROFILE_DEPTH = process.env.PROFILE_DEPTH || 'standard';
const JUDGE_HOST = process.env.JUDGE_HOST || HOST_URL;
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'qwen2.5:14b-instruct-q4_K_M';
const POLL_PROFILE_MS = Number(process.env.POLL_PROFILE_MS || 15000);
const POLL_BATCH_MS = Number(process.env.POLL_BATCH_MS || 30000);
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 0);
const LEVELS = [1, 2];

const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(repoRoot, 'logs');
const statePath = process.env.STATE_PATH || path.join(logsDir, 'host-beta-profile-l1-l2-state.json');

const EMBED_RE = /(embed|embedding|nomic|mxbai|bge-|snowflake-arctic|all-minilm)/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function normalizeModelName(name) {
  return String(name || '').trim().replace(/:latest$/i, '');
}

function adaptedName(rawName) {
  return rawName.startsWith('ax/') ? rawName : `ax/${rawName}`;
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function judgeConfigForBatch() {
  const config = { model: JUDGE_MODEL };
  if (normalizeUrl(JUDGE_HOST) && normalizeUrl(JUDGE_HOST) !== normalizeUrl(HOST_URL)) {
    config.host = JUDGE_HOST;
  }
  return config;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { startedAt: now(), hostId: HOST_ID, hostUrl: HOST_URL, models: {} };
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

async function getProfileHostInventory() {
  const payload = await request('GET', '/api/profiler/hosts/test/hosts-status', null, { timeoutMs: 30000 });
  const host = payload?.data?.hosts?.find(h => h.id === HOST_ID || h.url === HOST_URL);
  if (!host?.available) {
    throw new Error(`Host Beta is not available via profiler host status (${HOST_ID}, ${HOST_URL})`);
  }

  const seen = new Set();
  const candidates = [];
  const skipped = [];

  for (const model of host.models || []) {
    const name = normalizeModelName(model);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (name.startsWith('ax/')) continue;
    if (EMBED_RE.test(name)) {
      skipped.push({ model: name, reason: 'embedding model' });
      continue;
    }
    candidates.push(name);
  }

  return { host, candidates, skipped };
}

async function waitForNoProfile() {
  for (;;) {
    const payload = await request('GET', '/api/profiler/pipeline/profile/active', null, { timeoutMs: 30000 });
    const active = payload?.data?.active || [];
    const hostActive = active.find(job => job.hostId === HOST_ID);
    if (!hostActive) return;
    log('Waiting for existing profile job', hostActive);
    await sleep(POLL_PROFILE_MS);
  }
}

async function runProfile(modelName, stateEntry) {
  await waitForNoProfile();
  let profileId = stateEntry.profileId || null;

  if (!profileId || stateEntry.profileStatus !== 'running') {
    for (;;) {
      try {
        const payload = await request('POST', '/api/profiler/pipeline/profile', {
          modelName,
          hostId: HOST_ID,
          depth: PROFILE_DEPTH
        }, { timeoutMs: 30000 });
        profileId = payload?.data?.profileId;
        if (!profileId) throw new Error('Profiler did not return profileId');
        stateEntry.profileId = profileId;
        stateEntry.profileStatus = 'running';
        stateEntry.profileStartedAt = now();
        log('Profile started', { modelName, profileId, depth: PROFILE_DEPTH });
        break;
      } catch (err) {
        if (err.statusCode === 409) {
          log('Profile start blocked by active job; waiting', { modelName, error: err.message });
          await sleep(POLL_PROFILE_MS);
          continue;
        }
        throw err;
      }
    }
  }

  for (;;) {
    const payload = await request('GET', `/api/profiler/pipeline/profile/${profileId}/progress`, null, { timeoutMs: 30000 });
    const data = payload?.data || {};
    stateEntry.profileStatus = data.profileStatus;
    stateEntry.profileStep = data.currentStep;
    stateEntry.profileMessage = data.statusMessage;

    if (data.profileStatus === 'completed') {
      stateEntry.profileCompletedAt = now();
      log('Profile completed', { modelName, profileId });
      return;
    }
    if (data.profileStatus === 'failed') {
      throw new Error(`Profile failed: ${data.error || 'unknown error'}`);
    }

    log('Profile progress', {
      modelName,
      profileId,
      step: data.currentStep,
      completed: data.stepsCompleted,
      total: data.stepsTotal,
      message: data.statusMessage
    });
    await sleep(POLL_PROFILE_MS);
  }
}

async function preflightBenchmark(modelName) {
  const model = adaptedName(modelName);
  const payload = await request('POST', '/api/benchmark/preflight', {
    targets: [{ host: HOST_URL, model }],
    judge_config: judgeConfigForBatch(),
    levels: LEVELS
  }, { timeoutMs: 120000 });
  const data = payload?.data || {};
  if (!data.ready) {
    const err = new Error(`Benchmark preflight failed: ${(data.issues || []).join('; ') || 'not ready'}`);
    err.payload = data;
    throw err;
  }
  if (data.warnings?.length) {
    log('Benchmark preflight warnings', { model, warnings: data.warnings });
  }
}

async function startBenchmark(modelName, stateEntry) {
  const model = adaptedName(modelName);
  const runStamp = now().replace(/[:.]/g, '-');
  const body = {
    host: HOST_URL,
    models: [model],
    levels: LEVELS,
    run_name: `Host Beta L1-L2 | ${model} | ${runStamp}`,
    judge_config: judgeConfigForBatch(),
    execution_mode: 'latency',
    tags: ['host-beta', 'level-1', 'level-2', 'profiled', 'codex-run'],
    description: `Sequential Host Beta profile + adapted benchmark run for ${model}.`
  };

  for (;;) {
    try {
      const payload = await request('POST', '/api/benchmark/batch', body, { timeoutMs: 180000 });
      const batchId = payload?.data?.batch_id || payload?.data?.batchId || payload?.data?._id;
      if (!batchId) throw new Error(`Batch start did not return an id: ${JSON.stringify(payload?.data || {})}`);
      stateEntry.batchId = batchId;
      stateEntry.batchStatus = 'running';
      stateEntry.batchStartedAt = now();
      log('Benchmark started', { model, batchId, levels: LEVELS });
      return batchId;
    } catch (err) {
      if (err.statusCode === 409) {
        log('Benchmark start blocked by active batch; waiting', { model, error: err.message });
        await sleep(POLL_BATCH_MS);
        continue;
      }
      throw err;
    }
  }
}

async function waitBenchmark(modelName, batchId, stateEntry) {
  const badTerminal = new Set(['failed', 'stopped', 'interrupted']);
  for (;;) {
    const payload = await request('GET', `/api/benchmark/batch/${batchId}`, null, { timeoutMs: 60000 });
    const batch = payload?.data?.batch || payload?.data || {};
    stateEntry.batchStatus = batch.status;
    stateEntry.judgeStatus = batch.judge_status;
    stateEntry.completed = batch.completed;
    stateEntry.failed = batch.failed;
    stateEntry.totalTests = batch.total_tests;
    stateEntry.judgeCompleted = batch.judge_completed;
    stateEntry.judgeTotal = batch.judge_total;

    log('Benchmark progress', {
      model: adaptedName(modelName),
      batchId,
      status: batch.status,
      completed: batch.completed,
      total: batch.total_tests,
      judgeStatus: batch.judge_status,
      judgeCompleted: batch.judge_completed,
      judgeTotal: batch.judge_total
    });

    if (badTerminal.has(batch.status)) {
      stateEntry.batchCompletedAt = now();
      throw new Error(`Benchmark ended with status ${batch.status}`);
    }

    const judgeTotal = Number(batch.judge_total || batch.judge_total_effective || 0);
    const judgeCompleted = Number(batch.judge_completed || 0);
    const judgeDone = judgeTotal > 0 && judgeCompleted >= judgeTotal && !['pending', 'running', 'none'].includes(batch.judge_status);
    if (batch.status === 'completed' && judgeDone) {
      stateEntry.batchCompletedAt = now();
      return;
    }

    await sleep(POLL_BATCH_MS);
  }
}

async function runModel(modelName, state) {
  const entry = state.models[modelName] || {};
  state.models[modelName] = entry;

  if (entry.status === 'completed') {
    log('Skipping already completed model', { modelName, batchId: entry.batchId });
    return;
  }

  entry.status = 'running';
  entry.startedAt = entry.startedAt || now();
  entry.adaptedModel = adaptedName(modelName);
  writeState(state);

  try {
    if (entry.profileStatus !== 'completed') {
      await runProfile(modelName, entry);
      writeState(state);
    }

    if (entry.batchId && entry.batchStatus !== 'completed') {
      await waitBenchmark(modelName, entry.batchId, entry);
    } else if (!entry.batchId || entry.batchStatus !== 'completed') {
      await preflightBenchmark(modelName);
      writeState(state);
      const batchId = await startBenchmark(modelName, entry);
      writeState(state);
      await waitBenchmark(modelName, batchId, entry);
    }

    entry.status = 'completed';
    entry.completedAt = now();
    log('Model completed', { modelName, adaptedModel: entry.adaptedModel, batchId: entry.batchId });
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
    entry.failedAt = now();
    log('Model failed', { modelName, error: err.message, payload: err.payload || null });
  } finally {
    writeState(state);
  }
}

async function main() {
  if (START_DELAY_MS > 0) {
    log('Start delay requested', { delayMs: START_DELAY_MS });
    await sleep(START_DELAY_MS);
  }

  const state = readState();
  state.hostId = HOST_ID;
  state.hostUrl = HOST_URL;
  state.profileDepth = PROFILE_DEPTH;
  state.levels = LEVELS;
  state.judge = { host: JUDGE_HOST, model: JUDGE_MODEL, requestConfig: judgeConfigForBatch() };

  const { host, candidates, skipped } = await getProfileHostInventory();
  state.inventory = {
    capturedAt: now(),
    modelCount: host.modelCount,
    candidates,
    skipped
  };
  writeState(state);

  log('Host Beta run initialized', {
    hostId: HOST_ID,
    hostUrl: HOST_URL,
    inventoryModels: host.modelCount,
    candidates: candidates.length,
    skipped
  });

  for (const modelName of candidates) {
    await runModel(modelName, state);
  }

  state.finishedAt = now();
  writeState(state);
  log('Host Beta run finished', {
    completed: Object.values(state.models).filter(m => m.status === 'completed').length,
    failed: Object.values(state.models).filter(m => m.status === 'failed').length,
    statePath
  });
}

main().catch(err => {
  log('Runner crashed', { error: err.stack || err.message });
  process.exitCode = 1;
});

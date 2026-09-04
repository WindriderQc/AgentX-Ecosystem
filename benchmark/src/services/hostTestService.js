/**
 * Host Test Service
 *
 * Lightweight performance probe for models on Ollama hosts.
 * Measures: tokens/sec, prompt eval speed, latency, TTFT, VRAM.
 * Persists results to HostPerformanceSnapshot (benchmark-owned collection).
 *
 * Warm-up protocol ensures model is loaded into VRAM before measuring.
 * All models on a single host are tested sequentially to avoid GPU contention.
 *
 * Config (env vars):
 *   HOST_TEST_TIMEOUT_MS       - Per-model test timeout (default 60000)
 *   HOST_TEST_NUM_PREDICT      - Tokens to generate (default 64)
 *   HOST_TEST_CONTEXT_FILL_PCT - % of num_ctx to fill with prompt (default 25)
 *   HOST_TEST_WARMUP           - Enable warm-up (default true)
 */

const mongoose = require('mongoose');
const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const authorityReconciliation = require('./benchmark/benchmarkAuthorityReconciliation');
const ollamaVramService        = require('./ollamaVramService');
const nodeFetch                = require('node-fetch');
const { withBenchmarkServiceAuth } = require('../helpers/coreServiceAuth');
const { isSameOllamaModel }    = require('../helpers/ollamaModelIdentity');
const { generateFillPrompt }   = require('./contextProbePayload');
const { getConfiguredHosts }   = require('../helpers/ollamaHostConfig');
const {
  admitOllamaTarget,
  admitOllamaTargetResolved
} = require('../helpers/ollamaTargetAdmission');
const { createNodeFetchPeerTransport } = require('../helpers/outboundHttpTransport');
const {
  OUTBOUND_ERROR_CODES,
  createOutboundHttpExecutor,
  readBoundedJson,
  readBoundedText
} = require('../../../shared/outboundHttpExecutor');
const { resolveModelNumCtxDetails, normalizeModelName } = require('./modelContextResolver');

// Host test warm-up routes through core's /api/inference/generate. As of
// task 0168, the scoped Benchmark credential authenticates
// `callerDetail: 'benchmark-host-test-<model>'` for the **direct lane**
// (no probe, no gate, no Mongo, async telemetry) —
// keeping warmup low-overhead while preserving telemetry.
// The probe call itself (further down) stays direct — probing needs
// clean timing measurements unaffected by queueing. /api/ps and /api/tags
// metadata also stay direct — they're not inference.
const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const circuitBreaker           = require('../helpers/circuitBreaker');
const logger                   = require('../../config/logger');

const HOST_TEST_OPERATIONS = Object.freeze({
  TAGS: 'benchmark.host-test.tags',
  LOADED_PS: 'benchmark.host-test.loaded-ps',
  UNLOAD_PS: 'benchmark.host-test.unload-ps',
  UNLOAD_CURRENT: 'benchmark.host-test.unload-current',
  UNLOAD_ONE: 'benchmark.host-test.unload-one',
  WARMUP: 'benchmark.host-test.warmup',
  PROBE: 'benchmark.host-test.probe'
});

function operation(method, pathPattern, {
  deadlineMs,
  maxRequestBytes = 0,
  maxResponseBytes,
  responseMode
}) {
  return Object.freeze({
    allowSearch: false,
    method,
    pathPattern,
    responseMode,
    policy: Object.freeze({
      authoritySource: 'request-admitted',
      deadlineMs,
      maxRequestBytes,
      maxResponseBytes
    })
  });
}

const HOST_TEST_OPERATION_SPECS = Object.freeze({
  [HOST_TEST_OPERATIONS.TAGS]: operation('GET', '^/api/tags$', {
    deadlineMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.LOADED_PS]: operation('GET', '^/api/ps$', {
    deadlineMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.UNLOAD_PS]: operation('GET', '^/api/ps$', {
    deadlineMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.UNLOAD_CURRENT]: operation('POST', '^/api/generate$', {
    deadlineMs: 15_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.UNLOAD_ONE]: operation('POST', '^/api/generate$', {
    deadlineMs: 15_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.WARMUP]: operation('POST', '^/api/(?:inference/)?generate$', {
    deadlineMs: 600_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.PROBE]: operation('POST', '^/api/generate$', {
    deadlineMs: 600_000,
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    responseMode: 'json'
  })
});

function configuredCoreOrigin(coreUrl = CORE_URL) {
  let parsed;
  try {
    parsed = new URL(coreUrl);
  } catch {
    throw new Error('Core service URL is invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new Error('Core service URL is invalid');
  }
  return parsed.origin;
}

function operationMatches(spec, method, target) {
  return spec.method === method
    && new RegExp(spec.pathPattern).test(target.pathname)
    && (spec.allowSearch || !target.search);
}

function assertRegisteredOperation(operationId, method, target) {
  const spec = HOST_TEST_OPERATION_SPECS[operationId];
  if (!spec || !operationMatches(spec, method, target)) {
    throw new Error('Host test outbound operation is not registered');
  }
  return spec;
}

function createHostTestExecutor(options = {}) {
  const admitTarget = options.admitOllamaTargetResolved || admitOllamaTargetResolved;
  const configuredHosts = options.getConfiguredHosts || getConfiguredHosts;
  const coreUrl = options.coreUrl || CORE_URL;

  return createOutboundHttpExecutor({
    operations: Object.fromEntries(Object.entries(HOST_TEST_OPERATION_SPECS)
      .map(([operationId, spec]) => [operationId, spec.policy])),
    authorityAdapter: async ({ sinkId, target }) => {
      const spec = HOST_TEST_OPERATION_SPECS[sinkId];
      const requested = new URL(target);
      if (!spec
        || !new RegExp(spec.pathPattern).test(requested.pathname)
        || (!spec.allowSearch && requested.search)) {
        throw new Error('Host test outbound target is not registered');
      }

      if (sinkId === HOST_TEST_OPERATIONS.WARMUP
        && requested.pathname === '/api/inference/generate') {
        const coreOrigin = configuredCoreOrigin(coreUrl);
        if (requested.origin !== coreOrigin) {
          throw new Error('Host test Core warm-up target is not configured');
        }
        return { expectedOrigin: coreOrigin };
      }

      const expectedOrigin = await admitTarget(requested.origin, {
        configuredHosts: configuredHosts()
      });
      if (requested.origin !== expectedOrigin) {
        throw new Error('Host test Ollama target is not admitted');
      }
      return { expectedOrigin };
    },
    fetchImpl: options.fetchImpl || nodeFetch,
    transportAdapter: options.transportAdapter || createNodeFetchPeerTransport()
  });
}

const hostTestExecutor = createHostTestExecutor();

async function hostTestRequest(operationId, target, options = {}, executor = hostTestExecutor) {
  let requested;
  try {
    requested = new URL(target);
  } catch {
    throw new Error('Host test outbound target is not registered');
  }
  const method = String(options.method || 'GET').toUpperCase();
  assertRegisteredOperation(operationId, method, requested);
  const receipt = await executor.admitTarget(operationId, requested.href, {
    signal: options.signal
  });
  return executor.request(receipt, {
    ...options,
    method
  });
}

function createLocalDeadline(timeoutMs, maximumMs) {
  const parsed = Number(timeoutMs);
  const durationMs = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.round(parsed), maximumMs)
    : maximumMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
    get expired() { return controller.signal.aborted; }
  });
}

// ── Configuration ──────────────────────────────────────────────────────────────

function _asInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getConfig(options = {}) {
  const envConfig = {
    timeoutMs:       _asInt(process.env.HOST_TEST_TIMEOUT_MS, 60000),
    numPredict:      _asInt(process.env.HOST_TEST_NUM_PREDICT, 64),
    contextFillPct:  _asInt(process.env.HOST_TEST_CONTEXT_FILL_PCT, 25),
    maxPromptTokens: _asInt(process.env.HOST_TEST_MAX_PROMPT_TOKENS, 2048),
    warmup:          (process.env.HOST_TEST_WARMUP || 'true').toLowerCase() !== 'false'
  };

  return {
    timeoutMs:       _asInt(options.timeoutMs, envConfig.timeoutMs),
    numPredict:      _asInt(options.numPredict, envConfig.numPredict),
    contextFillPct:  _asInt(options.contextFillPct, envConfig.contextFillPct),
    maxPromptTokens: _asInt(options.maxPromptTokens, envConfig.maxPromptTokens),
    warmup:          typeof options.warmup === 'boolean' ? options.warmup : envConfig.warmup,
    promptWorkloadMode: options.promptWorkloadMode === 'scaled' ? 'scaled' : 'fixed'
  };
}

function buildProbePlan(numCtx, cfg) {
  const safeNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
    ? Number(numCtx)
    : null;

  if (cfg.promptWorkloadMode === 'scaled') {
    const requestedPromptTokens = Math.max(100, Math.floor((safeNumCtx || cfg.maxPromptTokens || 2048) * (cfg.contextFillPct / 100)));
    return {
      promptWorkloadMode: 'scaled',
      requestedPromptTokens,
      targetPromptTokens: requestedPromptTokens
    };
  }

  const requestedPromptTokens = Math.max(100, cfg.maxPromptTokens || 2048);
  const targetPromptTokens = safeNumCtx
    ? Math.min(requestedPromptTokens, safeNumCtx)
    : requestedPromptTokens;

  return {
    promptWorkloadMode: targetPromptTokens < requestedPromptTokens
      ? 'fixed_fallback_to_ctx'
      : 'fixed',
    requestedPromptTokens,
    targetPromptTokens
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function legacyHttpErrorMessage(error) {
  return error?.code === OUTBOUND_ERROR_CODES.REDIRECT_REJECTED
    && Number.isInteger(error.status)
    ? `HTTP ${error.status}`
    : error.message;
}

/**
 * Check host connectivity and return model list.
 * @param {string} hostUrl
 * @returns {Promise<{ available: boolean, models: string[], latency: number, error?: string }>}
 */
async function checkHost(hostUrl, options = {}) {
  const admitTarget = options.admitOllamaTargetResolved || admitOllamaTargetResolved;
  const admitOrigin = options.admitOllamaTarget || admitOllamaTarget;
  const configuredHosts = options.getConfiguredHosts || getConfiguredHosts;
  const executor = options.executor || (
    options.fetchImpl || options.transportAdapter || options.admitOllamaTargetResolved
      ? createHostTestExecutor({
        admitOllamaTargetResolved: admitTarget,
        coreUrl: options.coreUrl,
        fetchImpl: options.fetchImpl,
        getConfiguredHosts: configuredHosts,
        transportAdapter: options.transportAdapter
      })
      : hostTestExecutor
  );
  try {
    hostUrl = admitOrigin(hostUrl, { configuredHosts: configuredHosts() });
  } catch (error) {
    return { available: false, models: [], latency: 0, error: error.message };
  }

  // Circuit breaker gate
  const gate = circuitBreaker.canRequest(hostUrl);
  if (!gate.allowed) {
    return { available: false, models: [], latency: 0, error: gate.reason };
  }

  const start = Date.now();
  try {
    const url = `${hostUrl}/api/tags`;
    const res = await hostTestRequest(HOST_TEST_OPERATIONS.TAGS, url, {
      method: 'GET',
      signal: options.signal
    }, executor);
    if (!res.ok) {
      // Preserve the legacy status-first connectivity result.  Draining an
      // untrusted error body can otherwise turn an immediate HTTP failure into
      // a response-read timeout or byte-limit error.
      await res.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await readBoundedJson(res);
    const models = (data.models || [])
      .filter(m => {
        const name   = m.name.toLowerCase();
        const family = (m.details?.family || '').toLowerCase();
        if (name.includes('embed') || name.includes('nomic') || name.includes('bert')) return false;
        if (family === 'bert' || family === 'nomic-bert') return false;
        if (name.includes('diagnostic')) return false;
        return true;
      })
      .map(m => m.name.replace(/:latest$/, ''));
    circuitBreaker.recordSuccess(hostUrl);
    return { available: true, models, latency: Date.now() - start };
  } catch (err) {
    circuitBreaker.recordFailure(hostUrl);
    return {
      available: false,
      models: [],
      latency: Date.now() - start,
      error: legacyHttpErrorMessage(err)
    };
  }
}

/**
 * Return loaded model metadata from /api/ps when the target is already in VRAM.
 */
async function getLoadedModelInfo(hostUrl, modelName, executor = hostTestExecutor, signal = null) {
  try {
    const url = `${hostUrl}/api/ps`;
    const res = await hostTestRequest(
      HOST_TEST_OPERATIONS.LOADED_PS,
      url,
      { method: 'GET', signal },
      executor
    );
    if (!res.ok) {
      await res.cancel();
      return null;
    }
    const data = await readBoundedJson(res);
    const loaded = data.models || [];
    return loaded.find(m => isSameOllamaModel(m.name || m.model, modelName)) || null;
  } catch (error) {
    throwIfAborted(signal);
    return null;
  }
}

function readLoadedContextLength(modelInfo) {
  const value = modelInfo?.context_length ?? modelInfo?.contextLength ?? modelInfo?.details?.context_length;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

const WARMUP_TIMEOUT_COLD   = 600000; // 10 min — 40GB+ model swap and context allocation
const WARMUP_TIMEOUT_LOADED =  90000; // 1.5 min — model already in VRAM

function buildWarmupRequest(hostUrl, modelName, alreadyLoaded, numCtx) {
  const options = {
    num_predict: 1,
    temperature: 0.1,
    ...(numCtx ? { num_ctx: numCtx } : {})
  };
  if (!alreadyLoaded) {
    return {
      phase: 'cold_preload',
      url: `${hostUrl}/api/generate`,
      timeoutMs: WARMUP_TIMEOUT_COLD,
      body: {
        model: modelName,
        prompt: 'Hello',
        stream: false,
        keep_alive: '10m',
        options
      }
    };
  }
  return {
    phase: 'loaded_prime',
    url: `${CORE_URL}/api/inference/generate`,
    timeoutMs: WARMUP_TIMEOUT_LOADED,
    body: {
      model: modelName,
      host: hostUrl,
      prompt: 'Hello',
      stream: false,
      responseMode: 'normalized',
      think: false,
      callerDetail: 'benchmark-host-test-warmup',
      options
    }
  };
}

async function readExactGenerateTerminal(response, action) {
  if (!response.ok) {
    await response.cancel();
    const error = new Error(`Ollama ${action} returned HTTP ${response.status}`);
    error.code = 'OLLAMA_GENERATE_REJECTED';
    error.status = response.status;
    throw error;
  }
  const terminal = await readBoundedJson(response);
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
    || terminal.done !== true || typeof terminal.error === 'string') {
    const error = new Error(`Ollama ${action} ended without an exact terminal done object`);
    error.code = 'OLLAMA_RESPONSE_INCOMPLETE';
    throw error;
  }
  return terminal;
}

/**
 * Unload whatever model is currently occupying VRAM so the target model
 * can load cleanly without Ollama juggling both simultaneously.
 */
async function unloadCurrentModel(hostUrl, targetModelName, executor = hostTestExecutor, signal = null) {
  try {
    const url = `${hostUrl}/api/ps`;
    const res = await hostTestRequest(
      HOST_TEST_OPERATIONS.UNLOAD_PS,
      url,
      { method: 'GET', signal },
      executor
    );
    if (!res.ok) {
      await res.cancel();
      return;
    }
    const data = await readBoundedJson(res);
    const loaded = data.models || [];

    for (const m of loaded) {
      if (isSameOllamaModel(m.name, targetModelName)) continue; // already our target
      logger.info('Unloading model before warmup', { hostUrl, model: m.name });
      const genUrl = `${hostUrl}/api/generate`;
      const unloadResponse = await hostTestRequest(HOST_TEST_OPERATIONS.UNLOAD_CURRENT, genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0, stream: false }),
        signal
      }, executor);
      await readExactGenerateTerminal(unloadResponse, 'pre-warmup unload');
    }
  } catch (err) {
    throwIfAborted(signal);
    err.retainAdmission = true;
    err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
    throw err;
  }
}

async function unloadOneModel(hostUrl, modelName, executor = hostTestExecutor, signal = null) {
  const genUrl = `${hostUrl}/api/generate`;
  const response = await hostTestRequest(HOST_TEST_OPERATIONS.UNLOAD_ONE, genUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, keep_alive: 0, stream: false }),
    signal
  }, executor);
  await readExactGenerateTerminal(response, 'context-reload unload');
}

/**
 * Warm up a model by sending a trivial 1-token generation.
 * Ensures the model is loaded into VRAM before the timed test.
 * Uses a longer timeout for cold loads (model not yet in VRAM).
 */
async function warmUp(hostUrl, modelName, _timeoutMs, numCtx, executor = hostTestExecutor, benchmarkClaim = null, signal = null) {
  throwIfAborted(signal);
  const loadedInfo = await getLoadedModelInfo(hostUrl, modelName, executor, signal);
  const requestedNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
    ? Math.round(Number(numCtx))
    : null;
  const loadedNumCtx = readLoadedContextLength(loadedInfo);
  const contextMismatch = !!(loadedInfo && requestedNumCtx && loadedNumCtx && loadedNumCtx !== requestedNumCtx);
  let alreadyLoaded = !!loadedInfo && !contextMismatch;

  if (contextMismatch) {
    const loadedName = loadedInfo.name || loadedInfo.model || modelName;
    logger.info('Unloading model before warmup due to context mismatch', {
      hostUrl,
      modelName,
      loadedModel: loadedName,
      loadedNumCtx,
      requestedNumCtx
    });
    try {
      await unloadOneModel(hostUrl, loadedName, executor, signal);
    } catch (err) {
      throwIfAborted(signal);
      err.retainAdmission = true;
      err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
      throw err;
    }
    alreadyLoaded = false;
  }

  if (!alreadyLoaded) {
    await unloadCurrentModel(hostUrl, modelName, executor, signal);
  }

  // Cold loading goes directly to the claimed Ollama host. This prevents a
  // large model's disk load/context allocation from being cut off by a proxy
  // timeout. Once resident, the second warm-up pass goes through Core so the
  // normal direct-lane telemetry remains represented.
  const request = buildWarmupRequest(hostUrl, modelName, alreadyLoaded, numCtx);
  if (request.phase === 'loaded_prime' && benchmarkClaim) {
    Object.assign(request.body, benchmarkClaim);
  }
  logger.info('Host test warm-up', {
    hostUrl,
    modelName,
    alreadyLoaded,
    phase: request.phase,
    timeoutMs: request.timeoutMs
  });

  const deadline = createLocalDeadline(
    request.timeoutMs,
    HOST_TEST_OPERATION_SPECS[HOST_TEST_OPERATIONS.WARMUP].policy.deadlineMs
  );
  try {
    const response = await hostTestRequest(HOST_TEST_OPERATIONS.WARMUP, request.url, {
      method:  'POST',
      headers: request.phase === 'loaded_prime'
        ? withBenchmarkServiceAuth({ 'Content-Type': 'application/json' })
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: combineAbortSignals(deadline.signal, signal)
    }, executor);
    await readExactGenerateTerminal(response, `${request.phase} warm-up`);
  } catch (err) {
    throwIfAborted(signal);
    const errorMessage = deadline.expired
      && err?.code === OUTBOUND_ERROR_CODES.CALLER_ABORTED
      ? `request timeout after ${request.timeoutMs}ms`
      : legacyHttpErrorMessage(err);
    logger.warn('Host test warm-up failed', {
      hostUrl,
      modelName,
      phase: request.phase,
      timeoutMs: request.timeoutMs,
      error: errorMessage
    });
    const failure = new Error(`Warm-up failed during ${request.phase}: ${errorMessage}`);
    failure.code = err?.code || 'HOST_TEST_WARMUP_FAILED';
    if (err?.retainAdmission === true || err?.code === 'OLLAMA_RESPONSE_INCOMPLETE') {
      failure.retainAdmission = true;
    }
    throw failure;
  } finally {
    deadline.dispose();
  }
}

/**
 * Snapshot VRAM usage for a host (best-effort).
 */
async function snapshotVram(hostUrl, signal = null) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl, { signal });
    if (result.ok) {
      return { usedMiB: result.memoryUsedMiBTotal, totalMiB: result.memoryTotalMiBTotal };
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn('Host test VRAM snapshot unavailable', { hostUrl, error: err.message });
  }
  return { usedMiB: null, totalMiB: null };
}

async function persistHostSnapshot(modelName, snapshot, { signal, checkpoint, workloadId } = {}) {
  const snapshotId = new mongoose.Types.ObjectId();
  const authorityWriteId = new mongoose.Types.ObjectId().toString();
  if (!workloadId) {
    const error = new Error('Host snapshot publication requires an exact durable workload identity');
    error.code = 'PROFILER_AUTHORITY_JOURNAL_REQUIRED';
    throw error;
  }
  let journal = null;
  checkpoint?.();
  try {
    const basePayload = { _id: snapshotId, modelName, ...snapshot };
    journal = await authorityReconciliation.prepareProfilerAuthorityWrite({
      kind: 'profiler_snapshot_write',
      resultId: `profiler-snapshot:${workloadId}:${snapshotId}`,
      workloadId,
      phase: 'profiler host performance snapshot publication',
      details: {
        snapshotId: String(snapshotId),
        authorityWriteId,
        payload: basePayload
      }
    });
    checkpoint?.();
    const payload = {
      ...basePayload,
      authorityState: 'pending_reconciliation',
      authorityWriteId,
      authorityReconciliationId: String(journal._id)
    };
    const created = await HostPerformanceSnapshot.create(
      [payload],
      signal ? { signal } : undefined
    );
    const saved = Array.isArray(created) ? created[0] : created;
    checkpoint?.();
    await authorityReconciliation.completeProfilerAuthorityWrite(journal, {
      details: journal.details,
      signal,
      assertAuthorityActive: checkpoint
    });
    return saved;
  } catch (error) {
    if (journal) {
      error.retainAdmission = true;
      error.authorityInvalidationFailed = true;
      error.code = error.code || 'HOST_SNAPSHOT_RECONCILIATION_PENDING';
      error.reconciliationId = String(journal._id);
    }
    throw error;
  }
}

async function persistFailureSnapshot(modelName, snapshot, options = {}) {
  return persistHostSnapshot(modelName, {
    modelName,
    hostId:      null,
    tokensPerSec: 0,
    latencyMs:    0,
    numCtx:       null,
    testedAt:     new Date(),
    status:       'error',
    error:        null,
    ...snapshot
  }, options);
}

async function verifyAppliedContext(hostUrl, modelName, expectedNumCtx, signal = null, executor = hostTestExecutor) {
  const resident = await getLoadedModelInfo(hostUrl, modelName, executor, signal);
  const observedNumCtx = readLoadedContextLength(resident);
  if (!observedNumCtx) {
    const error = new Error(`Ollama /api/ps did not attest context_length=${expectedNumCtx} for ${modelName}`);
    error.code = 'HOST_TEST_CONTEXT_UNVERIFIED';
    throw error;
  }
  if (Number(observedNumCtx) !== Number(expectedNumCtx)) {
    const error = new Error(`Ollama applied context_length=${observedNumCtx}, requested ${expectedNumCtx} for ${modelName}`);
    error.code = 'HOST_TEST_CONTEXT_CLAMPED';
    error.observedNumCtx = observedNumCtx;
    error.requestedNumCtx = Number(expectedNumCtx);
    throw error;
  }
  return observedNumCtx;
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Profiler claim stopped while host request was running');
  error.code = 'BENCHMARK_CLAIM_STOPPED';
  throw error;
}

/** Parse Ollama's NDJSON stream and measure the first emitted output token. */
async function readOllamaGenerateStream(response, startedAt, now = Date.now) {
  let buffer = '';
  let terminal = null;
  let output = '';
  let timeToFirstTokenMs = null;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      const error = new Error('Ollama stream emitted a non-object frame');
      error.code = 'OLLAMA_STREAM_INVALID_FRAME';
      throw error;
    }
    if (terminal) {
      const error = new Error('Ollama stream emitted data after its terminal frame');
      error.code = 'OLLAMA_STREAM_POST_TERMINAL_DATA';
      throw error;
    }
    if (typeof event.error === 'string') {
      const error = new Error('Ollama stream emitted an error frame');
      error.code = 'OLLAMA_STREAM_ERROR';
      throw error;
    }
    if (event.done !== false && event.done !== true) {
      const error = new Error('Ollama stream frame omitted its explicit done state');
      error.code = 'OLLAMA_STREAM_INVALID_FRAME';
      throw error;
    }
    if (typeof event.response === 'string' && event.response.length > 0) {
      if (timeToFirstTokenMs === null) timeToFirstTokenMs = Math.max(0, now() - startedAt);
      output += event.response;
    }
    if (event.done === true) terminal = event;
  };

  for await (const chunk of response.stream()) {
    buffer += Buffer.from(chunk).toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.trim()) consumeLine(buffer);
  if (!terminal) {
    const error = new Error('Ollama stream ended without a terminal metrics event');
    error.code = 'OLLAMA_STREAM_INCOMPLETE';
    throw error;
  }
  return { data: { ...terminal, response: output }, timeToFirstTokenMs };
}

// ── Core Test Functions ────────────────────────────────────────────────────────

/**
 * Test a single model on a specific host.
 *
 * @param {string} modelName
 * @param {string} hostUrl
 * @param {object} [options]
 * @param {string} [options.hostId] - 'primary' | 'secondary' | 'tertiary'
 * @returns {Promise<object>} HostPerformanceSnapshot-compatible snapshot
 */
async function testModelOnHost(modelName, hostUrl, options = {}) {
  const cfg = getConfig(options);
  const { hostId, _skipHostCheck } = options;
  const checkpoint = typeof options.assertClaimActive === 'function' ? options.assertClaimActive : () => {};
  const signal = options.signal || null;
  const workloadId = options.benchmarkClaim?.claimBatchId || null;
  const normalizedModelName = normalizeModelName(modelName);
  checkpoint();
  throwIfAborted(signal);

  // Circuit breaker gate (when host check is skipped, we still enforce the breaker)
  if (_skipHostCheck) {
    const gate = circuitBreaker.canRequest(hostUrl);
    if (!gate.allowed) {
      const snapshot = {
        hostUrl, hostId: hostId || null, tokensPerSec: 0, latencyMs: 0,
        numCtx: null, numCtxSource: null, testedAt: new Date(),
        status: 'error', error: gate.reason, source: 'benchmark_host_test'
      };
      checkpoint();
      throwIfAborted(signal);
      await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
      return snapshot;
    }
  }

  // 1. Validate host (skip if caller already verified, e.g. testAllModelsOnHost)
  if (!_skipHostCheck) {
    const hostCheck = await checkHost(hostUrl, { signal });
    throwIfAborted(signal);
    if (!hostCheck.available) {
      throw new Error(`Host unreachable: ${hostUrl} (${hostCheck.error})`);
    }
    if (!hostCheck.models.includes(normalizedModelName)) {
      throw new Error(`Model "${modelName}" not found on host ${hostUrl}`);
    }
  }

  const numCtxDetails = await resolveModelNumCtxDetails(normalizedModelName, {
    targetHost: hostUrl,
    skipPriorProfileArtifacts: options.skipPriorProfileArtifacts === true
  });
  const explicitNumCtx = Number.isFinite(Number(options.numCtx)) && Number(options.numCtx) > 0
    ? Number(options.numCtx)
    : null;
  const numCtx = explicitNumCtx || numCtxDetails.num_ctx;
  const numCtxSource = explicitNumCtx ? 'runtime_override' : numCtxDetails.source;

  // 2. Warm-up (two passes: load model, then prime KV cache at target context)
  if (cfg.warmup) {
    checkpoint();
    logger.info('Host test: warming up model', { modelName, hostUrl, numCtx });
    const warmUpStartedAt = Date.now();
    try {
      await warmUp(hostUrl, normalizedModelName, cfg.timeoutMs, numCtx, hostTestExecutor, options.benchmarkClaim || null, signal);
      checkpoint();
      // Second pass with a small prompt at target num_ctx to prime KV cache allocation
      checkpoint();
      await warmUp(hostUrl, normalizedModelName, cfg.timeoutMs, numCtx, hostTestExecutor, options.benchmarkClaim || null, signal);
      checkpoint();
    } catch (err) {
      throwIfAborted(signal);
      circuitBreaker.recordFailure(hostUrl);
      const snapshot = {
        hostUrl,
        hostId:      hostId || null,
        tokensPerSec: 0,
        latencyMs:    Date.now() - warmUpStartedAt,
        numCtx,
        numCtxSource: numCtxDetails.source,
        testedAt:     new Date(),
        status:       'error',
        error:        err.message,
        source:       'benchmark_host_test'
      };
      checkpoint();
      throwIfAborted(signal);
      await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
      return snapshot;
    }
  }

  // 3. Probe
  const probePlan = buildProbePlan(numCtx, cfg);
  const { targetPromptTokens, requestedPromptTokens, promptWorkloadMode } = probePlan;
  const { prompt } = generateFillPrompt(targetPromptTokens);

  checkpoint();
  const start = Date.now();
  let probeData;
  const probeDeadline = createLocalDeadline(
    cfg.timeoutMs,
    HOST_TEST_OPERATION_SPECS[HOST_TEST_OPERATIONS.PROBE].policy.deadlineMs
  );
  try {
    const url = `${hostUrl}/api/generate`;
    const res = await hostTestRequest(HOST_TEST_OPERATIONS.PROBE, url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:   normalizedModelName,
        prompt,
        stream:  true,
        options: {
          num_ctx:     numCtx,
          num_predict: cfg.numPredict,
          temperature: 0,
          seed: 7
        }
      }),
      signal: combineAbortSignals(probeDeadline.signal, signal)
    });

    if (!res.ok) {
      throwIfAborted(signal);
      const latencyMs = Date.now() - start;
      circuitBreaker.recordFailure(hostUrl);
      const body = await readBoundedText(res).catch(() => '');
      const snapshot = {
        hostUrl, hostId, tokensPerSec: 0, latencyMs, numCtx,
        numCtxSource,
        testedAt: new Date(), status: 'error',
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        source: 'benchmark_host_test'
      };
      checkpoint();
      throwIfAborted(signal);
      await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
      return snapshot;
    }

    const streamed = await readOllamaGenerateStream(res, start);
    throwIfAborted(signal);
    probeData = streamed.data;
    probeData._latencyMs = Date.now() - start;
    probeData._timeToFirstTokenMs = streamed.timeToFirstTokenMs;
    checkpoint();
    probeData._observedNumCtx = await verifyAppliedContext(hostUrl, normalizedModelName, numCtx, signal);
    checkpoint();
  } catch (err) {
    throwIfAborted(signal);
    if (err.retainAdmission === true || err.code === 'HOST_SNAPSHOT_RECONCILIATION_PENDING') throw err;
    circuitBreaker.recordFailure(hostUrl);
    const latencyMs = Date.now() - start;
    const isTimeout = probeDeadline.expired
      || err.code === OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED
      || err.type === 'request-timeout'
      || err.message.includes('timeout');
    const errorMessage = probeDeadline.expired
      && err?.code === OUTBOUND_ERROR_CODES.CALLER_ABORTED
      ? `request timeout after ${cfg.timeoutMs}ms`
      : legacyHttpErrorMessage(err);
    const snapshot = {
      hostUrl, hostId, tokensPerSec: 0, latencyMs, numCtx,
      numCtxSource,
      testedAt: new Date(), status: isTimeout ? 'timeout' : 'error',
      error: errorMessage,
      source: 'benchmark_host_test'
    };
    checkpoint();
    throwIfAborted(signal);
    await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
    return snapshot;
  } finally {
    probeDeadline.dispose();
  }

  // 4. Parse metrics from Ollama response
  const evalCount           = probeData.eval_count           || 0;
  const evalDuration        = probeData.eval_duration        || 0;  // nanoseconds
  const promptEvalCount     = probeData.prompt_eval_count    || 0;
  const promptEvalDuration  = probeData.prompt_eval_duration || 0;

  const evalDurationSec       = evalDuration / 1e9;
  const promptEvalDurationSec = promptEvalDuration / 1e9;

  const tokensPerSec = evalDurationSec > 0
    ? Number((evalCount / evalDurationSec).toFixed(2))
    : 0;
  const promptEvalTps = promptEvalDurationSec > 0
    ? Number((promptEvalCount / promptEvalDurationSec).toFixed(2))
    : null;
  const promptEvalDurationMs = promptEvalDuration > 0
    ? Number((promptEvalDuration / 1e6).toFixed(1))
    : null;
  const timeToFirstTokenMs = Number.isFinite(probeData._timeToFirstTokenMs)
    ? probeData._timeToFirstTokenMs
    : null;

  // 5. VRAM snapshot
  const vram = await snapshotVram(hostUrl, signal);
  checkpoint();
  throwIfAborted(signal);

  // 6. Build and persist snapshot
  const snapshot = {
    hostUrl,
    hostId:                 hostId || null,
    tokensPerSec,
    promptEvalTokensPerSec: promptEvalTps,
    promptEvalDurationMs,
    latencyMs:              probeData._latencyMs,
    timeToFirstTokenMs,
    ttftMeasurement: timeToFirstTokenMs !== null ? 'streamed_wall_clock' : undefined,
    promptTokens:           promptEvalCount,
    completionTokens:       evalCount,
    requestedPromptTokens,
    promptWorkloadMode,
    vramUsedMiB:            vram.usedMiB,
    vramTotalMiB:           vram.totalMiB,
    numCtx,
    observedNumCtx:          probeData._observedNumCtx,
    numCtxSource,
    testedAt:               new Date(),
    status:                 'pass',
    error:                  null,
    source:                 'benchmark_host_test'
  };

  checkpoint();
  throwIfAborted(signal);
  await persistHostSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
  circuitBreaker.recordSuccess(hostUrl);

  logger.info('Host test completed', {
    modelName: normalizedModelName,
    hostUrl,
    tokensPerSec,
    latencyMs: snapshot.latencyMs,
    numCtx,
    numCtxSource,
    promptTokens: promptEvalCount,
    requestedPromptTokens,
    promptWorkloadMode
  });

  return snapshot;
}

/**
 * Test all models on a specific host (sequential).
 *
 * @param {string} hostUrl
 * @param {object} [options]
 * @param {string} [options.hostId]
 * @param {function} [options.onProgress] - (modelName, result, index, total) => void
 * @returns {Promise<{ host: string, results: object[], summary: object }>}
 */
async function testAllModelsOnHost(hostUrl, options = {}) {
  const { hostId, onProgress, shouldAbort } = options;

  const hostCheck = await checkHost(hostUrl, { signal: options.signal });
  throwIfAborted(options.signal);
  if (!hostCheck.available) {
    throw new Error(`Host unreachable: ${hostUrl} (${hostCheck.error})`);
  }

  const models = hostCheck.models;
  const results = [];

  for (let i = 0; i < models.length; i++) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      logger.info('Host test aborted by caller', { hostUrl, completedModels: i, totalModels: models.length });
      break;
    }
    const modelName = models[i];
    let result;
    try {
      result = await testModelOnHost(modelName, hostUrl, {
        hostId,
        _skipHostCheck: true,
        benchmarkClaim: options.benchmarkClaim || null,
        assertClaimActive: options.assertClaimActive,
        signal: options.signal
      });
    } catch (err) {
      throwIfAborted(options.signal);
      if (err.retainAdmission === true || err.code === 'HOST_SNAPSHOT_RECONCILIATION_PENDING') throw err;
      if (err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      result = {
        hostUrl, hostId, tokensPerSec: 0, latencyMs: 0,
        numCtx: null, testedAt: new Date(),
        status: 'error', error: err.message
      };
      logger.error('Host test failed for model', { modelName, hostUrl, error: err.message });
    }
    results.push({ modelName, ...result });
    if (onProgress) {
      try {
        onProgress(modelName, result, i, models.length);
      } catch (_err) {
        // Ignore progress callback failures; they should not abort host testing.
      }
    }
  }

  const passing = results.filter(r => r.status === 'pass');
  const summary = {
    total:   results.length,
    passed:  passing.length,
    failed:  results.length - passing.length,
    avgTps:  passing.length > 0
      ? Number((passing.reduce((s, r) => s + r.tokensPerSec, 0) / passing.length).toFixed(2))
      : 0
  };

  return { host: hostUrl, results, summary };
}

/**
 * Test a model across all configured hosts.
 *
 * @param {string} modelName
 * @param {object} [options]
 * @returns {Promise<{ modelName: string, hostResults: object[] }>}
 */
async function testModelAcrossHosts(modelName, options = {}) {
  const configuredHosts = getConfiguredHosts();
  const hostResults = [];
  const normalizedModelName = normalizeModelName(modelName);

  for (const host of configuredHosts) {
    options.assertClaimActive?.();
    const check = await checkHost(host.url, { signal: options.signal });
    throwIfAborted(options.signal);
    if (!check.available || !check.models.includes(normalizedModelName)) {
      continue;
    }

    options.assertClaimActive?.();
    const snapshot = await testModelOnHost(normalizedModelName, host.url, {
      hostId:         options.hostIdMap?.[host.url] || host.id || null,
      _skipHostCheck: true,
      benchmarkClaim: options.claimIdentityFor?.(host.url) || null,
      assertClaimActive: options.assertClaimActive,
      signal: options.signal
    });

    hostResults.push({ hostId: host.id, hostUrl: host.url, ...snapshot });
  }

  return { modelName: normalizedModelName, hostResults };
}

module.exports = {
  testModelOnHost,
  testAllModelsOnHost,
  testModelAcrossHosts,
  checkHost,
  getConfig,
  buildProbePlan,
  buildWarmupRequest,
  HOST_TEST_OPERATIONS,
  _internal: {
    HOST_TEST_OPERATION_SPECS,
    configuredCoreOrigin,
    createHostTestExecutor,
    createLocalDeadline,
    combineAbortSignals,
    throwIfAborted,
    getLoadedModelInfo,
    persistHostSnapshot,
    verifyAppliedContext,
    hostTestRequest,
    operationMatches,
    readExactGenerateTerminal,
    unloadCurrentModel,
    unloadOneModel,
    warmUp,
    readOllamaGenerateStream
  }
};

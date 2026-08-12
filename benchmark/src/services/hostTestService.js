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

const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const ollamaVramService        = require('./ollamaVramService');
const { getFetchOptions }      = require('../helpers/httpAgent');
const { isSameOllamaModel }    = require('../helpers/ollamaModelIdentity');
const { generateFillPrompt }   = require('./contextProbePayload');
const { getConfiguredHosts }   = require('../helpers/ollamaHostConfig');
const { resolveModelNumCtxDetails, normalizeModelName } = require('./modelContextResolver');

// Host test warm-up routes through core's /api/inference/generate. As of
// task 0168, `callerDetail: 'benchmark-host-test-<model>'` selects the
// **direct lane** (no probe, no gate, no Mongo, async telemetry) —
// keeping warmup low-overhead while preserving telemetry.
// The probe call itself (further down) stays direct — probing needs
// clean timing measurements unaffected by queueing. /api/ps and /api/tags
// metadata also stay direct — they're not inference.
const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const circuitBreaker           = require('../helpers/circuitBreaker');
const logger                   = require('../../config/logger');

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

const _fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

/**
 * Check host connectivity and return model list.
 * @param {string} hostUrl
 * @returns {Promise<{ available: boolean, models: string[], latency: number, error?: string }>}
 */
async function checkHost(hostUrl) {
  // Circuit breaker gate
  const gate = circuitBreaker.canRequest(hostUrl);
  if (!gate.allowed) {
    return { available: false, models: [], latency: 0, error: gate.reason };
  }

  const start = Date.now();
  try {
    const url = `${hostUrl}/api/tags`;
    const res = await _fetch(url, { method: 'GET', timeout: 5000, ...getFetchOptions(url) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
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
    return { available: false, models: [], latency: Date.now() - start, error: err.message };
  }
}

/**
 * Return loaded model metadata from /api/ps when the target is already in VRAM.
 */
async function getLoadedModelInfo(hostUrl, modelName) {
  try {
    const url = `${hostUrl}/api/ps`;
    const res = await _fetch(url, { method: 'GET', timeout: 5000, ...getFetchOptions(url) });
    if (!res.ok) return null;
    const data = await res.json();
    const loaded = data.models || [];
    return loaded.find(m => isSameOllamaModel(m.name || m.model, modelName)) || null;
  } catch {
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

/**
 * Unload whatever model is currently occupying VRAM so the target model
 * can load cleanly without Ollama juggling both simultaneously.
 */
async function unloadCurrentModel(hostUrl, targetModelName) {
  try {
    const url = `${hostUrl}/api/ps`;
    const res = await _fetch(url, { method: 'GET', timeout: 5000, ...getFetchOptions(url) });
    if (!res.ok) return;
    const data = await res.json();
    const loaded = data.models || [];

    for (const m of loaded) {
      if (isSameOllamaModel(m.name, targetModelName)) continue; // already our target
      logger.info('Unloading model before warmup', { hostUrl, model: m.name });
      const genUrl = `${hostUrl}/api/generate`;
      await _fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0, stream: false }),
        timeout: 15000,
        ...getFetchOptions(genUrl)
      });
    }
  } catch (err) {
    logger.debug('Pre-warmup unload best-effort failed', { hostUrl, error: err.message });
  }
}

async function unloadOneModel(hostUrl, modelName) {
  const genUrl = `${hostUrl}/api/generate`;
  await _fetch(genUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, keep_alive: 0, stream: false }),
    timeout: 15000,
    ...getFetchOptions(genUrl)
  });
}

/**
 * Warm up a model by sending a trivial 1-token generation.
 * Ensures the model is loaded into VRAM before the timed test.
 * Uses a longer timeout for cold loads (model not yet in VRAM).
 */
async function warmUp(hostUrl, modelName, _timeoutMs, numCtx) {
  const loadedInfo = await getLoadedModelInfo(hostUrl, modelName);
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
      await unloadOneModel(hostUrl, loadedName);
    } catch (err) {
      logger.debug('Context-mismatch unload best-effort failed', { hostUrl, modelName, error: err.message });
    }
    alreadyLoaded = false;
  }

  if (!alreadyLoaded) {
    await unloadCurrentModel(hostUrl, modelName);
  }

  // Cold loading goes directly to the claimed Ollama host. This prevents a
  // large model's disk load/context allocation from being cut off by a proxy
  // timeout. Once resident, the second warm-up pass goes through Core so the
  // normal direct-lane telemetry remains represented.
  const request = buildWarmupRequest(hostUrl, modelName, alreadyLoaded, numCtx);
  logger.info('Host test warm-up', {
    hostUrl,
    modelName,
    alreadyLoaded,
    phase: request.phase,
    timeoutMs: request.timeoutMs
  });

  try {
    const response = await _fetch(request.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      timeout: request.timeoutMs,
      ...getFetchOptions(request.url)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  } catch (err) {
    logger.warn('Host test warm-up failed', {
      hostUrl,
      modelName,
      phase: request.phase,
      timeoutMs: request.timeoutMs,
      error: err.message
    });
    throw new Error(`Warm-up failed during ${request.phase}: ${err.message}`);
  }
}

/**
 * Snapshot VRAM usage for a host (best-effort).
 */
async function snapshotVram(hostUrl) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl);
    if (result.ok) {
      return { usedMiB: result.memoryUsedMiBTotal, totalMiB: result.memoryTotalMiBTotal };
    }
  } catch (err) {
    logger.warn('Host test VRAM snapshot unavailable', { hostUrl, error: err.message });
  }
  return { usedMiB: null, totalMiB: null };
}

async function persistFailureSnapshot(modelName, snapshot) {
  await HostPerformanceSnapshot.create({
    modelName,
    hostId:      null,
    tokensPerSec: 0,
    latencyMs:    0,
    numCtx:       null,
    testedAt:     new Date(),
    status:       'error',
    error:        null,
    ...snapshot
  });
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
  const normalizedModelName = normalizeModelName(modelName);

  // Circuit breaker gate (when host check is skipped, we still enforce the breaker)
  if (_skipHostCheck) {
    const gate = circuitBreaker.canRequest(hostUrl);
    if (!gate.allowed) {
      const snapshot = {
        hostUrl, hostId: hostId || null, tokensPerSec: 0, latencyMs: 0,
        numCtx: null, numCtxSource: null, testedAt: new Date(),
        status: 'error', error: gate.reason, source: 'benchmark_host_test'
      };
      await persistFailureSnapshot(normalizedModelName, snapshot);
      return snapshot;
    }
  }

  // 1. Validate host (skip if caller already verified, e.g. testAllModelsOnHost)
  if (!_skipHostCheck) {
    const hostCheck = await checkHost(hostUrl);
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
    logger.info('Host test: warming up model', { modelName, hostUrl, numCtx });
    const warmUpStartedAt = Date.now();
    try {
      await warmUp(hostUrl, normalizedModelName, cfg.timeoutMs, numCtx);
      // Second pass with a small prompt at target num_ctx to prime KV cache allocation
      await warmUp(hostUrl, normalizedModelName, cfg.timeoutMs, numCtx);
    } catch (err) {
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
      await persistFailureSnapshot(normalizedModelName, snapshot);
      return snapshot;
    }
  }

  // 3. Probe
  const probePlan = buildProbePlan(numCtx, cfg);
  const { targetPromptTokens, requestedPromptTokens, promptWorkloadMode } = probePlan;
  const { prompt } = generateFillPrompt(targetPromptTokens);

  const start = Date.now();
  let probeData;
  try {
    const url = `${hostUrl}/api/generate`;
    const res = await _fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:   normalizedModelName,
        prompt,
        stream:  false,
        options: {
          num_ctx:     numCtx,
          num_predict: cfg.numPredict,
          temperature: 0.1
        }
      }),
      timeout: cfg.timeoutMs,
      ...getFetchOptions(url)
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      circuitBreaker.recordFailure(hostUrl);
      const body = await res.text().catch(() => '');
      const snapshot = {
        hostUrl, hostId, tokensPerSec: 0, latencyMs, numCtx,
        numCtxSource,
        testedAt: new Date(), status: 'error',
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        source: 'benchmark_host_test'
      };
      await persistFailureSnapshot(normalizedModelName, snapshot);
      return snapshot;
    }

    probeData = await res.json();
    probeData._latencyMs = latencyMs;
  } catch (err) {
    circuitBreaker.recordFailure(hostUrl);
    const latencyMs = Date.now() - start;
    const isTimeout = err.type === 'request-timeout' || err.message.includes('timeout');
    const snapshot = {
      hostUrl, hostId, tokensPerSec: 0, latencyMs, numCtx,
      numCtxSource,
      testedAt: new Date(), status: isTimeout ? 'timeout' : 'error',
      error: err.message,
      source: 'benchmark_host_test'
    };
    await persistFailureSnapshot(normalizedModelName, snapshot);
    return snapshot;
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
  const timeToFirstTokenMs = promptEvalDuration > 0
    ? Number((promptEvalDuration / 1e6).toFixed(1))
    : null;

  // 5. VRAM snapshot
  const vram = await snapshotVram(hostUrl);

  // 6. Build and persist snapshot
  const snapshot = {
    hostUrl,
    hostId:                 hostId || null,
    tokensPerSec,
    promptEvalTokensPerSec: promptEvalTps,
    latencyMs:              probeData._latencyMs,
    timeToFirstTokenMs,
    promptTokens:           promptEvalCount,
    completionTokens:       evalCount,
    requestedPromptTokens,
    promptWorkloadMode,
    vramUsedMiB:            vram.usedMiB,
    vramTotalMiB:           vram.totalMiB,
    numCtx,
    numCtxSource,
    testedAt:               new Date(),
    status:                 'pass',
    error:                  null,
    source:                 'benchmark_host_test'
  };

  await HostPerformanceSnapshot.create({ modelName: normalizedModelName, ...snapshot });
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

  const hostCheck = await checkHost(hostUrl);
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
      result = await testModelOnHost(modelName, hostUrl, { hostId, _skipHostCheck: true });
    } catch (err) {
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
    const check = await checkHost(host.url);
    if (!check.available || !check.models.includes(normalizedModelName)) {
      continue;
    }

    const snapshot = await testModelOnHost(normalizedModelName, host.url, {
      hostId:         options.hostIdMap?.[host.url] || host.id || null,
      _skipHostCheck: true
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
  buildWarmupRequest
};

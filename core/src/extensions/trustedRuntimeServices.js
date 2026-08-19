'use strict';

const fetch = require('node-fetch');

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;
const CONTRACT_VERSION = 1;
const MODES = new Set(['chat', 'generate', 'embed']);
const LOCAL_OPTION_KEYS = new Set([
  'num_ctx', 'num_predict', 'temperature', 'top_p', 'top_k', 'min_p', 'typical_p',
  'seed', 'stop', 'repeat_last_n', 'repeat_penalty', 'presence_penalty',
  'frequency_penalty', 'mirostat', 'mirostat_tau', 'mirostat_eta', 'penalize_newline'
]);

class TrustedRuntimeServiceError extends Error {
  constructor(message, { code = 'RUNTIME_INFERENCE_ERROR', statusCode = 500, cause = null } = {}) {
    super(message);
    this.name = 'TrustedRuntimeServiceError';
    this.code = code;
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function boundedTimeout(value) {
  const configured = positiveInteger(value)
    || positiveInteger(process.env.INFERENCE_FETCH_TIMEOUT_MS)
    || DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, configured));
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function frozenCopy(value) {
  return deepFreeze(clone(value));
}

function sanitizeHostPreference(pref, getPinnedEntries) {
  return {
    hostUrl: pref?.hostUrl || null,
    displayName: pref?.displayName || null,
    status: pref?.status || null,
    loadedModel: pref?.loadedModel || null,
    loadedModels: Array.isArray(pref?.loadedModels) ? [...pref.loadedModels] : [],
    maxConcurrentModels: positiveInteger(pref?.maxConcurrentModels),
    vramTotalMiB: positiveInteger(pref?.vramTotalMiB),
    benchmarkClaimed: Boolean(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId),
    pinnedModels: getPinnedEntries(pref).map((entry) => ({
      model: entry.model,
      contextSize: positiveInteger(entry.contextSize),
      keepAlive: entry.keepAlive ?? null,
      autoRestore: entry.autoRestore ?? null
    }))
  };
}

function buildTaskSnapshot(taskType, task, routerConfig, preferencesByHost, modelsMatch) {
  const hostKey = task?.host || null;
  const hostUrl = hostKey ? routerConfig.hosts?.[hostKey] || null : null;
  const preference = hostUrl ? preferencesByHost.get(hostUrl) || null : null;
  const pin = preference?.pinnedModels?.find((entry) => modelsMatch(entry.model, task?.model)) || null;
  return {
    taskType,
    model: pin?.model || task?.model || null,
    configuredModel: task?.model || null,
    hostKey,
    hostUrl,
    contextSize: positiveInteger(pin?.contextSize),
    contextSource: pin?.contextSize ? 'host_preference_pin' : 'unresolved',
    keepAlive: pin?.keepAlive ?? null,
    pinAligned: Boolean(pin),
    hostPreference: preference
  };
}

async function buildEffectiveRoutingSnapshot(deps, options = {}) {
  const [routerConfig, rawPreferences] = await Promise.all([
    deps.buildRouterConfigPayload(options.routerOptions || {}),
    deps.hostPreferenceService.getAll()
  ]);
  const hostPreferences = (rawPreferences || []).map((pref) =>
    sanitizeHostPreference(pref, deps.hostPreferenceService.getPinnedEntries)
  );
  const preferencesByHost = new Map(hostPreferences.map((pref) => [pref.hostUrl, pref]));
  const tasks = {};
  const warnings = [];

  for (const [taskType, task] of Object.entries(routerConfig.taskModels || {})) {
    const resolved = buildTaskSnapshot(taskType, task, routerConfig, preferencesByHost, deps.modelsMatch);
    if (resolved.model) {
      try {
        const [contextInfo, inferenceContract] = await Promise.all([
          deps.getContextInfo(resolved.model, resolved.hostUrl),
          deps.resolveInferenceContract({ model: resolved.model, host: resolved.hostUrl })
        ]);
        if (!resolved.contextSize && positiveInteger(contextInfo?.num_ctx)) {
          resolved.contextSize = positiveInteger(contextInfo.num_ctx);
          resolved.contextSource = contextInfo.source || 'context_info';
        }
        resolved.contextInfo = contextInfo;
        resolved.inferenceContract = inferenceContract;
      } catch (error) {
        resolved.resolutionError = String(error?.message || 'routing capability resolution failed');
      }
    }
    tasks[taskType] = resolved;
  }

  let catalog = [];
  if (options.includeCatalog !== false) {
    try {
      const docs = await deps.ModelRegistry.find({
        isActive: { $ne: false },
        status: { $ne: 'retired' }
      })
        .select('modelName sourceHost parameterSize quantization family capabilities categories')
        .sort({ modelName: 1 })
        .lean();
      catalog = (docs || []).map((doc) => ({
        model: doc.modelName || null,
        hostUrl: doc.sourceHost || null,
        parameterSize: doc.parameterSize || null,
        quantization: doc.quantization || null,
        family: doc.family || null,
        capabilities: Array.isArray(doc.capabilities) ? doc.capabilities : [],
        categories: Array.isArray(doc.categories) ? doc.categories : []
      }));
    } catch (error) {
      warnings.push(`Active model catalog is unavailable: ${error.message}`);
    }
  }

  return frozenCopy({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    authority: routerConfig.authority || null,
    hosts: routerConfig.hosts || {},
    tasks,
    hostPreferences,
    catalog,
    warnings
  });
}

function resolvePinnedRuntimeOptions(pref, model, modelsMatch) {
  const pin = pref
    ? pref.pinnedModels?.find((entry) => modelsMatch(entry?.model, model))
    : null;
  return pin ? {
    keepAlive: pin.keepAlive ?? -1,
    contextSize: positiveInteger(pin.contextSize)
  } : null;
}

function createAbortBridge(signal, timeoutMs) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason || new Error('Inference request cancelled'));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`Inference request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortFromCaller);
    }
  };
}

function safeJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { error: raw }; }
}

function releaseOnce(release) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release?.();
  };
}

function attachStreamLifecycle(stream, { abortBridge, release, onComplete }) {
  const finish = releaseOnce(() => {
    abortBridge.cleanup();
    release();
    onComplete();
  });
  stream.once('end', finish);
  stream.once('close', finish);
  stream.once('error', finish);
  abortBridge.signal.addEventListener('abort', () => {
    if (!stream.destroyed) stream.destroy(abortBridge.signal.reason || new Error('Inference request cancelled'));
    finish();
  }, { once: true });
  return stream;
}

function buildLocalPayload(request, model, options, keepAlive) {
  const common = {
    model,
    stream: request.stream === true,
    ...(Object.keys(options).length > 0 && { options }),
    ...(keepAlive !== undefined && { keep_alive: keepAlive })
  };
  if (request.mode === 'embed') {
    return {
      model,
      input: request.input,
      ...(request.truncate !== undefined && { truncate: request.truncate }),
      ...(Object.keys(options).length > 0 && { options }),
      ...(keepAlive !== undefined && { keep_alive: keepAlive })
    };
  }
  if (request.mode === 'chat') {
    return {
      ...common,
      messages: request.messages,
      ...(Array.isArray(request.tools) && { tools: request.tools }),
      ...(request.format !== undefined && { format: request.format }),
      ...(request.think !== undefined && { think: request.think })
    };
  }
  return {
    ...common,
    prompt: request.prompt,
    ...(request.system !== undefined && { system: request.system }),
    ...(request.format !== undefined && { format: request.format }),
    ...(request.think !== undefined && { think: request.think })
  };
}

function validatedLocalOptions(options = {}) {
  const result = {};
  for (const [key, value] of Object.entries(options)) {
    if (!LOCAL_OPTION_KEYS.has(key)) {
      throw new TrustedRuntimeServiceError(`Unsupported local inference option: ${key}.`, {
        code: 'INFERENCE_OPTION_UNSUPPORTED', statusCode: 400
      });
    }
    result[key] = value;
  }
  const stop = result.stop;
  if (stop !== undefined
    && typeof stop !== 'string'
    && (!Array.isArray(stop) || stop.length > 16 || stop.some((item) => typeof item !== 'string'))) {
    throw new TrustedRuntimeServiceError('options.stop must be a string or at most 16 strings.', {
      code: 'INFERENCE_POLICY_INVALID', statusCode: 400
    });
  }
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'stop' && key !== 'penalize_newline' && !Number.isFinite(Number(value))) {
      throw new TrustedRuntimeServiceError(`options.${key} must be numeric.`, {
        code: 'INFERENCE_POLICY_INVALID', statusCode: 400
      });
    }
  }
  if (result.penalize_newline !== undefined && typeof result.penalize_newline !== 'boolean') {
    throw new TrustedRuntimeServiceError('options.penalize_newline must be boolean.', {
      code: 'INFERENCE_POLICY_INVALID', statusCode: 400
    });
  }
  return result;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TrustedRuntimeServiceError('Inference request must be an object.', {
      code: 'INVALID_INFERENCE_REQUEST', statusCode: 400
    });
  }
  if (!MODES.has(request.mode)) {
    throw new TrustedRuntimeServiceError('Inference mode must be chat, generate, or embed.', {
      code: 'INVALID_INFERENCE_MODE', statusCode: 400
    });
  }
  if (!String(request.model || '').trim() && !String(request.taskType || '').trim()) {
    throw new TrustedRuntimeServiceError('model or taskType is required.', {
      code: 'INFERENCE_MODEL_REQUIRED', statusCode: 400
    });
  }
  if (request.mode === 'chat' && !Array.isArray(request.messages)) {
    throw new TrustedRuntimeServiceError('messages must be an array for chat inference.', {
      code: 'INFERENCE_MESSAGES_REQUIRED', statusCode: 400
    });
  }
  if (Array.isArray(request.messages) && request.messages.length > 512) {
    throw new TrustedRuntimeServiceError('messages may contain at most 512 entries.', {
      code: 'INFERENCE_MESSAGES_TOO_LARGE', statusCode: 400
    });
  }
  if (Array.isArray(request.tools) && request.tools.length > 128) {
    throw new TrustedRuntimeServiceError('tools may contain at most 128 entries.', {
      code: 'INFERENCE_TOOLS_TOO_LARGE', statusCode: 400
    });
  }
  if (request.mode === 'generate' && typeof request.prompt !== 'string') {
    throw new TrustedRuntimeServiceError('prompt must be a string for generate inference.', {
      code: 'INFERENCE_PROMPT_REQUIRED', statusCode: 400
    });
  }
  if (request.mode === 'embed' && request.input === undefined) {
    throw new TrustedRuntimeServiceError('input is required for embedding inference.', {
      code: 'INFERENCE_INPUT_REQUIRED', statusCode: 400
    });
  }
  if (Array.isArray(request.input) && request.input.length > 2048) {
    throw new TrustedRuntimeServiceError('embedding input may contain at most 2048 entries.', {
      code: 'INFERENCE_INPUT_TOO_LARGE', statusCode: 400
    });
  }
  if (request.options !== undefined
    && (!request.options || typeof request.options !== 'object' || Array.isArray(request.options))) {
    throw new TrustedRuntimeServiceError('options must be an object when supplied.', {
      code: 'INFERENCE_OPTIONS_INVALID', statusCode: 400
    });
  }
  if (request.keepAlive !== undefined
    && !((typeof request.keepAlive === 'number' && Number.isFinite(request.keepAlive))
      || (typeof request.keepAlive === 'string'
        && request.keepAlive.length <= 32
        && /^-?\d+(?:\.\d+)?(?:ms|s|m|h)?$/i.test(request.keepAlive)))) {
    throw new TrustedRuntimeServiceError('keepAlive must be a bounded duration or numeric value.', {
      code: 'INFERENCE_POLICY_INVALID', statusCode: 400
    });
  }
  for (const [name, value] of [
    ['options.num_ctx', request.options?.num_ctx],
    ['options.num_predict', request.options?.num_predict],
    ['max_tokens', request.max_tokens],
    ['max_completion_tokens', request.max_completion_tokens]
  ]) {
    if (value !== undefined && !positiveInteger(value)) {
      throw new TrustedRuntimeServiceError(`${name} must be a positive integer when supplied.`, {
        code: 'INFERENCE_POLICY_INVALID', statusCode: 400
      });
    }
  }
  if (request.n !== undefined
    && (!Number.isInteger(Number(request.n)) || Number(request.n) < 1 || Number(request.n) > 8)) {
    throw new TrustedRuntimeServiceError('n must be an integer from 1 through 8 when supplied.', {
      code: 'INFERENCE_POLICY_INVALID', statusCode: 400
    });
  }
}

function telemetryEntry(request, metadata, startedAt, status, data = null, error = null) {
  return {
    host: metadata.hostUrl,
    model: metadata.model,
    caller: request.mode === 'embed' ? 'embedding' : 'proxy',
    callerDetail: request.callerDetail || 'trusted-extension',
    taskType: request.taskType || null,
    routed: true,
    routedModel: metadata.model,
    routedHost: metadata.hostKey,
    routedHostUrl: metadata.hostUrl,
    num_ctx: metadata.options?.num_ctx ?? null,
    num_ctx_source: metadata.numCtxSource || null,
    tokensIn: data?.prompt_eval_count || data?.usage?.prompt_tokens || 0,
    tokensOut: data?.eval_count || data?.usage?.completion_tokens || 0,
    durationMs: Date.now() - startedAt,
    status,
    error
  };
}

async function executeRoutedInference(deps, request, options = {}) {
  validateRequest(request);
  const startedAt = Date.now();
  const requestedModel = String(request.model || '').trim();
  const taskType = String(request.taskType || '').trim();
  let model = requestedModel;
  let hostUrl = null;
  let hostKey = null;
  let routingSource = 'model_router';

  if (!model && taskType) {
    const recommendation = await deps.getAdvisoryModelForTask(taskType, {
      caller: request.callerDetail || 'trusted-extension',
      durationMs: boundedTimeout(request.timeoutMs),
      createSoftClaim: true
    });
    model = recommendation?.model || '';
    hostUrl = recommendation?.url || null;
    hostKey = recommendation?.host || null;
    routingSource = recommendation?.source || 'task_router';
  }
  if (!model) {
    throw new TrustedRuntimeServiceError('No model is configured for the requested task.', {
      code: 'INFERENCE_MODEL_UNAVAILABLE', statusCode: 503
    });
  }

  let upstreamUrl;
  const headers = { 'Content-Type': 'application/json' };
  let payload;
  let release = () => {};
  let inferenceContract = null;
  let runtimeOptions = validatedLocalOptions(request.options || {});
  const localOptionAliases = {
    temperature: 'temperature',
    top_p: 'top_p',
    seed: 'seed',
    stop: 'stop'
  };
  for (const [requestKey, optionKey] of Object.entries(localOptionAliases)) {
    if (request[requestKey] !== undefined && runtimeOptions[optionKey] === undefined) {
      runtimeOptions[optionKey] = request[requestKey];
    }
  }
  const requestedOutputTokens = request.max_completion_tokens ?? request.max_tokens;
  if (requestedOutputTokens !== undefined && runtimeOptions.num_predict === undefined) {
    runtimeOptions.num_predict = requestedOutputTokens;
  }
  let numCtxSource = runtimeOptions.num_ctx != null ? 'caller' : 'unresolved';
  let keepAlive = request.keepAlive;
  const upstreamProtocol = 'ollama';

  hostUrl = hostUrl || deps.getTargetForModel(model);
  hostKey = hostKey || deps.resolveHostKey(hostUrl);
  if (!hostUrl) {
    throw new TrustedRuntimeServiceError('No routed inference host is available.', {
      code: 'INFERENCE_HOST_UNAVAILABLE', statusCode: 503
    });
  }
  await deps.assertHostAvailableForConsumer(hostUrl, {
    callerDetail: request.callerDetail || 'trusted-extension',
    model,
    path: 'trusted-extension-contract'
  });
  const pref = await deps.hostPreferenceService.getByHost(hostUrl);
  const pinned = resolvePinnedRuntimeOptions(pref, model, deps.modelsMatch);
  if (pinned) {
    keepAlive = pinned.keepAlive;
    if (runtimeOptions.num_ctx == null && pinned.contextSize) {
      runtimeOptions.num_ctx = pinned.contextSize;
      numCtxSource = 'host_preference_pin';
    }
  }
  inferenceContract = await deps.resolveInferenceContract({
    model,
    host: hostUrl,
    prompt: request.prompt,
    messages: request.messages,
    requestedNumCtx: runtimeOptions.num_ctx,
    numCtxSource,
    requestedMaxOutputTokens: runtimeOptions.num_predict
  });
  if (request.mode !== 'embed') {
    deps.applyContractOutputLimit({ routed: true, options: runtimeOptions, inferenceContract });
  }
  upstreamUrl = `${hostUrl}/api/${request.mode === 'embed' ? 'embed' : request.mode}`;
  payload = buildLocalPayload(request, model, runtimeOptions, keepAlive);
  release = await deps.hostGate.acquire(hostUrl, model);

  const metadata = frozenCopy({
    requestedModel: requestedModel || null,
    taskType: taskType || null,
    model,
    hostUrl,
    hostKey,
    routingSource,
    upstreamProtocol,
    options: runtimeOptions,
    numCtxSource,
    inferenceContract
  });
  const timeoutMs = boundedTimeout(request.timeoutMs);
  const abortBridge = createAbortBridge(options.signal, timeoutMs);
  const releaseGate = releaseOnce(release);

  try {
    const response = await deps.fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: abortBridge.signal
    });

    if (request.stream === true && response.ok && response.body) {
      const stream = attachStreamLifecycle(response.body, {
        abortBridge,
        release: releaseGate,
        onComplete: () => {
          void deps.recordInference(telemetryEntry(request, metadata, startedAt,
            abortBridge.signal.aborted ? 'error' : 'success', null,
            abortBridge.signal.aborted ? 'cancelled' : null));
        }
      });
      return Object.freeze({
        ok: true,
        status: response.status,
        headers: response.headers,
        stream,
        metadata
      });
    }

    const raw = await response.text();
    const data = safeJson(raw);
    abortBridge.cleanup();
    releaseGate();
    void deps.recordInference(telemetryEntry(
      request, metadata, startedAt, response.ok ? 'success' : 'error', data,
      response.ok ? null : `upstream_http_${response.status}`
    ));
    return Object.freeze({
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: frozenCopy(data),
      raw,
      metadata
    });
  } catch (error) {
    abortBridge.cleanup();
    releaseGate();
    const cancelled = options.signal?.aborted === true;
    const timedOut = abortBridge.signal.aborted && !cancelled;
    void deps.recordInference(telemetryEntry(
      request, metadata, startedAt, timedOut ? 'timeout' : 'error', null,
      cancelled ? 'cancelled' : (timedOut ? `timeout_${timeoutMs}ms` : error.message)
    ));
    throw new TrustedRuntimeServiceError(
      cancelled ? 'Inference request cancelled.' : (timedOut ? 'Inference request timed out.' : 'Routed inference failed.'),
      {
        code: cancelled ? 'INFERENCE_CANCELLED' : (timedOut ? 'INFERENCE_TIMEOUT' : 'INFERENCE_UPSTREAM_UNAVAILABLE'),
        statusCode: cancelled ? 499 : (timedOut ? 504 : 502),
        cause: error
      }
    );
  }
}

function defaultDependencies() {
  const ModelRegistry = require('../../models/ModelRegistry');
  const hostPreferenceService = require('../services/hostPreferenceService');
  const modelRouterConfig = require('../services/modelRouterConfig');
  const modelRouter = require('../services/modelRouter');
  const { getContextInfo } = require('../services/modelContextInfoService');
  const { resolveInferenceContract } = require('../services/inferenceContractService');
  const { applyContractOutputLimit } = require('../services/inferenceRuntimePolicy');
  const { assertHostAvailableForConsumer } = require('../services/benchmarkClaimGuard');
  const { modelsMatch } = require('../helpers/modelNameNormalization');
  const hostGate = require('../services/hostGate');
  return {
    ModelRegistry,
    hostPreferenceService,
    buildRouterConfigPayload: modelRouterConfig.buildRouterConfigPayload,
    getAdvisoryModelForTask: modelRouterConfig.getAdvisoryModelForTask,
    getTargetForModel: modelRouterConfig.getTargetForModel,
    resolveHostKey: modelRouter.resolveHostKey,
    recordInference: modelRouter.recordInference,
    getContextInfo,
    resolveInferenceContract,
    applyContractOutputLimit,
    assertHostAvailableForConsumer,
    modelsMatch,
    hostGate,
    fetch
  };
}

function createTrustedRuntimeServices(overrides = {}) {
  const deps = { ...defaultDependencies(), ...overrides };
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    inference: Object.freeze({
      execute(request, options) {
        return executeRoutedInference(deps, request, options);
      }
    }),
    routing: Object.freeze({
      getEffectiveSnapshot(options) {
        return buildEffectiveRoutingSnapshot(deps, options);
      }
    })
  });
}

module.exports = {
  CONTRACT_VERSION,
  TrustedRuntimeServiceError,
  boundedTimeout,
  buildEffectiveRoutingSnapshot,
  createAbortBridge,
  createTrustedRuntimeServices,
  executeRoutedInference,
  frozenCopy,
  telemetryEntry
};

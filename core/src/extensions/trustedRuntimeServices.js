'use strict';

const fetch = require('node-fetch');
const { StringDecoder } = require('string_decoder');
const { Transform } = require('stream');

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;
const CONTRACT_VERSION = 1;
const MAX_STREAM_TELEMETRY_LINE_CHARS = 65_536;
const MODES = new Set(['chat', 'generate', 'embed']);
const CONSUMER_CONTRACT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ATTRIBUTION_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const ATTRIBUTION_RUNTIME_VALUES = new Set(['agentx', 'codex', 'claude-code', 'external', 'other']);
const ATTRIBUTION_KEYS = new Set(['workItemId', 'correlationId', 'runtime', 'attempt']);
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

function normalizeServerAttribution(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrustedRuntimeServiceError('attribution must be an object when supplied.', {
      code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  const unknownKeys = Object.keys(value).filter((key) => !ATTRIBUTION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new TrustedRuntimeServiceError('attribution contains unsupported fields.', {
      code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  const identifier = (name) => {
    if (value[name] == null) return null;
    const text = String(value[name]).trim();
    if (!ATTRIBUTION_IDENTIFIER_PATTERN.test(text)) {
      throw new TrustedRuntimeServiceError(`${name} must be a bounded opaque identifier.`, {
        code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400
      });
    }
    return text;
  };
  const workItemId = identifier('workItemId');
  const correlationId = identifier('correlationId');
  if (!workItemId && !correlationId) {
    throw new TrustedRuntimeServiceError('attribution requires workItemId or correlationId.', {
      code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  const runtime = String(value.runtime || '').trim().toLowerCase();
  if (!ATTRIBUTION_RUNTIME_VALUES.has(runtime)) {
    throw new TrustedRuntimeServiceError('attribution.runtime must be a recognized runtime.', {
      code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  const attempt = value.attempt == null ? 1 : Number(value.attempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 10_000) {
    throw new TrustedRuntimeServiceError('attribution.attempt must be an integer from 1 through 10000.', {
      code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400
    });
  }
  return frozenCopy({ workItemId, correlationId, runtime, attempt });
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
        const contractInput = { model: resolved.model, host: resolved.hostUrl };
        const [contextInfo, inferenceContract] = await Promise.all([
          deps.getContextInfo(resolved.model, resolved.hostUrl),
          options.includeArtifactIdentity === true
            ? deps.resolveInferenceContract(contractInput, { includeArtifactIdentity: true })
            : deps.resolveInferenceContract(contractInput)
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

function createStreamingTelemetryObserver() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discardingOversizedLine = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let terminalObserved = false;

  const observeLine = (rawLine) => {
    let line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line || line === '[DONE]') return;

    const data = safeJson(line);
    if (data?.done === true || data?.event === 'done') terminalObserved = true;
    const observedTokensIn = Number(data?.prompt_eval_count ?? data?.usage?.prompt_tokens);
    const observedTokensOut = Number(data?.eval_count ?? data?.usage?.completion_tokens);
    if (Number.isFinite(observedTokensIn) && observedTokensIn >= 0) tokensIn = observedTokensIn;
    if (Number.isFinite(observedTokensOut) && observedTokensOut >= 0) tokensOut = observedTokensOut;
  };

  const consume = (text, final = false) => {
    let cursor = 0;
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(cursor, end);

      if (!discardingOversizedLine) {
        if (pending.length + segment.length <= MAX_STREAM_TELEMETRY_LINE_CHARS) {
          pending += segment;
        } else {
          pending = '';
          discardingOversizedLine = true;
        }
      }

      if (newline === -1) break;
      if (!discardingOversizedLine) observeLine(pending);
      pending = '';
      discardingOversizedLine = false;
      cursor = newline + 1;
    }

    if (final) {
      if (!discardingOversizedLine) observeLine(pending);
      pending = '';
      discardingOversizedLine = false;
    }
  };

  return {
    write(chunk, encoding) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      consume(decoder.write(buffer));
    },
    end() {
      consume(decoder.end(), true);
    },
    snapshot() {
      return { prompt_eval_count: tokensIn, eval_count: tokensOut, terminalObserved };
    }
  };
}

function attachStreamLifecycle(stream, { abortBridge, release, inferenceAdmission, onComplete }) {
  const observer = createStreamingTelemetryObserver();
  const relay = new Transform({
    transform(chunk, encoding, callback) {
      observer.write(chunk, encoding);
      callback(null, chunk);
    },
    flush(callback) {
      observer.end();
      callback();
    }
  });
  const finish = releaseOnce(() => {
    abortBridge.cleanup();
    release();
    const snapshot = observer.snapshot();
    const settle = snapshot.terminalObserved === true && !abortBridge.signal.aborted
      ? inferenceAdmission.complete()
      : inferenceAdmission.abandon(new Error('Trusted runtime stream ended without a verified terminal record'));
    void Promise.resolve(settle)
      .then(() => onComplete(snapshot))
      .catch(error => onComplete({ ...snapshot, admissionError: error.message }));
  });
  stream.once('error', (error) => relay.destroy(error));
  stream.once('close', () => {
    if (!stream.readableEnded && !relay.destroyed) relay.destroy();
  });
  relay.once('finish', finish);
  relay.once('close', () => {
    if (!stream.destroyed && !stream.readableEnded) stream.destroy();
    finish();
  });
  relay.once('error', finish);
  abortBridge.signal.addEventListener('abort', () => {
    if (!stream.destroyed) stream.destroy(abortBridge.signal.reason || new Error('Inference request cancelled'));
    if (!relay.destroyed) relay.destroy(abortBridge.signal.reason || new Error('Inference request cancelled'));
    finish();
  }, { once: true });
  stream.pipe(relay);
  return relay;
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
  if (request.exclusiveHost !== undefined && typeof request.exclusiveHost !== 'boolean') {
    throw new TrustedRuntimeServiceError('exclusiveHost must be a boolean when supplied.', {
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

function telemetryEntry(
  request,
  metadata,
  startedAt,
  status,
  data = null,
  error = null,
  attribution = null
) {
  return {
    host: metadata.hostUrl,
    model: metadata.model,
    caller: request.mode === 'embed' ? 'embedding' : 'proxy',
    callerDetail: request.callerDetail || 'trusted-extension',
    consumerContract: metadata.consumerContract || null,
    runtime: attribution?.runtime || null,
    workItemId: attribution?.workItemId || null,
    correlationId: attribution?.correlationId || null,
    attempt: attribution?.attempt || 1,
    taskType: request.taskType || null,
    routed: true,
    routedModel: metadata.model,
    routedHost: metadata.hostKey,
    routedHostUrl: metadata.hostUrl,
    routingTrace: {
      selected: { routingSource: metadata.routingSource || null }
    },
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
  const attribution = normalizeServerAttribution(options.attribution);
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

  const consumerContract = options.consumerContract == null
    ? null
    : String(options.consumerContract).trim();
  if (consumerContract && !CONSUMER_CONTRACT_PATTERN.test(consumerContract)) {
    throw new TrustedRuntimeServiceError('consumerContract must be a bounded lowercase identifier.', {
      code: 'INFERENCE_CONSUMER_CONTRACT_INVALID', statusCode: 400
    });
  }
  if (attribution && !consumerContract) {
    throw new TrustedRuntimeServiceError('attribution requires a server-attested consumer contract.', {
      code: 'INFERENCE_ATTRIBUTION_CONTRACT_REQUIRED', statusCode: 400
    });
  }

  let upstreamUrl;
  const headers = { 'Content-Type': 'application/json' };
  let payload;
  let release = () => {};
  let inferenceAdmission = null;
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

  if (options.hostUrl) {
    const hostCheck = deps.validateHostUrl(options.hostUrl);
    if (!hostCheck.valid) {
      throw new TrustedRuntimeServiceError(hostCheck.message || 'Inference host is not configured.', {
        code: 'INFERENCE_HOST_INVALID', statusCode: 400
      });
    }
    hostUrl = hostCheck.host;
    hostKey = deps.resolveHostKey(hostUrl);
    routingSource = 'trusted_host_override';
  }
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
  const metadata = frozenCopy({
    requestedModel: requestedModel || null,
    taskType: taskType || null,
    model,
    hostUrl,
    hostKey,
    routingSource,
    consumerContract,
    upstreamProtocol,
    options: runtimeOptions,
    numCtxSource,
    inferenceContract
  });
  const timeoutMs = boundedTimeout(request.timeoutMs);
  const abortBridge = createAbortBridge(options.signal, timeoutMs);
  let releaseGate = releaseOnce(release);

  try {
    inferenceAdmission = await deps.beginInferenceAdmission({
      host: hostUrl,
      model,
      kind: request.stream === true ? 'trusted-runtime-stream' : 'trusted-runtime',
      mode: request.exclusiveHost === true ? 'exclusive' : 'shared',
      principal: 'core-trusted-runtime',
      runtimeOptions: payload.options,
      ...(Object.prototype.hasOwnProperty.call(payload, 'keep_alive') && { keepAlive: payload.keep_alive }),
      signal: abortBridge.signal
    });
    release = request.exclusiveHost === true
      ? await deps.hostGate.acquireExclusive(hostUrl, model, { signal: inferenceAdmission.signal })
      : await deps.hostGate.acquire(hostUrl, model, { signal: inferenceAdmission.signal });
    releaseGate = releaseOnce(release);
    if (request.exclusiveHost === true) {
      const prepared = await deps.hostPreferenceService.prepareExclusiveModel(hostUrl, model);
      if (prepared?.status !== 'ready') {
        throw new TrustedRuntimeServiceError('The inference host could not complete its exclusive model handoff.', {
          code: prepared?.status === 'busy'
            ? 'INFERENCE_EXCLUSIVE_HOST_BUSY'
            : 'INFERENCE_EXCLUSIVE_HOST_PREPARE_FAILED',
          statusCode: 503
        });
      }
    }
    inferenceAdmission.markDispatched();
    const response = await deps.fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: inferenceAdmission.signal
    });

    if (request.stream === true && response.ok && response.body) {
      const stream = attachStreamLifecycle(response.body, {
        abortBridge,
        release: releaseGate,
        inferenceAdmission,
        onComplete: (data) => {
          void deps.recordInference(telemetryEntry(request, metadata, startedAt,
            abortBridge.signal.aborted ? 'error' : 'success', data,
            abortBridge.signal.aborted ? 'cancelled' : null, attribution));
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
    await inferenceAdmission.complete();
    inferenceAdmission = null;
    abortBridge.cleanup();
    releaseGate();
    void deps.recordInference(telemetryEntry(
      request, metadata, startedAt, response.ok ? 'success' : 'error', data,
      response.ok ? null : `upstream_http_${response.status}`, attribution
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
    if (inferenceAdmission) {
      await inferenceAdmission.abandon(error).catch(quarantineError => {
        error.inferenceQuarantineError = quarantineError;
      });
      inferenceAdmission = null;
    }
    abortBridge.cleanup();
    releaseGate();
    const cancelled = options.signal?.aborted === true;
    const timedOut = abortBridge.signal.aborted && !cancelled;
    void deps.recordInference(telemetryEntry(
      request, metadata, startedAt, timedOut ? 'timeout' : 'error', null,
      cancelled ? 'cancelled' : (timedOut ? `timeout_${timeoutMs}ms` : error.message),
      attribution
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
  const { beginInferenceAdmission } = require('../services/inferenceAdmissionService');
  const { modelsMatch } = require('../helpers/modelNameNormalization');
  const hostGate = require('../services/hostGate');
  const { validateHostUrl } = require('../helpers/ollamaHostConfig');
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
    beginInferenceAdmission,
    modelsMatch,
    hostGate,
    validateHostUrl,
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
  normalizeServerAttribution,
  telemetryEntry
};

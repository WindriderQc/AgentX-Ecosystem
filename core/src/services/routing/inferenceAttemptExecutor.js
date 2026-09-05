'use strict';

const fetch = require('node-fetch');
const hostGate = require('../hostGate');
const { beginInferenceAdmission } = require('../inferenceAdmissionService');

const OLLAMA_ABORT_SOURCE = Object.freeze({
  CALLER: 'caller',
  TIMEOUT: 'timeout',
});

function hasTerminalOllamaFrame(raw) {
  const validator = createOllamaStreamTerminalValidator();
  String(raw || '').split(/\r?\n/).forEach(frame => validator.observe(frame));
  return validator.isComplete();
}

function createOllamaStreamTerminalValidator() {
  let terminalObserved = false;
  let invalid = false;
  let frameCount = 0;

  return {
    observe(rawFrame) {
      const frame = String(rawFrame || '').trim();
      if (!frame) return { accepted: true, empty: true, terminal: false, data: null };
      frameCount += 1;
      if (terminalObserved) {
        invalid = true;
        return { accepted: false, terminal: false, data: null };
      }
      let data;
      try {
        data = JSON.parse(frame);
      } catch {
        invalid = true;
        return { accepted: false, terminal: false, data: null };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || typeof data.done !== 'boolean' || typeof data.error === 'string') {
        invalid = true;
        return { accepted: false, terminal: false, data: null };
      }
      const terminal = data?.done === true;
      if (terminal) terminalObserved = true;
      return { accepted: true, terminal, data };
    },
    isComplete() {
      return frameCount > 0 && terminalObserved && !invalid;
    },
    snapshot() {
      return { frameCount, terminalObserved, invalid, complete: this.isComplete() };
    }
  };
}

function hasTerminalOllamaResponse(raw) {
  try {
    const data = JSON.parse(String(raw || ''));
    return Boolean(data && typeof data === 'object' && !Array.isArray(data)
      && data.done === true && typeof data.error !== 'string');
  } catch {
    return false;
  }
}

function createIncompleteOllamaResponseError(stream) {
  const error = new Error(stream
    ? 'Ollama stream ended without an exact terminal done frame'
    : 'Ollama response ended without an exact terminal done object');
  error.code = stream ? 'OLLAMA_STREAM_INCOMPLETE' : 'OLLAMA_RESPONSE_INCOMPLETE';
  error.isOllamaAttemptError = true;
  error.ollamaTerminalObserved = false;
  return error;
}

function createAttemptAbortBridge({ externalSignal, stream, timeoutMs }) {
  const ownsTimeout = stream !== true;
  if (!ownsTimeout && !externalSignal) {
    return { signal: undefined, getAbortSource: () => null, cleanup() {} };
  }

  const controller = new AbortController();
  let abortSource = null;
  let callerListenerAttached = false;
  let timer = null;

  const abort = (source, message) => {
    if (controller.signal.aborted) return;
    abortSource = source;
    // Do not forward an external signal's reason. It may contain caller-owned
    // details that do not belong in Core errors or logs.
    controller.abort(new Error(message));
  };
  const abortFromCaller = () => abort(
    OLLAMA_ABORT_SOURCE.CALLER,
    'Ollama attempt cancelled by caller'
  );

  if (externalSignal?.aborted) {
    abortFromCaller();
  } else if (externalSignal?.addEventListener) {
    externalSignal.addEventListener('abort', abortFromCaller, { once: true });
    callerListenerAttached = true;
  }

  if (ownsTimeout && !controller.signal.aborted) {
    timer = setTimeout(() => abort(
      OLLAMA_ABORT_SOURCE.TIMEOUT,
      `Inference fetch timeout after ${timeoutMs}ms`
    ), timeoutMs);
  }

  return {
    signal: controller.signal,
    getAbortSource: () => abortSource,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (callerListenerAttached) {
        externalSignal.removeEventListener('abort', abortFromCaller);
        callerListenerAttached = false;
      }
    },
  };
}

async function executeOllamaAttempt({
  hostUrl,
  payload,
  useChat,
  stream = false,
  timeoutMs,
  signal: externalSignal,
}) {
  const url = `${hostUrl}/api/${useChat ? 'chat' : 'generate'}`;
  const abortBridge = createAttemptAbortBridge({ externalSignal, stream, timeoutMs });
  const attemptStartedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(abortBridge.signal && { signal: abortBridge.signal }),
    });
    const raw = await response.text();
    if (response.ok) {
      const terminalObserved = stream === true
        ? hasTerminalOllamaFrame(raw)
        : hasTerminalOllamaResponse(raw);
      if (!terminalObserved) throw createIncompleteOllamaResponseError(stream === true);
    }
    let data;
    try { data = JSON.parse(raw); } catch { data = { response: raw }; }
    return {
      ok: response.ok,
      status: response.status,
      response,
      raw,
      data,
      durationMs: Date.now() - attemptStartedAt,
    };
  } catch (err) {
    const abortSource = abortBridge.getAbortSource();
    err.attemptDurationMs = Date.now() - attemptStartedAt;
    err.isOllamaAttemptError = true;
    err.ollamaAbortSource = abortSource;
    err.isCallerCancellation = abortSource === OLLAMA_ABORT_SOURCE.CALLER;
    err.isOllamaTimeout = abortSource === OLLAMA_ABORT_SOURCE.TIMEOUT;
    throw err;
  } finally {
    abortBridge.cleanup();
  }
}

async function executeAdmittedOllamaAttempt(options) {
  const distributed = await beginInferenceAdmission({
    host: options.hostUrl,
    model: options.model,
    kind: options.admissionKind || (options.stream ? 'inference-stream' : 'inference'),
    principal: options.principal || 'core-service',
    requestId: options.requestId,
    workloadAdmissionId: options.workloadAdmissionId || null,
    workloadGeneration: options.workloadGeneration || null,
    runtimeOptions: options.payload?.options || null,
    ...(Object.prototype.hasOwnProperty.call(options.payload || {}, 'keep_alive')
      && { keepAlive: options.payload.keep_alive }),
    ttlMs: options.admissionTtlMs,
    signal: options.signal,
  });
  let release = () => {};
  let dispatched = false;
  try {
    if (!options.skipGate) {
      release = await hostGate.acquire(options.hostUrl, options.model, {
        signal: distributed.signal,
      });
    } else {
      release = await hostGate.track(options.hostUrl, options.model, {
        signal: distributed.signal,
      });
    }
    await options.afterAdmission?.();
    distributed.assertActive();
    distributed.markDispatched();
    dispatched = true;
    const result = await executeOllamaAttempt({ ...options, signal: distributed.signal });
    distributed.assertActive();
    await distributed.complete();
    return result;
  } catch (err) {
    await distributed.abandon(err).catch(quarantineError => {
      err.inferenceQuarantineError = quarantineError;
    });
    if (options.signal?.aborted || (!dispatched && distributed.signal.aborted)) {
      err.isCallerCancellation = true;
      err.isOllamaTimeout = false;
    }
    throw err;
  } finally {
    await release();
  }
}

async function modelExistsOnHost(hostUrl, model, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${hostUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: controller.signal,
    });
    return response.ok === true;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveVerifiedFallbackModel({
  hostUrl,
  baseModel,
  resolvedPrimaryModel
}) {
  const names = [];
  if (resolvedPrimaryModel && !names.includes(resolvedPrimaryModel)) names.push(resolvedPrimaryModel);
  if (baseModel && !names.includes(baseModel)) names.push(baseModel);

  for (const candidateModel of names) {
    if (await modelExistsOnHost(hostUrl, candidateModel)) return candidateModel;
  }
  return null;
}

module.exports = {
  OLLAMA_ABORT_SOURCE,
  createAttemptAbortBridge,
  createOllamaStreamTerminalValidator,
  hasTerminalOllamaFrame,
  hasTerminalOllamaResponse,
  executeAdmittedOllamaAttempt,
  executeOllamaAttempt,
  modelExistsOnHost,
  resolveVerifiedFallbackModel,
};

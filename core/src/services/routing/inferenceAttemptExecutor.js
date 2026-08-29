'use strict';

const fetch = require('node-fetch');
const hostGate = require('../hostGate');

const OLLAMA_ABORT_SOURCE = Object.freeze({
  CALLER: 'caller',
  TIMEOUT: 'timeout',
});

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
  let release = () => {};
  try {
    if (!options.skipGate) {
      release = await hostGate.acquire(options.hostUrl, options.model, {
        signal: options.signal,
      });
    }
  } catch (err) {
    if (options.signal?.aborted) {
      err.isCallerCancellation = true;
      err.isOllamaTimeout = false;
    }
    throw err;
  }

  try {
    return await executeOllamaAttempt(options);
  } finally {
    release();
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
  executeAdmittedOllamaAttempt,
  executeOllamaAttempt,
  modelExistsOnHost,
  resolveVerifiedFallbackModel,
};

'use strict';

const fetch = require('node-fetch');
const hostGate = require('../hostGate');

async function executeOllamaAttempt({ hostUrl, payload, useChat, stream = false, timeoutMs }) {
  const url = `${hostUrl}/api/${useChat ? 'chat' : 'generate'}`;
  const controller = !stream ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`Inference fetch timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;
  const attemptStartedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(controller && { signal: controller.signal }),
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
    err.attemptDurationMs = Date.now() - attemptStartedAt;
    err.isOllamaAttemptError = true;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeAdmittedOllamaAttempt(options) {
  const release = options.skipGate
    ? (() => {})
    : await hostGate.acquire(options.hostUrl, options.model);
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
  resolvedPrimaryModel,
  useAdapted,
  axPrefix = 'ax/',
}) {
  const names = [];
  if (useAdapted && baseModel && !baseModel.startsWith(axPrefix)) names.push(`${axPrefix}${baseModel}`);
  if (resolvedPrimaryModel && !names.includes(resolvedPrimaryModel)) names.push(resolvedPrimaryModel);
  if (baseModel && !names.includes(baseModel)) names.push(baseModel);

  for (const candidateModel of names) {
    if (await modelExistsOnHost(hostUrl, candidateModel)) return candidateModel;
  }
  return null;
}

module.exports = {
  executeAdmittedOllamaAttempt,
  executeOllamaAttempt,
  modelExistsOnHost,
  resolveVerifiedFallbackModel,
};

'use strict';

const fetch = require('node-fetch');
const { getFetchOptions } = require('../helpers/httpAgent');

const DEFAULT_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RUNTIME_TIMEOUT_MS = 10 * 60 * 1000;

function positiveTimeout(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readError(response) {
  const text = await response.text().catch(() => '');
  if (!text) return `HTTP ${response.status} ${response.statusText || ''}`.trim();
  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.message || text;
  } catch {
    return text;
  }
}

async function requestOllama(host, path, { method = 'POST', body, timeoutMs } = {}) {
  const url = `${host}${path}`;
  const response = await fetch(url, getFetchOptions(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: timeoutMs
  }));

  if (!response.ok) {
    const error = new Error(await readError(response));
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw error;
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function pullModel(host, name) {
  const timeoutMs = positiveTimeout(process.env.OLLAMA_PULL_TIMEOUT_MS, DEFAULT_PULL_TIMEOUT_MS);
  await requestOllama(host, '/api/pull', {
    body: { name, stream: false },
    timeoutMs
  });
  return { action: 'pull', host, name };
}

async function startModel(host, name, keepAlive = '10m') {
  const timeoutMs = positiveTimeout(process.env.OLLAMA_MODEL_START_TIMEOUT_MS, DEFAULT_RUNTIME_TIMEOUT_MS);
  await requestOllama(host, '/api/generate', {
    body: { model: name, prompt: '', stream: false, keep_alive: keepAlive },
    timeoutMs
  });
  return { action: 'start', host, name, keepAlive };
}

async function stopModel(host, name) {
  await requestOllama(host, '/api/generate', {
    body: { model: name, prompt: '', stream: false, keep_alive: 0 },
    timeoutMs: 30_000
  });
  return { action: 'stop', host, name };
}

async function deleteModel(host, name) {
  await requestOllama(host, '/api/delete', {
    method: 'DELETE',
    body: { name },
    timeoutMs: 60_000
  });
  return { action: 'delete', host, name };
}

module.exports = {
  pullModel,
  startModel,
  stopModel,
  deleteModel,
  requestOllama,
  DEFAULT_PULL_TIMEOUT_MS,
  DEFAULT_RUNTIME_TIMEOUT_MS
};

'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const { getFetchOptions } = require('../helpers/httpAgent');
const { beginRuntimeMutation } = require('./runtimeMutationLeaseService');

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

function parseExactJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function hasExactMutationTerminal({ terminal, response, raw, data }) {
  if (terminal === 'pull') return data?.status === 'success';
  if (terminal === 'generate') return data?.done === true;
  if (terminal === 'delete') {
    return (response.status === 200 || response.status === 204) && String(raw || '').trim() === '';
  }
  return false;
}

async function requestOllama(host, path, {
  method = 'POST', body, timeoutMs, signal, terminal
} = {}) {
  const url = `${host}${path}`;
  const response = await fetch(url, getFetchOptions(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: timeoutMs,
    signal
  }));

  if (!response.ok) {
    const error = new Error(await readError(response));
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    error.ollamaTerminalObserved = true;
    throw error;
  }

  const raw = response.status === 204 ? '' : await response.text();
  const data = raw.trim() ? parseExactJson(raw) : null;
  if (!hasExactMutationTerminal({ terminal, response, raw, data })) {
    const error = new Error(`Ollama ${terminal || 'mutation'} response ended without its exact terminal receipt`);
    error.code = 'OLLAMA_MUTATION_TERMINAL_INVALID';
    throw error;
  }
  return data;
}

async function runRuntimeMutation({ host, name, action, principal, signal, timeoutMs }, task) {
  const lifecycle = await beginRuntimeMutation({
    principal: principal || 'core-runtime-mutation',
    requestId: `ollama-${action}:${crypto.randomUUID()}`,
    scope: `ollama-${action}:${host}:${name}`,
    ttlMs: timeoutMs,
    signal
  });
  try {
    lifecycle.markDispatched();
    const result = await task(lifecycle.signal);
    lifecycle.assertActive();
    await lifecycle.complete();
    return result;
  } catch (error) {
    if (error.ollamaTerminalObserved === true) {
      await lifecycle.complete().catch(releaseError => { error.releaseError = releaseError; });
    } else {
      await lifecycle.abandon(error).catch(quarantineError => { error.quarantineError = quarantineError; });
    }
    throw error;
  }
}

async function pullModel(host, name, options = {}) {
  const timeoutMs = positiveTimeout(process.env.OLLAMA_PULL_TIMEOUT_MS, DEFAULT_PULL_TIMEOUT_MS);
  return runRuntimeMutation({ host, name, action: 'pull', principal: options.principal, signal: options.signal, timeoutMs }, async signal => {
    await requestOllama(host, '/api/pull', {
      body: { name, stream: false }, timeoutMs, signal, terminal: 'pull'
    });
    return { action: 'pull', host, name };
  });
}

async function startModel(host, name, keepAlive = '10m', options = {}) {
  const timeoutMs = positiveTimeout(process.env.OLLAMA_MODEL_START_TIMEOUT_MS, DEFAULT_RUNTIME_TIMEOUT_MS);
  return runRuntimeMutation({ host, name, action: 'start', principal: options.principal, signal: options.signal, timeoutMs }, async signal => {
    await requestOllama(host, '/api/generate', {
      body: { model: name, prompt: '', stream: false, keep_alive: keepAlive },
      timeoutMs,
      signal,
      terminal: 'generate'
    });
    return { action: 'start', host, name, keepAlive };
  });
}

async function stopModel(host, name, options = {}) {
  return runRuntimeMutation({ host, name, action: 'stop', principal: options.principal, signal: options.signal, timeoutMs: 30_000 }, async signal => {
    await requestOllama(host, '/api/generate', {
      body: { model: name, prompt: '', stream: false, keep_alive: 0 },
      timeoutMs: 30_000,
      signal,
      terminal: 'generate'
    });
    return { action: 'stop', host, name };
  });
}

async function deleteModel(host, name, options = {}) {
  return runRuntimeMutation({ host, name, action: 'delete', principal: options.principal, signal: options.signal, timeoutMs: 60_000 }, async signal => {
    await requestOllama(host, '/api/delete', {
      method: 'DELETE',
      body: { name },
      timeoutMs: 60_000,
      signal,
      terminal: 'delete'
    });
    return { action: 'delete', host, name };
  });
}

module.exports = {
  pullModel,
  startModel,
  stopModel,
  deleteModel,
  DEFAULT_PULL_TIMEOUT_MS,
  DEFAULT_RUNTIME_TIMEOUT_MS,
  _internal: { hasExactMutationTerminal, parseExactJson, requestOllama, runRuntimeMutation }
};

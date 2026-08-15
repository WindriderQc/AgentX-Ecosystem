/**
 * Ollama Enrichment Service
 *
 * Polls configured Ollama hosts every 60s and keeps a bounded in-memory view:
 * - Ollama reachability, version, latency
 * - Available model list and count
 * - Running/loaded models with VRAM breakdown
 * - Explicitly configured VRAM totals
 */

const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const ollamaVramService = require('./ollamaVramService');

const DEFAULT_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let _interval = null;
let _state = new Map(); // hostKey → last poll result (for API consumers)

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── Ollama API calls ──────────────────────────────────────

async function fetchTags(hostUrl) {
  const start = Date.now();
  const res = await fetch(`${hostUrl}/api/tags`, {
    timeout: FETCH_TIMEOUT_MS,
    ...getFetchOptions(hostUrl)
  });
  const latency = Date.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { models: data.models || [], latency };
}

async function fetchPs(hostUrl) {
  const res = await fetch(`${hostUrl}/api/ps`, {
    timeout: FETCH_TIMEOUT_MS,
    ...getFetchOptions(hostUrl)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.models || [];
}

async function fetchVersion(hostUrl) {
  const res = await fetch(`${hostUrl}/api/version`, {
    timeout: FETCH_TIMEOUT_MS,
    ...getFetchOptions(hostUrl)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.version || '';
}

// ── Poll a single host ───────────────────────────────────

async function pollHost(hostConfig) {
  const result = {
    hostKey: hostConfig.id,
    hostUrl: hostConfig.url,
    status: 'offline',
    version: '',
    latencyMs: null,
    models: [],
    modelCount: 0,
    runningModels: [],
    vram: null,
    error: null
  };

  try {
    // Parallel: tags + ps + version
    const [tagsResult, runningModels, version] = await Promise.all([
      fetchTags(hostConfig.url),
      fetchPs(hostConfig.url).catch(() => []),
      fetchVersion(hostConfig.url).catch(() => '')
    ]);

    result.status = 'online';
    result.latencyMs = tagsResult.latency;
    result.version = version;

    // Filter embedding/diagnostic models from available list
    result.models = (tagsResult.models || [])
      .filter(m => {
        const name = m.name.toLowerCase();
        const family = (m.details?.family || '').toLowerCase();
        if (name.includes('embed') || name.includes('nomic') || name.includes('bert')) return false;
        if (family === 'bert' || family === 'nomic-bert') return false;
        if (name.includes('diagnostic')) return false;
        return true;
      })
      .map(m => m.name);
    result.modelCount = result.models.length;

    // Running models with VRAM info
    result.runningModels = runningModels.map(m => ({
      name: m.name,
      size: m.size,
      size_vram: m.size_vram,
      expires_at: m.expires_at,
      digest: m.digest
    }));

    // VRAM from running models
    const modelVramBytes = runningModels.reduce((s, m) => s + (m.size_vram || 0), 0);
    const modelVramMiB = Math.round(modelVramBytes / (1024 * 1024));

    // Read an explicit product configuration; no host probing is performed.
    try {
      const vramResult = await ollamaVramService.getHostVram(hostConfig.url);
      if (vramResult.ok && vramResult.memoryTotalMiBTotal > 0) {
        result.vram = {
          totalMiB: vramResult.memoryTotalMiBTotal,
          usedMiB: vramResult.memoryUsedMiBTotal || 0,
          modelVramMiB,
          source: vramResult._source || 'configured-profile'
        };
      }
    } catch { /* Explicit VRAM configuration is optional. */ }

    // If no configured total exists, retain only Ollama's loaded-model value.
    if (!result.vram) {
      result.vram = { totalMiB: 0, usedMiB: 0, modelVramMiB, source: '' };
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

// ── Poll cycle ────────────────────────────────────────────

async function pollAll() {
  const hosts = getConfiguredHosts();
  if (hosts.length === 0) return;

  for (const hostConfig of hosts) {
    try {
      const result = await pollHost(hostConfig);
      _state.set(hostConfig.id, result);
    } catch (err) {
      logger.warn('Ollama Enrichment: poll failed', { hostKey: hostConfig.id, error: err.message });
    }
  }
}

// ── Public API ────────────────────────────────────────────

function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_interval) return;
  logger.info('Ollama Enrichment: Active', { intervalMs });

  // Initial poll after short delay (let DB connect first)
  setTimeout(() => pollAll().catch(err => {
    logger.warn('Ollama Enrichment: initial poll failed', { error: err.message });
  }), 5_000);

  _interval = setInterval(() => {
    pollAll().catch(err => {
      logger.warn('Ollama Enrichment: poll cycle failed', { error: err.message });
    });
  }, intervalMs);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

async function refresh() {
  await pollAll();
}

function getOllamaState() {
  const result = {};
  for (const [key, val] of _state) {
    result[key] = val;
  }
  return result;
}

module.exports = { start, stop, refresh, getOllamaState };

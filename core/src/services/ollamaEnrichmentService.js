/**
 * Ollama Enrichment Service
 *
 * Polls configured Ollama hosts every 60s and enriches Host documents with:
 * - Ollama reachability, version, latency
 * - Available model list and count
 * - Running/loaded models with VRAM breakdown
 * - GPU VRAM totals (from agent heartbeat or SSH nvidia-smi)
 *
 * Matching strategy: ollamaHostKey > ollamaUrl > IP match.
 */

const Host = require('../../models/Host');
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');
const { getConfiguredHosts, parseHostIp } = require('../helpers/ollamaHostConfig');
const ollamaVramService = require('./ollamaVramService');

const DEFAULT_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let _interval = null;
let _state = new Map(); // hostKey → last poll result (for API consumers)
const _missingHostLogCache = new Set();

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

// ── Host matching ─────────────────────────────────────────

async function findMatchingHost(hostConfig) {
  const hostIp = parseHostIp(hostConfig.url);
  const configuredName = String(hostConfig.name || '').trim();
  const matchers = [
    { ollamaHostKey: hostConfig.id },
    { ollamaUrl: hostConfig.url }
  ];

  if (hostIp) {
    matchers.push({ ip: hostIp });
  }

  if (configuredName) {
    const configuredNameRegex = new RegExp(`^${escapeRegex(configuredName)}$`, 'i');
    matchers.push({ hostname: configuredNameRegex });
    matchers.push({ hostId: configuredNameRegex });
  }

  return Host.findOne({ $or: matchers });
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── VRAM from agent heartbeat ─────────────────────────────

function getAgentGpuVram(host) {
  if (!host.gpus || host.gpus.length === 0) return null;
  const totalMiB = host.gpus.reduce((s, g) => s + (g.vramTotal || 0), 0);
  const usedMiB = host.gpus.reduce((s, g) => s + (g.vramUsed || 0), 0);
  if (totalMiB <= 0) return null;
  return { totalMiB, usedMiB, source: 'agent-gpu' };
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

    // Try SSH VRAM detection
    try {
      const vramResult = await ollamaVramService.getHostVram(hostConfig.url);
      if (vramResult.ok && vramResult.memoryTotalMiBTotal > 0) {
        result.vram = {
          totalMiB: vramResult.memoryTotalMiBTotal,
          usedMiB: vramResult.memoryUsedMiBTotal || 0,
          modelVramMiB,
          source: vramResult._source || 'ssh-nvidia-smi'
        };
      }
    } catch { /* SSH VRAM not available */ }

    // If no SSH VRAM, set modelVramMiB only
    if (!result.vram) {
      result.vram = { totalMiB: 0, usedMiB: 0, modelVramMiB, source: '' };
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

// ── Write results to Host doc ─────────────────────────────

async function writeToHost(hostConfig, pollResult) {
  const host = await findMatchingHost(hostConfig);
  if (!host) {
    const cacheKey = `${hostConfig.id}:${hostConfig.url}`;
    if (!_missingHostLogCache.has(cacheKey)) {
      _missingHostLogCache.add(cacheKey);
      logger.debug('Ollama Enrichment: No matching Host doc for configured host', {
        hostKey: hostConfig.id,
        name: hostConfig.name,
        url: hostConfig.url
      });
    }
    return;
  }

  _missingHostLogCache.delete(`${hostConfig.id}:${hostConfig.url}`);

  const update = {
    ollamaUrl: hostConfig.url,
    ollamaStatus: pollResult.status,
    ollamaModels: pollResult.models,
    ollamaRunningModels: pollResult.runningModels,
    ollamaModelCount: pollResult.modelCount,
    ollamaVersion: pollResult.version,
    ollamaLatencyMs: pollResult.latencyMs,
    ollamaLastChecked: new Date(),
    ollamaHostKey: hostConfig.id
  };

  // VRAM: prefer SSH/override, fall back to agent heartbeat GPUs
  if (pollResult.vram && pollResult.vram.totalMiB > 0) {
    update.ollamaVram = pollResult.vram;
  } else {
    const agentVram = getAgentGpuVram(host);
    if (agentVram) {
      agentVram.modelVramMiB = pollResult.vram?.modelVramMiB || 0;
      update.ollamaVram = agentVram;
    }
  }

  await Host.updateOne({ _id: host._id }, { $set: update });
}

// ── Poll cycle ────────────────────────────────────────────

async function pollAll() {
  const hosts = getConfiguredHosts();
  if (hosts.length === 0) return;

  for (const hostConfig of hosts) {
    try {
      const result = await pollHost(hostConfig);
      _state.set(hostConfig.id, result);
      await writeToHost(hostConfig, result);
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

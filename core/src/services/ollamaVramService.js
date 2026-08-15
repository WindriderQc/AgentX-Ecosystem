'use strict';

const HostPreference = require('../../models/HostPreference');

function parseHostFromUrl(hostUrl) {
  try {
    return new URL(hostUrl).hostname.toLowerCase();
  } catch {
    const match = String(hostUrl || '').match(/^(?:https?:\/\/)?([^/:]+)(?::\d+)?/i);
    return match ? match[1].toLowerCase() : null;
  }
}

function parseHostVramMap() {
  const map = new Map();
  for (const entry of String(process.env.OLLAMA_HOST_VRAM_MAP || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const host = trimmed.slice(0, separator).trim().toLowerCase();
    const vram = Number.parseInt(trimmed.slice(separator + 1).trim(), 10);
    if (host && Number.isFinite(vram) && vram > 0) map.set(host, vram);
  }
  return map;
}

async function getStaticVram(host) {
  const hostKey = parseHostFromUrl(host);
  if (!hostKey) return null;

  try {
    const preference = await HostPreference.findOne({
      hostUrl: { $regex: hostKey, $options: 'i' }
    }).lean();
    if (Number(preference?.vramTotalMiB) > 0) {
      return {
        ok: true,
        _source: 'configured-profile',
        host: hostKey,
        memoryTotalMiBTotal: Number(preference.vramTotalMiB),
        memoryUsedMiBTotal: 0,
        gpus: [],
        collectedAt: preference.updatedAt?.toISOString?.() || new Date().toISOString()
      };
    }
  } catch {
    // An unavailable product database must not trigger an infrastructure probe.
  }

  const configured = parseHostVramMap().get(hostKey);
  if (configured) {
    return {
      ok: true,
      _source: 'configured-environment',
      host: hostKey,
      memoryTotalMiBTotal: configured,
      memoryUsedMiBTotal: 0,
      gpus: [],
      collectedAt: new Date().toISOString()
    };
  }

  return null;
}

class OllamaVramService {
  constructor() {
    this.cache = new Map();
  }

  async getHostVram(hostUrl) {
    const host = parseHostFromUrl(hostUrl);
    const cached = host ? this.cache.get(host) : null;
    if (cached) return cached;

    const configured = await getStaticVram(hostUrl);
    const value = configured || {
      ok: false,
      _source: 'none',
      host,
      gpus: [],
      memoryUsedMiBTotal: 0,
      memoryTotalMiBTotal: 0,
      collectedAt: null,
      error: 'VRAM total is not configured for this Ollama endpoint',
      actionRequired: false
    };
    if (host) this.cache.set(host, value);
    return value;
  }

  async getVramForHosts(hosts) {
    return Promise.all((hosts || []).map(async (host) => {
      const result = await this.getHostVram(host.url);
      return {
        ...host,
        host: result.host || parseHostFromUrl(host.url),
        ok: Boolean(result.ok),
        _source: result._source || 'none',
        gpus: result.gpus || [],
        memoryUsedMiBTotal: result.memoryUsedMiBTotal || 0,
        memoryTotalMiBTotal: result.memoryTotalMiBTotal || 0,
        collectedAt: result.collectedAt || null,
        error: result.error || null,
        actionRequired: false
      };
    }));
  }
}

module.exports = new OllamaVramService();
module.exports._internal = { parseHostFromUrl, parseHostVramMap, getStaticVram };

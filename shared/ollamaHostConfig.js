'use strict';

const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::', '[::]']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseHostFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    const match = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return match ? match[1].toLowerCase() : null;
  }
}

function normalizeHostUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (WILDCARD_HOSTNAMES.has(parsed.hostname)) parsed.hostname = '127.0.0.1';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return withScheme;
  }
}

function isWildcardHostUrl(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return WILDCARD_HOSTNAMES.has(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

function parseHostIp(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    const match = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return match ? match[1] : null;
  }
}

function hostUrlKey(raw) {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    let hostname = parsed.hostname.toLowerCase();
    if (LOOPBACK_HOSTNAMES.has(hostname)) hostname = 'localhost';
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${hostname}:${port}`;
  } catch {
    return normalized.toLowerCase();
  }
}

function createOllamaHostConfig({ readDotenv = () => ({}), readFallbackHosts = () => [] } = {}) {
  function values() {
    return { env: process.env, dotenv: readDotenv() || {} };
  }

  function firstValue(keys, { allowWildcard = true } = {}) {
    const sources = values();
    let wildcardFallback = null;
    for (const source of [sources.env, sources.dotenv]) {
      for (const key of keys) {
        const raw = source[key];
        if (!raw || !String(raw).trim()) continue;
        const trimmed = String(raw).trim();
        if (!isWildcardHostUrl(trimmed)) return trimmed;
        if (allowWildcard && !wildcardFallback) wildcardFallback = trimmed;
      }
    }
    return wildcardFallback;
  }

  function textValue(keys, fallback) {
    const sources = values();
    for (const source of [sources.env, sources.dotenv]) {
      for (const key of keys) {
        const raw = source[key];
        if (raw && String(raw).trim()) return String(raw).trim();
      }
    }
    return fallback;
  }

  function hostVramMap() {
    const raw = firstValue(['OLLAMA_HOST_VRAM_MAP']);
    const map = new Map();
    if (!raw) return map;
    for (const entry of String(raw).split(',')) {
      const index = entry.indexOf('=');
      if (index <= 0) continue;
      const host = entry.slice(0, index).trim().toLowerCase();
      const vramMb = Number.parseInt(entry.slice(index + 1).trim(), 10);
      if (host && Number.isFinite(vramMb) && vramMb > 0) map.set(host, vramMb);
    }
    return map;
  }

  function resolveHostVramMb(hostUrl, fallback = 0) {
    const host = parseHostFromUrl(hostUrl);
    return (host && hostVramMap().get(host)) || fallback || 0;
  }

  function getConfiguredHosts() {
    const definitions = [
      {
        id: 'primary',
        urlKeys: ['OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'],
        nameKeys: ['OLLAMA_HOST_NAME', 'OLLAMA_HOST_1_NAME', 'OLLAMA_HOST_PRIMARY_NAME'],
        defaultName: 'Local Ollama'
      },
      {
        id: 'secondary',
        urlKeys: ['OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'],
        nameKeys: ['OLLAMA_HOST_2_NAME', 'OLLAMA_HOST_HEAVY_NAME', 'OLLAMA_HOST_SECONDARY_NAME'],
        defaultName: 'Ollama 2'
      },
      {
        id: 'tertiary',
        urlKeys: ['OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'],
        nameKeys: ['OLLAMA_HOST_3_NAME', 'OLLAMA_HOST_TERTIARY_NAME'],
        defaultName: 'Ollama 3'
      }
    ];

    const hosts = [];
    for (const [index, definition] of definitions.entries()) {
      const url = normalizeHostUrl(firstValue(definition.urlKeys));
      if (!url) continue;
      hosts.push({
        id: definition.id,
        name: textValue(definition.nameKeys, definition.defaultName),
        url,
        priority: index + 1,
        vramMb: resolveHostVramMb(url)
      });
    }

    if (hosts.length === 0) {
      for (const [index, host] of (readFallbackHosts() || []).entries()) {
        const url = normalizeHostUrl(host?.url);
        if (!url) continue;
        hosts.push({
          id: host.id || `config-${index}`,
          name: host.name || `Host ${index + 1}`,
          url,
          priority: host.priority || index + 1,
          vramMb: Number(host.vramMb) > 0 ? Number(host.vramMb) : 0
        });
      }
    }
    return hosts;
  }

  function getHostUrls() {
    return getConfiguredHosts().map(host => host.url);
  }

  function validateHostUrl(input) {
    const configured = getConfiguredHosts();
    const allowed = configured.map(host => host.url);
    if (input === undefined || input === null || !String(input).trim()) {
      return { valid: true, host: null, allowed, message: null };
    }

    const raw = String(input).trim();
    for (const host of configured) {
      if (raw === host.id || raw.toLowerCase() === String(host.name || '').toLowerCase()) {
        return { valid: true, host: host.url, allowed, message: null };
      }
    }

    const key = hostUrlKey(raw);
    const match = configured.find(host => hostUrlKey(host.url) === key);
    if (match) return { valid: true, host: match.url, allowed, message: null };

    return {
      valid: false,
      host: null,
      allowed,
      message: `Host "${raw}" is not in the configured allowlist; use one of: ${allowed.join(', ') || '(none configured)'}`
    };
  }

  return {
    normalizeHostUrl,
    getConfiguredHosts,
    getHostUrls,
    parseHostIp,
    validateHostUrl,
    hostUrlKey,
    isConfigured: () => getConfiguredHosts().length > 0
  };
}

module.exports = {
  createOllamaHostConfig,
  hostUrlKey,
  normalizeHostUrl,
  parseHostIp
};

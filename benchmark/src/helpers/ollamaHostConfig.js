/**
 * Ollama Host Configuration Helper (benchmark)
 *
 * Single source of truth for discovering configured Ollama hosts from env vars.
 * Used by: ollama-hosts routes, ollama-vram routes, host-test routes,
 *          syncOrchestrator, ollamaEnrichmentService.
 *
 * Note: 0.0.0.0 and :: are valid listen/bind addresses, but they are not valid
 * client destinations for outbound requests, so we rewrite them to 127.0.0.1.
 *
 * DIVERGENCE NOTE: This is benchmark's version. core/src/helpers/ollamaHostConfig.js
 * is a separate module with core-specific features (test-mode env cache clearing).
 * Do not assume changes here should be mirrored to core, or vice versa.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::', '[::]']);

/** Path to the standalone config file (used by setup wizard / gift edition) */
const CONFIG_FILE_PATH = path.join(__dirname, '..', '..', 'benchmark.config.json');
let parsedDotenvCache = null;

function parseHostFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    const m = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return m ? m[1].toLowerCase() : null;
  }
}

function normalizeHostUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (WILDCARD_HOSTNAMES.has(parsed.hostname)) {
      parsed.hostname = '127.0.0.1';
    }
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

function getParsedDotenv() {
  if (parsedDotenvCache !== null) return parsedDotenvCache;

  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      parsedDotenvCache = {};
      return parsedDotenvCache;
    }
    parsedDotenvCache = dotenv.parse(fs.readFileSync(envPath));
    return parsedDotenvCache;
  } catch {
    parsedDotenvCache = {};
    return parsedDotenvCache;
  }
}

function envFirst(...keys) {
  let wildcardFallback = null;

  for (const key of keys) {
    const v = process.env[key];
    if (!v || !String(v).trim()) continue;

    const trimmed = String(v).trim();
    if (!isWildcardHostUrl(trimmed)) return trimmed;

    if (!wildcardFallback) wildcardFallback = trimmed;

    const dotenvValue = getParsedDotenv()[key];
    if (dotenvValue && String(dotenvValue).trim() && !isWildcardHostUrl(dotenvValue)) {
      return String(dotenvValue).trim();
    }
  }

  return wildcardFallback;
}

function parseHostVramMapFromEnv() {
  const raw = envFirst('OLLAMA_HOST_VRAM_MAP');
  const map = new Map();
  if (!raw) return map;

  for (const entry of String(raw).split(',')) {
    const trimmed = String(entry || '').trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const host = trimmed.slice(0, idx).trim().toLowerCase();
    const vramMb = Number.parseInt(trimmed.slice(idx + 1).trim(), 10);
    if (!host || !Number.isFinite(vramMb) || vramMb <= 0) continue;
    map.set(host, vramMb);
  }

  return map;
}

function resolveHostVramMb(hostUrl, fallbackVramMb) {
  const host = parseHostFromUrl(hostUrl);
  if (!host) return fallbackVramMb;

  const map = parseHostVramMapFromEnv();
  return map.get(host) || fallbackVramMb;
}

function envText(key, fallback) {
  const value = process.env[key];
  return value && String(value).trim() ? String(value).trim() : fallback;
}

/** Returns structured host objects: { id, name, url, priority } */
function getConfiguredHosts() {
  const hosts = [];

  const primaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'));
  if (primaryUrl) hosts.push({
    id: 'primary',
    name: envText('OLLAMA_HOST_NAME', 'Local Ollama'),
    url: primaryUrl,
    priority: 1,
    vramMb: resolveHostVramMb(primaryUrl, 49152)
  });

  const secondaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'));
  if (secondaryUrl) hosts.push({
    id: 'secondary',
    name: envText('OLLAMA_HOST_2_NAME', 'Ollama 2'),
    url: secondaryUrl,
    priority: 2,
    vramMb: resolveHostVramMb(secondaryUrl, 16384)
  });

  const tertiaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'));
  if (tertiaryUrl) hosts.push({
    id: 'tertiary',
    name: envText('OLLAMA_HOST_3_NAME', 'Ollama 3'),
    url: tertiaryUrl,
    priority: 3,
    vramMb: resolveHostVramMb(tertiaryUrl, 12288)
  });

  // Fallback: read from benchmark.config.json (setup wizard / gift edition)
  if (hosts.length === 0) {
    const config = readConfigFile();
    if (config && Array.isArray(config.hosts)) {
      config.hosts.forEach((h, i) => {
        const url = normalizeHostUrl(h.url);
        if (url) hosts.push({
          id: `config-${i}`,
          name: h.name || `Host ${i + 1}`,
          url,
          priority: i + 1,
          vramMb: h.vramMb || 0
        });
      });
    }
  }

  return hosts;
}

/** Returns just the URL strings (for backward compat with syncOrchestrator) */
function getHostUrls() {
  return getConfiguredHosts().map(h => h.url);
}

/** Extract IP/hostname from an Ollama URL */
function parseHostIp(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    const m = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return m ? m[1] : null;
  }
}

// ── Config file helpers (setup wizard / gift edition) ─────────────────────

/** Read the standalone benchmark.config.json, or null if absent/invalid. */
function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/** Write config to benchmark.config.json */
function saveConfigFile(config) {
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Returns true if at least one Ollama host is reachable via env vars or config file */
function isConfigured() {
  const envHost = envFirst(
    'OLLAMA_HOST',
    'OLLAMA_HOST_1',
    'OLLAMA_HOST_PRIMARY',
    'OLLAMA_HOST_2',
    'OLLAMA_HOST_HEAVY',
    'OLLAMA_HOST_SECONDARY',
    'OLLAMA_HOST_3',
    'OLLAMA_HOST_TERTIARY'
  );
  if (envHost && String(envHost).trim()) return true;
  const config = readConfigFile();
  return !!(config && Array.isArray(config.hosts) && config.hosts.length > 0);
}

module.exports = {
  normalizeHostUrl, getConfiguredHosts, getHostUrls, parseHostIp,
  readConfigFile, saveConfigFile, isConfigured
};

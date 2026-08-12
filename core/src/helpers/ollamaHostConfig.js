/**
 * Ollama Host Configuration Helper (core)
 *
 * Single source of truth for discovering configured Ollama hosts from env vars.
 * Used by: ollama-hosts routes, ollama-vram routes,
 *          syncOrchestrator, ollamaEnrichmentService.
 *
 * DIVERGENCE NOTE: This is core's version. benchmark/src/helpers/ollamaHostConfig.js
 * is a separate module with benchmark-specific features (config file persistence,
 * isConfigured()). Do not assume changes here should be mirrored to benchmark, or vice versa.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::', '[::]']);
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

  if ((process.env.NODE_ENV || '').trim() === 'test') {
    parsedDotenvCache = {};
    return parsedDotenvCache;
  }

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
  }

  for (const key of keys) {
    const dotenvValue = getParsedDotenv()[key];
    if (dotenvValue && String(dotenvValue).trim() && !isWildcardHostUrl(dotenvValue)) {
      return String(dotenvValue).trim();
    }
  }

  return wildcardFallback;
}

function envValueFirst(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v && String(v).trim()) return String(v).trim();
  }

  for (const key of keys) {
    const dotenvValue = getParsedDotenv()[key];
    if (dotenvValue && String(dotenvValue).trim()) {
      return String(dotenvValue).trim();
    }
  }

  return null;
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

/** Returns structured host objects: { id, name, url, priority } */
function getConfiguredHosts() {
  const hosts = [];

  const primaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'));
  if (primaryUrl) hosts.push({
    id: 'primary',
    name: envValueFirst('OLLAMA_HOST_NAME', 'OLLAMA_HOST_1_NAME', 'OLLAMA_HOST_PRIMARY_NAME') || 'Local Ollama',
    url: primaryUrl,
    priority: 1,
    vramMb: resolveHostVramMb(primaryUrl, 49152)
  });

  const secondaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'));
  if (secondaryUrl) hosts.push({
    id: 'secondary',
    name: envValueFirst('OLLAMA_HOST_2_NAME', 'OLLAMA_HOST_HEAVY_NAME', 'OLLAMA_HOST_SECONDARY_NAME') || 'Ollama 2',
    url: secondaryUrl,
    priority: 2,
    vramMb: resolveHostVramMb(secondaryUrl, 16384)
  });

  const tertiaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'));
  if (tertiaryUrl) hosts.push({
    id: 'tertiary',
    name: envValueFirst('OLLAMA_HOST_3_NAME', 'OLLAMA_HOST_TERTIARY_NAME') || 'Ollama 3',
    url: tertiaryUrl,
    priority: 3,
    vramMb: resolveHostVramMb(tertiaryUrl, 12288)
  });

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

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Build a comparison key for a host URL: scheme + canonical-hostname + port.
 * Loopback variants (`localhost`, `127.0.0.1`, `::1`) collapse to one canonical
 * form so a configured `http://localhost:11434` and a caller-supplied
 * `http://127.0.0.1:11434` (or vice versa) compare equal — per ecosystem
 * CLAUDE.md "Loopback host guidance".
 */
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

/**
 * Validate a caller-supplied host URL or host name against the configured
 * allowlist. Accepts:
 *   - an exact URL match against any `getConfiguredHosts()[i].url`
 *   - a loopback equivalent (`http://localhost:<port>` ↔ `http://127.0.0.1:<port>`)
 *   - a host **name** (e.g. `'Local Ollama'`) or **id** (e.g. `'primary'`),
 *     which is resolved to the configured URL
 *
 * Returns `{ valid, host, allowed, message }`:
 *   - `valid` (boolean)
 *   - `host`  (string|null) — the canonical configured URL on success
 *   - `allowed` (string[])  — the configured URLs (for error messages)
 *   - `message` (string|null) — human-readable error on rejection
 *
 * An empty / falsy `input` is treated as "no override" and returns
 * `{ valid: true, host: null }` so callers can chain it before falling back
 * to their own default (the existing `OLLAMA_HOST || 'http://localhost:...'`
 * pattern). If the operator passes a string, it MUST be in the allowlist.
 */
function validateHostUrl(input) {
  const configured = getConfiguredHosts();
  const allowed = configured.map((h) => h.url);

  if (input === undefined || input === null) {
    return { valid: true, host: null, allowed, message: null };
  }
  const raw = String(input).trim();
  if (!raw) {
    return { valid: true, host: null, allowed, message: null };
  }

  // 1) Host name / id lookup (e.g. 'Local Ollama', 'primary')
  for (const h of configured) {
    if (raw === h.id || raw.toLowerCase() === String(h.name || '').toLowerCase()) {
      return { valid: true, host: h.url, allowed, message: null };
    }
  }

  // 2) URL allowlist match (with loopback equivalence)
  const inputKey = hostUrlKey(raw);
  if (inputKey) {
    for (const h of configured) {
      if (hostUrlKey(h.url) === inputKey) {
        return { valid: true, host: h.url, allowed, message: null };
      }
    }
  }

  return {
    valid: false,
    host: null,
    allowed,
    message: `Host "${raw}" is not in the configured allowlist; use one of: ${allowed.join(', ') || '(none configured)'}`
  };
}

module.exports = {
  normalizeHostUrl,
  getConfiguredHosts,
  getHostUrls,
  parseHostIp,
  validateHostUrl,
  hostUrlKey
};

'use strict';

const net = require('node:net');
const dns = require('node:dns');

const DEFAULT_OLLAMA_PORT = '11434';
const EXTRA_TARGETS_ENV = 'AGENTX_OLLAMA_ALLOWED_TARGETS';

const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata.azure.internal',
  'metadata.internal',
  'instance-data',
  'instance-data.ec2.internal'
]);

const METADATA_IPV4 = new Set([
  '100.100.100.200'
]);

const METADATA_IPV6 = new Set([
  'fd00:ec2::254'
]);

class OllamaTargetAdmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OllamaTargetAdmissionError';
    this.code = 'OLLAMA_TARGET_REJECTED';
    this.statusCode = 400;
  }
}

function reject(message) {
  throw new OllamaTargetAdmissionError(message);
}

function stripIpv6Brackets(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
}

function parseIpv4(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').map((part) => Number.parseInt(part, 10));
}

function mappedIpv4FromIpv6(address) {
  const lower = String(address || '').toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice('::ffff:'.length);
  const dotted = parseIpv4(tail);
  if (dotted) return dotted;

  const groups = tail.split(':');
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function unsafeIpv4Reason(address, octets = parseIpv4(address)) {
  if (!octets) return null;
  if (METADATA_IPV4.has(address)) return 'cloud metadata address';
  if (octets[0] === 0) return 'unspecified address range';
  if (octets[0] === 169 && octets[1] === 254) return 'link-local address range';
  if (octets[0] >= 224 && octets[0] <= 239) return 'multicast address range';
  if (octets.every((part) => part === 255)) return 'broadcast address';
  return null;
}

function unsafeHostReason(rawHostname) {
  const hostname = stripIpv6Brackets(rawHostname).replace(/\.$/, '');
  if (!hostname) return 'missing hostname';
  if (METADATA_HOSTNAMES.has(hostname)) return 'cloud metadata hostname';

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) return unsafeIpv4Reason(hostname);
  if (ipVersion !== 6) return null;

  if (METADATA_IPV6.has(hostname)) return 'cloud metadata address';
  if (hostname === '::') return 'unspecified address';

  const mapped = mappedIpv4FromIpv6(hostname);
  const mappedReason = mapped && unsafeIpv4Reason(mapped.join('.'), mapped);
  if (mappedReason) return mappedReason;

  const firstGroup = Number.parseInt(hostname.split(':')[0] || '0', 16);
  if ((firstGroup & 0xffc0) === 0xfe80) return 'link-local address range';
  if ((firstGroup & 0xff00) === 0xff00) return 'multicast address range';
  return null;
}

function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) reject('Ollama target URL is required');
  const trimmed = raw.trim();
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    reject('Ollama target must use http or https');
  }

  let parsed;
  try {
    parsed = new URL(scheme ? trimmed : `http://${trimmed}`);
  } catch {
    reject('Ollama target URL is invalid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    reject('Ollama target must use http or https');
  }
  if (parsed.username || parsed.password) reject('Ollama target must not contain credentials');
  if (parsed.search) reject('Ollama target must not contain a query string');
  if (parsed.hash) reject('Ollama target must not contain a fragment');
  if (parsed.pathname !== '/') reject('Ollama target must not contain a path');

  const unsafeReason = unsafeHostReason(parsed.hostname);
  if (unsafeReason) reject(`Ollama target uses a forbidden ${unsafeReason}`);
  return parsed;
}

function effectivePort(parsed) {
  return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
}

function safeAllowedOrigin(raw) {
  try {
    return parseTarget(String(raw || '')).origin;
  } catch {
    return null;
  }
}

function configuredTargetValues(configuredHosts) {
  return (Array.isArray(configuredHosts) ? configuredHosts : [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.url)
    .filter(Boolean);
}

function explicitTargetValues(env) {
  return String(env?.[EXTRA_TARGETS_ENV] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Admit one operator-selected Ollama origin.
 *
 * The normal setup surface may target port 11434 on loopback, LAN hosts, or
 * Docker DNS names. Non-standard ports require an exact, pre-existing target
 * (configuration or AGENTX_OLLAMA_ALLOWED_TARGETS), so a request body cannot
 * turn the profiler into a general-purpose network client.
 */
function admitOllamaTarget(raw, {
  configuredHosts = [],
  env = process.env
} = {}) {
  const parsed = parseTarget(raw);
  const allowedOrigins = new Set([
    ...configuredTargetValues(configuredHosts),
    ...explicitTargetValues(env)
  ].map(safeAllowedOrigin).filter(Boolean));

  if (effectivePort(parsed) !== DEFAULT_OLLAMA_PORT && !allowedOrigins.has(parsed.origin)) {
    reject(`Ollama target port must be ${DEFAULT_OLLAMA_PORT} unless the exact target is explicitly configured`);
  }

  return parsed.origin;
}

async function admitOllamaTargetResolved(raw, {
  configuredHosts = [],
  env = process.env,
  lookup = dns.promises.lookup.bind(dns.promises)
} = {}) {
  const origin = admitOllamaTarget(raw, { configuredHosts, env });
  const parsed = new URL(origin);
  const hostname = stripIpv6Brackets(parsed.hostname);
  if (net.isIP(hostname)) return origin;
  // Compose service names are intentionally single-label and resolved only by
  // the container network at connect time. Known metadata names were already
  // denied by parseTarget, so do not send these names through slow DNS search
  // suffix expansion on operator workstations.
  if (!hostname.includes('.')) return origin;

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    // Single-label names are required for Docker/Compose service discovery and
    // may only exist inside the runtime network. A failed lookup cannot produce
    // an outbound connection; the subsequent bounded probe reports unreachable.
    reject('Ollama target hostname could not be resolved safely');
  }

  const entries = Array.isArray(records) ? records : [records];
  if (entries.length === 0) reject('Ollama target hostname did not resolve to an address');
  for (const record of entries) {
    const address = typeof record === 'string' ? record : record?.address;
    const reason = unsafeHostReason(address);
    if (reason) reject(`Ollama target resolves to a forbidden ${reason}`);
    if (!net.isIP(String(address || ''))) reject('Ollama target resolved to an invalid address');
  }
  return origin;
}

module.exports = {
  DEFAULT_OLLAMA_PORT,
  EXTRA_TARGETS_ENV,
  OllamaTargetAdmissionError,
  admitOllamaTarget,
  admitOllamaTargetResolved,
  _internal: {
    effectivePort,
    mappedIpv4FromIpv6,
    parseTarget,
    unsafeHostReason
  }
};

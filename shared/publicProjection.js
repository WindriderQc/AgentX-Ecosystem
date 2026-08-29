'use strict';

const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const UNC_PATH_PATTERN = /\\\\[a-z0-9._-]+\\[^\s"'<>]+/gi;
const WINDOWS_PATH_PATTERN = /\b[a-z]:\\[^\s"'<>]+/gi;
const BRACKETED_IPV6_ENDPOINT_PATTERN = /\[[0-9a-f:.%]+\](?::\d{1,5})?/gi;
const IPV4_ENDPOINT_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const HOST_PORT_PATTERN = /\b(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{2,5}\b/gi;
const NETWORK_ERROR_LOCATION_PATTERN = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\s+(?:connect\s+)?[^\s,;]+/gi;
const POSIX_PATH_PATTERN = /(^|[\s(])\/(?:[^\s"'<>),]+\/?)+/g;
const PRIVATE_LOCATION_KEYS = new Set([
  'address',
  'endpoint',
  'host',
  'hostname',
  'ip',
  'path',
  'port',
  'socket',
  'uri',
]);

function isPrivateLocationKey(key) {
  const normalized = String(key).toLowerCase();
  return normalized.endsWith('url')
    || normalized.endsWith('path')
    || PRIVATE_LOCATION_KEYS.has(normalized);
}

function redactDeploymentLocations(value) {
  return String(value || '')
    .replace(ABSOLUTE_URL_PATTERN, '[redacted-endpoint]')
    .replace(UNC_PATH_PATTERN, '[redacted-path]')
    .replace(WINDOWS_PATH_PATTERN, '[redacted-path]')
    .replace(BRACKETED_IPV6_ENDPOINT_PATTERN, '[redacted-endpoint]')
    .replace(IPV4_ENDPOINT_PATTERN, '[redacted-endpoint]')
    .replace(HOST_PORT_PATTERN, '[redacted-endpoint]')
    .replace(NETWORK_ERROR_LOCATION_PATTERN, '$1 [redacted-endpoint]')
    .replace(POSIX_PATH_PATTERN, (_match, prefix) => `${prefix}[redacted-path]`);
}

function sanitizePublicProjection(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactDeploymentLocations(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizePublicProjection);
  if (typeof value !== 'object') return null;

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isPrivateLocationKey(key))
    .map(([key, entry]) => [key, sanitizePublicProjection(entry)]));
}

module.exports = {
  isPrivateLocationKey,
  redactAbsoluteUrls: redactDeploymentLocations,
  redactDeploymentLocations,
  sanitizePublicProjection,
};

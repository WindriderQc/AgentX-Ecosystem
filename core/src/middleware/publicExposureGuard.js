'use strict';

const { operatorTokenAllowed } = require('./operatorAccess');

const PROTECTED_PATH_PREFIXES = ['/api/', '/mcp', '/api/mcp'];

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostnameFromUrl(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return '';
  }
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/:\d+$/, '');
}

function configuredPublicHosts() {
  const configuredHosts = [
    ...splitList(process.env.AGENTX_PUBLIC_HOSTS),
    ...splitList(process.env.AGENTX_PUBLIC_HOST)
  ];

  const explicitUrlHosts = [
    hostnameFromUrl(process.env.AGENTX_PUBLIC_URL)
  ].filter(Boolean);

  return new Set([...configuredHosts, ...explicitUrlHosts]
    .map((entry) => normalizeHost(hostnameFromUrl(entry) || entry))
    .filter(Boolean));
}

function requestHost(req) {
  // Do not trust caller-supplied forwarding metadata. Deployments that use a
  // reverse proxy must preserve the external Host value (or enforce auth at
  // the proxy) rather than allowing X-Forwarded-Host to disable this guard.
  return normalizeHost(req.get?.('host') || req.hostname || '');
}

function isProtectedPath(pathname) {
  const path = String(pathname || '');
  return PROTECTED_PATH_PREFIXES.some((prefix) => (
    path === prefix.replace(/\/$/, '') || path.startsWith(prefix)
  ));
}

function publicExposureGuard(req, res, next) {
  const publicHosts = configuredPublicHosts();
  const host = requestHost(req);

  if (!host || !publicHosts.has(host) || !isProtectedPath(req.path || req.originalUrl)) {
    return next();
  }

  if (operatorTokenAllowed(req)) return next();

  return res.status(403).json({
    ok: false,
    status: 'error',
    code: 'PUBLIC_EXPOSURE_GUARD',
    message: 'Public AgentX API access requires an operator token.'
  });
}

module.exports = {
  configuredPublicHosts,
  requestHost,
  isProtectedPath,
  publicExposureGuard
};

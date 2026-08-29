'use strict';

const crypto = require('crypto');

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeHostname(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input.includes('://') ? input : `http://${input}`);
    return parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  } catch {
    return '';
  }
}

function safeTokenMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function operatorTokenAllowed(req, env) {
  const authorization = String(req.get?.('authorization') || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const presented = bearer || req.get?.('x-agentx-operator-token') || '';
  return safeTokenMatch(env.AGENTX_OPERATOR_TOKEN || env.AGENTX_ADMIN_TOKEN, presented);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isLoopbackAddress(address) {
  const value = normalizeRemoteAddress(address);
  return value === '127.0.0.1' || value === '::1';
}

function normalizeRemoteAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  const mappedIpv4 = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mappedIpv4 ? mappedIpv4[1] : value;
}

function configuredTrustedUiProxyAddresses(env = process.env) {
  return new Set(splitList(env.AGENTX_TRUSTED_UI_PROXY_ADDRESSES)
    .map(normalizeRemoteAddress)
    .filter(Boolean));
}

function trustedUiProxySourceAllowed(address, env = process.env) {
  const normalized = normalizeRemoteAddress(address);
  return isLoopbackAddress(normalized)
    || configuredTrustedUiProxyAddresses(env).has(normalized);
}

function hasBrowserRequestSignals(req) {
  // Node/Undici fetch adds `Sec-Fetch-Mode: cors` to non-browser requests.
  // Treating that header alone as browser identity breaks local CLI and
  // product service calls without adding a meaningful CSRF guarantee.
  return Boolean(
    req.get?.('origin')
    || req.get?.('referer')
    || req.get?.('sec-fetch-site')
  );
}

function requestOrigin(req) {
  const direct = String(req.get?.('origin') || '').trim();
  if (direct) return direct;
  const referer = String(req.get?.('referer') || '').trim();
  try {
    return referer ? new URL(referer).origin : '';
  } catch {
    return '';
  }
}

function configuredOrigins(publicUrlEnv, env) {
  const values = [
    ...splitList(env.AGENTX_OPERATOR_UI_HOSTS),
    ...publicUrlEnv.map((name) => env[name]),
  ].filter(Boolean);
  return new Set(values.map((value) => {
    try {
      return String(value).includes('://') ? new URL(String(value)).origin : '';
    } catch {
      return '';
    }
  }).filter(Boolean));
}

function sameOriginMutationAllowed(
  req,
  allowedHosts,
  allowedOrigins,
  { trustLoopbackProxyUi = false, trustedProxyAddresses = new Set() } = {}
) {
  const fetchSite = String(req.get?.('sec-fetch-site') || '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') return false;

  const origin = requestOrigin(req);
  const rawHost = String(req.get?.('host') || '').split(',')[0].trim();
  const hostname = normalizeHostname(rawHost);
  if (!origin || !rawHost || !allowedHosts.has(hostname)) return false;

  // Same-origin headers are a browser CSRF signal, not machine identity. Only
  // the local UI boundary may rely on them without a credential. Remote/LAN
  // deployments must use the operator-token path.
  const remoteAddress = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const localTarget = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const normalizedRemoteAddress = normalizeRemoteAddress(remoteAddress);
  if (!isLoopbackAddress(normalizedRemoteAddress)
    && !trustedProxyAddresses.has(normalizedRemoteAddress)
    && !(trustLoopbackProxyUi && localTarget)) return false;

  try {
    const parsedOrigin = new URL(origin);
    if (normalizeHostname(parsedOrigin.hostname) !== hostname) return false;
    const connectionOrigin = new URL(`${req.protocol || 'http'}://${rawHost}`).origin;
    return parsedOrigin.origin === connectionOrigin || allowedOrigins.has(parsedOrigin.origin);
  } catch {
    return false;
  }
}

function createApiHostGuard({
  serviceHosts = [],
  publicUrlEnv = [],
  protectMutations = false,
  env = process.env,
} = {}) {
  return function apiHostGuard(req, res, next) {
    // Express routes are case-insensitive unless configured otherwise. Match
    // that behavior here so `/API/...` cannot bypass a guard mounted for
    // lowercase route declarations.
    const pathname = String(req.path || req.originalUrl || '').toLowerCase();
    if (!pathname.startsWith('/api/')) return next();

    const internalServiceHosts = new Set(serviceHosts.map(normalizeHostname).filter(Boolean));
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '::1',
      ...internalServiceHosts,
      ...splitList(env.AGENTX_OPERATOR_UI_HOSTS).map(normalizeHostname),
      ...publicUrlEnv.map((name) => normalizeHostname(env[name])),
    ].filter(Boolean));
    const host = normalizeHostname(String(req.get?.('host') || '').split(',')[0]);
    if (operatorTokenAllowed(req, env)) return next();
    if (!host || !allowedHosts.has(host)) {
      return res.status(403).json({
        ok: false,
        status: 'error',
        code: 'UNTRUSTED_HOST',
        message: 'Agent X API access requires a trusted product hostname or operator token.',
      });
    }

    const isMutation = !SAFE_METHODS.has(String(req.method || 'GET').toUpperCase());
    if (!protectMutations || !isMutation) return next();

    const browserRequest = hasBrowserRequestSignals(req);
    if (browserRequest) {
      const trustLoopbackProxyUi = String(env.AGENTX_TRUST_LOOPBACK_PROXY_UI || '')
        .trim().toLowerCase() === 'true';
      if (sameOriginMutationAllowed(
        req,
        allowedHosts,
        configuredOrigins(publicUrlEnv, env),
        {
          trustLoopbackProxyUi,
          trustedProxyAddresses: configuredTrustedUiProxyAddresses(env),
        }
      )) {
        return next();
      }
      return res.status(403).json({
        ok: false,
        status: 'error',
        code: 'CROSS_SITE_MUTATION_FORBIDDEN',
        message: 'State-changing Agent X requests require an exact same-origin UI or operator token.',
      });
    }

    const remoteAddress = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const trustInternalServiceHosts = String(env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS || '')
      .trim().toLowerCase() === 'true';
    const trustLoopbackPublishedAccess = String(env.AGENTX_TRUST_LOOPBACK_PROXY_UI || '')
      .trim().toLowerCase() === 'true';
    const loopbackPublishedTarget = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLoopbackAddress(remoteAddress)
      || (trustLoopbackPublishedAccess && loopbackPublishedTarget)
      || (trustInternalServiceHosts && internalServiceHosts.has(host))) return next();

    return res.status(403).json({
      ok: false,
      status: 'error',
      code: 'MUTATION_AUTH_REQUIRED',
      message: 'State-changing Agent X requests require a local/internal caller or operator token.',
    });
  };
}

module.exports = {
  configuredTrustedUiProxyAddresses,
  createApiHostGuard,
  hasBrowserRequestSignals,
  isLoopbackAddress,
  normalizeHostname,
  normalizeRemoteAddress,
  sameOriginMutationAllowed,
  safeTokenMatch,
  trustedUiProxySourceAllowed,
};

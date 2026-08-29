'use strict';

const crypto = require('crypto');

function isLoopbackAddress(address) {
  const ip = String(address || '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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

function configuredOperatorUiHosts() {
  const configured = [
    ...splitList(process.env.AGENTX_OPERATOR_UI_HOSTS),
    ...splitList(process.env.AGENTX_TRUSTED_UI_HOSTS),
    process.env.CORE_PUBLIC_URL,
  ].filter(Boolean);
  return new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...configured.map(normalizeHostname).filter(Boolean),
  ]);
}

function requestHostname(req) {
  return normalizeHostname(String(req.get?.('host') || '').split(',')[0].trim());
}

function operatorUiHostAllowed(req) {
  const host = requestHostname(req);
  return Boolean(host) && configuredOperatorUiHosts().has(host);
}

function expectedOperatorToken() {
  return process.env.AGENTX_OPERATOR_TOKEN || process.env.AGENTX_ADMIN_TOKEN || '';
}

function presentedOperatorToken(req) {
  const auth = req.get?.('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return bearer
    || req.get?.('x-agentx-operator-token')
    || req.get?.('x-agentx-admin-token')
    || '';
}

function tokensMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function operatorTokenAllowed(req) {
  return tokensMatch(expectedOperatorToken(), presentedOperatorToken(req));
}

function sameOriginUiAllowed(req) {
  if (!operatorUiHostAllowed(req)) return false;
  const remoteAddress = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const hostName = requestHostname(req);
  const localTarget = hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '::1';
  const trustLoopbackProxyUi = String(process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI || '')
    .trim().toLowerCase() === 'true';
  if (!isLoopbackAddress(remoteAddress) && !(trustLoopbackProxyUi && localTarget)) return false;
  let origin = String(req.get?.('origin') || '').trim();
  const fetchSite = String(req.get?.('sec-fetch-site') || '').trim().toLowerCase();
  if (!origin) {
    const referer = String(req.get?.('referer') || '').trim();
    try { origin = referer ? new URL(referer).origin : ''; } catch { origin = ''; }
  }
  // Sec-Fetch-Site is a useful browser hint, but embedded/older browsers may
  // omit it. An explicit non-same-origin value always fails; a missing value
  // still has to pass the exact Origin/Referer-to-host comparison below.
  if (!origin || (fetchSite && fetchSite !== 'same-origin')) return false;

  // Forwarded headers are meaningful only behind an explicitly trusted proxy.
  // AgentX does not enable Express trust-proxy by default, so compare against
  // the connection-derived protocol and the actual Host header here.
  const protocol = req.protocol || 'http';
  const host = String(req.get?.('host') || '').split(',')[0].trim();
  return !!host && origin === `${protocol}://${host}`;
}

function hasBrowserRequestSignals(req) {
  // Native Node/Undici fetch sends `Sec-Fetch-Mode: cors` even for CLI and
  // service calls. Mode alone is therefore not browser identity. Origin,
  // Referer, and Sec-Fetch-Site are the signals that require browser CSRF
  // handling.
  return Boolean(
    req.get?.('origin')
    || req.get?.('referer')
    || req.get?.('sec-fetch-site')
  );
}

function operatorAccessAllowed(req, options = {}) {
  if (operatorTokenAllowed(req)) return true;

  const allowLoopback = options.allowLoopback !== false;
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (!allowLoopback || !isLoopbackAddress(ip)) return false;

  // Headerless loopback clients (CLI, health tooling) retain the local product
  // contract. Browser-shaped requests must also prove same-origin so a remote
  // page cannot use the visitor's browser as a loopback operator.
  return !hasBrowserRequestSignals(req) || sameOriginUiAllowed(req);
}

function operatorUiAccessAllowed(req) {
  return operatorAccessAllowed(req) || sameOriginUiAllowed(req);
}

function operatorRequestIdentity(req) {
  if (operatorTokenAllowed(req)) return 'operator-token';
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (isLoopbackAddress(ip)) return 'loopback-operator';
  if (sameOriginUiAllowed(req)) return 'same-origin-ui';
  return 'unauthorized';
}

function requireOperatorAccess(req, res, next) {
  if (operatorAccessAllowed(req)) return next();
  return res.status(403).json({
    error: 'forbidden',
    message: 'loopback or valid operator token required'
  });
}

function requireOperatorUiAccess(req, res, next) {
  if (operatorUiAccessAllowed(req)) return next();
  return res.status(403).json({
    error: 'forbidden',
    message: 'same-origin UI, loopback, or valid operator token required'
  });
}

module.exports = {
  isLoopbackAddress,
  configuredOperatorUiHosts,
  requestHostname,
  operatorUiHostAllowed,
  expectedOperatorToken,
  presentedOperatorToken,
  operatorTokenAllowed,
  operatorAccessAllowed,
  sameOriginUiAllowed,
  hasBrowserRequestSignals,
  operatorUiAccessAllowed,
  operatorRequestIdentity,
  requireOperatorAccess,
  requireOperatorUiAccess
};

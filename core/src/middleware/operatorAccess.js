'use strict';

const crypto = require('crypto');

function isLoopbackAddress(address) {
  const ip = String(address || '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
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

function operatorAccessAllowed(req, options = {}) {
  const allowLoopback = options.allowLoopback !== false;
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  if (allowLoopback && isLoopbackAddress(ip)) return true;

  return operatorTokenAllowed(req);
}

function sameOriginUiAllowed(req) {
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

  const forwardedProto = String(req.get?.('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = String(req.get?.('x-forwarded-host') || req.get?.('host') || '').split(',')[0].trim();
  return !!host && origin === `${protocol}://${host}`;
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
  expectedOperatorToken,
  presentedOperatorToken,
  operatorTokenAllowed,
  operatorAccessAllowed,
  sameOriginUiAllowed,
  operatorUiAccessAllowed,
  operatorRequestIdentity,
  requireOperatorAccess,
  requireOperatorUiAccess
};

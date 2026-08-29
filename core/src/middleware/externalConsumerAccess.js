'use strict';

const crypto = require('crypto');
const {
  operatorAccessAllowed,
  operatorTokenAllowed,
} = require('./operatorAccess');

const TOKEN_HEADER = 'x-agentx-consumer-token';
const EXTERNAL_CONSUMER_BASE_PATH = '/api/consumers/v1';
const NESTOR_CONSUMER_BASE_PATH = '/api/consumers/nestor/v1';
const EXTERNAL_CONSUMER_BASE_PATHS = Object.freeze([
  EXTERNAL_CONSUMER_BASE_PATH,
  NESTOR_CONSUMER_BASE_PATH,
]);

function isExternalConsumerPath(pathname) {
  const path = String(pathname || '').split('?', 1)[0];
  return EXTERNAL_CONSUMER_BASE_PATHS.some((basePath) => (
    path === basePath || path.startsWith(`${basePath}/`)
  ));
}

function expectedExternalConsumerToken() {
  return process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN || '';
}

function presentedExternalConsumerToken(req) {
  const authorization = String(req.get?.('authorization') || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  return req.get?.(TOKEN_HEADER) || bearer || '';
}

function tokensMatch(left, right) {
  const expected = Buffer.from(String(left || ''));
  const presented = Buffer.from(String(right || ''));
  return expected.length === presented.length
    && expected.length > 0
    && crypto.timingSafeEqual(expected, presented);
}

function externalConsumerTokenAllowed(req) {
  return tokensMatch(expectedExternalConsumerToken(), presentedExternalConsumerToken(req));
}

function externalConsumerAccessAllowed(req) {
  if (externalConsumerTokenAllowed(req)) return true;
  // The existing operator credential is an explicit administrative path, not
  // a credential that standalone applications need to hold.
  if (operatorTokenAllowed(req)) return true;
  // Preserves the headerless loopback CLI/demo contract while failing closed
  // for every non-loopback caller when the scoped token is absent or invalid.
  return operatorAccessAllowed(req, { allowLoopback: true });
}

function requireExternalConsumerAccess(req, res, next) {
  if (externalConsumerAccessAllowed(req)) return next();
  return res.status(403).json({
    ok: false,
    status: 'error',
    error: 'forbidden',
    message: 'loopback or a valid external consumer token is required',
    code: 'EXTERNAL_CONSUMER_FORBIDDEN',
  });
}

module.exports = {
  TOKEN_HEADER,
  EXTERNAL_CONSUMER_BASE_PATH,
  EXTERNAL_CONSUMER_BASE_PATHS,
  NESTOR_CONSUMER_BASE_PATH,
  isExternalConsumerPath,
  expectedExternalConsumerToken,
  presentedExternalConsumerToken,
  externalConsumerTokenAllowed,
  externalConsumerAccessAllowed,
  requireExternalConsumerAccess,
};

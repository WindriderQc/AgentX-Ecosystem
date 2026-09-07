'use strict';

// Plain caller attribution for logs and coordination ownership. This is not an
// access control: the platform runs on a private LAN and every caller is
// trusted. Services declare who they are with a non-secret header.
const CALLER_HEADER = 'x-agentx-caller';
const KNOWN_PRINCIPALS = Object.freeze(['operator', 'benchmark-service', 'rag-service', 'runtime-bridge']);

function requestPrincipal(req) {
  const declared = String(req.get?.(CALLER_HEADER) || '').trim();
  return KNOWN_PRINCIPALS.includes(declared) ? declared : 'operator';
}

function isBenchmarkCaller(req) {
  return requestPrincipal(req) === 'benchmark-service';
}

module.exports = { CALLER_HEADER, KNOWN_PRINCIPALS, requestPrincipal, isBenchmarkCaller };

'use strict';

const crypto = require('crypto');
const {
  hasBrowserRequestSignals,
  operatorUiAccessAllowed,
  requestHostname,
} = require('../middleware/operatorAccess');

const LOOPBACK_PUBLISHED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function expectedMcpToken() {
  return String(process.env.AGENTX_MCP_TOKEN || '').trim();
}

function presentedMcpTokens(req) {
  const authorization = String(req.get?.('authorization') || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const header = String(req.get?.('x-agentx-mcp-token') || '').trim();
  return [bearer, header].filter(Boolean);
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

// Purpose-scoped token check. It deliberately fails closed when the token is
// absent; callers that retain a local development fallback must opt in.
function tokenAllowed(req, options = {}) {
  const expected = expectedMcpToken();
  if (!expected) return options.allowUnset === true;
  return presentedMcpTokens(req).some((presented) => tokensMatch(expected, presented));
}

function loopbackPublishedMachineAllowed(req) {
  return LOOPBACK_PUBLISHED_HOSTS.has(requestHostname(req))
    && String(process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI || '').trim().toLowerCase() === 'true'
    && !hasBrowserRequestSignals(req);
}

// The MCP ingress retains the product's trusted local/operator contract while
// every remote non-operator caller must present the purpose-scoped MCP token.
function mcpIngressAllowed(req) {
  return operatorUiAccessAllowed(req)
    || loopbackPublishedMachineAllowed(req)
    || tokenAllowed(req);
}

module.exports = {
  LOOPBACK_PUBLISHED_HOSTS,
  expectedMcpToken,
  presentedMcpTokens,
  tokensMatch,
  tokenAllowed,
  loopbackPublishedMachineAllowed,
  mcpIngressAllowed,
};

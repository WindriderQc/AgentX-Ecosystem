'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const {
  CONNECT_TIME_PEER_VERIFICATION,
} = require('../../../shared/outboundHttpExecutor');
const {
  _internal: { unsafeHostReason },
} = require('./ollamaTargetAdmission');

const AGENT_OPTIONS = Object.freeze({
  keepAlive: false,
  maxSockets: 10,
  scheduling: 'lifo',
});

function transportError(message = 'Outbound peer target rejected') {
  const error = new Error(message);
  error.code = 'OUTBOUND_PEER_TARGET_REJECTED';
  return error;
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.replace(/\.$/, '');
}

function normalizePeerAddress(value) {
  const address = normalizeHostname(value).split('%')[0];
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : address;
}

function normalizeLookupRecords(records) {
  const entries = Array.isArray(records) ? records : [records];
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      return { address: entry, family: entry.includes(':') ? 6 : 4 };
    }
    return { address: entry?.address, family: Number(entry?.family) };
  });
}

function containsAuthorityOverride(headers) {
  if (!headers) return false;
  try {
    if (Array.isArray(headers)) {
      return headers.some((entry) => Array.isArray(entry)
        && ['host', ':authority'].includes(String(entry[0]).toLowerCase()));
    }
    if (typeof headers.forEach === 'function') {
      let found = false;
      headers.forEach((_value, name) => {
        if (['host', ':authority'].includes(String(name).toLowerCase())) found = true;
      });
      return found;
    }
    if (typeof headers === 'object') {
      return Object.keys(headers)
        .some((name) => ['host', ':authority'].includes(name.toLowerCase()));
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Build the lookup callback used by the socket connect itself. DNS answers are
 * never handed back to Node until every answer has passed the same forbidden
 * peer checks as an operator-selected Ollama target. This closes the gap
 * between a preflight DNS check and the address actually used by connect().
 */
function createConnectTimeLookup(
  authorityHostname,
  lookupImpl = dns.lookup,
  onResolved = () => {}
) {
  const expectedHostname = normalizeHostname(authorityHostname);

  return function connectTimeLookup(hostname, options, callback) {
    let lookupOptions = options;
    let done = callback;
    if (typeof options === 'function') {
      done = options;
      lookupOptions = {};
    }

    if (typeof done !== 'function') throw transportError();
    if (normalizeHostname(hostname) !== expectedHostname) {
      done(transportError());
      return;
    }

    const requestedFamily = Number(lookupOptions?.family);
    const resolveOptions = {
      all: true,
      verbatim: true,
      ...(requestedFamily === 4 || requestedFamily === 6 ? { family: requestedFamily } : {}),
      ...(Number.isInteger(lookupOptions?.hints) ? { hints: lookupOptions.hints } : {}),
    };

    try {
      lookupImpl(hostname, resolveOptions, (error, records) => {
        if (error) {
          done(transportError('Outbound peer lookup failed'));
          return;
        }

        const normalized = normalizeLookupRecords(records);
        if (normalized.length === 0 || normalized.some((entry) => (
          !entry.address
          || (entry.family !== 4 && entry.family !== 6)
          || net.isIP(entry.address) !== entry.family
          || unsafeHostReason(entry.address)
        ))) {
          done(transportError());
          return;
        }

        for (const entry of normalized) onResolved(normalizePeerAddress(entry.address));

        if (lookupOptions?.all === true) {
          done(null, normalized);
          return;
        }
        done(null, normalized[0].address, normalized[0].family);
      });
    } catch {
      done(transportError('Outbound peer lookup failed'));
    }
  };
}

function createObservedPeerAgent(authority, { lookupImpl = dns.lookup } = {}) {
  const hostname = normalizeHostname(authority?.hostname);
  const protocol = authority?.protocol;
  if (!hostname || (protocol !== 'http:' && protocol !== 'https:')) {
    throw transportError();
  }

  const directReason = unsafeHostReason(hostname);
  if (directReason) throw transportError();

  const admittedAddresses = new Set();
  const literalFamily = net.isIP(hostname);
  if (literalFamily) admittedAddresses.add(normalizePeerAddress(hostname));

  const options = {
    ...AGENT_OPTIONS,
    lookup: createConnectTimeLookup(
      hostname,
      lookupImpl,
      (address) => admittedAddresses.add(address)
    ),
  };
  const agent = protocol === 'https:'
    ? new https.Agent(options)
    : new http.Agent(options);
  const observedAddresses = new Set();
  const originalCreateConnection = agent.createConnection.bind(agent);
  const readyEvent = protocol === 'https:' ? 'secureConnect' : 'connect';

  agent.createConnection = (connectionOptions, callback) => {
    const socket = originalCreateConnection(connectionOptions, callback);
    const observe = () => {
      const address = normalizePeerAddress(socket?.remoteAddress);
      if (net.isIP(address)) observedAddresses.add(address);
    };
    if (socket && typeof socket.once === 'function') {
      if (socket.connecting === false) observe();
      else socket.once(readyEvent, observe);
    }
    return socket;
  };

  return Object.freeze({ agent, admittedAddresses, observedAddresses });
}

function createPeerVerifyingAgent(authority, options) {
  return createObservedPeerAgent(authority, options).agent;
}

function cancelResponse(response) {
  try {
    if (typeof response?.body?.destroy === 'function') response.body.destroy();
    else if (typeof response?.body?.cancel === 'function') void response.body.cancel();
  } catch {
    // The shared executor also performs best-effort response cancellation.
  }
}

function destroyAgentAfterBody(agent, body) {
  if (!body || typeof body.once !== 'function' || body.destroyed || body.readableEnded) {
    agent.destroy();
    return;
  }
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    agent.destroy();
  };
  body.once('end', destroy);
  body.once('close', destroy);
  body.once('error', destroy);
}

/**
 * Shared-executor transport for Benchmark. The runtime implementation is
 * deliberately node-fetch: unlike global fetch it accepts a Node Agent whose
 * lookup callback controls the address used by the socket connection.
 */
function createNodeFetchPeerTransport({ lookupImpl = dns.lookup } = {}) {
  if (typeof lookupImpl !== 'function') {
    throw new TypeError('Benchmark outbound transport dependencies are invalid.');
  }

  return async function nodeFetchPeerTransport({ authority, fetchImpl, init, target }) {
    if (typeof fetchImpl !== 'function') throw transportError();
    if (containsAuthorityOverride(init?.headers)) throw transportError();
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw transportError();
    }

    if (parsed.origin !== authority?.expectedOrigin
      || normalizeHostname(parsed.hostname) !== normalizeHostname(authority?.hostname)
      || parsed.protocol !== authority?.protocol) {
      throw transportError();
    }

    const observed = createObservedPeerAgent(authority, { lookupImpl });
    try {
      const response = await fetchImpl(parsed.href, { ...init, agent: observed.agent });
      const connectedPeers = [...observed.observedAddresses];
      if (connectedPeers.length === 0
        || connectedPeers.some((address) => !observed.admittedAddresses.has(address))) {
        cancelResponse(response);
        observed.agent.destroy();
        throw transportError('Outbound connected peer could not be verified');
      }
      destroyAgentAfterBody(observed.agent, response?.body);
      return {
        response,
        peerVerification: CONNECT_TIME_PEER_VERIFICATION,
      };
    } catch (error) {
      observed.agent.destroy();
      throw error;
    }
  };
}

module.exports = {
  createNodeFetchPeerTransport,
  _internal: {
    createConnectTimeLookup,
    createObservedPeerAgent,
    createPeerVerifyingAgent,
    containsAuthorityOverride,
    normalizeHostname,
    normalizeLookupRecords,
    normalizePeerAddress,
  },
};

'use strict';

/**
 * node-fetch transport for the shared outbound executor.
 *
 * The target is resolved once, the resulting addresses are injected through a
 * request-local Agent lookup, and the address reported by the connected socket
 * is checked before the transport emits the shared executor's attestation.
 * Merely resolving a name before an ordinary fetch is intentionally not enough.
 */

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const {
  CONNECT_TIME_PEER_VERIFICATION,
} = require('../../../shared/outboundHttpExecutor');

function normalizedHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function normalizedAddress(value) {
  const address = normalizedHostname(value).split('%')[0];
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : address;
}

function addressFamily(address) {
  const family = net.isIP(normalizedAddress(address));
  return family === 4 || family === 6 ? family : 0;
}

async function resolvePinnedAddresses(hostname, lookup = dns.lookup) {
  const normalized = normalizedHostname(hostname);
  const literalFamily = addressFamily(normalized);
  if (literalFamily) {
    return Object.freeze([{ address: normalizedAddress(normalized), family: literalFamily }]);
  }

  let resolved;
  try {
    resolved = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error('Outbound peer resolution failed.');
  }

  const unique = new Map();
  for (const entry of Array.isArray(resolved) ? resolved : []) {
    const address = normalizedAddress(entry?.address);
    const family = Number(entry?.family) || addressFamily(address);
    if ((family === 4 || family === 6) && addressFamily(address) === family) {
      unique.set(`${family}:${address}`, Object.freeze({ address, family }));
    }
  }
  if (unique.size === 0) throw new Error('Outbound peer resolution failed.');
  return Object.freeze([...unique.values()]);
}

function createPinnedLookup(expectedHostname, addresses) {
  const expected = normalizedHostname(expectedHostname);
  return (hostname, options, callback) => {
    let lookupOptions = options;
    let done = callback;
    if (typeof lookupOptions === 'function') {
      done = lookupOptions;
      lookupOptions = {};
    } else if (typeof lookupOptions === 'number') {
      lookupOptions = { family: lookupOptions };
    }

    if (typeof done !== 'function' || normalizedHostname(hostname) !== expected) {
      const error = new Error('Outbound peer lookup was rejected.');
      if (typeof done === 'function') process.nextTick(done, error);
      return;
    }

    const requestedFamily = Number(lookupOptions?.family) || 0;
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      process.nextTick(done, new Error('Outbound peer lookup was rejected.'));
      return;
    }

    if (lookupOptions?.all === true) {
      process.nextTick(done, null, eligible.map((entry) => ({ ...entry })));
      return;
    }
    process.nextTick(done, null, eligible[0].address, eligible[0].family);
  };
}

function createObservedAgent(protocol, hostname, addresses) {
  const Agent = protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: false,
    lookup: createPinnedLookup(hostname, addresses),
  });
  const observedAddresses = new Set();
  const originalCreateConnection = agent.createConnection.bind(agent);

  agent.createConnection = (options, callback) => {
    const socket = originalCreateConnection(options, callback);
    const observe = () => {
      const address = normalizedAddress(socket?.remoteAddress);
      if (addressFamily(address)) observedAddresses.add(address);
    };
    if (socket && typeof socket.once === 'function') {
      if (socket.connecting === false) observe();
      else socket.once('connect', observe);
    }
    return socket;
  };

  return { agent, observedAddresses };
}

function cancelResponse(response) {
  try {
    if (typeof response?.body?.destroy === 'function') response.body.destroy();
    else if (typeof response?.body?.cancel === 'function') void response.body.cancel();
  } catch {
    // The shared executor will also attempt best-effort cancellation.
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

function createPeerVerifiedNodeFetchTransport({ lookup = dns.lookup } = {}) {
  if (typeof lookup !== 'function') throw new TypeError('lookup must be a function');

  return async ({ authority, fetchImpl, init, target }) => {
    const url = new URL(target);
    if (!authority
      || url.origin !== authority.expectedOrigin
      || url.protocol !== authority.protocol
      || normalizedHostname(url.hostname) !== normalizedHostname(authority.hostname)) {
      throw new Error('Outbound transport authority mismatch.');
    }

    const addresses = await resolvePinnedAddresses(url.hostname, lookup);
    const pinned = new Set(addresses.map((entry) => normalizedAddress(entry.address)));
    const { agent, observedAddresses } = createObservedAgent(
      url.protocol,
      url.hostname,
      addresses
    );

    let response;
    try {
      response = await fetchImpl(target, { ...init, agent });
      const connectedPeers = [...observedAddresses];
      if (connectedPeers.length === 0
        || connectedPeers.some((address) => !pinned.has(normalizedAddress(address)))) {
        cancelResponse(response);
        agent.destroy();
        throw new Error('Outbound connected peer could not be verified.');
      }
      destroyAgentAfterBody(agent, response?.body);
      return {
        response,
        peerVerification: CONNECT_TIME_PEER_VERIFICATION,
      };
    } catch (error) {
      agent.destroy();
      throw error;
    }
  };
}

const peerVerifiedNodeFetchTransport = createPeerVerifiedNodeFetchTransport();

module.exports = {
  createPeerVerifiedNodeFetchTransport,
  peerVerifiedNodeFetchTransport,
  resolvePinnedAddresses,
};

'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const nodeFetch = require('node-fetch');

const {
  CONNECT_TIME_PEER_VERIFICATION,
  createOutboundHttpExecutor,
  discardBoundedResponse,
  readBoundedBytes,
  readBoundedJson,
} = require('../../../shared/outboundHttpExecutor');

const CORE_OUTBOUND_OPERATION_IDS = Object.freeze({
  MODEL_CATALOG: 'rag.app.core-models',
  PLATFORM_EVENT: 'rag.buddy-event.deliver',
  PUBLIC_URLS_CONFIG: 'rag.public-urls.config',
});

const CORE_OUTBOUND_OPERATIONS = Object.freeze({
  [CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG]: Object.freeze({
    authoritySource: 'configured',
    deadlineMs: 10_000,
    maxRequestBytes: 0,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  [CORE_OUTBOUND_OPERATION_IDS.PLATFORM_EVENT]: Object.freeze({
    authoritySource: 'configured',
    deadlineMs: 5_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
  }),
  [CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG]: Object.freeze({
    authoritySource: 'configured',
    deadlineMs: 2_000,
    maxRequestBytes: 0,
    maxResponseBytes: 65_536,
  }),
});

const CORE_OUTBOUND_REQUEST_SPECS = Object.freeze({
  [CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG]: Object.freeze({
    allowSearch: true,
    method: 'GET',
    pathname: '/api/models/all',
  }),
  [CORE_OUTBOUND_OPERATION_IDS.PLATFORM_EVENT]: Object.freeze({
    allowSearch: false,
    method: 'POST',
    pathname: '/api/platform-events',
  }),
  [CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG]: Object.freeze({
    allowSearch: false,
    method: 'GET',
    pathname: '/api/config',
  }),
});

const FORBIDDEN_TRANSPORT_HEADERS = new Set([
  ':authority',
  'connection',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
]);

function configuredCoreBaseUrl(value = process.env.CORE_URL || process.env.CORE_PROXY_URL) {
  let parsed;
  try {
    parsed = new URL(String(value || 'http://localhost:3080').trim());
  } catch {
    throw new TypeError('Configured Core URL must be an HTTP(S) origin.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw new TypeError('Configured Core URL must be an HTTP(S) origin.');
  }
  return parsed.origin;
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.replace(/\.$/, '');
}

function normalizeIpAddress(value) {
  const address = normalizeHostname(value).split('%', 1)[0];
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) {
    return address.slice(7);
  }
  return address;
}

function normalizeLookupRecords(records) {
  const entries = Array.isArray(records) ? records : [records];
  return entries.map((entry) => {
    if (typeof entry === 'string') {
      return { address: entry, family: net.isIP(normalizeHostname(entry)) };
    }
    return { address: entry?.address, family: Number(entry?.family) };
  });
}

function createConnectTimeLookup(authorityHostname, lookupImpl = dns.lookup, onResolved = () => {}) {
  const expectedHostname = normalizeHostname(authorityHostname);
  const literalFamily = net.isIP(expectedHostname);

  return function connectTimeLookup(hostname, options, callback) {
    let lookupOptions = options;
    let done = callback;
    if (typeof options === 'function') {
      done = options;
      lookupOptions = {};
    }
    if (typeof done !== 'function') throw new Error('Outbound transport lookup callback is invalid.');
    if (normalizeHostname(hostname) !== expectedHostname) {
      done(new Error('Outbound transport requested an unexpected hostname.'));
      return;
    }

    const complete = (records) => {
      const normalized = normalizeLookupRecords(records);
      if (normalized.length === 0 || normalized.some((entry) => {
        const address = normalizeHostname(entry.address).split('%', 1)[0];
        return !address || net.isIP(address) !== entry.family;
      })) {
        done(new Error('Configured Core authority did not resolve to valid IP addresses.'));
        return;
      }
      for (const entry of normalized) onResolved(normalizeIpAddress(entry.address));
      if (lookupOptions?.all === true) {
        done(null, normalized);
        return;
      }
      done(null, normalized[0].address, normalized[0].family);
    };

    if (literalFamily) {
      complete([{ address: expectedHostname, family: literalFamily }]);
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
      lookupImpl(expectedHostname, resolveOptions, (error, records) => {
        if (error) {
          done(new Error('Configured Core authority DNS lookup failed.'));
          return;
        }
        complete(records);
      });
    } catch {
      done(new Error('Configured Core authority DNS lookup failed.'));
    }
  };
}

function createObservedPeerAgent(authority, { lookupImpl = dns.lookup } = {}) {
  const hostname = normalizeHostname(authority?.hostname);
  const protocol = authority?.protocol;
  if (!hostname || (protocol !== 'http:' && protocol !== 'https:')) {
    throw new Error('Outbound Core authority is invalid.');
  }

  const admittedAddresses = new Set();
  const literalFamily = net.isIP(hostname);
  if (literalFamily) admittedAddresses.add(normalizeIpAddress(hostname));
  const Agent = protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({
    autoSelectFamily: true,
    keepAlive: false,
    lookup: createConnectTimeLookup(
      hostname,
      lookupImpl,
      (address) => admittedAddresses.add(address)
    ),
  });
  const observedAddresses = new Set();
  const createConnection = agent.createConnection.bind(agent);
  const readyEvent = protocol === 'https:' ? 'secureConnect' : 'connect';
  agent.createConnection = (options, callback) => {
    const socket = createConnection(options, callback);
    const observe = () => {
      const address = normalizeIpAddress(socket?.remoteAddress);
      if (net.isIP(address)) observedAddresses.add(address);
    };
    if (socket?.connecting === false) observe();
    else socket?.once?.(readyEvent, observe);
    return socket;
  };
  return Object.freeze({ admittedAddresses, agent, observedAddresses });
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

function hasForbiddenTransportHeaders(headers) {
  if (headers === undefined || headers === null) return false;
  try {
    const entries = Array.isArray(headers)
      ? headers
      : typeof headers[Symbol.iterator] === 'function'
        ? [...headers]
        : Object.entries(headers);
    return entries.some((entry) => Array.isArray(entry)
      && FORBIDDEN_TRANSPORT_HEADERS.has(String(entry[0]).trim().toLowerCase()));
  } catch {
    return true;
  }
}

function createPinnedNodeFetchTransport({ lookup = dns.lookup } = {}) {
  if (typeof lookup !== 'function') {
    throw new TypeError('RAG outbound transport dependencies are invalid.');
  }
  return async ({ authority, fetchImpl, init, target }) => {
    if (hasForbiddenTransportHeaders(init?.headers)) {
      throw new Error('Outbound Core transport headers are invalid.');
    }
    const parsed = new URL(target);
    if (parsed.origin !== authority?.expectedOrigin
      || parsed.protocol !== authority?.protocol
      || normalizeHostname(parsed.hostname) !== normalizeHostname(authority?.hostname)) {
      throw new Error('Outbound Core target does not match its admitted authority.');
    }
    const observed = createObservedPeerAgent(authority, { lookupImpl: lookup });
    try {
      const response = await fetchImpl(parsed.href, { ...init, agent: observed.agent });
      const connectedPeers = [...observed.observedAddresses];
      if (connectedPeers.length === 0
        || connectedPeers.some((address) => !observed.admittedAddresses.has(address))) {
        cancelResponse(response);
        observed.agent.destroy();
        throw new Error('Outbound Core connected peer could not be verified.');
      }
      destroyAgentAfterBody(observed.agent, response?.body);
      return Object.freeze({
        peerVerification: CONNECT_TIME_PEER_VERIFICATION,
        response,
      });
    } catch (error) {
      observed.agent.destroy();
      throw error;
    }
  };
}

function createConfiguredCoreAuthorityAdapter(coreOrigin) {
  return ({ sinkId, target }) => {
    const requestSpec = CORE_OUTBOUND_REQUEST_SPECS[sinkId];
    const parsed = new URL(target);
    if (!requestSpec
      || parsed.origin !== coreOrigin
      || parsed.pathname !== requestSpec.pathname
      || parsed.hash
      || (!requestSpec.allowSearch && parsed.search)) {
      throw new Error('Outbound target does not match the configured Core authority.');
    }
    return Object.freeze({ expectedOrigin: coreOrigin });
  };
}

function createCoreOutboundClient(options = {}) {
  const baseUrl = configuredCoreBaseUrl(options.coreUrl);
  const coreOrigin = baseUrl;
  const executor = createOutboundHttpExecutor({
    authorityAdapter: options.authorityAdapter || createConfiguredCoreAuthorityAdapter(coreOrigin),
    fetchImpl: options.fetchImpl || nodeFetch,
    operations: options.operations || CORE_OUTBOUND_OPERATIONS,
    transportAdapter: options.transportAdapter || createPinnedNodeFetchTransport({
      lookup: options.lookup,
    }),
  });

  async function execute(sinkId, { query = '', requestOptions = {} } = {}) {
    const requestSpec = CORE_OUTBOUND_REQUEST_SPECS[sinkId];
    if (!requestSpec) throw new TypeError('Outbound Core operation is not registered.');
    const method = String(requestOptions.method || 'GET').toUpperCase();
    if (method !== requestSpec.method
      || typeof query !== 'string'
      || (query && (!requestSpec.allowSearch || !query.startsWith('?')))) {
      throw new TypeError('Outbound Core operation does not match its closed request specification.');
    }
    const target = new URL(`${requestSpec.pathname}${query}`, `${baseUrl}/`);
    if (target.origin !== coreOrigin
      || target.pathname !== requestSpec.pathname
      || target.hash) {
      throw new TypeError('Outbound Core operation does not match its closed request specification.');
    }
    const admission = await executor.admitTarget(sinkId, target, {
      signal: requestOptions?.signal,
    });
    return executor.request(admission, requestOptions);
  }

  return Object.freeze({
    async getPublicUrlsConfig({ signal } = {}) {
      const response = await execute(
        CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG,
        { requestOptions: { headers: { Accept: 'application/json' }, signal } }
      );
      const payload = await readBoundedJson(response);
      return Object.freeze({ ok: response.ok, payload, status: response.status });
    },

    async getModelCatalog({ accept = 'application/json', operatorToken, query = '', signal } = {}) {
      const headers = { Accept: accept };
      if (operatorToken) headers['X-AgentX-Operator-Token'] = operatorToken;
      const response = await execute(
        CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG,
        { query, requestOptions: { headers, signal } }
      );
      const body = await readBoundedBytes(response);
      return Object.freeze({ body, headers: response.headers, status: response.status });
    },

    async deliverPlatformEvent({ body, token, signal } = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Platform-Event-Token'] = token;
      const response = await execute(
        CORE_OUTBOUND_OPERATION_IDS.PLATFORM_EVENT,
        { requestOptions: { body, headers, method: 'POST', signal } }
      );
      await discardBoundedResponse(response);
      return Object.freeze({ ok: response.ok, status: response.status });
    },
  });
}

function createCorePublicUrlsConfigLoader(options = {}) {
  const coreOutboundClient = options.coreOutboundClient || createCoreOutboundClient({
    ...options,
    coreUrl: configuredCoreBaseUrl(options.coreUrl),
  });

  return async function loadCorePublicUrlsConfig(requestOptions = {}) {
    const result = await coreOutboundClient.getPublicUrlsConfig({
      signal: requestOptions.signal,
    });
    if (!result.ok) {
      throw new Error(`Core public URL authority returned HTTP ${result.status}`);
    }
    return result.payload;
  };
}

module.exports = {
  CORE_OUTBOUND_OPERATIONS,
  CORE_OUTBOUND_OPERATION_IDS,
  CORE_OUTBOUND_REQUEST_SPECS,
  configuredCoreBaseUrl,
  createConfiguredCoreAuthorityAdapter,
  createCoreOutboundClient,
  createCorePublicUrlsConfigLoader,
  createPinnedNodeFetchTransport,
  createConnectTimeLookup,
  createObservedPeerAgent,
  normalizeIpAddress,
  normalizeHostname,
  normalizeLookupRecords,
  hasForbiddenTransportHeaders,
};

'use strict';

const http = require('node:http');
const https = require('node:https');
const nodeFetch = require('node-fetch');
const {
  CONNECT_TIME_PEER_VERIFICATION,
} = require('../../../shared/outboundHttpExecutor');
const {
  createNodeFetchPeerTransport,
  _internal: {
    createConnectTimeLookup,
    createPeerVerifyingAgent,
  },
} = require('../../src/helpers/outboundHttpTransport');

function runLookup(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Benchmark connect-time outbound transport', () => {
  test('returns only a safe DNS answer from the lookup used by socket connect', async () => {
    let observedOptions;
    const lookup = createConnectTimeLookup('core.internal', (hostname, options, callback) => {
      observedOptions = { hostname, options };
      callback(null, [
        { address: '10.20.30.40', family: 4 },
        { address: 'fd00::20', family: 6 },
      ]);
    });

    await expect(runLookup(lookup, 'core.internal')).resolves.toEqual({
      address: '10.20.30.40',
      family: 4,
    });
    expect(observedOptions).toEqual({
      hostname: 'core.internal',
      options: { all: true, verbatim: true },
    });
  });

  test.each([
    ['a mismatched hostname', 'other.internal', [{ address: '10.20.30.40', family: 4 }]],
    ['a metadata answer', 'core.internal', [{ address: '169.254.169.254', family: 4 }]],
    ['a mixed safe/unsafe answer', 'core.internal', [
      { address: '10.20.30.40', family: 4 },
      { address: 'fe80::1', family: 6 },
    ]],
    ['an invalid answer', 'core.internal', [{ address: 'not-an-ip', family: 4 }]],
  ])('rejects %s before connect', async (_label, hostname, records) => {
    const lookup = createConnectTimeLookup('core.internal', (_host, _options, callback) => {
      callback(null, records);
    });
    await expect(runLookup(lookup, hostname)).rejects.toMatchObject({
      code: 'OUTBOUND_PEER_TARGET_REJECTED',
    });
  });

  test('builds protocol-specific agents and rejects forbidden literal peers', () => {
    expect(createPeerVerifyingAgent({ hostname: '127.0.0.1', protocol: 'http:' }))
      .toBeInstanceOf(http.Agent);
    expect(createPeerVerifyingAgent({ hostname: 'core.internal', protocol: 'https:' }))
      .toBeInstanceOf(https.Agent);
    expect(() => createPeerVerifyingAgent({ hostname: '169.254.169.254', protocol: 'http:' }))
      .toThrow('Outbound peer target rejected');
    expect(() => createPeerVerifyingAgent({ hostname: 'metadata.google.internal', protocol: 'http:' }))
      .toThrow('Outbound peer target rejected');
  });

  test('refuses to attest a fetch implementation that does not expose a connected socket', async () => {
    const response = { status: 200 };
    const fetchImpl = jest.fn(async () => response);
    const transport = createNodeFetchPeerTransport();
    const authority = {
      expectedOrigin: 'http://core.internal:3080',
      hostname: 'core.internal',
      protocol: 'http:',
    };

    await expect(transport({
      authority,
      fetchImpl,
      init: { method: 'GET', redirect: 'manual' },
      target: 'http://core.internal:3080/api/models/registry',
    })).rejects.toMatchObject({ code: 'OUTBOUND_PEER_TARGET_REJECTED' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://core.internal:3080/api/models/registry',
      expect.objectContaining({ agent: expect.any(http.Agent), redirect: 'manual' })
    );

    await expect(transport({
      authority,
      fetchImpl,
      init: { method: 'GET' },
      target: 'http://other.internal:3080/api/models/registry',
    })).rejects.toMatchObject({ code: 'OUTBOUND_PEER_TARGET_REJECTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    { Host: 'attacker.invalid' },
    [[':authority', 'attacker.invalid']],
    new Headers({ host: 'attacker.invalid' }),
  ])('rejects a caller-authored authority header before transport dispatch', async (headers) => {
    const fetchImpl = jest.fn();
    const transport = createNodeFetchPeerTransport();
    await expect(transport({
      authority: {
        expectedOrigin: 'http://core.internal:3080',
        hostname: 'core.internal',
        protocol: 'http:',
      },
      fetchImpl,
      init: { headers, method: 'GET' },
      target: 'http://core.internal:3080/api/config',
    })).rejects.toMatchObject({ code: 'OUTBOUND_PEER_TARGET_REJECTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('uses the guarded lookup on the actual node-fetch socket connection', async () => {
    const observed = [];
    const server = http.createServer((request, response) => {
      observed.push({ host: request.headers.host, path: request.url });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
    });
    const address = await listen(server);

    try {
      const lookupImpl = jest.fn((hostname, options, callback) => {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      });
      const transport = createNodeFetchPeerTransport({ lookupImpl });
      const expectedOrigin = `http://core.internal:${address.port}`;
      const result = await transport({
        authority: {
          expectedOrigin,
          hostname: 'core.internal',
          protocol: 'http:',
        },
        fetchImpl: nodeFetch,
        init: { method: 'GET', redirect: 'manual' },
        target: `${expectedOrigin}/api/models/registry`,
      });

      expect(result.peerVerification).toBe(CONNECT_TIME_PEER_VERIFICATION);
      await expect(result.response.json()).resolves.toEqual({ status: 'ok' });
      expect(lookupImpl).toHaveBeenCalledWith(
        'core.internal',
        expect.objectContaining({ all: true, verbatim: true }),
        expect.any(Function)
      );
      expect(observed).toEqual([{
        host: `core.internal:${address.port}`,
        path: '/api/models/registry',
      }]);
    } finally {
      await close(server);
    }
  });
});

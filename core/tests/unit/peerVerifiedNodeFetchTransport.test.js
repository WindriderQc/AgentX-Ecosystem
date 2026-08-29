'use strict';

const http = require('node:http');
const nodeFetch = require('node-fetch');
const {
  CONNECT_TIME_PEER_VERIFICATION,
} = require('../../../shared/outboundHttpExecutor');
const {
  createPeerVerifiedNodeFetchTransport,
  resolvePinnedAddresses,
} = require('../../src/helpers/peerVerifiedNodeFetchTransport');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function authorityFor(target) {
  const url = new URL(target);
  return Object.freeze({
    authoritySource: 'canonical',
    expectedOrigin: url.origin,
    hostname: url.hostname,
    port: url.port,
    protocol: url.protocol,
    sinkId: 'core.mcp.loopback-budget',
  });
}

describe('peerVerifiedNodeFetchTransport', () => {
  test('pins a literal target and attests only after observing its connected socket', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const target = `http://127.0.0.1:${port}/health`;

    try {
      const transport = createPeerVerifiedNodeFetchTransport();
      const result = await transport({
        authority: authorityFor(target),
        fetchImpl: nodeFetch,
        init: { method: 'GET', redirect: 'manual' },
        target,
      });

      expect(result.peerVerification).toBe(CONNECT_TIME_PEER_VERIFICATION);
      expect(result.response.status).toBe(200);
      await expect(result.response.json()).resolves.toEqual({ ok: true });
    } finally {
      await close(server);
    }
  });

  test('uses the reviewed DNS result for the connection and verifies the actual peer', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const target = `http://service.internal:${port}/health`;
    const lookup = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);

    try {
      const transport = createPeerVerifiedNodeFetchTransport({ lookup });
      const result = await transport({
        authority: authorityFor(target),
        fetchImpl: nodeFetch,
        init: { method: 'GET', redirect: 'manual' },
        target,
      });

      expect(result.peerVerification).toBe(CONNECT_TIME_PEER_VERIFICATION);
      expect(result.response.status).toBe(204);
      expect(lookup).toHaveBeenCalledWith('service.internal', { all: true, verbatim: true });
    } finally {
      await close(server);
    }
  });

  test('refuses to attest when the fetch implementation exposes no connected socket', async () => {
    const target = 'http://127.0.0.1:3080/health';
    const body = { destroy: jest.fn() };
    const transport = createPeerVerifiedNodeFetchTransport();

    await expect(transport({
      authority: authorityFor(target),
      fetchImpl: jest.fn(async () => ({ body })),
      init: { method: 'GET', redirect: 'manual' },
      target,
    })).rejects.toThrow('connected peer could not be verified');
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  test('deduplicates and validates resolver results before they can be pinned', async () => {
    const lookup = jest.fn(async () => [
      { address: '192.0.2.10', family: 4 },
      { address: '192.0.2.10', family: 4 },
      { address: 'not-an-address', family: 4 },
    ]);

    await expect(resolvePinnedAddresses('service.internal', lookup)).resolves.toEqual([
      { address: '192.0.2.10', family: 4 },
    ]);
    expect(lookup).toHaveBeenCalledWith('service.internal', { all: true, verbatim: true });
  });
});

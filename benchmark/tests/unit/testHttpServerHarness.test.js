'use strict';

const request = require('supertest');
const {
  startTestHttpServer,
  closeTestHttpServer,
  startTestHttpHarness
} = require('../helpers/testHttpServer');

describe('test HTTP server harness', () => {
  let server;

  afterEach(async () => {
    await closeTestHttpServer(server);
    server = undefined;
  });

  it('awaits one IPv4 loopback listener and reuses its ephemeral port', async () => {
    const remotePorts = [];
    const harness = await startTestHttpHarness((req, response) => {
      remotePorts.push(req.socket.remotePort);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ localPort: req.socket.localPort }));
    });
    server = harness.server;

    const address = server.address();
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(address.port).toBeGreaterThan(0);

    const first = await harness.request.get('/first').expect(200);
    const second = await harness.request.get('/second').expect(200);

    expect(first.body.localPort).toBe(address.port);
    expect(second.body.localPort).toBe(address.port);
    expect(remotePorts).toHaveLength(2);
    expect(remotePorts[1]).toBe(remotePorts[0]);

    await harness.close();
    expect(server.listening).toBe(false);
    await expect(harness.close()).resolves.toBeUndefined();
    server = undefined;
  });

  it('closes exactly and permits idempotent cleanup', async () => {
    server = await startTestHttpServer((_req, response) => response.end('ok'));

    await closeTestHttpServer(server);
    expect(server.listening).toBe(false);
    await expect(closeTestHttpServer(server)).resolves.toBeUndefined();
  });

  it('rejects non-handler inputs before allocating a listener', async () => {
    await expect(startTestHttpServer(null)).rejects.toThrow(TypeError);
  });
});

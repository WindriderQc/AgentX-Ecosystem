'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { listenLoopback } = require('./listenLoopback');
function failedSocket() {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setTimeout = (_ms, callback) => { process.nextTick(callback); return socket; };
  return socket;
}
test('rebinds an unreachable listener before dispatching any HTTP request', async t => {
  const realConnect = net.connect;
  let probes = 0;
  let requests = 0;
  t.mock.method(net, 'connect', (...args) => ++probes === 1 ? failedSocket() : realConnect(...args));
  const server = http.createServer((_req, res) => { requests++; res.end('ok'); });
  try {
    const address = await listenLoopback(server);
    assert.equal(probes, 2);
    assert.equal(requests, 0);
    assert.equal(server.address().port, address.port);
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${address.port}`, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.equal(body, 'ok');
    assert.equal(requests, 1);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
test('fails with a closed server when no listener is connectable', async t => {
  t.mock.method(net, 'connect', failedSocket);
  const server = http.createServer();
  await assert.rejects(listenLoopback(server), /after 5 attempts/);
  assert.equal(server.listening, false);
});

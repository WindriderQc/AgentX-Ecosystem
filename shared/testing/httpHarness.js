'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');

const { listenLoopback } = require('./listenLoopback');

/**
 * Start one deterministic loopback listener for a Supertest suite.
 *
 * Passing an Express function directly to Supertest makes Supertest create and
 * destroy a new `listen(0)` server for every request. Superagent also opts out
 * of client connection pooling by default. On Windows, a long serial suite can
 * intermittently time out while cycling both sides of those loopback sockets.
 * Owning the listener here also lets the suite await `listening` before its
 * first request.
 */
async function startTestHttpServer(app, { transport = 'tcp' } = {}) {
  if (typeof app !== 'function') {
    throw new TypeError('startTestHttpServer requires an Express-compatible request handler');
  }

  const server = http.createServer(app);
  // Suite-owned pooled sockets live until explicit teardown. A slow database
  // operation must not leave another pooled socket racing a five-second FIN.
  server.keepAliveTimeout = 0;

  if (transport === 'pipe') {
    if (process.platform !== 'win32') throw new Error('Named-pipe test transport requires Windows');
    await new Promise((resolve, reject) => {
      const onError = err => { server.off('listening', onReady); reject(err); };
      const onReady = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onReady);
      server.listen(`//./pipe/agentx-test-${randomUUID()}`);
    });
  } else {
    await listenLoopback(server);
  }

  return server;
}

async function closeTestHttpServer(server) {
  if (!server || !server.listening) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });

    // Every request is awaited before suite teardown. These calls make leaked
    // keep-alive sockets deterministic instead of leaving Jest to force-exit.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function createTestHttpRequester(server, supertest, { maxSockets = 1, headers = {} } = {}) {
  if (!server?.listening) {
    throw new TypeError('createTestHttpRequester requires a listening HTTP server');
  }

  // Superagent deliberately sets `agent: false` by default, so even a shared
  // server otherwise creates a new loopback TCP connection for every request.
  // Reuse one connection per suite to avoid transient Windows loopback stalls.
  const socketAgent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
  const address = server.address();
  const rawRequester = supertest(typeof address === 'string'
    ? `http+unix://${address.replaceAll('/', '%2F')}` : server);
  const requester = {};

  for (const [method, makeRequest] of Object.entries(rawRequester)) {
    requester[method] = (...args) => makeRequest(...args).agent(socketAgent).set(headers);
  }

  return {
    request: requester,
    destroy() {
      socketAgent.destroy();
    }
  };
}

async function startTestHttpHarness(app, supertest, options) {
  const server = await startTestHttpServer(app, options);
  const requester = createTestHttpRequester(server, supertest, options);
  let closePromise;

  return {
    server,
    request: requester.request,
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          requester.destroy();
          await closeTestHttpServer(server);
        })();
      }
      return closePromise;
    }
  };
}

module.exports = {
  startTestHttpServer,
  closeTestHttpServer,
  createTestHttpRequester,
  startTestHttpHarness
};

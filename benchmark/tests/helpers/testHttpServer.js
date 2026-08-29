'use strict';

const http = require('node:http');
const supertest = require('supertest');

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
async function startTestHttpServer(app) {
  if (typeof app !== 'function') {
    throw new TypeError('startTestHttpServer requires an Express-compatible request handler');
  }

  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });

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

function createTestHttpRequester(server) {
  if (!server?.listening) {
    throw new TypeError('createTestHttpRequester requires a listening HTTP server');
  }

  // Superagent deliberately sets `agent: false` by default, so even a shared
  // server otherwise creates a new loopback TCP connection for every request.
  // Reuse one connection per suite to avoid transient Windows loopback stalls.
  const socketAgent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const rawRequester = supertest(server);
  const requester = {};

  for (const [method, makeRequest] of Object.entries(rawRequester)) {
    requester[method] = (...args) => makeRequest(...args).agent(socketAgent);
  }

  return {
    request: requester,
    destroy() {
      socketAgent.destroy();
    }
  };
}

async function startTestHttpHarness(app) {
  const server = await startTestHttpServer(app);
  const requester = createTestHttpRequester(server);
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

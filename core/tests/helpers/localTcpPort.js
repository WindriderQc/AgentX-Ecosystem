const net = require('net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 1000;
const nextPortByRange = new Map();

function getPortOrder(start, end) {
  const key = `${start}-${end}`;
  const nextPort = nextPortByRange.get(key) || start;
  const ports = [];

  for (let port = nextPort; port <= end; port += 1) {
    ports.push(port);
  }
  for (let port = start; port < nextPort; port += 1) {
    ports.push(port);
  }

  return ports;
}

function markPortUsed(start, end, port) {
  const key = `${start}-${end}`;
  nextPortByRange.set(key, port >= end ? start : port + 1);
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
}

function waitForListen(server, options) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = err => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options);
  });
}

function probeTcpConnect(port, { host = DEFAULT_HOST, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function canAcceptConnection(port, { host = DEFAULT_HOST, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const server = net.createServer(socket => {
    socket.end();
  });

  try {
    await waitForListen(server, { host, port, exclusive: true });
    return await probeTcpConnect(port, { host, timeoutMs });
  } catch {
    return false;
  } finally {
    await closeServer(server);
  }
}

async function findConnectablePort({
  start,
  end,
  host = DEFAULT_HOST,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`Invalid port range: ${start}-${end}`);
  }

  for (const port of getPortOrder(start, end)) {
    if (await canAcceptConnection(port, { host, timeoutMs })) {
      markPortUsed(start, end, port);
      return port;
    }
  }

  throw new Error(`No connectable localhost port found in range ${start}-${end}`);
}

module.exports = {
  findConnectablePort
};

'use strict';
const net = require('node:net');
function probe(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(400, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
function bind(server, port) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}
async function listenLoopback(server) {
  // Some Windows loopback ports accept listen() but time out on connect().
  // Verify the retained listener before any application request is dispatched.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Use a bounded listener range on Windows instead of its machine-wide
      // dynamic allocation. Binding remains exclusive and collision-safe.
      const port = process.platform === 'win32' || attempt > 0
        ? 38000 + Math.floor(Math.random() * 10000) : 0;
      await bind(server, port);
      if (await probe(server.address().port)) return server.address();
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
    }
    if (server.listening) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    }
  }
  throw new Error('Test HTTP listener could not accept a loopback connection after 5 attempts');
}
module.exports = { listenLoopback };

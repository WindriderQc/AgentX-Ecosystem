'use strict';

// Real child process and watchdog; only external peers/Mongo are simulated.
const { Readable } = require('node:stream');
const phase = process.argv[2];
process.env.WATCHDOG_INTERVAL_MS = phase === 'before-tick' ? '500' : '40';
const events = [];
const event = name => { events.push(name); process.send?.({ event: name }); };
const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
let databaseOpen = true;
stub('../../config/logger', { info() {}, warn() {}, error() {}, debug() {} });
stub('../../src/helpers/ollamaHostConfig', {
  getConfiguredHosts: () => [1, 2].map(id => ({
    id: String(id), name: `Fixture ${id}`, url: `http://192.0.2.${id}:11434`
  }))
});
stub('../../src/helpers/peerVerifiedNodeFetchTransport', {
  peerVerifiedNodeFetchTransport: async ({ fetchImpl, init, target }) => ({
    response: await fetchImpl(target, init), peerVerification: 'connect-time'
  })
});
stub('../../src/services/hostGate', { hostHasInflight: () => false });
stub('../../src/services/runtimeMutationLeaseService', {
  runRuntimeMutation() { throw new Error('Shutdown must not begin recovery'); }
});
stub('../../src/services/runtimeCoordinationService', {
  async listActive() { return { inferences: [], maintenance: null }; },
  async acquireInference() {
    event('acquired');
    return { acquired: true, admissionId: 'one', generation: 'one', principal: 'core-watchdog' };
  },
  async heartbeatInference() { return { heartbeat: true }; },
  async releaseInference() {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (!databaseOpen) throw new Error('Database closed before receipt');
    event('completed');
    return { released: true };
  },
  async markInferenceUnknown() {
    if (!databaseOpen) throw new Error('Database closed before quarantine');
    event('unknown');
    return { quarantined: true };
  }
});

const watchdog = require('../../src/services/ollamaWatchdogService');
const { drainRuntimeOperations } = require('../../src/services/pendingRuntimeOperations');
const { createServerShutdown } = require('../../src/serverShutdown');
watchdog._setFetch(async (url) => {
  const generate = url.endsWith('/api/generate');
  if (generate) {
    event('dispatched');
    await new Promise(resolve => setTimeout(resolve, 200));
  } else event('metadata');
  const payload = generate
    ? (phase === 'missing-terminal' ? {} : { done: true })
    : { models: [{ name: 'fixture-model' }] };
  return {
    status: 200, ok: true, url,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    body: Readable.from([JSON.stringify(payload)])
  };
});
let leak;
const shutdown = createServerShutdown({
  timeoutMs: 1000,
  logger: { info() {}, error(message) { event(message); } },
  stop() {
    event('stop');
    const drained = watchdog.stop();
    if (phase === 'deadline') {
      leak = setInterval(() => {}, 100);
      return new Promise(() => {});
    }
    return drained;
  },
  close() { event('listener-closed'); },
  drain: drainRuntimeOperations,
  flush() {
    event('flushed');
    if (phase === 'cleanup-error') throw new Error('fixture flush failed');
  },
  disconnect() { event('disconnected'); databaseOpen = false; clearInterval(leak); }
});
let reportSent = false;
function signal(name) {
  shutdown.run(name).then(() => {
    if (reportSent) return;
    reportSent = true;
    process.send({ done: events }, () => process.disconnect());
  });
}
process.once('SIGTERM', () => signal('SIGTERM'));
process.once('SIGINT', () => signal('SIGINT'));
// Windows cannot deliver POSIX signals to Node handlers. Exercise the same
// installed handlers there; Linux CI sends the actual OS signals.
process.on('message', message => {
  if (message.signal) process.emit(message.signal);
});
watchdog.start();
event('ready');

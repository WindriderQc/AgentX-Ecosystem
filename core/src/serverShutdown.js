'use strict';

// Cover the default ten-minute inference attempt and final receipts.
// Compose grants eleven minutes; a hung shutdown exits nonzero before SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 630_000;

function createServerShutdown({ stop, close, drain, flush, disconnect, logger,
  timeoutMs = SHUTDOWN_TIMEOUT_MS, processRef = process }) {
  let stopping = false;
  let pending = null;

  function run(signal) {
    if (pending) return pending;
    stopping = true;
    logger.info('Core shutdown started', { signal });
    const deadline = setTimeout(() => {
      logger.error('Core shutdown exceeded its deadline');
      processRef.exit(1);
    }, timeoutMs);
    deadline.unref();

    // Invoke every stop immediately, before yielding back to timers. Closing
    // the listener and stopping producers must precede draining their work.
    const invoke = (operation) => {
      try { return Promise.resolve(operation()); }
      catch (error) { return Promise.reject(error); }
    };
    const producers = invoke(stop);
    const listener = invoke(close);
    pending = (async () => {
      const results = await Promise.allSettled([producers, listener]);
      results.push(...await Promise.allSettled([invoke(drain)]));
      // Receipts and telemetry still need Mongo while requests are draining.
      results.push(...await Promise.allSettled([invoke(flush)]));
      results.push(...await Promise.allSettled([invoke(disconnect)]));
      const failures = results.filter(result => result.status === 'rejected');
      for (const failure of failures) {
        logger.error('Core shutdown cleanup failed', { error: failure.reason?.message });
      }
      processRef.exitCode = failures.length ? 1 : 0;
      logger.info('Core shutdown drained', { failed: failures.length });
      // Do not force a successful exit: unowned live handles must remain
      // visible. This unref'ed deadline only fires if something still leaks.
    })();
    return pending;
  }

  return { get stopping() { return stopping; }, run };
}

module.exports = { createServerShutdown, SHUTDOWN_TIMEOUT_MS };

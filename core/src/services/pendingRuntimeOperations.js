'use strict';

// Process-local shutdown bookkeeping, including acquisition and Mongo receipts.
// Runtime ownership continues to be enforced by the existing coordinators.
const pending = new Set();

async function trackRuntimeOperation(acquire, options) {
  let resolve;
  const completion = new Promise(done => { resolve = done; });
  pending.add(completion);
  const settled = () => { pending.delete(completion); resolve(); };
  try {
    const operation = await acquire(options, settled);
    return {
      ...operation,
      async complete() {
        const result = await operation.complete();
        settled();
        return result;
      },
      async abandon(reason) {
        try { return await operation.abandon(reason); }
        finally { settled(); }
      }
    };
  } catch (error) {
    settled();
    throw error;
  }
}

async function drainRuntimeOperations() {
  while (pending.size) await Promise.all([...pending]);
}

module.exports = { trackRuntimeOperation, drainRuntimeOperations };

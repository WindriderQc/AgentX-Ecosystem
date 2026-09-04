'use strict';

const DEFAULT_RECOVERY_OWNERSHIP_HEARTBEAT_MS = 20_000;

function recoveryOwnershipError(message, code = 'RECOVERY_OWNERSHIP_LOST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function startRecoveryOwnershipHeartbeat({
  refreshOwner,
  intervalMs = DEFAULT_RECOVERY_OWNERSHIP_HEARTBEAT_MS
} = {}) {
  if (typeof refreshOwner !== 'function') {
    throw new TypeError('refreshOwner is required');
  }

  const controller = new AbortController();
  let coreHeartbeat = null;
  let fatalError = null;
  let closed = false;
  let inFlight = null;

  const heartbeatOnce = () => {
    if (closed) return Promise.resolve();
    if (fatalError) return Promise.reject(fatalError);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      await refreshOwner({ signal: controller.signal });
      if (coreHeartbeat) {
        const result = await coreHeartbeat({ signal: controller.signal });
        if (result?.heartbeat !== true) {
          throw recoveryOwnershipError(
            result?.reason || 'Core recovery owner heartbeat was rejected',
            'WORKLOAD_RECOVERY_OWNERSHIP_LOST'
          );
        }
      }
    })().catch(error => {
      fatalError = error;
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const timer = setInterval(() => { heartbeatOnce().catch(() => {}); }, intervalMs);
  timer.unref?.();
  const ready = heartbeatOnce();

  return {
    signal: controller.signal,
    ready,
    setCoreHeartbeat(callback) {
      if (callback != null && typeof callback !== 'function') {
        throw new TypeError('Core recovery heartbeat must be a function');
      }
      coreHeartbeat = callback || null;
    },
    heartbeatOnce,
    assertActive() {
      if (fatalError) throw fatalError;
      if (closed || controller.signal.aborted) {
        throw recoveryOwnershipError('Recovery ownership heartbeat is no longer active');
      }
    },
    async stop() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (inFlight) await inFlight.catch(() => {});
    }
  };
}

module.exports = {
  DEFAULT_RECOVERY_OWNERSHIP_HEARTBEAT_MS,
  recoveryOwnershipError,
  startRecoveryOwnershipHeartbeat
};

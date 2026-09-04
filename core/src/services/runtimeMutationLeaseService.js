'use strict';

const crypto = require('crypto');
const logger = require('../../config/logger');
const runtimeCoordination = require('./runtimeCoordinationService');

const DEFAULT_TTL_MS = 120_000;

function boundedTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.max(15_000, Math.min(30 * 60_000, Math.round(parsed)));
}

function mutationError(message, code = 'RUNTIME_MUTATION_LEASE_DENIED') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function createAbortBridge(externalSignal) {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('Runtime mutation caller disconnected'));
  };
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener?.('abort', onAbort, { once: true });
  return {
    controller,
    cleanup() { externalSignal?.removeEventListener?.('abort', onAbort); }
  };
}

async function beginRuntimeMutation({
  principal,
  requestId = crypto.randomUUID(),
  scope,
  ttlMs = DEFAULT_TTL_MS,
  signal: externalSignal
} = {}) {
  const duration = boundedTtl(ttlMs);
  const acquired = await runtimeCoordination.acquireMaintenance({ principal, requestId, scope, ttl: duration });
  if (acquired?.acquired !== true) {
    throw mutationError(acquired?.reason || 'Runtime mutation lease was denied');
  }

  const bridge = createAbortBridge(externalSignal);
  let fatalError = null;
  let heartbeatRunning = false;
  let dispatched = false;
  let closed = false;

  const heartbeatOnce = async () => {
    if (closed || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const heartbeat = await runtimeCoordination.heartbeat('maintenance', {
        id: acquired.leaseId,
        generation: acquired.generation,
        principal: acquired.principal,
        ttl: duration
      });
      if (heartbeat?.heartbeat !== true) {
        throw mutationError(heartbeat?.reason || 'Runtime mutation lease heartbeat was rejected', 'RUNTIME_MUTATION_LEASE_LOST');
      }
    } catch (error) {
      fatalError = error;
      if (!bridge.controller.signal.aborted) bridge.controller.abort(error);
      if (dispatched) {
        await runtimeCoordination.markMaintenanceUnknown({
          id: acquired.leaseId,
          generation: acquired.generation,
          principal: acquired.principal,
          reason: error.message
        }).catch(quarantineError => logger.error('Runtime mutation quarantine failed closed', {
          leaseId: acquired.leaseId,
          error: quarantineError.message
        }));
      }
    } finally {
      heartbeatRunning = false;
    }
  };

  const timer = setInterval(() => { heartbeatOnce().catch(() => {}); }, Math.max(5_000, Math.floor(duration / 3)));
  timer.unref?.();

  const closeLocal = () => {
    closed = true;
    clearInterval(timer);
    bridge.cleanup();
  };

  return {
    leaseId: acquired.leaseId,
    generation: acquired.generation,
    principal: acquired.principal,
    requestId: acquired.requestId,
    scope: acquired.scope,
    signal: bridge.controller.signal,
    markDispatched() { dispatched = true; },
    assertActive() {
      if (fatalError) throw fatalError;
      if (closed || bridge.controller.signal.aborted) {
        throw mutationError('Runtime mutation lease is no longer active', 'RUNTIME_MUTATION_LEASE_LOST');
      }
    },
    async complete() {
      this.assertActive();
      const released = await runtimeCoordination.release('maintenance', {
        id: acquired.leaseId,
        generation: acquired.generation,
        principal: acquired.principal
      });
      if (released?.released !== true) {
        throw mutationError(released?.reason || 'Runtime mutation release was not acknowledged', 'RUNTIME_MUTATION_RELEASE_UNVERIFIED');
      }
      closeLocal();
      return released;
    },
    async abandon(reason) {
      if (closed) return { quarantined: dispatched, released: !dispatched, idempotent: true };
      const exact = {
        id: acquired.leaseId,
        generation: acquired.generation,
        principal: acquired.principal
      };
      const result = dispatched
        ? await runtimeCoordination.markMaintenanceUnknown({ ...exact, reason: reason?.message || reason })
        : await runtimeCoordination.release('maintenance', exact);
      closeLocal();
      return result;
    },
    _heartbeatOnce: heartbeatOnce
  };
}

async function runRuntimeMutation(options, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Runtime mutation operation must be a function');
  }

  const lifecycle = await beginRuntimeMutation(options);
  try {
    lifecycle.assertActive();
    // This generic wrapper cannot observe the first persistence write inside
    // an arbitrary callback. Treat entry into the callback as dispatch: a
    // thrown/connection-lost outcome may have followed a partial write and
    // must therefore quarantine instead of reopening runtime authority.
    lifecycle.markDispatched();
    const result = await operation({
      leaseId: lifecycle.leaseId,
      generation: lifecycle.generation,
      principal: lifecycle.principal,
      signal: lifecycle.signal
    });
    await lifecycle.complete();
    return result;
  } catch (error) {
    try {
      await lifecycle.abandon(error);
    } catch (abandonError) {
      logger.error('Runtime mutation cleanup failed closed', {
        leaseId: lifecycle.leaseId,
        error: abandonError.message
      });
    }
    throw error;
  }
}

module.exports = {
  beginRuntimeMutation,
  runRuntimeMutation,
  _internal: { boundedTtl, createAbortBridge }
};

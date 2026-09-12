'use strict';

const crypto = require('crypto');
const logger = require('../../config/logger');
const runtimeCoordination = require('./runtimeCoordinationService');
const { trackRuntimeOperation } = require('./pendingRuntimeOperations');

const DEFAULT_TTL_MS = 120_000;

function boundedTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.max(15_000, Math.min(30 * 60_000, Math.round(parsed)));
}

function admissionError(message, code = 'RUNTIME_INFERENCE_ADMISSION_DENIED') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
}

function createAbortBridge(externalSignal) {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Inference caller disconnected'));
    }
  };
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener?.('abort', onAbort, { once: true });
  return {
    controller,
    cleanup() { externalSignal?.removeEventListener?.('abort', onAbort); }
  };
}

async function acquireInferenceAdmission({
  host,
  model,
  kind = 'inference',
  mode = 'shared',
  principal = 'core-service',
  requestId = crypto.randomUUID(),
  workloadAdmissionId = null,
  workloadGeneration = null,
  runtimeOptions = null,
  keepAlive,
  ttlMs = DEFAULT_TTL_MS,
  signal: externalSignal
} = {}, onSettled = () => {}) {
  const duration = boundedTtl(ttlMs);
  const acquired = await runtimeCoordination.acquireInference({
    principal,
    requestId,
    host,
    model,
    kind,
    mode,
    workloadAdmissionId,
    workloadGeneration,
    runtimeOptions,
    ...(keepAlive !== undefined && { keepAlive }),
    ttl: duration
  });
  if (acquired?.acquired !== true) {
    const error = admissionError(acquired?.reason || 'Distributed inference admission was denied',
      acquired?.recoveryRequired ? 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' : 'RUNTIME_INFERENCE_ADMISSION_DENIED');
    error.failure = acquired?.failure || { cause: acquired?.recoveryRequired
      ? 'inference_recovery_required' : 'admission_conflict_unclassified', retryable: false, safeToRetry: true };
    throw error;
  }

  const bridge = createAbortBridge(externalSignal);
  let fatalError = null;
  let closed = false;
  let dispatched = false;
  let heartbeatRunning = false;

  const quarantine = async (reason) => {
    if (closed) return { quarantined: false, reason: 'admission already closed' };
    closed = true;
    clearInterval(timer);
    bridge.cleanup();
    return runtimeCoordination.markInferenceUnknown({
      id: acquired.admissionId,
      generation: acquired.generation,
      principal: acquired.principal,
      reason: reason?.message || reason || 'upstream terminal state unknown'
    }).finally(onSettled);
  };

  const heartbeatOnce = async () => {
    if (closed || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const heartbeat = await runtimeCoordination.heartbeatInference({
        id: acquired.admissionId,
        generation: acquired.generation,
        principal: acquired.principal,
        ttl: duration
      });
      if (heartbeat?.heartbeat !== true) {
        throw admissionError(
          heartbeat?.reason || 'Distributed inference admission heartbeat was rejected',
          'RUNTIME_INFERENCE_ADMISSION_LOST'
        );
      }
    } catch (error) {
      fatalError = error;
      if (!bridge.controller.signal.aborted) {
        bridge.controller.abort(new Error('Distributed inference admission was lost'));
      }
      await quarantine(error).catch(quarantineError => logger.error(
        'Inference admission quarantine failed closed',
        { host, model, error: quarantineError.message }
      ));
    } finally {
      heartbeatRunning = false;
    }
  };

  const timer = setInterval(() => { heartbeatOnce().catch(() => {}); }, Math.max(5_000, Math.floor(duration / 3)));
  timer.unref?.();

  return {
    admissionId: acquired.admissionId,
    generation: acquired.generation,
    principal: acquired.principal,
    signal: bridge.controller.signal,
    markDispatched() { dispatched = true; },
    assertActive() {
      if (fatalError) throw fatalError;
      if (closed) throw admissionError('Distributed inference admission is closed', 'RUNTIME_INFERENCE_ADMISSION_CLOSED');
      if (bridge.controller.signal.aborted) {
        throw admissionError('Distributed inference admission was cancelled', 'RUNTIME_INFERENCE_ADMISSION_ABORTED');
      }
    },
    async complete() {
      if (closed) {
        if (fatalError) throw fatalError;
        return { released: false, reason: 'admission already closed' };
      }
      if (fatalError) throw fatalError;
      closed = true;
      clearInterval(timer);
      bridge.cleanup();
      const released = await runtimeCoordination.releaseInference({
        id: acquired.admissionId,
        generation: acquired.generation,
        principal: acquired.principal
      });
      if (released?.released !== true) {
        throw admissionError(released?.reason || 'Distributed inference release was not acknowledged');
      }
      return released;
    },
    async abandon(reason) {
      if (!dispatched) {
        if (closed) return { released: false, reason: 'admission already closed' };
        closed = true;
        clearInterval(timer);
        bridge.cleanup();
        return runtimeCoordination.releaseInference({
          id: acquired.admissionId,
          generation: acquired.generation,
          principal: acquired.principal
        });
      }
      return quarantine(reason);
    },
    _heartbeatOnce: heartbeatOnce
  };
}

function beginInferenceAdmission(options) {
  return trackRuntimeOperation(acquireInferenceAdmission, options);
}

// Pin warm/restore is a model operation on one host. Reuse its existing
// exclusive admission so an unrelated host's quarantine cannot block it.
async function runHostModelOperation(options, operation) {
  const lifecycle = await beginInferenceAdmission({ ...options, mode: 'exclusive' });
  let release = () => {};
  try {
    release = await require('./hostGate').acquireExclusive(options.host, options.model, { signal: lifecycle.signal });
    lifecycle.assertActive();
    lifecycle.markDispatched();
    const result = await operation({ signal: lifecycle.signal, assertActive: () => lifecycle.assertActive() });
    lifecycle.assertActive();
    await lifecycle.complete();
    return result;
  } catch (error) {
    await lifecycle.abandon(error).catch(cleanupError => logger.error('Host model operation cleanup failed', {
      host: options.host, error: cleanupError.message
    }));
    throw error;
  } finally {
    await release();
  }
}

module.exports = {
  beginInferenceAdmission,
  runHostModelOperation,
  _internal: { boundedTtl, createAbortBridge }
};

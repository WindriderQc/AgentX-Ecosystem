'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

function classifyFailure(error) {
  if (error.failure) return error.failure;
  if (error.code === 'BENCHMARK_CLAIM_ACTIVE') return {
    cause: 'workload_reserved', retryable: true, safeToRetry: true, retryAfterMs: 2000
  };
  if (error.ollamaRequestNotSent === true) return {
    cause: 'connection_unavailable', retryable: true, safeToRetry: true, retryAfterMs: 2000
  };
  return { cause: error.code || 'inference_outcome_unknown', retryable: false, safeToRetry: false };
}

function rejectedResponse(result) {
  if (result.ok) return null;
  const error = new Error('The local inference provider rejected the request.');
  error.code = 'INFERENCE_PROVIDER_REJECTED';
  const transient = [429, 503].includes(result.status);
  const retryAfter = result.response?.headers?.get?.('retry-after');
  const seconds = Number(retryAfter);
  const retryAfterMs = retryAfter == null ? null : Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now());
  error.failure = { cause: transient ? 'provider_temporarily_unavailable' : 'provider_rejected',
    retryable: transient, safeToRetry: true, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null };
  error.result = result;
  return error;
}

// One logical model call. The operation never contains harness/tool execution.
// Returning a stream transfers ownership permanently; a later partial stream
// failure cannot reenter this loop. No durable request is replayed on restart.
async function withInferenceRetry(operation, { enabled = false, signal, beforeAttempt, onProgress,
  maxAttempts = 6, maxElapsedMs = 120000, now = Date.now, wait = sleep } = {}) {
  maxAttempts = enabled ? Math.max(1, Math.min(6, maxAttempts)) : 1;
  maxElapsedMs = Math.max(0, Math.min(120000, maxElapsedMs));
  const startedAt = now();
  const history = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    let result;
    try {
      await beforeAttempt?.();
      signal?.throwIfAborted();
      result = await operation();
      const rejection = rejectedResponse(result);
      if (rejection && enabled) throw rejection;
      const retry = { state: result.stream ? 'streaming' : 'completed', attempts: attempt,
        elapsedMs: now() - startedAt, history };
      await onProgress?.(retry);
      return { ...result, retry };
    } catch (error) {
      if (signal?.aborted || error.isCallerCancellation) {
        await onProgress?.({ state: 'cancelled', attempts: attempt, history });
        throw error;
      }
      const failure = classifyFailure(error);
      const delayMs = Math.max(Math.min(30000, 2000 * 2 ** (attempt - 1)), failure.retryAfterMs || 0);
      const canRetry = enabled && failure.retryable === true && failure.safeToRetry === true
        && !error.inferenceQuarantineError && attempt < maxAttempts
        && now() - startedAt + delayMs < maxElapsedMs;
      history.push({ attempt, cause: failure.cause, delayMs: canRetry ? delayMs : 0 });
      const retry = { state: canRetry ? 'waiting' : failure.retryable && enabled ? 'exhausted' : 'failed',
        attempts: attempt, elapsedMs: now() - startedAt, cause: failure.cause,
        nextRetryAt: canRetry ? new Date(now() + delayMs).toISOString() : null, history: [...history] };
      error.failure = failure;
      error.retry = retry;
      await onProgress?.(retry);
      if (!canRetry) throw error;
      try { await wait(delayMs, undefined, { signal }); }
      catch (cancelled) {
        await onProgress?.({ ...retry, state: 'cancelled', nextRetryAt: null });
        throw cancelled;
      }
    }
  }
}

module.exports = { withInferenceRetry, classifyFailure };

/**
 * Model Load Waiter
 *
 * Wait for an Ollama model to finish loading by polling the configured VRAM
 * signal when available, instead of sleeping a fixed timeout.
 *
 * Why this exists:
 * - Fixed timeouts are either too short (flaky failures) or too long
 *   (wastes seconds on every deploy).
 * - Different models take different times based on size + GPU + host load.
 * - VRAM stabilization is a reliable proxy for "model finished loading."
 *
 * Fallback: if a VRAM total is not configured, send a minimal generate request
 * to test readiness directly.
 */

const fetch = require('node-fetch');
const logger = require('../../config/logger');
const ollamaVramService = require('../services/ollamaVramService');

/**
 * Poll VRAM until it stabilizes.
 *
 * @param {string} hostUrl       Explicit Ollama host URL
 * @param {string} modelName     Model being loaded (for logging)
 * @param {object} [options]
 * @param {number} [options.maxWaitMs=120000]     Hard ceiling before giving up.
 * @param {number} [options.pollIntervalMs=2000]  VRAM poll cadence.
 * @param {number} [options.stabilityChecks=2]    Consecutive stable readings needed.
 * @returns {Promise<{loaded: true|false|null, durationMs: number, vramUsedMiB: number|null, error: string|null}>}
 *   `loaded: null` signals VRAM monitoring unavailable (caller should fall back).
 */
async function waitForModelLoad(hostUrl, modelName, options = {}) {
  const {
    maxWaitMs = 120000,
    pollIntervalMs = 2000,
    stabilityChecks = 2
  } = options;

  const startTime = Date.now();
  let previousVramUsed = null;
  let stableCount = 0;

  logger.debug('Waiting for model to load', { hostUrl, modelName, maxWaitMs, pollIntervalMs });

  // Initial VRAM read — if this fails, signal the caller to fall back.
  try {
    const initial = await ollamaVramService.getHostVram(hostUrl);
    if (!initial.ok) {
      return { loaded: null, durationMs: 0, vramUsedMiB: null, error: `VRAM monitoring unavailable: ${initial.error}` };
    }
    previousVramUsed = initial.memoryUsedMiBTotal;
  } catch (err) {
    return { loaded: null, durationMs: 0, vramUsedMiB: null, error: `Cannot check VRAM: ${err.message}` };
  }

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    let currentVramUsed;
    try {
      const r = await ollamaVramService.getHostVram(hostUrl);
      if (!r.ok) continue;
      currentVramUsed = r.memoryUsedMiBTotal;
    } catch (err) {
      logger.warn('VRAM poll error', { hostUrl, modelName, error: err.message });
      continue;
    }

    const change = currentVramUsed - previousVramUsed;

    // Allow small fluctuations (< 100 MiB) as "stable."
    if (Math.abs(change) < 100) {
      stableCount += 1;
      if (stableCount >= stabilityChecks) {
        const durationMs = Date.now() - startTime;
        logger.info('Model load detected (VRAM stabilized)', { hostUrl, modelName, durationMs, vramUsedMiB: currentVramUsed });
        return { loaded: true, durationMs, vramUsedMiB: currentVramUsed, error: null };
      }
    } else {
      stableCount = 0;
    }

    previousVramUsed = currentVramUsed;
  }

  const durationMs = Date.now() - startTime;
  logger.warn('Model load wait timed out', { hostUrl, modelName, durationMs, maxWaitMs, lastVramUsedMiB: previousVramUsed });
  return { loaded: false, durationMs, vramUsedMiB: previousVramUsed, error: `Timeout after ${durationMs}ms (VRAM did not stabilize)` };
}

/**
 * Fallback path: probe Ollama directly with a minimal generate request.
 * Used when VRAM monitoring is unavailable.
 */
async function pollModelReady(hostUrl, modelName, options = {}) {
  const { maxWaitMs = 30000, pollIntervalMs = 2000 } = options;
  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempts += 1;
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${hostUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, prompt: 'hi', stream: false, options: { num_predict: 1 } }),
        signal: controller.signal
      });
      clearTimeout(to);

      if (response.ok) {
        const data = await response.json();
        if (data.response !== undefined) {
          const durationMs = Date.now() - startTime;
          logger.info('Model ready (probe response)', { hostUrl, modelName, durationMs, attempts });
          return { loaded: true, durationMs, vramUsedMiB: null, error: null };
        }
      }
    } catch {
      // still loading — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const durationMs = Date.now() - startTime;
  return { loaded: false, durationMs, vramUsedMiB: null, error: `Poll timed out after ${attempts} attempts` };
}

/**
 * Recommended entry point: VRAM-based wait, falling back to Ollama probe
 * if VRAM is unavailable.
 */
async function waitForModelLoadWithFallback(hostUrl, modelName, options = {}) {
  const { fallbackTimeoutMs = 30000, ...waitOptions } = options;
  const result = await waitForModelLoad(hostUrl, modelName, waitOptions);
  if (result.loaded === null) {
    logger.info('VRAM unavailable — falling back to Ollama probe', { hostUrl, modelName, maxWaitMs: fallbackTimeoutMs });
    return pollModelReady(hostUrl, modelName, { maxWaitMs: fallbackTimeoutMs, pollIntervalMs: 2000 });
  }
  return result;
}

module.exports = { waitForModelLoad, waitForModelLoadWithFallback, pollModelReady };

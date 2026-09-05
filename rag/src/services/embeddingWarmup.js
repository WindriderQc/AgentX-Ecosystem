'use strict';

const logger = require('../../config/logger');
const { getEmbeddingsService } = require('./embeddings');

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 2000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collect the first piece of embedding-connection evidence at startup.
 *
 * `/status` is observational by design — a GET never starts embedding
 * inference — so nothing in normal operation warms the connection view. Left
 * alone, a freshly started service reports its embedding dependency unhealthy
 * from boot until an operator POSTs a refresh, which is a false negative that
 * survives for the life of the process.
 *
 * This lives outside the EmbeddingsService constructor on purpose: that module
 * is also loaded by short-lived test processes, where a detached fetch would
 * outlive the process that requested it and leak sockets.
 *
 * Retries with linear backoff because the embedding host is frequently still
 * coming up when this service starts (Compose ordering). A run that never
 * succeeds deliberately leaves the recorded failure in place — the dependency
 * really was unreachable, and claiming otherwise would trade a false negative
 * for a far worse false positive. Real traffic corrects it on the next call.
 */
async function warmEmbeddingConnection(options = {}) {
  const attempts = Number(options.attempts) > 0 ? Number(options.attempts) : DEFAULT_ATTEMPTS;
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs))
    ? Number(options.baseDelayMs)
    : DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep || defaultSleep;
  const resolveService = options.getService || getEmbeddingsService;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let healthy = false;

    try {
      healthy = await resolveService().refreshConnectionStatus();
    } catch (err) {
      logger.warn('Embedding warm-up attempt failed', { attempt, error: err.message });
    }

    if (healthy === true) {
      logger.info('Embedding connection verified at startup', { attempt });
      return true;
    }

    if (attempt < attempts) {
      await sleep(baseDelayMs * attempt);
    }
  }

  logger.warn(
    'Embedding connection unverified after startup retries; /status will report the embedding dependency unhealthy until traffic or an explicit refresh proves otherwise',
    { attempts }
  );
  return false;
}

module.exports = { warmEmbeddingConnection, DEFAULT_ATTEMPTS, DEFAULT_BASE_DELAY_MS };

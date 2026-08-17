/**
 * Ollama VRAM Service
 *
 * Gets VRAM usage from Ollama's /api/ps endpoint.
 * Best-effort — returns null fields when the host is unreachable or
 * VRAM data is unavailable.
 *
 * This lightweight implementation relies only on Ollama's REST API.
 */

const logger = require('../../config/logger');
const { listRunning } = require('../clients/ollamaClient');

const DEFAULT_CACHE_MS = 5000;

class OllamaVramService {
  constructor() {
    this.cache = new Map();
  }

  /**
   * Get VRAM usage for a host by calling Ollama's /api/ps endpoint.
   *
   * @param {string} hostUrl - e.g. "http://192.0.2.66:11434"
   * @returns {Promise<{ ok: boolean, memoryUsedMiBTotal: number|null, memoryTotalMiBTotal: number|null, error?: string }>}
   */
  async getHostVram(hostUrl) {
    if (!hostUrl) {
      return { ok: false, error: 'No host URL provided', memoryUsedMiBTotal: null, memoryTotalMiBTotal: null };
    }

    const cacheMs = Number.parseInt(process.env.OLLAMA_VRAM_CACHE_MS || '', 10) || DEFAULT_CACHE_MS;
    const cached = this.cache.get(hostUrl);
    if (cached && (Date.now() - cached.ts) < cacheMs) {
      return cached.value;
    }

    try {
      const data = await listRunning(hostUrl, { timeoutMs: 4000 });
      const models = Array.isArray(data.models) ? data.models : [];

      // Sum VRAM across all loaded models
      let memoryUsedBytes = 0;
      let memoryTotalBytes = 0;
      for (const model of models) {
        memoryUsedBytes += model.size_vram || 0;
        // size_vram is loaded VRAM. Ollama doesn't expose total GPU VRAM via /api/ps.
        // We record what we can.
      }

      const memoryUsedMiBTotal = memoryUsedBytes > 0
        ? Math.round(memoryUsedBytes / (1024 * 1024))
        : null;

      const value = {
        ok: true,
        memoryUsedMiBTotal,
        memoryTotalMiBTotal: memoryTotalBytes > 0
          ? Math.round(memoryTotalBytes / (1024 * 1024))
          : null
      };
      this.cache.set(hostUrl, { ts: Date.now(), value });
      return value;
    } catch (err) {
      logger.warn('VRAM snapshot unavailable', { hostUrl, error: err.message });
      const value = { ok: false, error: err.message, memoryUsedMiBTotal: null, memoryTotalMiBTotal: null };
      this.cache.set(hostUrl, { ts: Date.now(), value });
      return value;
    }
  }
}

module.exports = new OllamaVramService();

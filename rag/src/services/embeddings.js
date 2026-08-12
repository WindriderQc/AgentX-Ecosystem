const logger = require('../../config/logger');
const CoreProxyProvider = require('./embeddings/coreProxyProvider');
const OllamaProvider = require('./embeddings/ollamaProvider');
const { getEmbeddingCache } = require('./embeddingCache');

function createEmbeddingsProvider(config = {}) {
  const providerName = (config.embeddingProvider || process.env.EMBEDDING_PROVIDER || 'ollama-direct')
    .trim()
    .toLowerCase();

  switch (providerName) {
    case 'ollama-direct':
      return new OllamaProvider(config);
    case 'core-proxy':
      return new CoreProxyProvider(config);
    default:
      throw new Error(`Unsupported embedding provider: ${providerName}`);
  }
}

class EmbeddingsService {
  constructor(config = {}) {
    this.provider = createEmbeddingsProvider(config);
    this.providerName = this.provider.name;
    this.model = this.provider.model;
    this.dimension = this.provider.getDimension();
    this.healthCheckTtlMs = Number(
      config.healthCheckTtlMs || process.env.EMBEDDING_HEALTH_TTL_MS || 300000
    );
    this._connectionStatus = null;
    this._connectionStatusPromise = null;

    // NOTE: do NOT eagerly fire a health check here. Kicking off a detached
    // fetch in the constructor leaks timers + TCP sockets in short-lived
    // processes (e.g. Jest test runs) because the promise can outlive the
    // process that requested it. The first /status call, or any explicit
    // testConnection(), will trigger refreshConnectionStatus() on demand.
  }

  getCachedConnectionStatus() {
    if (!this._connectionStatus) {
      return null;
    }

    return {
      healthy: this._connectionStatus.healthy,
      checkedAt: this._connectionStatus.checkedAt,
      stale: Date.now() - this._connectionStatus.checkedAt >= this.healthCheckTtlMs
    };
  }

  async refreshConnectionStatus() {
    if (this._connectionStatusPromise) {
      return this._connectionStatusPromise;
    }

    const runCheck = (async () => {
      let healthy = false;

      try {
        healthy = await this.provider.testConnection();
      } catch (error) {
        logger.error('Embeddings connection test failed', {
          provider: this.providerName,
          error: error.message
        });
      }

      this._connectionStatus = {
        healthy: healthy === true,
        checkedAt: Date.now()
      };

      return this._connectionStatus.healthy;
    })();

    this._connectionStatusPromise = runCheck.finally(() => {
      this._connectionStatusPromise = null;
    });

    return this._connectionStatusPromise;
  }

  async embed(text, preferredHost = null) {
    const cache = getEmbeddingCache();
    const cached = cache.get(text, this.model);
    if (cached) return cached;

    const embedding = await this.provider.embed(text, preferredHost);
    cache.set(text, this.model, embedding);
    return embedding;
  }

  async embedBatch(texts, preferredHost = null) {
    const cache = getEmbeddingCache();
    const results = new Array(texts.length);
    const uncachedIndices = [];
    const uncachedTexts = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = cache.get(texts[i], this.model);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const freshEmbeddings = await this.provider.embedBatch(uncachedTexts, preferredHost);
      for (let j = 0; j < uncachedIndices.length; j++) {
        results[uncachedIndices[j]] = freshEmbeddings[j];
        cache.set(uncachedTexts[j], this.model, freshEmbeddings[j]);
      }
    }

    return results;
  }

  getDimension() {
    return this.provider.getDimension();
  }

  async testConnection(options = {}) {
    const useCache = options.useCache !== false;
    const now = Date.now();

    if (
      useCache &&
      this._connectionStatus &&
      now - this._connectionStatus.checkedAt < this.healthCheckTtlMs
    ) {
      return this._connectionStatus.healthy;
    }

    if (useCache && this._connectionStatus && !options.waitForRefresh) {
      this.refreshConnectionStatus().catch(() => {});
      return this._connectionStatus.healthy;
    }

    return this.refreshConnectionStatus();
  }

  getStatusInfo() {
    if (typeof this.provider.getStatusInfo === 'function') {
      return this.provider.getStatusInfo();
    }

    return {
      provider: this.providerName,
      model: this.model,
      dimension: this.dimension,
    };
  }

  destroy() {
    if (typeof this.provider.destroy === 'function') {
      this.provider.destroy();
    }
  }
}

let embeddingsServiceInstance = null;

function getEmbeddingsService(config = {}) {
  if (!embeddingsServiceInstance) {
    embeddingsServiceInstance = new EmbeddingsService(config);
    logger.info('EmbeddingsService initialized', {
      model: embeddingsServiceInstance.model,
      provider: embeddingsServiceInstance.providerName
    });
  }

  return embeddingsServiceInstance;
}

function resetEmbeddingsService() {
  if (!embeddingsServiceInstance) return;

  embeddingsServiceInstance.destroy();
  embeddingsServiceInstance = null;
}

module.exports = {
  EmbeddingsService,
  createEmbeddingsProvider,
  getEmbeddingsService,
  resetEmbeddingsService,
};

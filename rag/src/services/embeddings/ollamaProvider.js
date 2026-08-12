const fetchWithTimeout = require('../../utils/fetchWithTimeout');
const logger = require('../../../config/logger');

const EMBEDDING_TIMEOUT = Number(process.env.EMBEDDING_TIMEOUT_MS) || 60000;

class OllamaProvider {
  constructor(config = {}) {
    this.name = 'ollama-direct';
    this.model = config.embeddingModel || process.env.EMBEDDING_MODEL || 'nomic-embed-text:v1.5';
    this.dimension = config.dimension || Number(process.env.EMBEDDING_DIMENSION) || 768;
    this.batchSize = config.batchSize || 10;
    this.maxTextLength = config.maxTextLength || 8000;
    this.hosts = this._parseHosts(config.ollamaHosts || process.env.OLLAMA_HOSTS || 'localhost:11434');
    this.nextHostIndex = 0;
  }

  _parseHosts(rawHosts) {
    const hosts = String(rawHosts)
      .split(',')
      .map((host) => this._normalizeHost(host))
      .filter(Boolean);

    if (hosts.length === 0) {
      throw new Error('OLLAMA_HOSTS must contain at least one host');
    }

    return hosts;
  }

  _normalizeHost(host) {
    const trimmed = String(host || '').trim().replace(/\/+$/, '');

    if (!trimmed) {
      return null;
    }

    return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  _getAttemptHosts(preferredHost = null) {
    if (preferredHost) {
      const normalizedPreferredHost = this._normalizeHost(preferredHost);
      return [
        normalizedPreferredHost,
        ...this.hosts.filter((host) => host !== normalizedPreferredHost)
      ];
    }

    const startIndex = this.nextHostIndex;
    this.nextHostIndex = (this.nextHostIndex + 1) % this.hosts.length;

    return [
      ...this.hosts.slice(startIndex),
      ...this.hosts.slice(0, startIndex)
    ];
  }

  _truncateText(text) {
    return text.length > this.maxTextLength
      ? text.substring(0, this.maxTextLength)
      : text;
  }

  _validateText(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('text must be a non-empty string');
    }
  }

  async embed(text, preferredHost = null) {
    this._validateText(text);
    return this._requestEmbedding(this._truncateText(text), preferredHost);
  }

  async embedBatch(texts, preferredHost = null) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('texts must be a non-empty array');
    }

    const results = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      batch.forEach((text) => this._validateText(text));

      const batchResults = await this._requestBatchEmbeddings(
        batch.map((text) => this._truncateText(text)),
        preferredHost
      );

      results.push(...batchResults);
    }

    return results;
  }

  async _requestBatchEmbeddings(texts, preferredHost = null) {
    const attemptHosts = this._getAttemptHosts(preferredHost);
    let lastError = null;

    for (const host of attemptHosts) {
      try {
        return await this._requestBatchEmbeddingsFromHost(host, texts);
      } catch (error) {
        lastError = error;
        logger.warn('Ollama batch embedding host failed', { host, error: error.message });
      }
    }

    logger.error('All Ollama batch embedding hosts failed', {
      hosts: attemptHosts,
      error: lastError ? lastError.message : 'Unknown error'
    });

    throw new Error(`Failed to generate embeddings: ${lastError ? lastError.message : 'No Ollama hosts available'}`);
  }

  async _requestBatchEmbeddingsFromHost(host, texts) {
    const response = await fetchWithTimeout(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    }, EMBEDDING_TIMEOUT);

    if (response.status === 404) {
      logger.warn('Ollama batch embed endpoint unavailable; falling back to legacy embeddings endpoint', { host });
      return this._requestLegacyBatchEmbeddings(texts, host);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama batch embedding error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error('Invalid response from Ollama batch embeddings API');
    }

    if (data.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama batch embeddings count mismatch: expected ${texts.length}, got ${data.embeddings.length}`
      );
    }

    if (!data.embeddings.every((embedding) => Array.isArray(embedding))) {
      throw new Error('Invalid embedding vector in Ollama batch response');
    }

    return data.embeddings;
  }

  async _requestLegacyBatchEmbeddings(texts, preferredHost = null) {
    return Promise.all(texts.map((text) => this._requestEmbedding(text, preferredHost)));
  }

  async _requestEmbedding(text, preferredHost = null) {
    const attemptHosts = this._getAttemptHosts(preferredHost);
    let lastError = null;

    for (const host of attemptHosts) {
      try {
        const response = await fetchWithTimeout(`${host}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            prompt: text,
          }),
        }, EMBEDDING_TIMEOUT);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama embedding error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();

        if (!data.embedding || !Array.isArray(data.embedding)) {
          throw new Error('Invalid response from Ollama embeddings API');
        }

        return data.embedding;
      } catch (error) {
        lastError = error;
        logger.warn('Ollama embedding host failed', { host, error: error.message });
      }
    }

    logger.error('All Ollama embedding hosts failed', {
      hosts: attemptHosts,
      error: lastError ? lastError.message : 'Unknown error'
    });

    throw new Error(`Failed to generate embedding: ${lastError ? lastError.message : 'No Ollama hosts available'}`);
  }

  getDimension() {
    return this.dimension;
  }

  getStatusInfo() {
    return {
      provider: this.name,
      model: this.model,
      dimension: this.dimension,
      endpoint: this.hosts[0],
      hosts: [...this.hosts],
      hostCount: this.hosts.length
    };
  }

  async testConnection() {
    try {
      const embedding = await this.embed('test');
      return Array.isArray(embedding) && embedding.length === this.dimension;
    } catch (error) {
      logger.error('Embeddings connection test failed', {
        provider: this.name,
        error: error.message
      });
      return false;
    }
  }

  destroy() {}
}

module.exports = OllamaProvider;

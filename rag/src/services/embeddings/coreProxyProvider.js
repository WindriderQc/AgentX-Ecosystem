const fetchWithTimeout = require('../../utils/fetchWithTimeout');
const logger = require('../../../config/logger');

const EMBEDDING_TIMEOUT = Number(process.env.EMBEDDING_TIMEOUT_MS) || 60000;

class CoreProxyProvider {
  constructor(config = {}) {
    this.name = 'core-proxy';
    this.coreProxyUrl = config.coreProxyUrl || process.env.CORE_PROXY_URL || 'http://localhost:3080';
    this.model = config.embeddingModel || process.env.EMBEDDING_MODEL || 'nomic-embed-text:v1.5';
    this.dimension = config.dimension || Number(process.env.EMBEDDING_DIMENSION) || 768;
    this.batchSize = config.batchSize || 10;
    this.maxTextLength = config.maxTextLength || 8000;
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
      const batchResults = await Promise.all(
        batch.map((text) => this.embed(text, preferredHost))
      );
      results.push(...batchResults);
    }

    return results;
  }

  async _requestEmbedding(text, preferredHost = null) {
    const body = {
      model: this.model,
      prompt: text,
    };

    if (preferredHost) {
      body.ollamaHost = preferredHost;
    }

    try {
      const response = await fetchWithTimeout(`${this.coreProxyUrl}/api/inference/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, EMBEDDING_TIMEOUT);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Core embed proxy error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid response from core embed proxy');
      }

      return data.embedding;
    } catch (error) {
      logger.error('Error generating embedding via core proxy', { error: error.message });
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
  }

  getDimension() {
    return this.dimension;
  }

  getStatusInfo() {
    return {
      provider: this.name,
      model: this.model,
      dimension: this.dimension,
      endpoint: this.coreProxyUrl,
      route: '/api/inference/embed'
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

module.exports = CoreProxyProvider;

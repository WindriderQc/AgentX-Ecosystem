'use strict';

/**
 * Compatibility tombstone for the former direct Ollama embeddings provider.
 * RAG must traverse Core so every model load or failover is covered by the
 * shared Product inference admission. Keeping this constructor closed prevents
 * old configuration or a direct import from restoring the network path.
 */
class DisabledOllamaProvider {
  constructor() {
    const error = new Error('Direct Ollama embeddings are disabled; use the admission-backed core-proxy provider');
    error.code = 'DIRECT_OLLAMA_EMBEDDINGS_DISABLED';
    throw error;
  }
}

module.exports = DisabledOllamaProvider;

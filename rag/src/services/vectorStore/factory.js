/**
 * Vector Store Factory — creates the configured vector store instance.
 */

const logger = require('../../../config/logger');

function createVectorStore(config = {}) {
  const type = config.type || process.env.VECTOR_STORE_TYPE;

  if (!type) {
    throw new Error(
      'VECTOR_STORE_TYPE is not set. Set to "qdrant" for production or "memory" for development.'
    );
  }

  if (type === 'qdrant') {
    const QdrantVectorStore = require('./QdrantVectorStore');
    logger.info('Using Qdrant vector store');
    return new QdrantVectorStore(config);
  }

  if (type === 'memory') {
    const InMemoryVectorStore = require('./InMemoryVectorStore');
    logger.info('Using in-memory vector store (data will not persist across restarts)');
    return new InMemoryVectorStore(config);
  }

  throw new Error(`Unknown VECTOR_STORE_TYPE: "${type}". Valid types: qdrant, memory`);
}

module.exports = { createVectorStore };

/**
 * Abstract Vector Store Interface
 */

class VectorStoreAdapter {
  constructor(config = {}) {
    if (this.constructor === VectorStoreAdapter) {
      throw new Error('VectorStoreAdapter is an abstract class');
    }
    this.config = config;
  }

  async upsertDocument(_documentId, _metadata, _chunks) {
    throw new Error('upsertDocument() must be implemented');
  }

  async searchSimilar(_queryEmbedding, _options = {}) {
    throw new Error('searchSimilar() must be implemented');
  }

  async getDocument(_documentId) {
    throw new Error('getDocument() must be implemented');
  }

  async listDocuments(_filters = {}, _pagination = {}) {
    throw new Error('listDocuments() must be implemented');
  }

  async getDocumentChunks(_documentId) {
    throw new Error('getDocumentChunks() must be implemented');
  }

  async deleteDocument(_documentId) {
    throw new Error('deleteDocument() must be implemented');
  }

  async getStats() {
    throw new Error('getStats() must be implemented');
  }

  async healthCheck() {
    throw new Error('healthCheck() must be implemented');
  }

  /**
   * Retrieve the persisted original (pre-chunking) text for a document.
   * Returns `null` if no original text has been stored for this documentId.
   *
   * Added 2026-04-22 (0163) as T1 of the Architect-B reindex-overlap fix.
   * No production callers yet — introduced ahead of the write-path update (T2)
   * and reindex rewrite (T3).
   *
   * @param {string} _documentId
   * @returns {Promise<string|null>}
   */
  async getDocumentOriginalText(_documentId) {
    throw new Error('getDocumentOriginalText() must be implemented');
  }

  /**
   * Persist the original (pre-chunking) text for a document so that reindex
   * flows can re-chunk from the same source-of-truth instead of reassembling
   * from stored chunks (which overlap and would duplicate content).
   *
   * Added 2026-04-22 (0163) as T1 of the Architect-B reindex-overlap fix.
   * No production callers yet.
   *
   * @param {string} _documentId
   * @param {string} _text
   * @returns {Promise<void>}
   */
  async setDocumentOriginalText(_documentId, _text) {
    throw new Error('setDocumentOriginalText() must be implemented');
  }
}

module.exports = VectorStoreAdapter;

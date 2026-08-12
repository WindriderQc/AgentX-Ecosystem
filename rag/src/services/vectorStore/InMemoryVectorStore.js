/**
 * In-Memory Vector Store — dev/small-scale use. Data lost on restart.
 */

const VectorStoreAdapter = require('./VectorStoreAdapter');
const { cosineSimilarity } = require('../../utils/cosineSimilarity');

class InMemoryVectorStore extends VectorStoreAdapter {
  constructor(config = {}) {
    super(config);
    this.documents = new Map();
    this.vectors = [];
  }

  async upsertDocument(documentId, metadata, chunks) {
    const existingDoc = this.documents.get(documentId);
    if (existingDoc) {
      this.vectors = this.vectors.filter(v => v.documentId !== documentId);
    }

    this.documents.set(documentId, {
      documentId, ...metadata,
      chunkCount: chunks.length,
      createdAt: existingDoc ? existingDoc.createdAt : new Date(),
      updatedAt: new Date(),
    });

    for (const chunk of chunks) {
      this.vectors.push({
        documentId,
        chunkIndex: chunk.chunkIndex,
        embedding: chunk.embedding,
        text: chunk.text,
        metadata: { documentId, ...metadata, chunkIndex: chunk.chunkIndex }
      });
    }

    return { documentId, chunkCount: chunks.length, status: existingDoc ? 'updated' : 'created' };
  }

  async searchSimilar(queryEmbedding, options = {}) {
    const topK = Math.min(options.topK || 5, 20);
    const minScore = options.minScore !== undefined ? options.minScore : 0.0;
    const filters = options.filters || {};

    let results = this.vectors.map(vec => ({
      text: vec.text,
      score: cosineSimilarity(queryEmbedding, vec.embedding),
      metadata: vec.metadata
    }));

    Object.keys(filters).forEach(key => {
      if (key === 'tags') {
        if (filters.tags && filters.tags.length > 0) {
          results = results.filter(r => r.metadata.tags && r.metadata.tags.some(tag => filters.tags.includes(tag)));
        }
      } else {
        results = results.filter(r => r.metadata[key] === filters[key]);
      }
    });

    return results.filter(r => r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async getDocument(documentId) {
    return this.documents.get(documentId) || null;
  }

  async listDocuments(filters = {}, pagination = {}) {
    let docs = Array.from(this.documents.values());
    Object.keys(filters).forEach(key => {
      if (key === 'tags') {
        if (filters.tags && filters.tags.length > 0) {
          docs = docs.filter(d => d.tags && d.tags.some(tag => filters.tags.includes(tag)));
        }
      } else {
        docs = docs.filter(d => d[key] === filters[key]);
      }
    });

    const total = docs.length;
    const offset = pagination.offset || 0;
    const limit = pagination.limit || total; // no limit if not specified
    const paged = docs.slice(offset, offset + limit);

    return { documents: paged, total };
  }

  async getDocumentChunks(documentId) {
    return this.vectors
      .filter(v => v.documentId === documentId)
      .sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0))
      .map(v => ({ text: v.text, chunkIndex: v.chunkIndex }));
  }

  async deleteDocument(documentId) {
    const doc = this.documents.get(documentId);
    if (!doc) return false;
    this.documents.delete(documentId);
    this.vectors = this.vectors.filter(v => v.documentId !== documentId);
    return true;
  }

  async getStats() {
    return {
      documentCount: this.documents.size,
      chunkCount: this.vectors.length,
      vectorDimension: this.vectors.length > 0 ? this.vectors[0].embedding.length : 0
    };
  }

  async healthCheck() {
    return { healthy: true, type: 'memory' };
  }

  async getDocumentOriginalText(documentId) {
    const doc = this.documents.get(documentId);
    if (!doc) return null;
    return doc.originalText ?? null;
  }

  async setDocumentOriginalText(documentId, text) {
    const existing = this.documents.get(documentId);
    if (existing) {
      existing.originalText = text;
    } else {
      this.documents.set(documentId, { documentId, originalText: text });
    }
  }

}

module.exports = InMemoryVectorStore;

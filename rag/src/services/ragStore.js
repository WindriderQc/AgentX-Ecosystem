/**
 * RAG Store — orchestrates embeddings + vector store for document ingestion and search.
 */

const logger = require('../../config/logger');
const { getEmbeddingsService } = require('./embeddings');
const { createVectorStore } = require('./vectorStore/factory');
const { generateDocumentId, splitIntoChunks, reciprocalRankFusion } = require('./ragStoreUtils');
const { expandQuery } = require('./queryExpansion');
const { keywordSearch } = require('./keywordSearch');
const { rerankResults } = require('./reranker');
const { getCompressionService } = require('./ragCompression');

let instance = null;

class RagStore {
  constructor(config = {}) {
    this.vectorStore = createVectorStore(config);
    this.embeddingsService = getEmbeddingsService();
    this.defaultChunkSize = config.chunkSize || 500;
    this.defaultChunkOverlap = config.chunkOverlap || 50;
  }

  async upsertDocumentWithChunks(text, metadata = {}) {
    const documentId = metadata.documentId || generateDocumentId(metadata.source || 'unknown', text);
    const chunkSize = metadata.chunkSize || this.defaultChunkSize;
    const chunkOverlap = metadata.chunkOverlap || this.defaultChunkOverlap;

    // Content hash unchanged detection — skip re-ingestion if hash matches
    if (metadata.hash) {
      const existing = await this.vectorStore.getDocument(documentId);
      if (existing && existing.hash === metadata.hash) {
        logger.info(`Document "${documentId}" unchanged (hash match) — skipping ingestion`);
        return { unchanged: true, documentId };
      }
    }

    const textChunks = splitIntoChunks(text, chunkSize, chunkOverlap);
    if (textChunks.length === 0) {
      throw new Error('No chunks generated from text');
    }

    // Get embeddings for all chunks
    const embeddings = await this.embeddingsService.embedBatch(textChunks);

    if (!embeddings || embeddings.length !== textChunks.length) {
      throw new Error(
        `Embedding count mismatch: expected ${textChunks.length}, got ${embeddings ? embeddings.length : 0}`
      );
    }

    const chunks = textChunks.map((chunkText, i) => ({
      text: chunkText,
      embedding: embeddings[i],
      chunkIndex: i
    }));

    const result = await this.vectorStore.upsertDocument(documentId, {
      source: metadata.source,
      tags: metadata.tags || [],
      ...(metadata.hash ? { hash: metadata.hash } : {}),
    }, chunks);

    // Persist original (pre-chunking) text so reindex can re-chunk from
    // source-of-truth instead of joining overlapping chunks (which would
    // duplicate overlap regions on every run). T2 of Architect-B (0163/0164).
    // Failure here is logged but non-fatal: this document will be flagged
    // as unreindexable until re-ingested from source. T3 made reindex
    // throw on missing originalText rather than silently falling back to
    // chunk-concat (which is the very bug T2 + T3 fixed).
    try {
      await this.vectorStore.setDocumentOriginalText(documentId, text);
    } catch (err) {
      logger.warn(`Failed to persist originalText for "${documentId}" — document will be unreindexable until re-ingested from source`, { error: err.message });
    }

    logger.info(`Upserted document "${documentId}" — ${chunks.length} chunks`);
    return result;
  }

  async searchSimilarChunks(query, options = {}) {
    const useHybrid = options.hybrid === true;
    const useExpansion = options.expand === true;
    const useRerank = options.rerank === true;
    const useCompress = options.compress === true;
    const topK = Math.min(options.topK || 5, 20);

    // When re-ranking, fetch more candidates so the LLM judge has a wider pool
    const candidateTopK = useRerank ? topK * 3 : topK;

    let results;

    // ── Hybrid search: vector + keyword in parallel, fused with RRF ──
    if (useHybrid) {
      const [vectorResults, keywordResults] = await Promise.all([
        (async () => {
          const [queryEmbedding] = await this.embeddingsService.embedBatch([query]);
          return this.vectorStore.searchSimilar(queryEmbedding, {
            ...options,
            topK: candidateTopK * 2 // fetch extra for RRF merge
          });
        })(),
        keywordSearch(this.vectorStore, query, {
          topK: candidateTopK * 2,
          filters: options.filters
        })
      ]);

      const fused = reciprocalRankFusion(vectorResults, keywordResults);
      results = fused.slice(0, candidateTopK);

      logger.info('Hybrid search completed', {
        query: query.substring(0, 50),
        vectorCount: vectorResults.length,
        keywordCount: keywordResults.length,
        fusedCount: results.length
      });
    }
    // ── Query expansion: generate related queries, search in parallel, merge/dedup ──
    else if (useExpansion) {
      const relatedQueries = await expandQuery(query);
      const queriesToSearch = [query, ...relatedQueries];

      const perQueryTopK = Math.max(Math.ceil(candidateTopK / queriesToSearch.length), 2);

      const searchPromises = queriesToSearch.map(async (q) => {
        const [embedding] = await this.embeddingsService.embedBatch([q]);
        return this.vectorStore.searchSimilar(embedding, {
          ...options,
          topK: perQueryTopK
        });
      });

      const resultsArrays = await Promise.all(searchPromises);
      const allResults = resultsArrays.flat();

      // Deduplicate by chunk identity (documentId:chunkIndex), keep highest score
      const deduped = new Map();
      for (const result of allResults) {
        const meta = result.metadata || {};
        const key = `${meta.documentId || ''}:${meta.chunkIndex ?? ''}`;
        if (!deduped.has(key) || deduped.get(key).score < result.score) {
          deduped.set(key, result);
        }
      }

      results = Array.from(deduped.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateTopK);

      logger.info('Expanded search completed', {
        original: query.substring(0, 50),
        queryCount: queriesToSearch.length,
        rawResults: allResults.length,
        dedupedResults: results.length
      });
    }
    // ── Standard vector search ──
    else {
      const [queryEmbedding] = await this.embeddingsService.embedBatch([query]);
      results = await this.vectorStore.searchSimilar(queryEmbedding, {
        ...options,
        topK: candidateTopK
      });
    }

    // ── Re-ranking: LLM judge scores relevance, returns top K ──
    if (useRerank && results.length > 0) {
      results = await rerankResults(query, results, topK);
    } else {
      // Without re-ranking, trim to topK
      results = results.slice(0, topK);
    }

    // ── Contextual compression: extract relevant sentences via LLM ──
    if (useCompress && results.length > 0) {
      try {
        const compressor = getCompressionService();
        results = await compressor.compressChunks(query, results);
      } catch (err) {
        logger.warn('Compression failed, returning uncompressed results', { error: err.message });
      }
    }

    return results;
  }

  async listDocuments(filters = {}, pagination = {}) {
    return this.vectorStore.listDocuments(filters, pagination);
  }

  async deleteDocument(documentId) {
    return this.vectorStore.deleteDocument(documentId);
  }

  async getDocument(documentId) {
    return this.vectorStore.getDocument(documentId);
  }

  async getDocumentChunks(documentId) {
    return this.vectorStore.getDocumentChunks(documentId);
  }

  async getStats() {
    const storeStats = await this.vectorStore.getStats();
    const health = await this.vectorStore.healthCheck();
    return {
      ...storeStats,
      embeddingModel: this.embeddingsService.model,
      vectorStore: health,
    };
  }
}

function getRagStore(config) {
  if (!instance) {
    instance = new RagStore(config);
  }
  return instance;
}

function resetRagStore() {
  instance = null;
}

module.exports = { RagStore, getRagStore, resetRagStore };

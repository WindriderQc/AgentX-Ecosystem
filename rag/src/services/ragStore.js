/**
 * RAG Store — orchestrates embeddings + vector store for document ingestion and search.
 */

const logger = require('../../config/logger');
const { getEmbeddingsService } = require('./embeddings');
const { createVectorStore } = require('./vectorStore/factory');
const {
  buildDocumentIdentity,
  generateDocumentId,
  normalizeSourceIdentity,
  splitIntoChunks,
  reciprocalRankFusion
} = require('./ragStoreUtils');
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
    this.identityLocks = new Map();
  }

  async _withIdentityLock(identityKey, work) {
    const previous = this.identityLocks.get(identityKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.identityLocks.set(identityKey, current);
    try {
      return await current;
    } finally {
      if (this.identityLocks.get(identityKey) === current) {
        this.identityLocks.delete(identityKey);
      }
    }
  }

  async _candidateMatchesIdentity(candidate, identity, text, sourceHash) {
    if (!candidate?.documentId) return false;
    const hasPersistedIdentity = typeof candidate.sourceIdentity === 'string' && candidate.sourceIdentity.length > 0;
    const candidateSource = normalizeSourceIdentity(candidate.source);
    if (identity.sourceIdentityKind === 'document_id') {
      if (candidate.documentId !== identity.documentId) return false;
    } else if (hasPersistedIdentity) {
      if (candidate.sourceIdentity !== identity.sourceIdentity) return false;
    } else if (candidateSource !== identity.source) {
      return false;
    }

    // Preserve the established manifest contract: for the same explicit
    // document ID, an unchanged caller-provided source hash is authoritative.
    // This keeps file scans idempotent without requiring a migration first.
    if (identity.sourceIdentityKind === 'document_id'
      && sourceHash
      && candidate.hash === sourceHash) {
      return true;
    }

    if (candidate.contentHash && candidate.contentHash !== identity.contentHash) return false;

    // Identity-aware rows can be matched from their persisted facts even if
    // the optional originalText payload was not written successfully.
    if (candidate.identityVersion === identity.identityVersion
      && candidate.contentHash === identity.contentHash) {
      return true;
    }

    const originalText = typeof this.vectorStore.getDocumentOriginalText === 'function'
      ? await this.vectorStore.getDocumentOriginalText(candidate.documentId)
      : null;
    if (typeof originalText === 'string') {
      if (originalText !== text) return false;
      // A legacy row without identity metadata is only treated as automatic
      // when its ID matches the historical source+text generator. Arbitrary
      // explicit IDs and distinct file paths retain their provenance.
      if (identity.sourceIdentityKind === 'source_label' && !hasPersistedIdentity) {
        return candidate.documentId === generateDocumentId(candidate.source || 'unknown', originalText);
      }
      return true;
    }

    // Legacy documents without source hash, original text, or canonical
    // identity facts are not guessed from filenames or reconstructed chunks.
    return false;
  }

  async _findExistingIdentity(identity, text, preferredDocumentId, sourceHash) {
    const seen = new Set();
    const inspect = async (candidate) => {
      if (!candidate?.documentId || seen.has(candidate.documentId)) return null;
      seen.add(candidate.documentId);
      return await this._candidateMatchesIdentity(candidate, identity, text, sourceHash) ? candidate : null;
    };

    // Prefer the requested/automatic ID, preserving the existing stable-ID
    // upsert contract when that exact document is already present.
    const preferred = await this.vectorStore.getDocument(preferredDocumentId);
    const preferredMatch = await inspect(preferred);
    if (preferredMatch) return preferredMatch;

    // An explicit document ID is the caller's stable source identity. Other
    // IDs are not collapsed into it, even when their text happens to match.
    if (identity.sourceIdentityKind === 'document_id') return null;

    // Identity-aware documents take the cheap path through payload filters.
    const identityMatches = await this.vectorStore.listDocuments({
      sourceIdentity: identity.sourceIdentity,
      contentHash: identity.contentHash
    });
    for (const candidate of [...(identityMatches.documents || [])]
      .sort((left, right) => String(left.documentId).localeCompare(String(right.documentId)))) {
      const match = await inspect(candidate);
      if (match) return match;
    }

    // Legacy automatic rows are recognized through their deterministic
    // preferred ID above. We deliberately do not sweep or merge older rows.
    return null;
  }

  async _unchangedResult(existing, requestedDocumentId) {
    let chunkCount = Number(existing.chunkCount);
    if (!Number.isFinite(chunkCount)) {
      const chunks = typeof this.vectorStore.getDocumentChunks === 'function'
        ? await this.vectorStore.getDocumentChunks(existing.documentId)
        : null;
      chunkCount = Array.isArray(chunks) ? chunks.length : 0;
    }
    const deduplicated = existing.documentId !== requestedDocumentId;
    return {
      unchanged: true,
      deduplicated,
      documentId: existing.documentId,
      chunkCount,
      status: 'unchanged',
      ...(deduplicated ? { requestedDocumentId } : {})
    };
  }

  async _backfillOriginalTextIfMissing(existing, identity, text) {
    if (existing?.identityVersion !== identity.identityVersion
      || existing?.contentHash !== identity.contentHash
      || typeof this.vectorStore.getDocumentOriginalText !== 'function'
      || typeof this.vectorStore.setDocumentOriginalText !== 'function') {
      return;
    }

    try {
      const originalText = await this.vectorStore.getDocumentOriginalText(existing.documentId);
      if (typeof originalText !== 'string') {
        await this.vectorStore.setDocumentOriginalText(existing.documentId, text);
        logger.info(`Backfilled originalText for unchanged document "${existing.documentId}"`);
      }
    } catch (err) {
      // Keep the ingest idempotent, but retry the repair on every exact repeat.
      // A transient payload-write failure must not make reindexability loss
      // permanent just because canonical identity facts already exist.
      logger.warn(`Failed to backfill originalText for "${existing.documentId}"`, { error: err.message });
    }
  }

  async _upsertDocumentWithIdentity(text, metadata, identity) {
    const documentId = metadata.documentId || identity.documentId;
    const chunkSize = metadata.chunkSize || this.defaultChunkSize;
    const chunkOverlap = metadata.chunkOverlap || this.defaultChunkOverlap;

    const existing = await this._findExistingIdentity(identity, text, documentId, metadata.hash);
    if (existing && metadata.forceReindex !== true) {
      await this._backfillOriginalTextIfMissing(existing, identity, text);
      const result = await this._unchangedResult(existing, documentId);
      logger.info(`Document "${documentId}" unchanged (canonical source/content match) — skipping ingestion`, {
        canonicalDocumentId: result.documentId,
        deduplicated: result.deduplicated
      });
      return result;
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
      source: identity.source,
      tags: metadata.tags || [],
      ...(metadata.hash ? { hash: metadata.hash } : {}),
      sourceIdentity: identity.sourceIdentity,
      sourceIdentityKind: identity.sourceIdentityKind,
      contentHash: identity.contentHash,
      identityVersion: identity.identityVersion,
      chunkSize,
      chunkOverlap
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

  async upsertDocumentWithChunks(text, metadata = {}) {
    const identity = buildDocumentIdentity(metadata.source || 'unknown', text, metadata.documentId);
    const identityKey = identity.sourceIdentity;
    return this._withIdentityLock(
      identityKey,
      () => this._upsertDocumentWithIdentity(text, metadata, identity)
    );
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

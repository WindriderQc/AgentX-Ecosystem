/**
 * Qdrant Vector Store — production vector store adapter.
 */

const VectorStoreAdapter = require('./VectorStoreAdapter');
const fetchWithTimeout = require('../../utils/fetchWithTimeout');
const {
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredServiceOrigin,
} = require('../../clients/serviceOutboundClient');
const crypto = require('crypto');
const logger = require('../../../config/logger');

const QDRANT_TIMEOUT = SERVICE_OUTBOUND_TIMEOUTS[
  SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_READ
];
const DOCUMENT_METADATA_FIELDS = [
  'documentId', 'source', 'tags', 'sourceIdentity', 'sourceIdentityKind',
  'contentHash', 'identityVersion', 'chunkSize', 'chunkOverlap'
];
const METADATA_PAGE_SIZE = 1000;

class QdrantVectorStore extends VectorStoreAdapter {
  constructor(config = {}) {
    super(config);
    this.qdrantUrl = configuredServiceOrigin(
      config.qdrantUrl || process.env.QDRANT_URL || 'http://localhost:6333'
    );
    this.collectionName = config.collectionName || process.env.QDRANT_COLLECTION || 'agentx_embeddings';
    this.vectorDimension = Number(config.vectorDimension || process.env.EMBEDDING_DIMENSION) || 0;
    this._collectionVerified = false;
  }

  _outboundContext(operationId) {
    return {
      expectedOrigins: [this.qdrantUrl],
      operationId,
    };
  }

  _isMissingCollectionResponse(status, body) {
    if (Number(status) !== 404) return false;
    const detail = String(body || '');
    return /(?:not found\s*:\s*)?collection\b[\s\S]*(?:does not exist|doesn't exist|not found)/i.test(detail);
  }

  async _ensureCollection(vectorSize) {
    if (this._collectionVerified) return;

    try {
      const res = await fetchWithTimeout(
        `${this.qdrantUrl}/collections/${this.collectionName}`,
        {},
        QDRANT_TIMEOUT,
        this._outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_READ)
      );
      if (res.ok) {
        this._collectionVerified = true;
        return;
      }
      // Non-OK but reachable (e.g. 404) — fall through to create
    } catch (e) {
      // ECONNREFUSED / timeout — Qdrant not running, fall through to create attempt
      const msg = (e.message || '').toLowerCase();
      if (!msg.includes('econnrefused') && !msg.includes('fetch failed') && !msg.includes('timed out')) {
        throw e; // DNS failure, auth error, etc. — propagate
      }
    }

    const body = {
      vectors: { size: vectorSize, distance: 'Cosine' }
    };
    const res = await fetchWithTimeout(`${this.qdrantUrl}/collections/${this.collectionName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, QDRANT_TIMEOUT, this._outboundContext(
      SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_CREATE
    ));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create Qdrant collection: ${res.status} ${text}`);
    }
    this._collectionVerified = true;
    logger.info(`Created Qdrant collection "${this.collectionName}" with vector size ${vectorSize}`);
  }

  _generatePointId(documentId, chunkIndex) {
    const hex = crypto
      .createHash('sha256')
      .update(`${documentId}:${chunkIndex}`)
      .digest('hex');
    // Qdrant accepts UUID strings — build a deterministic v4-format UUID from the hash
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      '4' + hex.slice(13, 16),
      ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
      hex.slice(20, 32)
    ].join('-');
  }

  _buildMustFilters(filters) {
    const must = [];
    if (!filters) return must;
    Object.keys(filters).forEach(key => {
      if (key === 'tags' && Array.isArray(filters.tags)) {
        filters.tags.forEach(tag => {
          must.push({ key: 'tags', match: { value: tag } });
        });
      } else {
        must.push({ key, match: { value: filters[key] } });
      }
    });
    return must;
  }

  async upsertDocument(documentId, metadata, chunks) {
    if (!chunks.length) return { documentId, chunkCount: 0, status: 'empty' };

    const vectorSize = chunks[0].embedding.length;
    await this._ensureCollection(vectorSize);

    // Collect old point IDs before inserting, so we can delete them after.
    // Insert-first means a crash leaves duplicates rather than data loss.
    const oldPointIds = [];
    for await (const points of this._scrollPages({
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
      withPayload: false,
      pageSize: METADATA_PAGE_SIZE
    })) {
      for (const point of points) oldPointIds.push(point.id);
    }

    const points = chunks.map(chunk => ({
      id: this._generatePointId(documentId, chunk.chunkIndex),
      vector: chunk.embedding,
      payload: {
        documentId,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        ...metadata
      }
    }));

    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      const res = await fetchWithTimeout(`${this.qdrantUrl}/collections/${this.collectionName}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: batch })
      }, QDRANT_TIMEOUT, this._outboundContext(
        SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_UPSERT
      ));
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant upsert failed: ${res.status} ${text}`);
      }
    }

    // Point IDs are deterministic for documentId + chunkIndex. An upsert can
    // therefore replace an old point in place. Delete only IDs that are no
    // longer part of the new revision; deleting every old ID here would also
    // delete freshly replaced points with overlapping chunk indexes.
    const currentPointIds = new Set(points.map((point) => point.id));
    const stalePointIds = oldPointIds.filter((pointId) => !currentPointIds.has(pointId));
    if (stalePointIds.length > 0) {
      await this._deleteByPointIds(stalePointIds);
    }

    return {
      documentId,
      chunkCount: chunks.length,
      status: oldPointIds.length > 0 ? 'updated' : 'created'
    };
  }

  async searchSimilar(queryEmbedding, options = {}) {
    const topK = Math.min(options.topK || 5, 20);
    const minScore = options.minScore !== undefined ? options.minScore : 0.0;
    const filters = options.filters || {};
    const must = this._buildMustFilters(filters);

    const body = {
      vector: queryEmbedding,
      limit: topK,
      score_threshold: minScore,
      with_payload: true,
    };
    if (must.length > 0) body.filter = { must };

    const res = await fetchWithTimeout(`${this.qdrantUrl}/collections/${this.collectionName}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, QDRANT_TIMEOUT, this._outboundContext(
      SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SEARCH
    ));

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant search failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    return (data.result || []).map(hit => ({
      text: hit.payload.text,
      score: hit.score,
      metadata: hit.payload
    }));
  }

  async getDocument(documentId) {
    for await (const points of this._scrollPages({
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
      limit: 1,
      withPayload: { include: [...DOCUMENT_METADATA_FIELDS, 'hash'] }
    })) {
      const payload = points[0].payload;
      return {
        documentId,
        source: payload.source,
        tags: payload.tags,
        hash: payload.hash,
        ...(payload.sourceIdentity ? { sourceIdentity: payload.sourceIdentity } : {}),
        ...(payload.sourceIdentityKind ? { sourceIdentityKind: payload.sourceIdentityKind } : {}),
        ...(payload.contentHash ? { contentHash: payload.contentHash } : {}),
        ...(payload.identityVersion ? { identityVersion: payload.identityVersion } : {}),
        ...(payload.chunkSize != null ? { chunkSize: payload.chunkSize } : {}),
        ...(payload.chunkOverlap != null ? { chunkOverlap: payload.chunkOverlap } : {})
      };
    }
    return null;
  }

  async listDocuments(filters = {}, pagination = {}) {
    const must = this._buildMustFilters(filters);
    const docMap = new Map();
    for await (const points of this._scrollPages({
      filter: must.length ? { must } : undefined,
      withPayload: { include: DOCUMENT_METADATA_FIELDS },
      pageSize: METADATA_PAGE_SIZE
    })) {
      for (const pt of points) {
        const docId = pt.payload.documentId;
        if (!docMap.has(docId)) {
          docMap.set(docId, {
            documentId: docId,
            source: pt.payload.source,
            tags: pt.payload.tags,
            ...(pt.payload.sourceIdentity ? { sourceIdentity: pt.payload.sourceIdentity } : {}),
            ...(pt.payload.sourceIdentityKind ? { sourceIdentityKind: pt.payload.sourceIdentityKind } : {}),
            ...(pt.payload.contentHash ? { contentHash: pt.payload.contentHash } : {}),
            ...(pt.payload.identityVersion ? { identityVersion: pt.payload.identityVersion } : {}),
            ...(pt.payload.chunkSize != null ? { chunkSize: pt.payload.chunkSize } : {}),
            ...(pt.payload.chunkOverlap != null ? { chunkOverlap: pt.payload.chunkOverlap } : {}),
            chunkCount: 0
          });
        }
        docMap.get(docId).chunkCount++;
      }
    }

    const allDocs = Array.from(docMap.values());
    const total = allDocs.length;
    const offset = pagination.offset || 0;
    const limit = pagination.limit || total;
    const paged = allDocs.slice(offset, offset + limit);

    return { documents: paged, total };
  }

  async getDocumentChunks(documentId) {
    const chunks = [];
    for await (const points of this._scrollPages({
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
      withPayload: { include: ['text', 'chunkIndex'] }
    })) {
      for (const pt of points) chunks.push({ text: pt.payload.text, chunkIndex: pt.payload.chunkIndex || 0 });
    }
    return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async deleteDocument(documentId) {
    return this._deleteByDocumentId(documentId);
  }

  async _deleteByDocumentId(documentId) {
    const res = await fetchWithTimeout(`${this.qdrantUrl}/collections/${this.collectionName}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { must: [{ key: 'documentId', match: { value: documentId } }] }
      })
    }, QDRANT_TIMEOUT, this._outboundContext(
      SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_DELETE
    ));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant delete by documentId failed: ${res.status} ${text}`);
    }
    return true;
  }

  async _deleteByPointIds(ids) {
    const res = await fetchWithTimeout(`${this.qdrantUrl}/collections/${this.collectionName}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: ids })
    }, QDRANT_TIMEOUT, this._outboundContext(
      SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_DELETE
    ));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant delete by point IDs failed: ${res.status} ${text}`);
    }
    return true;
  }

  // Share pagination/error handling while letting callers retain only their
  // result (document metadata, distinct IDs or passages), never the full corpus.
  async *_scrollPages({ filter, limit, withPayload, pageSize = 100, missingCollectionIsEmpty = true }) {
    let remaining = limit || Infinity;
    let offset = null;

    while (true) {
      const body = { limit: Math.min(pageSize, remaining), with_payload: withPayload, with_vector: false };
      if (filter) body.filter = filter;
      if (offset !== null) body.offset = offset;

      const res = await fetchWithTimeout(`${this.qdrantUrl}/collections/${this.collectionName}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, QDRANT_TIMEOUT, this._outboundContext(
        SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SCROLL
      ));
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (this._isMissingCollectionResponse(res.status, text)) {
          this._collectionVerified = false;
          // A collection absent before traversal is empty. Losing it after a
          // page (or after successful stats metadata) is an unavailable read.
          if (missingCollectionIsEmpty && offset === null) return;
        }
        logger.warn('Qdrant scroll page-fetch failed', { status: res.status, body: text });
        throw new Error(`Qdrant scroll failed: ${res.status} ${text}`);
      }
      const data = await res.json();
      const points = data.result?.points;
      if (!Array.isArray(points)) throw new Error('Qdrant scroll returned an invalid result');
      if (points.length) yield remaining < points.length ? points.slice(0, remaining) : points;
      remaining -= points.length;
      if (remaining <= 0) return;

      const nextOffset = data.result?.next_page_offset;
      if (nextOffset == null) break;
      offset = nextOffset;
    }
  }

  async getStats() {
    const res = await fetchWithTimeout(
      `${this.qdrantUrl}/collections/${this.collectionName}`,
      {},
      QDRANT_TIMEOUT,
      this._outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_READ)
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (this._isMissingCollectionResponse(res.status, text)) {
        this._collectionVerified = false;
        return {
          documentCount: 0,
          chunkCount: 0,
          vectorDimension: this.vectorDimension,
          status: 'empty'
        };
      }
      throw new Error(`Qdrant getStats failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    const info = data.result;

    // Lightweight scroll — only fetch documentId payload, no vectors
    const documentIds = new Set();
    for await (const points of this._scrollPages({
      withPayload: { include: ['documentId'] },
      pageSize: METADATA_PAGE_SIZE,
      missingCollectionIsEmpty: false
    })) {
      for (const point of points) {
        if (point?.payload?.documentId) documentIds.add(point.payload.documentId);
      }
    }

    return {
      documentCount: documentIds.size,
      chunkCount: info.points_count || 0,
      vectorDimension: info.config?.params?.vectors?.size || 0,
      status: info.status
    };
  }

  async healthCheck(timeoutMs = Math.min(QDRANT_TIMEOUT, 2000)) {
    try {
      const res = await fetchWithTimeout(
        `${this.qdrantUrl}/collections`,
        {},
        timeoutMs,
        this._outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH)
      );
      return { healthy: res.ok, type: 'qdrant', url: this.qdrantUrl };
    } catch (e) {
      return { healthy: false, type: 'qdrant', error: e.message };
    }
  }

  /**
   * Find the chunk-0 point for a document and return its payload.
   * Returns the raw point (with `id` and `payload`) or null if absent.
   * Internal helper — used by {get,set}DocumentOriginalText.
   */
  async _findChunkZeroPoint(documentId, withPayload = { include: ['originalText'] }) {
    for await (const points of this._scrollPages({
      limit: 1,
      withPayload,
      filter: {
        must: [
          { key: 'documentId', match: { value: documentId } },
          { key: 'chunkIndex', match: { value: 0 } }
        ]
      }
    })) return points[0];
    return null;
  }

  async getDocumentOriginalText(documentId) {
    const point = await this._findChunkZeroPoint(documentId);
    if (!point) return null;
    return point.payload?.originalText ?? null;
  }

  async setDocumentOriginalText(documentId, text) {
    const point = await this._findChunkZeroPoint(documentId, false);
    if (!point) {
      throw new Error(`cannot set originalText: no chunk-0 for ${documentId}`);
    }
    const res = await fetchWithTimeout(
      `${this.qdrantUrl}/collections/${this.collectionName}/points/payload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: { originalText: text },
          points: [point.id]
        })
      },
      QDRANT_TIMEOUT,
      this._outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_PAYLOAD)
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Qdrant setPayload failed: ${res.status} ${body}`);
    }
  }
}

module.exports = QdrantVectorStore;

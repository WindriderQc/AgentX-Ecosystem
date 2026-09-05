/**
 * RAG API Routes
 *
 * POST   /ingest               — Ingest a document (text + metadata)
 * POST   /documents            — Alias for /ingest
 * POST   /ingest/batch         — Bulk ingest multiple documents sequentially
 * POST   /ingest-scan          — Start async NAS file scan + ingestion (returns 202 + jobId)
 * GET    /ingest-scan/:jobId   — Poll ingest-scan job progress
 * DELETE /ingest-scan/:jobId   — Cancel a running ingest-scan job
 * GET    /ingestion/policy     — Read the bounded local import policy
 * POST   /search               — Search similar chunks
 * GET    /documents            — List ingested documents
 * DELETE /documents/:id        — Delete a document by ID
 * POST   /cache/clear          — Clear embedding cache
 * GET    /status               — RAG service status + stats (includes cache stats)
 */

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const logger = require('../config/logger');
const { getRagStore } = require('../src/services/ragStore');
const { getEmbeddingsService } = require('../src/services/embeddings');
const { getEmbeddingCache } = require('../src/services/embeddingCache');
const { runIngestScan, getConfiguredRoots, isPathUnderRoot } = require('../src/services/ingestWorker');
const jobManager = require('../src/services/ingestJobManager');
const IngestJob = require('../models/IngestJob');
const buddyRagEvents = require('../src/services/buddyRagEvents');
const {
  getPublicIngestionPolicy,
  loadIngestionPolicy
} = require('../../shared/ingestionPolicy');

const { sendError } = require('../src/utils/response');
const { sanitizePublicProjection } = require('../src/utils/publicProjection');

// ── Helpers ──────────────────────────────────────────────

function classifyRagAvailabilityError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('fetch failed')) {
    return { status: 503, code: 'VECTOR_STORE_UNAVAILABLE', detail: 'Vector store is not reachable' };
  }
  if (msg.includes('embedding') || msg.includes('core proxy') || msg.includes('502') || msg.includes('503')) {
    return { status: 503, code: 'EMBEDDING_SERVICE_UNAVAILABLE', detail: 'Embedding service (core proxy) is not reachable' };
  }
  return null;
}

function requireDocumentDeleteConfirmation(req, res, documentId) {
  const expected = `DELETE ${documentId}`;
  if (req.body?.confirmation === expected) return true;

  res.status(400).json({
    ok: false,
    error: 'CONFIRMATION_REQUIRED',
    detail: 'Type the exact document deletion phrase before retrying this destructive operation',
    confirmation: { field: 'confirmation', expected }
  });
  return false;
}

// ── POST /ingest (alias: POST /documents) ────────────────

const MAX_TEXT_LENGTH = 2_000_000; // ~2MB
const MAX_QUERY_LENGTH = 10_000;
const CHUNK_SIZE_MIN = 50;
const CHUNK_SIZE_MAX = 10_000;
const TOP_K_MAX = 20;

async function handleIngest(req, res) {
  try {
    const { text, source, tags, chunkSize, chunkOverlap, documentId } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'text is required and must be a non-empty string' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ ok: false, error: `text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
    }
    if (source && typeof source !== 'string') {
      return res.status(400).json({ ok: false, error: 'source must be a string' });
    }
    if (tags !== undefined && tags !== null) {
      if (!Array.isArray(tags)) {
        return res.status(400).json({ ok: false, error: 'tags must be an array' });
      }
      if (!tags.every((t) => typeof t === 'string')) {
        return res.status(400).json({ ok: false, error: 'tags must be an array of strings' });
      }
    }

    // Validate chunkSize
    const resolvedChunkSize = chunkSize !== undefined ? chunkSize : 500;
    if (!Number.isInteger(resolvedChunkSize) || resolvedChunkSize < CHUNK_SIZE_MIN || resolvedChunkSize > CHUNK_SIZE_MAX) {
      return res.status(400).json({ ok: false, error: `chunkSize must be an integer between ${CHUNK_SIZE_MIN} and ${CHUNK_SIZE_MAX}` });
    }

    // Validate chunkOverlap
    const resolvedChunkOverlap = chunkOverlap !== undefined ? chunkOverlap : 50;
    if (!Number.isInteger(resolvedChunkOverlap) || resolvedChunkOverlap < 0 || resolvedChunkOverlap > resolvedChunkSize / 2) {
      return res.status(400).json({ ok: false, error: `chunkOverlap must be an integer between 0 and ${Math.floor(resolvedChunkSize / 2)}` });
    }

    const ragStore = getRagStore();
    const startTime = Date.now();
    // Fire-and-forget Buddy surface event (intent:watching, surfaceScope:rag).
    buddyRagEvents.ingestStart(`RAG ingest started: ${source || 'api'}`);
    const result = await ragStore.upsertDocumentWithChunks(text, {
      source: source || 'api',
      tags: tags || [],
      chunkSize: resolvedChunkSize,
      chunkOverlap: resolvedChunkOverlap,
      documentId
    });
    const totalTimeMs = Date.now() - startTime;

    // Fire-and-forget Buddy surface event (intent:suggesting, surfaceScope:rag).
    buddyRagEvents.ingestDone(`RAG ingest done: ${result.chunkCount || 0} chunks from ${source || 'api'}`);

    // Fire-and-forget telemetry write
    IngestJob.create({
      jobId: crypto.randomUUID(),
      source: source || 'api',
      documentId: result.documentId,
      status: 'success',
      chunksCreated: result.chunkCount || 0,
      totalTimeMs,
      tags: tags || [],
      textLength: text.length
    }).catch((telErr) => logger.warn('Telemetry write failed:', telErr.message));

    res.json({ ok: true, data: result });
  } catch (err) {
    // Fire-and-forget Buddy surface event (intent:warning, surfaceScope:rag).
    buddyRagEvents.ingestFailed(`RAG ingest failed: ${(err.message || 'unknown').slice(0, 120)}`);

    // Fire-and-forget telemetry for failures
    const { text: bodyText, source: bodySrc, tags: bodyTags } = req.body || {};
    IngestJob.create({
      jobId: crypto.randomUUID(),
      source: bodySrc || 'api',
      status: 'failed',
      error: (err.message || '').slice(0, 500),
      tags: Array.isArray(bodyTags) ? bodyTags : [],
      textLength: typeof bodyText === 'string' ? bodyText.length : 0,
      totalTimeMs: 0
    }).catch((telErr) => logger.warn('Telemetry write failed:', telErr.message));

    const classified = classifyRagAvailabilityError(err);
    if (classified) {
      logger.warn(`Ingest blocked: ${classified.code} — ${err.message}`);
      return sendError(res, classified.status, classified.code, classified.detail);
    }
    logger.error('Ingest error:', err);
    sendError(res, 500, 'Ingest failed', err.message);
  }
}

router.post('/ingest', handleIngest);
router.post('/documents', handleIngest);

// ── POST /ingest/batch — Bulk multi-document ingest ─────

const BATCH_MAX_DOCS = Math.min(Math.max(Number(process.env.BATCH_MAX_DOCS) || 50, 1), 500);

router.post('/ingest/batch', async (req, res) => {
  try {
    const { documents } = req.body || {};

    // ── Validate batch envelope ──
    if (!Array.isArray(documents)) {
      return res.status(400).json({ ok: false, error: 'documents must be an array' });
    }
    if (documents.length === 0) {
      return res.status(400).json({ ok: false, error: 'documents array must not be empty' });
    }
    if (documents.length > BATCH_MAX_DOCS) {
      return res.status(400).json({ ok: false, error: `Batch exceeds maximum of ${BATCH_MAX_DOCS} documents` });
    }

    // ── Validate each document before processing any ──
    for (const [i, doc] of documents.entries()) {
      if (!doc.text || typeof doc.text !== 'string' || doc.text.trim().length === 0) {
        return res.status(400).json({ ok: false, error: `documents[${i}].text is required and must be a non-empty string` });
      }
      if (doc.text.length > MAX_TEXT_LENGTH) {
        return res.status(400).json({ ok: false, error: `documents[${i}].text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
      }
      if (doc.source !== undefined && doc.source !== null && typeof doc.source !== 'string') {
        return res.status(400).json({ ok: false, error: `documents[${i}].source must be a string` });
      }
      if (doc.tags !== undefined && doc.tags !== null) {
        if (!Array.isArray(doc.tags)) {
          return res.status(400).json({ ok: false, error: `documents[${i}].tags must be an array` });
        }
        if (!doc.tags.every((t) => typeof t === 'string')) {
          return res.status(400).json({ ok: false, error: `documents[${i}].tags must be an array of strings` });
        }
      }
    }

    // ── Process sequentially (GPU is the bottleneck) ──
    const ragStore = getRagStore();
    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const [index, doc] of documents.entries()) {
      try {
        const result = await ragStore.upsertDocumentWithChunks(doc.text, {
          source: doc.source || 'api',
          tags: doc.tags || [],
          chunkSize: doc.chunkSize,
          chunkOverlap: doc.chunkOverlap,
          documentId: doc.documentId
        });
        results.push({
          index,
          documentId: result.documentId,
          status: result.unchanged ? 'unchanged' : 'ok',
          chunkCount: result.chunkCount,
          ...(result.unchanged ? { unchanged: true } : {}),
          ...(result.deduplicated ? {
            deduplicated: true,
            requestedDocumentId: result.requestedDocumentId
          } : {})
        });
        succeeded++;
      } catch (err) {
        // Abort early on availability errors from the first document
        if (index === 0) {
          const classified = classifyRagAvailabilityError(err);
          if (classified) {
            logger.warn(`Batch ingest aborted: ${classified.code} — ${err.message}`);
            return sendError(res, classified.status, classified.code, classified.detail);
          }
        }
        results.push({ index, status: 'error', error: err.message });
        failed++;
      }
    }

    res.json({
      ok: true,
      data: { total: documents.length, succeeded, failed, results }
    });
  } catch (err) {
    logger.error('Batch ingest error:', err);
    sendError(res, 500, 'Batch ingest failed', err.message);
  }
});

// ── POST /ingest-scan — Start async scan job ───────────

router.post('/ingest-scan', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return sendError(res, 503, 'MONGODB_UNAVAILABLE', 'MongoDB must be connected before running ingest scan');
    }

    const { limit, roots } = req.body || {};
    const allowedRoots = getConfiguredRoots();

    if (roots !== undefined && (!Array.isArray(roots) || roots.length === 0)) {
      return sendError(res, 400, 'INVALID_ROOTS', 'roots must be a non-empty array when provided');
    }
    if (Array.isArray(roots)) {
      const invalid = roots.filter((r) => !allowedRoots.some((allowed) => isPathUnderRoot(r, allowed)));
      if (invalid.length) {
        return sendError(res, 400, 'INVALID_ROOTS', `Roots not under configured paths: ${invalid.join(', ')}`);
      }
    }

    // Reject if a scan is already running
    if (jobManager.isRunning()) {
      return res.status(409).json({ ok: false, error: 'SCAN_ALREADY_RUNNING', data: { activeJobId: jobManager.getActiveJobId() } });
    }

    const scanParams = {
      limit: Math.min(Number(limit) || 5000, 5000),
      roots: Array.isArray(roots) ? roots : undefined
    };

    const created = jobManager.createJob(scanParams);
    if (!created) {
      // Race condition — another request snuck in
      return sendError(res, 409, 'SCAN_ALREADY_RUNNING', 'A scan is already in progress');
    }

    const { jobId } = created;

    // Fire-and-forget: run scan in background
    runIngestScan({
      ...scanParams,
      onProgress: (progress) => jobManager.updateProgress(jobId, progress),
      isCancelled: () => {
        const job = jobManager.getJob(jobId);
        return job && job.status === 'cancelled';
      }
    })
      .then((summary) => {
        const job = jobManager.getJob(jobId);
        if (job && job.status === 'cancelled') return; // already cancelled
        const { results, ...counts } = summary;
        jobManager.completeJob(jobId, counts);
      })
      .catch((err) => {
        logger.error('Ingest scan background error:', err);
        jobManager.failJob(jobId, err.message);
      });

    res.status(202).json({
      ok: true,
      data: { jobId, status: 'running' }
    });
  } catch (err) {
    logger.error('Ingest scan error:', err);
    sendError(res, 500, 'Ingest scan failed', err.message);
  }
});

// ── GET /ingest-scan/:jobId — Poll job progress ────────

router.get('/ingest-scan/:jobId', (req, res) => {
  const job = jobManager.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job not found' });
  }

  const response = {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  };

  // Include summary counts when completed
  if (job.summary) {
    response.summary = job.summary;
  }
  if (job.error) {
    response.error = job.error;
  }

  res.json({ ok: true, data: response });
});

// ── DELETE /ingest-scan/:jobId — Cancel a running scan ──

router.delete('/ingest-scan/:jobId', (req, res) => {
  const job = jobManager.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job not found' });
  }

  if (job.status !== 'running') {
    return sendError(res, 400, 'JOB_NOT_RUNNING', `Job is ${job.status}, cannot cancel`);
  }

  jobManager.cancelJob(req.params.jobId);
  res.json({ ok: true, data: { jobId: job.jobId, status: 'cancelled' } });
});

// ── Read-only local ingestion contract ──────────────────

router.get('/ingestion/policy', (_req, res) => {
  res.json({ ok: true, data: getPublicIngestionPolicy(loadIngestionPolicy()) });
});

// ── POST /search ─────────────────────────────────────────

router.post('/search', async (req, res) => {
  try {
    const { query, topK, minScore, filters, expand, hybrid, rerank, compress } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'query is required and must be a non-empty string' });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ ok: false, error: `query exceeds maximum length of ${MAX_QUERY_LENGTH} characters` });
    }

    // Clamp topK to valid range
    let safeTopK = topK !== undefined ? Math.floor(Number(topK)) : 5;
    if (!Number.isFinite(safeTopK) || safeTopK < 1) safeTopK = 1;
    if (safeTopK > TOP_K_MAX) safeTopK = TOP_K_MAX;

    // Clamp minScore to [0, 1]
    let safeMinScore = minScore !== undefined ? Number(minScore) : 0;
    if (!Number.isFinite(safeMinScore) || safeMinScore < 0) safeMinScore = 0;
    if (safeMinScore > 1) safeMinScore = 1;

    // Validate filters is a plain object (not array, not string)
    if (filters !== undefined && filters !== null) {
      if (typeof filters !== 'object' || Array.isArray(filters)) {
        return res.status(400).json({ ok: false, error: 'filters must be a plain object' });
      }
    }

    const ragStore = getRagStore();
    const results = await ragStore.searchSimilarChunks(query, {
      topK: safeTopK,
      minScore: safeMinScore,
      filters,
      expand: expand === true,
      hybrid: hybrid === true,
      rerank: rerank === true,
      compress: compress === true
    });

    // Fire-and-forget Buddy surface event when a valid query yields nothing
    // (intent:suggesting, surfaceScope:rag) — guide the user to refine/ingest.
    if (!results || results.length === 0) {
      buddyRagEvents.searchEmpty(`RAG search returned no matches for "${query.slice(0, 60)}"`);
    }

    res.json({ ok: true, data: { results, count: results.length } });
  } catch (err) {
    // Fire-and-forget Buddy surface event (intent:warning, surfaceScope:rag).
    buddyRagEvents.searchFailed(`RAG search failed: ${(err.message || 'unknown').slice(0, 120)}`);

    const classified = classifyRagAvailabilityError(err);
    if (classified) {
      logger.warn(`Search blocked: ${classified.code} — ${err.message}`);
      return sendError(res, classified.status, classified.code, classified.detail);
    }
    logger.error('Search error:', err);
    sendError(res, 500, 'Search failed', err.message);
  }
});

// ── GET /documents ───────────────────────────────────────

const DOCS_LIMIT_DEFAULT = 50;
const DOCS_LIMIT_MAX = 200;

router.get('/documents', async (req, res) => {
  try {
    const filters = {};
    if (req.query.source) filters.source = String(req.query.source);
    if (req.query.tags) filters.tags = String(req.query.tags).split(',');

    // Parse and clamp pagination params
    let limit = req.query.limit !== undefined ? Math.floor(Number(req.query.limit)) : DOCS_LIMIT_DEFAULT;
    if (!Number.isFinite(limit) || limit < 1) limit = DOCS_LIMIT_DEFAULT;
    if (limit > DOCS_LIMIT_MAX) limit = DOCS_LIMIT_MAX;

    let offset = req.query.offset !== undefined ? Math.floor(Number(req.query.offset)) : 0;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const ragStore = getRagStore();
    const { documents, total } = await ragStore.listDocuments(filters, { limit, offset });
    res.json({ ok: true, data: { documents, total, limit, offset } });
  } catch (err) {
    logger.error('List documents error:', err);
    sendError(res, 500, 'Failed to list documents', err.message);
  }
});

// ── DELETE /documents/:documentId ────────────────────────

router.delete('/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;

    if (!requireDocumentDeleteConfirmation(req, res, documentId)) return;

    const ragStore = getRagStore();
    const deleted = await ragStore.deleteDocument(documentId);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }
    res.json({ ok: true, data: { documentId } });
  } catch (err) {
    logger.error('Delete document error:', err);
    sendError(res, 500, 'Failed to delete document', err.message);
  }
});

// ── POST /cache/clear ───────────────────────────────────

router.post('/cache/clear', (req, res) => {
  try {
    const cache = getEmbeddingCache();
    cache.clear();
    res.json({ ok: true, data: { cleared: true } });
  } catch (err) {
    logger.error('Cache clear error:', err);
    res.status(500).json({ ok: false, error: 'Failed to clear cache' });
  }
});

// ── GET /status + POST /status/refresh ───────────────────

async function handleStatus(req, res) {
  const refreshRequested = req.method === 'POST';
  try {
    const ragStore = getRagStore();

    // Gather existing stats (preserves all existing fields)
    let stats = {};
    try {
      stats = await ragStore.getStats();
    } catch (err) {
      logger.warn('Status: ragStore.getStats() failed', { error: err.message });
    }

    // ── Per-dependency health matrix ──
    const dependencies = {};

    // MongoDB
    try {
      const readyState = mongoose.connection.readyState;
      dependencies.mongodb = { healthy: readyState === 1, readyState };
    } catch (err) {
      dependencies.mongodb = { healthy: false, error: err.message };
    }

    // Embedding provider
    try {
      const embSvc = getEmbeddingsService();
      const embStatus = typeof embSvc.getStatusInfo === 'function'
        ? embSvc.getStatusInfo()
        : { provider: embSvc.providerName, model: embSvc.model };
      if (refreshRequested && typeof embSvc.refreshConnectionStatus === 'function') {
        await embSvc.refreshConnectionStatus({ source: 'operator-refresh' });
      }
      const cachedEmbedding = typeof embSvc.getCachedConnectionStatus === 'function'
        ? embSvc.getCachedConnectionStatus()
        : null;

      if (cachedEmbedding) {
        dependencies.embedding = {
          healthy: cachedEmbedding.healthy === true,
          ...embStatus,
          // `active` means we hold a real observation (a startup probe, an
          // explicit refresh, or a genuine embed call), as opposed to the
          // `unknown` below where nothing has been collected yet.
          evidence: 'active',
          evidenceSource: cachedEmbedding.source || 'unspecified',
          checkedAt: cachedEmbedding.checkedAt,
          ...(cachedEmbedding.startupVerifiedAt
            ? { startupVerifiedAt: cachedEmbedding.startupVerifiedAt }
            : {}),
          ...(cachedEmbedding.stale ? { stale: true } : {}),
          ...(cachedEmbedding.healthy === true ? {} : { error: 'Embedding connection test failed' })
        };
      } else {
        dependencies.embedding = {
          healthy: false,
          ...embStatus,
          evidence: 'unknown',
          error: 'No embedding connection evidence has been collected.'
        };
      }
    } catch (err) {
      const embSvc = (() => { try { return getEmbeddingsService(); } catch { return null; } })();
      const embStatus = embSvc && typeof embSvc.getStatusInfo === 'function'
        ? embSvc.getStatusInfo()
        : { provider: embSvc?.providerName || 'unknown', model: embSvc?.model || 'unknown' };
      dependencies.embedding = {
        healthy: false,
        ...embStatus,
        error: err.message
      };
    }

    // Qdrant / vector store (already in stats.vectorStore from getStats)
    try {
      if (stats.vectorStore) {
        dependencies.qdrant = {
          healthy: stats.vectorStore.healthy === true,
          url: stats.vectorStore.url || undefined
        };
      } else {
        // Fall back to direct health check
        const health = await ragStore.vectorStore.healthCheck();
        dependencies.qdrant = { healthy: health.healthy === true, url: health.url || undefined };
      }
    } catch (err) {
      dependencies.qdrant = { healthy: false, error: err.message };
    }

    const serviceReady = dependencies.mongodb?.healthy === true
      && dependencies.qdrant?.healthy === true;
    const queryReady = serviceReady && dependencies.embedding?.healthy === true;
    const status = queryReady ? 'green' : (serviceReady ? 'degraded' : 'red');

    // Fire-and-forget Buddy corpus-readiness surface event (surfaceScope:rag).
    // Ready = all deps healthy AND a non-empty corpus → intent:suggesting.
    // Otherwise (deps down or empty corpus) → intent:warning.
    const documentCount = Number(stats.documentCount) || 0;
    if (refreshRequested) {
      if (queryReady && documentCount > 0) {
        buddyRagEvents.indexReady(`RAG index ready: ${documentCount} documents`);
      } else if (!queryReady) {
        buddyRagEvents.corpusNotReady('RAG corpus not ready: a dependency is unavailable');
      } else {
        buddyRagEvents.corpusNotReady('RAG corpus not ready: no documents ingested yet');
      }
    }

    // Embedding cache stats
    const cache = getEmbeddingCache();
    const cacheStats = cache.getStats();

    res.json({
      ok: true,
      data: {
        ...sanitizePublicProjection(stats),
        // Vector-store adapters may expose their own green status in stats.
        // Capability status must instead follow end-to-end query readiness.
        status,
        cache: cacheStats,
        dependencies: sanitizePublicProjection(dependencies),
        // Compatibility: `healthy` has historically meant full query
        // readiness on this capability endpoint, not mere HTTP liveness.
        healthy: queryReady,
        serviceReady,
        queryReady,
        observedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error('Status error:', err);
    sendError(res, 500, 'Status check failed', err.message);
  }
}

// GET is observational and never starts embedding inference or emits readiness
// events. The same-origin/operator-protected POST owns active refresh work.
router.get('/status', handleStatus);
router.post('/status/refresh', handleStatus);

module.exports = router;

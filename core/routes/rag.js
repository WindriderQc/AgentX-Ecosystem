const express = require('express');
const router = express.Router();
const { getRagServiceClient } = require('../src/services/ragServiceClient');
const logger = require('../config/logger');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

const ragClient = getRagServiceClient();

function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function handleError(res, err, context) {
  logger.warn('RAG proxy request failed', {
    context,
    status: err.status || 500,
    code: err.code || 'RAG_PROXY_ERROR',
    message: err.message
  });

  return res.status(err.status || 500).json({
    status: 'error',
    message: err.message,
    code: err.code || 'RAG_PROXY_ERROR',
    detail: err.body?.detail || undefined
  });
}

router.get('/status', async (_req, res) => {
  try {
    const data = await ragClient.getStatus();
    return res.json({
      status: 'success',
      data: {
        ...data,
        observedAt: data?.observedAt || new Date().toISOString()
      }
    });
  } catch (err) {
    return handleError(res, err, 'status');
  }
});

router.post('/status/refresh', async (_req, res) => {
  try {
    const data = await ragClient.refreshStatus();
    return res.json({
      status: 'success',
      data: {
        ...data,
        observedAt: data?.observedAt || new Date().toISOString()
      }
    });
  } catch (err) {
    return handleError(res, err, 'status.refresh');
  }
});

router.get('/metrics', async (_req, res) => {
  try {
    const data = await ragClient.getStatus();
    const totalDocuments = finiteOrNull(data?.documentCount);
    const totalChunks = finiteOrNull(data?.chunkCount);
    const healthy = booleanOrNull(data?.healthy);
    const observedAt = data?.observedAt || new Date().toISOString();

    // The UI has always read stats.sourceBreakdown and this route never sent it,
    // so "Documents by Source" sat on "Loading..." forever. The RAG service has
    // no aggregate endpoint, but /documents returns source + chunkCount per doc,
    // so fold it here. Best-effort: on failure the breakdown stays null and the
    // table renders an honest empty state instead of hanging.
    let sourceBreakdown = null;
    try {
      const listed = await ragClient.listDocuments({ limit: 1000 });
      const docs = Array.isArray(listed?.documents) ? listed.documents : [];
      if (docs.length) {
        sourceBreakdown = docs.reduce((acc, doc) => {
          const key = doc?.source || 'unknown';
          acc[key] ||= { count: 0, chunks: 0, chunksComplete: true };
          acc[key].count += 1;
          const chunkCount = finiteOrNull(doc?.chunkCount);
          if (chunkCount === null) acc[key].chunksComplete = false;
          else acc[key].chunks += chunkCount;
          return acc;
        }, {});
        for (const entry of Object.values(sourceBreakdown)) {
          if (!entry.chunksComplete) entry.chunks = null;
          delete entry.chunksComplete;
        }
      }
    } catch (breakdownErr) {
      logger.warn('RAG source breakdown unavailable', { error: breakdownErr.message });
    }
    return res.json({
      status: 'success',
      // Reachability and dependency health are distinct facts. A successful
      // proxy request must never manufacture a healthy dependency state.
      reachable: true,
      healthy,
      observedAt,
      stats: {
        totalDocuments,
        totalChunks,
        avgChunksPerDoc: totalDocuments !== null && totalDocuments > 0 && totalChunks !== null
          ? Math.round((totalChunks / totalDocuments) * 10) / 10
          : (totalDocuments === 0 && totalChunks !== null ? 0 : null),
        sourceBreakdown,
        // The RAG service records no ingest timestamps, so there is no oldest or
        // newest to report. Explicitly null so the UI says so rather than showing
        // a permanent placeholder that reads like a failed load.
        oldestDocument: null,
        newestDocument: null,
        vectorDimension: finiteOrNull(data?.vectorDimension),
        vectorStore: data?.vectorStore || null
      },
      data
    });
  } catch (err) {
    return handleError(res, err, 'metrics');
  }
});

router.post('/search', async (req, res) => {
  try {
    const results = await ragClient.searchSimilarChunks(req.body?.query, req.body || {});
    return res.json({ status: 'success', data: { results, count: results.length } });
  } catch (err) {
    return handleError(res, err, 'search');
  }
});

router.get('/documents', async (req, res) => {
  try {
    const filters = { ...req.query };
    if (typeof filters.tags === 'string') {
      filters.tags = filters.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    const documents = await ragClient.listDocuments(filters);
    return res.json({ status: 'success', data: documents });
  } catch (err) {
    return handleError(res, err, 'documents.list');
  }
});

router.post('/documents', async (req, res) => {
  try {
    const result = await ragClient.upsertDocumentWithChunks(req.body?.text, req.body || {});
    return res.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(res, err, 'documents.create');
  }
});

router.post('/ingest', async (req, res) => {
  try {
    const result = await ragClient.upsertDocumentWithChunks(req.body?.text, req.body || {});
    return res.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(res, err, 'ingest');
  }
});

router.delete('/documents/:documentId', async (req, res) => {
  try {
    if (!requireTypedConfirmation(req, res, 'DELETE RAG DOCUMENT', req.params.documentId)) return;
    const result = await ragClient.deleteDocument(req.params.documentId);
    return res.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(res, err, 'documents.delete');
  }
});

router.get('/documents/:documentId', async (req, res) => {
  try {
    const data = await ragClient.getDocument(req.params.documentId);
    return res.json({ status: 'success', data });
  } catch (err) {
    return handleError(res, err, 'documents.get');
  }
});

router.get('/documents/:documentId/chunks', async (req, res) => {
  try {
    const data = await ragClient.getDocumentChunks(req.params.documentId);
    return res.json({ status: 'success', data });
  } catch (err) {
    return handleError(res, err, 'documents.chunks');
  }
});

module.exports = router;

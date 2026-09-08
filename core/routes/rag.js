const express = require('express');
const router = express.Router();
const { getRagServiceClient } = require('../src/services/ragServiceClient');
const logger = require('../config/logger');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

const ragClient = getRagServiceClient();

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
    // RAG owns corpus metrics; never reconstruct totals from a document page.
    return res.json({ status: 'success', data: await ragClient.getMetrics() });
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

/**
 * Document Detail Routes — metadata and chunk retrieval.
 *
 * GET /documents/:id        — Get document metadata
 * GET /documents/:id/chunks — Get all chunks for a document
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getRagStore } = require('../src/services/ragStore');
const { sendError } = require('../src/utils/response');

// ── GET /documents/:id ──────────────────────────────────

router.get('/documents/:id', async (req, res) => {
  try {
    const ragStore = getRagStore();
    const doc = await ragStore.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const chunks = await ragStore.getDocumentChunks(req.params.id);

    res.json({
      ok: true,
      data: {
        documentId: doc.documentId,
        source: doc.source,
        chunkCount: chunks.length,
        metadata: { tags: doc.tags, hash: doc.hash }
      }
    });
  } catch (err) {
    logger.error('Get document error:', err);
    sendError(res, 500, 'Failed to get document', err.message);
  }
});

// ── GET /documents/:id/chunks ────────────────────────────

router.get('/documents/:id/chunks', async (req, res) => {
  try {
    const ragStore = getRagStore();
    const doc = await ragStore.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const chunks = await ragStore.getDocumentChunks(req.params.id);

    res.json({
      ok: true,
      data: {
        documentId: doc.documentId,
        chunks: chunks.map(c => ({
          chunkIndex: c.chunkIndex,
          text: c.text,
          metadata: c.metadata || {}
        }))
      }
    });
  } catch (err) {
    logger.error('Get document chunks error:', err);
    sendError(res, 500, 'Failed to get document chunks', err.message);
  }
});

module.exports = router;

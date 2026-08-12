/**
 * Metrics Routes — source breakdown, chunk distribution, last-ingest timestamps.
 *
 * GET /metrics — Totals, per-source breakdown, and last ingest info
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const RagManifest = require('../models/RagManifest');
const { getRagStore } = require('../src/services/ragStore');
const { sendError } = require('../src/utils/response');

// ── GET /metrics ────────────────────────────────────────

router.get('/metrics', async (req, res) => {
  try {
    const ragStore = getRagStore();

    // ── Totals from vector store stats ──
    let totals = { documents: 0, chunks: 0 };
    try {
      const stats = await ragStore.getStats();
      totals.documents = stats.documentCount || 0;
      totals.chunks = stats.chunkCount || 0;
    } catch (err) {
      logger.warn('Metrics: getStats() failed —', err.message);
    }

    // ── Per-source breakdown ──
    let bySource = [];
    try {
      const { documents } = await ragStore.listDocuments({}, { limit: 10000, offset: 0 });
      const sourceMap = new Map();
      for (const doc of documents) {
        const src = doc.source || 'unknown';
        if (!sourceMap.has(src)) {
          sourceMap.set(src, { source: src, documents: 0, chunks: 0 });
        }
        const entry = sourceMap.get(src);
        entry.documents++;
        entry.chunks += doc.chunkCount || 0;
      }
      bySource = Array.from(sourceMap.values());
    } catch (err) {
      logger.warn('Metrics: listDocuments() failed —', err.message);
    }

    // ── Last ingest timestamp from RagManifest ──
    let lastIngest = null;
    try {
      const manifest = await RagManifest.findOne().sort({ updatedAt: -1 }).lean();
      if (manifest) {
        lastIngest = {
          timestamp: manifest.updatedAt || manifest.generatedAt,
          source: manifest.source
        };
      }
    } catch (err) {
      logger.warn('Metrics: RagManifest query failed —', err.message);
    }

    res.json({
      ok: true,
      data: { totals, bySource, lastIngest }
    });
  } catch (err) {
    logger.error('Metrics error:', err);
    sendError(res, 500, 'Metrics retrieval failed', err.message);
  }
});

module.exports = router;

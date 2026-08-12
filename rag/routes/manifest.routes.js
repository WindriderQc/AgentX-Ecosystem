/**
 * Manifest Routes — folder scan snapshots and cleanup operations.
 *
 * POST   /manifests          — Store a folder scan snapshot
 * GET    /manifests/latest   — Get most recent manifest
 * GET    /deletion-preview   — Compare manifest against indexed documents
 * POST   /cleanup            — Delete stale documents (dry-run by default)
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const RagManifest = require('../models/RagManifest');
const { getRagStore } = require('../src/services/ragStore');
const { sendError } = require('../src/utils/response');

const MAX_DELETES_DEFAULT = 100;
const MAX_DELETES_HARD_CAP = 500;

// ── POST /manifests ──────────────────────────────────────

router.post('/manifests', async (req, res) => {
  try {
    const { source, root, scanId, files } = req.body;

    if (!source || typeof source !== 'string') {
      return res.status(400).json({ ok: false, error: 'source is required and must be a string' });
    }
    if (!root || typeof root !== 'string') {
      return res.status(400).json({ ok: false, error: 'root is required and must be a string' });
    }
    if (!Array.isArray(files)) {
      return res.status(400).json({ ok: false, error: 'files must be an array' });
    }

    const stats = {
      fileCount: files.length,
      totalBytes: files.reduce((sum, f) => sum + (f.size || 0), 0)
    };

    const manifest = await RagManifest.findOneAndUpdate(
      { source, root },
      { source, root, scanId, files, stats, generatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      ok: true,
      data: { manifestId: manifest._id, source: manifest.source, stats: manifest.stats }
    });
  } catch (err) {
    logger.error('Create manifest error:', err);
    sendError(res, 500, 'Failed to create manifest', err.message);
  }
});

// ── GET /manifests/latest ────────────────────────────────

router.get('/manifests/latest', async (req, res) => {
  try {
    const query = {};
    if (req.query.source) query.source = req.query.source;

    const manifest = await RagManifest.findOne(query).sort({ generatedAt: -1 }).lean();
    res.json({ ok: true, data: manifest || null });
  } catch (err) {
    logger.error('Get latest manifest error:', err);
    sendError(res, 500, 'Failed to get manifest', err.message);
  }
});

// ── Shared helper ────────────────────────────────────────

async function computeStaleDocs(source, manifestId = null) {
  const manifest = manifestId
    ? await RagManifest.findById(manifestId).lean()
    : await RagManifest.findOne({ source }).sort({ generatedAt: -1 }).lean();
  if (!manifest) return { manifest: null };

  const ragStore = getRagStore();
  const { documents: indexedDocs } = await ragStore.listDocuments({ source });

  const manifestPaths = new Set(manifest.files.map(f => f.path));
  const stale = indexedDocs.filter(doc => !manifestPaths.has(doc.documentId));
  const fresh = indexedDocs.length - stale.length;

  return { manifest, indexedDocs, stale, fresh };
}

// ── GET /deletion-preview ────────────────────────────────

router.get('/deletion-preview', async (req, res) => {
  try {
    const { source } = req.query;

    // Multi-source aggregate when source is omitted
    if (!source) {
      const manifests = await RagManifest.find().lean();
      const ragStore = getRagStore();

      const sources = [];
      let totalStale = 0;

      for (const manifest of manifests) {
        const { documents: indexedDocs } = await ragStore.listDocuments({ source: manifest.source });
        const manifestPaths = new Set(manifest.files.map(f => f.path));
        const staleCount = indexedDocs.filter(doc => !manifestPaths.has(doc.documentId)).length;
        const freshCount = indexedDocs.length - staleCount;

        sources.push({
          source: manifest.source,
          manifestFiles: manifest.files.length,
          indexedDocs: indexedDocs.length,
          staleCount,
          freshCount
        });
        totalStale += staleCount;
      }

      return res.json({ ok: true, data: { sources, totalStale } });
    }

    // Single-source preview (existing behavior)
    const { manifest, indexedDocs, stale, fresh } = await computeStaleDocs(source);
    if (!manifest) {
      return res.json({ ok: true, data: { source, manifestFiles: 0, indexedDocs: 0, stale: [], fresh: 0 } });
    }

    res.json({
      ok: true,
      data: {
        source,
        manifestFiles: manifest.files.length,
        indexedDocs: indexedDocs.length,
        stale,
        fresh
      }
    });
  } catch (err) {
    logger.error('Deletion preview error:', err);
    sendError(res, 500, 'Failed to compute deletion preview', err.message);
  }
});

// ── POST /cleanup ────────────────────────────────────────

router.post('/cleanup', async (req, res) => {
  try {
    const { source, dryRun = true, manifestId = null } = req.body;
    const maxDeletes = Math.min(
      Math.max(Number(req.body.maxDeletes) || MAX_DELETES_DEFAULT, 1),
      MAX_DELETES_HARD_CAP
    );

    if (!source) {
      return res.status(400).json({ ok: false, error: 'source is required' });
    }

    const startTime = Date.now();
    const { manifest, stale } = await computeStaleDocs(source, manifestId);

    if (!manifest) {
      if (manifestId) {
        return res.status(404).json({ ok: false, error: `Manifest "${manifestId}" not found` });
      }
      return res.json({ ok: true, data: { dryRun, deleted: [], errors: [], stats: { attempted: 0, succeeded: 0, failed: 0 } } });
    }

    if (!stale || stale.length === 0) {
      return res.json({
        ok: true,
        data: {
          dryRun,
          manifestId: manifest._id,
          manifestGeneratedAt: manifest.generatedAt,
          deleted: [],
          errors: [],
          stats: { attempted: 0, succeeded: 0, failed: 0 }
        }
      });
    }

    if (dryRun) {
      return res.json({
        ok: true,
        data: {
          dryRun: true,
          manifestId: manifest._id,
          manifestGeneratedAt: manifest.generatedAt,
          staleCount: stale.length,
          documents: stale,
          stats: { attempted: 0, succeeded: 0, failed: 0 }
        }
      });
    }

    // Safety cap — prevent accidental mass deletion in non-dryRun mode
    if (stale.length > maxDeletes) {
      return res.status(400).json({
        ok: false,
        error: `Stale count (${stale.length}) exceeds maxDeletes (${maxDeletes}). Increase maxDeletes or run in batches.`
      });
    }

    // Per-document deletion with error handling
    const ragStore = getRagStore();
    const deleted = [];
    const errors = [];

    for (const doc of stale) {
      try {
        await ragStore.deleteDocument(doc.documentId);
        deleted.push(doc.documentId);
      } catch (err) {
        errors.push({ documentId: doc.documentId, error: err.message });
      }
    }

    const elapsed = Date.now() - startTime;

    res.json({
      ok: true,
      data: {
        dryRun: false,
        manifestId: manifest._id,
        manifestGeneratedAt: manifest.generatedAt,
        deleted,
        errors,
        stats: {
          attempted: stale.length,
          succeeded: deleted.length,
          failed: errors.length,
          elapsedMs: elapsed
        }
      }
    });
  } catch (err) {
    logger.error('Cleanup error:', err);
    sendError(res, 500, 'Cleanup failed', err.message);
  }
});

module.exports = router;

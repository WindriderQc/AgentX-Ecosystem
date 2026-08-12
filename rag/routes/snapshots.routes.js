/**
 * Snapshot Routes — thin proxy to Qdrant's snapshot API.
 *
 * POST   /snapshots              — Create a new snapshot of the collection
 * GET    /snapshots              — List all snapshots for the collection
 * DELETE /snapshots/:name        — Delete a named snapshot
 * POST   /snapshots/:name/restore — Recover the collection from a named snapshot
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const fetchWithTimeout = require('../src/utils/fetchWithTimeout');
const { sendOk, sendError } = require('../src/utils/response');

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'agentx_embeddings';
const SNAPSHOT_TIMEOUT = Number(process.env.QDRANT_SNAPSHOT_TIMEOUT_MS) || 120000;

const baseUrl = () => `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/snapshots`;

function isSafeName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('/')
    && !name.includes('..')
    && /^[a-zA-Z0-9._-]+$/.test(name);
}

// POST /snapshots ────────────────────────────────────────
router.post('/snapshots', async (req, res) => {
  try {
    const qres = await fetchWithTimeout(baseUrl(), { method: 'POST' }, SNAPSHOT_TIMEOUT);
    const body = await qres.json().catch(() => ({}));
    if (!qres.ok) {
      logger.error('Qdrant snapshot create failed', { status: qres.status, body });
      return sendError(res, 502, 'Qdrant snapshot creation failed', JSON.stringify(body));
    }
    logger.info('Qdrant snapshot created', { snapshot: body?.result?.name });
    const result = body.result || {};
    const url = result.name
      ? `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/snapshots/${encodeURIComponent(result.name)}`
      : null;
    return sendOk(res, { ...result, url }, { collection: QDRANT_COLLECTION });
  } catch (err) {
    logger.error('Snapshot create error', { error: err.message });
    return sendError(res, 502, 'Failed to reach Qdrant', err.message);
  }
});

// GET /snapshots ─────────────────────────────────────────
router.get('/snapshots', async (req, res) => {
  try {
    const qres = await fetchWithTimeout(baseUrl(), {}, SNAPSHOT_TIMEOUT);
    const body = await qres.json().catch(() => ({}));
    if (!qres.ok) {
      return sendError(res, 502, 'Qdrant snapshot list failed', JSON.stringify(body));
    }
    return sendOk(res, body.result || [], {
      collection: QDRANT_COLLECTION,
      qdrantUrl: QDRANT_URL,
      root: `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/snapshots`
    });
  } catch (err) {
    logger.error('Snapshot list error', { error: err.message });
    return sendError(res, 502, 'Failed to reach Qdrant', err.message);
  }
});

// DELETE /snapshots/:name ────────────────────────────────
router.delete('/snapshots/:name', async (req, res) => {
  const { name } = req.params;
  if (!isSafeName(name)) {
    return sendError(res, 400, 'Invalid snapshot name');
  }
  try {
    const qres = await fetchWithTimeout(`${baseUrl()}/${encodeURIComponent(name)}`, { method: 'DELETE' }, SNAPSHOT_TIMEOUT);
    const body = await qres.json().catch(() => ({}));
    if (!qres.ok) {
      return sendError(res, qres.status === 404 ? 404 : 502, 'Qdrant snapshot delete failed', JSON.stringify(body));
    }
    logger.info('Qdrant snapshot deleted', { snapshot: name });
    return sendOk(res, { name, deleted: true });
  } catch (err) {
    logger.error('Snapshot delete error', { error: err.message });
    return sendError(res, 502, 'Failed to reach Qdrant', err.message);
  }
});

// POST /snapshots/:name/restore ──────────────────────────
// Uses Qdrant's recover-from-URL feature. Qdrant fetches the snapshot from its
// own HTTP endpoint, which is always reachable to itself.
router.post('/snapshots/:name/restore', async (req, res) => {
  const { name } = req.params;
  if (!isSafeName(name)) {
    return sendError(res, 400, 'Invalid snapshot name');
  }

  const snapshotUrl = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/snapshots/${encodeURIComponent(name)}`;
  const recoverUrl = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/snapshots/recover`;

  try {
    const qres = await fetchWithTimeout(recoverUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: snapshotUrl, priority: 'snapshot' })
    }, SNAPSHOT_TIMEOUT);

    const body = await qres.json().catch(() => ({}));
    if (!qres.ok) {
      logger.error('Qdrant restore failed', { status: qres.status, body });
      return sendError(res, 502, 'Qdrant restore failed', JSON.stringify(body));
    }
    logger.info('Qdrant snapshot restored', { snapshot: name });
    return sendOk(res, { name, restored: true, result: body.result });
  } catch (err) {
    logger.error('Snapshot restore error', { error: err.message });
    return sendError(res, 502, 'Failed to reach Qdrant', err.message);
  }
});

module.exports = router;

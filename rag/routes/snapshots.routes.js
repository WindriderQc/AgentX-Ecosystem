/**
 * Recovery snapshot routes. These are an internal Core↔RAG contract, not a
 * public Qdrant topology API. Every route requires the ephemeral recovery
 * token supplied only to Core and RAG by the launcher.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const fetchWithTimeout = require('../src/utils/fetchWithTimeout');
const {
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredServiceOrigin
} = require('../src/clients/serviceOutboundClient');
const { requireRecoveryToken } = require('../src/middleware/recoveryAuth');
const { sendOk, sendError } = require('../src/utils/response');

const QDRANT_URL = configuredServiceOrigin(process.env.QDRANT_URL || 'http://localhost:6333');
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'agentx_embeddings';
const SNAPSHOT_TIMEOUT = SERVICE_OUTBOUND_TIMEOUTS[
  SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_SNAPSHOT_LIST
];
const OFFLINE_RESTORE_REQUIRED = 'OFFLINE_RESTORE_REQUIRED';

const baseUrl = () => `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/snapshots`;
const outboundContext = (operationId) => ({
  expectedOrigins: [QDRANT_URL],
  operationId
});

function isSafeName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('/')
    && !name.includes('..')
    && /^[a-zA-Z0-9._-]+$/.test(name);
}

function restoreRehearsalEnabled(env = process.env) {
  return String(env.AGENTX_RESTORE_REHEARSAL_ENABLED || '').trim().toLowerCase() === 'true';
}

function projectSnapshot(value) {
  const source = value && typeof value === 'object' ? value : {};
  const projected = {};
  if (isSafeName(source.name)) projected.name = source.name;
  const creationTime = new Date(source.creation_time).getTime();
  if (Number.isFinite(creationTime)) projected.creation_time = new Date(creationTime).toISOString();
  const size = Number(source.size);
  if (Number.isFinite(size) && size >= 0) projected.size = size;
  if (typeof source.checksum === 'string' && /^[a-fA-F0-9]{8,128}$/.test(source.checksum)) {
    projected.checksum = source.checksum;
  }
  return projected;
}

router.use(requireRecoveryToken);

router.post('/snapshots', async (req, res) => {
  try {
    const qres = await fetchWithTimeout(
      baseUrl(),
      { method: 'POST' },
      SNAPSHOT_TIMEOUT,
      outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_SNAPSHOT_CREATE)
    );
    const body = await qres.json().catch(() => ({}));
    if (!qres.ok) {
      logger.error('Qdrant snapshot create failed', { status: qres.status });
      return sendError(res, 502, 'Qdrant snapshot creation failed');
    }
    const result = projectSnapshot(body.result);
    logger.info('Qdrant snapshot created', { snapshot: result.name });
    return sendOk(res, result, { storage: 'qdrant-snapshot-store' });
  } catch (err) {
    logger.error('Snapshot create error', { error: err.message });
    return sendError(res, 502, 'Qdrant snapshot service unavailable');
  }
});

router.get('/snapshots', async (req, res) => {
  try {
    const qres = await fetchWithTimeout(
      baseUrl(),
      {},
      SNAPSHOT_TIMEOUT,
      outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_SNAPSHOT_LIST)
    );
    const body = await qres.json().catch(() => ({}));
    if (!qres.ok) return sendError(res, 502, 'Qdrant snapshot list failed');
    const snapshots = Array.isArray(body.result) ? body.result.map(projectSnapshot) : [];
    return sendOk(res, snapshots, { storage: 'qdrant-snapshot-store' });
  } catch (err) {
    logger.error('Snapshot list error', { error: err.message });
    return sendError(res, 502, 'Qdrant snapshot service unavailable');
  }
});

router.get('/snapshots/:name/download', async (req, res) => {
  const { name } = req.params;
  if (!isSafeName(name)) return sendError(res, 400, 'Invalid snapshot name');

  try {
    const qres = await fetchWithTimeout(
      `${baseUrl()}/${encodeURIComponent(name)}`,
      {},
      SNAPSHOT_TIMEOUT,
      outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_SNAPSHOT_DOWNLOAD)
    );
    if (!qres.ok) {
      return sendError(res, qres.status === 404 ? 404 : 502, 'Qdrant snapshot download failed');
    }
    if (typeof qres.arrayBuffer !== 'function') {
      return sendError(res, 502, 'Qdrant snapshot download failed');
    }
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    return res.end(Buffer.from(await qres.arrayBuffer()));
  } catch (err) {
    logger.error('Snapshot download error', { error: err.message });
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(err);
      return undefined;
    }
    return sendError(res, 502, 'Qdrant snapshot service unavailable');
  }
});

router.delete('/snapshots/:name', async (req, res) => {
  const { name } = req.params;
  if (!isSafeName(name)) return sendError(res, 400, 'Invalid snapshot name');
  const expectedConfirmation = `DELETE ${name}`;
  if (req.get('x-agentx-confirm') !== expectedConfirmation) {
    return res.status(400).json({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error: 'Type the exact snapshot deletion phrase before retrying this destructive operation',
      confirmation: { header: 'X-AgentX-Confirm', expected: expectedConfirmation }
    });
  }
  try {
    const qres = await fetchWithTimeout(
      `${baseUrl()}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      SNAPSHOT_TIMEOUT,
      outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_SNAPSHOT_DELETE)
    );
    if (!qres.ok) {
      return sendError(res, qres.status === 404 ? 404 : 502, 'Qdrant snapshot delete failed');
    }
    logger.info('Qdrant snapshot deleted', { snapshot: name });
    return sendOk(res, { name, deleted: true });
  } catch (err) {
    logger.error('Snapshot delete error', { error: err.message });
    return sendError(res, 502, 'Qdrant snapshot service unavailable');
  }
});

router.post('/snapshots/:name/restore', async (req, res) => {
  if (!restoreRehearsalEnabled()) {
    return res.status(409).json({
      ok: false,
      code: OFFLINE_RESTORE_REQUIRED,
      error: 'Restore requires a controlled offline release rehearsal and is disabled in the running product.'
    });
  }

  const { name } = req.params;
  if (!isSafeName(name)) return sendError(res, 400, 'Invalid snapshot name');
  const expectedConfirmation = `RESTORE ${name}`;
  if (req.get('x-agentx-confirm') !== expectedConfirmation) {
    return res.status(400).json({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error: `Type ${expectedConfirmation} exactly to confirm this destructive operation`
    });
  }

  const snapshotUrl = `${baseUrl()}/${encodeURIComponent(name)}`;
  const recoverUrl = `${baseUrl()}/recover`;
  try {
    const qres = await fetchWithTimeout(
      recoverUrl,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: snapshotUrl, priority: 'snapshot' })
      },
      SNAPSHOT_TIMEOUT,
      outboundContext(SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_SNAPSHOT_RESTORE)
    );
    if (!qres.ok) return sendError(res, 502, 'Qdrant restore failed');
    logger.info('Qdrant snapshot restored during controlled rehearsal', { snapshot: name });
    return sendOk(res, { name, restored: true, mode: 'controlled-rehearsal' });
  } catch (err) {
    logger.error('Snapshot restore error', { error: err.message });
    return sendError(res, 502, 'Qdrant snapshot service unavailable');
  }
});

module.exports = router;
module.exports.projectSnapshot = projectSnapshot;
module.exports.restoreRehearsalEnabled = restoreRehearsalEnabled;
module.exports.OFFLINE_RESTORE_REQUIRED = OFFLINE_RESTORE_REQUIRED;

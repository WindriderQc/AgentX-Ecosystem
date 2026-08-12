/**
 * Operations — Backup / Restore
 *
 * MongoDB dumps, config tarballs, and Qdrant snapshots. Extracted from
 * `routes/operations.js` in task 0190 to keep that file under the 700-line
 * cap. Mounted at `/api/operations` alongside the original; URLs unchanged.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const backupService = require('../src/services/backupService');
const backupScheduler = require('../src/services/backupSchedulerService');
const { requireOperatorAccess } = require('../src/middleware/operatorAccess');

// ========================================
// MongoDB backup / restore
// ========================================

/**
 * GET /api/operations/backup/config
 * Return current effective backup configuration (BACKUP_DIR, retention, etc.)
 */
router.get('/backup/config', (req, res) => {
  try {
    const config = {
      ...backupService.getConfig(),
      schedule: backupScheduler.getStatus()
    };
    res.json({ status: 'success', config });
  } catch (error) {
    logger.error('Failed to read backup config', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * PATCH /api/operations/backup/config
 * Update runtime-configurable backup settings (retentionDays).
 * BACKUP_DIR remains env-only and requires restart to change.
 */
router.patch('/backup/config', requireOperatorAccess, express.json(), (req, res) => {
  try {
    const config = backupService.setConfig(req.body || {});
    res.json({ status: 'success', config });
  } catch (error) {
    const status = error.code === 'INVALID' ? 400 : 500;
    logger.error('Failed to update backup config', { error: error.message });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/operations/backup
 * Trigger a new MongoDB backup via mongodump
 */
router.post('/backup', requireOperatorAccess, async (req, res) => {
  try {
    const result = await backupService.createBackup();
    res.json({ status: 'success', backup: result });
  } catch (error) {
    const status = error.code === 'BUSY' ? 409 : 500;
    logger.error('Backup failed', { error: error.message });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/operations/backups
 * List available backups
 */
router.get('/backups', (req, res) => {
  try {
    const backups = backupService.listBackups();
    res.json({ status: 'success', backups, total: backups.length, root: backupService.BACKUP_DIR });
  } catch (error) {
    logger.error('Failed to list backups', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/operations/restore/:backupName
 * Restore from a named backup (requires ?confirm=true)
 */
router.post('/restore/:backupName', requireOperatorAccess, async (req, res) => {
  const { backupName } = req.params;

  // Validate backup name
  const validation = backupService.validateBackupName(backupName);
  if (!validation.valid) {
    return res.status(400).json({ status: 'error', message: validation.reason });
  }

  // Safety: require ?confirm=true
  if (req.query.confirm !== 'true') {
    return res.status(400).json({
      status: 'error',
      message: 'Restore requires ?confirm=true query parameter as safety confirmation'
    });
  }

  try {
    const result = await backupService.restoreBackup(backupName);
    res.json({ status: 'success', restore: result });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404, BUSY: 409 };
    const status = statusMap[error.code] || 500;
    logger.error('Restore failed', { error: error.message, backupName });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

/**
 * DELETE /api/operations/backups/:backupName
 * Delete a named backup
 */
router.delete('/backups/:backupName', requireOperatorAccess, (req, res) => {
  const { backupName } = req.params;

  try {
    const result = backupService.deleteBackup(backupName);
    res.json({ status: 'success', deleted: result });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 500;
    logger.error('Delete backup failed', { error: error.message, backupName });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

// ========================================
// Config backups (ecosystem.config.js + .env files + crontab + openclaw)
// ========================================

/**
 * POST /api/operations/config/backup
 * Tar ecosystem config, .env files, crontab, openclaw jobs.json
 */
router.post('/config/backup', requireOperatorAccess, async (req, res) => {
  try {
    const result = await backupService.createConfigBackup();
    res.json({ status: 'success', backup: result });
  } catch (error) {
    const statusMap = { BUSY: 409, EMPTY: 400 };
    const status = statusMap[error.code] || 500;
    logger.error('Config backup failed', { error: error.message });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/operations/config/backups
 * List available config tarballs
 */
router.get('/config/backups', (req, res) => {
  try {
    const backups = backupService.listConfigBackups();
    res.json({ status: 'success', backups, total: backups.length, root: backupService.BACKUP_DIR });
  } catch (error) {
    logger.error('Failed to list config backups', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * DELETE /api/operations/config/backups/:name
 * Delete a named config backup
 */
router.delete('/config/backups/:name', requireOperatorAccess, (req, res) => {
  const { name } = req.params;
  try {
    const result = backupService.deleteConfigBackup(name);
    res.json({ status: 'success', deleted: result });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 500;
    logger.error('Delete config backup failed', { error: error.message, name });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

// ========================================
// Qdrant snapshots (proxied via RAG)
// ========================================

/**
 * POST /api/operations/qdrant/backup
 * Trigger a new Qdrant collection snapshot
 */
router.post('/qdrant/backup', requireOperatorAccess, async (req, res) => {
  try {
    const result = await backupService.createQdrantBackup();
    res.json({ status: 'success', snapshot: result });
  } catch (error) {
    logger.error('Qdrant backup failed', { error: error.message });
    res.status(502).json({ status: 'error', message: error.message, detail: error.detail });
  }
});

/**
 * GET /api/operations/qdrant/backups
 * List available Qdrant snapshots
 */
router.get('/qdrant/backups', async (req, res) => {
  try {
    const { snapshots, meta } = await backupService.listQdrantBackups();
    res.json({
      status: 'success',
      snapshots,
      total: snapshots.length,
      root: meta.root || null,
      collection: meta.collection || null
    });
  } catch (error) {
    logger.error('Qdrant list failed', { error: error.message });
    res.status(502).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/operations/qdrant/restore/:snapshotName
 * Restore Qdrant collection from a named snapshot (requires ?confirm=true)
 */
router.post('/qdrant/restore/:snapshotName', requireOperatorAccess, async (req, res) => {
  const { snapshotName } = req.params;

  if (req.query.confirm !== 'true') {
    return res.status(400).json({
      status: 'error',
      message: 'Restore requires ?confirm=true query parameter as safety confirmation'
    });
  }

  try {
    const result = await backupService.restoreQdrantBackup(snapshotName);
    res.json({ status: 'success', restore: result });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 502;
    logger.error('Qdrant restore failed', { error: error.message, snapshotName });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

/**
 * DELETE /api/operations/qdrant/backups/:snapshotName
 * Delete a named Qdrant snapshot
 */
router.delete('/qdrant/backups/:snapshotName', requireOperatorAccess, async (req, res) => {
  const { snapshotName } = req.params;

  try {
    const result = await backupService.deleteQdrantBackup(snapshotName);
    res.json({ status: 'success', deleted: result });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 502;
    logger.error('Qdrant delete failed', { error: error.message, snapshotName });
    res.status(status).json({ status: 'error', message: error.message });
  }
});

module.exports = router;

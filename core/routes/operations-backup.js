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
const { projectBackupPolicy, summarizeInventory } = require('../src/services/backupEvidenceService');
const {
  projectArtifacts,
  projectBackupConfig,
  projectCreatedArtifact,
  projectCreatedConfig,
  projectCreatedQdrant,
  projectInventoryEvidence,
  projectMutationResult,
  projectRestorePolicy
} = require('../src/services/backupPublicProjection');
const { requireOperatorUiAccess } = require('../src/middleware/operatorAccess');

function currentRestorePolicy() {
  return projectRestorePolicy(
    typeof backupService.getRestorePolicy === 'function'
      ? backupService.getRestorePolicy()
      : { enabled: false }
  );
}

function currentBackupConfig() {
  const schedule = backupScheduler.getStatus();
  const config = backupService.getConfig();
  const policyEvidence = projectBackupPolicy(config, schedule);
  return projectBackupConfig(config, policyEvidence, currentRestorePolicy());
}

function inventoryEvidence(items, options, kind) {
  const policy = projectBackupPolicy(backupService.getConfig(), backupScheduler.getStatus());
  const evidence = {
    inventory: summarizeInventory(items, options, policy.observedAt),
    retention: policy.retention,
    growthRisk: policy.growthRisk,
    observedAt: policy.observedAt
  };
  return projectInventoryEvidence(evidence, kind);
}

function requireRestoreRehearsal(res) {
  const restorePolicy = currentRestorePolicy();
  if (restorePolicy.enabled) return true;
  res.status(409).json({
    status: 'error',
    code: 'OFFLINE_RESTORE_REQUIRED',
    message: restorePolicy.message,
    restorePolicy
  });
  return false;
}

function requireTypedConfirmation(req, res, action, name) {
  const expected = `${action} ${name}`;
  if (req.get('x-agentx-confirm') === expected) return true;
  res.status(400).json({
    status: 'error',
    code: 'CONFIRMATION_REQUIRED',
    message: `Type ${expected} exactly to confirm this destructive operation`,
    confirmation: { header: 'X-AgentX-Confirm', expected }
  });
  return false;
}

// ========================================
// MongoDB backup / restore
// ========================================

/**
 * GET /api/operations/backup/config
 * Return the safe logical recovery policy. Internal paths and endpoints are
 * deliberately not part of this public projection.
 */
router.get('/backup/config', (req, res) => {
  try {
    const config = currentBackupConfig();
    res.json({ status: 'success', config });
  } catch (error) {
    logger.error('Failed to read backup config', { error: error.message });
    res.status(500).json({ status: 'error', code: 'RECOVERY_CONFIG_UNAVAILABLE', message: 'Recovery policy is unavailable.' });
  }
});

/**
 * PATCH /api/operations/backup/config
 * Update runtime-configurable backup settings (retentionDays).
 * Recovery storage remains deployment-owned and is not runtime-editable.
 */
router.patch('/backup/config', requireOperatorUiAccess, express.json(), (req, res) => {
  try {
    backupService.setConfig(req.body || {});
    const config = currentBackupConfig();
    res.json({ status: 'success', config });
  } catch (error) {
    const status = error.code === 'INVALID' ? 400 : 500;
    logger.error('Failed to update backup config', { error: error.message });
    res.status(status).json({ status: 'error', code: error.code || 'RECOVERY_CONFIG_UPDATE_FAILED', message: status === 400 ? 'Retention must be a non-negative number of days.' : 'Recovery policy update failed.' });
  }
});

/**
 * POST /api/operations/backup
 * Trigger a new MongoDB backup via mongodump
 */
router.post('/backup', requireOperatorUiAccess, async (req, res) => {
  try {
    const result = await backupService.createBackup();
    res.json({ status: 'success', backup: projectCreatedArtifact(result) });
  } catch (error) {
    const status = error.code === 'BUSY' ? 409 : 500;
    logger.error('Backup failed', { error: error.message });
    res.status(status).json({ status: 'error', code: error.code || 'BACKUP_CREATE_FAILED', message: status === 409 ? 'Another recovery operation is already running.' : 'MongoDB backup creation failed.' });
  }
});

/**
 * GET /api/operations/backups
 * List available backups
 */
router.get('/backups', (req, res) => {
  try {
    const backups = backupService.listBackups();
    const projected = projectArtifacts(backups);
    const evidence = inventoryEvidence(projected, {
      authority: 'core.backup-inventory.mongo',
      source: 'Persistent recovery inventory',
      scope: 'Complete recognized MongoDB recovery inventory'
    }, 'mongo');
    res.json({ status: 'success', backups: projected, total: projected.length, storage: 'persistent-recovery-storage', evidence });
  } catch (error) {
    logger.error('Failed to list backups', { error: error.message });
    res.status(500).json({ status: 'error', code: 'BACKUP_LIST_FAILED', message: 'MongoDB recovery inventory is unavailable.' });
  }
});

/**
 * POST /api/operations/restore/:backupName
 * Restore from a named backup (requires an exact typed confirmation header)
 */
router.post('/restore/:backupName', requireOperatorUiAccess, async (req, res) => {
  const { backupName } = req.params;

  if (!requireRestoreRehearsal(res)) return;

  // Validate backup name
  const validation = backupService.validateBackupName(backupName);
  if (!validation.valid) {
    return res.status(400).json({ status: 'error', message: validation.reason });
  }

  if (!requireTypedConfirmation(req, res, 'RESTORE', backupName)) return;

  try {
    const result = await backupService.restoreBackup(backupName);
    res.json({ status: 'success', restore: projectMutationResult(result, { restored: true, mode: 'controlled-rehearsal' }) });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404, BUSY: 409 };
    const status = statusMap[error.code] || 500;
    logger.error('Restore failed', { error: error.message, backupName });
    res.status(status).json({ status: 'error', code: error.code || 'RESTORE_FAILED', message: status === 404 ? 'Recovery artifact not found.' : 'Controlled restore rehearsal failed.' });
  }
});

/**
 * DELETE /api/operations/backups/:backupName
 * Delete a named backup
 */
router.delete('/backups/:backupName', requireOperatorUiAccess, (req, res) => {
  const { backupName } = req.params;

  const validation = backupService.validateBackupName(backupName);
  if (!validation.valid) {
    return res.status(400).json({ status: 'error', message: validation.reason });
  }
  if (!requireTypedConfirmation(req, res, 'DELETE', backupName)) return;

  try {
    const result = backupService.deleteBackup(backupName);
    res.json({ status: 'success', deleted: projectMutationResult(result, { deleted: true }) });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 500;
    logger.error('Delete backup failed', { error: error.message, backupName });
    res.status(status).json({ status: 'error', code: error.code || 'BACKUP_DELETE_FAILED', message: status === 404 ? 'Recovery artifact not found.' : 'Recovery artifact deletion failed.' });
  }
});

// ========================================
// Product configuration backups
// ========================================

/**
 * POST /api/operations/config/backup
 * Archive the bounded product configuration sources.
 */
router.post('/config/backup', requireOperatorUiAccess, async (req, res) => {
  try {
    const result = await backupService.createConfigBackup();
    res.json({ status: 'success', backup: projectCreatedConfig(result) });
  } catch (error) {
    const statusMap = { BUSY: 409, EMPTY: 400 };
    const status = statusMap[error.code] || 500;
    logger.error('Config backup failed', { error: error.message });
    res.status(status).json({ status: 'error', code: error.code || 'CONFIG_BACKUP_FAILED', message: status === 400 ? 'No supported product configuration sources were available.' : status === 409 ? 'Another recovery operation is already running.' : 'Configuration backup creation failed.' });
  }
});

/**
 * GET /api/operations/config/backups
 * List available config tarballs
 */
router.get('/config/backups', (req, res) => {
  try {
    const backups = backupService.listConfigBackups();
    const projected = projectArtifacts(backups);
    const evidence = inventoryEvidence(projected, {
      authority: 'core.backup-inventory.config',
      source: 'Persistent recovery inventory',
      scope: 'Complete recognized configuration recovery inventory'
    }, 'config');
    res.json({ status: 'success', backups: projected, total: projected.length, storage: 'persistent-recovery-storage', evidence });
  } catch (error) {
    logger.error('Failed to list config backups', { error: error.message });
    res.status(500).json({ status: 'error', code: 'CONFIG_BACKUP_LIST_FAILED', message: 'Configuration recovery inventory is unavailable.' });
  }
});

/**
 * DELETE /api/operations/config/backups/:name
 * Delete a named config backup
 */
router.delete('/config/backups/:name', requireOperatorUiAccess, (req, res) => {
  const { name } = req.params;
  const validation = backupService.validateBackupName(name);
  if (!validation.valid) {
    return res.status(400).json({ status: 'error', code: 'INVALID_NAME', message: 'Invalid recovery artifact name.' });
  }
  if (!requireTypedConfirmation(req, res, 'DELETE', name)) return;
  try {
    const result = backupService.deleteConfigBackup(name);
    res.json({ status: 'success', deleted: projectMutationResult(result, { deleted: true }) });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 500;
    logger.error('Delete config backup failed', { error: error.message, name });
    res.status(status).json({ status: 'error', code: error.code || 'CONFIG_BACKUP_DELETE_FAILED', message: status === 404 ? 'Recovery artifact not found.' : 'Configuration recovery artifact deletion failed.' });
  }
});

// ========================================
// Qdrant snapshots (proxied via RAG)
// ========================================

/**
 * POST /api/operations/qdrant/backup
 * Trigger a new Qdrant collection snapshot
 */
router.post('/qdrant/backup', requireOperatorUiAccess, async (req, res) => {
  try {
    const result = await backupService.createQdrantBackup();
    res.json({ status: 'success', snapshot: projectCreatedQdrant(result) });
  } catch (error) {
    logger.error('Qdrant backup failed', { error: error.message });
    res.status(502).json({ status: 'error', code: error.code || 'SNAPSHOT_CREATE_FAILED', message: 'Qdrant snapshot creation is unavailable.' });
  }
});

/**
 * GET /api/operations/qdrant/backups
 * List available Qdrant snapshots
 */
router.get('/qdrant/backups', async (req, res) => {
  try {
    const { snapshots } = await backupService.listQdrantBackups();
    const projected = projectArtifacts(snapshots, 'creation_time');
    const evidence = inventoryEvidence(projected, {
      authority: 'core.backup-inventory.qdrant',
      source: 'Internal recovery snapshot inventory',
      scope: 'Complete recognized Qdrant recovery inventory',
      dateField: 'creation_time'
    }, 'qdrant');
    res.json({
      status: 'success',
      snapshots: projected,
      total: projected.length,
      storage: 'qdrant-snapshot-store',
      evidence
    });
  } catch (error) {
    logger.error('Qdrant list failed', { error: error.message });
    res.status(502).json({ status: 'error', code: error.code || 'SNAPSHOT_LIST_FAILED', message: 'Qdrant snapshot inventory is unavailable.' });
  }
});

/**
 * POST /api/operations/qdrant/restore/:snapshotName
 * Restore Qdrant collection from a named snapshot (requires an exact typed confirmation header)
 */
router.post('/qdrant/restore/:snapshotName', requireOperatorUiAccess, async (req, res) => {
  const { snapshotName } = req.params;

  if (!requireRestoreRehearsal(res)) return;

  const validation = backupService.validateBackupName(snapshotName);
  if (!validation.valid) {
    return res.status(400).json({ status: 'error', code: 'INVALID_NAME', message: 'Invalid recovery snapshot name.' });
  }

  if (!requireTypedConfirmation(req, res, 'RESTORE', snapshotName)) return;

  try {
    const result = await backupService.restoreQdrantBackup(snapshotName);
    res.json({ status: 'success', restore: projectMutationResult(result, { restored: true, mode: 'controlled-rehearsal' }) });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 502;
    logger.error('Qdrant restore failed', { error: error.message, snapshotName });
    res.status(status).json({ status: 'error', code: error.code || 'RESTORE_FAILED', message: status === 404 ? 'Recovery snapshot not found.' : 'Controlled restore rehearsal failed.' });
  }
});

/**
 * DELETE /api/operations/qdrant/backups/:snapshotName
 * Delete a named Qdrant snapshot
 */
router.delete('/qdrant/backups/:snapshotName', requireOperatorUiAccess, async (req, res) => {
  const { snapshotName } = req.params;

  const validation = backupService.validateBackupName(snapshotName);
  if (!validation.valid) {
    return res.status(400).json({ status: 'error', code: 'INVALID_NAME', message: 'Invalid recovery snapshot name.' });
  }

  if (!requireTypedConfirmation(req, res, 'DELETE', snapshotName)) return;

  try {
    const result = await backupService.deleteQdrantBackup(snapshotName);
    res.json({ status: 'success', deleted: projectMutationResult(result, { deleted: true }) });
  } catch (error) {
    const statusMap = { INVALID_NAME: 400, NOT_FOUND: 404 };
    const status = statusMap[error.code] || 502;
    logger.error('Qdrant delete failed', { error: error.message, snapshotName });
    res.status(status).json({ status: 'error', code: error.code || 'SNAPSHOT_DELETE_FAILED', message: status === 404 ? 'Recovery snapshot not found.' : 'Recovery snapshot deletion failed.' });
  }
});

module.exports = router;

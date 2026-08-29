/**
 * Backup/Restore Service
 *
 * MongoDB — uses mongodump/mongorestore via execFile (no shell injection risk).
 * Qdrant — delegates to the RAG service's /api/rag/snapshots proxy.
 * Backup directory defaults to ../backups/ relative to core/. The supported
 * Docker runtime mounts a dedicated named recovery volume at /backups.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');
const logger = require('../../config/logger');

const DEFAULT_BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : DEFAULT_BACKUP_DIR;
const QDRANT_LOCAL_DIR = path.join(BACKUP_DIR, 'qdrant');
const DEFAULT_ECOSYSTEM_ROOT = path.resolve(__dirname, '..', '..', '..');
const ECOSYSTEM_ROOT = process.env.BACKUP_CONFIG_ROOT
  ? path.resolve(process.env.BACKUP_CONFIG_ROOT)
  : DEFAULT_ECOSYSTEM_ROOT;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx';
const RAG_URL = process.env.RAG_SERVICE_URL || 'http://localhost:3082';
const QDRANT_FETCH_TIMEOUT = Number(process.env.QDRANT_SNAPSHOT_TIMEOUT_MS) || 120000;
const DEFAULT_RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30); // 0 = keep forever
const RUNTIME_CONFIG_FILE = path.join(BACKUP_DIR, '.backup-config.json');
const OFFLINE_RESTORE_REQUIRED = 'OFFLINE_RESTORE_REQUIRED';

const PRODUCT_CONFIG_SOURCES = Object.freeze([
  'docker-compose.yml',
  'docker-compose.ollama.yml',
  'config/agentx.env',
  'config/rag-ingestion-policy.json',
  'config/product-surfaces.json',
  'config/adapter-consumer-contracts.json',
  'config/container-image-pins.json'
]);

function restoreRehearsalEnabled(env = process.env) {
  return String(env.AGENTX_RESTORE_REHEARSAL_ENABLED || '').trim().toLowerCase() === 'true';
}

function getRestorePolicy(env = process.env) {
  const enabled = restoreRehearsalEnabled(env);
  return {
    enabled,
    mode: enabled ? 'controlled-rehearsal' : 'offline-rehearsal-required',
    code: enabled ? null : OFFLINE_RESTORE_REQUIRED,
    message: enabled
      ? 'Restore is enabled only for a controlled, offline release rehearsal.'
      : 'Restore requires a controlled offline release rehearsal and is disabled in the running product.',
    coherentRecoverySetVerified: false
  };
}

function assertRestoreRehearsalEnabled() {
  if (restoreRehearsalEnabled()) return;
  throw Object.assign(new Error(getRestorePolicy().message), { code: OFFLINE_RESTORE_REQUIRED });
}

function parseOwnerId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

const BACKUP_OWNER_UID = parseOwnerId(process.env.BACKUP_OWNER_UID);
const BACKUP_OWNER_GID = parseOwnerId(process.env.BACKUP_OWNER_GID);

function secureBackupPath(target, mode) {
  try {
    if (BACKUP_OWNER_UID !== null || BACKUP_OWNER_GID !== null) {
      const stat = fs.statSync(target);
      fs.chownSync(
        target,
        BACKUP_OWNER_UID === null ? stat.uid : BACKUP_OWNER_UID,
        BACKUP_OWNER_GID === null ? stat.gid : BACKUP_OWNER_GID
      );
    }
  } catch { /* unsupported filesystem ownership or insufficient rights */ }
  try { fs.chmodSync(target, mode); } catch { /* platform/mount limitation */ }
}

/**
 * Load runtime config overrides from disk, layered over env defaults.
 */
function getConfig() {
  let override = {};
  try {
    if (fs.existsSync(RUNTIME_CONFIG_FILE)) {
      override = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    logger.warn('Failed to read runtime backup config, using defaults', { error: err.message });
  }
  const retentionDays = Number.isFinite(override.retentionDays)
    ? override.retentionDays
    : DEFAULT_RETENTION_DAYS;
  return {
    backupDir: BACKUP_DIR,
    qdrantLocalDir: QDRANT_LOCAL_DIR,
    retentionDays,
    retentionDaysSource: Number.isFinite(override.retentionDays) ? 'runtime' : (process.env.BACKUP_RETENTION_DAYS ? 'env' : 'default'),
    backupDirSource: process.env.BACKUP_DIR ? 'env' : 'default',
    configRoot: ECOSYSTEM_ROOT,
    configSources: [...PRODUCT_CONFIG_SOURCES],
    ownerUid: BACKUP_OWNER_UID,
    ownerGid: BACKUP_OWNER_GID,
    mongoUri: MONGO_URI,
    ragUrl: RAG_URL
  };
}

/**
 * Persist runtime config overrides. Only whitelisted keys are written.
 */
function setConfig(partial) {
  ensureBackupDir();
  const allowed = {};
  if (partial && Number.isFinite(Number(partial.retentionDays))) {
    const n = Number(partial.retentionDays);
    if (n < 0) throw Object.assign(new Error('retentionDays must be >= 0'), { code: 'INVALID' });
    allowed.retentionDays = Math.floor(n);
  }
  let existing = {};
  try {
    if (fs.existsSync(RUNTIME_CONFIG_FILE)) {
      existing = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
    }
  } catch { /* fresh config */ }
  const merged = { ...existing, ...allowed };
  fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  secureBackupPath(RUNTIME_CONFIG_FILE, 0o600);
  logger.info('Backup config updated', { merged });
  return getConfig();
}

// Simple in-memory mutex to prevent concurrent backup/restore
let operationInProgress = null;

/**
 * Validate a backup name against path traversal.
 * Must not contain "..", "/", or "\".
 */
function validateBackupName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, reason: 'Backup name is required' };
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return { valid: false, reason: 'Invalid backup name: path traversal characters not allowed' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { valid: false, reason: 'Invalid backup name: only alphanumeric, dot, dash, underscore allowed' };
  }
  return { valid: true };
}

function validateMongoBackupName(name) {
  const validation = validateBackupName(name);
  if (!validation.valid) return validation;
  if (!/^agentx-[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\.tar\.gz)?$/.test(name)) {
    return { valid: false, reason: 'Invalid MongoDB recovery artifact name' };
  }
  return { valid: true };
}

function validateConfigBackupName(name) {
  const validation = validateBackupName(name);
  if (!validation.valid) return validation;
  if (!/^config-[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar\.gz$/.test(name)) {
    return { valid: false, reason: 'Invalid configuration recovery artifact name' };
  }
  return { valid: true };
}

function validateQdrantSnapshotName(name) {
  const validation = validateBackupName(name);
  if (!validation.valid) return validation;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.snapshot$/.test(name)) {
    return { valid: false, reason: 'Invalid Qdrant recovery snapshot name' };
  }
  return { valid: true };
}

/**
 * Parse the MongoDB URI to extract host, port, and database name.
 */
function parseMongoUri(uri) {
  try {
    const url = new URL(uri);
    const host = url.hostname || '127.0.0.1';
    const port = url.port || '27017';
    const db = url.pathname.replace(/^\//, '') || 'agentx';
    return { host, port, db };
  } catch {
    return { host: 'mongo', port: '27017', db: 'agentx' };
  }
}

/**
 * Ensure the backup directory (and qdrant subdirectory) exist.
 */
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    logger.info('Created backup directory', { path: BACKUP_DIR });
  }
  if (!fs.existsSync(QDRANT_LOCAL_DIR)) {
    fs.mkdirSync(QDRANT_LOCAL_DIR, { recursive: true, mode: 0o700 });
  }
  // Best effort: ownership makes secure volume export possible while 0700/0600
  // protects artifacts. Some host filesystems may ignore POSIX ownership.
  secureBackupPath(BACKUP_DIR, 0o700);
  secureBackupPath(QDRANT_LOCAL_DIR, 0o700);

  // Repair artifacts created before ownership mapping was configured. Limit
  // the sweep to the service's known archive patterns.
  for (const [dir, pattern] of [
    [BACKUP_DIR, /^(?:agentx-|config-).*\.tar\.gz$|^\.backup-config\.json$/],
    [QDRANT_LOCAL_DIR, /\.snapshot$/]
  ]) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && pattern.test(entry.name)) {
          secureBackupPath(path.join(dir, entry.name), 0o600);
        }
      }
    } catch { /* directory may be concurrently unavailable */ }
  }
}

/**
 * Prune entries older than RETENTION_DAYS from a directory.
 * matchFn(entry) decides which entries are subject to pruning.
 */
function pruneOld(dir, matchFn) {
  const { retentionDays } = getConfig();
  if (!retentionDays || retentionDays <= 0) return [];
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  const pruned = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!matchFn(entry)) continue;
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        pruned.push(entry.name);
      }
    }
    if (pruned.length) logger.info('Pruned old backups', { dir, count: pruned.length, names: pruned });
  } catch (err) {
    logger.warn('Prune failed', { dir, error: err.message });
  }
  return pruned;
}

/**
 * Get directory size in bytes (recursive).
 */
function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += getDirSize(fullPath);
      } else {
        totalSize += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Directory may not be readable
  }
  return totalSize;
}

/**
 * Run execFile as a promise.
 */
function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Create a new MongoDB backup using mongodump, compressed to .tar.gz.
 * Prunes old backups beyond retention window.
 */
async function createBackup() {
  if (operationInProgress) {
    throw Object.assign(new Error(`Another operation is in progress: ${operationInProgress}`), { code: 'BUSY' });
  }

  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const baseName = `agentx-${timestamp}`;
  const workDir = path.join(BACKUP_DIR, baseName);
  const tarName = `${baseName}.tar.gz`;
  const tarPath = path.join(BACKUP_DIR, tarName);
  const { host, port, db } = parseMongoUri(MONGO_URI);
  let completed = false;

  operationInProgress = `backup:${tarName}`;
  logger.info('Starting MongoDB backup', { tarName, host, port, db });

  try {
    await execFileAsync('mongodump', [
      '--host', host,
      '--port', port,
      '--db', db,
      '--out', workDir
    ]);

    // Compress then remove uncompressed dump
    await execFileAsync('tar', ['-czf', tarPath, '-C', BACKUP_DIR, baseName]);
    fs.rmSync(workDir, { recursive: true, force: true });

    const size = fs.statSync(tarPath).size;
    secureBackupPath(tarPath, 0o600);
    logger.info('MongoDB backup completed', { tarName, size });

    const pruned = pruneOld(BACKUP_DIR, (e) => e.isFile() && /^agentx-.*\.tar\.gz$/.test(e.name));
    completed = true;

    return {
      name: tarName,
      path: tarPath,
      size,
      timestamp: new Date().toISOString(),
      pruned
    };
  } finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    if (!completed && fs.existsSync(tarPath)) fs.rmSync(tarPath, { force: true });
    operationInProgress = null;
  }
}

// ============================================================
// Config — tarball of bounded product configuration files
// ============================================================

async function createConfigBackup() {
  if (operationInProgress) {
    throw Object.assign(new Error(`Another operation is in progress: ${operationInProgress}`), { code: 'BUSY' });
  }

  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const tarName = `config-${timestamp}.tar.gz`;
  const tarPath = path.join(BACKUP_DIR, tarName);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-config-'));

  operationInProgress = `config-backup:${tarName}`;
  logger.info('Starting config backup', { tarName });

  try {
    const included = [];

    // This is intentionally an exact product-owned, secret-free allowlist.
    // Runtime env files, private adapters, crontabs, data, and secrets are
    // never discovered or archived.
    for (const rel of PRODUCT_CONFIG_SOURCES) {
      const src = path.join(ECOSYSTEM_ROOT, rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(stagingDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      included.push(rel);
    }

    if (included.length === 0) {
      throw Object.assign(new Error('No config files found to backup'), { code: 'EMPTY' });
    }

    // tar -czf tarPath -C stagingDir .
    await execFileAsync('tar', ['-czf', tarPath, '-C', stagingDir, '.']);

    const size = fs.statSync(tarPath).size;
    secureBackupPath(tarPath, 0o600);
    logger.info('Config backup completed', { tarName, size, included });

    const pruned = pruneOld(BACKUP_DIR, (e) => e.isFile() && /^config-.*\.tar\.gz$/.test(e.name));

    return {
      name: tarName,
      path: tarPath,
      size,
      timestamp: new Date().toISOString(),
      includes: included,
      pruned
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    operationInProgress = null;
  }
}

function listConfigBackups() {
  ensureBackupDir();
  try {
    const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.startsWith('config-') && e.name.endsWith('.tar.gz'))
      .map(e => {
        const fullPath = path.join(BACKUP_DIR, e.name);
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          date: stat.mtime.toISOString(),
          size: stat.size,
          path: fullPath
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch (err) {
    logger.error('Failed to list config backups', { error: err.message });
    return [];
  }
}

function deleteConfigBackup(name) {
  const validation = validateConfigBackupName(name);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.reason), { code: 'INVALID_NAME' });
  }
  const target = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(target)) {
    throw Object.assign(new Error(`Config backup not found: ${name}`), { code: 'NOT_FOUND' });
  }
  const resolved = path.resolve(target);
  if (!resolved.startsWith(BACKUP_DIR + path.sep) && resolved !== BACKUP_DIR) {
    throw Object.assign(new Error('Invalid backup path'), { code: 'INVALID_NAME' });
  }
  if (!fs.lstatSync(target).isFile()) {
    throw Object.assign(new Error('Configuration recovery artifact must be a regular file'), { code: 'INVALID_NAME' });
  }
  fs.rmSync(target, { force: true });
  logger.info('Config backup deleted', { name });
  return { name, deleted: true };
}

// ============================================================
// Qdrant — snapshots proxied through the RAG service
// ============================================================

async function ragFetch(pathSuffix, options = {}) {
  const recoveryToken = String(process.env.AGENTX_RECOVERY_TOKEN || '').trim();
  const operatorToken = String(process.env.AGENTX_OPERATOR_TOKEN || '').trim();
  if (!recoveryToken) {
    throw Object.assign(new Error('Recovery snapshot authorization is not configured'), {
      code: 'RECOVERY_AUTH_REQUIRED'
    });
  }
  const url = `${RAG_URL}/api/rag${pathSuffix}`;
  const resp = await fetch(url, {
    timeout: QDRANT_FETCH_TIMEOUT,
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-AgentX-Recovery-Token': recoveryToken,
      ...(operatorToken ? { 'X-AgentX-Operator-Token': operatorToken } : {})
    }
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.ok === false) {
    const msg = body.error || `RAG ${options.method || 'GET'} ${pathSuffix} failed (${resp.status})`;
    const err = new Error(msg);
    err.code = resp.status === 404 ? 'NOT_FOUND' : 'RAG_ERROR';
    err.detail = body.detail;
    throw err;
  }
  return { data: body.data, meta: body.meta || {} };
}

async function downloadQdrantSnapshot(snapshotName) {
  const recoveryToken = String(process.env.AGENTX_RECOVERY_TOKEN || '').trim();
  const operatorToken = String(process.env.AGENTX_OPERATOR_TOKEN || '').trim();
  if (!recoveryToken) {
    throw Object.assign(new Error('Recovery snapshot authorization is not configured'), {
      code: 'RECOVERY_AUTH_REQUIRED'
    });
  }
  const resp = await fetch(`${RAG_URL}/api/rag/snapshots/${encodeURIComponent(snapshotName)}/download`, {
    timeout: QDRANT_FETCH_TIMEOUT,
    headers: {
      'X-AgentX-Recovery-Token': recoveryToken,
      ...(operatorToken ? { 'X-AgentX-Operator-Token': operatorToken } : {})
    }
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || 'RAG snapshot download failed'), {
      code: resp.status === 404 ? 'NOT_FOUND' : 'RAG_ERROR'
    });
  }
  return resp;
}

async function createQdrantBackup() {
  ensureBackupDir();
  logger.info('Starting Qdrant snapshot via RAG');
  const { data } = await ragFetch('/snapshots', { method: 'POST' });

  let localPath = null;
  if (data?.name && validateQdrantSnapshotName(data.name).valid) {
    const finalPath = path.join(QDRANT_LOCAL_DIR, data.name);
    const tempPath = path.join(
      QDRANT_LOCAL_DIR,
      `.${data.name}.${process.pid}.${Date.now()}.partial`
    );
    try {
      const resp = await downloadQdrantSnapshot(data.name);
      if (!resp.body || typeof resp.body.pipe !== 'function') {
        throw new Error('RAG snapshot response is not streamable');
      }
      await pipeline(resp.body, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      try {
        fs.linkSync(tempPath, finalPath);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw Object.assign(new Error('A local snapshot with this immutable name already exists'), {
            code: 'SNAPSHOT_EXISTS'
          });
        }
        throw error;
      }
      fs.rmSync(tempPath, { force: true });
      localPath = finalPath;
      secureBackupPath(finalPath, 0o600);
      logger.info('Qdrant snapshot downloaded locally', { name: data.name, localPath });
    } catch (err) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      logger.warn('Qdrant local download failed (snapshot still exists on server)', { error: err.message });
      localPath = null;
    }
  }

  // Prune local copies past retention
  const prunedLocal = pruneOld(QDRANT_LOCAL_DIR, (e) => e.isFile() && e.name.endsWith('.snapshot'));

  // Prune server-side snapshots past retention (best-effort)
  const prunedServer = await pruneQdrantServer();

  return { ...data, localPath, prunedLocal, prunedServer };
}

/**
 * Prune Qdrant server-side snapshots past the retention window.
 * Returns array of deleted snapshot names.
 */
async function pruneQdrantServer() {
  const { retentionDays } = getConfig();
  if (!retentionDays || retentionDays <= 0) return [];
  try {
    const { snapshots } = await listQdrantBackups();
    const cutoff = Date.now() - retentionDays * 86400 * 1000;
    const deleted = [];
    for (const s of snapshots) {
      const created = new Date(s.creation_time).getTime();
      if (!isNaN(created) && created < cutoff) {
        try {
          await deleteQdrantBackup(s.name);
          deleted.push(s.name);
        } catch (err) {
          logger.warn('Qdrant server-side prune failed for snapshot', { name: s.name, error: err.message });
        }
      }
    }
    if (deleted.length) logger.info('Pruned Qdrant server-side snapshots', { count: deleted.length });
    return deleted;
  } catch (err) {
    logger.warn('Qdrant server-side prune skipped', { error: err.message });
    return [];
  }
}

async function listQdrantBackups() {
  const { data, meta } = await ragFetch('/snapshots');
  return { snapshots: data, meta };
}

async function restoreQdrantBackup(snapshotName) {
  assertRestoreRehearsalEnabled();
  if (!snapshotName || !/^[a-zA-Z0-9._-]+$/.test(snapshotName)) {
    throw Object.assign(new Error('Invalid snapshot name'), { code: 'INVALID_NAME' });
  }
  logger.info('Starting Qdrant restore', { snapshotName });
  const { data } = await ragFetch(`/snapshots/${encodeURIComponent(snapshotName)}/restore`, {
    method: 'POST',
    headers: { 'X-AgentX-Confirm': `RESTORE ${snapshotName}` }
  });
  logger.info('Qdrant snapshot restored', { snapshotName });
  return data;
}

async function deleteQdrantBackup(snapshotName) {
  if (!snapshotName || !/^[a-zA-Z0-9._-]+$/.test(snapshotName)) {
    throw Object.assign(new Error('Invalid snapshot name'), { code: 'INVALID_NAME' });
  }

  // Best-effort server-side delete (may already be gone)
  let serverDeleted = false;
  try {
    await ragFetch(`/snapshots/${encodeURIComponent(snapshotName)}`, {
      method: 'DELETE',
      headers: { 'X-AgentX-Confirm': `DELETE ${snapshotName}` }
    });
    serverDeleted = true;
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
    logger.info('Qdrant server-side snapshot already gone', { snapshotName });
  }

  // Remove local copy if present
  let localDeleted = false;
  const localPath = path.join(QDRANT_LOCAL_DIR, snapshotName);
  const resolved = path.resolve(localPath);
  if (resolved.startsWith(QDRANT_LOCAL_DIR + path.sep) && fs.existsSync(resolved)) {
    fs.rmSync(resolved, { force: true });
    localDeleted = true;
  }

  if (!serverDeleted && !localDeleted) {
    throw Object.assign(new Error(`Snapshot not found: ${snapshotName}`), { code: 'NOT_FOUND' });
  }

  logger.info('Qdrant snapshot deleted', { snapshotName, serverDeleted, localDeleted });
  return { name: snapshotName, serverDeleted, localDeleted };
}

/**
 * List MongoDB backups. Supports both new tarballs (`agentx-*.tar.gz`)
 * and legacy uncompressed directories (`agentx-*`).
 */
function listBackups() {
  ensureBackupDir();

  try {
    const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    const backups = entries
      .filter(e => !e.name.startsWith('.') && (
        (e.isFile() && /^agentx-.*\.tar\.gz$/.test(e.name)) ||
        (e.isDirectory() && /^agentx-/.test(e.name))
      ))
      .map(e => {
        const fullPath = path.join(BACKUP_DIR, e.name);
        const stat = fs.statSync(fullPath);
        const size = e.isDirectory() ? getDirSize(fullPath) : stat.size;
        return {
          name: e.name,
          date: stat.mtime.toISOString(),
          size,
          path: fullPath,
          compressed: e.isFile()
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return backups;
  } catch (err) {
    logger.error('Failed to list backups', { error: err.message });
    return [];
  }
}

/**
 * Restore from a named backup. Accepts both tarballs (.tar.gz) and legacy directories.
 */
async function restoreBackup(backupName) {
  assertRestoreRehearsalEnabled();
  const validation = validateMongoBackupName(backupName);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.reason), { code: 'INVALID_NAME' });
  }

  if (operationInProgress) {
    throw Object.assign(new Error(`Another operation is in progress: ${operationInProgress}`), { code: 'BUSY' });
  }

  const backupPath = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(backupPath)) {
    throw Object.assign(new Error(`Backup not found: ${backupName}`), { code: 'NOT_FOUND' });
  }

  const backupStat = fs.lstatSync(backupPath);
  if (backupStat.isSymbolicLink() || (!backupStat.isFile() && !backupStat.isDirectory())) {
    throw Object.assign(new Error('MongoDB recovery artifact has an unsupported type'), { code: 'INVALID_NAME' });
  }

  const { host, port, db } = parseMongoUri(MONGO_URI);
  const isTarball = backupName.endsWith('.tar.gz');
  let restorePath;
  let tempDir = null;

  operationInProgress = `restore:${backupName}`;
  logger.info('Starting MongoDB restore', { backupName, host, port, db });

  try {
    if (isTarball) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-restore-'));
      await execFileAsync('tar', ['-xzf', backupPath, '-C', tempDir]);
      // Tar was built with baseName as top-level dir
      const baseName = backupName.replace(/\.tar\.gz$/, '');
      const extracted = path.join(tempDir, baseName);
      const dbPath = path.join(extracted, db);
      restorePath = fs.existsSync(dbPath) ? dbPath : extracted;
    } else {
      const dbPath = path.join(backupPath, db);
      restorePath = fs.existsSync(dbPath) ? dbPath : backupPath;
    }

    await execFileAsync('mongorestore', [
      '--host', host,
      '--port', port,
      '--db', db,
      '--drop',
      restorePath
    ]);

    logger.info('MongoDB restore completed', { backupName });

    return {
      name: backupName,
      restoredFrom: restorePath,
      timestamp: new Date().toISOString()
    };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    operationInProgress = null;
  }
}

/**
 * Delete a named backup (handles both tarballs and legacy directories).
 */
function deleteBackup(backupName) {
  const validation = validateMongoBackupName(backupName);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.reason), { code: 'INVALID_NAME' });
  }

  const backupPath = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(backupPath)) {
    throw Object.assign(new Error(`Backup not found: ${backupName}`), { code: 'NOT_FOUND' });
  }

  const resolved = path.resolve(backupPath);
  if (!resolved.startsWith(BACKUP_DIR + path.sep) && resolved !== BACKUP_DIR) {
    throw Object.assign(new Error('Invalid backup path'), { code: 'INVALID_NAME' });
  }

  const backupStat = fs.lstatSync(backupPath);
  if (backupStat.isSymbolicLink() || (!backupStat.isFile() && !backupStat.isDirectory())) {
    throw Object.assign(new Error('MongoDB recovery artifact has an unsupported type'), { code: 'INVALID_NAME' });
  }

  fs.rmSync(backupPath, { recursive: true, force: true });
  logger.info('Backup deleted', { backupName });

  return { name: backupName, deleted: true };
}

module.exports = {
  validateBackupName,
  validateMongoBackupName,
  validateConfigBackupName,
  validateQdrantSnapshotName,
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  createConfigBackup,
  listConfigBackups,
  deleteConfigBackup,
  createQdrantBackup,
  listQdrantBackups,
  restoreQdrantBackup,
  deleteQdrantBackup,
  getConfig,
  setConfig,
  getRestorePolicy,
  restoreRehearsalEnabled,
  OFFLINE_RESTORE_REQUIRED,
  PRODUCT_CONFIG_SOURCES,
  BACKUP_DIR,
  parseOwnerId
};

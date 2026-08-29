'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

describe('backupService durable storage behavior', () => {
  let tempRoot;
  let backupDir;
  let configRoot;
  let failMongodump;
  let archivedConfigFiles;
  let fetchMock;
  const originalEnv = {};
  const envNames = [
    'BACKUP_DIR', 'BACKUP_CONFIG_ROOT', 'BACKUP_OWNER_UID', 'BACKUP_OWNER_GID',
    'AGENTX_RESTORE_REHEARSAL_ENABLED', 'AGENTX_RECOVERY_TOKEN'
  ];

  beforeEach(() => {
    jest.resetModules();
    failMongodump = false;
    archivedConfigFiles = [];
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-backup-test-'));
    backupDir = path.join(tempRoot, 'backups');
    configRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(path.join(configRoot, 'config'), { recursive: true });
    for (const rel of [
      'docker-compose.yml',
      'docker-compose.ollama.yml',
      'config/agentx.env',
      'config/rag-ingestion-policy.json',
      'config/product-surfaces.json',
      'config/adapter-consumer-contracts.json',
      'config/container-image-pins.json'
    ]) {
      fs.writeFileSync(path.join(configRoot, rel), rel.endsWith('.json') ? '{}\n' : 'supported=true\n');
    }
    fs.writeFileSync(path.join(configRoot, '.env'), 'PRIVATE_TOKEN=must-not-be-captured\n');
    fs.writeFileSync(path.join(configRoot, 'config', 'secrets.json'), '{"password":"must-not-be-captured"}\n');

    for (const name of envNames) originalEnv[name] = process.env[name];
    process.env.BACKUP_DIR = backupDir;
    process.env.BACKUP_CONFIG_ROOT = configRoot;
    delete process.env.AGENTX_RESTORE_REHEARSAL_ENABLED;

    fetchMock = jest.fn();
    jest.doMock('node-fetch', () => fetchMock);

    jest.doMock('child_process', () => ({
      execFile: jest.fn((command, args, _options, callback) => {
        if (command === 'mongodump') {
          const outputDir = args[args.indexOf('--out') + 1];
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(path.join(outputDir, 'partial.bson'), 'partial');
          if (failMongodump) return callback(new Error('mongodump failed'), '', 'failed');
        }
        if (command === 'tar') {
          if (args.includes('-C') && String(args[args.indexOf('-C') + 1]).includes('agentx-config-')) {
            const staging = args[args.indexOf('-C') + 1];
            const walk = (dir, prefix = '') => {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const rel = path.join(prefix, entry.name).replace(/\\/g, '/');
                if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
                else archivedConfigFiles.push(rel);
              }
            };
            walk(staging);
          }
          fs.writeFileSync(args[1], 'test archive');
        }
        return callback(null, '', '');
      })
    }));
    jest.doMock('../../config/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }));
  });

  afterEach(() => {
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('child_process');
    jest.dontMock('../../config/logger');
    jest.dontMock('node-fetch');
  });

  test('config backup contains only the supported secret-free product allowlist', async () => {
    const service = require('../../src/services/backupService');

    const result = await service.createConfigBackup();

    expect(result.includes).toEqual([
      'docker-compose.yml',
      'docker-compose.ollama.yml',
      'config/agentx.env',
      'config/rag-ingestion-policy.json',
      'config/product-surfaces.json',
      'config/adapter-consumer-contracts.json',
      'config/container-image-pins.json'
    ]);
    expect(archivedConfigFiles.sort()).toEqual([...result.includes].sort());
    expect(archivedConfigFiles).not.toEqual(expect.arrayContaining(['.env', 'config/secrets.json', 'crontab.txt']));
    expect(result.path.startsWith(backupDir)).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(service.getConfig()).toMatchObject({
      backupDir,
      configRoot,
      configSources: result.includes
    });
  });

  test('restore fails closed until a controlled offline rehearsal is enabled', async () => {
    const service = require('../../src/services/backupService');

    expect(service.getRestorePolicy()).toMatchObject({
      enabled: false,
      mode: 'offline-rehearsal-required',
      code: 'OFFLINE_RESTORE_REQUIRED',
      coherentRecoverySetVerified: false
    });
    await expect(service.restoreBackup('agentx-test.tar.gz')).rejects.toMatchObject({
      code: 'OFFLINE_RESTORE_REQUIRED'
    });
    await expect(service.restoreQdrantBackup('test.snapshot')).rejects.toMatchObject({
      code: 'OFFLINE_RESTORE_REQUIRED'
    });
  });

  test('Core attaches the scoped recovery token to internal RAG snapshot calls', async () => {
    process.env.AGENTX_RECOVERY_TOKEN = 'scoped-recovery-token';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: [], meta: { storage: 'qdrant-snapshot-store' } })
    });
    const service = require('../../src/services/backupService');

    await expect(service.listQdrantBackups()).resolves.toEqual({
      snapshots: [],
      meta: { storage: 'qdrant-snapshot-store' }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/rag\/snapshots$/),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-AgentX-Recovery-Token': 'scoped-recovery-token' })
      })
    );
  });

  test('Core binds an exact typed confirmation to internal snapshot deletion', async () => {
    process.env.AGENTX_RECOVERY_TOKEN = 'scoped-recovery-token';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { deleted: true } })
    });
    const service = require('../../src/services/backupService');

    await expect(service.deleteQdrantBackup('agentx-test.snapshot')).resolves.toEqual(expect.objectContaining({
      name: 'agentx-test.snapshot',
      serverDeleted: true
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/rag\/snapshots\/agentx-test\.snapshot$/),
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'X-AgentX-Recovery-Token': 'scoped-recovery-token',
          'X-AgentX-Confirm': 'DELETE agentx-test.snapshot'
        })
      })
    );
  });

  test('Core fails closed instead of calling RAG when recovery auth is missing', async () => {
    delete process.env.AGENTX_RECOVERY_TOKEN;
    const service = require('../../src/services/backupService');

    await expect(service.listQdrantBackups()).rejects.toMatchObject({ code: 'RECOVERY_AUTH_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('failed Mongo backup removes partial dump data and archives', async () => {
    failMongodump = true;
    const service = require('../../src/services/backupService');

    await expect(service.createBackup()).rejects.toThrow('mongodump failed');

    const leftovers = fs.readdirSync(backupDir)
      .filter(name => name.startsWith('agentx-'));
    expect(leftovers).toEqual([]);
  });

  test('delete operations are confined to their exact recovery artifact class', () => {
    const service = require('../../src/services/backupService');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(backupDir, 'qdrant'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'qdrant', 'vectors.snapshot'), 'snapshot');
    fs.writeFileSync(path.join(backupDir, '.backup-config.json'), '{}');
    fs.writeFileSync(path.join(backupDir, 'config-safe.tar.gz'), 'config');
    fs.writeFileSync(path.join(backupDir, 'agentx-safe.tar.gz'), 'mongo');

    for (const protectedName of ['qdrant', '.backup-config.json', 'config-safe.tar.gz']) {
      expect(() => service.deleteBackup(protectedName)).toThrow(expect.objectContaining({ code: 'INVALID_NAME' }));
    }
    expect(() => service.deleteConfigBackup('agentx-safe.tar.gz')).toThrow(expect.objectContaining({ code: 'INVALID_NAME' }));

    expect(fs.existsSync(path.join(backupDir, 'qdrant', 'vectors.snapshot'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, '.backup-config.json'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'config-safe.tar.gz'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'agentx-safe.tar.gz'))).toBe(true);

    expect(service.deleteBackup('agentx-safe.tar.gz')).toMatchObject({ deleted: true });
    expect(service.deleteConfigBackup('config-safe.tar.gz')).toMatchObject({ deleted: true });
  });

  test('Qdrant downloads publish atomically and remove failed partial files', async () => {
    process.env.AGENTX_RECOVERY_TOKEN = 'scoped-recovery-token';
    const service = require('../../src/services/backupService');
    const createResponse = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { name: 'atomic.snapshot' } })
    };
    const failedBody = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('stream interrupted'));
      }
    });
    fetchMock
      .mockResolvedValueOnce(createResponse)
      .mockResolvedValueOnce({ ok: true, status: 200, body: failedBody });

    const failed = await service.createQdrantBackup();
    const qdrantDir = path.join(backupDir, 'qdrant');
    expect(failed.localPath).toBeNull();
    expect(fs.readdirSync(qdrantDir)).toEqual([]);

    fetchMock
      .mockResolvedValueOnce(createResponse)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: Readable.from([Buffer.from('complete snapshot')])
      });
    const completed = await service.createQdrantBackup();
    expect(completed.localPath).toBe(path.join(qdrantDir, 'atomic.snapshot'));
    expect(fs.readFileSync(completed.localPath, 'utf8')).toBe('complete snapshot');
    expect(fs.readdirSync(qdrantDir)).toEqual(['atomic.snapshot']);
  });

  test('accepts only non-negative integer ownership ids', () => {
    const { parseOwnerId } = require('../../src/services/backupService');

    expect(parseOwnerId('1000')).toBe(1000);
    expect(parseOwnerId(0)).toBe(0);
    expect(parseOwnerId('')).toBeNull();
    expect(parseOwnerId('-1')).toBeNull();
    expect(parseOwnerId('1.5')).toBeNull();
    expect(parseOwnerId('operator')).toBeNull();
  });
});

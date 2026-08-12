'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('backupService durable storage behavior', () => {
  let tempRoot;
  let backupDir;
  let configRoot;
  let runtimeEnvFile;
  let failMongodump;
  const originalEnv = {};
  const envNames = [
    'BACKUP_DIR', 'BACKUP_CONFIG_ROOT', 'BACKUP_RUNTIME_ENV_FILE',
    'BACKUP_OWNER_UID', 'BACKUP_OWNER_GID'
  ];

  beforeEach(() => {
    jest.resetModules();
    failMongodump = false;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-backup-test-'));
    backupDir = path.join(tempRoot, 'backups');
    configRoot = path.join(tempRoot, 'repo');
    runtimeEnvFile = path.join(tempRoot, 'agentx.env');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(runtimeEnvFile, 'TEST_RUNTIME_SETTING=present\n');

    for (const name of envNames) originalEnv[name] = process.env[name];
    process.env.BACKUP_DIR = backupDir;
    process.env.BACKUP_CONFIG_ROOT = configRoot;
    process.env.BACKUP_RUNTIME_ENV_FILE = runtimeEnvFile;

    jest.doMock('child_process', () => ({
      execFile: jest.fn((command, args, _options, callback) => {
        if (command === 'mongodump') {
          const outputDir = args[args.indexOf('--out') + 1];
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(path.join(outputDir, 'partial.bson'), 'partial');
          if (failMongodump) return callback(new Error('mongodump failed'), '', 'failed');
        }
        if (command === 'tar') fs.writeFileSync(args[1], 'test archive');
        if (command === 'crontab') return callback(new Error('no crontab'), '', '');
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
  });

  test('config backup includes the mounted runtime env and repository configuration', async () => {
    const service = require('../../src/services/backupService');

    const result = await service.createConfigBackup();

    expect(result.includes).toEqual(expect.arrayContaining([
      'docker-compose.yml',
      'runtime/agentx.env'
    ]));
    expect(result.path.startsWith(backupDir)).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(service.getConfig()).toMatchObject({
      backupDir,
      configRoot,
      runtimeEnvFileAvailable: true
    });
  });

  test('failed Mongo backup removes partial dump data and archives', async () => {
    failMongodump = true;
    const service = require('../../src/services/backupService');

    await expect(service.createBackup()).rejects.toThrow('mongodump failed');

    const leftovers = fs.readdirSync(backupDir)
      .filter(name => name.startsWith('agentx-'));
    expect(leftovers).toEqual([]);
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

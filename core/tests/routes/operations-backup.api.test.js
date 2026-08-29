'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../../src/services/backupService', () => ({
  BACKUP_DIR: '/safe/backups',
  getConfig: jest.fn(() => ({
    backupDir: '/safe/backups',
    qdrantLocalDir: '/safe/backups/qdrant',
    configRoot: '/private/product-config',
    mongoUri: 'mongodb://user:password@mongo:27017/agentx',
    ragUrl: 'http://rag:3082',
    configSources: ['docker-compose.yml', 'config/agentx.env', '.env', 'config/secrets.json'],
    retentionDays: 0,
    retentionDaysSource: 'runtime'
  })),
  getRestorePolicy: jest.fn(() => ({ enabled: false })),
  setConfig: jest.fn(),
  listBackups: jest.fn(() => [
    { name: 'agentx-one.tar.gz', date: '2026-08-27T00:00:00.000Z', size: 100, path: '/safe/backups/agentx-one.tar.gz', url: 'http://mongo/private' }
  ]),
  listConfigBackups: jest.fn(() => []),
  listQdrantBackups: jest.fn(async () => ({
    snapshots: [{ name: 'one.snapshot', creation_time: '2026-08-28T00:00:00.000Z', size: 200, path: '/qdrant/private', url: 'http://qdrant:6333/private' }],
    meta: { root: '/qdrant/snapshots', collection: 'agentx_embeddings' }
  })),
  validateBackupName: jest.fn(() => ({ valid: true })),
  restoreBackup: jest.fn(async (name) => ({ name })),
  deleteBackup: jest.fn((name) => ({ name })),
  restoreQdrantBackup: jest.fn(async (name) => ({ name })),
  deleteQdrantBackup: jest.fn(async (name) => ({ name })),
  deleteConfigBackup: jest.fn((name) => ({ name }))
}));

jest.mock('../../src/services/backupSchedulerService', () => ({
  getStatus: jest.fn(() => ({
    enabled: true,
    enabledSource: 'env',
    intervalMs: 2400000,
    intervalMsSource: 'env',
    startupDelayMs: 1000,
    startupDelayMsSource: 'env',
    retryDelayMs: 1200000,
    retryDelayMsSource: 'env',
    lastStatus: 'partial'
  }))
}));

const routes = require('../../routes/operations-backup');
const backupService = require('../../src/services/backupService');

function createApp() {
  const app = express();
  app.use('/api/operations', routes);
  return app;
}

describe('operations backup evidence API', () => {
  beforeEach(() => {
    backupService.getRestorePolicy.mockReturnValue({ enabled: false });
    backupService.restoreBackup.mockClear();
    backupService.restoreQdrantBackup.mockClear();
  });

  test('exposes effective cadence, retention enforcement, and growth risk', async () => {
    const response = await request(createApp())
      .get('/api/operations/backup/config')
      .expect(200);

    expect(response.body.config.policyEvidence).toMatchObject({
      authority: 'core.backup-policy',
      schedule: {
        enabled: true,
        normalEveryMs: 2400000,
        failureRetryEveryMs: 1200000,
        logicalOperationsPerCycle: 3
      },
      retention: { days: 0, mode: 'unbounded', automaticCleanup: false },
      growthRisk: { level: 'high' }
    });
  });

  test('labels Mongo inventory count basis, source, size, and observation time', async () => {
    const response = await request(createApp())
      .get('/api/operations/backups')
      .expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.evidence.inventory).toMatchObject({
      authority: 'core.backup-inventory.mongo',
      source: 'Persistent recovery inventory',
      count: 1,
      knownSizeCount: 1,
      totalKnownBytes: 100
    });
    expect(response.body.evidence.inventory.countBasis).toMatch(/no date window or pagination/i);
    expect(response.body.evidence.growthRisk.level).toBe('high');
  });

  test('labels Qdrant inventory without exposing collection topology', async () => {
    const response = await request(createApp())
      .get('/api/operations/qdrant/backups')
      .expect(200);

    expect(response.body.evidence.inventory).toMatchObject({
      authority: 'core.backup-inventory.qdrant',
      source: 'Internal recovery snapshot inventory',
      count: 1,
      oldestAt: '2026-08-28T00:00:00.000Z'
    });
    expect(response.body.evidence.inventory.scope).toBe('Complete recognized qdrant recovery inventory');
    expect(response.body).not.toHaveProperty('root');
    expect(response.body).not.toHaveProperty('collection');
  });

  test('gates restore before requiring exact typed confirmation, then keeps confirmation for rehearsals', async () => {
    const gated = await request(createApp())
      .post('/api/operations/restore/agentx-one.tar.gz')
      .set('X-AgentX-Confirm', 'RESTORE something-else.tar.gz')
      .expect(409);
    expect(gated.body.code).toBe('OFFLINE_RESTORE_REQUIRED');
    expect(backupService.restoreBackup).not.toHaveBeenCalled();

    backupService.getRestorePolicy.mockReturnValue({ enabled: true });

    await request(createApp())
      .post('/api/operations/restore/agentx-one.tar.gz')
      .set('X-AgentX-Confirm', 'RESTORE something-else.tar.gz')
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe('CONFIRMATION_REQUIRED');
        expect(body.confirmation.expected).toBe('RESTORE agentx-one.tar.gz');
      });

    await request(createApp())
      .post('/api/operations/restore/agentx-one.tar.gz')
      .set('X-AgentX-Confirm', 'RESTORE agentx-one.tar.gz')
      .expect(200);

    await request(createApp())
      .delete('/api/operations/backups/agentx-one.tar.gz')
      .set('X-AgentX-Confirm', 'DELETE agentx-one.tar.gz')
      .expect(200);
  });

  test('all config and inventory responses are topology-safe under hostile service values', async () => {
    for (const endpoint of [
      '/api/operations/backup/config',
      '/api/operations/backups',
      '/api/operations/config/backups',
      '/api/operations/qdrant/backups'
    ]) {
      const response = await request(createApp()).get(endpoint).expect(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/mongodb:\/\/|http:\/\/|\/safe\/backups|\/qdrant\/private|password/i);
      expect(serialized).not.toMatch(/"(?:path|localPath|url|root|restoredFrom|mongoUri|ragUrl|backupDir|configRoot)"/i);
    }
  });

  test('allows the same-origin product UI but rejects a cross-site destructive request', async () => {
    await request(createApp())
      .delete('/api/operations/backups/agentx-one.tar.gz')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('X-AgentX-Confirm', 'DELETE agentx-one.tar.gz')
      .expect(200);

    await request(createApp())
      .delete('/api/operations/backups/agentx-one.tar.gz')
      .set('Host', 'localhost')
      .set('Origin', 'https://attacker.invalid')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('X-AgentX-Confirm', 'DELETE agentx-one.tar.gz')
      .expect(403);
  });
});

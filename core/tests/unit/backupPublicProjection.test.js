'use strict';

const {
  projectArtifacts,
  projectBackupConfig,
  projectCreatedConfig,
  projectCreatedQdrant,
  projectMutationResult
} = require('../../src/services/backupPublicProjection');

function expectNoPrivateTopology(value) {
  const forbiddenKeys = new Set([
    'path', 'localpath', 'url', 'root', 'restoredfrom', 'mongouri', 'ragurl',
    'backupdir', 'qdrantlocaldir', 'configroot', 'password', 'credential', 'token'
  ]);
  const visit = current => {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      expect(forbiddenKeys).not.toContain(key.toLowerCase());
      if (typeof child === 'string') {
        expect(child).not.toMatch(/(?:https?:\/\/|mongodb:\/\/|[a-z]:\\|\/backups(?:\/|$)|\/qdrant(?:\/|$))/i);
      }
      visit(child);
    }
  };
  visit(value);
}

describe('backup API public projection', () => {
  const hostile = {
    name: 'agentx-one.tar.gz',
    date: '2026-08-28T00:00:00.000Z',
    timestamp: '2026-08-28T00:00:00.000Z',
    creation_time: '2026-08-28T00:00:00.000Z',
    size: 12,
    path: '/backups/agentx-one.tar.gz',
    localPath: '/backups/qdrant/one.snapshot',
    url: 'http://qdrant:6333/private',
    root: '/qdrant/storage',
    restoredFrom: '/tmp/restore/agentx',
    mongoUri: 'mongodb://user:password@mongo:27017/agentx',
    ragUrl: 'http://rag:3082',
    token: 'super-secret'
  };

  test('artifact, create, and mutation projections strip topology and secrets by construction', () => {
    const projected = {
      inventory: projectArtifacts([hostile]),
      qdrant: projectCreatedQdrant({ ...hostile, name: 'one.snapshot' }),
      mutation: projectMutationResult(hostile, { restored: true }),
      config: projectCreatedConfig({
        ...hostile,
        includes: ['docker-compose.yml', '.env', 'config/secrets.json', 'http://private/config']
      })
    };

    expect(projected.inventory[0]).toEqual({
      name: 'agentx-one.tar.gz',
      date: '2026-08-28T00:00:00.000Z',
      size: 12
    });
    expect(projected.config.sourceIds).toEqual(['base-compose']);
    expectNoPrivateTopology(projected);
  });

  test('sanitized config exposes logical storage and honest restore policy only', () => {
    const config = projectBackupConfig({
      ...hostile,
      retentionDays: 30,
      retentionDaysSource: 'env',
      configSources: [
        'docker-compose.yml',
        'config/agentx.env',
        '.env',
        'config/secrets.json',
        'http://private/config'
      ]
    }, {}, { enabled: false });

    expect(config).toMatchObject({
      storage: {
        kind: 'docker-named-volume',
        lifecycle: 'preserved-by-ordinary-down',
        hostLossProtection: 'separate-export-required'
      },
      configBackup: {
        sourceCount: 2,
        sourceIds: ['base-compose', 'product-defaults'],
        excludesRuntimeEnvironment: true,
        excludesSecrets: true
      },
      restorePolicy: {
        enabled: false,
        code: 'OFFLINE_RESTORE_REQUIRED',
        coherentRecoverySetVerified: false
      }
    });
    expectNoPrivateTopology(config);
  });
});

'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const { createBackupScheduler } = require('../../src/services/backupSchedulerService');

function fakeBackupService(overrides = {}) {
  return {
    createBackup: jest.fn(async () => ({ name: 'mongo.tar.gz' })),
    createConfigBackup: jest.fn(async () => ({ name: 'config.tar.gz' })),
    createQdrantBackup: jest.fn(async () => ({ name: 'qdrant.snapshot' })),
    ...overrides
  };
}

describe('backupSchedulerService', () => {
  test('stays disabled unless explicitly enabled', () => {
    const setTimeout = jest.fn();
    const scheduler = createBackupScheduler({ env: {}, setTimeout });

    expect(scheduler.start()).toBe(false);
    expect(setTimeout).not.toHaveBeenCalled();
    expect(scheduler.getStatus()).toMatchObject({ enabled: false, lastStatus: 'never' });
    expect(scheduler.getStatus()).toMatchObject({
      enabledSource: 'default',
      intervalMsSource: 'default',
      retryDelayMsSource: 'default'
    });
  });

  test('runs Mongo, config, and Qdrant backups as one successful cycle', async () => {
    const service = fakeBackupService();
    const scheduler = createBackupScheduler({
      env: { BACKUP_SCHEDULE_ENABLED: 'true' },
      backupService: service
    });

    const result = await scheduler.runNow();

    expect(service.createBackup).toHaveBeenCalledTimes(1);
    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toBe('success');
    expect(result.results.map(entry => entry.name)).toEqual(['mongo', 'config', 'qdrant']);
  });

  test('continues after an operation fails and schedules the shorter retry delay', async () => {
    const callbacks = [];
    const delays = [];
    const service = fakeBackupService({
      createBackup: jest.fn(async () => { throw new Error('mongodump unavailable'); })
    });
    const scheduler = createBackupScheduler({
      env: {
        BACKUP_SCHEDULE_ENABLED: 'true',
        BACKUP_STARTUP_DELAY_MS: '1000',
        BACKUP_INTERVAL_MS: '9000',
        BACKUP_RETRY_DELAY_MS: '2000'
      },
      backupService: service,
      setTimeout: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return { unref: jest.fn() };
      },
      clearTimeout: jest.fn()
    });

    expect(scheduler.start()).toBe(true);
    expect(scheduler.getStatus()).toMatchObject({
      enabledSource: 'env',
      intervalMsSource: 'env',
      retryDelayMsSource: 'env'
    });
    expect(delays).toEqual([1000]);

    await callbacks.shift()();

    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().lastStatus).toBe('partial');
    expect(delays).toEqual([1000, 2000]);
  });
});

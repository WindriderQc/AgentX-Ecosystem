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

describe('backupSchedulerService retry discipline', () => {
  function harness(service, env = {}) {
    const callbacks = [];
    const delays = [];
    const scheduler = createBackupScheduler({
      env: {
        BACKUP_SCHEDULE_ENABLED: 'true',
        BACKUP_STARTUP_DELAY_MS: '1000',
        BACKUP_INTERVAL_MS: '9000',
        BACKUP_RETRY_DELAY_MS: '2000',
        ...env
      },
      backupService: service,
      setTimeout: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return { unref: jest.fn() };
      },
      clearTimeout: jest.fn()
    });
    scheduler.start();
    return { scheduler, callbacks, delays };
  }

  test('a retry cycle re-runs only the failed layer and carries successes forward', async () => {
    let qdrantAttempts = 0;
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => {
        qdrantAttempts += 1;
        if (qdrantAttempts === 1) throw new Error('rag unreachable');
        return { name: 'qdrant.snapshot' };
      })
    });
    const { scheduler, callbacks, delays } = harness(service);

    await callbacks.shift()(); // startup cycle: qdrant fails
    expect(scheduler.getStatus().lastStatus).toBe('partial');
    expect(scheduler.getStatus().nextRunReason).toBe('retry');
    expect(scheduler.getStatus().lastFailures).toEqual([
      { name: 'qdrant', error: 'rag unreachable', code: null, retryable: true }
    ]);
    expect(delays).toEqual([1000, 2000]);

    await callbacks.shift()(); // retry cycle
    expect(service.createBackup).toHaveBeenCalledTimes(1);
    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(2);
    const status = scheduler.getStatus();
    expect(status.lastCycleMode).toBe('retry');
    expect(status.lastStatus).toBe('success');
    expect(status.results.map(r => [r.name, r.status, r.carriedForward === true])).toEqual([
      ['mongo', 'success', true],
      ['config', 'success', true],
      ['qdrant', 'success', false]
    ]);
    expect(status.nextRunReason).toBe('normal');
    expect(delays).toEqual([1000, 2000, 9000]);
  });

  test('a non-retryable failure (missing recovery auth) waits for the normal cadence', async () => {
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => {
        throw Object.assign(new Error('Recovery snapshot authorization is not configured'), {
          code: 'RECOVERY_AUTH_REQUIRED'
        });
      })
    });
    const { scheduler, callbacks, delays } = harness(service);

    await callbacks.shift()();

    const status = scheduler.getStatus();
    expect(status.lastStatus).toBe('partial');
    expect(status.lastFailures[0]).toMatchObject({ name: 'qdrant', code: 'RECOVERY_AUTH_REQUIRED', retryable: false });
    expect(status.nextRunReason).toBe('non-retryable-failure');
    expect(delays).toEqual([1000, 9000]);
    expect(service.createBackup).toHaveBeenCalledTimes(1);
  });

  test('the retry budget is bounded and then falls back to the normal cadence', async () => {
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => { throw new Error('rag unreachable'); })
    });
    const { scheduler, callbacks, delays } = harness(service, { BACKUP_MAX_RETRIES: '2' });

    await callbacks.shift()(); // startup → retry #1 scheduled
    await callbacks.shift()(); // retry #1 → retry #2 scheduled
    await callbacks.shift()(); // retry #2 → budget exhausted

    expect(delays).toEqual([1000, 2000, 2000, 9000]);
    expect(scheduler.getStatus().nextRunReason).toBe('retry-exhausted');
    expect(scheduler.getStatus().consecutiveRetries).toBe(0);
    // Mongo and config were created once, not once per retry.
    expect(service.createBackup).toHaveBeenCalledTimes(1);
    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(3);
  });
});

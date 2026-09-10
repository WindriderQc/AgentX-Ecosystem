'use strict';

jest.mock('../../src/services/pinReconciler', () => ({ checkAndReloadDefaults: jest.fn() }));
const { checkAndReloadDefaults } = require('../../src/services/pinReconciler');
const daemon = require('../../src/services/hostHealthDaemon');

test('a release requests an immediate cycle and coalesces requests while it is running', async () => {
  jest.useFakeTimers();
  checkAndReloadDefaults.mockClear();
  let finish;
  checkAndReloadDefaults.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  checkAndReloadDefaults.mockResolvedValue(undefined);
  try {
    daemon.startHealthCheck();
    daemon.requestReconcile();
    expect(checkAndReloadDefaults).toHaveBeenCalledTimes(1);
    daemon.requestReconcile(); daemon.requestReconcile();
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(checkAndReloadDefaults).toHaveBeenCalledTimes(2);
  } finally { finish?.(); await daemon.stopHealthCheck(); jest.useRealTimers(); checkAndReloadDefaults.mockClear(); }
});

test('health polling never overlaps and stop waits for its current cycle', async () => {
  jest.useFakeTimers();
  let finish;
  let stopped;
  checkAndReloadDefaults.mockImplementationOnce(isStopped => {
    stopped = isStopped;
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    daemon.setHealthCheckIntervalMs(10_000);
    daemon.startHealthCheck();
    jest.advanceTimersByTime(30_000);
    expect(checkAndReloadDefaults).toHaveBeenCalledTimes(1);
    expect(stopped()).toBe(false);
    let drained = false;
    const drain = daemon.stopHealthCheck().then(() => { drained = true; });
    await Promise.resolve();
    expect(stopped()).toBe(true);
    expect(drained).toBe(false);
    finish();
    await drain;
    jest.advanceTimersByTime(30_000);
    expect(checkAndReloadDefaults).toHaveBeenCalledTimes(1);
  } finally {
    finish?.();
    await daemon.stopHealthCheck();
    jest.useRealTimers();
  }
});

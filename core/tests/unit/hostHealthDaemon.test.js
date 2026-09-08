'use strict';

jest.mock('../../src/services/pinReconciler', () => ({ checkAndReloadDefaults: jest.fn() }));
const { checkAndReloadDefaults } = require('../../src/services/pinReconciler');
const daemon = require('../../src/services/hostHealthDaemon');

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

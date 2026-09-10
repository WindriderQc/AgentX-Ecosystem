'use strict';

/**
 * The watchdog must not probe a host under an active session hold: the held
 * model may be mid-swap, and a probe that times out there is quarantined and
 * blocks maintenance fleet-wide (observed 2026-09-10 00:17:18 on UGAlien).
 */

jest.mock('../../config/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}));
const mockHosts = [{ id: 'primary', name: 'Held Host', url: 'http://held.test:11434' }];
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => mockHosts)
}));
jest.mock('../../src/services/runtimeMutationLeaseService', () => ({
  runRuntimeMutation: jest.fn(async (_options, operation) => operation({
    signal: new AbortController().signal, assertActive: jest.fn()
  }))
}));
jest.mock('../../src/services/inferenceAdmissionService', () => ({
  beginInferenceAdmission: jest.fn(async () => ({
    signal: new AbortController().signal, assertActive: jest.fn(), markDispatched: jest.fn(),
    complete: jest.fn(async () => ({ released: true })), abandon: jest.fn(async () => ({ quarantined: true }))
  }))
}));
const mockGetActiveSessionHold = jest.fn(async () => null);
jest.mock('../../src/services/hostSessionHoldService', () => ({
  getActiveSessionHold: (...args) => mockGetActiveSessionHold(...args)
}));

const logger = require('../../config/logger');
const watchdog = require('../../src/services/ollamaWatchdogService');

describe('watchdog and session holds', () => {
  test('skips a held host before any metadata or inference probe', async () => {
    mockGetActiveSessionHold.mockResolvedValueOnce({
      holdId: 'hold-1', owner: 'extension/open', model: 'held-model:27b',
      expiresAt: new Date(Date.now() + 60_000)
    });
    const before = watchdog.getStats();
    await watchdog.runNow();
    const after = watchdog.getStats();
    expect(mockGetActiveSessionHold).toHaveBeenCalledWith('http://held.test:11434');
    expect(after.probesSent).toBe(before.probesSent);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('probe skipped — active session hold'),
      expect.objectContaining({ model: 'held-model:27b', owner: 'extension/open' })
    );
    expect(after.history.some((event) => event.type === 'hold_skip' && event.hostUrl === 'http://held.test:11434')).toBe(true);
  });

  test('probes normally when no hold is active', async () => {
    mockGetActiveSessionHold.mockResolvedValueOnce(null);
    logger.debug.mockClear();
    await watchdog.runNow();
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('active session hold'),
      expect.anything()
    );
  });
});

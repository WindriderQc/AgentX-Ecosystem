'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { warmEmbeddingConnection } = require('../../src/services/embeddingWarmup');

describe('warmEmbeddingConnection', () => {
  function serviceThat(refresh) {
    const service = { refreshConnectionStatus: refresh };
    return () => service;
  }

  it('stops after the first successful probe', async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const sleep = jest.fn();

    await expect(warmEmbeddingConnection({
      getService: serviceThat(refresh),
      sleep,
    })).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ source: 'startup' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries while the embedding host is still coming up', async () => {
    const refresh = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(warmEmbeddingConnection({
      getService: serviceThat(refresh),
      sleep,
      baseDelayMs: 10,
    })).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(3);
    // Linear backoff, and no wait after the attempt that succeeded.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });

  it('survives a probe that throws and keeps trying', async () => {
    const refresh = jest.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(true);

    await expect(warmEmbeddingConnection({
      getService: serviceThat(refresh),
      sleep: jest.fn().mockResolvedValue(undefined),
      baseDelayMs: 0,
    })).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured attempts and reports failure honestly', async () => {
    const refresh = jest.fn().mockResolvedValue(false);
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(warmEmbeddingConnection({
      getService: serviceThat(refresh),
      sleep,
      attempts: 3,
      baseDelayMs: 1,
    })).resolves.toBe(false);

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('treats a non-boolean answer as unproven rather than healthy', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);

    await expect(warmEmbeddingConnection({
      getService: serviceThat(refresh),
      sleep: jest.fn().mockResolvedValue(undefined),
      attempts: 2,
      baseDelayMs: 0,
    })).resolves.toBe(false);

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

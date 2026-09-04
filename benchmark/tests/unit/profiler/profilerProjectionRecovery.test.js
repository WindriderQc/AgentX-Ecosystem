'use strict';

const mockAcquireLease = jest.fn();
const mockCheckStatus = jest.fn();
const mockUpsert = jest.fn();
const mockListModels = jest.fn();
const mockDeleteModel = jest.fn();

jest.mock('../../../models/HostProfile', () => ({ find: jest.fn() }));
jest.mock('../../../src/services/profiler/profilerClaimLifecycle', () => ({
  acquireProfilerClaimLease: (...args) => mockAcquireLease(...args)
}));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({
  checkStatus: (...args) => mockCheckStatus(...args),
  upsert: (...args) => mockUpsert(...args)
}));
jest.mock('../../../src/clients/ollamaClient', () => ({
  listModels: (...args) => mockListModels(...args),
  deleteModel: (...args) => mockDeleteModel(...args)
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const service = require('../../../src/services/profiler/profilerProjectionRecovery');

function lease() {
  const active = jest.fn();
  return {
    signal: new AbortController().signal,
    assertActive: active,
    abandon: jest.fn(async () => ({ abandoned: true })),
    finalize: jest.fn(async options => {
      if (typeof options?.beforeWorkloadRelease === 'function') {
        await options.beforeWorkloadRelease({ failed: 0, details: [] });
      }
      return { failed: 0 };
    })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({});
  mockAcquireLease.mockResolvedValue(lease());
});

test('release recovery observes runtime and commits the converged projection before admission release', async () => {
  const ownedLease = lease();
  mockAcquireLease.mockResolvedValue(ownedLease);
  mockCheckStatus.mockResolvedValue({
    status: 'online',
    dedicated: { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') }
  });
  const profile = {
    hostId: 'primary',
    hostUrl: 'http://primary:11434',
    reconciliation: { state: 'pending_reconciliation', operation: 'release_model', operationId: 'old-op' }
  };

  await expect(service._reconcileReleaseProjection(profile)).resolves.toMatchObject({ recovered: true });

  expect(ownedLease.finalize).toHaveBeenCalledWith({ beforeWorkloadRelease: expect.any(Function) });
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
    hostId: 'primary',
    dedicated: expect.objectContaining({ model: 'qwen:7b' }),
    reconciliation: expect.objectContaining({ state: 'resolved' })
  }), { assertAuthorityActive: ownedLease.assertActive });
});

test('baseline recovery deletes a late artifact and holds one fence through the complete quiet window', async () => {
  const ownedLease = lease();
  mockAcquireLease.mockResolvedValue(ownedLease);
  mockListModels
    .mockResolvedValueOnce({ models: [{ name: 'qwen2.5:3b' }] })
    .mockResolvedValue({ models: [] });
  mockDeleteModel.mockResolvedValue({ status: 'success' });
  const profile = {
    hostId: 'primary',
    hostUrl: 'http://primary:11434',
    reconciliation: {
      state: 'pending_reconciliation',
      operation: 'baseline_pull',
      operationId: 'pull-op',
      model: 'qwen2.5:3b',
      timeoutAt: new Date('2026-09-04T00:00:00.000Z')
    }
  };

  await expect(service._reconcileBaselinePull(profile, { stableWindowMs: 5, pollIntervalMs: 1 }))
    .resolves.toMatchObject({ recovered: true, pending: false, available: false });

  expect(mockDeleteModel).toHaveBeenCalledWith(
    'http://primary:11434',
    'qwen2.5:3b',
    expect.objectContaining({ signal: ownedLease.signal })
  );
  expect(mockListModels.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(ownedLease.finalize).toHaveBeenCalledWith(expect.objectContaining({
    byHost: { 'http://primary:11434': { excludedModels: ['qwen2.5:3b'] } },
    beforeWorkloadRelease: expect.any(Function)
  }));
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
    reconciliation: expect.objectContaining({ state: 'resolved', quietSince: expect.any(Date) })
  }), { assertAuthorityActive: ownedLease.assertActive });
});

test('baseline recovery ignores a pre-lease quiet timestamp and proves a new continuous quiet window', async () => {
  const ownedLease = lease();
  mockAcquireLease.mockResolvedValue(ownedLease);
  mockListModels.mockResolvedValue({ models: [] });
  const profile = {
    hostId: 'primary',
    hostUrl: 'http://primary:11434',
    reconciliation: {
      state: 'pending_reconciliation',
      operation: 'baseline_pull',
      operationId: 'pull-op-stable',
      model: 'qwen2.5:3b',
      timeoutAt: new Date('2026-09-04T00:00:00.000Z'),
      quietSince: new Date(Date.now() - 5_000),
      attempts: 2
    }
  };

  await expect(service._reconcileBaselinePull(profile, { stableWindowMs: 5, pollIntervalMs: 1 }))
    .resolves.toMatchObject({ recovered: true, pending: false, available: false });

  expect(mockDeleteModel).not.toHaveBeenCalled();
  expect(mockListModels.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
    reconciliation: expect.objectContaining({ state: 'resolved', attempts: expect.any(Number) })
  }), { assertAuthorityActive: ownedLease.assertActive });
  const resolved = mockUpsert.mock.calls.find(call => call[0]?.reconciliation?.state === 'resolved');
  expect(resolved[0].reconciliation.attempts).toBeGreaterThan(2);
});

test('baseline recovery retains the lease when inventory cannot be proven quiet', async () => {
  const ownedLease = lease();
  mockAcquireLease.mockResolvedValue(ownedLease);
  mockListModels.mockRejectedValue(new Error('inventory unavailable'));
  const profile = {
    hostId: 'primary',
    hostUrl: 'http://primary:11434',
    reconciliation: {
      state: 'pending_reconciliation',
      operation: 'baseline_pull',
      model: 'qwen2.5:3b'
    }
  };

  await expect(service._reconcileBaselinePull(profile, { stableWindowMs: 5, pollIntervalMs: 1 }))
    .rejects.toThrow('inventory unavailable');

  expect(ownedLease.abandon).toHaveBeenCalledWith(expect.any(Error));
  expect(ownedLease.finalize).not.toHaveBeenCalled();
});

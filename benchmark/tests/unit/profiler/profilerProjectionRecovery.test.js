'use strict';

const mockHostProfile = { find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() };
const mockAcquireLease = jest.fn();
const mockUpsert = jest.fn();
const mockListModels = jest.fn();
const mockAdoptRecovery = jest.fn();
const mockHeartbeatRecovery = jest.fn();
const mockAssertRecovery = jest.fn();
const mockTransitionRecovery = jest.fn();
const mockRestoreHosts = jest.fn();
const mockReleaseAdmission = jest.fn();
const mockRecoverRelease = jest.fn();

jest.mock('../../../models/HostProfile', () => mockHostProfile);
jest.mock('../../../src/services/profiler/profilerClaimLifecycle', () => ({
  acquireProfilerClaimLease: (...args) => mockAcquireLease(...args),
}));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({ upsert: (...args) => mockUpsert(...args) }));
jest.mock('../../../src/clients/ollamaClient', () => ({ listModels: (...args) => mockListModels(...args) }));
jest.mock('../../../src/clients/coreApiClient', () => ({
  adoptWorkloadRecovery: (...args) => mockAdoptRecovery(...args),
  heartbeatWorkloadRecovery: (...args) => mockHeartbeatRecovery(...args),
  assertWorkloadRecovery: (...args) => mockAssertRecovery(...args),
  transitionWorkloadRecovery: (...args) => mockTransitionRecovery(...args),
  restoreWorkloadRecoveryHosts: (...args) => mockRestoreHosts(...args),
  releaseWorkloadAdmission: (...args) => mockReleaseAdmission(...args),
  recoverWorkloadAdmissionRelease: (...args) => mockRecoverRelease(...args),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const service = require('../../../src/services/profiler/profilerProjectionRecovery');

function queryResult(value) {
  return { lean: jest.fn(async () => value) };
}

function lease() {
  const assertActive = jest.fn();
  return {
    signal: new AbortController().signal,
    assertActive,
    abandon: jest.fn(async () => ({ abandoned: true })),
    finalize: jest.fn(async options => {
      if (typeof options?.beforeWorkloadRelease === 'function') {
        await options.beforeWorkloadRelease({ failed: 0, details: [] });
      }
      return { failed: 0, details: [] };
    }),
  };
}

function durableProfile(overrides = {}) {
  return {
    _id: 'profile-1',
    hostId: 'primary',
    hostUrl: 'http://primary:11434',
    reconciliation: {
      state: 'unknown',
      operation: 'release_model',
      operationId: 'release-op',
      workloadId: 'release-op',
      admissionId: 'admission-1',
      admissionGeneration: 'admission-generation-1',
      admissionPrincipal: 'benchmark-service',
      recoveryId: 'recovery-1',
      recoveryRequestId: 'recovery-request-1',
      model: 'qwen:7b',
      serverTerminalObserved: true,
      startedAt: new Date(0),
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHostProfile.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mockUpsert.mockResolvedValue({});
  mockListModels.mockResolvedValue({ models: [] });
  mockHeartbeatRecovery.mockResolvedValue({ heartbeat: true });
  mockRestoreHosts.mockResolvedValue({ restored: true });
  mockTransitionRecovery.mockResolvedValue({ transitioned: true });
  mockReleaseAdmission.mockResolvedValue({ released: true, recoveryReceipt: { contract: 'agentx.workload-recovery/v1' } });
  mockRecoverRelease.mockResolvedValue({ recovered: false, released: false });
});

test('startup recovery adopts Core quarantine, restores exact claims, and persists the terminal receipt', async () => {
  const profile = durableProfile();
  let claimed;
  mockHostProfile.findOneAndUpdate.mockImplementation((_filter, update) => {
    if (update?.$set?.['reconciliation.ownerId']) {
      claimed = { ...profile, reconciliation: { ...profile.reconciliation,
        ownerId: update.$set['reconciliation.ownerId'], ownerEpoch: update.$set['reconciliation.ownerEpoch'] } };
      return queryResult(claimed);
    }
    if (update?.$set?.reconciliation) {
      claimed = { ...claimed, reconciliation: update.$set.reconciliation };
      return queryResult(claimed);
    }
    if (update?.$set?.['reconciliation.state'] === 'resolved') {
      return queryResult({ ...claimed, reconciliation: { ...claimed.reconciliation, state: 'resolved' } });
    }
    return queryResult(null);
  });
  mockHostProfile.findOne.mockImplementation(() => queryResult(claimed));
  mockAdoptRecovery.mockImplementation(async ({ ownerId }) => ({ adopted: true, recoveryOwnerId: ownerId }));
  mockAssertRecovery.mockImplementation(async () => ({
    owned: true, recoveryOwnerId: claimed.reconciliation.ownerId, recoveryState: 'UNKNOWN', recoveryVersion: 2,
  }));

  await expect(service._reconcileReleaseProjection(profile)).resolves.toMatchObject({ recovered: true, pending: false, model: 'qwen:7b' });
  expect(mockAdoptRecovery).toHaveBeenCalledWith(expect.objectContaining({ workloadId: 'release-op', recoveryId: 'recovery-1' }));
  expect(mockRestoreHosts).toHaveBeenCalledWith('release-op', { 'http://primary:11434': ['qwen:7b'] });
  expect(mockTransitionRecovery.mock.calls.map(call => call[1])).toEqual(['VERIFIED', 'RESTORED']);
  expect(mockReleaseAdmission).toHaveBeenCalledWith('release-op');
  expect(mockHostProfile.findOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ 'reconciliation.state': 'verified' }),
    expect.objectContaining({ $set: expect.objectContaining({ 'reconciliation.state': 'resolved' }) }),
    { new: true },
  );
});

test('two recovery workers use a HostProfile owner epoch CAS and only one can adopt', async () => {
  const profile = durableProfile();
  let claimed = false;
  mockHostProfile.findOneAndUpdate.mockImplementation((_filter, update) => {
    if (!update?.$set?.['reconciliation.ownerId'] || claimed) return queryResult(null);
    claimed = true;
    return queryResult({ ...profile, reconciliation: { ...profile.reconciliation,
      ownerId: update.$set['reconciliation.ownerId'], ownerEpoch: update.$set['reconciliation.ownerEpoch'] } });
  });

  const [first, second] = await Promise.all([
    service._claimProfileRecovery(profile, 'worker-a'), service._claimProfileRecovery(profile, 'worker-b'),
  ]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
  expect([first, second].filter(Boolean)[0]).toMatchObject({ ownerId: expect.stringMatching(/^worker-/), ownerEpoch: expect.any(String) });
});

test('legacy terminal profile keeps the historical recovery route and resolves under a fresh exact lease', async () => {
  const profile = durableProfile({ state: 'pending_reconciliation', recoveryId: undefined, recoveryRequestId: undefined });
  const ownedLease = lease();
  mockAcquireLease.mockResolvedValue(ownedLease);
  mockHostProfile.findOneAndUpdate.mockImplementation((_filter, update) => queryResult({ ...profile,
    reconciliation: { ...profile.reconciliation,
      ownerId: update.$set['reconciliation.ownerId'], ownerEpoch: update.$set['reconciliation.ownerEpoch'] } }));

  await expect(service._reconcileReleaseProjection(profile)).resolves.toMatchObject({ recovered: true, legacy: true });
  expect(mockAcquireLease).toHaveBeenCalledWith(['http://primary:11434'], expect.stringMatching(/^profiler-legacy-recovery-/), 300000);
  expect(ownedLease.finalize).toHaveBeenCalledWith(expect.objectContaining({
    byHost: { 'http://primary:11434': { excludedModels: ['qwen:7b'] } }, beforeWorkloadRelease: expect.any(Function),
  }));
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
    dedicated: null,
    reconciliation: expect.objectContaining({ state: 'resolved', ownerId: null, ownerEpoch: null }),
  }), expect.any(Object));
});

test.each(['release_model', 'baseline_pull'])('never infers terminal completion from silence for %s', async operation => {
  const profile = durableProfile({ operation, serverTerminalObserved: false });
  mockHostProfile.findOneAndUpdate.mockImplementation((_filter, update) => queryResult({ ...profile,
    reconciliation: { ...profile.reconciliation,
      ownerId: update.$set['reconciliation.ownerId'], ownerEpoch: update.$set['reconciliation.ownerEpoch'] } }));

  await expect(operation === 'release_model'
    ? service._reconcileReleaseProjection(profile)
    : service._reconcileBaselinePull(profile))
    .resolves.toMatchObject({ pending: true, operatorRequired: true });
  expect(mockAcquireLease).not.toHaveBeenCalled();
  expect(mockAdoptRecovery).not.toHaveBeenCalled();
  expect(mockReleaseAdmission).not.toHaveBeenCalled();
});

test('startup sweep includes migrated legacy pending profiles and leaves unproven intents visible', async () => {
  const legacy = durableProfile({ state: 'pending_reconciliation', recoveryId: undefined,
    recoveryRequestId: undefined, serverTerminalObserved: false });
  mockHostProfile.find.mockReturnValue({ limit: jest.fn(() => ({ lean: jest.fn(async () => [legacy]) })) });
  mockHostProfile.findOneAndUpdate.mockImplementation((_filter, update) => queryResult({ ...legacy,
    reconciliation: { ...legacy.reconciliation,
      ownerId: update.$set['reconciliation.ownerId'], ownerEpoch: update.$set['reconciliation.ownerEpoch'] } }));

  await expect(service.recoverPendingHostProjections({ delayMs: 1, workerId: 'startup-worker' }))
    .resolves.toMatchObject({ inspected: 1, recovered: 0, pending: 1 });
  expect(mockHostProfile.find).toHaveBeenCalledWith(expect.objectContaining({
    'reconciliation.state': { $in: expect.arrayContaining(['pending_reconciliation', 'prepared', 'mutating', 'unknown', 'verified']) },
  }));
  expect(mockHostProfile.updateOne).toHaveBeenCalledWith(
    expect.objectContaining({ 'reconciliation.ownerId': 'startup-worker' }),
    expect.objectContaining({ $set: expect.objectContaining({
      'reconciliation.reason': expect.stringContaining('controlled runtime restart'),
    }) }),
  );
});

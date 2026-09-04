'use strict';

const mockReconciliationFindOneAndUpdate = jest.fn();
const mockReconciliationUpdateOne = jest.fn();
const mockReconciliationFindOne = jest.fn();
const mockReconciliationCountDocuments = jest.fn();
const mockBatchUpdateOne = jest.fn();
const mockResultFindOneAndUpdate = jest.fn();
const mockGetRecoveryIdentity = jest.fn();
const mockAdoptRecovery = jest.fn();
const mockHeartbeatRecovery = jest.fn();
const mockAssertRecovery = jest.fn();
const mockTransitionRecovery = jest.fn();
const mockRestoreRecoveryHosts = jest.fn();
const mockReleaseAdmission = jest.fn();
const mockRecoverRelease = jest.fn();

jest.mock('../../../models/BenchmarkAuthorityReconciliation', () => ({
  findOneAndUpdate: (...args) => mockReconciliationFindOneAndUpdate(...args),
  updateOne: (...args) => mockReconciliationUpdateOne(...args),
  findOne: (...args) => mockReconciliationFindOne(...args),
  countDocuments: (...args) => mockReconciliationCountDocuments(...args),
  find: jest.fn(),
  findById: jest.fn()
}));
jest.mock('../../../models/BenchmarkBatch', () => ({
  updateOne: (...args) => mockBatchUpdateOne(...args),
  findOneAndUpdate: jest.fn()
}));
jest.mock('../../../models/BenchmarkResult', () => ({
  findOneAndUpdate: (...args) => mockResultFindOneAndUpdate(...args)
}));
jest.mock('../../../models/JudgeAccuracyMatrix', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../../models/JudgeGovernanceRun', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../../models/JudgeGroundTruth', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: (...args) => mockGetRecoveryIdentity(...args),
  adoptWorkloadRecovery: (...args) => mockAdoptRecovery(...args),
  heartbeatWorkloadRecovery: (...args) => mockHeartbeatRecovery(...args),
  assertWorkloadRecovery: (...args) => mockAssertRecovery(...args),
  transitionWorkloadRecovery: (...args) => mockTransitionRecovery(...args),
  restoreWorkloadRecoveryHosts: (...args) => mockRestoreRecoveryHosts(...args),
  releaseWorkloadAdmission: (...args) => mockReleaseAdmission(...args),
  recoverWorkloadAdmissionRelease: (...args) => mockRecoverRelease(...args)
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const service = require('../../../src/services/benchmark/benchmarkAuthorityReconciliation');

function lean(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

const proof = {
  admissionId: 'admission-1',
  generation: 'admission-generation-1',
  principal: 'benchmark-service',
  workloadId: 'batch-1',
  recoveryRequired: true,
  recoveryId: 'recovery-1',
  recoveryGeneration: 'recovery-generation-1',
  recoveryRequestId: 'recovery:benchmark:batch-1',
  recoveryOwnerId: null,
  recoveryState: 'MUTATING',
  recoveryVersion: 1
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecoveryIdentity.mockReturnValue(proof);
  mockBatchUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockReconciliationUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockReconciliationCountDocuments.mockResolvedValue(0);
  mockRecoverRelease.mockResolvedValue({ recovered: false, released: false });
  mockHeartbeatRecovery.mockResolvedValue({ heartbeat: true });
  mockRestoreRecoveryHosts.mockResolvedValue({ restored: true, details: [] });
});

test('journals the Core quarantine identity before handing ambiguous authority to recovery', async () => {
  mockReconciliationFindOneAndUpdate.mockReturnValueOnce(lean({ _id: 'journal-1' }));
  await expect(service.enqueueResultInvalidation({
    resultId: 'result-1',
    batchId: 'batch-1',
    workloadId: 'batch-1',
    phase: 'successful result save',
    reason: 'acknowledgement lost'
  })).resolves.toMatchObject({ _id: 'journal-1' });

  expect(mockReconciliationFindOneAndUpdate).toHaveBeenCalledWith(
    { resultId: 'result-1' },
    expect.objectContaining({ $setOnInsert: expect.objectContaining({
      state: 'pending_reconciliation',
      workloadId: 'batch-1',
      admissionId: proof.admissionId,
      admissionGeneration: proof.generation,
      admissionPrincipal: proof.principal,
      recoveryId: proof.recoveryId,
      recoveryRequestId: proof.recoveryRequestId
    }) }),
    { upsert: true, new: true }
  );
});

test('restart worker adopts Core quarantine before compensation and persists afterVersion before release', async () => {
  const calls = [];
  const ownership = {
    ownerId: 'worker-restart',
    ownerEpoch: 'epoch-1',
    record: {
      _id: 'journal-1',
      kind: 'result_invalidation',
      resourceType: 'BenchmarkResult',
      resultId: 'result-1',
      batchId: 'batch-1',
      workloadId: 'batch-1',
      admissionId: proof.admissionId,
      admissionGeneration: proof.generation,
      admissionPrincipal: proof.principal,
      recoveryId: proof.recoveryId,
      recoveryRequestId: proof.recoveryRequestId,
      phase: 'result save',
      state: 'pending_reconciliation'
    }
  };
  let coreState = 'MUTATING';
  let coreVersion = 1;
  mockAdoptRecovery.mockImplementation(async () => {
    calls.push('adopt');
    return { ...proof, adopted: true, recoveryOwnerId: ownership.ownerId };
  });
  mockAssertRecovery.mockImplementation(async () => ({
    owned: true,
    recoveryOwnerId: ownership.ownerId,
    recoveryState: coreState,
    recoveryVersion: coreVersion
  }));
  mockTransitionRecovery.mockImplementation(async (_workloadId, state) => {
    calls.push(`transition:${state}`);
    coreState = state;
    coreVersion += 1;
    return { transitioned: true, recoveryState: state, recoveryVersion: coreVersion };
  });
  mockReconciliationFindOne.mockImplementation(() => lean({ _id: 'journal-1' }));
  mockResultFindOneAndUpdate.mockImplementation(() => {
    calls.push('invalidate');
    return lean({ _id: 'result-1', __v: 7 });
  });
  mockReconciliationFindOneAndUpdate
    .mockImplementationOnce(() => lean({ ...ownership.record, state: 'verified', compensationReceipt: {
      contract: 'agentx.authority-compensation/v1', afterVersion: 7
    } }))
    .mockImplementationOnce(() => lean({ ...ownership.record, state: 'releasing', compensationReceipt: {
      contract: 'agentx.authority-compensation/v1', afterVersion: 7
    } }))
    .mockImplementationOnce(() => lean({ ...ownership.record, state: 'resolved' }));
  mockReleaseAdmission.mockImplementation(async () => {
    calls.push('release');
    return {
      released: true,
      recoveryState: 'RESTORED',
      recoveryReceipt: { contract: 'agentx.workload-recovery/v1' }
    };
  });

  await expect(service._reconcileOwnedRecord(ownership)).resolves.toMatchObject({ resolved: true });
  expect(calls.indexOf('adopt')).toBeLessThan(calls.indexOf('invalidate'));
  expect(calls.indexOf('invalidate')).toBeLessThan(calls.indexOf('transition:VERIFIED'));
  expect(calls.indexOf('transition:RESTORED')).toBeLessThan(calls.indexOf('release'));
  expect(mockRestoreRecoveryHosts).toHaveBeenCalledWith(
    'batch-1',
    {},
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
  expect(mockReconciliationFindOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: ownership.ownerId, ownerEpoch: ownership.ownerEpoch }),
    expect.objectContaining({ $set: expect.objectContaining({
      state: 'verified',
      compensationReceipt: expect.objectContaining({ afterVersion: 7 })
    }) }),
    expect.objectContaining({ new: true, signal: expect.any(AbortSignal) })
  );
});

test('two recovery workers cannot both claim one journal epoch', async () => {
  const row = { _id: 'journal-race', state: 'pending_reconciliation' };
  mockReconciliationFindOneAndUpdate
    .mockReturnValueOnce(lean({ ...row, ownerId: 'worker-a', ownerEpoch: 'epoch-a' }))
    .mockReturnValueOnce(lean(null));
  const [a, b] = await Promise.all([
    service._claimRecoveryRecord(row, 'worker-a'),
    service._claimRecoveryRecord(row, 'worker-b')
  ]);
  expect(a).toMatchObject({ ownerId: 'worker-a', record: { ownerId: 'worker-a' } });
  expect(b).toBeNull();
});

test('a releasing journal recovers the durable Core receipt after a crash without another write', async () => {
  const released = {
    recovered: true,
    released: true,
    admissionId: proof.admissionId,
    generation: proof.generation,
    principal: proof.principal,
    workloadId: proof.workloadId,
    recoveryId: proof.recoveryId,
    recoveryState: 'RESTORED',
    recoveryReceipt: { contract: 'agentx.workload-recovery/v1' }
  };
  mockRecoverRelease.mockResolvedValue(released);
  mockReconciliationFindOneAndUpdate.mockReturnValueOnce(lean({ state: 'resolved' }));
  const ownership = {
    ownerId: 'worker-restart',
    ownerEpoch: 'epoch-2',
    record: {
      _id: 'journal-2',
      state: 'releasing',
      resultId: 'result-2',
      workloadId: proof.workloadId,
      admissionId: proof.admissionId,
      admissionGeneration: proof.generation,
      admissionPrincipal: proof.principal,
      recoveryId: proof.recoveryId
    }
  };
  await expect(service._reconcileOwnedRecord(ownership)).resolves.toMatchObject({
    resolved: true,
    recovered: true
  });
  expect(mockAdoptRecovery).not.toHaveBeenCalled();
  expect(mockResultFindOneAndUpdate).not.toHaveBeenCalled();
});

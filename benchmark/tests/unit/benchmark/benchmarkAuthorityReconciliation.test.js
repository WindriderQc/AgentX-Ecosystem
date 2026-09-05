'use strict';

const mockReconciliationFindOneAndUpdate = jest.fn();
const mockReconciliationUpdateOne = jest.fn();
const mockReconciliationFindOne = jest.fn();
const mockReconciliationCountDocuments = jest.fn();
const mockReconciliationFind = jest.fn();
const mockBatchUpdateOne = jest.fn();
const mockResultFindOneAndUpdate = jest.fn();
const mockHostSnapshotFindOneAndUpdate = jest.fn();
const mockHostProfileUpdateOne = jest.fn();
const mockModelPerformanceFindOneAndUpdate = jest.fn();
const mockModelPerformanceUpdateOne = jest.fn();
const mockModelPerformanceUpdateMany = jest.fn();
const mockModelProfileUpdateOne = jest.fn();
const mockContextProfileUpdateOne = jest.fn();
const mockContextSnapshotUpdateOne = jest.fn();
const mockContextSnapshotFindOneAndUpdate = jest.fn();
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
  find: (...args) => mockReconciliationFind(...args),
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
jest.mock('../../../models/HostPerformanceSnapshot', () => ({
  findOneAndUpdate: (...args) => mockHostSnapshotFindOneAndUpdate(...args),
  updateOne: jest.fn()
}));
jest.mock('../../../models/HostProfile', () => ({
  updateOne: (...args) => mockHostProfileUpdateOne(...args)
}));
jest.mock('../../../models/ModelPerformanceProfile', () => ({
  findOneAndUpdate: (...args) => mockModelPerformanceFindOneAndUpdate(...args),
  updateOne: (...args) => mockModelPerformanceUpdateOne(...args),
  updateMany: (...args) => mockModelPerformanceUpdateMany(...args)
}));
jest.mock('../../../models/ModelProfile', () => ({
  updateOne: (...args) => mockModelProfileUpdateOne(...args)
}));
jest.mock('../../../models/ModelContextProfile', () => ({
  updateOne: (...args) => mockContextProfileUpdateOne(...args)
}));
jest.mock('../../../models/ModelContextProbeSnapshot', () => ({
  updateOne: (...args) => mockContextSnapshotUpdateOne(...args),
  findOneAndUpdate: (...args) => mockContextSnapshotFindOneAndUpdate(...args)
}));
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
  mockHostProfileUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockModelPerformanceUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockModelPerformanceUpdateMany.mockResolvedValue({ matchedCount: 1 });
  mockModelProfileUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockContextProfileUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockContextSnapshotUpdateOne.mockResolvedValue({ matchedCount: 1 });
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

test('publishes profiler evidence only after the durable journal verifies every projection write', async () => {
  const details = {
    modelName: 'model-a',
    hostId: 'host-a',
    artifactDigest: 'sha256:model-a',
    runtimeFingerprint: 'runtime-a',
    authorityWriteId: 'write-a',
    evidenceId: 'evidence-a',
    thinking: true
  };
  const pending = {
    _id: 'journal-profiler-a',
    kind: 'profiler_evidence_write',
    resourceType: 'ModelPerformanceProfile',
    state: 'pending_reconciliation',
    details
  };
  mockReconciliationFindOneAndUpdate
    .mockReturnValueOnce(lean({ ...pending, state: 'verified', resolutionMode: 'publish' }))
    .mockReturnValueOnce(lean({ ...pending, state: 'resolved', resolutionMode: 'publish' }));
  mockModelPerformanceUpdateOne.mockResolvedValueOnce({ matchedCount: 1 });
  mockModelProfileUpdateOne.mockResolvedValueOnce({ matchedCount: 1 });

  await expect(service.completeProfilerAuthorityWrite(pending, { details }))
    .resolves.toMatchObject({ record: { state: 'resolved' } });

  expect(mockReconciliationFindOneAndUpdate.mock.invocationCallOrder[0])
    .toBeLessThan(mockModelPerformanceUpdateOne.mock.invocationCallOrder[0]);
  expect(mockModelPerformanceUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: 'evidence-a',
      authorityWriteId: 'write-a',
      authorityState: { $in: ['pending_reconciliation', 'authoritative'] }
    }),
    { $set: expect.objectContaining({ authorityState: 'authoritative' }) },
    undefined
  );
  expect(mockModelProfileUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'model-a',
      'readiness.host-a.authorityWriteId': 'write-a'
    }),
    { $set: expect.objectContaining({
      'readiness.host-a.authorityState': 'authoritative',
      'thinkingProfiles.host-a.authorityState': 'authoritative'
    }) },
    undefined
  );
});

test('publishes a context profile only after its durable journal and raw snapshot are committed', async () => {
  const details = {
    snapshotId: 'snapshot-context-a',
    authorityWriteId: 'write-context-a',
    modelName: 'model-a',
    hostUrl: 'http://host-a:11434',
    artifactDigest: 'sha256:model-a',
    runtimeFingerprint: 'runtime-a'
  };
  const pending = {
    _id: 'journal-context-a',
    kind: 'profiler_context_write',
    resourceType: 'ModelContextProfile',
    state: 'pending_reconciliation',
    details
  };
  mockReconciliationFindOneAndUpdate
    .mockReturnValueOnce(lean({ ...pending, state: 'verified', resolutionMode: 'publish' }))
    .mockReturnValueOnce(lean({ ...pending, state: 'resolved', resolutionMode: 'publish' }));

  await expect(service.completeProfilerAuthorityWrite(pending, { details }))
    .resolves.toMatchObject({ record: { state: 'resolved' } });

  expect(mockReconciliationFindOneAndUpdate.mock.invocationCallOrder[0])
    .toBeLessThan(mockContextSnapshotUpdateOne.mock.invocationCallOrder[0]);
  expect(mockContextSnapshotUpdateOne.mock.invocationCallOrder[0])
    .toBeLessThan(mockContextProfileUpdateOne.mock.invocationCallOrder[0]);
  expect(mockContextSnapshotUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({ _id: 'snapshot-context-a', authorityStatus: { $in: ['pending', 'committed'] } }),
    { $set: expect.objectContaining({ authorityStatus: 'committed' }) },
    undefined
  );
  expect(mockContextProfileUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      modelName: 'model-a',
      authorityWriteId: 'write-context-a',
      authorityState: { $in: ['pending_reconciliation', 'authoritative'] }
    }),
    { $set: expect.objectContaining({ authorityState: 'authoritative' }) },
    undefined
  );
});

test('restart compensation restores profiler evidence overwritten by an ambiguous in-place write', async () => {
  const priorEvidence = {
    _id: 'evidence-existing',
    modelName: 'model-a',
    hostId: 'host-a',
    artifact: { digest: 'sha256:model-a', runtimeFingerprint: 'runtime-a' },
    profile: { benchmarkQualified: true, score: 91 },
    authorityWriteId: 'write-prior',
    authorityReconciliationId: 'journal-prior',
    authorityState: 'authoritative',
    active: true,
    stale: false,
    staleReason: null
  };
  mockModelPerformanceFindOneAndUpdate
    .mockReturnValueOnce(lean({
      ...priorEvidence,
      authorityWriteId: 'write-ambiguous',
      authorityState: 'authority_invalidated'
    }))
    .mockReturnValueOnce(lean(priorEvidence));

  await expect(service._invalidateResource({
    _id: 'journal-ambiguous',
    kind: 'profiler_evidence_write',
    resourceType: 'ModelPerformanceProfile',
    resultId: 'profiler-evidence:workload-a:write-ambiguous',
    details: {
      modelName: 'model-a',
      hostId: 'host-a',
      authorityWriteId: 'write-ambiguous',
      priorEvidence
    }
  })).resolves.toMatchObject({ state: 'authority_invalidated' });

  expect(mockModelPerformanceFindOneAndUpdate).toHaveBeenCalledTimes(2);
  expect(mockModelPerformanceFindOneAndUpdate.mock.calls[1]).toEqual([
    {
      _id: 'evidence-existing',
      authorityWriteId: 'write-ambiguous',
      authorityState: 'authority_invalidated'
    },
    { $set: expect.objectContaining({
      profile: priorEvidence.profile,
      authorityWriteId: 'write-prior',
      authorityState: 'authoritative',
      active: true,
      stale: false
    }) },
    { new: true }
  ]);
});

test('restart compensation rejects an ambiguous context snapshot and restores prior authority', async () => {
  const priorProfile = {
    modelName: 'model-a',
    hostUrl: 'http://host-a:11434',
    artifactDigest: 'sha256:model-a',
    runtimeFingerprint: 'runtime-a',
    authorityState: 'authoritative',
    recommendedContext: 8192,
    rejectedEvidenceIds: ['older-rejected']
  };
  mockContextSnapshotFindOneAndUpdate.mockReturnValue(lean({
    _id: 'snapshot-context-ambiguous',
    authorityStatus: 'rejected'
  }));

  await expect(service._invalidateResource({
    _id: 'journal-context-ambiguous',
    kind: 'profiler_context_write',
    resourceType: 'ModelContextProfile',
    resultId: 'profiler-context:workload-a:write-context-a',
    details: {
      snapshotId: 'snapshot-context-ambiguous',
      authorityWriteId: 'write-context-a',
      modelName: 'model-a',
      hostUrl: 'http://host-a:11434',
      artifactDigest: 'sha256:model-a',
      runtimeFingerprint: 'runtime-a',
      snapshotPayload: { modelName: 'model-a', authorityStatus: 'pending' },
      priorProfile
    }
  })).resolves.toMatchObject({
    resourceId: 'snapshot-context-ambiguous',
    state: 'authority_invalidated'
  });

  expect(mockContextSnapshotFindOneAndUpdate).toHaveBeenCalledWith(
    { _id: 'snapshot-context-ambiguous' },
    expect.objectContaining({
      $set: expect.objectContaining({ authorityStatus: 'rejected', authorityWriteId: 'write-context-a' })
    }),
    expect.objectContaining({ upsert: true, new: true })
  );
  expect(mockContextProfileUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({ modelName: 'model-a', artifactDigest: 'sha256:model-a' }),
    { $set: expect.objectContaining({
      authorityState: 'authoritative',
      recommendedContext: 8192,
      rejectedEvidenceIds: ['older-rejected', 'snapshot-context-ambiguous']
    }) },
    expect.objectContaining({ upsert: true })
  );
});

test('restart worker tombstones an ambiguously acknowledged profiler snapshot before releasing Core', async () => {
  const calls = [];
  const record = {
    _id: 'journal-snapshot-a',
    kind: 'profiler_snapshot_write',
    resourceType: 'HostPerformanceSnapshot',
    resultId: 'profiler-snapshot:workload-a:snapshot-a',
    workloadId: proof.workloadId,
    admissionId: proof.admissionId,
    admissionGeneration: proof.generation,
    admissionPrincipal: proof.principal,
    recoveryId: proof.recoveryId,
    recoveryRequestId: proof.recoveryRequestId,
    phase: 'snapshot save',
    state: 'pending_reconciliation',
    resolutionMode: 'invalidate',
    details: {
      snapshotId: 'snapshot-a',
      authorityWriteId: 'write-snapshot-a',
      payload: {
        modelName: 'model-a',
        hostUrl: 'http://host-a:11434',
        status: 'pass'
      }
    }
  };
  const ownership = { ownerId: 'worker-restart', ownerEpoch: 'epoch-snapshot', record };
  let coreState = 'MUTATING';
  mockAdoptRecovery.mockImplementation(async () => {
    calls.push('adopt');
    return { adopted: true };
  });
  mockAssertRecovery.mockImplementation(async () => ({
    owned: true,
    recoveryOwnerId: ownership.ownerId,
    recoveryState: coreState
  }));
  mockTransitionRecovery.mockImplementation(async (_workloadId, state) => {
    coreState = state;
    calls.push(`transition:${state}`);
    return { transitioned: true, recoveryState: state };
  });
  mockReconciliationFindOne.mockImplementation(() => lean({ _id: record._id }));
  mockHostSnapshotFindOneAndUpdate.mockImplementation(() => {
    calls.push('tombstone');
    return lean({ _id: 'snapshot-a', __v: 2 });
  });
  mockReconciliationFindOneAndUpdate
    .mockImplementationOnce(() => lean({ ...record, state: 'verified', compensationReceipt: { afterVersion: 2 } }))
    .mockImplementationOnce(() => lean({ ...record, state: 'releasing', compensationReceipt: { afterVersion: 2 } }))
    .mockImplementationOnce(() => lean({ ...record, state: 'resolved' }));
  mockReleaseAdmission.mockImplementation(async () => {
    calls.push('release');
    return { released: true };
  });

  await expect(service._reconcileOwnedRecord(ownership)).resolves.toMatchObject({ resolved: true });
  expect(calls.indexOf('adopt')).toBeLessThan(calls.indexOf('tombstone'));
  expect(calls.indexOf('tombstone')).toBeLessThan(calls.indexOf('release'));
  expect(mockHostSnapshotFindOneAndUpdate).toHaveBeenCalledWith(
    { _id: 'snapshot-a' },
    expect.objectContaining({
      $setOnInsert: expect.objectContaining({ modelName: 'model-a' }),
      $set: expect.objectContaining({ authorityState: 'authority_invalidated' })
    }),
    expect.objectContaining({ upsert: true, new: true, signal: expect.any(AbortSignal) })
  );
});

test('baseline recovery fences the receipt before restoring the prior value', async () => {
  await expect(service._invalidateResource({
    _id: 'journal-baseline-a',
    kind: 'profiler_baseline_write',
    resourceType: 'HostProfileBaseline',
    resultId: 'baseline-write-a',
    details: {
      hostId: 'host-a',
      persistenceReceipt: 'receipt-a',
      authorityWriteId: 'write-a',
      priorBaseline: { referenceModel: 'old-model', tokensPerSec: 10 }
    }
  })).resolves.toMatchObject({ state: 'authority_invalidated', persistenceReceipt: 'receipt-a' });

  expect(mockHostProfileUpdateOne.mock.calls[0]).toEqual([
    { hostId: 'host-a' },
    { $addToSet: { rejectedBaselineReceipts: 'receipt-a' } },
    undefined
  ]);
  expect(mockHostProfileUpdateOne.mock.calls[1]).toEqual([
    { hostId: 'host-a', 'baseline.persistenceReceipt': 'receipt-a' },
    { $set: { baseline: { referenceModel: 'old-model', tokensPerSec: 10 } } },
    undefined
  ]);
});

test('the restart sweep gives every profiler projection write a stale-owner grace window', async () => {
  const leanQuery = jest.fn().mockResolvedValue([]);
  const limitQuery = jest.fn(() => ({ lean: leanQuery }));
  const sortQuery = jest.fn(() => ({ limit: limitQuery }));
  mockReconciliationFind.mockReturnValue({ sort: sortQuery });

  await expect(service.reconcilePendingResultInvalidations({ limit: 5 }))
    .resolves.toMatchObject({ inspected: 0, resolved: 0, pending: 0 });

  expect(mockReconciliationFind).toHaveBeenCalledWith({
    state: { $ne: 'resolved' },
    $or: [
      { kind: { $nin: [
        'profiler_evidence_write',
        'profiler_baseline_write',
        'profiler_snapshot_write',
        'profiler_context_write'
      ] } },
      {
        kind: { $in: [
          'profiler_evidence_write',
          'profiler_baseline_write',
          'profiler_snapshot_write',
          'profiler_context_write'
        ] },
        startedAt: { $lte: expect.any(Date) }
      }
    ]
  });
});

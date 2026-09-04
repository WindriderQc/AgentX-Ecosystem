'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const JudgeAccuracyMatrix = require('../../../models/JudgeAccuracyMatrix');
const JudgeGovernanceRun = require('../../../models/JudgeGovernanceRun');
const JudgeGroundTruth = require('../../../models/JudgeGroundTruth');
const HostPerformanceSnapshot = require('../../../models/HostPerformanceSnapshot');
const HostProfile = require('../../../models/HostProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelProfile = require('../../../models/ModelProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const ModelContextProbeSnapshot = require('../../../models/ModelContextProbeSnapshot');
const {
  getWorkloadRecoveryIdentity,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  restoreWorkloadRecoveryHosts,
  releaseWorkloadAdmission,
  recoverWorkloadAdmissionRelease
} = require('../../clients/coreApiClient');
const logger = require('../../../config/logger');
const { startRecoveryOwnershipHeartbeat } = require('../recoveryOwnershipHeartbeat');

const DEFAULT_INTERVAL_MS = 5_000;
const OWNER_STALE_MS = 60_000;
let interval = null;
let running = false;

function objectId(value) {
  const text = String(value || '');
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : value;
}

function resourceTypeForKind(kind) {
  return {
    workload_invalidation: 'BenchmarkWorkload',
    result_invalidation: 'BenchmarkResult',
    batch_invalidation: 'BenchmarkBatch',
    judge_matrix_invalidation: 'JudgeAccuracyMatrix',
    judge_governance_invalidation: 'JudgeGovernanceRun',
    ground_truth_invalidation: 'JudgeGroundTruth',
    profiler_evidence_write: 'ModelPerformanceProfile',
    profiler_baseline_write: 'HostProfileBaseline',
    profiler_snapshot_write: 'HostPerformanceSnapshot',
    profiler_context_write: 'ModelContextProfile'
  }[kind] || null;
}

function authorityInvalidationFields(record) {
  const reason = `Authority was lost during ${record.phase}; durable reconciliation invalidated this projection`;
  if (record.kind === 'result_invalidation') {
    return {
      excluded_from_leaderboard: true,
      needs_review: true,
      scoring_method: 'authority_invalidated',
      quality_score: null,
      composite_score: null,
      review_reason: reason,
      authority_state: 'authority_invalidated',
      authority_reconciliation_reason: reason
    };
  }
  if (record.kind === 'judge_governance_invalidation') {
    return { status: 'failed', authority_state: 'authority_invalidated', authority_reconciliation_reason: reason };
  }
  if (record.kind === 'ground_truth_invalidation') {
    return { active: false, authority_state: 'authority_invalidated', authority_reconciliation_reason: reason };
  }
  if (record.kind === 'workload_invalidation') {
    return {
      status: 'failed',
      authority_state: 'authority_invalidated',
      authority_reconciliation_reason: reason,
      failure_reason: 'workload_authority_reconciled_after_owner_loss',
      completed_at: new Date(),
      last_activity_at: new Date()
    };
  }
  return { authority_state: 'authority_invalidated', authority_reconciliation_reason: reason };
}

function resourceModel(record) {
  return {
    workload_invalidation: BenchmarkBatch,
    result_invalidation: BenchmarkResult,
    batch_invalidation: BenchmarkBatch,
    judge_matrix_invalidation: JudgeAccuracyMatrix,
    judge_governance_invalidation: JudgeGovernanceRun,
    ground_truth_invalidation: JudgeGroundTruth,
    profiler_evidence_write: ModelPerformanceProfile,
    profiler_baseline_write: HostProfile,
    profiler_snapshot_write: HostPerformanceSnapshot,
    profiler_context_write: ModelContextProfile
  }[record.kind] || null;
}

async function prepareWorkloadAuthority({ workloadId, batchId = null, phase = 'workload' } = {}) {
  const workloadKey = String(workloadId || '');
  if (!workloadKey) throw new Error('workloadId is required for authority guard');
  const recovery = getWorkloadRecoveryIdentity(workloadKey);
  if (!recovery?.recoveryId || !recovery?.recoveryRequestId
    || !recovery?.admissionId || !recovery?.generation || !recovery?.principal) {
    throw new Error(`Durable recovery quarantine proof is missing for workload ${workloadKey}`);
  }
  const resultId = `workload:${workloadKey}`;
  return BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId },
    {
      $setOnInsert: {
        kind: 'workload_invalidation',
        resultId,
        resourceType: 'BenchmarkWorkload',
        batchId: batchId ? String(batchId) : null,
        workloadId: workloadKey,
        admissionId: recovery.admissionId,
        admissionGeneration: recovery.generation,
        admissionPrincipal: recovery.principal,
        recoveryId: recovery.recoveryId,
        recoveryRequestId: recovery.recoveryRequestId,
        phase,
        state: 'pending_reconciliation',
        reason: 'workload owner has not published a terminal authority receipt',
        attempts: 0,
        startedAt: new Date()
      }
    },
    { upsert: true, new: true }
  ).lean();
}

async function verifyWorkloadAuthority(workloadId, receipt = {}) {
  const workloadKey = String(workloadId || '');
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: `workload:${workloadKey}`, workloadId: workloadKey, state: 'pending_reconciliation' },
    { $set: {
      state: 'verified',
      reason: null,
      compensationReceipt: {
        contract: 'agentx.authority-workload-terminal/v1',
        workloadId: workloadKey,
        ...receipt,
        verifiedAt: new Date().toISOString()
      }
    } },
    { new: true }
  ).lean();
  if (!updated) throw new Error(`Workload authority guard ${workloadKey} could not be verified`);
  return updated;
}

async function resolveWorkloadAuthority(workloadId, releaseReceipt) {
  const workloadKey = String(workloadId || '');
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: `workload:${workloadKey}`, workloadId: workloadKey, state: { $in: ['verified', 'releasing'] } },
    { $set: {
      state: 'resolved',
      reason: null,
      releaseReceipt,
      resolvedAt: new Date(),
      ownerId: null,
      ownerEpoch: null,
      ownerClaimedAt: null
    } },
    { new: true }
  ).lean();
  if (!updated) throw new Error(`Workload authority guard ${workloadKey} terminal receipt could not be projected`);
  return updated;
}

async function enqueueAuthorityInvalidation({
  kind = 'result_invalidation',
  resultId,
  batchId,
  workloadId,
  phase,
  reason,
  details = null,
  resolutionMode = 'invalidate'
}) {
  const identity = String(resultId || '');
  const workloadKey = String(workloadId || batchId || '');
  if (!identity) throw new Error('resultId is required for authority reconciliation');
  const recovery = getWorkloadRecoveryIdentity(workloadKey);
  if (!workloadKey || !recovery?.recoveryId || !recovery?.recoveryRequestId
    || !recovery?.admissionId || !recovery?.generation || !recovery?.principal) {
    throw new Error(`Durable recovery quarantine proof is missing for workload ${workloadKey || 'unknown'}`);
  }
  const resourceType = resourceTypeForKind(kind);
  if (!resourceType) throw new Error(`Unsupported authority reconciliation kind: ${kind}`);
  const record = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: identity },
    {
      $setOnInsert: {
        kind,
        resultId: identity,
        resourceType,
        batchId: batchId ? String(batchId) : null,
        workloadId: workloadKey,
        admissionId: recovery.admissionId,
        admissionGeneration: recovery.generation,
        admissionPrincipal: recovery.principal,
        recoveryId: recovery.recoveryId,
        recoveryRequestId: recovery.recoveryRequestId,
        phase,
        details,
        resolutionMode,
        state: 'pending_reconciliation',
        reason: reason || null,
        attempts: 0,
        startedAt: new Date()
      },
      $set: { lastError: reason || null }
    },
    { upsert: true, new: true }
  ).lean();

  if (batchId) {
    try {
      await BenchmarkBatch.updateOne(
        { _id: batchId, authority_state: { $ne: 'authority_invalidated' } },
        { $set: {
          authority_state: 'pending_reconciliation',
          authority_reconciliation_reason: `${resourceType} ${identity} persistence acknowledgement was ambiguous`
        } }
      );
    } catch (error) {
      logger.error('Benchmark batch pending-authority projection could not be persisted', {
        batchId: String(batchId), reconciliationId: String(record._id), error: error.message
      });
    }
  }
  return record;
}

function enqueueResultInvalidation(input) {
  return enqueueAuthorityInvalidation({ ...input, kind: 'result_invalidation' });
}

function isProfilerAuthorityKind(kind) {
  return new Set([
    'profiler_evidence_write',
    'profiler_baseline_write',
    'profiler_snapshot_write',
    'profiler_context_write'
  ]).has(kind);
}

async function prepareProfilerAuthorityWrite(input = {}) {
  if (!isProfilerAuthorityKind(input.kind)) {
    throw new Error(`Unsupported profiler authority write kind: ${input.kind || 'unknown'}`);
  }
  return enqueueAuthorityInvalidation({
    ...input,
    reason: input.reason || 'profiler authority write prepared before first projection mutation',
    resolutionMode: 'invalidate'
  });
}

function matchedExactlyOne(result) {
  const matched = Number(result?.matchedCount ?? result?.modifiedCount);
  return !Number.isFinite(matched) || matched === 1;
}

async function publishProfilerResource(record, options = {}) {
  const details = record.details || {};
  options.assertActive?.();
  if (record.kind === 'profiler_evidence_write') {
    const evidenceId = details.evidenceId || null;
    const evidence = await ModelPerformanceProfile.updateOne(
      {
        ...(evidenceId ? { _id: objectId(evidenceId) } : {
          modelName: details.modelName,
          hostId: details.hostId,
          'artifact.digest': details.artifactDigest,
          'artifact.runtimeFingerprint': details.runtimeFingerprint
        }),
        authorityWriteId: details.authorityWriteId,
        authorityState: { $in: ['pending_reconciliation', 'authoritative'] }
      },
      { $set: { authorityState: 'authoritative', authorityReconciliationId: String(record._id) } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(evidence)) throw new Error('Profiler evidence publication CAS did not match its pending write');
    const readinessSet = {
      [`readiness.${details.hostId}.authorityState`]: 'authoritative'
    };
    if (details.thinking === true) {
      readinessSet[`thinkingProfiles.${details.hostId}.authorityState`] = 'authoritative';
    }
    const projection = await ModelProfile.updateOne(
      {
        name: details.modelName,
        [`readiness.${details.hostId}.evidenceId`]: objectId(evidenceId),
        [`readiness.${details.hostId}.authorityWriteId`]: details.authorityWriteId,
        rejectedAuthorityWriteIds: { $ne: details.authorityWriteId }
      },
      { $set: readinessSet },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(projection)) throw new Error('Profiler readiness publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: String(evidenceId),
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_snapshot_write') {
    const snapshot = await HostPerformanceSnapshot.updateOne(
      {
        _id: objectId(details.snapshotId || record.resultId),
        authorityWriteId: details.authorityWriteId,
        authorityState: { $in: ['pending_reconciliation', 'authoritative'] }
      },
      { $set: { authorityState: 'authoritative', authorityReconciliationId: String(record._id) } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(snapshot)) throw new Error('Host snapshot publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: String(details.snapshotId || record.resultId),
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_baseline_write') {
    const baseline = await HostProfile.updateOne(
      {
        hostId: details.hostId,
        'baseline.persistenceReceipt': details.persistenceReceipt,
        'baseline.authorityWriteId': details.authorityWriteId,
        'baseline.authorityState': { $in: ['pending_reconciliation', 'authoritative'] },
        rejectedBaselineReceipts: { $ne: details.persistenceReceipt }
      },
      { $set: {
        'baseline.authorityState': 'authoritative',
        'baseline.authorityReconciliationId': String(record._id)
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(baseline)) throw new Error('Host baseline publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: details.hostId,
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_context_write') {
    const snapshot = await ModelContextProbeSnapshot.updateOne(
      {
        _id: objectId(details.snapshotId),
        authorityWriteId: details.authorityWriteId,
        authorityStatus: { $in: ['pending', 'committed'] }
      },
      { $set: {
        authorityStatus: 'committed',
        authorityError: null,
        authorityReconciliationId: String(record._id)
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(snapshot)) throw new Error('Context probe snapshot publication CAS did not match its pending write');
    const profile = await ModelContextProfile.updateOne(
      {
        modelName: details.modelName,
        hostUrl: details.hostUrl,
        artifactDigest: details.artifactDigest,
        runtimeFingerprint: details.runtimeFingerprint,
        authorityWriteId: details.authorityWriteId,
        authorityState: { $in: ['pending_reconciliation', 'authoritative'] },
        rejectedEvidenceIds: { $ne: details.snapshotId }
      },
      { $set: {
        authorityState: 'authoritative',
        authorityReconciliationId: String(record._id)
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(profile)) throw new Error('Context profile publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: details.snapshotId,
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  throw new Error(`Unsupported profiler authority publication kind: ${record.kind}`);
}

async function completeProfilerAuthorityWrite(recordOrId, input = {}) {
  const recordId = recordOrId?._id || recordOrId;
  input.assertAuthorityActive?.();
  const verified = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    {
      _id: recordId,
      state: 'pending_reconciliation',
      $or: [{ ownerId: null }, { ownerId: { $exists: false } }]
    },
    { $set: {
      state: 'verified',
      resolutionMode: 'publish',
      details: input.details || recordOrId?.details || null,
      compensationReceipt: {
        contract: 'agentx.profiler-authority-write/v1',
        terminal: 'all_projection_writes_acknowledged',
        verifiedAt: new Date().toISOString()
      },
      lastError: null
    } },
    { new: true, ...(input.signal ? { signal: input.signal } : {}) }
  ).lean();
  if (!verified) {
    const error = new Error('Profiler authority journal verification CAS was lost');
    error.code = 'PROFILER_AUTHORITY_RECONCILIATION_PENDING';
    error.retainAdmission = true;
    error.authorityInvalidationFailed = true;
    throw error;
  }
  input.assertAuthorityActive?.();
  const publicationReceipt = await publishProfilerResource(verified, {
    signal: input.signal,
    assertActive: input.assertAuthorityActive
  });
  input.assertAuthorityActive?.();
  const resolvedAt = new Date();
  const resolved = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { _id: recordId, state: 'verified', resolutionMode: 'publish' },
    { $set: {
      state: 'resolved',
      compensationReceipt: publicationReceipt,
      resolvedAt,
      lastError: null,
      ownerId: null,
      ownerEpoch: null,
      ownerClaimedAt: null
    } },
    { new: true, ...(input.signal ? { signal: input.signal } : {}) }
  ).lean();
  if (!resolved) {
    const error = new Error('Profiler authority journal resolution CAS was lost');
    error.code = 'PROFILER_AUTHORITY_RECONCILIATION_PENDING';
    error.retainAdmission = true;
    error.authorityInvalidationFailed = true;
    throw error;
  }
  return { record: resolved, publicationReceipt };
}

async function invalidateResource(record, options = {}) {
  options.assertActive?.();
  if (record.kind === 'workload_invalidation') {
    const batchId = record.batchId || null;
    const fields = authorityInvalidationFields(record);
    const [batch, results, matrices, governance, groundTruth] = await Promise.all([
      batchId
        ? BenchmarkBatch.findOneAndUpdate(
          { _id: objectId(batchId) },
          { $set: fields, $inc: { __v: 1 } },
          { new: true, ...(options.signal ? { signal: options.signal } : {}) }
        ).lean()
        : null,
      batchId ? BenchmarkResult.updateMany(
        { $or: [{ batch_id: String(batchId) }, { batchId: String(batchId) }] },
        { $set: authorityInvalidationFields({ ...record, kind: 'result_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null,
      batchId ? JudgeAccuracyMatrix.updateMany(
        { batch_id: String(batchId) },
        { $set: authorityInvalidationFields({ ...record, kind: 'judge_matrix_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null,
      batchId ? JudgeGovernanceRun.updateMany(
        { batch_id: String(batchId) },
        { $set: authorityInvalidationFields({ ...record, kind: 'judge_governance_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null,
      batchId ? JudgeGroundTruth.updateMany(
        { tags: `batch:${String(batchId)}` },
        { $set: authorityInvalidationFields({ ...record, kind: 'ground_truth_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null
    ]);
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: record.resultId,
      workloadId: record.workloadId,
      batchId,
      state: 'authority_invalidated',
      afterVersion: Number.isFinite(Number(batch?.__v)) ? Number(batch.__v) : null,
      affected: {
        batch: batch ? 1 : 0,
        results: Number(results?.modifiedCount || 0),
        matrices: Number(matrices?.modifiedCount || 0),
        governance: Number(governance?.modifiedCount || 0),
        groundTruth: Number(groundTruth?.modifiedCount || 0)
      },
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_evidence_write') {
    const details = record.details || {};
    const invalidated = await ModelPerformanceProfile.findOneAndUpdate(
      {
        modelName: details.modelName,
        hostId: details.hostId,
        authorityWriteId: details.authorityWriteId
      },
      {
        $setOnInsert: {
          artifact: details.artifact,
          profile: details.profile
        },
        $set: {
        active: false,
        stale: true,
        staleReason: 'profiler_authority_write_reconciled',
        authorityState: 'authority_invalidated',
        authorityReconciliationId: String(record._id)
        }
      },
      { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
    ).lean();
    await ModelProfile.updateOne(
      { name: details.modelName },
      {
        $addToSet: { rejectedAuthorityWriteIds: details.authorityWriteId },
        $set: {
          [`readiness.${details.hostId}`]: details.priorReadiness || null,
          ...(details.thinking === true
            ? { [`thinkingProfiles.${details.hostId}`]: details.priorThinking || null }
            : {})
        }
      },
      options.signal ? { signal: options.signal } : undefined
    );
    await ModelPerformanceProfile.updateMany(
      {
        modelName: details.modelName,
        hostId: details.hostId,
        supersededByAuthorityWriteId: details.authorityWriteId
      },
      { $set: {
        active: true,
        stale: false,
        staleReason: null,
        supersededByAuthorityWriteId: null
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: details.evidenceId || record.resultId,
      state: 'authority_invalidated',
      afterVersion: Number.isFinite(Number(invalidated?.__v)) ? Number(invalidated.__v) : null,
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_snapshot_write') {
    const details = record.details || {};
    const payload = details.payload || {};
    const updated = await HostPerformanceSnapshot.findOneAndUpdate(
      { _id: objectId(details.snapshotId || record.resultId) },
      {
        $setOnInsert: payload,
        $set: {
          authorityState: 'authority_invalidated',
          authorityReconciliationReason: 'host snapshot persistence acknowledgement reconciled after owner loss',
          authorityWriteId: details.authorityWriteId,
          authorityReconciliationId: String(record._id)
        }
      },
      { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
    ).lean();
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: String(details.snapshotId || record.resultId),
      state: 'authority_invalidated',
      afterVersion: Number.isFinite(Number(updated?.__v)) ? Number(updated.__v) : null,
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_baseline_write') {
    const details = record.details || {};
    const receipt = String(details.persistenceReceipt || '');
    const fenced = await HostProfile.updateOne(
      { hostId: details.hostId },
      { $addToSet: { rejectedBaselineReceipts: receipt } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(fenced)) throw new Error('Host baseline receipt fence did not match its host');
    const replacement = details.priorBaseline
      ? { $set: { baseline: details.priorBaseline } }
      : { $unset: { baseline: '' } };
    await HostProfile.updateOne(
      { hostId: details.hostId, 'baseline.persistenceReceipt': receipt },
      replacement,
      options.signal ? { signal: options.signal } : undefined
    );
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: details.hostId,
      state: 'authority_invalidated',
      persistenceReceipt: receipt,
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_context_write') {
    const details = record.details || {};
    await ModelContextProbeSnapshot.findOneAndUpdate(
      { _id: objectId(details.snapshotId) },
      {
        $setOnInsert: details.snapshotPayload || {},
        $set: {
          authorityStatus: 'rejected',
          authorityError: 'context authority write reconciled after owner loss',
          authorityWriteId: details.authorityWriteId,
          authorityReconciliationId: String(record._id)
        }
      },
      { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
    ).lean();
    const identity = {
      modelName: details.modelName,
      hostUrl: details.hostUrl,
      artifactDigest: details.artifactDigest,
      runtimeFingerprint: details.runtimeFingerprint
    };
    const rejected = [
      ...new Set([...(details.priorProfile?.rejectedEvidenceIds || []), String(details.snapshotId)])
    ];
    if (details.priorProfile) {
      const { _id, __v, createdAt, updatedAt, ...priorProfile } = details.priorProfile;
      await ModelContextProfile.updateOne(
        identity,
        { $set: { ...priorProfile, rejectedEvidenceIds: rejected } },
        { upsert: true, ...(options.signal ? { signal: options.signal } : {}) }
      );
    } else {
      await ModelContextProfile.updateOne(
        identity,
        {
          $setOnInsert: identity,
          $set: {
            authorityState: 'authority_invalidated',
            authorityWriteId: details.authorityWriteId,
            authorityReconciliationId: String(record._id),
            stale: true,
            staleReason: 'context_authority_write_reconciled',
            recommendationStatus: 'unknown',
            revalidationRequired: true,
            recommendedInteractiveContext: null,
            recommendedDocumentContext: null,
            performanceKneeContext: null,
            qualityVerifiedContext: null,
            qualityContextStatus: 'unknown',
            recommendedContext: null,
            rejectedEvidenceIds: rejected
          }
        },
        { upsert: true, ...(options.signal ? { signal: options.signal } : {}) }
      );
    }
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: details.snapshotId,
      state: 'authority_invalidated',
      compensatedAt: new Date().toISOString()
    };
  }
  const Model = resourceModel(record);
  if (!Model) throw new Error(`Unsupported authority reconciliation kind: ${record.kind}`);
  const id = objectId(record.resultId);
  const update = { $set: authorityInvalidationFields(record), $inc: { __v: 1 } };
  const query = Model.findOneAndUpdate(
    { _id: id },
    update,
    { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
  );
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;
  if (!updated) throw new Error(`Authority invalidation did not return ${record.resourceType} ${record.resultId}`);
  if (record.kind === 'result_invalidation' && record.batchId) {
    await BenchmarkBatch.updateOne(
      { _id: record.batchId },
      { $set: authorityInvalidationFields({ ...record, kind: 'batch_invalidation' }), $inc: { __v: 1 } },
      options.signal ? { signal: options.signal } : undefined
    );
  }
  options.assertActive?.();
  return {
    contract: 'agentx.authority-compensation/v1',
    resourceType: record.resourceType,
    resourceId: record.resultId,
    state: 'authority_invalidated',
    afterVersion: Number(updated.__v),
    compensatedAt: new Date().toISOString()
  };
}

async function claimRecoveryRecord(record, ownerId) {
  const ownerEpoch = crypto.randomUUID();
  const claimed = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    {
      _id: record._id,
      state: { $ne: 'resolved' },
      $or: [
        { ownerId: null },
        { ownerId: { $exists: false } },
        { ownerClaimedAt: { $lte: new Date(Date.now() - OWNER_STALE_MS) } }
      ]
    },
    { $set: { ownerId, ownerEpoch, ownerClaimedAt: new Date() } },
    { new: true }
  ).lean();
  return claimed ? { record: claimed, ownerId, ownerEpoch } : null;
}

async function assertJournalOwner(recordId, ownerId, ownerEpoch, states, options = {}) {
  const journal = await BenchmarkAuthorityReconciliation.findOne({
    _id: recordId,
    state: { $in: states },
    ownerId,
    ownerEpoch
  }, null, options.signal ? { signal: options.signal } : undefined).lean();
  if (!journal) {
    const error = new Error('Authority reconciliation journal ownership was lost');
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
  return journal;
}

async function refreshJournalOwner(ownership, { signal } = {}) {
  const { record, ownerId, ownerEpoch } = ownership;
  const result = await BenchmarkAuthorityReconciliation.updateOne(
    { _id: record._id, state: { $ne: 'resolved' }, ownerId, ownerEpoch },
    { $set: { ownerClaimedAt: new Date() } },
    { signal }
  );
  if (Number(result?.matchedCount ?? result?.modifiedCount) !== 1) {
    const error = new Error('Authority reconciliation journal ownership was lost');
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
}

async function adoptAndAssert(record, ownerId, options = {}) {
  await adoptWorkloadRecovery({
    workloadId: record.workloadId,
    recoveryId: record.recoveryId,
    recoveryRequestId: record.recoveryRequestId,
    ownerId,
    signal: options.signal
  });
  const heartbeat = await heartbeatWorkloadRecovery(record.workloadId, undefined, options);
  if (heartbeat?.heartbeat !== true) {
    const error = new Error(heartbeat?.reason || 'Core recovery owner heartbeat was rejected');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  const core = await assertWorkloadRecovery(record.workloadId, options);
  if (core?.owned !== true || core.recoveryOwnerId !== ownerId) {
    const error = new Error(core?.reason || 'Core recovery quarantine ownership was lost');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  return core;
}

async function persistJournalState(ownership, fromStates, state, fields = {}, options = {}) {
  options.assertActive?.();
  const { record, ownerId, ownerEpoch } = ownership;
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { _id: record._id, state: { $in: fromStates }, ownerId, ownerEpoch },
    { $set: { state, ...fields, lastAttemptAt: new Date() }, $inc: { attempts: 1 } },
    { new: true, ...(options.signal ? { signal: options.signal } : {}) }
  ).lean();
  if (!updated) {
    const error = new Error(`Authority reconciliation ${state} receipt CAS was lost`);
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
  options.assertActive?.();
  ownership.record = updated;
  return updated;
}

async function reconcileOwnedRecord(ownership) {
  let { record } = ownership;
  const { ownerId, ownerEpoch } = ownership;
  const ownershipHeartbeat = startRecoveryOwnershipHeartbeat({
    refreshOwner: options => refreshJournalOwner(ownership, options)
  });

  try {
  await ownershipHeartbeat.ready;

  if (record.state === 'verified' || record.state === 'releasing') {
    if (record.state === 'verified' && record.resolutionMode === 'publish' && isProfilerAuthorityKind(record.kind)) {
      const publicationReceipt = await publishProfilerResource(record, {
        signal: ownershipHeartbeat.signal,
        assertActive: ownershipHeartbeat.assertActive
      });
      record = await persistJournalState(ownership, ['verified'], 'verified', {
        compensationReceipt: publicationReceipt,
        lastError: null
      }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
    }
    ownershipHeartbeat.assertActive();
    const recovered = await recoverWorkloadAdmissionRelease({
      admissionId: record.admissionId,
      generation: record.admissionGeneration,
      principal: record.admissionPrincipal,
      workloadId: record.workloadId,
      recoveryId: record.recoveryId
    }, { signal: ownershipHeartbeat.signal });
    ownershipHeartbeat.assertActive();
    if (recovered?.released === true) {
      const resolvedAt = new Date();
      await persistJournalState(ownership, ['verified', 'releasing'], 'resolved', {
        releaseReceipt: recovered,
        resolvedAt,
        lastError: null,
        ownerId: null,
        ownerEpoch: null,
        ownerClaimedAt: null
      }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
      return { resolved: true, resultId: record.resultId, resolvedAt, recovered: true };
    }
  }

  await adoptAndAssert(record, ownerId, { signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.setCoreHeartbeat(({ signal }) => heartbeatWorkloadRecovery(
    record.workloadId,
    undefined,
    { signal }
  ));
  await ownershipHeartbeat.heartbeatOnce();
  ownershipHeartbeat.assertActive();
  await assertJournalOwner(
    record._id,
    ownerId,
    ownerEpoch,
    ['pending_reconciliation', 'verified', 'releasing'],
    { signal: ownershipHeartbeat.signal }
  );

  if (record.state === 'pending_reconciliation') {
    await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
      if (result?.heartbeat !== true) {
        const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
        error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
        throw error;
      }
    });
    const core = await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal });
    if (new Set(['PREPARED', 'MUTATING']).has(core.recoveryState)) {
      await transitionWorkloadRecovery(record.workloadId, 'UNKNOWN', {
        signal: ownershipHeartbeat.signal,
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'ambiguous-authority-write' }
      });
    }
    ownershipHeartbeat.assertActive();
    const compensationReceipt = await invalidateResource(record, {
      signal: ownershipHeartbeat.signal,
      assertActive: ownershipHeartbeat.assertActive
    });
    ownershipHeartbeat.assertActive();
    await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
      if (result?.heartbeat !== true) {
        const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
        error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
        throw error;
      }
    });
    await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal }).then(result => {
      if (result?.owned !== true || result.recoveryOwnerId !== ownerId) {
        const error = new Error(result?.reason || 'Core recovery ownership was lost after compensation');
        error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
        throw error;
      }
    });
    record = await persistJournalState(ownership, ['pending_reconciliation'], 'verified', {
      compensationReceipt,
      lastError: null
    }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
  }

  if (record.state === 'verified') {
    if (record.resolutionMode === 'publish' && isProfilerAuthorityKind(record.kind)) {
      const publicationReceipt = await publishProfilerResource(record, {
        signal: ownershipHeartbeat.signal,
        assertActive: ownershipHeartbeat.assertActive
      });
      record = await persistJournalState(ownership, ['verified'], 'verified', {
        compensationReceipt: publicationReceipt,
        lastError: null
      }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
    }
    const core = await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal });
    if (core.recoveryState !== 'VERIFIED' && core.recoveryState !== 'RESTORED') {
      await transitionWorkloadRecovery(record.workloadId, 'VERIFIED', {
        signal: ownershipHeartbeat.signal,
        receipt: record.compensationReceipt
      });
    }
    const afterVerified = await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal });
    if (afterVerified.recoveryState !== 'RESTORED') {
      await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
        if (result?.heartbeat !== true) {
          const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
          error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
          throw error;
        }
      });
      ownershipHeartbeat.assertActive();
      const hostRestore = await restoreWorkloadRecoveryHosts(
        record.workloadId,
        {},
        { signal: ownershipHeartbeat.signal }
      );
      ownershipHeartbeat.assertActive();
      if (hostRestore?.restored !== true) {
        throw new Error(hostRestore?.reason || 'Core host restoration under recovery quarantine failed');
      }
      await transitionWorkloadRecovery(record.workloadId, 'RESTORED', {
        signal: ownershipHeartbeat.signal,
        receipt: {
          contract: 'agentx.workload-recovery/v1',
          event: 'authority-restored',
          compensation: record.compensationReceipt
        }
      });
    }
    record = await persistJournalState(
      ownership,
      ['verified'],
      'releasing',
      { lastError: null },
      { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive }
    );
  }

  ownershipHeartbeat.assertActive();
  const remaining = await BenchmarkAuthorityReconciliation.countDocuments({
    workloadId: record.workloadId,
    state: { $in: ['pending_reconciliation', 'verified'] },
    _id: { $ne: record._id }
  }, { signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.assertActive();
  if (remaining > 0) {
    return { resolved: false, resultId: record.resultId, reason: 'other authority reconciliations remain pending' };
  }
  await assertJournalOwner(
    record._id,
    ownerId,
    ownerEpoch,
    ['releasing'],
    { signal: ownershipHeartbeat.signal }
  );
  await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
    if (result?.heartbeat !== true) {
      const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
      error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
      throw error;
    }
  });
  ownershipHeartbeat.assertActive();
  const released = await releaseWorkloadAdmission(record.workloadId, { signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.setCoreHeartbeat(null);
  ownershipHeartbeat.assertActive();
  if (released?.released !== true) throw new Error(released?.reason || 'Recovery quarantine release was not acknowledged');
  const resolvedAt = new Date();
  await persistJournalState(ownership, ['releasing'], 'resolved', {
    releaseReceipt: released,
    resolvedAt,
    lastError: null,
    ownerId: null,
    ownerEpoch: null,
    ownerClaimedAt: null
  }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
  return { resolved: true, resultId: record.resultId, resolvedAt, recovery: released };
  } finally {
    await ownershipHeartbeat.stop();
  }
}

function isRecoveryOwnershipLoss(error) {
  return new Set([
    'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST',
    'RECOVERY_OWNERSHIP_LOST',
    'WORKLOAD_RECOVERY_OWNERSHIP_LOST'
  ]).has(error?.code);
}

async function releaseJournalOwnership(ownership, error) {
  if (!ownership || isRecoveryOwnershipLoss(error)) return;
  const { record, ownerId, ownerEpoch } = ownership;
  try {
    await BenchmarkAuthorityReconciliation.updateOne(
      { _id: record._id, state: { $ne: 'resolved' }, ownerId, ownerEpoch },
      { $set: {
        ownerId: null,
        ownerEpoch: null,
        ownerClaimedAt: null,
        lastAttemptAt: new Date(),
        lastError: error.message
      }, $inc: { attempts: 1 } }
    );
  } catch (updateError) {
    logger.error('Authority recovery ownership release failed', {
      reconciliationId: String(record._id), error: updateError.message
    });
  }
}

async function reconcilePendingResultInvalidations(options = {}) {
  if (running) return { skipped: true, reason: 'authority reconciliation already running' };
  running = true;
  try {
    const profilerKinds = [
      'profiler_evidence_write',
      'profiler_baseline_write',
      'profiler_snapshot_write',
      'profiler_context_write'
    ];
    const rows = await BenchmarkAuthorityReconciliation.find({
      state: { $ne: 'resolved' },
      $or: [
        { kind: { $nin: profilerKinds } },
        {
          kind: { $in: profilerKinds },
          startedAt: { $lte: new Date(Date.now() - OWNER_STALE_MS) }
        }
      ]
    })
      .sort({ startedAt: 1 }).limit(Number(options.limit) || 50).lean();
    const results = [];
    const workerId = String(options.workerId || `benchmark-recovery:${process.pid}`);
    for (const row of rows) {
      let ownership = null;
      try {
        ownership = await claimRecoveryRecord(row, workerId);
        if (!ownership) {
          results.push({ resolved: false, resultId: row.resultId, reason: 'journal owned by another recovery worker' });
          continue;
        }
        results.push(await reconcileOwnedRecord(ownership));
      } catch (error) {
        await releaseJournalOwnership(ownership, error);
        logger.warn('Benchmark authority reconciliation remains quarantined', {
          reconciliationId: String(row._id), resultId: row.resultId, error: error.message
        });
        results.push({ resolved: false, resultId: row.resultId, error: error.message });
      }
    }
    return {
      inspected: rows.length,
      resolved: results.filter(result => result.resolved).length,
      pending: results.filter(result => !result.resolved).length,
      results
    };
  } finally {
    running = false;
  }
}

async function waitForResultInvalidation(reconciliationId, options = {}) {
  const retryMs = Math.max(10, Number(options.retryMs) || 1_000);
  const workerId = String(options.workerId || `benchmark-recovery:${process.pid}:${reconciliationId}`);
  while (true) {
    const row = await BenchmarkAuthorityReconciliation.findById(reconciliationId).lean();
    if (!row) throw new Error(`Authority reconciliation ${reconciliationId} disappeared`);
    if (row.state === 'resolved') return { resolved: true, reconciliationId: String(row._id) };
    let ownership = null;
    try {
      ownership = await claimRecoveryRecord(row, workerId);
      if (ownership) await reconcileOwnedRecord(ownership);
    } catch (error) {
      await releaseJournalOwnership(ownership, error);
    }
    await new Promise(resolve => setTimeout(resolve, retryMs));
  }
}

function startBenchmarkAuthorityReconciliation(options = {}) {
  if (interval) return interval;
  const intervalMs = Math.max(100, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const run = () => reconcilePendingResultInvalidations(options)
    .catch(error => logger.warn('Benchmark authority reconciliation sweep failed', { error: error.message }));
  run();
  interval = setInterval(run, intervalMs);
  interval.unref?.();
  return interval;
}

function stopBenchmarkAuthorityReconciliation() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = {
  prepareWorkloadAuthority,
  verifyWorkloadAuthority,
  resolveWorkloadAuthority,
  enqueueAuthorityInvalidation,
  enqueueResultInvalidation,
  prepareProfilerAuthorityWrite,
  completeProfilerAuthorityWrite,
  reconcilePendingResultInvalidations,
  waitForResultInvalidation,
  startBenchmarkAuthorityReconciliation,
  stopBenchmarkAuthorityReconciliation,
  _claimRecoveryRecord: claimRecoveryRecord,
  _reconcileOwnedRecord: reconcileOwnedRecord,
  _invalidateResource: invalidateResource,
  _publishProfilerResource: publishProfilerResource
};

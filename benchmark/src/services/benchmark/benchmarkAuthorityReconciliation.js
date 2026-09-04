'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const JudgeAccuracyMatrix = require('../../../models/JudgeAccuracyMatrix');
const JudgeGovernanceRun = require('../../../models/JudgeGovernanceRun');
const JudgeGroundTruth = require('../../../models/JudgeGroundTruth');
const {
  getWorkloadRecoveryIdentity,
  adoptWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  restoreWorkloadRecoveryHosts,
  releaseWorkloadAdmission,
  recoverWorkloadAdmissionRelease
} = require('../../clients/coreApiClient');
const logger = require('../../../config/logger');

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
    ground_truth_invalidation: 'JudgeGroundTruth'
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
    ground_truth_invalidation: JudgeGroundTruth
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

async function enqueueAuthorityInvalidation({ kind = 'result_invalidation', resultId, batchId, workloadId, phase, reason }) {
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

async function invalidateResource(record) {
  if (record.kind === 'workload_invalidation') {
    const batchId = record.batchId || null;
    const fields = authorityInvalidationFields(record);
    const [batch, results, matrices, governance, groundTruth] = await Promise.all([
      batchId
        ? BenchmarkBatch.findOneAndUpdate({ _id: objectId(batchId) }, { $set: fields, $inc: { __v: 1 } }, { new: true }).lean()
        : null,
      batchId ? BenchmarkResult.updateMany(
        { $or: [{ batch_id: String(batchId) }, { batchId: String(batchId) }] },
        { $set: authorityInvalidationFields({ ...record, kind: 'result_invalidation' }), $inc: { __v: 1 } }
      ) : null,
      batchId ? JudgeAccuracyMatrix.updateMany(
        { batch_id: String(batchId) },
        { $set: authorityInvalidationFields({ ...record, kind: 'judge_matrix_invalidation' }), $inc: { __v: 1 } }
      ) : null,
      batchId ? JudgeGovernanceRun.updateMany(
        { batch_id: String(batchId) },
        { $set: authorityInvalidationFields({ ...record, kind: 'judge_governance_invalidation' }), $inc: { __v: 1 } }
      ) : null,
      batchId ? JudgeGroundTruth.updateMany(
        { tags: `batch:${String(batchId)}` },
        { $set: authorityInvalidationFields({ ...record, kind: 'ground_truth_invalidation' }), $inc: { __v: 1 } }
      ) : null
    ]);
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
  const Model = resourceModel(record);
  if (!Model) throw new Error(`Unsupported authority reconciliation kind: ${record.kind}`);
  const id = objectId(record.resultId);
  const update = { $set: authorityInvalidationFields(record), $inc: { __v: 1 } };
  const query = Model.findOneAndUpdate({ _id: id }, update, { upsert: true, new: true });
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;
  if (!updated) throw new Error(`Authority invalidation did not return ${record.resourceType} ${record.resultId}`);
  if (record.kind === 'result_invalidation' && record.batchId) {
    await BenchmarkBatch.updateOne(
      { _id: record.batchId },
      { $set: authorityInvalidationFields({ ...record, kind: 'batch_invalidation' }), $inc: { __v: 1 } }
    );
  }
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

async function assertJournalOwner(recordId, ownerId, ownerEpoch, states) {
  const journal = await BenchmarkAuthorityReconciliation.findOne({
    _id: recordId,
    state: { $in: states },
    ownerId,
    ownerEpoch
  }).lean();
  if (!journal) {
    const error = new Error('Authority reconciliation journal ownership was lost');
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
  return journal;
}

async function adoptAndAssert(record, ownerId) {
  await adoptWorkloadRecovery({
    workloadId: record.workloadId,
    recoveryId: record.recoveryId,
    recoveryRequestId: record.recoveryRequestId,
    ownerId
  });
  const core = await assertWorkloadRecovery(record.workloadId);
  if (core?.owned !== true || core.recoveryOwnerId !== ownerId) {
    const error = new Error(core?.reason || 'Core recovery quarantine ownership was lost');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  return core;
}

async function persistJournalState(ownership, fromStates, state, fields = {}) {
  const { record, ownerId, ownerEpoch } = ownership;
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { _id: record._id, state: { $in: fromStates }, ownerId, ownerEpoch },
    { $set: { state, ...fields, lastAttemptAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  if (!updated) throw new Error(`Authority reconciliation ${state} receipt CAS was lost`);
  ownership.record = updated;
  return updated;
}

async function reconcileOwnedRecord(ownership) {
  let { record } = ownership;
  const { ownerId, ownerEpoch } = ownership;

  if (record.state === 'verified' || record.state === 'releasing') {
    const recovered = await recoverWorkloadAdmissionRelease({
      admissionId: record.admissionId,
      generation: record.admissionGeneration,
      principal: record.admissionPrincipal,
      workloadId: record.workloadId,
      recoveryId: record.recoveryId
    });
    if (recovered?.released === true) {
      const resolvedAt = new Date();
      await persistJournalState(ownership, ['verified', 'releasing'], 'resolved', {
        releaseReceipt: recovered,
        resolvedAt,
        lastError: null,
        ownerId: null,
        ownerEpoch: null,
        ownerClaimedAt: null
      });
      return { resolved: true, resultId: record.resultId, resolvedAt, recovered: true };
    }
  }

  await adoptAndAssert(record, ownerId);
  await assertJournalOwner(record._id, ownerId, ownerEpoch, ['pending_reconciliation', 'verified', 'releasing']);

  if (record.state === 'pending_reconciliation') {
    const core = await assertWorkloadRecovery(record.workloadId);
    if (new Set(['PREPARED', 'MUTATING']).has(core.recoveryState)) {
      await transitionWorkloadRecovery(record.workloadId, 'UNKNOWN', {
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'ambiguous-authority-write' }
      });
    }
    const compensationReceipt = await invalidateResource(record);
    await assertWorkloadRecovery(record.workloadId).then(result => {
      if (result?.owned !== true || result.recoveryOwnerId !== ownerId) {
        throw new Error(result?.reason || 'Core recovery ownership was lost after compensation');
      }
    });
    record = await persistJournalState(ownership, ['pending_reconciliation'], 'verified', {
      compensationReceipt,
      lastError: null
    });
  }

  if (record.state === 'verified') {
    const core = await assertWorkloadRecovery(record.workloadId);
    if (core.recoveryState !== 'VERIFIED' && core.recoveryState !== 'RESTORED') {
      await transitionWorkloadRecovery(record.workloadId, 'VERIFIED', {
        receipt: record.compensationReceipt
      });
    }
    const afterVerified = await assertWorkloadRecovery(record.workloadId);
    if (afterVerified.recoveryState !== 'RESTORED') {
      const hostRestore = await restoreWorkloadRecoveryHosts(record.workloadId);
      if (hostRestore?.restored !== true) {
        throw new Error(hostRestore?.reason || 'Core host restoration under recovery quarantine failed');
      }
      await transitionWorkloadRecovery(record.workloadId, 'RESTORED', {
        receipt: {
          contract: 'agentx.workload-recovery/v1',
          event: 'authority-restored',
          compensation: record.compensationReceipt
        }
      });
    }
    record = await persistJournalState(ownership, ['verified'], 'releasing', { lastError: null });
  }

  const remaining = await BenchmarkAuthorityReconciliation.countDocuments({
    workloadId: record.workloadId,
    state: { $in: ['pending_reconciliation', 'verified'] },
    _id: { $ne: record._id }
  });
  if (remaining > 0) {
    return { resolved: false, resultId: record.resultId, reason: 'other authority reconciliations remain pending' };
  }
  await assertJournalOwner(record._id, ownerId, ownerEpoch, ['releasing']);
  const released = await releaseWorkloadAdmission(record.workloadId);
  if (released?.released !== true) throw new Error(released?.reason || 'Recovery quarantine release was not acknowledged');
  const resolvedAt = new Date();
  await persistJournalState(ownership, ['releasing'], 'resolved', {
    releaseReceipt: released,
    resolvedAt,
    lastError: null,
    ownerId: null,
    ownerEpoch: null,
    ownerClaimedAt: null
  });
  return { resolved: true, resultId: record.resultId, resolvedAt, recovery: released };
}

async function releaseJournalOwnership(row, workerId, error) {
  try {
    await BenchmarkAuthorityReconciliation.updateOne(
      { _id: row._id, state: { $ne: 'resolved' }, ownerId: workerId },
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
      reconciliationId: String(row._id), error: updateError.message
    });
  }
}

async function reconcilePendingResultInvalidations(options = {}) {
  if (running) return { skipped: true, reason: 'authority reconciliation already running' };
  running = true;
  try {
    const rows = await BenchmarkAuthorityReconciliation.find({ state: { $ne: 'resolved' } })
      .sort({ startedAt: 1 }).limit(Number(options.limit) || 50).lean();
    const results = [];
    const workerId = String(options.workerId || `benchmark-recovery:${process.pid}`);
    for (const row of rows) {
      try {
        const ownership = await claimRecoveryRecord(row, workerId);
        if (!ownership) {
          results.push({ resolved: false, resultId: row.resultId, reason: 'journal owned by another recovery worker' });
          continue;
        }
        results.push(await reconcileOwnedRecord(ownership));
      } catch (error) {
        await releaseJournalOwnership(row, workerId, error);
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
    try {
      const ownership = await claimRecoveryRecord(row, workerId);
      if (ownership) await reconcileOwnedRecord(ownership);
    } catch (error) {
      await releaseJournalOwnership(row, workerId, error);
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
  reconcilePendingResultInvalidations,
  waitForResultInvalidation,
  startBenchmarkAuthorityReconciliation,
  stopBenchmarkAuthorityReconciliation,
  _claimRecoveryRecord: claimRecoveryRecord,
  _reconcileOwnedRecord: reconcileOwnedRecord,
  _invalidateResource: invalidateResource
};

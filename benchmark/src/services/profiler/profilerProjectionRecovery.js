'use strict';

const crypto = require('crypto');
const HostProfile = require('../../../models/HostProfile');
const hostProfileService = require('./hostProfileService');
const { acquireProfilerClaimLease } = require('./profilerClaimLifecycle');
const { listModels } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const {
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

const DEFAULT_RECOVERY_DELAY_MS = 60_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;
const OWNER_STALE_MS = 60_000;
let interval = null;
let running = false;

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function recoveryIdentity(profile) {
  const value = profile?.reconciliation || {};
  return {
    workloadId: value.workloadId || value.operationId,
    recoveryId: value.recoveryId,
    recoveryRequestId: value.recoveryRequestId
  };
}

async function reconcileLegacyTerminalProfile(profile) {
  if (profile.reconciliation?.serverTerminalObserved !== true) {
    return { hostId: profile.hostId, recovered: false, pending: true, operatorRequired: true };
  }
  const operationId = `profiler-legacy-recovery-${crypto.randomBytes(8).toString('hex')}`;
  const lease = await acquireProfilerClaimLease([profile.hostUrl], operationId, 5 * 60 * 1000);
  try {
    lease.assertActive();
    const inventory = await listModels(profile.hostUrl, { timeoutMs: 30_000, signal: lease.signal });
    lease.assertActive();
    const modelName = profile.reconciliation?.model;
    const available = (inventory.models || []).some(model => isSameOllamaModel(model.name, modelName));
    const isRelease = profile.reconciliation?.operation === 'release_model';
    const authorityProof = lease.authorityProof();
    await lease.finalize({
      ...(isRelease ? { byHost: { [profile.hostUrl]: { excludedModels: [modelName] } } } : {}),
      beforeWorkloadRelease: async result => {
        await hostProfileService.upsertAuthority({
          hostId: profile.hostId,
          ...(isRelease ? { dedicated: null } : {}),
          reconciliation: {
            ...profile.reconciliation,
            admissionId: authorityProof.admissionId,
            admissionGeneration: authorityProof.generation,
            admissionPrincipal: authorityProof.principal,
            state: 'resolved',
            reason: null,
            releaseReceipt: result,
            resolvedAt: new Date(),
            ownerId: null,
            ownerEpoch: null,
            ownerClaimedAt: null
          }
        }, {
          authorityService: 'profiler-recovery',
          authorityProof,
          authorityFilter: {
            'reconciliation.state': profile.reconciliation.state,
            'reconciliation.operationId': profile.reconciliation.operationId,
            'reconciliation.serverTerminalObserved': true
          },
          signal: lease.signal,
          assertAuthorityActive: lease.assertActive
        });
      }
    });
    return { hostId: profile.hostId, recovered: true, pending: false, legacy: true, available };
  } catch (error) {
    await lease.abandon(error);
    throw error;
  }
}

async function claimProfileRecovery(profile, ownerId) {
  const ownerEpoch = crypto.randomUUID();
  const claimed = await HostProfile.findOneAndUpdate(
    {
      _id: profile._id,
      'reconciliation.state': { $in: ['prepared', 'mutating', 'unknown', 'pending_reconciliation', 'verified'] },
      $or: [
        { 'reconciliation.ownerId': null },
        { 'reconciliation.ownerId': { $exists: false } },
        { 'reconciliation.ownerClaimedAt': { $lte: new Date(Date.now() - OWNER_STALE_MS) } }
      ]
    },
    { $set: {
      'reconciliation.ownerId': ownerId,
      'reconciliation.ownerEpoch': ownerEpoch,
      'reconciliation.ownerClaimedAt': new Date()
    } },
    { new: true }
  ).lean();
  return claimed ? { profile: claimed, ownerId, ownerEpoch } : null;
}

async function assertOwnership(ownership, options = {}) {
  const { profile, ownerId, ownerEpoch } = ownership;
  const journal = await HostProfile.findOne({
    _id: profile._id,
    'reconciliation.ownerId': ownerId,
    'reconciliation.ownerEpoch': ownerEpoch,
    'reconciliation.state': { $ne: 'resolved' }
  }, null, options.signal ? { signal: options.signal } : undefined).lean();
  if (!journal) {
    const error = new Error('Profiler recovery journal ownership was lost');
    error.code = 'PROFILER_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  const core = await assertWorkloadRecovery(recoveryIdentity(profile).workloadId, options);
  if (core?.owned !== true || core.recoveryOwnerId !== ownerId) {
    const error = new Error(core?.reason || 'Core profiler recovery quarantine ownership was lost');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  return core;
}

async function refreshProfileOwner(ownership, { signal } = {}) {
  const { profile, ownerId, ownerEpoch } = ownership;
  const result = await HostProfile.updateOne(
    {
      _id: profile._id,
      'reconciliation.ownerId': ownerId,
      'reconciliation.ownerEpoch': ownerEpoch,
      'reconciliation.state': { $ne: 'resolved' }
    },
    { $set: { 'reconciliation.ownerClaimedAt': new Date() } },
    { signal }
  );
  if (Number(result?.matchedCount ?? result?.modifiedCount) !== 1) {
    const error = new Error('Profiler recovery journal ownership was lost');
    error.code = 'PROFILER_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
}

async function reconcileOwnedProfile(ownership) {
  const { profile, ownerId, ownerEpoch } = ownership;
  const reconciliation = profile.reconciliation || {};
  const ownershipHeartbeat = startRecoveryOwnershipHeartbeat({
    refreshOwner: options => refreshProfileOwner(ownership, options)
  });

  try {
  await ownershipHeartbeat.ready;
  if (reconciliation.state === 'verified'
    && reconciliation.admissionId
    && reconciliation.admissionGeneration
    && reconciliation.admissionPrincipal) {
    const recoveredRelease = await recoverWorkloadAdmissionRelease({
      admissionId: reconciliation.admissionId,
      generation: reconciliation.admissionGeneration,
      principal: reconciliation.admissionPrincipal,
      workloadId: reconciliation.workloadId || reconciliation.operationId,
      recoveryId: reconciliation.recoveryId
    }, { signal: ownershipHeartbeat.signal });
    ownershipHeartbeat.assertActive();
    if (recoveredRelease?.released === true) {
      const resolvedAt = new Date();
      const resolved = await HostProfile.findOneAndUpdate(
        {
          _id: profile._id,
          'reconciliation.ownerId': ownerId,
          'reconciliation.ownerEpoch': ownerEpoch,
          'reconciliation.state': 'verified'
        },
        { $set: {
          'reconciliation.state': 'resolved',
          'reconciliation.reason': null,
          'reconciliation.resolvedAt': resolvedAt,
          'reconciliation.releaseReceipt': recoveredRelease,
          'reconciliation.ownerId': null,
          'reconciliation.ownerEpoch': null,
          'reconciliation.ownerClaimedAt': null
        } },
        { new: true, signal: ownershipHeartbeat.signal }
      ).lean();
      if (!resolved) throw new Error('Recovered profiler release receipt projection CAS was lost');
      return { hostId: profile.hostId, recovered: true, pending: false, resolvedAt, releaseRecovered: true };
    }
  }
  if (reconciliation.serverTerminalObserved !== true) {
    return {
      hostId: profile.hostId,
      recovered: false,
      pending: true,
      operatorRequired: true,
      reason: 'Ollama mutation has no terminal server receipt; controlled runtime restart attestation is required'
    };
  }
  const identity = recoveryIdentity(profile);
  if (!identity.workloadId || !identity.recoveryId || !identity.recoveryRequestId) {
    return reconcileLegacyTerminalProfile(profile);
  }
  await adoptWorkloadRecovery({ ...identity, ownerId, signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.setCoreHeartbeat(({ signal }) => heartbeatWorkloadRecovery(
    identity.workloadId,
    undefined,
    { signal }
  ));
  await ownershipHeartbeat.heartbeatOnce();
  await assertOwnership(ownership, { signal: ownershipHeartbeat.signal });

  ownershipHeartbeat.assertActive();
  const inventory = await listModels(profile.hostUrl, {
    timeoutMs: 30_000,
    signal: ownershipHeartbeat.signal
  });
  ownershipHeartbeat.assertActive();
  const inventoryHeartbeat = await heartbeatWorkloadRecovery(
    identity.workloadId,
    undefined,
    { signal: ownershipHeartbeat.signal }
  );
  if (inventoryHeartbeat?.heartbeat !== true) {
    const error = new Error(inventoryHeartbeat?.reason || 'Core recovery owner heartbeat was rejected');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  await assertOwnership(ownership, { signal: ownershipHeartbeat.signal });
  const modelName = reconciliation.model;
  const available = (inventory.models || []).some(model => isSameOllamaModel(model.name, modelName));
  const isRelease = reconciliation.operation === 'release_model';
  const hostRestore = await restoreWorkloadRecoveryHosts(
    identity.workloadId,
    isRelease ? { [profile.hostUrl]: [modelName] } : {},
    { signal: ownershipHeartbeat.signal }
  );
  ownershipHeartbeat.assertActive();
  if (hostRestore?.restored !== true) throw new Error(hostRestore?.reason || 'Core host restore failed');
  const restoreHeartbeat = await heartbeatWorkloadRecovery(
    identity.workloadId,
    undefined,
    { signal: ownershipHeartbeat.signal }
  );
  if (restoreHeartbeat?.heartbeat !== true) {
    const error = new Error(restoreHeartbeat?.reason || 'Core recovery owner heartbeat was rejected');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  await assertOwnership(ownership, { signal: ownershipHeartbeat.signal });

  const core = await assertWorkloadRecovery(identity.workloadId, { signal: ownershipHeartbeat.signal });
  if (!new Set(['VERIFIED', 'RESTORED']).has(core.recoveryState)) {
    await transitionWorkloadRecovery(identity.workloadId, 'VERIFIED', {
      signal: ownershipHeartbeat.signal,
      receipt: {
        contract: 'agentx.profiler-runtime-compensation/v1',
        operation: reconciliation.operation,
        model: modelName,
        serverTerminalObserved: true,
        inventoryAvailable: available,
        hostRestoreVerified: true
      }
    });
  }

  const updated = await HostProfile.findOneAndUpdate(
    {
      _id: profile._id,
      'reconciliation.ownerId': ownerId,
      'reconciliation.ownerEpoch': ownerEpoch,
      'reconciliation.state': { $ne: 'resolved' }
    },
    { $set: {
      ...(isRelease ? { dedicated: null } : {}),
      reconciliation: {
        ...reconciliation,
        state: 'verified',
        ownerId,
        ownerEpoch,
        ownerClaimedAt: new Date(),
        desiredDedicated: isRelease ? null : reconciliation.desiredDedicated,
        reason: null,
        releaseReceipt: hostRestore,
        lastObservedAt: new Date(),
        attempts: (Number(reconciliation.attempts) || 0) + 1
      }
    } },
    { new: true, signal: ownershipHeartbeat.signal }
  ).lean();
  if (!updated) {
    const error = new Error('Profiler recovery projection CAS was lost');
    error.code = 'PROFILER_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  await assertOwnership(
    { ...ownership, profile: updated },
    { signal: ownershipHeartbeat.signal }
  );

  await transitionWorkloadRecovery(identity.workloadId, 'RESTORED', {
    signal: ownershipHeartbeat.signal,
    receipt: {
      contract: 'agentx.workload-recovery/v1',
      event: 'profiler-runtime-restored',
      operation: reconciliation.operation,
      hostRestore
    }
  });
  ownershipHeartbeat.assertActive();
  const released = await releaseWorkloadAdmission(identity.workloadId, {
    signal: ownershipHeartbeat.signal
  });
  ownershipHeartbeat.setCoreHeartbeat(null);
  ownershipHeartbeat.assertActive();
  if (released?.released !== true) throw new Error(released?.reason || 'Profiler recovery quarantine release failed');

  const resolvedAt = new Date();
  const resolved = await HostProfile.findOneAndUpdate(
    {
      _id: profile._id,
      'reconciliation.ownerId': ownerId,
      'reconciliation.ownerEpoch': ownerEpoch,
      'reconciliation.state': 'verified'
    },
    { $set: {
      'reconciliation.state': 'resolved',
      'reconciliation.reason': null,
      'reconciliation.resolvedAt': resolvedAt,
      'reconciliation.releaseReceipt': released,
      'reconciliation.ownerId': null,
      'reconciliation.ownerEpoch': null,
      'reconciliation.ownerClaimedAt': null
    } },
    { new: true, signal: ownershipHeartbeat.signal }
  ).lean();
  if (!resolved) {
    // Core release receipt is durable. Leave the verified journal visible so
    // the next sweep can reconcile its projection without another mutation.
    throw new Error('Profiler recovery terminal journal receipt CAS was lost');
  }
  return {
    hostId: profile.hostId,
    recovered: true,
    pending: false,
    model: modelName,
    available,
    resolvedAt
  };
  } finally {
    await ownershipHeartbeat.stop();
  }
}

function isRecoveryOwnershipLoss(error) {
  return new Set([
    'PROFILER_RECOVERY_OWNERSHIP_LOST',
    'RECOVERY_OWNERSHIP_LOST',
    'WORKLOAD_RECOVERY_OWNERSHIP_LOST'
  ]).has(error?.code);
}

async function releaseProfileOwnership(ownership, error) {
  if (!ownership || isRecoveryOwnershipLoss(error)) return;
  const { profile, ownerId, ownerEpoch } = ownership;
  try {
    await HostProfile.updateOne(
      {
        _id: profile._id,
        'reconciliation.ownerId': ownerId,
        'reconciliation.ownerEpoch': ownerEpoch,
        'reconciliation.state': { $ne: 'resolved' }
      },
      { $set: {
        'reconciliation.ownerId': null,
        'reconciliation.ownerEpoch': null,
        'reconciliation.ownerClaimedAt': null,
        'reconciliation.reason': error.message
      } }
    );
  } catch (updateError) {
    logger.error('Profiler recovery journal ownership release failed', {
      hostId: profile.hostId,
      error: updateError.message
    });
  }
}

async function recoverPendingHostProjections(options = {}) {
  if (running) return { skipped: true, reason: 'recovery already running' };
  running = true;
  try {
    const delayMs = positiveMs(options.delayMs ?? process.env.PROFILER_RECONCILIATION_DELAY_MS, DEFAULT_RECOVERY_DELAY_MS);
    const profiles = await HostProfile.find({
      'reconciliation.state': { $in: ['prepared', 'mutating', 'unknown', 'pending_reconciliation', 'verified'] },
      'reconciliation.startedAt': { $lte: new Date(Date.now() - delayMs) }
    }).limit(25).lean();
    const results = [];
    const workerId = String(options.workerId || `profiler-recovery:${process.pid}`);
    for (const profile of profiles) {
      let ownership = null;
      try {
        ownership = await claimProfileRecovery(profile, workerId);
        if (!ownership) {
          results.push({ hostId: profile.hostId, recovered: false, pending: true, reason: 'owned by another worker' });
          continue;
        }
        const result = await reconcileOwnedProfile(ownership);
        if (result.operatorRequired) await releaseProfileOwnership(ownership, new Error(result.reason));
        results.push(result);
      } catch (error) {
        await releaseProfileOwnership(ownership, error);
        logger.warn('Profiler projection remains in durable Core quarantine', {
          hostId: profile.hostId,
          operationId: profile.reconciliation?.operationId || null,
          error: error.message
        });
        results.push({ hostId: profile.hostId, recovered: false, pending: true, error: error.message });
      }
    }
    return {
      inspected: profiles.length,
      recovered: results.filter(result => result.recovered).length,
      pending: results.filter(result => result.pending).length,
      failed: results.filter(result => !result.recovered && !result.pending).length,
      results
    };
  } finally {
    running = false;
  }
}

function startProfilerProjectionRecovery(options = {}) {
  if (interval) return interval;
  const intervalMs = positiveMs(options.intervalMs ?? process.env.PROFILER_RECONCILIATION_INTERVAL_MS, DEFAULT_RECOVERY_INTERVAL_MS);
  const run = () => recoverPendingHostProjections(options)
    .catch(error => logger.warn('Profiler projection recovery sweep failed', { error: error.message }));
  run();
  interval = setInterval(run, intervalMs);
  interval.unref?.();
  return interval;
}

function stopProfilerProjectionRecovery() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = {
  recoverPendingHostProjections,
  startProfilerProjectionRecovery,
  stopProfilerProjectionRecovery,
  _claimProfileRecovery: claimProfileRecovery,
  _reconcileOwnedProfile: reconcileOwnedProfile,
  _reconcileReleaseProjection: async profile => {
    const ownership = await claimProfileRecovery(profile, `profiler-recovery:${process.pid}:release`);
    return ownership ? reconcileOwnedProfile(ownership) : { recovered: false, pending: true };
  },
  _reconcileBaselinePull: async profile => {
    const ownership = await claimProfileRecovery(profile, `profiler-recovery:${process.pid}:baseline`);
    return ownership ? reconcileOwnedProfile(ownership) : { recovered: false, pending: true };
  }
};

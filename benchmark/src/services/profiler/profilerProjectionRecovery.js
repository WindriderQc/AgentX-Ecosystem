'use strict';

const crypto = require('crypto');
const HostProfile = require('../../../models/HostProfile');
const hostProfileService = require('./hostProfileService');
const { acquireProfilerClaimLease } = require('./profilerClaimLifecycle');
const { listModels } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const {
  adoptWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  restoreWorkloadRecoveryHosts,
  releaseWorkloadAdmission,
  recoverWorkloadAdmissionRelease
} = require('../../clients/coreApiClient');
const logger = require('../../../config/logger');

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
    await lease.finalize({
      ...(isRelease ? { byHost: { [profile.hostUrl]: { excludedModels: [modelName] } } } : {}),
      beforeWorkloadRelease: async result => {
        await hostProfileService.upsert({
          hostId: profile.hostId,
          ...(isRelease ? { dedicated: null } : {}),
          reconciliation: {
            ...profile.reconciliation,
            state: 'resolved',
            reason: null,
            releaseReceipt: result,
            resolvedAt: new Date(),
            ownerId: null,
            ownerEpoch: null,
            ownerClaimedAt: null
          }
        }, { signal: lease.signal, assertAuthorityActive: lease.assertActive });
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

async function assertOwnership(ownership) {
  const { profile, ownerId, ownerEpoch } = ownership;
  const journal = await HostProfile.findOne({
    _id: profile._id,
    'reconciliation.ownerId': ownerId,
    'reconciliation.ownerEpoch': ownerEpoch,
    'reconciliation.state': { $ne: 'resolved' }
  }).lean();
  if (!journal) throw new Error('Profiler recovery journal ownership was lost');
  const core = await assertWorkloadRecovery(recoveryIdentity(profile).workloadId);
  if (core?.owned !== true || core.recoveryOwnerId !== ownerId) {
    throw new Error(core?.reason || 'Core profiler recovery quarantine ownership was lost');
  }
  return core;
}

async function reconcileOwnedProfile(ownership) {
  const { profile, ownerId, ownerEpoch } = ownership;
  const reconciliation = profile.reconciliation || {};
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
    });
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
        { new: true }
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
  await adoptWorkloadRecovery({ ...identity, ownerId });
  await assertOwnership(ownership);

  const inventory = await listModels(profile.hostUrl, { timeoutMs: 30_000 });
  await assertOwnership(ownership);
  const modelName = reconciliation.model;
  const available = (inventory.models || []).some(model => isSameOllamaModel(model.name, modelName));
  const isRelease = reconciliation.operation === 'release_model';
  const hostRestore = await restoreWorkloadRecoveryHosts(identity.workloadId, isRelease
    ? { [profile.hostUrl]: [modelName] }
    : {});
  if (hostRestore?.restored !== true) throw new Error(hostRestore?.reason || 'Core host restore failed');
  await assertOwnership(ownership);

  const core = await assertWorkloadRecovery(identity.workloadId);
  if (!new Set(['VERIFIED', 'RESTORED']).has(core.recoveryState)) {
    await transitionWorkloadRecovery(identity.workloadId, 'VERIFIED', {
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
    { new: true }
  ).lean();
  if (!updated) throw new Error('Profiler recovery projection CAS was lost');
  await assertOwnership({ ...ownership, profile: updated });

  await transitionWorkloadRecovery(identity.workloadId, 'RESTORED', {
    receipt: {
      contract: 'agentx.workload-recovery/v1',
      event: 'profiler-runtime-restored',
      operation: reconciliation.operation,
      hostRestore
    }
  });
  const released = await releaseWorkloadAdmission(identity.workloadId);
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
    { new: true }
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
}

async function releaseProfileOwnership(profile, ownerId, error) {
  try {
    await HostProfile.updateOne(
      { _id: profile._id, 'reconciliation.ownerId': ownerId, 'reconciliation.state': { $ne: 'resolved' } },
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
      try {
        const ownership = await claimProfileRecovery(profile, workerId);
        if (!ownership) {
          results.push({ hostId: profile.hostId, recovered: false, pending: true, reason: 'owned by another worker' });
          continue;
        }
        const result = await reconcileOwnedProfile(ownership);
        if (result.operatorRequired) await releaseProfileOwnership(profile, workerId, new Error(result.reason));
        results.push(result);
      } catch (error) {
        await releaseProfileOwnership(profile, workerId, error);
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

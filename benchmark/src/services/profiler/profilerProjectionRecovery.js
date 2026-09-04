'use strict';

const crypto = require('crypto');
const HostProfile = require('../../../models/HostProfile');
const hostProfileService = require('./hostProfileService');
const { acquireProfilerClaimLease } = require('./profilerClaimLifecycle');
const { listModels, deleteModel } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const logger = require('../../../config/logger');

const DEFAULT_RECOVERY_DELAY_MS = 6 * 60 * 1000;
const DEFAULT_RECOVERY_INTERVAL_MS = 60 * 1000;
let interval = null;
let running = false;

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function reconcileReleaseProjection(profile) {
  const operationId = `profiler-release-recovery-${crypto.randomBytes(8).toString('hex')}`;
  const lease = await acquireProfilerClaimLease([profile.hostUrl], operationId, 5 * 60 * 1000);
  try {
    lease.assertActive();
    const observed = await hostProfileService.checkStatus(profile.hostUrl);
    lease.assertActive();
    if (observed.status !== 'online') {
      const error = new Error(`Host ${profile.hostId} is not observable for release projection recovery`);
      error.code = 'PROFILER_PROJECTION_RECOVERY_HOST_UNAVAILABLE';
      throw error;
    }
    const recoveredDedicated = observed.dedicated || null;
    await lease.finalize({
      beforeWorkloadRelease: async () => {
        await hostProfileService.upsert({
          hostId: profile.hostId,
          status: observed.status,
          dedicated: recoveredDedicated,
          reconciliation: {
            ...profile.reconciliation,
            state: 'resolved',
            desiredDedicated: recoveredDedicated,
            reason: null,
            resolvedAt: new Date()
          }
        }, {
          assertAuthorityActive: lease.assertActive
        });
      }
    });
    return { hostId: profile.hostId, recovered: true, dedicated: recoveredDedicated };
  } catch (error) {
    try {
      await lease.finalize();
    } catch (finalizeError) {
      error.finalizeError = finalizeError;
    }
    throw error;
  }
}

async function reconcileBaselinePull(profile, options = {}) {
  const operationId = `profiler-baseline-recovery-${crypto.randomBytes(8).toString('hex')}`;
  const configuredStableMs = positiveMs(
    options.stableWindowMs ?? process.env.PROFILER_BASELINE_RECOVERY_STABLE_MS,
    30 * 60 * 1000
  );
  const pollIntervalMs = Math.min(
    configuredStableMs,
    positiveMs(options.pollIntervalMs ?? process.env.PROFILER_BASELINE_RECOVERY_POLL_MS, 5_000)
  );
  const lease = await acquireProfilerClaimLease(
    [profile.hostUrl],
    operationId,
    configuredStableMs + (5 * 60 * 1000)
  );
  let finalized = false;
  try {
    const modelName = profile.reconciliation?.model;
    const inventory = async () => {
      lease.assertActive();
      const data = await listModels(profile.hostUrl, { timeoutMs: 8_000, signal: lease.signal });
      lease.assertActive();
      return (data.models || []).some(model => isSameOllamaModel(model.name, modelName));
    };
    const delay = ms => new Promise((resolve, reject) => {
      let settled = false;
      const finish = callback => {
        if (settled) return;
        settled = true;
        lease.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const timer = setTimeout(() => finish(resolve), ms);
      const onAbort = () => {
        clearTimeout(timer);
        finish(() => reject(lease.signal.reason instanceof Error
          ? lease.signal.reason
          : new Error('Profiler baseline recovery lease stopped')));
      };
      if (lease.signal?.aborted) onAbort();
      else lease.signal?.addEventListener('abort', onAbort, { once: true });
    });

    // A quiet observation made before this exact recovery lease is not
    // continuity evidence: maintenance could have run in the gap. Hold one
    // admission/host fence for the complete quiet window and compensate every
    // late artifact that appears before exposing the host again.
    let quietSince = null;
    let lastObservedAt = null;
    let excludedModel = false;
    let attempts = Number(profile.reconciliation?.attempts) || 0;
    while (true) {
      lease.assertActive();
      const observedAt = new Date();
      lastObservedAt = observedAt;
      attempts += 1;
      const artifactObserved = await inventory();
      if (artifactObserved) {
        excludedModel = true;
        quietSince = null;
        await deleteModel(profile.hostUrl, modelName, { timeoutMs: 120_000, signal: lease.signal });
        lease.assertActive();
        if (await inventory()) {
          const error = new Error(`Late baseline artifact ${modelName} remained installed after fenced cleanup`);
          error.code = 'BASELINE_PULL_STILL_MUTATING';
          throw error;
        }
      }
      if (!quietSince) quietSince = new Date();
      const quietForMs = Date.now() - quietSince.getTime();
      if (quietForMs >= configuredStableMs) break;

      await hostProfileService.upsert({
        hostId: profile.hostId,
        reconciliation: {
          ...profile.reconciliation,
          state: 'pending_reconciliation',
          quietSince,
          lastObservedAt,
          attempts,
          reason: 'Durable recovery is holding the workload fence while monitoring for late pull completion',
          resolvedAt: null
        }
      }, {
        signal: lease.signal,
        assertAuthorityActive: lease.assertActive
      });
      await delay(Math.max(1, Math.min(pollIntervalMs, configuredStableMs - quietForMs)));
    }

    await lease.finalize({
      ...(excludedModel ? { byHost: { [profile.hostUrl]: { excludedModels: [modelName] } } } : {}),
      beforeWorkloadRelease: async () => {
        if (await inventory()) {
          const error = new Error(`Late baseline artifact ${modelName} is still present after fenced cleanup`);
          error.code = 'BASELINE_PULL_STILL_MUTATING';
          throw error;
        }
        await hostProfileService.upsert({
          hostId: profile.hostId,
          reconciliation: {
            ...profile.reconciliation,
            state: 'resolved',
            quietSince,
            lastObservedAt,
            attempts,
            reason: null,
            resolvedAt: new Date()
          }
        }, { assertAuthorityActive: lease.assertActive });
      }
    });
    finalized = true;
    return {
      hostId: profile.hostId,
      recovered: true,
      pending: false,
      model: modelName,
      available: false,
      quietSince,
      stableWindowMs: configuredStableMs
    };
  } catch (error) {
    if (!finalized) {
      try {
        // Never expose maintenance while a timed-out Ollama pull may still
        // mutate inventory. Keep renewing the exact admission for bounded
        // recovery; Core TTL/reaper remains the crash-safe fallback.
        await lease.abandon(error);
      } catch (abandonError) {
        error.abandonError = abandonError;
      }
    }
    throw error;
  }
}

async function recoverPendingHostProjections(options = {}) {
  if (running) return { skipped: true, reason: 'recovery already running' };
  running = true;
  try {
    const delayMs = positiveMs(options.delayMs ?? process.env.PROFILER_RECONCILIATION_DELAY_MS, DEFAULT_RECOVERY_DELAY_MS);
    const before = new Date(Date.now() - delayMs);
    const profiles = await HostProfile.find({
      'reconciliation.state': 'pending_reconciliation',
      $or: [
        {
          'reconciliation.operation': 'release_model',
          'reconciliation.startedAt': { $lte: before }
        },
        {
          'reconciliation.operation': 'baseline_pull',
          'reconciliation.timeoutAt': { $lte: new Date() }
        }
      ]
    }).limit(25).lean();
    const results = [];
    for (const profile of profiles) {
      try {
        results.push(profile.reconciliation?.operation === 'baseline_pull'
          ? await reconcileBaselinePull(profile, options)
          : await reconcileReleaseProjection(profile));
      } catch (error) {
        logger.warn('Profiler release projection remains pending reconciliation', {
          hostId: profile.hostId,
          operationId: profile.reconciliation?.operationId || null,
          error: error.message
        });
        results.push({ hostId: profile.hostId, recovered: false, error: error.message });
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
  const intervalMs = positiveMs(
    options.intervalMs ?? process.env.PROFILER_RECONCILIATION_INTERVAL_MS,
    DEFAULT_RECOVERY_INTERVAL_MS
  );
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
  _reconcileReleaseProjection: reconcileReleaseProjection,
  _reconcileBaselinePull: reconcileBaselinePull
};

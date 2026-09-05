'use strict';
/**
 * Benchmark Claim Service
 *
 * Owns the lifecycle of benchmark host claims. Extracted from
 * hostPreferenceService.js in task 0183 — that file was over 1.6× the
 * service-file budget and mixed CRUD/pin/warm/health concerns with the
 * benchmark-claim machinery added by tasks 0175 + 0176.
 *
 * Responsibilities:
 *   - claimBenchmark / releaseBenchmarkClaim / listBenchmarkClaims
 *   - reapStaleBenchmarkClaims + the periodic reaper interval
 *   - hasActiveBenchmarkClaim (the helper the reconciler in
 *     hostPreferenceService.js still uses to short-circuit pin warming)
 *
 * What stays in hostPreferenceService.js:
 *   - the pin reconciler (`checkAndReloadDefaults`)
 *   - the pin auto-restore grace-period state machine (task 0176)
 *   - pin warm / restore / unload primitives
 *
 * Cross-module calls between the two services are intentionally lazy
 * (`require('./hostPreferenceService')` inside the function bodies) to keep
 * the two-way edge from forming a load-time cycle: the reconciler imports
 * `hasActiveBenchmarkClaim` from this module, while release/reap call
 * `restorePinnedModels` / `getPinnedEntries` from hostPreferenceService.
 *
 * Symbol stability: hostPreferenceService.js re-exports every name listed
 * below so that callers that previously did
 * `hostPreferenceService.releaseBenchmarkClaim(...)` continue to work.
 */

const HostPreference = require('../../models/HostPreference');
const crypto = require('crypto');
const logger = require('../../config/logger');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');
const {
  observeClaimReleaseFailure,
  observePinRestoreFailure
} = require('./laneObservabilityService');

let benchmarkClaimReaperInterval = null;
let benchmarkClaimReaperIntervalMs = parseInt(process.env.BENCHMARK_CLAIM_REAP_INTERVAL_MS, 10) || 300_000;
const TERMINAL_BENCHMARK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'stopped']);
const MANUAL_CLAIM_SOURCE = 'manual';
const BENCHMARK_CLAIM_SOURCE = 'benchmark';

/**
 * True when the host preference currently belongs to an active benchmark
 * batch. Pin-warming code paths (reconciler, /reload endpoint, restorePinnedModels)
 * MUST short-circuit on this check — reloading a pinned model on a claimed
 * host evicts the bench's working set mid-run and forces 30–90s reload
 * cycles per prompt (task 0175). The check is defense-in-depth: we look at
 * both `status === 'benchmarking'` and a present `benchmarkClaim.batchId`,
 * so a status drift on either side still trips the guard.
 *
 * The only safe bypass is releaseBenchmarkClaim's fenced restore, which
 * proves the exact batch and generation and keeps the claim active until
 * pinned residency has been verified.
 */
function hasActiveBenchmarkClaim(pref) {
  if (!pref) return false;
  if (pref.status === 'benchmarking') return true;
  if (pref.benchmarkClaim && pref.benchmarkClaim.batchId) return true;
  return false;
}

// ── Reaper scheduler ──────────────────────────────────────────

function startBenchmarkClaimReaper() {
  if (benchmarkClaimReaperInterval) return;
  benchmarkClaimReaperInterval = setInterval(() => {
    reapStaleBenchmarkClaims().catch(err => {
      logger.warn(`[HostPreference] Benchmark claim reaper error: ${err.message}`);
    });
  }, benchmarkClaimReaperIntervalMs);
  logger.info(`[HostPreference] Benchmark claim reaper started (interval: ${benchmarkClaimReaperIntervalMs / 1000}s)`);
}

function stopBenchmarkClaimReaper() {
  if (benchmarkClaimReaperInterval) {
    clearInterval(benchmarkClaimReaperInterval);
    benchmarkClaimReaperInterval = null;
    logger.info('[HostPreference] Benchmark claim reaper stopped');
  }
}

function getBenchmarkClaimReaperIntervalMs() {
  return benchmarkClaimReaperIntervalMs;
}

// ── Claim lifecycle ───────────────────────────────────────────
//
// When a benchmark batch takes over a host, it announces itself here.
// Other consumers (chat, buddy, bounded API clients) read the status and route
// around benchmarking hosts. Claim acquisition is a required startup guard for
// Benchmark work; consumers still enforce the routing exclusion.
//
// Claiming is idempotent per (hostUrl, batchId, claimGeneration): calling
// claimBenchmark twice with the same generation returns the existing claim
// and does NOT overwrite prevStatus. A claim by a *different* owner on a host that
// is already benchmarking is rejected so we don't lose the true prevStatus.

// Hard cap on the estimated-duration stored with a claim. The reaper uses
// 1.5× estimate as its stale threshold — without a cap, an over-eager
// estimate (e.g., 5h for a 15-min batch) would let a crashed batch lock a
// host for 8+ hours. 2h ceiling matches the reaper's no-estimate hard cap.
const CLAIM_DURATION_CAP_MS = 2 * 60 * 60 * 1000;
const CLAIM_FINALIZE_TTL_MS = 30 * 60 * 1000;
const CLAIM_FINALIZE_HEARTBEAT_MS = Math.max(
  1_000,
  Math.min(CLAIM_FINALIZE_TTL_MS / 3, Number(process.env.BENCHMARK_CLAIM_FINALIZE_HEARTBEAT_MS) || 60_000)
);
const CLAIM_SNAPSHOT_WAIT_MS = Math.max(
  5_000,
  (Number(process.env.BENCHMARK_CLAIM_DRAIN_TIMEOUT_MS) || 30_000) + 5_000
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startFinalizeFenceHeartbeat({ preferenceId, hostUrl, batchId, claimGeneration, finalizeToken }) {
  const controller = new AbortController();
  let stopped = false;
  let pending = Promise.resolve();
  const assertActive = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : Object.assign(new Error('Benchmark finalizer fence was lost'), { code: 'BENCHMARK_CLAIM_LOST' });
    }
  };
  const refresh = async () => {
    if (stopped || controller.signal.aborted) return;
    const refreshedAt = new Date();
    const result = await HostPreference.updateOne(
      {
        _id: preferenceId,
        hostUrl,
        status: 'benchmarking',
        'benchmarkClaim.batchId': batchId,
        'benchmarkClaim.claimGeneration': claimGeneration,
        'benchmarkClaim.finalizeToken': finalizeToken
      },
      { $set: {
        'benchmarkClaim.heartbeatAt': refreshedAt,
        'benchmarkClaim.heartbeatTtlMs': CLAIM_FINALIZE_TTL_MS,
        'benchmarkClaim.finalizingAt': refreshedAt
      } }
    );
    const matched = Number(result?.matchedCount ?? result?.modifiedCount);
    if (Number.isFinite(matched) && matched !== 1) {
      const error = new Error('Benchmark finalizer fence heartbeat was rejected');
      error.code = 'BENCHMARK_CLAIM_LOST';
      throw error;
    }
  };
  const tick = () => {
    pending = pending.then(refresh).catch(error => {
      if (!controller.signal.aborted) controller.abort(error);
    });
  };
  const timer = setInterval(tick, CLAIM_FINALIZE_HEARTBEAT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    assertActive,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      assertActive();
    }
  };
}

function isMongoObjectIdLike(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanClaimGeneration(value) {
  const normalized = cleanString(value);
  return normalized && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function sanitizeEstimate(estimatedDurationMs) {
  const n = positiveInteger(estimatedDurationMs);
  return n ? Math.min(n, CLAIM_DURATION_CAP_MS) : null;
}

function inferClaimSource(batchId, source = null) {
  const explicit = cleanString(source);
  if (explicit) return explicit;
  return isMongoObjectIdLike(batchId) ? BENCHMARK_CLAIM_SOURCE : MANUAL_CLAIM_SOURCE;
}

function normalizeClaimOptions(estimatedDurationMs, opts = {}) {
  if (estimatedDurationMs && typeof estimatedDurationMs === 'object' && !Array.isArray(estimatedDurationMs)) {
    opts = estimatedDurationMs;
    estimatedDurationMs = opts.estimatedDurationMs ?? opts.estimated_duration_ms ?? null;
  }

  return {
    estimatedDurationMs: sanitizeEstimate(estimatedDurationMs),
    source: cleanString(opts.source),
    owner: cleanString(opts.owner),
    note: cleanString(opts.note),
    admissionId: cleanString(opts.admissionId),
    admissionGeneration: cleanString(opts.admissionGeneration),
    admissionPrincipal: cleanString(opts.admissionPrincipal),
    claimGeneration: cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation),
    heartbeatTtlMs: positiveInteger(opts.heartbeatTtlMs ?? opts.heartbeat_ttl_ms),
    heartbeatAt: opts.heartbeatAt ? new Date(opts.heartbeatAt) : new Date()
  };
}

function buildBenchmarkClaim(batchId, prevStatus, normalizedOptions) {
  return {
    batchId,
    claimGeneration: normalizedOptions.claimGeneration || crypto.randomUUID(),
    admissionId: normalizedOptions.admissionId,
    admissionGeneration: normalizedOptions.admissionGeneration,
    admissionPrincipal: normalizedOptions.admissionPrincipal,
    prevStatus,
    claimedAt: new Date(),
    estimatedDurationMs: normalizedOptions.estimatedDurationMs,
    source: inferClaimSource(batchId, normalizedOptions.source),
    owner: normalizedOptions.owner,
    note: normalizedOptions.note,
    heartbeatAt: normalizedOptions.heartbeatAt,
    heartbeatTtlMs: normalizedOptions.heartbeatTtlMs,
    finalizeToken: null,
    finalizingAt: null
  };
}

function claimSourceOf(claim) {
  return inferClaimSource(claim?.batchId, claim?.source);
}

function shouldAskBenchmarkService(claim) {
  return claimSourceOf(claim) === BENCHMARK_CLAIM_SOURCE;
}

function claimConflict(existing, batchId) {
  if (!existing) {
    return { claimed: false, reason: 'host preference changed while acquiring claim' };
  }
  if (existing.status === 'restoring') {
    return {
      claimed: false,
      reason: 'host is restoring pinned models after a previous claim',
      pref: existing
    };
  }
  if (existing.benchmarkClaim?.batchId && existing.benchmarkClaim.batchId !== batchId) {
    return {
      claimed: false,
      reason: `host already claimed by batch ${existing.benchmarkClaim.batchId}`,
      pref: existing
    };
  }
  return {
    claimed: false,
    reason: 'host preference changed while acquiring claim',
    pref: existing
  };
}

async function ensureHostClaimUniquenessIndex() {
  // Claim atomicity for a previously unseen host depends on the canonical
  // hostUrl uniqueness boundary. Do not rely on background autoIndex timing:
  // every acquisition waits until Mongo confirms the exact unique index.
  await HostPreference.collection.createIndex(
    { hostUrl: 1 },
    { unique: true, name: 'hostUrl_1' }
  );
}

/**
 * Claim a host for a benchmark batch. Stores previous status so we can
 * restore it on release.
 *
 * @param {string} hostUrl
 * @param {string} batchId
 * @param {number} [estimatedDurationMs]
 * @returns {Promise<{ claimed: boolean, reason?: string, pref?: object }>}
 */
async function claimBenchmark(hostUrl, batchId, estimatedDurationMs = null, opts = {}) {
  if (!hostUrl || !batchId) {
    return { claimed: false, reason: 'hostUrl and batchId required' };
  }

  await ensureHostClaimUniquenessIndex();

  const normalizedOptions = normalizeClaimOptions(estimatedDurationMs, opts);

  let existing = await HostPreference.findOne({ hostUrl }).lean();
  if (!existing) {
    try {
      // Seed only the neutral preference. A host preference created by another
      // writer in this window is left untouched, then acquired through the
      // same status-aware CAS as every known host so prevStatus stays exact.
      await HostPreference.updateOne(
        { hostUrl },
        { $setOnInsert: { hostUrl, hostKey: 'primary', status: 'idle' } },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    existing = await HostPreference.findOne({ hostUrl }).lean();
    if (!existing) return claimConflict(existing, batchId);
  }

  // Same batch reclaiming — idempotent
  if (existing.status === 'benchmarking' && existing.benchmarkClaim?.batchId === batchId) {
    if (!normalizedOptions.claimGeneration
        || normalizedOptions.claimGeneration !== existing.benchmarkClaim.claimGeneration) {
      return {
        claimed: false,
        reason: 'claim generation no longer owns the host',
        pref: existing
      };
    }
    const existingHasAdmission = Boolean(existing.benchmarkClaim.admissionId
      || existing.benchmarkClaim.admissionGeneration
      || existing.benchmarkClaim.admissionPrincipal);
    const requestHasAdmission = Boolean(normalizedOptions.admissionId
      || normalizedOptions.admissionGeneration
      || normalizedOptions.admissionPrincipal);
    if ((existingHasAdmission || requestHasAdmission)
      && (normalizedOptions.admissionId !== existing.benchmarkClaim.admissionId
        || normalizedOptions.admissionGeneration !== existing.benchmarkClaim.admissionGeneration
        || normalizedOptions.admissionPrincipal !== existing.benchmarkClaim.admissionPrincipal)) {
      return {
        claimed: false,
        reason: 'workload admission proof no longer matches the host claim',
        pref: existing
      };
    }
    // A concurrent retry can observe the claim after the CAS but before its
    // exact runtime snapshot has been attached. It must not receive a usable
    // capability early, nor attempt to tear down the in-progress owner.
    if (existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
      const deadline = Date.now() + CLAIM_SNAPSHOT_WAIT_MS;
      do {
        await sleep(50);
        existing = await HostPreference.findOne({ hostUrl }).lean();
        if (existing?.status !== 'benchmarking'
          || existing?.benchmarkClaim?.batchId !== batchId
          || existing?.benchmarkClaim?.claimGeneration !== normalizedOptions.claimGeneration) {
          return claimConflict(existing, batchId);
        }
        if (existing.benchmarkClaim?.preClaimRuntime?.exact === true) break;
      } while (Date.now() < deadline);
      if (existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
        return {
          claimed: false,
          reason: 'exact pre-claim runtime snapshot is still unavailable',
          pref: existing
        };
      }
    }
    const set = {
      'benchmarkClaim.heartbeatAt': normalizedOptions.heartbeatAt
    };
    if (normalizedOptions.estimatedDurationMs != null) {
      set['benchmarkClaim.estimatedDurationMs'] = normalizedOptions.estimatedDurationMs;
    }
    if (normalizedOptions.source) set['benchmarkClaim.source'] = normalizedOptions.source;
    if (normalizedOptions.owner) set['benchmarkClaim.owner'] = normalizedOptions.owner;
    if (normalizedOptions.note) set['benchmarkClaim.note'] = normalizedOptions.note;
    if (normalizedOptions.heartbeatTtlMs != null) {
      set['benchmarkClaim.heartbeatTtlMs'] = normalizedOptions.heartbeatTtlMs;
    }

    const updated = await HostPreference.findOneAndUpdate(
      {
        _id: existing._id,
        hostUrl,
        status: 'benchmarking',
        'benchmarkClaim.batchId': batchId,
        'benchmarkClaim.claimGeneration': normalizedOptions.claimGeneration,
        'benchmarkClaim.finalizeToken': null
      },
      { $set: set },
      { new: true }
    ).lean();
    if (updated) {
      return {
        claimed: true,
        batchId,
        claimGeneration: updated.benchmarkClaim.claimGeneration,
        prevStatus: updated.benchmarkClaim.prevStatus,
        snapshotExact: updated.benchmarkClaim.preClaimRuntime?.exact === true,
        snapshotIdentity: updated.benchmarkClaim.preClaimRuntime?.identityDigest || null,
        pref: updated,
        reason: 'already claimed by this batch'
      };
    }
    return claimConflict(await HostPreference.findOne({ hostUrl }).lean(), batchId);
  }

  // Different batch already owns the claim
  if (existing.status === 'benchmarking' && existing.benchmarkClaim?.batchId && existing.benchmarkClaim.batchId !== batchId) {
    return {
      claimed: false,
      reason: `host already claimed by batch ${existing.benchmarkClaim.batchId}`,
      pref: existing
    };
  }

  // Pin restore is disruptive: it may be actively loading the user's pinned
  // model after a previous benchmark released its claim. Do not let a new
  // benchmark claim race that restore, or the old restore can evict the new
  // batch's warmup model after the new claim has started.
  if (existing.status === 'restoring') {
    return {
      claimed: false,
      reason: 'host is restoring pinned models after a previous claim',
      pref: existing
    };
  }

  if (existing.status === 'benchmarking') {
    return {
      claimed: false,
      reason: 'host is benchmarking without a stable claim owner',
      pref: existing
    };
  }

  const prevStatus = existing.status || 'idle';
  const benchmarkClaim = buildBenchmarkClaim(batchId, prevStatus, normalizedOptions);
  const updated = await HostPreference.findOneAndUpdate(
    {
      _id: existing._id,
      hostUrl,
      status: existing.status,
      'benchmarkClaim.batchId': existing.benchmarkClaim?.batchId ?? null
    },
    {
      $set: {
        status: 'benchmarking',
        benchmarkClaim
      }
    },
    { new: true }
  ).lean();

  if (updated?.benchmarkClaim?.batchId === batchId) {
    const exactClaim = {
      batchId,
      claimGeneration: updated.benchmarkClaim.claimGeneration
    };
    let preClaimRuntime;
    try {
      // The claim CAS above fences chat/watchdog traffic. Snapshot only after
      // that fence exists, and do not return ownership to Benchmark until the
      // snapshot is durably bound to this exact generation.
      const hostPrefService = require('./hostPreferenceService');
      preClaimRuntime = await hostPrefService.captureBenchmarkRuntime(hostUrl);
    } catch (error) {
      await HostPreference.findOneAndUpdate(
        {
          _id: updated._id,
          hostUrl,
          status: 'benchmarking',
          'benchmarkClaim.batchId': batchId,
          'benchmarkClaim.claimGeneration': exactClaim.claimGeneration
        },
        { $set: { status: prevStatus, benchmarkClaim: null } },
        { new: true }
      ).lean();
      return {
        claimed: false,
        reason: `exact pre-claim runtime snapshot failed: ${error.message}`,
        pref: await HostPreference.findOne({ hostUrl }).lean()
      };
    }
    const snapshotted = await HostPreference.findOneAndUpdate(
      {
        _id: updated._id,
        hostUrl,
        status: 'benchmarking',
        'benchmarkClaim.batchId': batchId,
        'benchmarkClaim.claimGeneration': exactClaim.claimGeneration
      },
      { $set: { 'benchmarkClaim.preClaimRuntime': preClaimRuntime } },
      { new: true }
    ).lean();
    if (!snapshotted) {
      // A claim without its exact snapshot is unusable. Clear it only when
      // this exact generation still owns the fence; otherwise leave the new
      // owner untouched and report the conflict.
      await HostPreference.findOneAndUpdate(
        {
          _id: updated._id,
          hostUrl,
          status: 'benchmarking',
          'benchmarkClaim.batchId': batchId,
          'benchmarkClaim.claimGeneration': exactClaim.claimGeneration,
          'benchmarkClaim.preClaimRuntime.exact': { $ne: true }
        },
        { $set: { status: prevStatus, benchmarkClaim: null } },
        { new: true }
      ).lean();
      return claimConflict(await HostPreference.findOne({ hostUrl }).lean(), batchId);
    }
    return {
      claimed: true,
      batchId,
      claimGeneration: snapshotted.benchmarkClaim.claimGeneration,
      prevStatus: snapshotted.benchmarkClaim.prevStatus,
      snapshotExact: snapshotted.benchmarkClaim.preClaimRuntime?.exact === true,
      snapshotIdentity: snapshotted.benchmarkClaim.preClaimRuntime?.identityDigest || null,
      pref: snapshotted
    };
  }
  return claimConflict(await HostPreference.findOne({ hostUrl }).lean(), batchId);
}

/**
 * Release a benchmark claim, restoring prevStatus.
 *
 * @param {string} hostUrl
 * @param {string} batchId - only releases if current claim matches this batch
 * @returns {Promise<{ released: boolean, reason?: string, pref?: object }>}
 */
async function releaseBenchmarkClaim(hostUrl, batchId, opts = {}) {
  // opts.skipPinRestore — internal recovery/testing escape hatch. Normal
  // callers and the reaper restore under the exact claim before releasing.
  const { skipPinRestore = false, allowLegacyMissingGeneration = false } = opts;
  const rawClaimGeneration = opts.claimGeneration ?? opts.claim_generation;
  const claimGeneration = cleanClaimGeneration(rawClaimGeneration);
  const legacyMissingGeneration = allowLegacyMissingGeneration === true
    && (rawClaimGeneration === null || rawClaimGeneration === undefined);
  const expectedLegacyClaimedAt = legacyMissingGeneration && opts.expectedClaimedAt
    ? new Date(opts.expectedClaimedAt)
    : null;
  const expectedHeartbeatAt = opts.expectedHeartbeatAt === null
    ? null
    : opts.expectedHeartbeatAt
      ? new Date(opts.expectedHeartbeatAt)
      : undefined;
  const excludedModels = [...new Set((Array.isArray(opts.excludedModels) ? opts.excludedModels : [])
    .map(cleanString)
    .filter(Boolean))];
  if (!hostUrl || !batchId) {
    return { released: false, reason: 'hostUrl and batchId required' };
  }
  if (!claimGeneration && !legacyMissingGeneration) {
    return { released: false, reason: 'claimGeneration is required' };
  }
  if (legacyMissingGeneration
    && (!expectedLegacyClaimedAt || !Number.isFinite(expectedLegacyClaimedAt.getTime()))) {
    return { released: false, reason: 'legacy claim expectedClaimedAt is required' };
  }
  if (expectedHeartbeatAt instanceof Date && !Number.isFinite(expectedHeartbeatAt.getTime())) {
    return { released: false, reason: 'expectedHeartbeatAt is invalid' };
  }

  let existing = await HostPreference.findOne({ hostUrl }).lean();
  if (!existing) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'host preference not found',
      source: 'benchmark-claim-release'
    });
    return { released: false, reason: 'host preference not found' };
  }

  // Only release if the claim still belongs to this batch — prevents a
  // late-returning batch from clobbering a newer claim.
  if (!existing.benchmarkClaim?.batchId) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'host is not claimed',
      source: 'benchmark-claim-release'
    });
    return { released: false, reason: 'host is not claimed', pref: existing };
  }
  if (existing.benchmarkClaim.batchId !== batchId) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'claim belongs to another owner',
      source: 'benchmark-claim-release'
    });
    return {
      released: false,
      reason: `claim belongs to batch ${existing.benchmarkClaim.batchId}, not ${batchId}`,
      pref: existing
    };
  }
  const storedClaimGeneration = existing.benchmarkClaim.claimGeneration ?? null;
  if ((legacyMissingGeneration && storedClaimGeneration !== null)
    || (!legacyMissingGeneration && storedClaimGeneration !== claimGeneration)) {
    return {
      released: false,
      reason: 'claim generation no longer owns the host',
      pref: existing
    };
  }
  if (legacyMissingGeneration
    && new Date(existing.benchmarkClaim.claimedAt).getTime() !== expectedLegacyClaimedAt.getTime()) {
    return {
      released: false,
      reason: 'legacy claim changed since reaper scan',
      pref: existing
    };
  }
  if (opts.requireAdmissionProof === true
    && (cleanString(opts.admissionId) !== existing.benchmarkClaim.admissionId
      || cleanString(opts.admissionGeneration) !== existing.benchmarkClaim.admissionGeneration
      || cleanString(opts.admissionPrincipal) !== existing.benchmarkClaim.admissionPrincipal)) {
    return {
      released: false,
      reason: 'workload admission proof no longer matches the host claim',
      pref: existing
    };
  }
  if (expectedHeartbeatAt !== undefined) {
    const currentHeartbeat = existing.benchmarkClaim.heartbeatAt
      ? new Date(existing.benchmarkClaim.heartbeatAt).getTime()
      : null;
    const expectedHeartbeat = expectedHeartbeatAt
      ? expectedHeartbeatAt.getTime()
      : null;
    if (currentHeartbeat !== expectedHeartbeat) {
      return {
        released: false,
        reason: 'claim heartbeat changed since reaper scan',
        pref: existing
      };
    }
  }

  if (!skipPinRestore && !legacyMissingGeneration
    && existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
    const deadline = Date.now() + CLAIM_SNAPSHOT_WAIT_MS;
    do {
      await sleep(50);
      const current = await HostPreference.findOne({ hostUrl }).lean();
      const sameClaim = current?.status === 'benchmarking'
        && current?.benchmarkClaim?.batchId === batchId
        && (legacyMissingGeneration
          ? (current?.benchmarkClaim?.claimGeneration ?? null) === null
            && new Date(current?.benchmarkClaim?.claimedAt).getTime() === expectedLegacyClaimedAt.getTime()
          : current?.benchmarkClaim?.claimGeneration === claimGeneration);
      if (!sameClaim) {
        return {
          released: false,
          reason: 'claim changed while awaiting exact pre-claim snapshot',
          pref: current || undefined
        };
      }
      existing = current;
      if (existing.benchmarkClaim?.preClaimRuntime?.exact === true) break;
    } while (Date.now() < deadline);
    if (existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
      return {
        released: false,
        reason: 'exact pre-claim runtime snapshot remained unavailable',
        pref: existing
      };
    }
  }

  // Fenced finalization: restore and verify the exact observable pre-claim
  // Ollama runtime while this
  // exact batch+generation still owns the host. Renew the heartbeat from
  // inside Core so the reaper cannot clear the claim during a cold reload.
  // If restoration fails, keep the claim in place and fail closed; exposing
  // the host before its pins are verified would race chat/watchdog traffic.
  let pinRestore = null;
  let restoredSnapshot = null;
  let expiredModels = [];
  let filterEvaluatedAt = null;
  const hostPrefService = require('./hostPreferenceService');
  const finalizeToken = crypto.randomUUID();
  const finalizingFilter = {
    _id: existing._id,
    hostUrl,
    status: 'benchmarking',
    'benchmarkClaim.batchId': batchId,
    'benchmarkClaim.claimGeneration': legacyMissingGeneration ? null : claimGeneration,
    'benchmarkClaim.finalizeToken': null
  };
  if (legacyMissingGeneration) finalizingFilter['benchmarkClaim.claimedAt'] = expectedLegacyClaimedAt;
  if (expectedHeartbeatAt !== undefined) finalizingFilter['benchmarkClaim.heartbeatAt'] = expectedHeartbeatAt;
  const renewed = await HostPreference.findOneAndUpdate(
    finalizingFilter,
    { $set: {
      'benchmarkClaim.heartbeatAt': new Date(),
      'benchmarkClaim.heartbeatTtlMs': CLAIM_FINALIZE_TTL_MS,
      'benchmarkClaim.finalizeToken': finalizeToken,
      'benchmarkClaim.finalizingAt': new Date()
    } },
    { new: true }
  ).lean();
  if (!renewed) {
    const current = await HostPreference.findOne({ hostUrl }).lean();
    const currentOwnerChanged = current?.benchmarkClaim?.batchId
      && current.benchmarkClaim.batchId !== batchId;
    return {
      released: false,
      reason: currentOwnerChanged
        ? `claim belongs to batch ${current.benchmarkClaim.batchId}, not ${batchId}`
        : expectedHeartbeatAt !== undefined
        && (current?.benchmarkClaim?.heartbeatAt
          ? new Date(current.benchmarkClaim.heartbeatAt).getTime()
          : null) !== (expectedHeartbeatAt ? expectedHeartbeatAt.getTime() : null)
        ? 'claim heartbeat changed since reaper scan'
        : 'claim changed or another finalizer owns runtime restoration',
      pref: current || undefined
    };
  }
  const finalizerHeartbeat = startFinalizeFenceHeartbeat({
    preferenceId: renewed._id,
    hostUrl,
    batchId,
    claimGeneration: legacyMissingGeneration ? null : claimGeneration,
    finalizeToken
  });

  if (!skipPinRestore) {
    const originalSnapshot = renewed.benchmarkClaim?.preClaimRuntime;
    const afterExplicitExclusions = (originalSnapshot?.residents || []).filter(entry =>
      !excludedModels.some(model => hostPrefService.pinNamesMatch(model, entry.model)));
    // Freeze the TTL decision once and attest that instant in the durable
    // receipt. Consumers can then independently recompute which residents
    // were naturally expired instead of trusting Core's projected arrays.
    filterEvaluatedAt = new Date();
    const applicableResidents = hostPrefService.desiredBenchmarkResidents({
      ...originalSnapshot,
      residents: afterExplicitExclusions
    }, filterEvaluatedAt.getTime());
    expiredModels = afterExplicitExclusions
      .filter(entry => !applicableResidents.includes(entry))
      .map(entry => entry.model);
    let restoreSnapshot = {
      ...originalSnapshot,
      residents: applicableResidents
    };
    if (excludedModels.length > 0 || expiredModels.length > 0) {
      restoreSnapshot = {
        ...restoreSnapshot,
        identityDigest: hostPrefService.benchmarkRuntimeSnapshotIdentity(restoreSnapshot)
      };
    }
    restoredSnapshot = restoreSnapshot;
    try {
      pinRestore = await hostPrefService.restoreBenchmarkRuntime(
        hostUrl,
        restoreSnapshot,
        {
          batchId,
          claimGeneration: legacyMissingGeneration ? null : claimGeneration,
          finalizeToken,
          snapshotAlreadyFiltered: true,
          signal: finalizerHeartbeat.signal,
          assertAuthorityActive: finalizerHeartbeat.assertActive
        }
      );
      finalizerHeartbeat.assertActive();
    } catch (err) {
      pinRestore = {
        host: hostUrl,
        status: 'error',
        verified: false,
        degraded: err.code === 'BENCHMARK_RUNTIME_SNAPSHOT_MISSING',
        error: err.message
      };
    }
    if (pinRestore?.status !== 'ready'
      || pinRestore?.verified !== true
      || pinRestore?.degraded !== false
      || pinRestore?.mode !== 'exact_runtime_snapshot'
      || pinRestore?.snapshotIdentity !== restoreSnapshot.identityDigest) {
      const error = pinRestore?.error || 'Pre-claim runtime restore did not verify';
      void observePinRestoreFailure({
        host: hostUrl,
        models: (renewed.benchmarkClaim?.preClaimRuntime?.residents || []).map(entry => entry.model),
        batchId,
        error,
        source: 'benchmark-claim-fenced-release'
      });
      await finalizerHeartbeat.stop().catch(() => {});
      return {
        released: false,
        reason: `fenced runtime restore failed: ${error}`,
        finalizationQuarantined: true,
        pinRestore,
        runtimeRestore: pinRestore,
        pref: await HostPreference.findOne({ hostUrl }).lean()
      };
    }
  }

  await finalizerHeartbeat.stop();

  const restoreStatus = renewed.benchmarkClaim?.prevStatus || 'idle';
  const releaseFilter = {
    _id: existing._id,
    hostUrl,
    status: 'benchmarking',
    'benchmarkClaim.batchId': batchId,
    'benchmarkClaim.claimGeneration': legacyMissingGeneration ? null : claimGeneration,
    'benchmarkClaim.finalizeToken': finalizeToken
  };
  // The reaper is the only caller allowed to drain a pre-generation claim.
  // Bind its exact timestamp as well as batch and null/missing generation so a
  // stale read can never clear a replacement UUID-backed claim.
  if (legacyMissingGeneration) {
    releaseFilter['benchmarkClaim.claimedAt'] = expectedLegacyClaimedAt;
  }

  const releaseReceipt = {
    contract: 'agentx.benchmark-claim-release/v1',
    hostUrl,
    batchId,
    claimGeneration: legacyMissingGeneration ? null : claimGeneration,
    snapshot: {
      identityDigest: renewed.benchmarkClaim?.preClaimRuntime?.identityDigest || null,
      appliedIdentityDigest: restoredSnapshot?.identityDigest || null,
      exact: renewed.benchmarkClaim?.preClaimRuntime?.exact === true,
      capturedAt: renewed.benchmarkClaim?.preClaimRuntime?.capturedAt || null,
      source: renewed.benchmarkClaim?.preClaimRuntime?.source || null,
      filterEvaluatedAt,
      residentCount: restoredSnapshot?.residents?.length || 0,
      residents: (restoredSnapshot?.residents || []).map(entry => ({
        model: entry.model,
        digest: entry.digest,
        artifactSize: Number(entry.artifactSize),
        sizeVram: Number(entry.sizeVram),
        contextLength: Number(entry.contextLength),
        keepAlive: Number(entry.keepAlive),
        expiresAt: entry.expiresAt || null
      })),
      excludedModels,
      expiredModels
    },
    verification: {
      status: pinRestore?.status || (skipPinRestore ? 'skipped' : 'unknown'),
      ready: pinRestore?.status === 'ready',
      verified: pinRestore?.verified === true,
      degraded: pinRestore?.degraded !== false,
      mode: pinRestore?.mode || null,
      snapshotIdentity: pinRestore?.snapshotIdentity || null
    },
    state: {
      restoredStatus: restoreStatus,
      claimCleared: true,
      finalizerCleared: true
    },
    releasedAt: new Date()
  };

  let updated;
  try {
    updated = await HostPreference.findOneAndUpdate(
      releaseFilter,
      {
        $set: {
          status: restoreStatus,
          lastBenchmarkReleaseReceipt: releaseReceipt,
          benchmarkClaim: {
            batchId: null,
            claimGeneration: null,
            admissionId: null,
            admissionGeneration: null,
            admissionPrincipal: null,
            prevStatus: null,
            claimedAt: null,
            estimatedDurationMs: null,
            source: null,
            owner: null,
            note: null,
            heartbeatAt: null,
            heartbeatTtlMs: null,
            finalizeToken: null,
            finalizingAt: null,
            preClaimRuntime: null
          }
        }
      },
      { new: true }
    ).lean();
  } catch (err) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: err.message,
      source: 'benchmark-claim-release'
    });
    throw err;
  }
  if (!updated) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'claim release update did not match',
      source: 'benchmark-claim-release'
    });
    const current = await HostPreference.findOne({ hostUrl }).lean();
    return {
      released: false,
      reason: current?.benchmarkClaim?.batchId
        ? `claim belongs to batch ${current.benchmarkClaim.batchId}, not ${batchId}`
        : 'claim release update did not match',
      pref: current || undefined
    };
  }

  const claimCleared = !updated.benchmarkClaim?.batchId
    && !updated.benchmarkClaim?.claimGeneration
    && !updated.benchmarkClaim?.preClaimRuntime;
  const finalizerCleared = !updated.benchmarkClaim?.finalizeToken
    && !updated.benchmarkClaim?.finalizingAt;
  const verifiedRestore = pinRestore
    ? pinRestore.status === 'ready'
      && pinRestore.verified === true
      && pinRestore.degraded === false
      && pinRestore.mode === 'exact_runtime_snapshot'
    : false;
  if ((!skipPinRestore && !verifiedRestore) || !claimCleared || !finalizerCleared) {
    return {
      released: false,
      reason: 'final benchmark release receipt did not verify restored runtime and cleared fences',
      pref: updated,
      pinRestore,
      runtimeRestore: pinRestore,
      releaseReceipt
    };
  }

  return {
    released: true,
    pref: updated,
    pinRestore,
    runtimeRestore: pinRestore,
    releaseReceipt,
    legacyClaimRecovered: legacyMissingGeneration
  };
}

/**
 * Refresh an active benchmark/manual claim heartbeat.
 *
 * Operators and ad-hoc scout scripts should call this periodically. If it
 * returns heartbeat=false, the caller no longer owns the host and should stop
 * sending model traffic to avoid bypassing AgentX's scheduler signal.
 */
async function heartbeatBenchmarkClaim(hostUrl, batchId, opts = {}) {
  if (!hostUrl || !batchId) {
    return { heartbeat: false, reason: 'hostUrl and batchId required' };
  }
  const claimGeneration = cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation);
  if (!claimGeneration) {
    return { heartbeat: false, reason: 'claimGeneration is required' };
  }

  const existing = await HostPreference.findOne({ hostUrl }).lean();
  if (!existing) {
    return { heartbeat: false, reason: 'host preference not found' };
  }
  if (!existing.benchmarkClaim?.batchId) {
    return { heartbeat: false, reason: 'host is not claimed', pref: existing };
  }
  if (existing.benchmarkClaim.batchId !== batchId) {
    return {
      heartbeat: false,
      reason: `claim belongs to batch ${existing.benchmarkClaim.batchId}, not ${batchId}`,
      pref: existing
    };
  }
  if (existing.benchmarkClaim.claimGeneration !== claimGeneration) {
    return {
      heartbeat: false,
      reason: 'claim generation no longer owns the host',
      pref: existing
    };
  }
  if (opts.requireAdmissionProof === true
    && (cleanString(opts.admissionId) !== existing.benchmarkClaim.admissionId
      || cleanString(opts.admissionGeneration) !== existing.benchmarkClaim.admissionGeneration
      || cleanString(opts.admissionPrincipal) !== existing.benchmarkClaim.admissionPrincipal)) {
    return {
      heartbeat: false,
      reason: 'workload admission proof no longer matches the host claim',
      pref: existing
    };
  }

  const normalizedOptions = normalizeClaimOptions(opts);
  const set = {
    'benchmarkClaim.heartbeatAt': normalizedOptions.heartbeatAt
  };
  if (normalizedOptions.estimatedDurationMs != null) {
    set['benchmarkClaim.estimatedDurationMs'] = normalizedOptions.estimatedDurationMs;
  }
  if (normalizedOptions.source) set['benchmarkClaim.source'] = normalizedOptions.source;
  if (normalizedOptions.owner) set['benchmarkClaim.owner'] = normalizedOptions.owner;
  if (normalizedOptions.note) set['benchmarkClaim.note'] = normalizedOptions.note;
  if (normalizedOptions.heartbeatTtlMs != null) {
    set['benchmarkClaim.heartbeatTtlMs'] = normalizedOptions.heartbeatTtlMs;
  }

  const updated = await HostPreference.findOneAndUpdate(
    {
      _id: existing._id,
      hostUrl,
      status: 'benchmarking',
      'benchmarkClaim.batchId': batchId,
      'benchmarkClaim.claimGeneration': claimGeneration,
      ...(opts.requireAdmissionProof === true ? {
        'benchmarkClaim.admissionId': cleanString(opts.admissionId),
        'benchmarkClaim.admissionGeneration': cleanString(opts.admissionGeneration),
        'benchmarkClaim.admissionPrincipal': cleanString(opts.admissionPrincipal)
      } : {}),
      'benchmarkClaim.finalizeToken': null
    },
    { $set: set },
    { new: true }
  ).lean();

  if (!updated) {
    const current = await HostPreference.findOne({ hostUrl }).lean();
    return {
      heartbeat: false,
      reason: current?.benchmarkClaim?.batchId
        ? `claim belongs to batch ${current.benchmarkClaim.batchId}, not ${batchId}`
        : 'claim heartbeat update did not match',
      pref: current || undefined
    };
  }
  return {
    heartbeat: true,
    batchId,
    claimGeneration: updated.benchmarkClaim.claimGeneration,
    prevStatus: updated.benchmarkClaim.prevStatus,
    snapshotExact: updated.benchmarkClaim.preClaimRuntime?.exact === true,
    snapshotIdentity: updated.benchmarkClaim.preClaimRuntime?.identityDigest || null,
    pref: updated
  };
}

/**
 * Reap benchmark claims that outlived their estimated duration (×grace factor)
 * or that have no estimatedDurationMs and exceeded the hard cap. Used as a
 * safety net for batches that crash between claim and release — without this,
 * HostPreference.status could stay 'benchmarking' indefinitely.
 *
 * @param {object} [opts]
 * @param {number} [opts.graceFactor=1.5]       - Multiplier on estimatedDurationMs before a claim is considered stale.
 * @param {number} [opts.hardCapMs=7200000]     - Upper bound on claim age when estimatedDurationMs is missing (2h).
 * @returns {Promise<{ reaped: Array, now: string }>}
 */
async function reapStaleBenchmarkClaims(opts = {}) {
  const rawGraceFactor = opts.graceFactor == null ? 1.5 : Number(opts.graceFactor);
  const rawHardCapMs = opts.hardCapMs == null ? (2 * 60 * 60 * 1000) : Number(opts.hardCapMs);
  if (!Number.isFinite(rawGraceFactor) || rawGraceFactor <= 0 || rawGraceFactor > 10
    || !Number.isFinite(rawHardCapMs) || rawHardCapMs < 1_000 || rawHardCapMs > 24 * 60 * 60 * 1000) {
    const error = new Error('graceFactor must be > 0 and <= 10; hardCapMs must be between 1000 and 86400000');
    error.code = 'BENCHMARK_REAPER_OPTIONS_INVALID';
    throw error;
  }
  const graceFactor = rawGraceFactor;
  const hardCapMs = Math.round(rawHardCapMs);
  const now = Date.now();

  const claims = await HostPreference.find({ status: 'benchmarking' }).lean();
  const reaped = [];

  for (const pref of claims) {
    const claim = pref.benchmarkClaim || {};
    if (claim.admissionId && claim.admissionGeneration && claim.admissionPrincipal) {
      const runtimeCoordinationService = require('./runtimeCoordinationService');
      const quarantined = await runtimeCoordinationService.isWorkloadRecoveryRequired({
        id: claim.admissionId,
        generation: claim.admissionGeneration,
        principal: claim.admissionPrincipal
      });
      // A recovery quarantine is durable precisely because ordinary TTL and
      // claim reapers cannot expose the host after the originating process
      // dies. Only the fenced recovery owner may resolve it.
      if (quarantined) continue;
    }
    const claimedAt = claim.claimedAt ? new Date(claim.claimedAt).getTime() : 0;
    if (!claimedAt) continue; // unexpectedly missing timestamp — leave alone
    const est = Number(claim.estimatedDurationMs) || 0;
    const maxAgeMs = est > 0 ? Math.round(est * graceFactor) : hardCapMs;
    const ageMs = now - claimedAt;
    const heartbeatAt = claim.heartbeatAt ? new Date(claim.heartbeatAt).getTime() : claimedAt;
    const heartbeatTtlMs = Number(claim.heartbeatTtlMs) || 0;
    const source = claimSourceOf(claim);
    let staleReason = null;

    if (heartbeatTtlMs > 0 && heartbeatAt > 0 && now - heartbeatAt > heartbeatTtlMs) {
      staleReason = 'claim heartbeat expired';
    }

    if (!staleReason && claim.batchId && shouldAskBenchmarkService(claim)) {
      try {
        const batch = await getBenchmarkServiceClient().getBatch(claim.batchId);
        const batchStatus = String(batch?.status || '').toLowerCase();
        const judgeStatus = String(batch?.judge_status || '').toLowerCase();
        if (TERMINAL_BENCHMARK_STATUSES.has(batchStatus) && (!judgeStatus || TERMINAL_BENCHMARK_STATUSES.has(judgeStatus))) {
          staleReason = `benchmark batch ${batchStatus}${judgeStatus ? ` / judge ${judgeStatus}` : ''}`;
        }
      } catch (err) {
        logger.warn('[hostPreferenceService] benchmark batch status check failed', {
          hostUrl: pref.hostUrl,
          batchId: claim.batchId,
          source,
          error: err.message
        });
      }
    }

    const idleAgeMs = now - Math.max(claimedAt, heartbeatAt || 0);
    if (!staleReason && idleAgeMs > maxAgeMs) {
      staleReason = 'claim age exceeded max age';
    }
    if (!staleReason) continue;

    const result = await releaseBenchmarkClaim(pref.hostUrl, claim.batchId, {
      claimGeneration: claim.claimGeneration,
      allowLegacyMissingGeneration: true,
      expectedClaimedAt: claim.claimedAt,
      expectedHeartbeatAt: claim.heartbeatAt || null
    });
    const pinRestored = result.pinRestore?.verified === true;
    reaped.push({
      hostUrl: pref.hostUrl,
      batchId: claim.batchId,
      source,
      claimedAt: claim.claimedAt,
      heartbeatAt: claim.heartbeatAt || null,
      ageMs,
      maxAgeMs,
      released: result.released,
      reason: result.reason || null,
      staleReason,
      pinRestored
    });
  }

  const { released: releasedReaps, refused: failedReaps } = summarizeBenchmarkClaimReaps(reaped);
  if (releasedReaps.length > 0) {
    logger.warn('[hostPreferenceService] released stale benchmark claims', {
      count: releasedReaps.length,
      details: releasedReaps.map(result => ({
        hostUrl: result.hostUrl,
        batchId: result.batchId,
        ageMinutes: Math.round(result.ageMs / 60000)
      }))
    });
  }
  if (failedReaps.length > 0) {
    logger.warn('[hostPreferenceService] stale benchmark claims remain active', {
      count: failedReaps.length,
      details: failedReaps.map(result => ({
        hostUrl: result.hostUrl,
        batchId: result.batchId,
        reason: result.reason
      }))
    });
  }

  return { reaped, now: new Date(now).toISOString() };
}

function summarizeBenchmarkClaimReaps(reaped = []) {
  const results = Array.isArray(reaped) ? reaped : [];
  return {
    released: results.filter(result => result?.released === true),
    refused: results.filter(result => result?.released !== true)
  };
}

/**
 * List all hosts currently claimed by benchmark batches.
 * @returns {Promise<Array>}
 */
async function listBenchmarkClaims() {
  const prefs = await HostPreference.find({ status: 'benchmarking' }).lean();
  return prefs.map(p => ({
    hostUrl: p.hostUrl,
    hostKey: p.hostKey,
    displayName: p.displayName,
    batchId: p.benchmarkClaim?.batchId,
    claimGeneration: p.benchmarkClaim?.claimGeneration || null,
    prevStatus: p.benchmarkClaim?.prevStatus,
    claimedAt: p.benchmarkClaim?.claimedAt,
    estimatedDurationMs: p.benchmarkClaim?.estimatedDurationMs,
    source: claimSourceOf(p.benchmarkClaim),
    owner: p.benchmarkClaim?.owner || null,
    note: p.benchmarkClaim?.note || null,
    heartbeatAt: p.benchmarkClaim?.heartbeatAt || null,
    heartbeatTtlMs: p.benchmarkClaim?.heartbeatTtlMs || null,
    snapshotExact: p.benchmarkClaim?.preClaimRuntime?.exact === true,
    snapshotResidentCount: Array.isArray(p.benchmarkClaim?.preClaimRuntime?.residents)
      ? p.benchmarkClaim.preClaimRuntime.residents.length
      : null,
    finalizing: Boolean(p.benchmarkClaim?.finalizeToken)
  }));
}

async function restoreClaimsForWorkloadRecovery({
  recoveryId,
  recoveryGeneration,
  principal,
  ownerId,
  excludedModelsByHost = {}
} = {}) {
  const runtimeCoordinationService = require('./runtimeCoordinationService');
  const ownership = await runtimeCoordinationService.assertWorkloadRecovery({
    recoveryId,
    recoveryGeneration,
    principal,
    ownerId
  });
  if (ownership.owned !== true) {
    return { restored: false, reason: ownership.reason || 'recovery quarantine ownership required', details: [] };
  }
  const preferences = await HostPreference.find({
    'benchmarkClaim.admissionId': ownership.admissionId,
    'benchmarkClaim.admissionGeneration': ownership.generation,
    'benchmarkClaim.admissionPrincipal': principal,
    'benchmarkClaim.batchId': ownership.workloadId
  }).lean();
  const details = [];
  for (const pref of preferences) {
    const claim = pref.benchmarkClaim;
    const result = await releaseBenchmarkClaim(pref.hostUrl, claim.batchId, {
      claimGeneration: claim.claimGeneration,
      admissionId: ownership.admissionId,
      admissionGeneration: ownership.generation,
      admissionPrincipal: principal,
      requireAdmissionProof: true,
      excludedModels: Array.isArray(excludedModelsByHost?.[pref.hostUrl])
        ? excludedModelsByHost[pref.hostUrl]
        : []
    });
    details.push({ hostUrl: pref.hostUrl, ...result });
    if (result.released !== true) {
      return { restored: false, reason: result.reason || `host restore failed for ${pref.hostUrl}`, details };
    }
  }
  return {
    restored: true,
    admissionId: ownership.admissionId,
    workloadId: ownership.workloadId,
    recoveryId,
    recoveryGeneration,
    recoveryOwnerId: ownership.recoveryOwnerId || null,
    details
  };
}

async function recoverBenchmarkClaimRelease(hostUrl, batchId, opts = {}) {
  const claimGeneration = cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation);
  if (!hostUrl || !batchId || !claimGeneration) {
    return { recovered: false, released: false, reason: 'hostUrl, batchId and claimGeneration are required' };
  }
  const existing = await HostPreference.findOne({ hostUrl })
    .select('+lastBenchmarkReleaseReceipt')
    .lean();
  if (!existing) return { recovered: false, released: false, reason: 'host preference not found' };
  const receipt = existing.lastBenchmarkReleaseReceipt;
  if (receipt?.contract === 'agentx.benchmark-claim-release/v1'
    && receipt.hostUrl === hostUrl
    && receipt.batchId === batchId
    && receipt.claimGeneration === claimGeneration
    && receipt.state?.claimCleared === true
    && receipt.state?.finalizerCleared === true) {
    return {
      recovered: true,
      released: true,
      releaseReceipt: receipt,
      pinRestore: receipt.verification,
      runtimeRestore: receipt.verification
    };
  }
  const claim = existing.benchmarkClaim;
  if (claim?.batchId === batchId && claim?.claimGeneration === claimGeneration) {
    return {
      recovered: true,
      released: false,
      retryable: !claim.finalizeToken,
      finalizing: Boolean(claim.finalizeToken),
      reason: claim.finalizeToken
        ? 'exact claim release is still finalizing'
        : 'exact claim remains active and can be released again'
    };
  }
  return {
    recovered: false,
    released: false,
    retryable: false,
    reason: claim?.batchId ? 'host is owned by another claim' : 'no matching release receipt or active claim'
  };
}

module.exports = {
  hasActiveBenchmarkClaim,
  claimBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  recoverBenchmarkClaimRelease,
  restoreClaimsForWorkloadRecovery,
  listBenchmarkClaims,
  summarizeBenchmarkClaimReaps,
  reapStaleBenchmarkClaims,
  startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs
};

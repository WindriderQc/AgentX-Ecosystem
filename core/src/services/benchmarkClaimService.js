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
 * Safe paths that should *bypass* this check:
 *   - reapStaleBenchmarkClaims → restorePinnedModels (the claim is being
 *     released for staleness; restoring is correct)
 *   - releaseBenchmarkClaim → restorePinnedModels (the claim was just
 *     cleared by the rightful owner; restoring is correct)
 * Both call restorePinnedModels AFTER releasing the claim, so the check
 * naturally returns false at that point.
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
    claimGeneration: cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation),
    heartbeatTtlMs: positiveInteger(opts.heartbeatTtlMs ?? opts.heartbeat_ttl_ms),
    heartbeatAt: opts.heartbeatAt ? new Date(opts.heartbeatAt) : new Date()
  };
}

function buildBenchmarkClaim(batchId, prevStatus, normalizedOptions) {
  return {
    batchId,
    claimGeneration: normalizedOptions.claimGeneration || crypto.randomUUID(),
    prevStatus,
    claimedAt: new Date(),
    estimatedDurationMs: normalizedOptions.estimatedDurationMs,
    source: inferClaimSource(batchId, normalizedOptions.source),
    owner: normalizedOptions.owner,
    note: normalizedOptions.note,
    heartbeatAt: normalizedOptions.heartbeatAt,
    heartbeatTtlMs: normalizedOptions.heartbeatTtlMs
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
        'benchmarkClaim.claimGeneration': normalizedOptions.claimGeneration
      },
      { $set: set },
      { new: true }
    ).lean();
    if (updated) {
      return {
        claimed: true,
        claimGeneration: updated.benchmarkClaim.claimGeneration,
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
    return {
      claimed: true,
      claimGeneration: updated.benchmarkClaim.claimGeneration,
      pref: updated
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
  // opts.skipPinRestore — when true, do NOT auto-restore the pin after
  // release. Used by reapStaleBenchmarkClaims, which calls restorePinnedModels
  // explicitly with its own logging path. All other callers (the bench's
  // finally{}, the operator endpoint) want the auto-restore (0175).
  const { skipPinRestore = false, allowLegacyMissingGeneration = false } = opts;
  const rawClaimGeneration = opts.claimGeneration ?? opts.claim_generation;
  const claimGeneration = cleanClaimGeneration(rawClaimGeneration);
  const legacyMissingGeneration = allowLegacyMissingGeneration === true
    && (rawClaimGeneration === null || rawClaimGeneration === undefined);
  const expectedLegacyClaimedAt = legacyMissingGeneration && opts.expectedClaimedAt
    ? new Date(opts.expectedClaimedAt)
    : null;
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

  const existing = await HostPreference.findOne({ hostUrl }).lean();
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

  const restoreStatus = existing.benchmarkClaim?.prevStatus || 'idle';
  const releaseFilter = {
    _id: existing._id,
    hostUrl,
    status: 'benchmarking',
    'benchmarkClaim.batchId': batchId,
    'benchmarkClaim.claimGeneration': legacyMissingGeneration ? null : claimGeneration
  };
  // The reaper is the only caller allowed to drain a pre-generation claim.
  // Bind its exact timestamp as well as batch and null/missing generation so a
  // stale read can never clear a replacement UUID-backed claim.
  if (legacyMissingGeneration) {
    releaseFilter['benchmarkClaim.claimedAt'] = expectedLegacyClaimedAt;
  }

  let updated;
  try {
    updated = await HostPreference.findOneAndUpdate(
      releaseFilter,
      {
        $set: {
          status: restoreStatus,
          benchmarkClaim: {
            batchId: null,
            claimGeneration: null,
            prevStatus: null,
            claimedAt: null,
            estimatedDurationMs: null,
            source: null,
            owner: null,
            note: null,
            heartbeatAt: null,
            heartbeatTtlMs: null
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

  // 0175: now that we gate warmHost / restorePinnedModels on active claims,
  // the bench's pre-release restoreAllDedication call becomes a no-op (good
  // - that ordering was the trigger for mid-batch reloads). Trigger pin
  // restoration here so the operator's preferred default still comes back
  // promptly without waiting up to 60s for the reconciler tick. This now
  // blocks until the restore path verifies Ollama residency; returning
  // "released" while a restore silently failed is worse than taking the
  // extra time at the end of a disruptive benchmark/profiler run. The reaper
  // passes skipPinRestore=true and runs its own restore so it can attach
  // reaper-specific logging.
  let pinRestore = null;
  if (!skipPinRestore) {
    // Lazy require to avoid the load-time cycle with hostPreferenceService.
    const hostPrefService = require('./hostPreferenceService');
    const entries = hostPrefService.getPinnedEntries(updated);
    const anyAutoRestore = entries.some(e => e.autoRestore !== false);
    if (entries.length > 0 && anyAutoRestore) {
      try {
        pinRestore = await hostPrefService.restorePinnedModels(hostUrl);
      } catch (err) {
        pinRestore = { host: hostUrl, status: 'error', error: err.message };
        logger.warn(`[HostPreference] post-release pin restore failed on ${hostUrl}: ${err.message}`);
      }
    }
  }

  return { released: true, pref: updated, pinRestore, legacyClaimRecovered: legacyMissingGeneration };
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
      'benchmarkClaim.claimGeneration': claimGeneration
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
  return { heartbeat: true, pref: updated };
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
  const graceFactor = Number(opts.graceFactor) || 1.5;
  const hardCapMs = Number(opts.hardCapMs) || (2 * 60 * 60 * 1000);
  const now = Date.now();

  const claims = await HostPreference.find({ status: 'benchmarking' }).lean();
  const reaped = [];

  // Lazy require to avoid the load-time cycle with hostPreferenceService.
  const hostPrefService = require('./hostPreferenceService');

  for (const pref of claims) {
    const claim = pref.benchmarkClaim || {};
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

    if (!staleReason && ageMs > maxAgeMs) {
      staleReason = 'claim age exceeded max age';
    }
    if (!staleReason) continue;

    // Reaper drives its own restore + logging below; ask the release path
    // not to schedule a duplicate restorePinnedModels call.
    const result = await releaseBenchmarkClaim(pref.hostUrl, claim.batchId, {
      skipPinRestore: true,
      claimGeneration: claim.claimGeneration,
      allowLegacyMissingGeneration: true,
      expectedClaimedAt: claim.claimedAt
    });
    // If the reaped batch left pinned models displaced, restore them now.
    // The batch's own finally{} didn't run (that's why we're reaping), so
    // nobody else will do it. restorePinnedModels is a no-op if autoRestore
    // is false on every entry.
    let pinRestored = false;
    const entries = hostPrefService.getPinnedEntries(pref);
    const anyAutoRestore = entries.some(e => e.autoRestore !== false);
    if (result.released && entries.length > 0 && anyAutoRestore) {
      try {
        logger.info('[hostPreferenceService] reaper triggering pin restore', {
          hostUrl: pref.hostUrl,
          pinnedModels: entries.map(e => e.model),
          batchId: claim.batchId
        });
        const restoreResult = await hostPrefService.restorePinnedModels(pref.hostUrl);
        pinRestored = restoreResult?.status !== 'error';
      } catch (err) {
        logger.warn('[hostPreferenceService] reaper pin restore failed', {
          hostUrl: pref.hostUrl, error: err.message
        });
        void observePinRestoreFailure({
          host: pref.hostUrl,
          models: entries.map(entry => entry.model),
          batchId: claim.batchId,
          error: err.message,
          source: 'benchmark-claim-reaper'
        });
      }
    }
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
    heartbeatTtlMs: p.benchmarkClaim?.heartbeatTtlMs || null
  }));
}

module.exports = {
  hasActiveBenchmarkClaim,
  claimBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  listBenchmarkClaims,
  summarizeBenchmarkClaimReaps,
  reapStaleBenchmarkClaims,
  startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs
};

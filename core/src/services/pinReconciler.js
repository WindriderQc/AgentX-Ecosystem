'use strict';
/**
 * Pin Reconciler
 *
 * Owns the pin auto-restore reconciler (`checkAndReloadDefaults`) and the
 * pin auto-restore grace-period state machine (task 0176). Extracted from
 * hostPreferenceService.js in task 0227 — that file was 1042 lines (cap 700)
 * and mixed pin CRUD, a health-check daemon, this reconciler/grace-period
 * state machine, and benchmark-claim re-exports.
 *
 * Responsibilities:
 *   - checkAndReloadDefaults — the per-tick reconciler that updates
 *     loadedModel/loadedModels, respects active benchmark claims, and warms
 *     displaced pins back once the grace period elapses.
 *   - the grace-period getters/setters (getPinRestoreGraceMs /
 *     setPinRestoreGraceMs) the tests use to drive the window down to a few ms.
 *
 * The interval scheduler that calls checkAndReloadDefaults lives in
 * hostHealthDaemon.js.
 *
 * Cross-module calls into hostPreferenceService (getAll, setHostStatus,
 * warmDefaultModel, updateLoadedModel) are intentionally lazy
 * (`require('./hostPreferenceService')` inside the function body) to avoid a
 * load-time cycle, mirroring the pattern benchmarkClaimService established in
 * task 0183.
 *
 * The function bodies are copied VERBATIM — this is a pure structural split,
 * no behavior change. Symbol stability: hostPreferenceService.js re-exports
 * checkAndReloadDefaults, getPinRestoreGraceMs, and setPinRestoreGraceMs so
 * existing callers keep working.
 */

const hostGate = require('./hostGate');
const logger = require('../../config/logger');
const HostPreference = require('../../models/HostPreference');
const { hasActiveBenchmarkClaim } = require('./benchmarkClaimService');
const { observePinRestoreFailure } = require('./laneObservabilityService');
const { runRuntimeMutation } = require('./runtimeMutationLeaseService');
const {
  getPinnedEntries,
  getWarmOrder,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel
} = require('./hostPinPrimitives');

// Task 0176 — Pin auto-restore grace period.
//
// Ms the reconciler waits after first observing a displaced pin before it
// warms the pin back. Protects active non-benchmark callers (chat, profiler,
// manual swaps) from getting kicked out within one 60s tick. The 0175 claim
// check fires earlier for benchmark batches; this grace is the safety net
// for everyone else. Default 120_000ms / 2 minutes — long enough for an
// interactive session to settle, short enough that an idle host's pin
// returns promptly.
let pinRestoreGraceMs = parseInt(process.env.PIN_RESTORE_GRACE_MS, 10);
if (!Number.isFinite(pinRestoreGraceMs) || pinRestoreGraceMs < 0) {
  pinRestoreGraceMs = 120_000;
}

// ── Health Check ────────────────────────────────────────────

async function checkAndReloadDefaults() {
  // Lazy require to avoid the load-time cycle with hostPreferenceService.
  const hostPrefService = require('./hostPreferenceService');
  const { getAll, setHostStatus, warmDefaultModel, updateLoadedModel } = hostPrefService;

  const prefs = await getAll();
  for (const pref of prefs) {
    try {
      const response = await fetch(`${pref.hostUrl}/api/ps`, {
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        const hasPin = getPinnedEntries(pref).length > 0;
        if (hasPin) await setHostStatus(pref.hostUrl, 'offline');
        continue;
      }
      const data = await response.json();
      const runningModelInfos = data.models || [];
      const runningModels = runningModelInfos.map(m => m.name || m.model);

      // Update loadedModel (scalar, back-compat) + loadedModels[] (array,
      // canonical for multi-model hosts). Rewrite the array every tick so
      // it stays in sync with Ollama; scalar tracks the first running model.
      const topModel = runningModels[0] || null;
      const prevLoaded = Array.isArray(pref.loadedModels) ? pref.loadedModels : [];
      const changed =
        topModel !== pref.loadedModel ||
        prevLoaded.length !== runningModels.length ||
        prevLoaded.some((m, i) => m !== runningModels[i]);
      if (changed) {
        await HostPreference.findOneAndUpdate(
          { hostUrl: pref.hostUrl },
          { $set: { loadedModel: topModel, loadedModels: runningModels } }
        );
      }

      // Skip reload logic if the host is claimed by a benchmark batch or
      // another restore is in flight — either way we don't want to fight
      // the current owner. The hasActiveBenchmarkClaim helper checks both
      // status==='benchmarking' AND a present benchmarkClaim.batchId, so a
      // stale or drifted status field still trips the guard (0175).
      if (hasActiveBenchmarkClaim(pref) || pref.status === 'restoring') {
        if (hasActiveBenchmarkClaim(pref)) {
          logger.debug(`[HostPreference] reconciler skipped ${pref.displayName || pref.hostUrl} — active benchmark claim`, {
            batchId: pref.benchmarkClaim?.batchId || null,
            status: pref.status
          });
        }
        continue;
      }

      const entries = getPinnedEntries(pref);
      if (entries.length === 0) continue;

      // Primary-pin status tracking (first entry drives the host `status` field)
      const primary = entries[0];
      const primaryLoaded = entrySatisfiedByLoadedModel(primary, runningModelInfos);
      if (primaryLoaded && pref.status !== 'ready') {
        await setHostStatus(pref.hostUrl, 'ready');
      }

      // Any entry whose autoRestore is enabled and is currently displaced
      // gets a restore attempt. We reuse restorePinnedModels which handles
      // unload-if-needed + warm on all entries, but we only want to restore
      // the displaced subset. Do it inline here.
      const displaced = entries.filter(e => e.autoRestore && !entrySatisfiedByLoadedModel(e, runningModelInfos));
      const contextMismatches = entries
        .map(e => ({ entry: e, status: getLoadedEntryStatus(e, runningModelInfos) }))
        .filter(({ status }) => status.contextMismatch);
      if (contextMismatches.length > 0) {
        logger.info(`[HostPreference] Pinned context mismatch observed on ${pref.displayName || pref.hostUrl}`, {
          mismatches: contextMismatches.map(({ entry, status }) => ({
            model: entry.model,
            loadedModel: status.loadedModel,
            loadedContextLength: status.loadedContextLength,
            expectedContextLength: status.expectedContextLength
          }))
        });
      }

      // Task 0176 — Pin auto-restore grace period.
      //
      // The reconciler used to fire on the very first tick that observed a
      // displaced pin, kicking out chat sessions / profilers / any caller
      // that legitimately swapped the pin out. We now stamp
      // `pinFirstDisplacedAt` on the first tick we see a displacement and
      // wait `pinRestoreGraceMs` (default 120s) before warming the pin
      // back. The 0175 claim check above runs first, so benchmark batches
      // never reach this path; the grace is for everyone else.
      //
      // Three states:
      //  1. Pin is loaded → clear pinFirstDisplacedAt if we set it earlier
      //     and continue (no restore needed).
      //  2. Pin is displaced and pinFirstDisplacedAt is null → stamp it,
      //     log "grace period started", skip restore.
      //  3. Pin is displaced and pinFirstDisplacedAt is set →
      //       elapsed < grace → log "still in grace, X remaining", skip.
      //       elapsed >= grace → proceed with restore (clear stamp on
      //       success).
      if (displaced.length === 0) {
        if (pref.pinFirstDisplacedAt) {
          await HostPreference.findOneAndUpdate(
            { hostUrl: pref.hostUrl },
            { $set: { pinFirstDisplacedAt: null } }
          );
        }
        continue;
      }

      const now = Date.now();
      const firstDisplacedAt = pref.pinFirstDisplacedAt
        ? new Date(pref.pinFirstDisplacedAt).getTime()
        : null;

      if (!firstDisplacedAt) {
        // First tick that observes the displacement — stamp and wait.
        await HostPreference.findOneAndUpdate(
          { hostUrl: pref.hostUrl },
          { $set: { pinFirstDisplacedAt: new Date(now) } }
        );
        logger.info(`[HostPreference] Pin auto-restore grace period started on ${pref.displayName || pref.hostUrl}`, {
          displaced: displaced.map(d => d.model),
          running: runningModels,
          graceMs: pinRestoreGraceMs
        });
        continue;
      }

      const elapsed = now - firstDisplacedAt;
      if (elapsed < pinRestoreGraceMs) {
        const remainingMs = pinRestoreGraceMs - elapsed;
        logger.info(`[HostPreference] Pin still in grace on ${pref.displayName || pref.hostUrl}, ${Math.round(remainingMs / 1000)}s remaining`, {
          displaced: displaced.map(d => d.model),
          running: runningModels,
          elapsedMs: elapsed,
          remainingMs
        });
        continue;
      }

      logger.info(`[HostPreference] Pin grace elapsed on ${pref.displayName || pref.hostUrl}, auto-restoring`, {
        displaced: displaced.map(d => d.model),
        running: runningModels,
        status: pref.status,
        elapsedMs: elapsed,
        graceMs: pinRestoreGraceMs
      });

      // If the primary is displaced, flip status to restoring so concurrent
      // ticks don't double-fire. restorePinnedModels does this too but
      // setting it here closes the race window at the top of this branch.
      const primaryDisplaced = displaced.some(d => d.model === primary.model);

      // Defer reload if any model on this host has active inference — warming
      // a displaced pin forces a VRAM swap that would terminate the in-flight
      // caller (e.g. a long benchmark judge call). The pin stays displaced
      // until the next tick; status stays unchanged so the retry path is clean.
      if (hostGate.hostHasInflight(pref.hostUrl)) {
        logger.info(`[HostPreference] Deferring pin reload on ${pref.displayName || pref.hostUrl} — host has active inference`, {
          displaced: displaced.map(d => d.model)
        });
        continue;
      }

      await runRuntimeMutation({
        principal: 'core-pin-reconciler',
        scope: `pin-reconcile:${pref.hostUrl}`
      }, async ({ signal, assertActive }) => {
        if (primaryDisplaced) await setHostStatus(pref.hostUrl, 'restoring');
        assertActive();

        let anyWarmOk = false;
        for (const entry of getWarmOrder(displaced)) {
          const opts = {
            keepAlive: entry.keepAlive ?? -1,
            contextSize: entry.contextSize ?? 0,
            signal,
            assertAuthorityActive: assertActive
          };
          const result = await warmDefaultModel(pref.hostUrl, entry.model, opts);
          assertActive();
          if (result.status === 'ok') {
            anyWarmOk = true;
            logger.info(`[HostPreference] Reloaded ${entry.model} on ${pref.displayName || pref.hostUrl}`);
            if (entry.model === primary.model) {
              await updateLoadedModel(pref.hostUrl, entry.model);
              assertActive();
            }
          } else {
            const error = new Error(`Pin restore for ${entry.model} was not terminally verified: ${result.error}`);
            error.code = 'PIN_RESTORE_UNVERIFIED';
            throw error;
          }
        }

        if (anyWarmOk) {
          await HostPreference.findOneAndUpdate(
            { hostUrl: pref.hostUrl },
            { $set: { pinFirstDisplacedAt: null } },
            { signal }
          );
          assertActive();
        }
      });
    } catch (err) {
      void observePinRestoreFailure({
        host: pref.hostUrl,
        model: getPinnedEntries(pref)[0]?.model || null,
        error: err.message,
        source: 'pin-reconciler'
      });
      logger.warn(`[HostPreference] Health check failed for ${pref.hostUrl}: ${err.message}`);
    }
  }
}

// Task 0176 — getters/setters for the pin auto-restore grace period.
// Tests use the setter to drive the grace window down to a few ms so the
// state machine can be exercised in-memory; production code reads the env
// var on module load and never touches these.
function getPinRestoreGraceMs() {
  return pinRestoreGraceMs;
}

function setPinRestoreGraceMs(ms) {
  const parsed = Number(ms);
  if (!Number.isFinite(parsed) || parsed < 0) return;
  pinRestoreGraceMs = parsed;
}

module.exports = {
  checkAndReloadDefaults,
  getPinRestoreGraceMs,
  setPinRestoreGraceMs
};

'use strict';

/**
 * Benchmark → Buddy surface events (task 0266).
 *
 * A thin, opinionated layer over `buddyEventClient.emitBuddyEvent` that makes
 * Buddy a launch / preflight / judge / run guide on the Benchmark surface,
 * per the Buddy product plan § 6 (Benchmark contract).
 *
 * Responsibilities:
 *  - Tag every emission with `surfaceScope:'benchmark'` and an explicit
 *    `intent` from the locked 5-intent model (idle/watching/suggesting/
 *    warning/blocked). The lifecycle-point → {type,intent,significance} map
 *    is the single source of truth here so call sites stay one-liners.
 *  - Enforce the per-surface "quiet during judge/scoring" rule: while a
 *    judge/scoring phase is active, only `watching` (terse) and
 *    `warning`/`blocked` may pass. `suggesting`/`idle` are suppressed.
 *  - Stay strictly fire-and-forget. `emitBuddyEvent` already swallows network
 *    errors; this layer never awaits, never throws, and never blocks or delays
 *    a batch even if mapping/argument construction hits something unexpected.
 *
 * Non-goals: this layer does NOT open a second inference path, write to any
 * Mongo collection, or duplicate the widget. Events only — inference + state
 * live in Core. Cross-container delivery uses Core's generic
 * `/api/platform-events` ingress with the deployed `BUDDY_EMIT_TOKEN` secret.
 */

const { emitBuddyEvent } = require('../../clients/buddyEventClient');
const logger = require('../../../config/logger');

const SURFACE_SCOPE = 'benchmark';
const EVENT_CLASS = 'benchmark';

// Lifecycle point → emitted event. `type` mirrors the seed type→intent map in
// core/src/services/buddyEvents.js so classification agrees even if intent is
// dropped; `intent` is still passed explicitly (authoritative).
const LIFECYCLE = {
  // Preflight / launch
  preflight_start:   { type: 'preflight_start',   intent: 'watching',   significance: 'low' },
  preflight_blocked: { type: 'preflight_blocked', intent: 'blocked',    significance: 'high' },
  // pre-run only — a `suggesting` here is intentionally allowed because no
  // judge/scoring phase is active yet. Suppressed if emitted mid-critical.
  preflight_ok:      { type: 'preflight_ok',      intent: 'suggesting', significance: 'normal' },

  // Run / judge lifecycle
  run_phase:  { type: 'run_phase',  intent: 'watching', significance: 'low' },
  judge_start:{ type: 'judge_start',intent: 'watching', significance: 'low' },
  judge_done: { type: 'judge_done', intent: 'watching', significance: 'low' },

  // Failures / blockers — these are the ONLY proactive things allowed to speak
  // mid-critical, per the safety invariant (warning/blocked never silenced).
  run_blocked: { type: 'run_blocked', intent: 'blocked', significance: 'high' },
  run_warning: { type: 'run_blocked', intent: 'warning', significance: 'high' },
};

// Intents that must stay silent while a judge/scoring phase is active.
const QUIET_DURING_CRITICAL = new Set(['suggesting', 'idle']);

// Module-level critical-phase flag. A benchmark process runs one batch at a
// time (batchOrchestrator holds a single-flight execution lock), so a single
// counter is sufficient and avoids leaking a stuck "critical" state if
// begin/end are unbalanced under error paths.
let _criticalDepth = 0;

function isJudgePhaseActive() {
  return _criticalDepth > 0;
}

/**
 * Mark the start of a judge/scoring (critical) phase. Idempotent-safe via a
 * depth counter so nested/overlapping judge stages don't prematurely clear it.
 */
function beginJudgePhase() {
  _criticalDepth += 1;
}

/** Mark the end of a judge/scoring phase. Never drops below zero. */
function endJudgePhase() {
  if (_criticalDepth > 0) _criticalDepth -= 1;
}

/** Test/reset hook — force-clear the critical flag. */
function _resetJudgePhase() {
  _criticalDepth = 0;
}

/**
 * Emit a benchmark lifecycle event to Buddy.
 *
 * @param {string} point - a key of LIFECYCLE
 * @param {string} summary - human-readable, for the widget/LLM context
 * @param {object} [opts]
 * @param {boolean} [opts.duringJudge] - force the quiet-during-critical check
 *   even if the module flag isn't set (lets call sites be explicit).
 * Fire-and-forget: returns the intent that was emitted, or null if suppressed.
 */
function emitLifecycle(point, summary, opts = {}) {
  try {
    const mapping = LIFECYCLE[point];
    if (!mapping) {
      logger.debug(`buddySurfaceEvents: unknown lifecycle point '${point}' — skipped`);
      return null;
    }

    const critical = opts.duringJudge === true || isJudgePhaseActive();
    if (critical && QUIET_DURING_CRITICAL.has(mapping.intent)) {
      // Quiet-during-critical: drop proactive chatter while judging/scoring.
      logger.debug(`buddySurfaceEvents: suppressed '${point}' (${mapping.intent}) during judge/scoring`);
      return null;
    }

    emitBuddyEvent(
      mapping.type,
      EVENT_CLASS,
      summary || mapping.type,
      mapping.significance,
      { intent: mapping.intent, surfaceScope: SURFACE_SCOPE }
    );
    return mapping.intent;
  } catch (err) {
    // Absolutely never let a buddy emit affect a batch.
    logger.debug(`buddySurfaceEvents: emit failed for '${point}' — ${err.message}`);
    return null;
  }
}

module.exports = {
  emitLifecycle,
  beginJudgePhase,
  endJudgePhase,
  isJudgePhaseActive,
  LIFECYCLE,
  SURFACE_SCOPE,
  EVENT_CLASS,
  QUIET_DURING_CRITICAL,
  _resetJudgePhase,
};

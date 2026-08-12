'use strict';

/**
 * Identity use instrumentation — task 0529.
 *
 * Answers "which agent identities actually did work, over 7/30/90 days?" so
 * identity consolidation is decided from evidence rather than from the registry's
 * own opinion of who exists.
 *
 * The invariant this module exists to protect:
 *
 *   MISSING EVIDENCE IS `unknown`, NEVER `0`.
 *
 * That distinction is the whole point. "This identity was used 0 times" is a
 * finding — it argues for retirement. "We cannot see whether this identity was
 * used" is the absence of a finding, and it argues for nothing. Rendering the
 * second as the first is how a consolidation quietly deletes something that was
 * in use, and it is the same failure already seen elsewhere on this platform: a
 * health probe that reported `agentCount: 0` for eight live agents because it
 * could not parse the response (task 0538).
 *
 * The concrete trap here is retention. InferenceLog carries a TTL index — 30
 * days by default (`INFERENCE_LOG_TTL_DAYS`) — so rows older than that are gone.
 * A 90-day window therefore cannot be answered at all: the query returns nothing
 * and a naive implementation reports a confident `0`. It must report `unknown`.
 */

const logger = require('../../config/logger');

const DEFAULT_WINDOWS_DAYS = Object.freeze([7, 30, 90]);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Evidence states. `measured` is the only one carrying a count. */
const EVIDENCE = Object.freeze({
  MEASURED: 'measured',
  UNKNOWN: 'unknown',
});

const UNKNOWN_REASONS = Object.freeze({
  WINDOW_EXCEEDS_RETENTION: 'window_exceeds_retention',
  SOURCE_UNAVAILABLE: 'source_unavailable',
});

/** Retention actually in force, read the same way the model builds its TTL index. */
function retentionDays() {
  const parsed = parseInt(process.env.INFERENCE_LOG_TTL_DAYS || '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

/**
 * Reduce a free-form `callerDetail` to a stable identity token.
 *
 * `callerDetail` is documented as "agent ID, task ID, cron job name, etc." and in
 * practice carries paths like `nestor/panel/ask`. Only the leading segment is an
 * identity; the rest is operation detail that would fragment the aggregate into
 * near-duplicates and widen what this report exposes. Sanitizing here rather than
 * at the call site means a new caller format cannot leak by omission.
 */
function sanitizeIdentity(value) {
  if (value == null) return null;
  const head = String(value).trim().split(/[/:#?\s]/)[0];
  if (!head) return null;
  return head.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64).toLowerCase();
}

/**
 * Build the per-window evidence envelope.
 *
 * Windows longer than retention are refused before the query runs — asking is
 * what produces the misleading zero, so the guard belongs in front of it, not in
 * the interpretation of the result.
 */
function evidenceForWindow(windowDays, retention) {
  if (windowDays > retention) {
    return {
      windowDays,
      status: EVIDENCE.UNKNOWN,
      reason: UNKNOWN_REASONS.WINDOW_EXCEEDS_RETENTION,
      retentionDays: retention,
      count: null,
    };
  }
  return { windowDays, status: EVIDENCE.MEASURED, reason: null, retentionDays: retention, count: 0 };
}

/**
 * Sanitized identity use across the requested windows.
 *
 * @param {object} [options]
 * @param {number[]} [options.windows] Window sizes in days. Default 7/30/90.
 * @param {Date}   [options.now]
 * @param {object} [options.model]     InferenceLog model (injectable for tests).
 * @returns {Promise<object>} `{ generatedAt, retentionDays, windows, identities }`
 */
async function summarizeIdentityUse(options = {}) {
  const windows = (Array.isArray(options.windows) && options.windows.length
    ? options.windows
    : DEFAULT_WINDOWS_DAYS
  ).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

  const now = options.now instanceof Date ? options.now : new Date();
  const retention = retentionDays();
  const InferenceLog = options.model || require('../../models/InferenceLog');

  const answerable = windows.filter((w) => w <= retention);
  const unavailableWindows = new Set();
  const identities = new Map();

  const ensure = (identity) => {
    if (!identities.has(identity)) {
      identities.set(identity, {
        identity,
        windows: Object.fromEntries(windows.map((w) => [w, evidenceForWindow(w, retention)])),
      });
    }
    return identities.get(identity);
  };

  for (const windowDays of answerable) {
    const since = new Date(now.getTime() - windowDays * DAY_MS);
    let rows;
    try {
      rows = await InferenceLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        {
          $group: {
            _id: { caller: '$caller', callerDetail: '$callerDetail', runtime: '$runtime' },
            count: { $sum: 1 },
            lastSeen: { $max: '$timestamp' },
          },
        },
      ]);
    } catch (err) {
      // The source failed. This window becomes unknown for EVERY identity —
      // not zero. A reporting outage must never read as "unused". Recorded
      // here and applied once after the loop, so identities discovered by a
      // later window are covered too.
      logger.warn('Identity use aggregate failed; reporting unknown', {
        windowDays, error: err.message,
      });
      unavailableWindows.add(windowDays);
      continue;
    }

    for (const row of rows) {
      const identity = sanitizeIdentity(row._id?.callerDetail)
        || sanitizeIdentity(row._id?.caller)
        || 'unknown';
      const entry = ensure(identity);
      const current = entry.windows[windowDays];
      if (current.status !== EVIDENCE.MEASURED) continue;
      current.count += row.count;
      const lastSeen = row.lastSeen ? new Date(row.lastSeen).toISOString() : null;
      if (lastSeen && (!entry.lastSeen || lastSeen > entry.lastSeen)) entry.lastSeen = lastSeen;
      if (row._id?.runtime) {
        entry.runtimes = entry.runtimes || [];
        if (!entry.runtimes.includes(row._id.runtime)) entry.runtimes.push(row._id.runtime);
      }
    }
  }

  // Windows that failed mid-run must be unknown for every identity, including
  // ones first discovered by a later window.
  for (const windowDays of unavailableWindows) {
    for (const entry of identities.values()) {
      entry.windows[windowDays] = {
        windowDays,
        status: EVIDENCE.UNKNOWN,
        reason: UNKNOWN_REASONS.SOURCE_UNAVAILABLE,
        retentionDays: retention,
        count: null,
      };
    }
  }

  return {
    generatedAt: now.toISOString(),
    retentionDays: retention,
    windows,
    unanswerableWindows: windows.filter((w) => w > retention),
    identities: [...identities.values()].sort((a, b) => a.identity.localeCompare(b.identity)),
  };
}

/**
 * Is there enough evidence to retire this identity?
 *
 * Deliberately conservative and deliberately not a boolean: an identity with no
 * measured evidence returns `unknown`, which is not permission to remove it.
 * Consolidation must be blocked by absence of evidence, not enabled by it.
 */
function retirementEvidence(entry, requiredWindowDays) {
  const window = entry?.windows?.[requiredWindowDays];
  if (!window || window.status !== EVIDENCE.MEASURED) {
    return {
      verdict: EVIDENCE.UNKNOWN,
      reason: window?.reason || UNKNOWN_REASONS.SOURCE_UNAVAILABLE,
      safeToRetire: false,
    };
  }
  return {
    verdict: EVIDENCE.MEASURED,
    reason: null,
    unusedFor: window.count === 0 ? requiredWindowDays : null,
    safeToRetire: window.count === 0,
  };
}

module.exports = {
  DEFAULT_WINDOWS_DAYS,
  EVIDENCE,
  UNKNOWN_REASONS,
  retentionDays,
  sanitizeIdentity,
  summarizeIdentityUse,
  retirementEvidence,
};

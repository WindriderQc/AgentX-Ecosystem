'use strict';

/**
 * Shadow evaluation wiring — task 0522, the half the resolver was missing.
 *
 * 0522 delivered the resolver and the comparison function but nothing invoked
 * them, which made ROUTE_RESOLVER_SHADOW a flag that could be switched on and
 * change nothing. A flag that looks live and is inert is worse than no flag: it
 * tells an operator a capability is running when no request can reach it.
 *
 * This is the part that makes it real — and the design rule that makes it safe:
 *
 *   THE SHADOW RUNS AFTER THE RESPONSE, NEVER BEFORE IT.
 *
 * Evaluated inline, this would add a Mongo read and a scoring pass to every
 * request on the platform's hottest path, and any bug in it would surface as a
 * user-visible failure. Deferred to `setImmediate` after the reply is already
 * sent, it is structurally incapable of slowing a request or failing one — the
 * worst case is a missing shadow record, which costs a comparison sample and
 * nothing else.
 *
 * Everything here is therefore best-effort by construction: errors are swallowed
 * at the boundary and logged at debug, because a diagnostic that can break
 * production is not a diagnostic.
 */

const logger = require('../../../config/logger');
const { resolveRoute, isShadowEnabled, compareToActual } = require('./routeResolver');
const { modelsMatch } = require('../../helpers/modelNameNormalization');

/**
 * Build candidate tuples from live host preferences.
 *
 * Deliberately conservative: it describes only what the preference documents
 * actually assert. Absent facts are left `undefined` rather than guessed, which
 * matters because the resolver treats `undefined` as "not known" and excludes
 * only on explicit disqualification — inventing a `false` here would filter out
 * a host that is merely unprofiled.
 */
function buildCandidates(hostPreferences = [], model, actualHostUrl) {
  return hostPreferences
    .filter((pref) => pref?.hostUrl)
    .map((pref) => {
      const pinned = Array.isArray(pref.pinnedModels)
        ? pref.pinnedModels.find((entry) => modelsMatch(entry?.model, model))
        : null;
      const loaded = Array.isArray(pref.loadedModels) ? pref.loadedModels : [];
      const resident = loaded.some((entry) => modelsMatch(entry, model));
      const status = typeof pref.status === 'string' ? pref.status : null;
      const liveOnline = typeof pref.live?.online === 'boolean' ? pref.live.online : undefined;
      const online = status === 'offline'
        ? false
        : (status === 'ready' ? true : liveOnline);
      const draining = ['swapping', 'restoring'].includes(status) || undefined;
      const pinContext = Number(pinned?.contextSize);
      const pinOptions = pinned
        ? {
          ...(Number.isFinite(pinContext) && pinContext > 0 && { num_ctx: Math.round(pinContext) }),
          keep_alive: pinned.keepAlive ?? -1,
        }
        : null;

      return {
        model,
        hostUrl: pref.hostUrl,
        cloud: false,
        host: {
          key: pref.hostKey || null,
          tier: pref.hostKey || null,
          online,
          draining,
          benchmarkClaimed: pref.status === 'benchmarking' || Boolean(pref.benchmarkClaim?.batchId),
          freeVramMiB: undefined,
        },
        artifact: {
          installed: resident || Boolean(pinned) || undefined,
          resident: resident || undefined,
          pinned: Boolean(pinned) || undefined,
          qualified: undefined,
          maxContextTokens: Number.isFinite(pinContext) && pinContext > 0 ? Math.round(pinContext) : undefined,
          pinOptions,
        },
        // Retained so a mismatch can be read without re-deriving which tuple
        // production actually used.
        wasActual: pref.hostUrl === actualHostUrl,
      };
    });
}

/**
 * Compute one shadow comparison. Never throws.
 *
 * @returns {Promise<object|null>} the comparison record, or null when disabled
 *   or unavailable. Null is "no sample", never "they agreed".
 */
async function evaluateShadow(actual = {}, context = {}) {
  if (!isShadowEnabled()) return null;

  try {
    const hostPrefService = require('../hostPreferenceService');
    const preferences = await hostPrefService.getAll();
    const candidates = buildCandidates(preferences, actual.model, actual.hostUrl);
    if (!candidates.length) return null;

    const shadow = resolveRoute(
      {
        mode: context.mode,
        taskType: context.taskType,
        requestedModel: context.requestedModel,
        candidates,
      },
      {
        caller: context.caller,
        callerDetail: context.callerDetail,
        correlationId: context.correlationId,
        cloudEligible: context.cloudEligible === true,
        requiredContextTokens: context.requiredContextTokens,
      }
    );

    const comparison = compareToActual(shadow, actual);
    return {
      match: comparison.match,
      mismatches: comparison.mismatches,
      shadowSelected: shadow.selected
        ? { model: shadow.selected.model, hostUrl: shadow.selected.hostUrl, score: shadow.selected.score }
        : null,
      actual: { model: actual.model || null, hostUrl: actual.hostUrl || null },
      rejected: shadow.rejected,
      candidateCount: candidates.length,
    };
  } catch (err) {
    // A diagnostic that can break production is not a diagnostic.
    logger.debug('Shadow route evaluation failed (non-fatal)', { error: err.message });
    return null;
  }
}

/**
 * Fire-and-forget shadow evaluation, for use on a request path.
 *
 * Returns immediately. Call it only after the response has been sent — the
 * `setImmediate` is what guarantees the comparison cannot sit between a user and
 * their reply.
 */
function scheduleShadowEvaluation(actual, context, onResult) {
  if (!isShadowEnabled()) return;
  setImmediate(async () => {
    const record = await evaluateShadow(actual, context);
    if (!record) return;
    if (typeof onResult === 'function') {
      try { onResult(record); } catch (_err) { /* never surface */ }
      return;
    }
    logger.info('route-shadow', {
      match: record.match,
      mismatches: record.mismatches,
      shadow: record.shadowSelected,
      actual: record.actual,
      candidates: record.candidateCount,
    });
  });
}

module.exports = {
  buildCandidates,
  evaluateShadow,
  scheduleShadowEvaluation,
};

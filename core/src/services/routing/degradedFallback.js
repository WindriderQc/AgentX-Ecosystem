'use strict';

const { resolveRoute, RESOLVER_MODES } = require('./routeResolver');

/**
 * Bounded degraded fallback — task 0523. Supersedes blocked task 0513.
 *
 * When a short interactive request fails for a reason that is plainly about the
 * transport or the host rather than the request itself, retry it exactly once on
 * a different local candidate, and tell the caller it is running degraded.
 *
 * 0513 was blocked because the advisory chain substituted hosts implicitly and
 * unboundedly. This is the bounded successor: every dimension is closed by
 * default and opened only where it is provably safe.
 *
 * THE FOUR INVARIANTS
 * -------------------
 * 1. NEVER AFTER THE FIRST STREAM BYTE. Once any token has reached the client,
 *    the response has begun. A retry would append a second answer to a partial
 *    first one — the user sees two half replies spliced together, or a sentence
 *    that changes its mind mid-word. There is no way to un-send bytes, so this
 *    is checked before anything else and is not overridable.
 * 2. NEVER AUTOMATIC CLOUD. A local failure must not silently become a paid,
 *    off-machine request. Escalating privacy and cost boundaries is a decision a
 *    human makes, not a fallback path. This holds even when the cloud candidate
 *    is otherwise eligible.
 * 3. ONCE. One retry, then the error surfaces. Retry chains turn one slow host
 *    into a multiplied stall, and the user is waiting.
 * 4. THREE LANES ONLY. quick_chat, buddy_reaction, nestor_answer_light — short,
 *    interactive, cheap to repeat. A long generation or a batch job must not
 *    silently double its cost.
 *
 * Everything here is pure and flag-gated: `isEnabled()` is false unless
 * DEGRADED_FALLBACK is the literal "true".
 */

/** The only lanes in scope. Short, interactive, cheap to repeat. */
const SCOPED_LANES = Object.freeze(['quick_chat', 'buddy_reaction', 'nestor_answer_light']);

/**
 * Failure classes that may be retried.
 *
 * The common thread: each is evidence the *host* failed, not that the request
 * was bad. A request that is itself malformed will fail identically on a second
 * host, so retrying it only doubles the latency before the same error.
 */
const RETRYABLE_FAILURES = Object.freeze({
  CONNECTION_FAILURE: 'connection_failure',
  PRE_RESPONSE_TIMEOUT: 'pre_response_timeout',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  MISSING_ARTIFACT_VERIFIED: 'missing_artifact_verified',
});

const RETRYABLE = new Set(Object.values(RETRYABLE_FAILURES));

/**
 * HTTP 5xx codes treated as "the host is unavailable".
 *
 * 502/503/504 are gateway/unavailable/timeout — statements about reachability.
 * 500 is deliberately excluded: it is the generic "something went wrong inside",
 * which on a model host is usually a real generation error (bad options, an OOM
 * on this exact prompt) that will reproduce identically elsewhere. Retrying it
 * doubles the wait to reach the same failure.
 */
const APPROVED_5XX = Object.freeze([502, 503, 504]);

/** Why a retry was refused. Stable codes — the degraded UI cue and telemetry group on these. */
const REFUSAL_REASONS = Object.freeze({
  DISABLED: 'fallback_disabled',
  LANE_OUT_OF_SCOPE: 'lane_out_of_scope',
  STREAM_ALREADY_STARTED: 'stream_already_started',
  ALREADY_RETRIED: 'already_retried',
  FAILURE_NOT_RETRYABLE: 'failure_not_retryable',
  STATUS_NOT_APPROVED: 'status_not_approved',
  ARTIFACT_NOT_VERIFIED: 'artifact_not_verified',
  NO_LOCAL_CANDIDATE: 'no_local_candidate',
  CLOUD_NOT_AUTOMATIC: 'cloud_not_automatic',
});

function isEnabled() {
  return String(process.env.DEGRADED_FALLBACK || '').toLowerCase() === 'true';
}

/**
 * Classify an upstream failure into a retryable class, or null.
 *
 * `missing_artifact` requires `verified === true`: an assumed-missing model is
 * not evidence. Guessing here would retry away from a host that actually had
 * the model, which is how a fallback path quietly becomes the normal path.
 */
function classifyFailure(failure = {}) {
  if (failure.kind === 'connection') return RETRYABLE_FAILURES.CONNECTION_FAILURE;
  if (failure.kind === 'timeout' && failure.streamStarted !== true) {
    return RETRYABLE_FAILURES.PRE_RESPONSE_TIMEOUT;
  }
  if (failure.kind === 'http' && APPROVED_5XX.includes(Number(failure.status))) {
    return RETRYABLE_FAILURES.UPSTREAM_UNAVAILABLE;
  }
  if (failure.kind === 'missing_artifact' && failure.verified === true) {
    return RETRYABLE_FAILURES.MISSING_ARTIFACT_VERIFIED;
  }
  return null;
}

/**
 * Decide whether one retry is permitted.
 *
 * Ordered so the most irreversible condition is checked first: bytes already
 * sent cannot be recalled, so that gate precedes every other consideration
 * including the feature flag's own scope checks.
 *
 * @returns {{eligible: boolean, reason: string|null, failureClass: string|null}}
 */
function isRetryEligible(attemptState = {}) {
  const deny = (reason) => ({ eligible: false, reason, failureClass: null });

  // 1. Irreversible: the client already has part of the answer.
  if (attemptState.streamStarted === true) return deny(REFUSAL_REASONS.STREAM_ALREADY_STARTED);

  if (!isEnabled()) return deny(REFUSAL_REASONS.DISABLED);
  if (!SCOPED_LANES.includes(attemptState.lane)) return deny(REFUSAL_REASONS.LANE_OUT_OF_SCOPE);

  // 3. Once. `attempt` is 1-based, so anything past the first has had its retry.
  if (Number(attemptState.attempt) > 1) return deny(REFUSAL_REASONS.ALREADY_RETRIED);

  const failureClass = classifyFailure(attemptState.failure);
  if (!failureClass) {
    const failure = attemptState.failure || {};
    if (failure.kind === 'http') return deny(REFUSAL_REASONS.STATUS_NOT_APPROVED);
    if (failure.kind === 'missing_artifact') return deny(REFUSAL_REASONS.ARTIFACT_NOT_VERIFIED);
    return deny(REFUSAL_REASONS.FAILURE_NOT_RETRYABLE);
  }

  return { eligible: true, reason: null, failureClass };
}

/**
 * Pick the retry target from already-filtered candidates.
 *
 * Callers pass survivors from the 0522 resolver, so these are known-possible.
 * Two rules: never the candidate that just failed, and never a cloud candidate —
 * invariant 2 holds here as a hard exclusion rather than a ranking penalty, so
 * no scoring change can ever surface cloud as an automatic fallback.
 */
function selectRetryCandidate(candidates = [], failedCandidate = {}) {
  const local = candidates.filter((candidate) => {
    if (candidate?.cloud === true) return false;
    const sameHost = candidate?.hostUrl && candidate.hostUrl === failedCandidate.hostUrl;
    const sameModel = candidate?.model && candidate.model === failedCandidate.model;
    return !(sameHost && sameModel);
  });

  if (!local.length) {
    const hadCloud = candidates.some((candidate) => candidate?.cloud === true);
    return {
      candidate: null,
      reason: hadCloud ? REFUSAL_REASONS.CLOUD_NOT_AUTOMATIC : REFUSAL_REASONS.NO_LOCAL_CANDIDATE,
    };
  }
  return { candidate: local[0], reason: null };
}

/**
 * Turn raw host-preference candidates into the closed, ordered set that a live
 * degraded retry may use.
 *
 * The shadow resolver owns hard filtering and deterministic scoring. The live
 * retry adds two stricter boundaries: a candidate must be explicitly online,
 * and its host key must be in the operator-approved fallback set. Unknown host
 * rows and tertiary runtimes therefore fail closed before selection.
 */
function resolveRetryCandidates(candidates = [], options = {}) {
  const allowedHostKeys = new Set(options.allowedHostKeys || ['primary', 'secondary']);
  const excludedHostKeys = new Set(options.excludedHostKeys || ['tertiary']);
  const permitted = candidates.filter((candidate) => {
    const hostKey = candidate?.host?.key;
    if (!hostKey || !allowedHostKeys.has(hostKey) || excludedHostKeys.has(hostKey)) return false;
    return candidate?.host?.online === true;
  });

  const resolved = resolveRoute(
    {
      mode: RESOLVER_MODES.MODEL,
      taskType: options.taskType,
      requestedModel: options.requestedModel,
      candidates: permitted,
    },
    {
      cloudEligible: false,
      requiredContextTokens: options.requiredContextTokens,
    }
  );

  return {
    candidates: resolved.scored,
    rejected: resolved.rejected,
  };
}

/**
 * The degraded state handed back to the surface.
 *
 * `userCue` is intentionally present and intentionally vague — the user needs to
 * know the answer came from a fallback path, not which host died. `pinOptions`
 * is recalculated from the retry target because the original host's pin context
 * no longer applies; carrying it over is how a request ends up asking for a
 * context window the new host never loaded.
 */
function buildDegradedState(failureClass, retryCandidate, options = {}) {
  return {
    degraded: true,
    degradedReason: failureClass,
    userCue: options.userCue || 'mode dégradé',
    retriedTo: retryCandidate
      ? { model: retryCandidate.model, hostUrl: retryCandidate.hostUrl, host: retryCandidate.host?.key || null }
      : null,
    pinOptions: retryCandidate?.artifact?.pinOptions || null,
    cloudEscalated: false, // invariant 2: never true on an automatic path
  };
}

/**
 * Run the one permitted retry, or explain why not.
 *
 * Stays free of I/O: the caller supplies `executeAttempt`, so the route keeps
 * ownership of fetch options, timeouts and its abort wiring rather than this
 * module growing a second, subtly different copy of them. Two implementations
 * of "how we call Ollama" is how the retry path drifts from the primary path
 * and starts failing for reasons the primary never would.
 *
 * Returns `{ retried: false, reason }` for every refusal so the caller can log
 * why a fallback did not happen — silence there is indistinguishable from the
 * feature being broken.
 */
async function runDegradedRetry({ attemptState, candidates, failedCandidate, executeAttempt }) {
  const eligibility = isRetryEligible(attemptState);
  if (!eligibility.eligible) return { retried: false, reason: eligibility.reason };

  const { candidate, reason } = selectRetryCandidate(candidates, failedCandidate);
  if (!candidate) return { retried: false, reason };

  const result = await executeAttempt(candidate);
  return {
    retried: true,
    reason: null,
    candidate,
    result,
    degraded: buildDegradedState(eligibility.failureClass, candidate),
  };
}

module.exports = {
  SCOPED_LANES,
  runDegradedRetry,
  resolveRetryCandidates,
  RETRYABLE_FAILURES,
  APPROVED_5XX,
  REFUSAL_REASONS,
  isEnabled,
  classifyFailure,
  isRetryEligible,
  selectRetryCandidate,
  buildDegradedState,
};

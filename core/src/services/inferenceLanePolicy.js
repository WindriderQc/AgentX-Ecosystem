'use strict';

const { resolveCallerPolicy } = require('./routing/callerPolicy');

/**
 * Caller-aware execution lanes for /api/inference/generate.
 * Lane selection controls routing, admission, and telemetry cost. It never
 * rewrites model names: every lane sends the exact caller-selected tag.
 * Privileged performance policies are authenticated by the HTTP boundary and
 * supplied to resolvePolicyLane; callerDetail remains telemetry metadata.
 */
const LANE_POLICY = Object.freeze({
  direct: Object.freeze({
    route: false,
    admit: false,
    recordInferenceSync: false,
    alert: 'error-only',
  }),
  interactive: Object.freeze({
    route: true,
    admit: true,
    recordInferenceSync: false,
    alert: true,
  }),
  automated: Object.freeze({
    route: true,
    admit: true,
    recordInferenceSync: true,
    alert: true,
  }),
});

/**
 * Resolve the lane for a given callerDetail.
 *
 * @param {string|undefined|null} callerDetail
 * @returns {{ name: 'direct'|'interactive'|'automated', policy: object }}
 */
function resolveLane(callerDetail) {
  const { lane } = resolveCallerPolicy(callerDetail);
  return { name: lane, policy: LANE_POLICY[lane] };
}

function resolvePolicyLane(callerPolicy) {
  const lane = callerPolicy && LANE_POLICY[callerPolicy.lane]
    ? callerPolicy.lane
    : 'automated';
  return { name: lane, policy: LANE_POLICY[lane] };
}

module.exports = {
  LANE_POLICY,
  resolveLane,
  resolvePolicyLane,
};

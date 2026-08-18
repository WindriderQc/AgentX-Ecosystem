'use strict';

const crypto = require('crypto');
const { operatorTokenAllowed, sameOriginUiAllowed } = require('../../middleware/operatorAccess');
const { DEFAULT_POLICY, resolveCallerPolicy } = require('./callerPolicy');

const BENCHMARK_TOKEN_HEADER = 'x-agentx-benchmark-token';

function expectedBenchmarkToken() {
  return process.env.AGENTX_BENCHMARK_TOKEN || '';
}

function presentedBenchmarkToken(req) {
  return req.get?.(BENCHMARK_TOKEN_HEADER) || '';
}

function tokensMatch(left, right) {
  const expected = Buffer.from(String(left || ''));
  const presented = Buffer.from(String(right || ''));
  return expected.length === presented.length
    && expected.length > 0
    && crypto.timingSafeEqual(expected, presented);
}

function benchmarkTokenAllowed(req) {
  return tokensMatch(expectedBenchmarkToken(), presentedBenchmarkToken(req));
}

function inferenceCallerPrincipal(req) {
  if (benchmarkTokenAllowed(req)) return 'benchmark-service';
  if (operatorTokenAllowed(req)) return 'operator-token';
  if (sameOriginUiAllowed(req)) return 'same-origin-ui';
  return 'anonymous';
}

/**
 * Resolve caller-supplied performance metadata into an effective policy.
 *
 * callerDetail remains available for telemetry, but privileged rate buckets
 * and lanes require an authenticated principal. A missing or invalid proof
 * degrades to the safe automated/general policy instead of rejecting the
 * inference request.
 */
function resolveInferenceRequestCaller(req) {
  const callerDetail = req.body?.callerDetail || '';
  const requestedPolicy = resolveCallerPolicy(callerDetail);
  const benchmarkAuthenticated = benchmarkTokenAllowed(req);
  const operatorAuthenticated = operatorTokenAllowed(req);
  const sameOriginAuthenticated = sameOriginUiAllowed(req);
  let principal = inferenceCallerPrincipal(req);

  let effectivePolicy = requestedPolicy;
  if (requestedPolicy.rateBucket === 'benchmark') {
    if (benchmarkAuthenticated) principal = 'benchmark-service';
    else effectivePolicy = DEFAULT_POLICY;
  } else if (requestedPolicy.rateBucket === 'internal') {
    if (operatorAuthenticated) principal = 'operator-token';
    else if (sameOriginAuthenticated) principal = 'same-origin-ui';
    else effectivePolicy = DEFAULT_POLICY;
  }

  return {
    principal,
    requestedPolicy,
    effectivePolicy
  };
}

module.exports = {
  BENCHMARK_TOKEN_HEADER,
  expectedBenchmarkToken,
  presentedBenchmarkToken,
  benchmarkTokenAllowed,
  inferenceCallerPrincipal,
  resolveInferenceRequestCaller
};

'use strict';

const { requestPrincipal } = require('../../helpers/requestCaller');
const { resolveCallerPolicy } = require('./callerPolicy');

function inferenceCallerPrincipal(req) {
  return requestPrincipal(req);
}

/**
 * Resolve caller-supplied performance metadata into an effective policy.
 * Callers on the private LAN are trusted, so the requested policy is applied
 * as declared.
 */
function resolveInferenceRequestCaller(req) {
  const callerDetail = req.body?.callerDetail || '';
  const requestedPolicy = resolveCallerPolicy(callerDetail);
  return {
    principal: inferenceCallerPrincipal(req),
    requestedPolicy,
    effectivePolicy: requestedPolicy
  };
}

module.exports = {
  inferenceCallerPrincipal,
  resolveInferenceRequestCaller
};

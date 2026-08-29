'use strict';

const { normalizeAgentXProfile } = require('../../../shared/agentxRuntimeProfile');

function shouldRecoverBenchmarkClaims(profile = process.env.AGENTX_PROFILE) {
  return normalizeAgentXProfile(profile) === 'full';
}

module.exports = { shouldRecoverBenchmarkClaims };

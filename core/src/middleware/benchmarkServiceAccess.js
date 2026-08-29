'use strict';

const {
  benchmarkTokenAllowed,
  expectedBenchmarkToken,
} = require('../services/routing/inferenceCallerAccess');
const { operatorUiAccessAllowed } = require('./operatorAccess');
const { trustedLocalMachineAllowed } = require('./publicExposureGuard');

function benchmarkServiceAccessAllowed(req) {
  if (benchmarkTokenAllowed(req)) return true;
  if (operatorUiAccessAllowed(req)) return true;
  // Preserve the product's explicit secret-free local/container authority.
  // Browser-shaped requests never qualify for this branch; remote machines
  // still need the purpose-scoped token even when they send a plausible Host.
  if (!expectedBenchmarkToken() && trustedLocalMachineAllowed(req)) return true;
  return false;
}

function requireBenchmarkServiceAccess(req, res, next) {
  if (benchmarkServiceAccessAllowed(req)) return next();
  return res.status(403).json({
    status: 'error',
    code: 'BENCHMARK_SERVICE_ACCESS_REQUIRED',
    message: 'Benchmark service token, same-origin UI, or trusted local operator access required.'
  });
}

module.exports = {
  benchmarkServiceAccessAllowed,
  requireBenchmarkServiceAccess,
};

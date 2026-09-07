'use strict';

const CALLER_HEADER = 'X-AgentX-Caller';
const BENCHMARK_PRINCIPAL = 'benchmark-service';

/**
 * Declare Benchmark's identity to Core. Plain attribution on a private LAN,
 * not a credential.
 */
function withBenchmarkServiceAuth(headers = {}) {
  return { ...headers, [CALLER_HEADER]: BENCHMARK_PRINCIPAL };
}

module.exports = {
  CALLER_HEADER,
  BENCHMARK_PRINCIPAL,
  withBenchmarkServiceAuth
};

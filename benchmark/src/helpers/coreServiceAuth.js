'use strict';

const BENCHMARK_TOKEN_HEADER = 'X-AgentX-Benchmark-Token';

/**
 * Add Benchmark's scoped Core credential when one was configured externally.
 * The token is intentionally absent from source and from the default runtime.
 */
function withBenchmarkServiceAuth(headers = {}) {
  const token = process.env.AGENTX_BENCHMARK_TOKEN || '';
  return token
    ? { ...headers, [BENCHMARK_TOKEN_HEADER]: token }
    : { ...headers };
}

module.exports = {
  BENCHMARK_TOKEN_HEADER,
  withBenchmarkServiceAuth
};

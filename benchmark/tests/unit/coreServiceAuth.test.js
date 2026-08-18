'use strict';

const {
  BENCHMARK_TOKEN_HEADER,
  withBenchmarkServiceAuth
} = require('../../src/helpers/coreServiceAuth');

describe('Core service authentication headers', () => {
  const originalToken = process.env.AGENTX_BENCHMARK_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalToken;
  });

  test('omits the credential when no external token is configured', () => {
    delete process.env.AGENTX_BENCHMARK_TOKEN;
    expect(withBenchmarkServiceAuth({ Accept: 'application/json' })).toEqual({
      Accept: 'application/json'
    });
  });

  test('adds the scoped credential without mutating the input headers', () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'scoped-benchmark-token';
    const input = { 'Content-Type': 'application/json' };

    expect(withBenchmarkServiceAuth(input)).toEqual({
      'Content-Type': 'application/json',
      [BENCHMARK_TOKEN_HEADER]: 'scoped-benchmark-token'
    });
    expect(input).toEqual({ 'Content-Type': 'application/json' });
  });
});

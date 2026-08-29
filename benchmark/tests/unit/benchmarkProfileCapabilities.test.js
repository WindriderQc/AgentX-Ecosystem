'use strict';

const { shouldRecoverBenchmarkClaims } = require('../../src/helpers/benchmarkProfileCapabilities');

describe('Benchmark profile capabilities', () => {
  it('does not poll full-profile claim coordination from the demo product', () => {
    expect(shouldRecoverBenchmarkClaims('demo')).toBe(false);
    expect(shouldRecoverBenchmarkClaims(undefined)).toBe(false);
  });

  it('enables startup claim recovery in the explicit full profile', () => {
    expect(shouldRecoverBenchmarkClaims('full')).toBe(true);
    expect(shouldRecoverBenchmarkClaims(' FULL ')).toBe(true);
  });
});

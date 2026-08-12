'use strict';

const { estimateTotalVram } = require('../../src/services/parameterDetection');

/**
 * Locks the VRAM estimator to the real `ollama ps` measurements documented in
 * estimateKvCacheBytes. The KV base factor (55 MiB/B/1K for <30B) and
 * estimateTotalVram's tiered overhead multiplier COMPOSE to match the measured
 * totals — if either half changes without the other, these back-tests break
 * before the drift ships as bad fit estimates.
 */
describe('estimateTotalVram back-test against documented measurements', () => {
  const GB = 1024 ** 3;

  it('matches deepseek-r1:8b Q4_K_M at 32K ctx within 10% (measured 25 GB)', () => {
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', 32768) / GB;
    expect(estimate).toBeGreaterThan(25 * 0.9);
    expect(estimate).toBeLessThan(25 * 1.1);
  });

  it('matches deepseek-r1:8b Q4_K_M at 65K ctx within 10% (measured 45 GB)', () => {
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', 65536) / GB;
    expect(estimate).toBeGreaterThan(45 * 0.9);
    expect(estimate).toBeLessThan(45 * 1.1);
  });

  it('never uses the raw 78 slope directly (would double-count overhead)', () => {
    // With a 78 base factor the 65K estimate would be ~58 GB — 29% over the
    // measured 45 GB. Guard the ceiling explicitly.
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', 65536) / GB;
    expect(estimate).toBeLessThan(50);
  });
});

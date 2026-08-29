'use strict';

const { estimateTotalVram } = require('../../src/services/parameterDetection');

/**
 * Calibration provenance: `ollama ps` reported 25 GB total allocation at 32K
 * context and 45 GB at 65K for deepseek-r1:8b Q4_K_M. That change implies a
 * raw total-allocation slope of roughly 78 MiB/B/1K, but 78 is not the KV base:
 * estimateTotalVram also applies 30% overhead to weights plus KV at both points.
 * The 55 MiB/B/1K base composes with that multiplier to estimate 23.9 GiB and
 * 42.2 GiB. Using 78 as the base would count overhead twice and estimate about
 * 57.6 GiB at 65K. These tests lock both halves of that calibration together.
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

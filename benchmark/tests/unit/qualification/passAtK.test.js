'use strict';

const { combination, estimatePassAtK, wilsonInterval, buildPassAtKReport } = require('../../../src/services/qualification/passAtK');

describe('passAtK.combination', () => {
  test('computes binomial coefficients', () => {
    expect(combination(4, 2)).toBe(6);
    expect(combination(5, 0)).toBe(1);
    expect(combination(5, 5)).toBe(1);
    expect(combination(3, 1)).toBe(3);
  });

  test('returns 0 for invalid / out-of-range k', () => {
    expect(combination(2, 3)).toBe(0);
    expect(combination(-1, 1)).toBe(0);
    expect(combination(3, 1.5)).toBe(0);
  });
});

describe('passAtK.estimatePassAtK', () => {
  test('boundary cases', () => {
    expect(estimatePassAtK(3, 0, 1)).toBe(0);        // never passes
    expect(estimatePassAtK(3, 3, 1)).toBe(1);        // always passes
    expect(estimatePassAtK(3, 1, 1)).toBeCloseTo(1 / 3, 10);
  });

  test('unbiased estimator matches 1 - C(n-c,k)/C(n,k)', () => {
    // n=4, c=2, k=2  ->  1 - C(2,2)/C(4,2) = 1 - 1/6
    expect(estimatePassAtK(4, 2, 2)).toBeCloseTo(1 - 1 / 6, 10);
    // n=5, c=2, k=3  ->  1 - C(3,3)/C(5,3) = 1 - 1/10
    expect(estimatePassAtK(5, 2, 3)).toBeCloseTo(1 - 1 / 10, 10);
  });

  test('returns 1 when passing attempts guarantee a hit (n-c < k)', () => {
    expect(estimatePassAtK(3, 1, 3)).toBe(1); // only 2 failures, sampling all 3
  });

  test('rejects invalid inputs', () => {
    expect(() => estimatePassAtK(0, 0, 1)).toThrow(/invalid pass@k/);
    expect(() => estimatePassAtK(3, 4, 1)).toThrow(/invalid pass@k/); // c > n
    expect(() => estimatePassAtK(3, 1, 0)).toThrow(/invalid pass@k/); // k < 1
    expect(() => estimatePassAtK(3, 1, 4)).toThrow(/invalid pass@k/); // k > n
  });
});

describe('passAtK.buildPassAtKReport', () => {
  test('groups by model and computes observed rate + pass@k', () => {
    const records = [
      { model: 'A', grade: { pass: true } },
      { model: 'A', grade: { pass: true } },
      { model: 'A', grade: { pass: false } },
      { model: 'B', grade: { pass: false } },
      { model: 'B', grade: { pass: false } }
    ];
    const report = buildPassAtKReport(records, { ks: [1, 3] });
    const a = report.find((r) => r.model === 'A');
    const b = report.find((r) => r.model === 'B');

    expect(a.samples).toBe(3);
    expect(a.correct).toBe(2);
    expect(a.observedPassRate).toBeCloseTo(2 / 3, 10);
    expect(a.passAtK['pass@1']).toBeCloseTo(2 / 3, 10);
    expect(a.passAtK['pass@3']).toBe(1); // 2 of 3 pass, sampling all 3

    expect(b.correct).toBe(0);
    expect(b.passAtK['pass@1']).toBe(0);
    // pass@3 omitted for B because it only has 2 samples (k must be <= n)
    expect(b.passAtK['pass@3']).toBeUndefined();
  });

  test('honours a custom passOf predicate and ignores model-less records', () => {
    const records = [
      { model: 'A', ok: true },
      { model: 'A', ok: false },
      { ok: true } // no model -> ignored
    ];
    const report = buildPassAtKReport(records, { ks: [1], passOf: (r) => r.ok === true });
    expect(report).toHaveLength(1);
    expect(report[0].samples).toBe(2);
    expect(report[0].correct).toBe(1);
  });
});

describe('passAtK.wilsonInterval', () => {
  test('returns a bounded 95% interval around the observed pass rate', () => {
    const interval = wilsonInterval(30, 60);
    expect(interval.low).toBeGreaterThan(0.35);
    expect(interval.low).toBeLessThan(0.5);
    expect(interval.high).toBeGreaterThan(0.5);
    expect(interval.high).toBeLessThan(0.65);
  });

  test('handles boundary rates without leaving [0, 1]', () => {
    expect(wilsonInterval(0, 5).low).toBe(0);
    expect(wilsonInterval(5, 5).high).toBe(1);
  });
});

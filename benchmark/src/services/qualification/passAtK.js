'use strict';

/**
 * passAtK — shared, dependency-free pass@k math for benchmark qualification.
 *
 * Extracted (task 0452) so the code-lane executable grader and the Hermes
 * agentic bake-off compute the estimator identically instead of keeping two
 * copies that drift. Only the pure math lives here; each lane keeps its own
 * report builder because their per-sample fields differ (a code run has
 * executable pass/fail; an agentic run also has completion-envelope rates).
 */

function combination(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n) return 0;
  const r = Math.min(k, n - k);
  let value = 1;
  for (let i = 1; i <= r; i += 1) value = (value * (n - r + i)) / i;
  return value;
}

/**
 * Unbiased pass@k estimator (Chen et al. 2021):
 *   1 - C(n-c, k) / C(n, k)
 * n = total independent attempts, c = number that passed, k = sample size.
 */
function estimatePassAtK(total, correct, k) {
  const n = Number(total);
  const c = Number(correct);
  const sampleK = Number(k);
  if (![n, c, sampleK].every(Number.isInteger) || n < 1 || c < 0 || c > n || sampleK < 1 || sampleK > n) {
    throw new Error(`invalid pass@k inputs: n=${total}, c=${correct}, k=${k}`);
  }
  if (n - c < sampleK) return 1;
  return 1 - combination(n - c, sampleK) / combination(n, sampleK);
}

/** Wilson score interval for a Bernoulli pass rate (default 95%). */
function wilsonInterval(correct, total, z = 1.96) {
  const n = Number(total);
  const c = Number(correct);
  if (!Number.isInteger(n) || !Number.isInteger(c) || n < 1 || c < 0 || c > n || !Number.isFinite(z) || z <= 0) {
    throw new Error(`invalid Wilson inputs: n=${total}, c=${correct}, z=${z}`);
  }
  const p = c / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Generic per-model pass@k report. `records` is a flat list of attempt records;
 * `passOf(record)` returns the executable/deterministic boolean pass for that
 * attempt (no LLM opinion). Groups by `model`, then reports observed pass rate
 * and pass@k for every requested k that is <= the group's attempt count.
 */
function buildPassAtKReport(records, { ks = [1, 3], passOf = (r) => r?.grade?.pass === true } = {}) {
  const grouped = new Map();
  for (const record of records || []) {
    const model = record?.model;
    if (!model) continue;
    if (!grouped.has(model)) grouped.set(model, []);
    grouped.get(model).push(record);
  }
  return [...grouped.entries()].map(([model, samples]) => {
    const n = samples.length;
    const correct = samples.filter((s) => passOf(s) === true).length;
    const validKs = [...new Set(ks)].filter((k) => Number.isInteger(k) && k >= 1 && k <= n);
    return {
      model,
      samples: n,
      correct,
      observedPassRate: n > 0 ? correct / n : 0,
      passAtK: Object.fromEntries(validKs.map((k) => [`pass@${k}`, estimatePassAtK(n, correct, k)]))
    };
  });
}

module.exports = { combination, estimatePassAtK, wilsonInterval, buildPassAtKReport };

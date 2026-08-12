'use strict';

/**
 * calibrationAggregator — pure reducer over calibration-tagged rows (task 0297).
 *
 * Sibling of capabilityAggregator (0296). Groups K-probe-tagged BenchmarkResult-
 * shaped rows by the frozen qualification unit (model × agent × task_class × host)
 * and emits, per unit, the calibration evidence the promotion engine (0298)
 * consumes: the `K` score (fraction of distinct probes passed), the
 * `k1_k2_hardfail` disqualifier flag, and a per-probe breakdown.
 *
 * PURE: no DB. The caller reads BenchmarkResult rows whose `qualification.tier`
 * is one of K1..K4 and enriches each with the run's `agent` and `task_class`
 * (the contract matrix knows these from --agent). Rows without a K-tier are
 * ignored. Rows for non-K tiers (C0..C4) are ignored here — capability has its
 * own aggregator.
 *
 * Frozen scoring rule (schema §2b): K = fraction passed, but ANY K1/K2 hard-fail
 * is disqualifying regardless of the average. We surface both so 0298 can apply
 * the gate without recomputing it.
 *
 * Multiple rows for the same probe (repeats) collapse conservatively:
 *   - a probe counts as PASSED only if it passed on EVERY run (worst-case wins);
 *   - a catastrophic probe is hard-failed if it hard-failed on ANY run.
 * This refuses to let a single lucky pass paper over a flaky catastrophic miss.
 */

const K_PROBES = Object.freeze(['K1', 'K2', 'K3', 'K4']);
const CATASTROPHIC = Object.freeze(new Set(['K1', 'K2']));
const K_FLOOR = 0.80; // schema §4 A1→A2 calibration floor

function isKTier(t) {
  return typeof t === 'string' && K_PROBES.includes(t);
}

function unitKey(r) {
  const host = (r.qualification && r.qualification.host) || r.host || '';
  return [r.model || '', r.agent || '', r.task_class || '', host].join('||');
}

/**
 * @param {Array<Object>} rows  calibration-tagged rows (plain objects). Each row:
 *   { model, agent, task_class, host, batch_id?, timestamp?,
 *     qualification: { tier:'K1'..'K4', passed:Boolean, reason?, host? },
 *     k_hardfail?: Boolean }   // optional explicit catastrophic hard-fail flag
 *
 *   If `k_hardfail` is absent, a catastrophic probe (K1/K2) is treated as
 *   hard-failed whenever `qualification.passed === false` (the grader's rule:
 *   a catastrophic miss IS a hard-fail).
 *
 * @returns {Array<Object>} one record per unit:
 *   {
 *     unit: { model, agent, task_class, host },
 *     K: Number|null,                 // distinct probes passed / distinct probes seen
 *     k1_k2_hardfail: Boolean,
 *     meets_floor: Boolean,           // !hardfail && K >= 0.80
 *     per_probe: { K1:{passed,hardFail,reason}, ... },
 *     probes_seen: [String], probes_passed: [String], probes_hardfailed: [String],
 *     evidence: { calibration_batch, contract_matrix_run },
 *     n: Number, last_tested: String|null
 *   }
 */
function aggregateCalibration(rows = []) {
  const groups = new Map();

  for (const r of rows) {
    const q = r && r.qualification;
    if (!q || !isKTier(q.tier)) continue; // only K-tagged rows count

    const key = unitKey(r);
    if (!groups.has(key)) {
      groups.set(key, {
        unit: {
          model: r.model || null,
          agent: r.agent || null,
          task_class: r.task_class || null,
          host: (q.host || r.host || null)
        },
        probe: {},                       // probeId → { passedAll, anyHardFail, reason }
        evidence: { calibration_batch: null, contract_matrix_run: null },
        n: 0,
        last_tested: null
      });
    }
    const g = groups.get(key);
    g.n += 1;

    const id = q.tier;
    const passed = q.passed === true;
    const isCatastrophic = CATASTROPHIC.has(id);
    // Explicit flag wins; otherwise a catastrophic miss is a hard-fail by rule.
    const hardFail = typeof r.k_hardfail === 'boolean'
      ? r.k_hardfail
      : (isCatastrophic && !passed);

    if (!g.probe[id]) g.probe[id] = { passedAll: true, anyHardFail: false, reason: null };
    const slot = g.probe[id];
    // Worst-case collapse: passed only if passed on every run.
    slot.passedAll = slot.passedAll && passed;
    slot.anyHardFail = slot.anyHardFail || hardFail;
    // Keep the first failing reason for explainability; else the latest reason.
    if (!passed && !slot.reason && q.reason) slot.reason = q.reason;
    else if (slot.reason == null && q.reason) slot.reason = q.reason;

    if (r.batch_id && !g.evidence.calibration_batch) g.evidence.calibration_batch = String(r.batch_id);
    if (r.contract_matrix_run && !g.evidence.contract_matrix_run) g.evidence.contract_matrix_run = String(r.contract_matrix_run);

    const ts = r.timestamp ? new Date(r.timestamp).getTime() : null;
    if (ts && (!g.last_tested || ts > g.last_tested)) g.last_tested = ts;
  }

  return Array.from(groups.values()).map((g) => {
    const seen = Object.keys(g.probe).sort();
    const passed = seen.filter((id) => g.probe[id].passedAll);
    const hardFailed = seen.filter((id) => g.probe[id].anyHardFail && CATASTROPHIC.has(id));
    const per_probe = {};
    for (const id of seen) {
      per_probe[id] = {
        passed: g.probe[id].passedAll,
        hardFail: g.probe[id].anyHardFail && CATASTROPHIC.has(id),
        reason: g.probe[id].reason
      };
    }
    const K = seen.length ? Number((passed.length / seen.length).toFixed(4)) : null;
    const k1_k2_hardfail = hardFailed.length > 0;
    const meets_floor = !k1_k2_hardfail && typeof K === 'number' && K >= K_FLOOR;

    return {
      unit: g.unit,
      K,
      k1_k2_hardfail,
      meets_floor,
      per_probe,
      probes_seen: seen,
      probes_passed: passed,
      probes_hardfailed: hardFailed,
      evidence: g.evidence,
      n: g.n,
      last_tested: g.last_tested ? new Date(g.last_tested).toISOString() : null
    };
  });
}

module.exports = { aggregateCalibration, unitKey, isKTier, K_PROBES, CATASTROPHIC, K_FLOOR };

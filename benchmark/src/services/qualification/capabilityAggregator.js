'use strict';

/**
 * capabilityAggregator — pure reducer over capability-tagged rows (task 0296).
 *
 * Groups tagged BenchmarkResult-shaped rows by the frozen qualification unit
 * (model × agent × task_class × host) and returns the highest capability tier
 * earned per unit, plus evidence pointers — matching the dispatch_qualification
 * historical schema (docs/_archive/2026-06/dispatch-qualification-schema.md §3).
 *
 * PURE: no DB. The caller reads BenchmarkResult rows and enriches each with the
 * run's `agent` and `task_class` (which the contract matrix knows from --agent);
 * this function only decides. Rows without `qualification.tier` are ignored.
 */

const TIER_RANK = Object.freeze({ C0: 0, C1: 1, C2: 2, C3: 3, C4: 4 });

function tierRank(t) {
  if (t == null) return -1;
  return Object.prototype.hasOwnProperty.call(TIER_RANK, t) ? TIER_RANK[t] : -1;
}

function unitKey(r) {
  const host = (r.qualification && r.qualification.host) || r.host || '';
  return [r.model || '', r.agent || '', r.task_class || '', host].join('||');
}

/**
 * @param {Array<Object>} rows  capability-tagged rows (plain objects)
 * @returns {Array<Object>} one record per unit: { unit, capability_tier,
 *   passed_tiers, ceiling, evidence, n, last_tested }
 */
function aggregateCapability(rows = []) {
  const groups = new Map();

  for (const r of rows) {
    const q = r && r.qualification;
    if (!q || !q.tier) continue; // only capability-tagged rows count

    const key = unitKey(r);
    if (!groups.has(key)) {
      groups.set(key, {
        unit: {
          model: r.model || null,
          agent: r.agent || null,
          task_class: r.task_class || null,
          host: (q.host || r.host || null)
        },
        capability_tier: null,           // highest PASSED tier
        ceiling: null,                   // highest tier seen at all (pass or fail)
        passed_tiers: new Set(),
        evidence: { capability_batch: null, contract_matrix_run: null },
        n: 0,
        last_tested: null
      });
    }
    const g = groups.get(key);
    g.n += 1;

    if (q.passed && tierRank(q.tier) > tierRank(g.capability_tier)) g.capability_tier = q.tier;
    if (tierRank(q.tier) > tierRank(g.ceiling)) g.ceiling = q.tier;
    if (q.passed) g.passed_tiers.add(q.tier);

    if (r.batch_id && !g.evidence.capability_batch) g.evidence.capability_batch = String(r.batch_id);
    if (r.contract_matrix_run && !g.evidence.contract_matrix_run) g.evidence.contract_matrix_run = String(r.contract_matrix_run);

    const ts = r.timestamp ? new Date(r.timestamp).getTime() : null;
    if (ts && (!g.last_tested || ts > g.last_tested)) g.last_tested = ts;
  }

  return Array.from(groups.values()).map((g) => ({
    unit: g.unit,
    capability_tier: g.capability_tier,
    ceiling: g.ceiling,
    passed_tiers: Array.from(g.passed_tiers).sort((a, b) => tierRank(a) - tierRank(b)),
    evidence: g.evidence,
    n: g.n,
    last_tested: g.last_tested ? new Date(g.last_tested).toISOString() : null
  }));
}

module.exports = { aggregateCapability, unitKey, tierRank, TIER_RANK };

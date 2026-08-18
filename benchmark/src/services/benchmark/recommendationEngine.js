'use strict';

/**
 * Lane recommendation engine (Backlog A + B4 per-lane weights).
 *
 * Turns per-lane benchmark candidate metrics into a ratification-ready routing
 * diff: rank candidates with LANE-SPECIFIC weights, compare the winner to the
 * current incumbent, and gate any promotion behind margin / latency /
 * reliability guards. Pure + deterministic — it consumes already-computed
 * metrics and NEVER mutates routing truth (applying a promotion stays a human
 * step, per the master plan). Judge-lane selection is intentionally out of
 * scope (it uses calibration ρ/MAE, not these dimensions).
 *
 * Candidate metric shape (all optional except `model`):
 *   { model, host?, quality?, composite?, latencyMs?, tokensPerSec?, failures?, vramMiB? }
 */

// B4 — per-lane weight vectors over normalized dimensions. Dimensions:
//   quality (benchmark quality), speed (tok/s or inverse latency),
//   reliability (fewer failures), fit (lower VRAM — utility/fully-resident lanes).
const LANE_WEIGHTS = {
  daily:       { quality: 0.35, speed: 0.45, reliability: 0.20 },
  lightweight: { quality: 0.35, speed: 0.35, reliability: 0.30 },
  utility:     { quality: 0.25, speed: 0.35, reliability: 0.20, fit: 0.20 },
  generalist:  { quality: 0.55, speed: 0.20, reliability: 0.25 },
  deep:        { quality: 0.65, speed: 0.10, reliability: 0.25 }
};
// Aliases for convenience.
LANE_WEIGHTS.master_brain = LANE_WEIGHTS.generalist;
LANE_WEIGHTS.deep_reflection = LANE_WEIGHTS.deep;

const DEFAULT_GUARDS = {
  minCompositeMargin: 2,   // challenger composite must beat incumbent by ≥ this
  maxLatencyRatio: 1.5,    // challenger latency ≤ incumbent × this
  requireZeroFailures: true
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function err(message, code = 400) {
  const e = new Error(message);
  e.statusCode = code;
  return e;
}

// Normalize only Ollama's implicit :latest alias; namespaces are identity.
function normModel(name) {
  return String(name || '').trim().toLowerCase().replace(/:latest$/, '');
}
function sameModel(a, b) {
  return normModel(a) === normModel(b);
}

// Higher-is-better raw extractors (lower-is-better dims are negated).
const DIMENSION_GETTERS = {
  quality: (c) => num(c.quality) ?? num(c.composite),
  speed: (c) => {
    const tps = num(c.tokensPerSec);
    if (tps != null) return tps;
    const lat = num(c.latencyMs);
    return lat != null ? -lat : null;
  },
  reliability: (c) => -(num(c.failures) || 0),
  fit: (c) => {
    const v = num(c.vramMiB);
    return v != null ? -v : null;
  }
};

function minMaxNormalize(values) {
  const present = values.filter((v) => v != null);
  if (!present.length) return values.map(() => 0.5);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max === min) return values.map((v) => (v == null ? 0.5 : 0.5));
  return values.map((v) => (v == null ? 0.5 : (v - min) / (max - min)));
}

/**
 * Score candidates with a lane weight vector. Returns candidates annotated with
 * `laneScore` (0–100) and the per-dimension normalized values, sorted desc.
 */
function scoreCandidates(candidates, weights) {
  // Active dims = weighted dims where at least one candidate has data.
  const activeDims = Object.keys(weights).filter((d) =>
    candidates.some((c) => DIMENSION_GETTERS[d] && DIMENSION_GETTERS[d](c) != null)
  );
  const weightSum = activeDims.reduce((s, d) => s + weights[d], 0) || 1;

  const normByDim = {};
  for (const d of activeDims) {
    normByDim[d] = minMaxNormalize(candidates.map((c) => DIMENSION_GETTERS[d](c)));
  }

  return candidates
    .map((c, i) => {
      const dimScores = {};
      let score = 0;
      for (const d of activeDims) {
        const n = normByDim[d][i];
        dimScores[d] = Number(n.toFixed(4));
        score += (weights[d] / weightSum) * n;
      }
      return { ...c, laneScore: Number((score * 100).toFixed(2)), dimScores };
    })
    .sort((a, b) => b.laneScore - a.laneScore);
}

function evaluateGuards(winner, incumbentMetrics, guards) {
  const g = { ...DEFAULT_GUARDS, ...(guards || {}) };
  const results = {};

  const wComposite = num(winner.composite);
  const iComposite = incumbentMetrics ? num(incumbentMetrics.composite) : null;
  const margin = wComposite != null && iComposite != null ? Number((wComposite - iComposite).toFixed(2)) : null;
  results.compositeMargin = {
    value: margin,
    threshold: g.minCompositeMargin,
    pass: margin == null ? true : margin >= g.minCompositeMargin
  };

  let latencyPass = true;
  let ratio = null;
  const wLat = num(winner.latencyMs);
  const iLat = incumbentMetrics ? num(incumbentMetrics.latencyMs) : null;
  if (wLat != null && iLat != null) {
    ratio = Number((wLat / Math.max(1, iLat)).toFixed(3));
    latencyPass = ratio <= g.maxLatencyRatio;
  }
  results.latency = { ratio, threshold: g.maxLatencyRatio, pass: latencyPass };

  const failures = num(winner.failures) || 0;
  results.reliability = { failures, pass: g.requireZeroFailures ? failures === 0 : true };

  return { pass: Object.values(results).every((r) => r.pass), results, applied: g };
}

function formatRecommendation(rec) {
  const head = `lane ${rec.lane}${rec.host ? ` on ${rec.host}` : ''}:`;
  if (rec.recommendation === 'keep' && sameModel(rec.winner, rec.incumbent)) {
    return `${head} keep ${rec.incumbent} (top-ranked, laneScore ${rec.winnerScore})`;
  }
  const margin = rec.guards?.results?.compositeMargin?.value;
  const verdict = rec.recommendation.toUpperCase();
  const arrow = `${rec.incumbent || '(none)'} -> ${rec.winner}`;
  const bits = [];
  if (margin != null) bits.push(`composite ${margin >= 0 ? '+' : ''}${margin}`);
  if (rec.guards?.results?.latency?.ratio != null) bits.push(`latency ×${rec.guards.results.latency.ratio}`);
  bits.push(`failures ${rec.guards?.results?.reliability?.failures ?? 0}`);
  return `${head} ${arrow}: ${bits.join(', ')} => ${verdict}`;
}

/**
 * Build a lane recommendation.
 * @param {object} input
 * @param {string} input.lane
 * @param {Array}  input.candidates - candidate metric objects
 * @param {string} [input.incumbent] - currently-routed model for this lane
 * @param {string} [input.host]
 * @param {object} [input.weights] - override LANE_WEIGHTS[lane]
 * @param {object} [input.guards]  - override DEFAULT_GUARDS
 * @returns {object} { lane, host, winner, winnerScore, incumbent, incumbentBenchmarked,
 *                     recommendation: 'promote'|'keep'|'inconclusive', ranked, guards, reasons, summary }
 */
function buildLaneRecommendation(input = {}) {
  const { lane, candidates, incumbent = null, host = null } = input;
  if (!lane) throw err('lane is required');
  if (!Array.isArray(candidates) || candidates.length === 0) throw err('candidates[] is required');
  const weights = input.weights || LANE_WEIGHTS[lane];
  if (!weights) throw err(`unknown lane '${lane}' and no weights provided`);

  const ranked = scoreCandidates(candidates, weights);
  const winner = ranked[0];
  const incumbentMetrics = incumbent ? candidates.find((c) => sameModel(c.model, incumbent)) : null;
  const incumbentBenchmarked = !!incumbentMetrics;

  const reasons = [];
  let recommendation;
  let guards = null;

  if (incumbent && sameModel(winner.model, incumbent)) {
    recommendation = 'keep';
    reasons.push('incumbent is the top-ranked model for this lane');
  } else {
    guards = evaluateGuards(winner, incumbentMetrics, input.guards);
    if (!incumbent) {
      recommendation = 'promote';
      reasons.push('no incumbent configured — top-ranked candidate recommended');
    } else if (!incumbentBenchmarked) {
      recommendation = 'inconclusive';
      reasons.push('incumbent is not in the candidate set — no head-to-head comparison');
    } else if (guards.pass) {
      recommendation = 'promote';
      reasons.push('challenger wins lane score and clears all guards');
    } else {
      recommendation = 'keep';
      const failed = Object.entries(guards.results).filter(([, r]) => !r.pass).map(([k]) => k);
      reasons.push(`challenger wins lane score but failed guard(s): ${failed.join(', ')}`);
    }
  }

  const result = {
    lane,
    host,
    winner: winner.model,
    winnerScore: winner.laneScore,
    incumbent,
    incumbentBenchmarked,
    recommendation,
    ranked,
    guards,
    reasons
  };
  result.summary = formatRecommendation(result);
  return result;
}

function metricsFor(rec, model) {
  return (rec.ranked || []).find((c) => sameModel(c.model, model)) || null;
}

/**
 * Render a recommendation as a Self-Tuning Ledger entry (report-every-change).
 * The engine fills the EVIDENCE side (verdict, diff, guards) automatically; the
 * apply side (Validation/Health/Smoke/Rollback/Target) is left as `_pending_`
 * placeholders for the actuator (the Self-Tuning Lane) to fill after applying,
 * or can be supplied via `opts`. Never applies anything — pure string.
 *
 * @param {object} rec - buildLaneRecommendation output
 * @param {object} [opts] - { date, actor, target, backup, evidenceRefs[],
 *                            extraChanges[], validation, health, smoke, rollback, untouched, host }
 * @returns {string} markdown ledger entry
 */
function formatLedgerEntry(rec, opts = {}) {
  const date = opts.date || 'YYYY-MM-DD';
  const actor = opts.actor || 'Self-Tuning Lane, human-directed';
  const host = rec.host || opts.host || null;
  const hostStr = host ? ` on ${host}` : '';
  const pend = (v, hint) => v || `_pending — ${hint}_`;
  const refs = opts.evidenceRefs?.length ? ` Refs: ${opts.evidenceRefs.join(', ')}.` : '';

  const g = rec.guards?.results || {};
  const margin = g.compositeMargin?.value;
  const ratio = g.latency?.ratio;
  const failures = g.reliability?.failures ?? 0;
  const w = metricsFor(rec, rec.winner);
  const inc = rec.incumbent ? metricsFor(rec, rec.incumbent) : null;

  const lines = [];
  if (rec.recommendation === 'promote') {
    lines.push(`## ${date} — ${rec.lane} lane${hostStr}: ${rec.incumbent || '(none)'} → ${rec.winner}`);
    lines.push('');
    lines.push(`- **Actor:** ${actor}`);
    lines.push(`- **Target:** ${pend(opts.target, 'routing key for this lane (environment or model registry)')}${opts.backup ? ` · backup: ${opts.backup}` : ''}`);
    const ev = [
      `${rec.lane} sweep`,
      w ? `\`${rec.winner}\` composite **${w.composite}**` : `winner \`${rec.winner}\``,
      inc ? `vs incumbent \`${rec.incumbent}\` **${inc.composite}**` : (rec.incumbent ? `vs incumbent \`${rec.incumbent}\`` : 'no incumbent'),
      margin != null ? `(${margin >= 0 ? '+' : ''}${margin})` : null,
      `laneScore ${rec.winnerScore}`,
      ratio != null ? `latency ×${ratio}` : null,
      `failures ${failures}`
    ].filter(Boolean).join(' — ');
    lines.push(`- **Evidence:** ${ev}.${refs}`);
    lines.push(`- **Changes:**`);
    lines.push(`  - lane \`${rec.lane}\`${host ? ` on \`${host}\`` : ''}: \`${rec.incumbent || '(none)'}\` → \`${rec.winner}\``);
    for (const c of opts.extraChanges || []) lines.push(`  - ${c}`);
    lines.push(`- **Validation:** ${pend(opts.validation, 'config re-parsed/valid before write')}`);
    lines.push(`- **Health:** ${pend(opts.health, 'service restarted + healthy')}`);
    lines.push(`- **Smoke:** ${pend(opts.smoke, 'routed request returns the expected model')}`);
    lines.push(`- **Rollback:** ${pend(opts.rollback, 'keep a backup before applying')}`);
    lines.push(`- **Guards:** margin ${g.compositeMargin?.pass ? 'pass' : 'FAIL'}, latency ${g.latency?.pass ? 'pass' : 'FAIL'}, reliability ${g.reliability?.pass ? 'pass' : 'FAIL'}.`);
    if (opts.untouched) lines.push(`- **Untouched / noted:** ${opts.untouched}`);
  } else {
    lines.push(`## ${date} — ${rec.lane} lane${hostStr}: ${rec.recommendation} (no change)`);
    lines.push('');
    lines.push(`- **Actor:** ${actor}`);
    lines.push(`- **Decision:** ${rec.recommendation} — ${rec.reasons.join('; ')}`);
    lines.push(`- **Evidence:** winner \`${rec.winner}\` laneScore ${rec.winnerScore}; incumbent \`${rec.incumbent || '(none)'}\`.${refs}`);
    lines.push(`- **Changes:** none — incumbent retained`);
  }
  return lines.join('\n');
}

module.exports = {
  LANE_WEIGHTS,
  DEFAULT_GUARDS,
  buildLaneRecommendation,
  formatRecommendation,
  formatLedgerEntry,
  _internal: { scoreCandidates, evaluateGuards, sameModel, minMaxNormalize, metricsFor }
};

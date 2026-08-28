'use strict';

/**
 * Lane recommendation engine with per-lane weights.
 *
 * Turns per-lane benchmark candidate metrics into a ratification-ready routing
 * diff: rank candidates with LANE-SPECIFIC weights, compare the winner to the
 * current incumbent, and gate any promotion behind margin / latency /
 * reliability guards. Pure + deterministic — it consumes already-computed
 * metrics and NEVER mutates routing truth (applying a promotion stays a human
 * step). Judge-lane selection is intentionally out of scope (it uses
 * calibration ρ/MAE, not these dimensions).
 *
 * Candidate metric shape (`model` is a required unique string; supplied
 * metrics are strict, domain-validated numbers; promotion also requires
 * `composite`, `latencyMs`, and `failures` for winner and incumbent):
 *   { model, host?, quality?, composite?, latencyMs?, tokensPerSec?, failures?, vramMiB? }
 */

// Per-lane weight vectors over normalized dimensions. Dimensions:
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
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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

const DIMENSION_SOURCES = {
  quality: [
    { metric: 'quality', direction: 1 },
    { metric: 'composite', direction: 1 }
  ],
  speed: [
    { metric: 'tokensPerSec', direction: 1 },
    { metric: 'latencyMs', direction: -1 }
  ],
  reliability: [{ metric: 'failures', direction: -1 }],
  fit: [{ metric: 'vramMiB', direction: -1 }]
};

const METRIC_RULES = {
  quality: { valid: (v) => v >= 0 && v <= 10, description: 'between 0 and 10' },
  composite: { valid: (v) => v >= 0 && v <= 100, description: 'between 0 and 100' },
  latencyMs: { valid: (v) => v > 0, description: 'greater than 0' },
  tokensPerSec: { valid: (v) => v >= 0, description: 'at least 0' },
  failures: { valid: (v) => Number.isInteger(v) && v >= 0, description: 'a non-negative integer' },
  vramMiB: { valid: (v) => v >= 0, description: 'at least 0' }
};

const WEIGHT_KEYS = new Set(Object.keys(DIMENSION_SOURCES));
const GUARD_KEYS = new Set(Object.keys(DEFAULT_GUARDS));
const LEDGER_KEYS = new Set([
  'date', 'actor', 'target', 'backup', 'evidenceRefs', 'extraChanges',
  'validation', 'health', 'smoke', 'rollback', 'untouched', 'host'
]);
const LEDGER_STRING_KEYS = [
  'date', 'actor', 'target', 'backup', 'validation', 'health',
  'smoke', 'rollback', 'untouched', 'host'
];

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateCandidates(candidates) {
  const seen = new Map();
  return candidates.map((candidate, index) => {
    if (!isPlainObject(candidate)) throw err(`candidates[${index}] must be an object`);
    if (typeof candidate.model !== 'string' || !candidate.model.trim()) {
      throw err(`candidates[${index}].model is required and must be a nonempty string`);
    }
    const clean = { ...candidate, model: candidate.model.trim() };
    if (/\s/.test(clean.model)) throw err(`candidates[${index}].model must not contain whitespace`);
    const identity = normModel(clean.model);
    if (!identity) throw err(`candidates[${index}].model must contain a valid model identity`);
    if (seen.has(identity)) {
      throw err(`candidates[${index}].model duplicates candidates[${seen.get(identity)}].model after normalization`);
    }
    seen.set(identity, index);

    for (const [field, rule] of Object.entries(METRIC_RULES)) {
      const value = clean[field];
      if (value == null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || !rule.valid(value)) {
        throw err(`candidates[${index}].${field} must be a finite number ${rule.description}`);
      }
    }
    return clean;
  });
}

function validateWeights(weights) {
  if (!isPlainObject(weights)) throw err('weights must be an object');
  const entries = Object.entries(weights);
  if (!entries.length) throw err('weights must define at least one dimension');
  for (const [dimension, value] of entries) {
    if (!WEIGHT_KEYS.has(dimension)) throw err(`weights contains unknown dimension '${dimension}'`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw err(`weights.${dimension} must be a finite number between 0 and 1`);
    }
  }
  const sum = entries.reduce((total, [, value]) => total + value, 0);
  if (Math.abs(sum - 1) > 1e-6) throw err(`weights must sum to 1 (received ${sum})`);
  return { ...weights };
}

function validateGuards(guards) {
  if (guards != null && !isPlainObject(guards)) throw err('guards must be an object');
  for (const key of Object.keys(guards || {})) {
    if (!GUARD_KEYS.has(key)) throw err(`guards contains unknown field '${key}'`);
  }
  const applied = { ...DEFAULT_GUARDS, ...(guards || {}) };
  if (typeof applied.minCompositeMargin !== 'number'
      || !Number.isFinite(applied.minCompositeMargin)
      || applied.minCompositeMargin < 0
      || applied.minCompositeMargin > 100) {
    throw err('guards.minCompositeMargin must be a finite number between 0 and 100');
  }
  if (typeof applied.maxLatencyRatio !== 'number'
      || !Number.isFinite(applied.maxLatencyRatio)
      || applied.maxLatencyRatio <= 0) {
    throw err('guards.maxLatencyRatio must be a finite number greater than 0');
  }
  if (typeof applied.requireZeroFailures !== 'boolean') {
    throw err('guards.requireZeroFailures must be a boolean');
  }
  return applied;
}

function validateLedgerOptions(opts) {
  if (!isPlainObject(opts)) throw err('ledger must be an object');
  for (const key of Object.keys(opts)) {
    if (!LEDGER_KEYS.has(key)) throw err(`ledger contains unknown field '${key}'`);
  }
  for (const key of LEDGER_STRING_KEYS) {
    if (opts[key] != null && typeof opts[key] !== 'string') {
      throw err(`ledger.${key} must be a string`);
    }
  }
  for (const key of ['evidenceRefs', 'extraChanges']) {
    if (opts[key] == null) continue;
    if (!Array.isArray(opts[key]) || opts[key].some((value) => typeof value !== 'string')) {
      throw err(`ledger.${key} must be an array of strings`);
    }
  }
  return opts;
}

/**
 * Pick one comparable metric basis for every positively weighted dimension.
 * A fallback is selected only when it is present for the entire cohort; values
 * from different units are never compared row-by-row.
 */
function resolveDimensionPlan(candidates, weights) {
  const getters = {};
  const metricBasis = {};
  const missingDimensions = [];
  for (const [dimension, weight] of Object.entries(weights)) {
    if (weight <= 0) continue;
    const source = DIMENSION_SOURCES[dimension].find(({ metric }) =>
      candidates.every((candidate) => num(candidate[metric]) != null)
    );
    if (!source) {
      missingDimensions.push(dimension);
      continue;
    }
    metricBasis[dimension] = source.metric;
    getters[dimension] = (candidate) => source.direction * num(candidate[source.metric]);
  }
  return { getters, metricBasis, missingDimensions };
}

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
function scoreCandidates(candidates, weights, dimensionPlan = resolveDimensionPlan(candidates, weights)) {
  const activeDims = Object.keys(dimensionPlan.getters);
  const weightSum = activeDims.reduce((s, d) => s + weights[d], 0) || 1;

  const normByDim = {};
  for (const d of activeDims) {
    normByDim[d] = minMaxNormalize(candidates.map((c) => dimensionPlan.getters[d](c)));
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
    .sort((a, b) => b.laneScore - a.laneScore || compareModelIdentity(a.model, b.model));
}

function compareModelIdentity(a, b) {
  const left = normModel(a);
  const right = normModel(b);
  return left < right ? -1 : (left > right ? 1 : 0);
}

function evaluateGuards(winner, incumbentMetrics, guards) {
  const g = validateGuards(guards);
  const results = {};

  const wComposite = num(winner.composite);
  const iComposite = incumbentMetrics ? num(incumbentMetrics.composite) : null;
  const rawMargin = wComposite != null && iComposite != null ? wComposite - iComposite : null;
  results.compositeMargin = {
    value: rawMargin,
    threshold: g.minCompositeMargin,
    pass: rawMargin != null && rawMargin >= g.minCompositeMargin
  };

  let rawRatio = null;
  const wLat = num(winner.latencyMs);
  const iLat = incumbentMetrics ? num(incumbentMetrics.latencyMs) : null;
  if (wLat != null && iLat != null) {
    const derivedRatio = wLat / iLat;
    rawRatio = Number.isFinite(derivedRatio) ? derivedRatio : null;
  }
  results.latency = { ratio: rawRatio, threshold: g.maxLatencyRatio, pass: rawRatio != null && rawRatio <= g.maxLatencyRatio };

  const failures = num(winner.failures);
  results.reliability = {
    failures,
    pass: failures != null && (g.requireZeroFailures ? failures === 0 : true)
  };

  return { pass: Object.values(results).every((r) => r.pass), results, applied: g };
}

function formatGuardNumber(value, threshold, pass, comparison) {
  if (value == null) return null;
  for (let digits = 2; digits <= 15; digits++) {
    const rounded = Number(value.toFixed(digits));
    const roundedPass = comparison === 'min' ? rounded >= threshold : rounded <= threshold;
    if (roundedPass === pass) return String(rounded);
  }
  return String(value);
}

function formatRecommendation(rec) {
  const head = `lane ${rec.lane}${rec.host ? ` on ${rec.host}` : ''}:`;
  if (rec.recommendation === 'keep' && !rec.guards && rec.scoring?.topTiedModels?.length > 1) {
    return `${head} keep ${rec.incumbent} (${rec.reasons.join('; ')})`;
  }
  if (rec.recommendation === 'keep' && sameModel(rec.winner, rec.incumbent)) {
    return `${head} keep ${rec.incumbent} (top-ranked, laneScore ${rec.winnerScore})`;
  }
  if (rec.recommendation === 'keep' && !rec.guards) {
    return `${head} keep ${rec.incumbent} (${rec.reasons.join('; ')})`;
  }
  if (rec.recommendation === 'inconclusive') {
    const arrow = `${rec.incumbent || '(none)'} -> ${rec.winner}`;
    return `${head} ${arrow}: INCONCLUSIVE (${rec.reasons.join('; ')})`;
  }
  const margin = rec.guards?.results?.compositeMargin?.value;
  const verdict = rec.recommendation.toUpperCase();
  const arrow = `${rec.incumbent || '(none)'} -> ${rec.winner}`;
  const bits = [];
  if (margin != null) {
    const guard = rec.guards.results.compositeMargin;
    bits.push(`composite ${margin >= 0 ? '+' : ''}${formatGuardNumber(margin, guard.threshold, guard.pass, 'min')}`);
  }
  if (rec.guards?.results?.latency?.ratio != null) {
    const guard = rec.guards.results.latency;
    bits.push(`latency ×${formatGuardNumber(guard.ratio, guard.threshold, guard.pass, 'max')}`);
  }
  const failures = rec.guards?.results?.reliability?.failures;
  if (failures != null) bits.push(`failures ${failures}`);
  return `${head} ${arrow}: ${bits.join(', ')} => ${verdict}`;
}

function missingPromotionEvidence(candidate) {
  return ['composite', 'latencyMs', 'failures'].filter((field) => num(candidate?.[field]) == null);
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
  if (!isPlainObject(input)) throw err('recommendation input must be an object');
  if (typeof input.lane !== 'string' || !input.lane.trim()) throw err('lane is required and must be a nonempty string');
  const lane = input.lane.trim();
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) throw err('candidates[] is required');
  const candidates = validateCandidates(input.candidates);
  const hasIncumbent = input.incumbent !== undefined && input.incumbent !== null;
  if (hasIncumbent && (typeof input.incumbent !== 'string' || !input.incumbent.trim())) {
    throw err('incumbent must be a nonempty string when provided');
  }
  if (input.host != null && (typeof input.host !== 'string' || !input.host.trim())) {
    throw err('host must be a nonempty string when provided');
  }
  const incumbent = hasIncumbent ? input.incumbent.trim() : null;
  if (incumbent && !normModel(incumbent)) throw err('incumbent must contain a valid model identity');
  if (incumbent && /\s/.test(incumbent)) throw err('incumbent must not contain whitespace');
  const host = input.host == null ? null : input.host.trim();
  const requestedWeights = input.weights == null ? LANE_WEIGHTS[lane] : input.weights;
  if (!requestedWeights) throw err(`unknown lane '${lane}' and no weights provided`);
  const weights = validateWeights(requestedWeights);
  const appliedGuards = validateGuards(input.guards);
  const dimensionPlan = resolveDimensionPlan(candidates, weights);

  const ranked = scoreCandidates(candidates, weights, dimensionPlan);
  const winner = ranked[0];
  const incumbentMetrics = incumbent ? candidates.find((c) => sameModel(c.model, incumbent)) : null;
  const incumbentRanked = incumbent ? ranked.find((c) => sameModel(c.model, incumbent)) : null;
  const incumbentBenchmarked = !!incumbentMetrics;
  const topTiedModels = ranked
    .filter((candidate) => candidate.laneScore === winner.laneScore)
    .map((candidate) => candidate.model);
  const laneScoreMargin = incumbentRanked
    ? Number((winner.laneScore - incumbentRanked.laneScore).toFixed(2))
    : null;

  const reasons = [];
  let recommendation;
  let guards = null;

  if (!incumbent) {
    recommendation = 'inconclusive';
    reasons.push('no incumbent configured — promotion requires an explicit head-to-head comparison');
  } else if (!incumbentBenchmarked) {
    recommendation = 'inconclusive';
    reasons.push('incumbent is not in the candidate set — no head-to-head comparison');
  } else if (topTiedModels.length > 1) {
    const incumbentSharesTop = topTiedModels.some((model) => sameModel(model, incumbent));
    recommendation = incumbentSharesTop ? 'keep' : 'inconclusive';
    reasons.push(incumbentSharesTop
      ? 'incumbent shares the top lane score — no challenger has a strict lead'
      : `top lane score is tied across ${topTiedModels.join(', ')} — no deterministic winner`);
  } else if (sameModel(winner.model, incumbent)) {
    recommendation = 'keep';
    reasons.push('incumbent is the top-ranked model for this lane');
  } else {
    guards = evaluateGuards(winner, incumbentMetrics, appliedGuards);
    const missing = [
      ...missingPromotionEvidence(winner).map((field) => `winner.${field}`),
      ...missingPromotionEvidence(incumbentMetrics).map((field) => `incumbent.${field}`)
    ];
    if (laneScoreMargin == null || laneScoreMargin <= 0) {
      recommendation = 'keep';
      reasons.push('challenger does not have a strict lane-score lead over the incumbent');
    } else if (missing.length) {
      recommendation = 'inconclusive';
      reasons.push(`promotion evidence is incomplete: missing ${missing.join(', ')}`);
    } else if (dimensionPlan.missingDimensions.length) {
      recommendation = 'inconclusive';
      reasons.push(`scoring evidence is incomplete for weighted dimension(s): ${dimensionPlan.missingDimensions.join(', ')}`);
    } else if (guards.pass) {
      recommendation = 'promote';
      reasons.push('challenger has a strict lane-score lead and clears all guards');
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
    scoring: {
      metricBasis: dimensionPlan.metricBasis,
      missingDimensions: dimensionPlan.missingDimensions,
      topTiedModels,
      laneScoreMargin
    },
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
 * Render a recommendation as an operator ledger entry (report-every-change).
 * The engine fills the EVIDENCE side (verdict, diff, guards) automatically; the
 * apply side (Validation/Health/Smoke/Rollback/Target) is left as `_pending_`
 * placeholders for the operator to fill after applying,
 * or can be supplied via `opts`. Never applies anything — pure string.
 *
 * @param {object} rec - buildLaneRecommendation output
 * @param {object} [opts] - { date, actor, target, backup, evidenceRefs[],
 *                            extraChanges[], validation, health, smoke, rollback, untouched, host }
 * @returns {string} markdown ledger entry
 */
function formatLedgerEntry(rec, opts = {}) {
  validateLedgerOptions(opts);
  const date = opts.date || 'YYYY-MM-DD';
  const actor = opts.actor || 'Operator, human-directed';
  const host = rec.host || opts.host || null;
  const hostStr = host ? ` on ${host}` : '';
  const pend = (v, hint) => v || `_pending — ${hint}_`;
  const refs = opts.evidenceRefs?.length ? ` Refs: ${opts.evidenceRefs.join(', ')}.` : '';

  const g = rec.guards?.results || {};
  const margin = g.compositeMargin?.value;
  const ratio = g.latency?.ratio;
  const failures = g.reliability?.failures ?? 'missing';
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
      margin != null
        ? `(${margin >= 0 ? '+' : ''}${formatGuardNumber(margin, g.compositeMargin.threshold, g.compositeMargin.pass, 'min')})`
        : null,
      `laneScore ${rec.winnerScore}`,
      ratio != null ? `latency ×${formatGuardNumber(ratio, g.latency.threshold, g.latency.pass, 'max')}` : null,
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
    lines.push(`- **Changes:** none — ${rec.incumbent ? 'incumbent retained' : 'no promotion proposed'}`);
  }
  return lines.join('\n');
}

module.exports = {
  LANE_WEIGHTS,
  DEFAULT_GUARDS,
  buildLaneRecommendation,
  formatRecommendation,
  formatLedgerEntry,
  _internal: {
    scoreCandidates,
    evaluateGuards,
    sameModel,
    minMaxNormalize,
    metricsFor,
    missingPromotionEvidence,
    resolveDimensionPlan,
    validateCandidates,
    validateWeights,
    validateGuards,
    validateLedgerOptions,
    compareModelIdentity,
    formatGuardNumber
  }
};

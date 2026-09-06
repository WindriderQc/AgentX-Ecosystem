'use strict';

/**
 * Signal Evidence Contract v1.
 *
 * One portable shape for every "number with a meaning" that Agent X renders:
 * a rate, an average, a count, a delta, or a ranking. The contract exists so
 * that the same phenomenon is never rendered as a measured zero on one page
 * and as "no data" on another, and so that a percentage can never be built on
 * an empty denominator, a "Best" badge on a single candidate, or a "fresh"
 * label on a source that carries no timestamp.
 *
 * The module is dependency-free CommonJS so Core routes, Benchmark, RAG and
 * the browser bundle (`core/src/frontend/signal-evidence.js` via esbuild) all
 * consume the exact same implementation.
 *
 * Invariants enforced here (see docs/SIGNAL_EVIDENCE_CONTRACT_V1.md):
 * - a value of 0 is `observed` only when it was measured on a real sample or
 *   as a census count; a zero without a sample becomes `missing`;
 * - an empty denominator never yields a ratio;
 * - a ranking names a best candidate only when at least two comparable
 *   candidates exist and the leader is not tied;
 * - freshness is `unknown` when no observation timestamp exists, never `fresh`;
 * - `stale` keeps the last value aside instead of presenting it as current;
 * - drill-down links are relative paths only, so a public projection cannot
 *   leak a private origin.
 */

const SIGNAL_EVIDENCE_SCHEMA = 'agentx.signal-evidence.v1';

const SIGNAL_STATES = Object.freeze({
  OBSERVED: 'observed',
  INSUFFICIENT_SAMPLE: 'insufficient_sample',
  MISSING: 'missing',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
  DISABLED: 'disabled',
  NOT_APPLICABLE: 'not_applicable',
  PARTIAL: 'partial',
  CONTRADICTED: 'contradicted',
});

const SIGNAL_STATE_SET = new Set(Object.values(SIGNAL_STATES));

/** States whose `value` is a real measurement the UI may print. */
const VALUE_BEARING_STATES = new Set([
  SIGNAL_STATES.OBSERVED,
  SIGNAL_STATES.INSUFFICIENT_SAMPLE,
  SIGNAL_STATES.PARTIAL,
  SIGNAL_STATES.CONTRADICTED,
]);

const FRESHNESS_STATES = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable',
});

const COMPARISON_STATES = Object.freeze({
  RANKED: 'ranked',
  TIED: 'tied',
  NO_COMPARATOR: 'no_comparator',
  NOT_COMPARABLE: 'not_comparable',
});

const SIGNAL_KINDS = Object.freeze({
  COUNT: 'count',
  RATIO: 'ratio',
  AVERAGE: 'average',
  DIFFERENCE: 'difference',
  RANKING: 'ranking',
  MEASURE: 'measure',
});

/**
 * Human wording per state. Aligned with docs/UX_DOCTRINE.md: unknown evidence
 * is labelled `Not observed`, never converted to green or to a zero.
 */
const SIGNAL_LABELS = Object.freeze({
  [SIGNAL_STATES.OBSERVED]: null,
  [SIGNAL_STATES.INSUFFICIENT_SAMPLE]: 'Low sample',
  [SIGNAL_STATES.MISSING]: 'Not observed',
  [SIGNAL_STATES.STALE]: 'Stale',
  [SIGNAL_STATES.UNAVAILABLE]: 'Unavailable',
  [SIGNAL_STATES.DISABLED]: 'Disabled',
  [SIGNAL_STATES.NOT_APPLICABLE]: 'Not applicable',
  [SIGNAL_STATES.PARTIAL]: 'Partial',
  [SIGNAL_STATES.CONTRADICTED]: 'Contradicted',
});

/** Doctrine tone per state: ready (green), attention (amber), unknown (gray). */
const SIGNAL_TONES = Object.freeze({
  [SIGNAL_STATES.OBSERVED]: 'ready',
  [SIGNAL_STATES.INSUFFICIENT_SAMPLE]: 'attention',
  [SIGNAL_STATES.STALE]: 'attention',
  [SIGNAL_STATES.PARTIAL]: 'attention',
  [SIGNAL_STATES.CONTRADICTED]: 'attention',
  [SIGNAL_STATES.MISSING]: 'unknown',
  [SIGNAL_STATES.UNAVAILABLE]: 'unknown',
  [SIGNAL_STATES.DISABLED]: 'unknown',
  [SIGNAL_STATES.NOT_APPLICABLE]: 'unknown',
});

const PLACEHOLDER = '—'; // em dash: the one glyph every surface uses for "no value"

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const RELATIVE_PATH_PATTERN = /^\/(?!\/)[^\s]*$/;
const ABSOLUTE_LOCATION_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toIso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Freshness is derived only from real timestamps. No timestamp means the
 * freshness is unknown; it is never assumed fresh.
 */
function freshnessOf({ observedAt, ingestedAt, ttlMs, now = Date.now(), applicable = true } = {}) {
  const observedIso = toIso(observedAt);
  const ingestedIso = toIso(ingestedAt);
  const ttl = isFiniteNumber(ttlMs) && ttlMs > 0 ? ttlMs : null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  if (!applicable) {
    return { state: FRESHNESS_STATES.NOT_APPLICABLE, observedAt: observedIso, ingestedAt: ingestedIso, ttlMs: ttl, ageMs: null };
  }
  if (!observedIso) {
    return { state: FRESHNESS_STATES.UNKNOWN, observedAt: null, ingestedAt: ingestedIso, ttlMs: ttl, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - new Date(observedIso).getTime());
  const state = ttl == null
    ? FRESHNESS_STATES.UNKNOWN
    : (ageMs > ttl ? FRESHNESS_STATES.STALE : FRESHNESS_STATES.FRESH);
  return { state, observedAt: observedIso, ingestedAt: ingestedIso, ttlMs: ttl, ageMs };
}

function normalizeSample(sample) {
  const source = sample && typeof sample === 'object' ? sample : {};
  const n = nonNegativeInteger(source.n);
  const numerator = isFiniteNumber(source.numerator) ? source.numerator : null;
  const denominator = isFiniteNumber(source.denominator) ? source.denominator : null;
  const minimum = nonNegativeInteger(source.minimum);
  return {
    n: n == null ? (denominator != null && Number.isInteger(denominator) ? denominator : 0) : n,
    numerator,
    denominator,
    minimum: minimum == null ? 1 : minimum,
  };
}

function normalizeContributors(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .map((entry) => ({
      id: entry.id,
      state: SIGNAL_STATE_SET.has(entry.state) ? entry.state : SIGNAL_STATES.MISSING,
      ...(entry.detail ? { detail: String(entry.detail) } : {}),
    }));
}

function normalizeContradictions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.signalId === 'string')
    .map((entry) => ({
      signalId: entry.signalId,
      ...(entry.source ? { source: String(entry.source) } : {}),
      ...(entry.detail ? { detail: String(entry.detail) } : {}),
    }));
}

/**
 * Normalize a producer payload into a v1 signal. Throws on an invalid
 * producer contract so that a wrong producer fails in its own tests rather
 * than rendering a misleading tile.
 */
function buildSignal(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('signal input must be an object');
  const id = String(input.id || '');
  if (!ID_PATTERN.test(id)) throw new TypeError(`signal id "${id}" must match ${ID_PATTERN}`);

  let state = SIGNAL_STATE_SET.has(input.state) ? input.state : null;
  if (!state) throw new TypeError(`signal "${id}" has unknown state "${input.state}"`);

  const kind = Object.values(SIGNAL_KINDS).includes(input.kind) ? input.kind : SIGNAL_KINDS.MEASURE;
  const sample = normalizeSample(input.sample);
  let value = isFiniteNumber(input.value) ? input.value : null;
  let lastValue = isFiniteNumber(input.lastValue) ? input.lastValue : null;
  let reason = input.reason ? String(input.reason) : null;
  let detail = input.detail ? String(input.detail) : null;

  // Zero is only a measurement when something was actually sampled or counted.
  const census = kind === SIGNAL_KINDS.COUNT || input.basis === 'census';
  if (VALUE_BEARING_STATES.has(state) && value === 0 && !census && !(sample.n > 0)) {
    state = SIGNAL_STATES.MISSING;
    reason = reason || 'zero_without_sample';
    value = null;
  }

  // A value-bearing state with no value is a producer bug; downgrade honestly.
  if (VALUE_BEARING_STATES.has(state) && value == null) {
    state = SIGNAL_STATES.MISSING;
    reason = reason || 'value_missing';
  }

  // Non value-bearing states never carry a printable value.
  if (!VALUE_BEARING_STATES.has(state) && value != null) {
    if (state === SIGNAL_STATES.STALE) lastValue = lastValue == null ? value : lastValue;
    value = null;
  }

  const freshness = freshnessOf({
    observedAt: input.observedAt,
    ingestedAt: input.ingestedAt,
    ttlMs: input.ttlMs,
    now,
    applicable: input.freshnessApplicable !== false,
  });

  // A stale observation stops being "current": keep the number aside.
  if (VALUE_BEARING_STATES.has(state) && freshness.state === FRESHNESS_STATES.STALE) {
    lastValue = value;
    value = null;
    state = SIGNAL_STATES.STALE;
    reason = reason || 'ttl_exceeded';
  }

  const drilldown = typeof input.drilldown === 'string' && RELATIVE_PATH_PATTERN.test(input.drilldown)
    ? input.drilldown
    : null;

  const signal = {
    schema: SIGNAL_EVIDENCE_SCHEMA,
    id,
    kind,
    scope: input.scope == null ? null : input.scope,
    unit: input.unit ? String(input.unit) : null,
    state,
    value,
    lastValue,
    sample,
    freshness,
    source: input.source ? String(input.source) : null,
    reason,
    detail,
    drilldown,
    contributors: normalizeContributors(input.contributors),
    contradictions: normalizeContradictions(input.contradictions),
    comparison: input.comparison && typeof input.comparison === 'object' ? input.comparison : null,
  };

  if (signal.contradictions.length && VALUE_BEARING_STATES.has(signal.state)) {
    signal.state = SIGNAL_STATES.CONTRADICTED;
    signal.reason = signal.reason || 'surfaces_disagree';
  }

  const validation = validateSignal(signal);
  if (!validation.ok) throw new TypeError(`signal "${id}" is invalid: ${validation.errors.join('; ')}`);
  return signal;
}

/** Census count: the whole population was enumerated, so 0 is a measurement. */
function countSignal({ id, value, ...rest }) {
  const count = nonNegativeInteger(value);
  if (count == null) {
    return buildSignal({ ...rest, id, kind: SIGNAL_KINDS.COUNT, state: SIGNAL_STATES.UNAVAILABLE, reason: rest.reason || 'count_unavailable' });
  }
  return buildSignal({ ...rest, id, kind: SIGNAL_KINDS.COUNT, state: SIGNAL_STATES.OBSERVED, value: count, sample: { n: count, ...(rest.sample || {}) } });
}

/**
 * Ratio: numerator / denominator. Empty denominator -> missing. Denominator
 * below `minimum` -> insufficient_sample with the value still attached so the
 * UI can print it beside an explicit warning and its n.
 */
function ratioSignal({ id, numerator, denominator, minimum = 1, unit = 'percent', ...rest }) {
  const denom = isFiniteNumber(denominator) ? denominator : null;
  const num = isFiniteNumber(numerator) ? numerator : null;
  const base = { ...rest, id, kind: SIGNAL_KINDS.RATIO, unit };
  if (denom == null || num == null) {
    return buildSignal({ ...base, state: SIGNAL_STATES.UNAVAILABLE, reason: rest.reason || 'ratio_inputs_unavailable', sample: { n: 0, minimum } });
  }
  if (denom <= 0) {
    return buildSignal({ ...base, state: SIGNAL_STATES.MISSING, reason: rest.reason || 'empty_denominator', sample: { n: 0, numerator: num, denominator: denom, minimum } });
  }
  const ratio = num / denom;
  const value = unit === 'percent' ? ratio * 100 : ratio;
  const n = Number.isInteger(denom) ? denom : Math.floor(denom);
  const state = n < minimum ? SIGNAL_STATES.INSUFFICIENT_SAMPLE : SIGNAL_STATES.OBSERVED;
  return buildSignal({
    ...base,
    state,
    value,
    reason: state === SIGNAL_STATES.INSUFFICIENT_SAMPLE ? (rest.reason || 'below_minimum_sample') : rest.reason,
    sample: { n, numerator: num, denominator: denom, minimum },
  });
}

/** Average: sum / count. Zero observations -> missing, never 0. */
function averageSignal({ id, sum, count, minimum = 1, unit = null, ...rest }) {
  const n = nonNegativeInteger(count);
  const total = isFiniteNumber(sum) ? sum : null;
  const base = { ...rest, id, kind: SIGNAL_KINDS.AVERAGE, unit };
  if (n == null || total == null) {
    return buildSignal({ ...base, state: SIGNAL_STATES.UNAVAILABLE, reason: rest.reason || 'average_inputs_unavailable', sample: { n: 0, minimum } });
  }
  if (n === 0) {
    return buildSignal({ ...base, state: SIGNAL_STATES.MISSING, reason: rest.reason || 'no_observations', sample: { n: 0, minimum } });
  }
  const state = n < minimum ? SIGNAL_STATES.INSUFFICIENT_SAMPLE : SIGNAL_STATES.OBSERVED;
  return buildSignal({
    ...base,
    state,
    value: total / n,
    reason: state === SIGNAL_STATES.INSUFFICIENT_SAMPLE ? (rest.reason || 'below_minimum_sample') : rest.reason,
    sample: { n, numerator: total, denominator: n, minimum },
  });
}

/**
 * Difference between two cohort signals (left - right). Both cohorts must
 * carry a value; otherwise the delta is missing with the reason and both
 * contributors listed, instead of "+0.0".
 */
function differenceSignal({ id, left, right, unit = null, ...rest }) {
  const contributors = [left, right]
    .filter(Boolean)
    .map((signal) => ({ id: signal.id, state: signal.state, ...(signal.reason ? { detail: signal.reason } : {}) }));
  const base = { ...rest, id, kind: SIGNAL_KINDS.DIFFERENCE, unit: unit || left?.unit || right?.unit || null, contributors };
  const bothMeasured = left && right && left.value != null && right.value != null;
  if (!bothMeasured) {
    return buildSignal({ ...base, state: SIGNAL_STATES.MISSING, reason: rest.reason || 'needs_both_cohorts', sample: { n: 0 } });
  }
  const n = Math.min(left.sample?.n ?? 0, right.sample?.n ?? 0);
  const minimum = Math.max(left.sample?.minimum ?? 1, right.sample?.minimum ?? 1);
  const insufficient = left.state === SIGNAL_STATES.INSUFFICIENT_SAMPLE || right.state === SIGNAL_STATES.INSUFFICIENT_SAMPLE;
  return buildSignal({
    ...base,
    state: insufficient ? SIGNAL_STATES.INSUFFICIENT_SAMPLE : SIGNAL_STATES.OBSERVED,
    value: left.value - right.value,
    reason: insufficient ? (rest.reason || 'below_minimum_sample') : rest.reason,
    sample: { n, minimum },
  });
}

/**
 * Ranking over candidates. A candidate is comparable only when its value is
 * finite and the producer did not mark it otherwise. A single best is named
 * only with at least `minimumCandidates` comparable entries and no tie at
 * the top.
 */
function rankingSignal({ id, candidates, direction = 'asc', minimumCandidates = 2, unit = null, ...rest }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const normalized = list
    .filter((candidate) => candidate && typeof candidate === 'object' && candidate.key != null)
    .map((candidate) => {
      const value = isFiniteNumber(candidate.value) ? candidate.value : null;
      const comparable = candidate.comparable === undefined ? value != null : Boolean(candidate.comparable) && value != null;
      return { key: String(candidate.key), value, comparable, reason: candidate.reason ? String(candidate.reason) : null };
    });
  const comparable = normalized.filter((candidate) => candidate.comparable);
  const sorted = [...comparable].sort((a, b) => (direction === 'desc' ? b.value - a.value : a.value - b.value));
  const ranks = new Map(sorted.map((candidate, index) => [candidate.key, index + 1]));
  const ranked = normalized.map((candidate) => ({
    key: candidate.key,
    value: candidate.value,
    comparable: candidate.comparable,
    rank: candidate.comparable ? ranks.get(candidate.key) : null,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
  }));

  let comparisonState;
  let best = null;
  if (comparable.length === 0) comparisonState = COMPARISON_STATES.NOT_COMPARABLE;
  else if (comparable.length < minimumCandidates) comparisonState = COMPARISON_STATES.NO_COMPARATOR;
  else if (sorted[0].value === sorted[1].value) comparisonState = COMPARISON_STATES.TIED;
  else { comparisonState = COMPARISON_STATES.RANKED; best = sorted[0].key; }

  const comparison = { state: comparisonState, direction, best, comparable: comparable.length, of: normalized.length, minimumCandidates, ranked };
  const base = { ...rest, id, kind: SIGNAL_KINDS.RANKING, unit, comparison, sample: { n: comparable.length, minimum: minimumCandidates } };

  if (comparisonState === COMPARISON_STATES.NOT_COMPARABLE) {
    return buildSignal({ ...base, state: normalized.length ? SIGNAL_STATES.NOT_APPLICABLE : SIGNAL_STATES.MISSING, reason: rest.reason || (normalized.length ? 'no_comparable_candidate' : 'no_candidates') });
  }
  if (comparisonState === COMPARISON_STATES.NO_COMPARATOR) {
    return buildSignal({ ...base, state: SIGNAL_STATES.INSUFFICIENT_SAMPLE, value: sorted[0].value, reason: rest.reason || 'single_comparable_candidate' });
  }
  return buildSignal({ ...base, state: SIGNAL_STATES.OBSERVED, value: sorted[0].value, reason: comparisonState === COMPARISON_STATES.TIED ? (rest.reason || 'tied_leaders') : rest.reason });
}

function isValueBearing(signal) {
  return Boolean(signal) && VALUE_BEARING_STATES.has(signal.state) && isFiniteNumber(signal.value);
}

/** Validation used by producers, contract tests and server-side ingestion. */
function validateSignal(signal) {
  const errors = [];
  if (!signal || typeof signal !== 'object') return { ok: false, errors: ['signal must be an object'] };
  if (signal.schema !== SIGNAL_EVIDENCE_SCHEMA) errors.push(`schema must be ${SIGNAL_EVIDENCE_SCHEMA}`);
  if (!ID_PATTERN.test(String(signal.id || ''))) errors.push('id must be a stable lowercase identifier');
  if (!SIGNAL_STATE_SET.has(signal.state)) errors.push(`state "${signal.state}" is not a contract state`);
  if (VALUE_BEARING_STATES.has(signal.state) && !isFiniteNumber(signal.value)) errors.push(`state ${signal.state} requires a finite value`);
  if (!VALUE_BEARING_STATES.has(signal.state) && signal.value != null) errors.push(`state ${signal.state} must not carry a value`);
  if (signal.lastValue != null && !isFiniteNumber(signal.lastValue)) errors.push('lastValue must be finite when present');
  const sample = signal.sample || {};
  if (nonNegativeInteger(sample.n) == null) errors.push('sample.n must be a non-negative integer');
  if (nonNegativeInteger(sample.minimum) == null) errors.push('sample.minimum must be a non-negative integer');
  if (signal.state === SIGNAL_STATES.OBSERVED && signal.kind !== SIGNAL_KINDS.COUNT && signal.value === 0 && !(sample.n > 0)) {
    errors.push('a zero is observed only on a real sample');
  }
  if (signal.state === SIGNAL_STATES.OBSERVED && signal.kind === SIGNAL_KINDS.RATIO && !(sample.denominator > 0)) {
    errors.push('an observed ratio needs a positive denominator');
  }
  const freshness = signal.freshness || {};
  if (!Object.values(FRESHNESS_STATES).includes(freshness.state)) errors.push('freshness.state is not a contract state');
  if (freshness.state === FRESHNESS_STATES.FRESH && !freshness.observedAt) errors.push('fresh evidence needs an observedAt timestamp');
  if (signal.drilldown != null && !RELATIVE_PATH_PATTERN.test(signal.drilldown)) errors.push('drilldown must be a relative path');
  for (const field of ['detail', 'reason', 'source']) {
    if (signal[field] && ABSOLUTE_LOCATION_PATTERN.test(signal[field])) errors.push(`${field} must not carry an absolute location`);
  }
  if (signal.comparison && signal.comparison.state === COMPARISON_STATES.RANKED && !signal.comparison.best) {
    errors.push('a ranked comparison must name its best candidate');
  }
  if (signal.comparison && signal.comparison.best && signal.comparison.state !== COMPARISON_STATES.RANKED) {
    errors.push('only a ranked comparison may name a best candidate');
  }
  return { ok: errors.length === 0, errors };
}

/** Stable, JSON-safe projection with a fixed key order. */
function serializeSignal(signal) {
  return {
    schema: signal.schema,
    id: signal.id,
    kind: signal.kind,
    scope: signal.scope ?? null,
    unit: signal.unit ?? null,
    state: signal.state,
    value: signal.value ?? null,
    lastValue: signal.lastValue ?? null,
    sample: {
      n: signal.sample?.n ?? 0,
      numerator: signal.sample?.numerator ?? null,
      denominator: signal.sample?.denominator ?? null,
      minimum: signal.sample?.minimum ?? 1,
    },
    freshness: {
      state: signal.freshness?.state ?? FRESHNESS_STATES.UNKNOWN,
      observedAt: signal.freshness?.observedAt ?? null,
      ingestedAt: signal.freshness?.ingestedAt ?? null,
      ttlMs: signal.freshness?.ttlMs ?? null,
      ageMs: signal.freshness?.ageMs ?? null,
    },
    source: signal.source ?? null,
    reason: signal.reason ?? null,
    detail: signal.detail ?? null,
    drilldown: signal.drilldown ?? null,
    contributors: Array.isArray(signal.contributors) ? signal.contributors : [],
    contradictions: Array.isArray(signal.contradictions) ? signal.contradictions : [],
    comparison: signal.comparison ?? null,
  };
}

/** Accept a serialized signal from the wire; returns null when it is not a valid v1 signal. */
function parseSignal(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const validation = validateSignal(candidate);
  return validation.ok ? candidate : null;
}

function describeSample(signal) {
  const sample = signal?.sample || {};
  if (!(sample.n > 0)) return 'n=0';
  const minimum = sample.minimum > 1 && sample.n < sample.minimum ? ` of ${sample.minimum} needed` : '';
  return `n=${sample.n}${minimum}`;
}

function defaultFormatValue(value, unit) {
  if (!isFiniteNumber(value)) return PLACEHOLDER;
  switch (unit) {
    case 'percent': return `${value.toFixed(1)}%`;
    case 'points': return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pts`;
    case 'ms': return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
    case 'usd': return `$${value.toFixed(value < 0.01 && value > 0 ? 4 : 2)}`;
    case 'count': return Math.round(value).toLocaleString('en-US');
    default: return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

/**
 * Deterministic rendering projection. Every surface that prints a signal
 * goes through this so the same state always yields the same text, label,
 * tone and sample note. `text` is the printable value or the placeholder.
 */
function formatSignal(signal, { formatValue = defaultFormatValue } = {}) {
  if (!signal || !SIGNAL_STATE_SET.has(signal.state)) {
    return { text: PLACEHOLDER, label: SIGNAL_LABELS.missing, tone: SIGNAL_TONES.missing, state: SIGNAL_STATES.MISSING, detail: 'Not observed', sample: 'n=0', drilldown: null };
  }
  const state = signal.state;
  const printable = isValueBearing(signal);
  const text = printable ? formatValue(signal.value, signal.unit) : PLACEHOLDER;
  const sample = describeSample(signal);
  const reasonText = signal.detail || (signal.reason ? signal.reason.replace(/_/g, ' ') : null);
  let detail;
  switch (state) {
    case SIGNAL_STATES.OBSERVED: detail = reasonText || sample; break;
    case SIGNAL_STATES.INSUFFICIENT_SAMPLE: detail = `Low sample (${sample})${reasonText && signal.detail ? ` · ${reasonText}` : ''}`; break;
    case SIGNAL_STATES.STALE: detail = `Stale${signal.lastValue != null ? ` · last ${formatValue(signal.lastValue, signal.unit)}` : ''}${signal.freshness?.observedAt ? ` at ${signal.freshness.observedAt}` : ''}`; break;
    case SIGNAL_STATES.MISSING: detail = reasonText ? `Not observed · ${reasonText}` : 'Not observed'; break;
    default: detail = reasonText ? `${SIGNAL_LABELS[state]} · ${reasonText}` : SIGNAL_LABELS[state];
  }
  return {
    text,
    label: SIGNAL_LABELS[state],
    tone: SIGNAL_TONES[state],
    state,
    detail,
    sample,
    drilldown: signal.drilldown || null,
  };
}

module.exports = {
  SIGNAL_EVIDENCE_SCHEMA,
  SIGNAL_STATES,
  SIGNAL_KINDS,
  SIGNAL_LABELS,
  SIGNAL_TONES,
  FRESHNESS_STATES,
  COMPARISON_STATES,
  PLACEHOLDER,
  buildSignal,
  countSignal,
  ratioSignal,
  averageSignal,
  differenceSignal,
  rankingSignal,
  freshnessOf,
  validateSignal,
  serializeSignal,
  parseSignal,
  formatSignal,
  describeSample,
  isValueBearing,
};

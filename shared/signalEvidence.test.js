'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SIGNAL_EVIDENCE_SCHEMA,
  SIGNAL_STATES,
  SIGNAL_LABELS,
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
} = require('./signalEvidence');

const NOW = new Date('2026-09-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

test('a measured zero on a real sample stays observed and prints 0', () => {
  const signal = ratioSignal({ id: 'test.error_rate', numerator: 0, denominator: 100, unit: 'percent' });
  assert.equal(signal.state, SIGNAL_STATES.OBSERVED);
  assert.equal(signal.value, 0);
  assert.equal(formatSignal(signal).text, '0.0%');
  assert.equal(formatSignal(signal).label, null);
});

test('a census count of zero is a measurement, not an absence', () => {
  const signal = countSignal({ id: 'test.calls', value: 0 });
  assert.equal(signal.state, SIGNAL_STATES.OBSERVED);
  assert.equal(formatSignal(signal).text, '0');
});

test('a zero without any sample is missing and never printed as 0', () => {
  const signal = buildSignal({ id: 'test.avg_ms', state: SIGNAL_STATES.OBSERVED, value: 0, unit: 'ms', sample: { n: 0 } });
  assert.equal(signal.state, SIGNAL_STATES.MISSING);
  assert.equal(signal.reason, 'zero_without_sample');
  assert.equal(signal.value, null);
  const view = formatSignal(signal);
  assert.equal(view.text, PLACEHOLDER);
  assert.equal(view.label, 'Not observed');
  assert.equal(view.tone, 'unknown');
});

test('an empty denominator never becomes a percentage', () => {
  const signal = ratioSignal({ id: 'test.adoption', numerator: 0, denominator: 0, unit: 'percent' });
  assert.equal(signal.state, SIGNAL_STATES.MISSING);
  assert.equal(signal.reason, 'empty_denominator');
  assert.equal(signal.value, null);
  assert.equal(formatSignal(signal).text, PLACEHOLDER);
});

test('a ratio below the minimum sample keeps its value but is flagged with its n', () => {
  const signal = ratioSignal({ id: 'test.adoption', numerator: 1, denominator: 1, minimum: 5, unit: 'percent' });
  assert.equal(signal.state, SIGNAL_STATES.INSUFFICIENT_SAMPLE);
  assert.equal(signal.value, 100);
  const view = formatSignal(signal);
  assert.equal(view.text, '100.0%');
  assert.equal(view.label, 'Low sample');
  assert.equal(view.sample, 'n=1 of 5 needed');
  assert.equal(view.tone, 'attention');
});

test('an average over zero observations is missing, not 0ms', () => {
  const signal = averageSignal({ id: 'test.avg_classification_ms', sum: 0, count: 0, unit: 'ms' });
  assert.equal(signal.state, SIGNAL_STATES.MISSING);
  assert.equal(signal.reason, 'no_observations');
  assert.equal(formatSignal(signal).text, PLACEHOLDER);
  const observed = averageSignal({ id: 'test.avg_classification_ms', sum: 400, count: 2, unit: 'ms' });
  assert.equal(observed.state, SIGNAL_STATES.OBSERVED);
  assert.equal(formatSignal(observed).text, '200ms');
});

test('a difference needs both cohorts; otherwise it is missing rather than +0.0', () => {
  const rag = ratioSignal({ id: 'test.rag_positive', numerator: 0, denominator: 0, unit: 'percent' });
  const noRag = ratioSignal({ id: 'test.norag_positive', numerator: 0, denominator: 0, unit: 'percent' });
  const delta = differenceSignal({ id: 'test.rag_delta', left: rag, right: noRag, unit: 'points' });
  assert.equal(delta.state, SIGNAL_STATES.MISSING);
  assert.equal(delta.reason, 'needs_both_cohorts');
  assert.deepEqual(delta.contributors.map((c) => c.state), [SIGNAL_STATES.MISSING, SIGNAL_STATES.MISSING]);
  assert.equal(formatSignal(delta).text, PLACEHOLDER);

  const left = ratioSignal({ id: 'test.rag_positive', numerator: 8, denominator: 10, minimum: 5, unit: 'percent' });
  const right = ratioSignal({ id: 'test.norag_positive', numerator: 6, denominator: 10, minimum: 5, unit: 'percent' });
  const measured = differenceSignal({ id: 'test.rag_delta', left, right, unit: 'points' });
  assert.equal(measured.state, SIGNAL_STATES.OBSERVED);
  assert.equal(formatSignal(measured).text, '+20.0 pts');

  const thin = differenceSignal({
    id: 'test.rag_delta',
    left: ratioSignal({ id: 'a', numerator: 1, denominator: 1, minimum: 5, unit: 'percent' }),
    right,
    unit: 'points',
  });
  assert.equal(thin.state, SIGNAL_STATES.INSUFFICIENT_SAMPLE);
});

test('a ranking names a best candidate only with two comparable entries and no tie', () => {
  const single = rankingSignal({ id: 'test.cost_rank', candidates: [{ key: 'local', value: 0, comparable: false }] });
  assert.equal(single.state, SIGNAL_STATES.NOT_APPLICABLE);
  assert.equal(single.comparison.state, COMPARISON_STATES.NOT_COMPARABLE);
  assert.equal(single.comparison.best, null);

  const lonely = rankingSignal({ id: 'test.cost_rank', candidates: [{ key: 'gpt', value: 0.02 }, { key: 'local', value: 0, comparable: false }] });
  assert.equal(lonely.state, SIGNAL_STATES.INSUFFICIENT_SAMPLE);
  assert.equal(lonely.comparison.state, COMPARISON_STATES.NO_COMPARATOR);
  assert.equal(lonely.comparison.best, null);
  assert.equal(lonely.comparison.ranked.find((r) => r.key === 'local').rank, null);

  const tied = rankingSignal({ id: 'test.cost_rank', candidates: [{ key: 'a', value: 0.02 }, { key: 'b', value: 0.02 }] });
  assert.equal(tied.comparison.state, COMPARISON_STATES.TIED);
  assert.equal(tied.comparison.best, null);

  const ranked = rankingSignal({ id: 'test.cost_rank', candidates: [{ key: 'a', value: 0.03 }, { key: 'b', value: 0.01 }, { key: 'c', value: 0.02 }] });
  assert.equal(ranked.state, SIGNAL_STATES.OBSERVED);
  assert.equal(ranked.comparison.state, COMPARISON_STATES.RANKED);
  assert.equal(ranked.comparison.best, 'b');
  assert.deepEqual(ranked.comparison.ranked.map((r) => [r.key, r.rank]), [['a', 3], ['b', 1], ['c', 2]]);

  const empty = rankingSignal({ id: 'test.cost_rank', candidates: [] });
  assert.equal(empty.state, SIGNAL_STATES.MISSING);
});

test('freshness is unknown without a timestamp and never fresh by default', () => {
  assert.equal(freshnessOf({ ttlMs: HOUR, now: NOW }).state, FRESHNESS_STATES.UNKNOWN);
  assert.equal(freshnessOf({ observedAt: NOW, now: NOW }).state, FRESHNESS_STATES.UNKNOWN);
  assert.equal(freshnessOf({ observedAt: NOW, ttlMs: HOUR, now: NOW }).state, FRESHNESS_STATES.FRESH);
  assert.equal(freshnessOf({ observedAt: new Date(NOW.getTime() - 2 * HOUR), ttlMs: HOUR, now: NOW }).state, FRESHNESS_STATES.STALE);
  assert.equal(freshnessOf({ observedAt: 'not a date', ttlMs: HOUR, now: NOW }).state, FRESHNESS_STATES.UNKNOWN);
  assert.equal(freshnessOf({ observedAt: NOW, ttlMs: HOUR, now: NOW, applicable: false }).state, FRESHNESS_STATES.NOT_APPLICABLE);
});

test('an observation older than its TTL becomes stale and keeps its last value aside', () => {
  const signal = buildSignal({
    id: 'test.corpus_age',
    state: SIGNAL_STATES.OBSERVED,
    value: 42,
    sample: { n: 10 },
    observedAt: new Date(NOW.getTime() - 3 * HOUR),
    ttlMs: HOUR,
  }, { now: NOW });
  assert.equal(signal.state, SIGNAL_STATES.STALE);
  assert.equal(signal.value, null);
  assert.equal(signal.lastValue, 42);
  assert.equal(signal.freshness.state, FRESHNESS_STATES.STALE);
  const view = formatSignal(signal);
  assert.equal(view.text, PLACEHOLDER);
  assert.equal(view.label, 'Stale');
  assert.match(view.detail, /last 42/);
});

test('unavailable, disabled and not-applicable sources carry no value and a neutral tone', () => {
  for (const state of [SIGNAL_STATES.UNAVAILABLE, SIGNAL_STATES.DISABLED, SIGNAL_STATES.NOT_APPLICABLE]) {
    const signal = buildSignal({ id: 'test.source', state, value: 12, reason: 'collector_off' });
    assert.equal(signal.value, null, state);
    const view = formatSignal(signal);
    assert.equal(view.text, PLACEHOLDER);
    assert.equal(view.label, SIGNAL_LABELS[state]);
    assert.equal(view.tone, 'unknown');
    assert.match(view.detail, /collector off/);
  }
});

test('a degraded contributor is visible on a partial parent and never turns it green', () => {
  const signal = buildSignal({
    id: 'test.fleet_health',
    state: SIGNAL_STATES.PARTIAL,
    value: 2,
    sample: { n: 3 },
    contributors: [
      { id: 'host.a', state: SIGNAL_STATES.OBSERVED },
      { id: 'host.b', state: SIGNAL_STATES.UNAVAILABLE, detail: 'probe timeout' },
      { id: 'host.c', state: 'bogus' },
    ],
  });
  assert.equal(signal.state, SIGNAL_STATES.PARTIAL);
  assert.equal(formatSignal(signal).tone, 'attention');
  assert.equal(signal.contributors[1].detail, 'probe timeout');
  assert.equal(signal.contributors[2].state, SIGNAL_STATES.MISSING);
});

test('a contradiction from another surface overrides an observed value', () => {
  const signal = buildSignal({
    id: 'test.dreaming_state',
    state: SIGNAL_STATES.OBSERVED,
    value: 1,
    sample: { n: 1 },
    contradictions: [{ signalId: 'nerve.alert.memory_review_no_eligible_evidence', source: 'nerve-center', detail: 'active alert' }],
  });
  assert.equal(signal.state, SIGNAL_STATES.CONTRADICTED);
  assert.equal(signal.value, 1);
  assert.equal(formatSignal(signal).label, 'Contradicted');
});

test('validation rejects forged or unsafe producer payloads', () => {
  const good = ratioSignal({ id: 'test.ok', numerator: 1, denominator: 4, drilldown: '/api/analytics/inference/logs?status=error' });
  assert.equal(validateSignal(good).ok, true);
  assert.equal(good.drilldown, '/api/analytics/inference/logs?status=error');

  assert.throws(() => buildSignal({ id: 'Bad Id', state: 'observed', value: 1, sample: { n: 1 } }), /must match/);
  assert.throws(() => buildSignal({ id: 'test.x', state: 'green', value: 1 }), /unknown state/);

  const external = buildSignal({ id: 'test.x', state: 'observed', value: 1, sample: { n: 1 }, drilldown: 'https://192.168.2.99/secret' });
  assert.equal(external.drilldown, null);
  const protocolRelative = buildSignal({ id: 'test.x', state: 'observed', value: 1, sample: { n: 1 }, drilldown: '//evil.example/path' });
  assert.equal(protocolRelative.drilldown, null);

  assert.throws(() => buildSignal({ id: 'test.x', state: 'observed', value: 1, sample: { n: 1 }, detail: 'see http://10.0.0.1:3080/x' }), /absolute location/);

  const forged = { ...serializeSignal(good), state: 'observed', value: 0, sample: { n: 0, minimum: 1 } };
  assert.equal(validateSignal(forged).ok, false);
  assert.equal(parseSignal(forged), null);
  assert.equal(parseSignal({ ...serializeSignal(good), schema: 'other' }), null);
  assert.equal(parseSignal(serializeSignal(good))?.id, 'test.ok');
});

test('serialization is stable and round-trips through JSON', () => {
  const signal = ratioSignal({
    id: 'test.adoption',
    numerator: 3,
    denominator: 9,
    minimum: 5,
    unit: 'percent',
    scope: { window: '7d' },
    source: 'conversations',
    observedAt: NOW,
    ingestedAt: NOW,
    ttlMs: HOUR,
    now: NOW,
  });
  const wire = JSON.parse(JSON.stringify(serializeSignal(signal)));
  assert.deepEqual(Object.keys(wire), [
    'schema', 'id', 'kind', 'scope', 'unit', 'state', 'value', 'lastValue', 'sample', 'freshness',
    'source', 'reason', 'detail', 'drilldown', 'contributors', 'contradictions', 'comparison',
  ]);
  assert.equal(wire.schema, SIGNAL_EVIDENCE_SCHEMA);
  assert.equal(wire.sample.denominator, 9);
  assert.equal(wire.freshness.observedAt, NOW.toISOString());
  assert.equal(wire.freshness.ttlMs, HOUR);
  assert.deepEqual(serializeSignal(parseSignal(wire)), wire);
});

test('the rendering projection is deterministic per state', () => {
  const cases = [
    [ratioSignal({ id: 'r', numerator: 5, denominator: 10 }), '50.0%', null],
    [ratioSignal({ id: 'r', numerator: 1, denominator: 1, minimum: 5 }), '100.0%', 'Low sample'],
    [ratioSignal({ id: 'r', numerator: 0, denominator: 0 }), PLACEHOLDER, 'Not observed'],
    [buildSignal({ id: 'r', state: 'unavailable' }), PLACEHOLDER, 'Unavailable'],
    [buildSignal({ id: 'r', state: 'disabled' }), PLACEHOLDER, 'Disabled'],
    [buildSignal({ id: 'r', state: 'not_applicable' }), PLACEHOLDER, 'Not applicable'],
    [buildSignal({ id: 'r', state: 'stale', lastValue: 3 }), PLACEHOLDER, 'Stale'],
    [formatSignal(null) && null, PLACEHOLDER, 'Not observed'],
  ];
  for (const [signal, text, label] of cases) {
    const view = formatSignal(signal);
    assert.equal(view.text, text);
    assert.equal(view.label, label);
  }
});

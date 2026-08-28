'use strict';

const {
  buildLaneRecommendation,
  formatLedgerEntry,
  LANE_WEIGHTS,
  _internal
} = require('../../../src/services/benchmark/recommendationEngine');

// Real Phase 1 Host Beta lightweight sweep (batch 6a341b5a2621fbe9a0b38f00).
const LIGHTWEIGHT_CANDIDATES = [
  { model: 'ax/gemma4:e4b', composite: 82.55, quality: 8.01, tokensPerSec: 52.40, latencyMs: 2666, failures: 0 },
  { model: 'ax/qwen3.5:9b', composite: 78.29, quality: 7.67, tokensPerSec: 48.07, latencyMs: 2042, failures: 0 },
  { model: 'ax/qwen2.5:7b-instruct-q5_K_M', composite: 75.42, quality: 7.22, tokensPerSec: 55.09, latencyMs: 1552, failures: 0 },
  { model: 'ax/qwen2.5-coder:7b', composite: 74.84, quality: 7.02, tokensPerSec: 57.57, latencyMs: 1491, failures: 0 }
];

describe('buildLaneRecommendation', () => {
  it('reproduces the real lightweight promotion (qwen3.5:9b -> gemma4:e4b)', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      host: 'secondary',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/qwen3.5:9b'
    });

    expect(rec.winner).toBe('ax/gemma4:e4b');
    expect(rec.recommendation).toBe('promote');
    expect(rec.guards.results.compositeMargin.value).toBeCloseTo(4.26, 2);
    expect(rec.guards.results.compositeMargin.pass).toBe(true);
    expect(rec.guards.results.latency.pass).toBe(true);   // 2666/2042 = 1.305 ≤ 1.5
    expect(rec.guards.results.reliability.pass).toBe(true);
    expect(rec.summary).toMatch(/PROMOTE/);
  });

  it('keeps the incumbent when it is the top-ranked model', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/gemma4:e4b' // already the winner
    });
    expect(rec.recommendation).toBe('keep');
    expect(rec.summary).toMatch(/keep/);
  });

  it('blocks promotion when the challenger fails the latency guard', () => {
    const rec = buildLaneRecommendation({
      lane: 'deep',
      candidates: [
        { model: 'slow-but-good', composite: 90, quality: 9.5, latencyMs: 30000, failures: 0 },
        { model: 'incumbent', composite: 80, quality: 7.0, latencyMs: 3000, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.winner).toBe('slow-but-good');     // wins the quality-heavy deep lane
    expect(rec.recommendation).toBe('keep');       // but blocked
    expect(rec.guards.results.latency.pass).toBe(false);
    expect(rec.reasons.join(' ')).toMatch(/latency/);
  });

  it('blocks promotion when the challenger has reliability failures', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'flaky-winner', composite: 95, quality: 9, tokensPerSec: 60, latencyMs: 2000, failures: 3 },
        { model: 'steady', composite: 80, quality: 8, tokensPerSec: 50, latencyMs: 2100, failures: 0 }
      ],
      incumbent: 'steady'
    });
    expect(rec.winner).toBe('flaky-winner');
    expect(rec.recommendation).toBe('keep');
    expect(rec.guards.results.reliability.pass).toBe(false);
  });

  it('compares unrounded guard values at the decision boundary', () => {
    const margin = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 9, composite: 81.995, tokensPerSec: 60, latencyMs: 1000, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(margin.guards.results.compositeMargin.value).toBeCloseTo(1.995, 12);
    expect(margin.guards.results.compositeMargin.pass).toBe(false);
    expect(margin.recommendation).toBe('keep');

    const latency = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 60, latencyMs: 1500.4, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(latency.guards.results.latency.ratio).toBeCloseTo(1.5004, 12);
    expect(latency.guards.results.latency.pass).toBe(false);
    expect(latency.recommendation).toBe('keep');
  });

  it('reports enough raw precision to explain near-threshold guard failures', () => {
    const margin = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 9, composite: 81.999999999, tokensPerSec: 60, latencyMs: 1000, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(margin.guards.results.compositeMargin.value).toBeLessThan(2);
    expect(margin.guards.results.compositeMargin.pass).toBe(false);
    expect(margin.summary).toMatch(/1\.999999999/);

    const latency = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 60, latencyMs: 1.500000000001, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: 1, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(latency.guards.results.latency.ratio).toBeGreaterThan(1.5);
    expect(latency.guards.results.latency.pass).toBe(false);
    expect(latency.summary).toMatch(/1\.500000000001/);
  });

  it('fails the latency guard cleanly when finite inputs overflow the derived ratio', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 60, latencyMs: Number.MAX_VALUE, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: Number.MIN_VALUE, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.guards.results.latency).toMatchObject({ ratio: null, pass: false });
    expect(rec.recommendation).toBe('keep');
    expect(JSON.parse(JSON.stringify(rec)).guards.results.latency.ratio).toBeNull();
  });

  it('is inconclusive when the incumbent was not benchmarked', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/some-model-not-in-the-sweep'
    });
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.incumbentBenchmarked).toBe(false);
  });

  it('is inconclusive when there is no explicit incumbent', () => {
    const rec = buildLaneRecommendation({ lane: 'lightweight', candidates: LIGHTWEIGHT_CANDIDATES });
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.winner).toBe('ax/gemma4:e4b');
    expect(rec.summary).toMatch(/INCONCLUSIVE.*no incumbent configured/);
    expect(rec.summary).not.toMatch(/failures 0/);
  });

  it('is inconclusive when head-to-head promotion evidence is incomplete', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', composite: 90, quality: 9, tokensPerSec: 60, failures: 0 },
        { model: 'incumbent', composite: 80, quality: 7, tokensPerSec: 40, latencyMs: 2500, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.winner).toBe('challenger');
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.guards.results.latency.pass).toBe(false);
    expect(rec.reasons.join(' ')).toMatch(/winner\.latencyMs/);
    expect(rec.summary).not.toMatch(/=> PROMOTE/);
  });

  it('treats missing failure counts as incomplete evidence, not zero failures', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', composite: 90, quality: 9, latencyMs: 2000 },
        { model: 'incumbent', composite: 80, quality: 7, latencyMs: 2500, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.guards.results.reliability).toEqual({ failures: null, pass: false });
    expect(rec.reasons.join(' ')).toMatch(/winner\.failures/);
  });

  it('treats null promotion fields as missing rather than numeric zero', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', composite: null, quality: 9, latencyMs: null, failures: null },
        { model: 'incumbent', composite: 80, quality: 7, latencyMs: 2500, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.winner).toBe('challenger');
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.reasons.join(' ')).toMatch(/winner\.composite/);
    expect(rec.reasons.join(' ')).toMatch(/winner\.latencyMs/);
    expect(rec.reasons.join(' ')).toMatch(/winner\.failures/);
  });

  it('requires complete incumbent evidence before recommending a promotion', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', composite: 90, quality: 9, latencyMs: 2000, failures: 0 },
        { model: 'incumbent', quality: 7, latencyMs: 2500, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.winner).toBe('challenger');
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.guards.results.compositeMargin.pass).toBe(false);
    expect(rec.reasons.join(' ')).toMatch(/incumbent\.composite/);
  });

  it('rejects candidates without a model identity', () => {
    expect(() => buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [{ composite: 90, latencyMs: 2000, failures: 0 }]
    })).toThrow(/candidates\[0\]\.model is required/);
  });

  it.each([
    [{}, /at least one dimension/],
    [{ banana: 1 }, /unknown dimension/],
    [{ quality: 0 }, /sum to 1/],
    [{ quality: '1' }, /finite number/],
    [{ quality: -1, speed: 2 }, /between 0 and 1/],
    [{ quality: 0.5, speed: 0.4 }, /sum to 1/]
  ])('rejects invalid custom weights %j', (weights, message) => {
    expect(() => buildLaneRecommendation({
      lane: 'custom',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/qwen3.5:9b',
      weights
    })).toThrow(message);
  });

  it('accepts a normalized custom weight vector with complete evidence', () => {
    const rec = buildLaneRecommendation({
      lane: 'custom',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/qwen3.5:9b',
      weights: { quality: 1 }
    });
    expect(rec.winner).toBe('ax/gemma4:e4b');
    expect(rec.recommendation).toBe('promote');
  });

  it.each([
    [{ minCompositeMargin: -1 }, /minCompositeMargin/],
    [{ minCompositeMargin: '-Infinity' }, /minCompositeMargin/],
    [{ maxLatencyRatio: 0 }, /maxLatencyRatio/],
    [{ maxLatencyRatio: Infinity }, /maxLatencyRatio/],
    [{ requireZeroFailures: 0 }, /requireZeroFailures/],
    [{ requireZeroFailures: 'false' }, /requireZeroFailures/],
    [{ typo: true }, /unknown field/]
  ])('rejects invalid guard overrides %j', (guards, message) => {
    expect(() => buildLaneRecommendation({
      lane: 'lightweight',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/qwen3.5:9b',
      guards
    })).toThrow(message);
  });

  it.each([
    ['model', 123],
    ['model', '   '],
    ['model', 'owner/model\nforged'],
    ['quality', -1],
    ['quality', 11],
    ['quality', '9'],
    ['composite', -1],
    ['composite', 101],
    ['latencyMs', 0],
    ['latencyMs', -5],
    ['latencyMs', '1000'],
    ['tokensPerSec', -1],
    ['failures', -1],
    ['failures', 0.5],
    ['vramMiB', -1]
  ])('rejects invalid candidate field %s=%p', (field, value) => {
    const candidate = {
      model: 'challenger',
      quality: 9,
      composite: 90,
      latencyMs: 1000,
      tokensPerSec: 50,
      failures: 0,
      vramMiB: 1000,
      [field]: value
    };
    expect(() => buildLaneRecommendation({ lane: 'lightweight', candidates: [candidate] }))
      .toThrow(new RegExp(`candidates\\[0\\]\\.${field}`));
  });

  it('rejects duplicate normalized model identities', () => {
    expect(() => buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'owner/model:latest', quality: 9 },
        { model: 'OWNER/MODEL', quality: 8 }
      ]
    })).toThrow(/duplicates candidates\[0\]\.model after normalization/);
  });

  it('rejects an incumbent that normalizes to an empty identity', () => {
    expect(() => buildLaneRecommendation({
      lane: 'lightweight',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: ':latest'
    })).toThrow(/incumbent must contain a valid model identity/);
  });

  it('uses one cohort-wide quality basis instead of mixing quality with composite', () => {
    const candidates = [
      { model: 'challenger', composite: 82, latencyMs: 1000, tokensPerSec: 50, failures: 0 },
      { model: 'incumbent', quality: 10, composite: 90, latencyMs: 1000, tokensPerSec: 50, failures: 0 }
    ];
    const rec = buildLaneRecommendation({ lane: 'deep', candidates, incumbent: 'incumbent' });
    expect(rec.scoring.metricBasis.quality).toBe('composite');
    expect(rec.winner).toBe('incumbent');
    expect(rec.recommendation).toBe('keep');
  });

  it('uses one cohort-wide speed basis instead of mixing throughput with latency', () => {
    const candidates = [
      { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 1, latencyMs: 1400, failures: 0 },
      { model: 'incumbent', quality: 9, composite: 80, latencyMs: 1000, failures: 0 }
    ];
    const rec = buildLaneRecommendation({ lane: 'daily', candidates, incumbent: 'incumbent' });
    expect(rec.scoring.metricBasis.speed).toBe('latencyMs');
    expect(rec.winner).toBe('incumbent');
    expect(rec.recommendation).toBe('keep');
  });

  it('is inconclusive when a positive weighted dimension lacks cohort-wide evidence', () => {
    const rec = buildLaneRecommendation({
      lane: 'utility',
      candidates: [
        { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 50, latencyMs: 1000, failures: 0, vramMiB: 1000 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 40, latencyMs: 1100, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.winner).toBe('challenger');
    expect(rec.scoring.missingDimensions).toContain('fit');
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.reasons.join(' ')).toMatch(/weighted dimension.*fit/);
  });

  it('does not require evidence for a zero-weight dimension', () => {
    const rec = buildLaneRecommendation({
      lane: 'custom',
      weights: { quality: 1, fit: 0 },
      candidates: [
        { model: 'challenger', quality: 9, composite: 90, latencyMs: 1000, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, latencyMs: 1100, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.scoring.missingDimensions).not.toContain('fit');
    expect(rec.recommendation).toBe('promote');
  });

  it('never promotes an exact lane-score tie, regardless of request order', () => {
    const challenger = { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 50, latencyMs: 1000, failures: 0 };
    const incumbent = { model: 'incumbent', quality: 9, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 };
    const forward = buildLaneRecommendation({ lane: 'lightweight', candidates: [challenger, incumbent], incumbent: 'incumbent' });
    const reversed = buildLaneRecommendation({ lane: 'lightweight', candidates: [incumbent, challenger], incumbent: 'incumbent' });
    expect(forward.recommendation).toBe('keep');
    expect(reversed.recommendation).toBe('keep');
    expect(forward.scoring.topTiedModels).toEqual(reversed.scoring.topTiedModels);
    expect(forward.reasons.join(' ')).toMatch(/strict lead/);
  });

  it('keeps the tie reason visible when the incumbent is the lexical representative', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'a-incumbent', quality: 9, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 },
        { model: 'z-challenger', quality: 9, composite: 90, tokensPerSec: 50, latencyMs: 1000, failures: 0 }
      ],
      incumbent: 'a-incumbent'
    });
    expect(rec.winner).toBe('a-incumbent');
    expect(rec.recommendation).toBe('keep');
    expect(rec.summary).toMatch(/shares the top lane score.*strict lead/);
  });

  it('is inconclusive when challengers tie above the incumbent', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger-b', quality: 9, composite: 91, tokensPerSec: 60, latencyMs: 1000, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 40, latencyMs: 1100, failures: 0 },
        { model: 'challenger-a', quality: 9, composite: 90, tokensPerSec: 60, latencyMs: 1000, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.scoring.topTiedModels).toEqual(['challenger-a', 'challenger-b']);
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.reasons.join(' ')).toMatch(/no deterministic winner/);
  });

  it('uses locale-independent tie ordering for canonically similar Unicode identities', () => {
    const composed = { model: 'owner/caf\u00e9:q', quality: 9, composite: 91, tokensPerSec: 60, latencyMs: 1000, failures: 0 };
    const decomposed = { model: 'owner/cafe\u0301:q', quality: 9, composite: 90, tokensPerSec: 60, latencyMs: 1000, failures: 0 };
    const incumbent = { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 40, latencyMs: 1100, failures: 0 };
    const forward = buildLaneRecommendation({ lane: 'lightweight', candidates: [composed, incumbent, decomposed], incumbent: 'incumbent' });
    const reversed = buildLaneRecommendation({ lane: 'lightweight', candidates: [decomposed, incumbent, composed], incumbent: 'incumbent' });
    expect(forward.ranked.map((candidate) => candidate.model)).toEqual(reversed.ranked.map((candidate) => candidate.model));
    expect(forward.scoring.topTiedModels).toEqual(reversed.scoring.topTiedModels);
    expect(forward.recommendation).toBe('inconclusive');
  });

  it('blocks a score difference that rounds to an exposed two-decimal tie', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 10, composite: 90, tokensPerSec: 50, latencyMs: 1000, failures: 0 },
        { model: 'incumbent', quality: 9.9999, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 },
        { model: 'floor', quality: 0, composite: 10, tokensPerSec: 50, latencyMs: 1000, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.ranked.find((candidate) => candidate.model === 'challenger').laneScore)
      .toBe(rec.ranked.find((candidate) => candidate.model === 'incumbent').laneScore);
    expect(rec.recommendation).toBe('keep');
    expect(rec.reasons.join(' ')).toMatch(/strict lead/);
  });

  it('uses direct sub-millisecond latency ratios and permits exact guard thresholds', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: [
        { model: 'challenger', quality: 9, composite: 82, tokensPerSec: 60, latencyMs: 0.75, failures: 0 },
        { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: 0.5, failures: 0 }
      ],
      incumbent: 'incumbent'
    });
    expect(rec.guards.results.compositeMargin).toMatchObject({ value: 2, pass: true });
    expect(rec.guards.results.latency).toMatchObject({ ratio: 1.5, pass: true });
    expect(rec.recommendation).toBe('promote');
  });

  it('lane weights change the winner (deep favors quality, daily favors speed)', () => {
    const candidates = [
      { model: 'A-quality', quality: 9, composite: 80, tokensPerSec: 20, latencyMs: 10000, failures: 0 },
      { model: 'B-speed', quality: 7, composite: 78, tokensPerSec: 100, latencyMs: 1000, failures: 0 }
    ];
    const deep = buildLaneRecommendation({ lane: 'deep', candidates });
    const daily = buildLaneRecommendation({ lane: 'daily', candidates });
    expect(deep.winner).toBe('A-quality');
    expect(daily.winner).toBe('B-speed');
  });

  it('throws on unknown lane without explicit weights', () => {
    expect(() => buildLaneRecommendation({ lane: 'nonsense', candidates: [{ model: 'x' }] }))
      .toThrow(/unknown lane/);
  });

  it('utility lane uses the fit dimension (prefers lower VRAM on a tie)', () => {
    const rec = buildLaneRecommendation({
      lane: 'utility',
      candidates: [
        { model: 'small', quality: 8, composite: 78, tokensPerSec: 30, latencyMs: 4000, failures: 0, vramMiB: 3200 },
        { model: 'big', quality: 8, composite: 78, tokensPerSec: 30, latencyMs: 4000, failures: 0, vramMiB: 11000 }
      ]
    });
    expect(rec.winner).toBe('small'); // identical except VRAM → fit weight breaks the tie
    expect(LANE_WEIGHTS.utility.fit).toBeGreaterThan(0);
  });
});

describe('formatLedgerEntry', () => {
  const promoteRec = buildLaneRecommendation({
    lane: 'lightweight',
    host: 'secondary',
    candidates: LIGHTWEIGHT_CANDIDATES,
    incumbent: 'ax/qwen3.5:9b'
  });

  it('renders a promote entry with the diff, evidence numbers, and pending apply-side', () => {
    const entry = formatLedgerEntry(promoteRec, { date: '2026-06-19', evidenceRefs: ['batch 6a341b5a'] });
    expect(entry).toMatch(/^## 2026-06-19 — lightweight lane on secondary: ax\/qwen3\.5:9b → ax\/gemma4:e4b/);
    expect(entry).toMatch(/composite \*\*82\.55\*\*/);          // winner composite
    expect(entry).toMatch(/vs incumbent `ax\/qwen3\.5:9b` \*\*78\.29\*\*/);
    expect(entry).toMatch(/\(\+4\.26\)/);                       // margin
    expect(entry).toMatch(/- \*\*Changes:\*\*/);
    expect(entry).toMatch(/Refs: batch 6a341b5a/);
    expect(entry).toMatch(/- \*\*Actor:\*\* Operator, human-directed/);
    expect(entry).not.toMatch(/Self-Tuning Lane|Claude Code/);
    expect(entry).toMatch(/Validation:.*_pending/);            // apply side left for the lane
    expect(entry).toMatch(/Guards:.*margin pass, latency pass, reliability pass/);
  });

  it('fills apply-side fields when provided', () => {
    const entry = formatLedgerEntry(promoteRec, {
      date: '2026-06-19',
      target: '.env AGENTX_LIGHTWEIGHT_MODEL',
      validation: 'config re-parsed OK',
      health: 'core healthy',
      smoke: 'routed model OK'
    });
    expect(entry).toMatch(/Target:.*AGENTX_LIGHTWEIGHT_MODEL/);
    expect(entry).toMatch(/Validation:.*config re-parsed OK/);
    expect(entry).not.toMatch(/Validation:.*_pending/);
  });

  it('rejects malformed ledger option shapes instead of throwing an unclassified error', () => {
    expect(() => formatLedgerEntry(promoteRec, { evidenceRefs: { length: 1 } }))
      .toThrow(/ledger\.evidenceRefs must be an array of strings/);
    expect(() => formatLedgerEntry(promoteRec, { unknown: true }))
      .toThrow(/ledger contains unknown field/);
  });

  it('renders a no-change entry for keep/inconclusive verdicts', () => {
    const keep = buildLaneRecommendation({ lane: 'lightweight', candidates: LIGHTWEIGHT_CANDIDATES, incumbent: 'ax/gemma4:e4b' });
    const entry = formatLedgerEntry(keep, { date: '2026-06-19' });
    expect(entry).toMatch(/keep \(no change\)/);
    expect(entry).toMatch(/Changes:\*\* none — incumbent retained/);
  });
});

describe('recommendationEngine internals', () => {
  it('sameModel preserves namespaces and normalizes only :latest', () => {
    expect(_internal.sameModel('ax/gemma4:e4b', 'gemma4:e4b')).toBe(false);
    expect(_internal.sameModel('qwen:7b:latest', 'qwen:7b')).toBe(true);
    expect(_internal.sameModel('a', 'b')).toBe(false);
  });

  it('minMaxNormalize handles all-equal and null values', () => {
    expect(_internal.minMaxNormalize([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
    const out = _internal.minMaxNormalize([0, null, 10]);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0.5);
    expect(out[2]).toBe(1);
  });
});

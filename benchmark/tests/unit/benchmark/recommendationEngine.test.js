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

  it('is inconclusive when the incumbent was not benchmarked', () => {
    const rec = buildLaneRecommendation({
      lane: 'lightweight',
      candidates: LIGHTWEIGHT_CANDIDATES,
      incumbent: 'ax/some-model-not-in-the-sweep'
    });
    expect(rec.recommendation).toBe('inconclusive');
    expect(rec.incumbentBenchmarked).toBe(false);
  });

  it('promotes the top candidate when there is no incumbent', () => {
    const rec = buildLaneRecommendation({ lane: 'lightweight', candidates: LIGHTWEIGHT_CANDIDATES });
    expect(rec.recommendation).toBe('promote');
    expect(rec.winner).toBe('ax/gemma4:e4b');
  });

  it('B4: lane weights change the winner (deep favors quality, daily favors speed)', () => {
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

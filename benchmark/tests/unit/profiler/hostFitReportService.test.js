'use strict';

/**
 * Unit tests for the Host Fit Report estimator (pure functions).
 * These cover the llmfit-style VRAM math and the throughput model that
 * self-calibrates from a host's measured profiles.
 */

const {
  measuredFitLevel,
  calibrationSet,
  buildThroughputModel,
  estTpsFromModel,
  estimateFit,
  recommendQuant,
  largestRunnableParamsB,
  pickRecommended,
  pickBestBenchmarked,
  parseActiveParams,
  isMoE,
  dimensionScores,
  compositeScore,
  median
} = require('../../../src/services/profiler/fitEstimator');

describe('hostFitReportService estimator', () => {
  describe('measuredFitLevel', () => {
    it('flags spill as crit regardless of VRAM%', () => {
      expect(measuredFitLevel({ vramPct: 50, spillDetected: true }).level).toBe('spills');
    });
    it('>90% VRAM is tight', () => {
      expect(measuredFitLevel({ vramPct: 95, spillDetected: false }).level).toBe('tight');
    });
    it('50-90% VRAM is a good fit', () => {
      expect(measuredFitLevel({ vramPct: 70, spillDetected: false }).level).toBe('good');
    });
    it('<50% VRAM is comfortable', () => {
      expect(measuredFitLevel({ vramPct: 30, spillDetected: false }).level).toBe('comfortable');
    });
    it('no VRAM% + low reliability surfaces as unverified', () => {
      expect(measuredFitLevel({ vramPct: null, spillDetected: false, reliability: 'low' }).level).toBe('unverified');
    });
  });

  describe('buildThroughputModel (self-calibration)', () => {
    it('calibrates K from measured profiles', () => {
      const measured = [
        { paramB: 7, quant: 'Q4_K_M', tokensPerSec: 50, spillVerified: true, spillDetected: false },
        { paramB: 7, quant: 'Q4_K_M', tokensPerSec: 60, spillVerified: true, spillDetected: false }
      ];
      const tm = buildThroughputModel(measured, null);
      expect(tm.source).toBe('profiles');
      expect(tm.nPoints).toBe(2);
      const est14 = estTpsFromModel(tm, 14, 'Q4_K_M');
      // ~half the throughput of a 7B at the same quant
      expect(est14).toBeGreaterThan(20);
      expect(est14).toBeLessThan(40);
    });
    it('falls back to the host baseline when no profiles', () => {
      const tm = buildThroughputModel([], { referenceModel: 'qwen2.5:3b', tokensPerSec: 180 });
      expect(tm.source).toBe('baseline');
      expect(tm.K).toBeGreaterThan(0);
    });
    it('falls back to a generic constant when nothing is known', () => {
      const tm = buildThroughputModel([], null);
      expect(tm.source).toBe('generic');
      expect(tm.K).toBe(220);
    });
    it('a faster host yields a higher estimate than a slower one', () => {
      const fast = buildThroughputModel([{ paramB: 7, quant: 'Q4_K_M', tokensPerSec: 120, spillVerified: true, spillDetected: false }], null);
      const slow = buildThroughputModel([{ paramB: 7, quant: 'Q4_K_M', tokensPerSec: 40, spillVerified: true, spillDetected: false }], null);
      expect(estTpsFromModel(fast, 14, 'Q4_K_M')).toBeGreaterThan(estTpsFromModel(slow, 14, 'Q4_K_M'));
    });
    it('excludes capacity-bound (near-full) profiles from the fit', () => {
      const withOutlier = buildThroughputModel([
        { paramB: 7, quant: 'Q4_K_M', tokensPerSec: 100, vramPct: 40, spillVerified: true, spillDetected: false },
        { paramB: 14, quant: 'Q4_K_M', tokensPerSec: 15, vramPct: 95, spillVerified: true, spillDetected: false }
      ], null);
      const cleanOnly = buildThroughputModel([
        { paramB: 7, quant: 'Q4_K_M', tokensPerSec: 100, vramPct: 40, spillVerified: true, spillDetected: false }
      ], null);
      expect(withOutlier.nPoints).toBe(1);
      expect(withOutlier.K).toBe(cleanOnly.K);
    });
  });

  describe('calibrationSet', () => {
    it('keeps clean profiles, drops spill and >85% VRAM', () => {
      const set = calibrationSet([
        { paramB: 7, tokensPerSec: 90, vramPct: 40, spillVerified: true, spillDetected: false },
        { paramB: 14, tokensPerSec: 20, vramPct: 95, spillVerified: true, spillDetected: false },
        { paramB: 32, tokensPerSec: 10, spillVerified: true, spillDetected: true }
      ]);
      expect(set.map(m => m.paramB)).toEqual([7]);
    });
    it('never calibrates from constrained or residency-unverified profiles', () => {
      const set = calibrationSet([
        { paramB: 14, tokensPerSec: 20, vramPct: 95, spillVerified: true, spillDetected: false },
        { paramB: 7, tokensPerSec: 40, vramPct: 40, spillVerified: false, spillDetected: null }
      ]);
      expect(set).toEqual([]);
    });
  });

  describe('estimateFit (llmfit-style VRAM math)', () => {
    it('marks a 14B-Q4 as not-fully-fitting on a 12GB GPU', () => {
      const r = estimateFit({ paramB: 14, quant: 'Q4_K_M', vramTotalMiB: 12288 });
      expect(['tight', 'too-large']).toContain(r.verdict);
      expect(r.estMaxCtx).toBeNull();
    });
    it('marks a 3B-Q4 as fitting comfortably on a 12GB GPU', () => {
      const r = estimateFit({ paramB: 3, quant: 'Q4_K_M', vramTotalMiB: 12288 });
      expect(r.verdict).toBe('fits');
      expect(r.estMaxCtx).toBeNull();
    });
    it('returns unknown without params or VRAM', () => {
      expect(estimateFit({ paramB: null, quant: 'Q4_K_M', vramTotalMiB: 12288 }).verdict).toBe('unknown');
    });
  });

  describe('recommendQuant', () => {
    it('returns a ladder quant or null (never throws)', () => {
      const q = recommendQuant(32, 16000, 8192);
      expect(q === null || /^Q[2-8]/.test(q)).toBe(true);
    });
  });

  describe('largestRunnableParamsB', () => {
    it('a 12GB GPU runs a single-digit-B dense model, not a 70B', () => {
      const b = largestRunnableParamsB(12288);
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(70);
    });
    it('a 48GB host runs strictly larger than a 12GB host', () => {
      expect(largestRunnableParamsB(49152)).toBeGreaterThan(largestRunnableParamsB(12288));
    });
  });

  describe('pickRecommended', () => {
    it('picks the largest model that runs without spill', () => {
      const measured = [
        { modelName: 'a:7b', paramB: 7, tokensPerSec: 90, vramPct: 40, spillVerified: true, spillDetected: false },
        { modelName: 'b:14b', paramB: 14, tokensPerSec: 30, vramPct: 80, spillVerified: true, spillDetected: false },
        { modelName: 'c:32b', paramB: 32, tokensPerSec: 10, vramPct: 99, spillVerified: true, spillDetected: true }
      ];
      expect(pickRecommended(measured).modelName).toBe('b:14b');
    });
    it('returns null when every model spills', () => {
      expect(pickRecommended([{ modelName: 'x', paramB: 70, spillDetected: true }])).toBeNull();
    });
  });

  describe('pickBestBenchmarked', () => {
    it('picks the highest benchmark score among clean fits', () => {
      const measured = [
        { modelName: 'a', paramB: 7, vramPct: 40, spillVerified: true, spillDetected: false, score: 70 },
        { modelName: 'b', paramB: 14, vramPct: 80, spillVerified: true, spillDetected: false, score: 88, bestCategory: 'coding' }
      ];
      expect(pickBestBenchmarked(measured).modelName).toBe('b');
    });
    it('returns null when no model has a score', () => {
      expect(pickBestBenchmarked([{ modelName: 'a', score: null, spillDetected: false }])).toBeNull();
    });
  });

  describe('MoE awareness', () => {
    it('parses active expert params from the name', () => {
      expect(parseActiveParams('qwen3.6:35b-a3b-mtp-q4_K_M')).toBe(3);
      expect(parseActiveParams('ax/gemma4:26b-a4b-it-qat')).toBe(4);
      expect(parseActiveParams('qwen2.5:14b-instruct-q4_K_M')).toBeNull();
    });
    it('flags MoE only when active < total', () => {
      expect(isMoE('qwen3.6:35b-a3b', 35)).toBe(true);
      expect(isMoE('qwen2.5:14b', 14)).toBe(false);
    });
    it('estimates MoE throughput from active params (much faster than dense)', () => {
      const tm = buildThroughputModel([{ modelName: 'qwen2.5:14b', paramB: 14, quant: 'Q4_K_M', tokensPerSec: 30, vramPct: 50, spillVerified: true, spillDetected: false }], null);
      const dense = estTpsFromModel(tm, 35, 'Q4_K_M', 'qwen2.5:32b');
      const moe = estTpsFromModel(tm, 35, 'Q4_K_M', 'qwen3.6:35b-a3b');
      expect(moe).toBeGreaterThan(dense * 3);
    });
    it('excludes MoE from the dense throughput calibration', () => {
      const set = calibrationSet([
        { modelName: 'qwen2.5:14b', paramB: 14, tokensPerSec: 30, vramPct: 50, spillVerified: true, spillDetected: false },
        { modelName: 'qwen3.6:35b-a3b', paramB: 35, tokensPerSec: 100, vramPct: 50, spillVerified: true, spillDetected: false }
      ]);
      expect(set.map(m => m.paramB)).toEqual([14]);
    });
    it('calibrates a separate MoE constant from MoE profiles (matches measured)', () => {
      const tm = buildThroughputModel([
        { modelName: 'qwen2.5:14b', paramB: 14, quant: 'Q4_K_M', tokensPerSec: 30, vramPct: 50, spillVerified: true, spillDetected: false },
        { modelName: 'qwen3.6:35b-a3b', paramB: 35, quant: 'Q4_K_M', tokensPerSec: 100, vramPct: 50, spillVerified: true, spillDetected: false }
      ], null);
      expect(tm.moeNPoints).toBe(1);
      expect(tm.moeSource).toBe('profiles');
      // a same-shape unprofiled MoE estimates ~the measured 100, not the
      // dense-extrapolated value, and not 0.8×active either
      const e = estTpsFromModel(tm, 35, 'Q4_K_M', 'qwen3.6:35b-a3b');
      expect(e).toBeGreaterThan(85);
      expect(e).toBeLessThan(115);
    });
  });

  describe('composite scoring', () => {
    it('scores the four dimensions from model data', () => {
      const d = dimensionScores({ tps: 50, vramPct: 65, spillDetected: false, benchmarkScore: null, paramB: 14, quant: 'Q4_K_M', ctx: 8192 });
      expect(d.speed).toBe(50);
      expect(d.fit).toBe(100);
      expect(d.quality).toBeGreaterThan(80);
      expect(d.context).toBe(70);
    });
    it('uses real benchmark score for quality when present', () => {
      expect(dimensionScores({ tps: 50, vramPct: 50, paramB: 7, quant: 'Q4_K_M', benchmarkScore: 88, ctx: 8192 }).quality).toBe(88);
    });
    it('reasoning weights quality, chat weights speed', () => {
      const hiQ = { quality: 90, speed: 30, fit: 80, context: 70 };
      const hiS = { quality: 50, speed: 95, fit: 80, context: 70 };
      expect(compositeScore(hiQ, 'reasoning')).toBeGreaterThan(compositeScore(hiS, 'reasoning'));
      expect(compositeScore(hiS, 'chat')).toBeGreaterThan(compositeScore(hiQ, 'chat'));
    });
    it('renormalizes over present dimensions (missing context)', () => {
      const s = compositeScore({ quality: 80, speed: 60, fit: 70, context: null }, 'general');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(100);
    });
  });

  describe('median', () => {
    it('handles odd-length arrays', () => expect(median([3, 1, 2])).toBe(2));
    it('handles even-length arrays', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  });
});

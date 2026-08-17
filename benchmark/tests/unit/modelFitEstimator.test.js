/**
 * Tests for the analytical Model Fit Estimator (llmfit-derived, Track B).
 * Pure functions — no DB, no network.
 */

const {
  GPU_BANDWIDTH_GBS,
  resolveHostBandwidthGBs,
  parseActiveParams,
  effectiveThroughputParams,
  physicalCeilingTokSec,
  estimateTokSec,
  isImplausibleThroughput,
  selectBestQuantForVram
} = require('../../src/services/modelFitEstimator');

describe('resolveHostBandwidthGBs', () => {
  it('does not encode IP-to-hardware inventory', () => {
    expect(resolveHostBandwidthGBs('192.0.2.10')).toBeNull();
    expect(resolveHostBandwidthGBs('http://192.0.2.20:11434')).toBeNull();
  });
  it('resolves by GPU name', () => {
    expect(resolveHostBandwidthGBs('RTX 3090')).toBe(GPU_BANDWIDTH_GBS['rtx 3090']);
    expect(resolveHostBandwidthGBs('rtx 5070 ti')).toBe(896);
  });
  it('returns null when unresolved', () => {
    expect(resolveHostBandwidthGBs('not-a-host')).toBeNull();
    expect(resolveHostBandwidthGBs(null)).toBeNull();
    expect(resolveHostBandwidthGBs('mystery-gpu')).toBeNull();
  });
});

describe('parseActiveParams (B3 MoE)', () => {
  it('parses aNb active-param tags', () => {
    expect(parseActiveParams('ax/qwen3.6:35b-a3b-mtp-q4_K_M')).toBe(3);
    expect(parseActiveParams('ax/gemma4:26b-a4b-it-qat')).toBe(4);
  });
  it('parses eNb effective tags', () => {
    expect(parseActiveParams('ax/gemma4:e4b')).toBe(4);
  });
  it('returns null for dense models', () => {
    expect(parseActiveParams('ax/qwen3-coder:30b')).toBeNull();
    expect(parseActiveParams('llama3:70b-instruct-q4_K_M')).toBeNull();
    expect(parseActiveParams(null)).toBeNull();
  });
});

describe('effectiveThroughputParams (B3)', () => {
  it('prefers explicit active params', () => {
    expect(effectiveThroughputParams({ paramBillions: 35, activeParamBillions: 3 })).toBe(3);
  });
  it('falls back to parsed active tag then total', () => {
    expect(effectiveThroughputParams({ modelName: 'ax/qwen3.6:35b-a3b-mtp-q4_K_M' })).toBe(3);
    expect(effectiveThroughputParams({ modelName: 'ax/qwen3-coder:30b' })).toBe(30);
    expect(effectiveThroughputParams({ paramBillions: 14 })).toBe(14);
  });
  it('recognizes qwen35moe/Ornith models whose tags omit active params', () => {
    expect(effectiveThroughputParams({ modelName: 'ornith:35b-q4_K_M' })).toBe(3);
    expect(effectiveThroughputParams({
      modelName: 'custom:35b-q4_K_M',
      architecture: 'qwen35moe',
      modelInfo: {
        'general.architecture': 'qwen35moe',
        'general.parameter_count': 34660610688
      }
    })).toBe(3);
  });
  it('returns null when undeterminable', () => {
    expect(effectiveThroughputParams({ modelName: 'nomic-embed-text' })).toBeNull();
  });
});

describe('physicalCeilingTokSec (B1)', () => {
  it('computes a memory-bound ceiling for a dense model', () => {
    // 30B Q4 on 936 GB/s ≈ 936 / (30 * 0.5625) ≈ 55 tok/s
    const c = physicalCeilingTokSec({ paramBillions: 30, quantization: 'Q4_K_M', hostBandwidthGBs: 936 });
    expect(c).toBeGreaterThan(45);
    expect(c).toBeLessThan(65);
  });
  it('gives a much higher ceiling for MoE active params', () => {
    // gemma4:26b-a4b (4B active) ceiling >> observed 56.69 tok/s from Phase 1
    const c = physicalCeilingTokSec({ modelName: 'ax/gemma4:26b-a4b-it-qat', hostBandwidthGBs: 936 });
    expect(c).toBeGreaterThan(56.69);
  });
  it('does not treat Ornith qwen35moe as a dense 35B model', () => {
    const c = physicalCeilingTokSec({
      modelName: 'ornith:35b-q4_K_M',
      hostBandwidthGBs: 936
    });
    expect(c).toBeGreaterThan(130.5);
  });
  it('resolves bandwidth from the model/host hint when not passed', () => {
    const c = physicalCeilingTokSec({ modelName: 'rtx 3090 qwen:7b', quantization: 'Q4_K_M' });
    expect(c).toBeGreaterThan(0);
  });
  it('returns null without enough info', () => {
    expect(physicalCeilingTokSec({ paramBillions: 7 })).toBeNull(); // no bandwidth
    expect(physicalCeilingTokSec({ hostBandwidthGBs: 936 })).toBeNull(); // no params
  });
});

describe('estimateTokSec (B1)', () => {
  it('is a fraction of the physical ceiling', () => {
    const ceiling = physicalCeilingTokSec({ paramBillions: 30, quantization: 'Q4_K_M', hostBandwidthGBs: 936 });
    const pred = estimateTokSec({ paramBillions: 30, quantization: 'Q4_K_M', hostBandwidthGBs: 936, efficiency: 0.2 });
    expect(pred).toBeCloseTo(ceiling * 0.2, 5);
    expect(pred).toBeLessThan(ceiling);
  });
});

describe('isImplausibleThroughput (B1 — the qwopus guard)', () => {
  it('flags the impossible 1,000,000 tok/s probe artifact', () => {
    const r = isImplausibleThroughput(1_000_000, {
      modelName: 'ax/qwopus3.6-coder-mtp:27b-q5_K_M',
      hostBandwidthGBs: 936
    });
    expect(r.implausible).toBe(true);
    expect(r.ceilingTokSec).toBeGreaterThan(0);
    expect(r.reason).toMatch(/exceeds physical ceiling/);
  });
  it('accepts a realistic reading', () => {
    const r = isImplausibleThroughput(56.69, { modelName: 'ax/gemma4:26b-a4b-it-qat', hostBandwidthGBs: 936 });
    expect(r.implausible).toBe(false);
  });
  it('accepts measured Ornith qwen35moe throughput on Host Alpha', () => {
    const r = isImplausibleThroughput(130.5, {
      modelName: 'ornith:35b-q4_K_M',
      hostBandwidthGBs: 936,
      marginFactor: 2
    });
    expect(r.implausible).toBe(false);
  });
  it('allows one reported tenth at the physical-ceiling boundary', () => {
    const args = {
      modelName: 'ax/qwen3.6:27b-mtp-q8_0',
      hostBandwidthGBs: 936,
      marginFactor: 2
    };

    expect(isImplausibleThroughput(69.4, args).implausible).toBe(false);
    expect(isImplausibleThroughput(69.5, args).implausible).toBe(true);
  });
  it('does not judge when the ceiling is undeterminable', () => {
    const r = isImplausibleThroughput(1_000_000, { modelName: 'nomic-embed-text' });
    expect(r.implausible).toBe(false);
    expect(r.reason).toMatch(/undeterminable/);
  });
  it('handles missing observation gracefully', () => {
    expect(isImplausibleThroughput(0, { paramBillions: 7, hostBandwidthGBs: 936 }).implausible).toBe(false);
  });
});

describe('selectBestQuantForVram (B2 quant-walk)', () => {
  it('fits a 7B fully-resident in 12GB and picks a high quant', () => {
    const r = selectBestQuantForVram({ paramBillions: 7, hostVramMiB: 12288, numCtx: 8192 });
    expect(r.fits).toBe(true);
    expect(r.quantization).toBeTruthy();
    expect(r.estVramMiB).toBeLessThanOrEqual(Math.round(12288 * 0.9));
  });
  it('downgrades quant for a tighter fit before giving up', () => {
    // 14B in 12GB should require a lower quant than 7B did.
    const r = selectBestQuantForVram({ paramBillions: 14, hostVramMiB: 12288, numCtx: 8192 });
    if (r.fits) {
      expect(['Q5_K_M', 'Q4_K_M', 'Q3_K_M', 'Q2_K']).toContain(r.quantization);
    } else {
      expect(r.reason).toMatch(/no quant/);
    }
  });
  it('reports no fit for a 30B in 12GB', () => {
    const r = selectBestQuantForVram({ paramBillions: 30, hostVramMiB: 12288, numCtx: 8192 });
    expect(r.fits).toBe(false);
  });
  it('derives params from the model name', () => {
    const r = selectBestQuantForVram({ modelName: 'qwen2.5:7b-instruct', hostVramMiB: 16303, numCtx: 8192 });
    expect(r.fits).toBe(true);
  });
  it('returns a clear failure on insufficient inputs', () => {
    const r = selectBestQuantForVram({ hostVramMiB: 12288 });
    expect(r.fits).toBe(false);
    expect(r.reason).toMatch(/insufficient inputs/);
  });
});

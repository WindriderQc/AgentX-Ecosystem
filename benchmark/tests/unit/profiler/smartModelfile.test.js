'use strict';

jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../models/HostProfile');
jest.mock('../../../src/services/profiler/namingConvention');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

describe('Smart Modelfile Generation', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.MODEL_CONTEXT_OPERATIONAL_CAP;
    delete process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP;
    jest.mock('../../../models/ModelAdaptation');
    jest.mock('../../../models/HostProfile');
    jest.mock('../../../src/services/profiler/namingConvention');
    jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
    service = require('../../../src/services/profiler/adaptationService');
  });

  // ── generateConfig ──────────────────────────────────────────────────────────

  describe('generateConfig()', () => {
    it('uses spill.lastSafeNumCtx for num_ctx', () => {
      const profile = {
        optimalNumCtx: 8192,
        spill: { spillDetected: true, lastSafeNumCtx: 6144, spillNumCtx: 8192 }
      };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(6144);
    });

    it('falls back to optimalNumCtx when no spill data', () => {
      const profile = { optimalNumCtx: 16384 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(16384);
    });

    it('caps generated runtime num_ctx at the conservative operational ceiling', () => {
      const profile = { optimalNumCtx: 300000 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(98304);
    });

    it('honors a verified context below the ceiling instead of flat-capping it', () => {
      const profile = { optimalNumCtx: 65536 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(65536);
    });

    it('honors an explicit higher operational ceiling', () => {
      process.env.MODEL_CONTEXT_OPERATIONAL_CAP = '131072';
      jest.resetModules();
      service = require('../../../src/services/profiler/adaptationService');

      const profile = { optimalNumCtx: 131072 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(131072);
    });

    it('rejects implausible profiler throughput before writing a Modelfile', () => {
      expect(() => service.generateModelfile('llama3.1:8b', {
        optimalNumCtx: 8192,
        tokensPerSec: 1000000
      }, null)).toThrow(/Implausible profiler throughput/);
    });

    it('auto-detects num_thread from host CPU cores (12 cores -> 10 threads)', () => {
      const profile = { optimalNumCtx: 8192 };
      const hostProfile = { cpu: { cores: 12 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config.num_thread).toBe(10);
    });

    it('uses all cores when host has <= 4', () => {
      const profile = { optimalNumCtx: 8192 };
      const hostProfile = { cpu: { cores: 4 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config.num_thread).toBe(4);
    });

    it('respects threadOverride', () => {
      const profile = { optimalNumCtx: 8192 };
      const hostProfile = { cpu: { cores: 12, threadOverride: 6 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config.num_thread).toBe(6);
    });

    it('scales num_batch by VRAM headroom', () => {
      // 50% headroom: floor(0.5 * 512) = 256, clamped to [128,512] = 256
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 5000 };
      const hostProfile = { gpu: { vramTotalMiB: 10000 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config.num_batch).toBe(256);
      expect(config.num_batch).toBeGreaterThanOrEqual(128);
      expect(config.num_batch).toBeLessThanOrEqual(512);
    });

    it('clamps num_batch to 128 minimum (very tight VRAM)', () => {
      // 5% headroom: floor(0.05 * 512) = 25 → clamped to 128
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 9500 };
      const hostProfile = { gpu: { vramTotalMiB: 10000 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config.num_batch).toBe(128);
    });

    it('includes num_predict and num_keep in output', () => {
      const profile = { optimalNumCtx: 8192 };
      const config = service.generateConfig(profile, null);
      expect(config).toHaveProperty('num_predict');
      expect(config).toHaveProperty('num_keep', 4);
    });

    it('uses best num_predict from generation stability data', () => {
      // baseline (64 tokens) = 42 tok/s, threshold = 37.8
      // 256 = 40 tok/s >= 37.8 => OK
      // 512 = 30 tok/s < 37.8  => FAIL
      // Best = 256
      const profile = {
        optimalNumCtx: 8192,
        generationStability: [
          { numPredict: 64, tokensPerSec: 42, totalLatencyMs: 1500 },
          { numPredict: 256, tokensPerSec: 40, totalLatencyMs: 6400 },
          { numPredict: 512, tokensPerSec: 30, totalLatencyMs: 17000 }
        ]
      };
      const config = service.generateConfig(profile, null);
      expect(config.num_predict).toBe(256);
    });
  });

  // ── _bestNumPredict ─────────────────────────────────────────────────────────

  describe('_bestNumPredict()', () => {
    it('returns 512 when no stability data', () => {
      expect(service._bestNumPredict(null)).toBe(512);
      expect(service._bestNumPredict(undefined)).toBe(512);
    });

    it('returns 512 when stability array is empty', () => {
      expect(service._bestNumPredict([])).toBe(512);
    });

    it('returns 512 when baseline tokensPerSec is 0', () => {
      const stability = [{ numPredict: 64, tokensPerSec: 0 }];
      expect(service._bestNumPredict(stability)).toBe(512);
    });

    it('returns the largest numPredict above 90% threshold', () => {
      const stability = [
        { numPredict: 64, tokensPerSec: 100 },
        { numPredict: 256, tokensPerSec: 95 },   // >= 90 OK
        { numPredict: 512, tokensPerSec: 91 },   // >= 90 OK
        { numPredict: 1024, tokensPerSec: 85 }   // < 90 FAIL
      ];
      expect(service._bestNumPredict(stability)).toBe(512);
    });

    it('returns 64 when even the first entry drops below threshold', () => {
      // Only one entry and it IS the baseline, so it always qualifies
      // Need at least two entries where second drops
      const stability = [
        { numPredict: 64, tokensPerSec: 100 },
        { numPredict: 256, tokensPerSec: 50 }
      ];
      // baseline=100, threshold=90, 64 qualifies (100>=90), 256 fails (50<90)
      expect(service._bestNumPredict(stability)).toBe(64);
    });

    it('returns all entries if none drop below threshold', () => {
      const stability = [
        { numPredict: 64, tokensPerSec: 100 },
        { numPredict: 256, tokensPerSec: 98 },
        { numPredict: 512, tokensPerSec: 95 }
      ];
      expect(service._bestNumPredict(stability)).toBe(512);
    });
  });

  // ── generateModelfile ───────────────────────────────────────────────────────

  describe('generateModelfile()', () => {
    const hostProfile = {
      displayName: 'Host Delta',
      hostId: 'host-delta',
      gpu: { model: 'RTX 3090', vramTotalMiB: 24576 },
      cpu: { cores: 12 }
    };
    const profile = {
      optimalNumCtx: 8192,
      vramUsedMiB: 5800,
      tokensPerSec: 42.5,
      profiledAt: new Date('2026-04-01T10:00:00Z'),
      profileDepth: 'standard'
    };

    it('includes all tuned parameters', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      const content = result.content;

      expect(content).toMatch(/^FROM llama3\.1:8b-q4_K_M/m);
      expect(content).toMatch(/PARAMETER num_ctx \d+/);
      expect(content).toMatch(/PARAMETER num_gpu 99/);
      expect(content).toMatch(/PARAMETER num_batch \d+/);
      expect(content).toMatch(/PARAMETER num_thread \d+/);
      expect(content).toMatch(/PARAMETER num_predict \d+/);
      expect(content).toMatch(/PARAMETER num_keep 4/);
    });

    it('returns content, generatedAt, and hash', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('generatedAt');
      expect(result).toHaveProperty('hash');
      expect(typeof result.content).toBe('string');
      expect(result.generatedAt).toBeInstanceOf(Date);
      expect(result.hash).toMatch(/^sha256:/);
    });

    it('shows spill warning in comments when spill detected', () => {
      const spillProfile = {
        ...profile,
        spill: { spillDetected: true, lastSafeNumCtx: 6144, spillNumCtx: 8192 }
      };
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', spillProfile, hostProfile);
      expect(result.content).toMatch(/Spill:.*Detected at ctx 8192/);
      expect(result.content).toMatch(/safe limit: 6144/);
    });

    it('shows no spill message when spill is not detected', () => {
      const noSpillProfile = {
        ...profile,
        spill: { spillDetected: false }
      };
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', noSpillProfile, hostProfile);
      expect(result.content).toMatch(/Spill:.*None detected/);
    });

    it('includes host info, profiled date, and baseline in comments', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      const content = result.content;
      expect(content).toMatch(/Host:.*Host Delta/);
      expect(content).toMatch(/RTX 3090/);
      expect(content).toMatch(/24GB/);
      expect(content).toMatch(/Profiled:.*2026-04-01/);
      expect(content).toMatch(/Baseline:.*42\.5 tok\/s/);
    });

    it('includes profile depth in comments', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(result.content).toMatch(/standard depth/);
    });

    it('includes parent model name and hash in comments', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(result.content).toMatch(/Parent:.*llama3\.1:8b-q4_K_M/);
      expect(result.content).toMatch(/Hash:.*sha256:/);
    });

    it('handles null hostProfile gracefully', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, null);
      expect(result.content).toMatch(/^FROM llama3\.1:8b-q4_K_M/m);
      expect(result.content).toMatch(/PARAMETER num_ctx/);
    });
  });
});

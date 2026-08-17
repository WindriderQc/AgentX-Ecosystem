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

    it('uses a large profiled num_ctx without imposing an unrelated ceiling', () => {
      const profile = { optimalNumCtx: 300000 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(300000);
    });

    it('honors a verified context below the ceiling instead of flat-capping it', () => {
      const profile = { optimalNumCtx: 65536 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(65536);
    });

    it('does not reject positive measured throughput using an arbitrary ceiling', () => {
      expect(service.generateModelfile('llama3.1:8b', {
        optimalNumCtx: 8192,
        tokensPerSec: 1000000
      }, null).content).toContain('PARAMETER num_ctx 8192');
    });

    it('does not guess num_thread from host CPU cores', () => {
      const profile = { optimalNumCtx: 8192 };
      const hostProfile = { cpu: { cores: 12 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config).not.toHaveProperty('num_thread');
    });

    it('does not guess num_thread for small hosts', () => {
      const profile = { optimalNumCtx: 8192 };
      const hostProfile = { cpu: { cores: 4 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config).not.toHaveProperty('num_thread');
    });

    it('respects threadOverride', () => {
      const profile = { optimalNumCtx: 8192 };
      const hostProfile = { cpu: { cores: 12, threadOverride: 6 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config.num_thread).toBe(6);
    });

    it('does not turn VRAM headroom into a guessed num_batch', () => {
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 5000 };
      const hostProfile = { gpu: { vramTotalMiB: 10000 } };
      const config = service.generateConfig(profile, hostProfile);
      expect(config).not.toHaveProperty('num_batch');
    });

    it('does not create output or prompt-retention limits', () => {
      const profile = { optimalNumCtx: 8192 };
      const config = service.generateConfig(profile, null);
      expect(config).not.toHaveProperty('num_predict');
      expect(config).not.toHaveProperty('num_keep');
    });

    it('keeps generation stability as evidence instead of a runtime limit', () => {
      // All three output lengths completed; throughput changes are recorded
      // but do not manufacture a smaller output limit.
      const profile = {
        optimalNumCtx: 8192,
        generationStability: [
          { numPredict: 64, tokensPerSec: 42, totalLatencyMs: 1500 },
          { numPredict: 256, tokensPerSec: 40, totalLatencyMs: 6400 },
          { numPredict: 512, tokensPerSec: 30, totalLatencyMs: 17000 }
        ]
      };
      const config = service.generateConfig(profile, null);
      expect(config).not.toHaveProperty('num_predict');
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

    it('includes measured context without guessed tuning parameters', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      const content = result.content;

      expect(content).toMatch(/^FROM llama3\.1:8b-q4_K_M/m);
      expect(content).toMatch(/PARAMETER num_ctx \d+/);
      expect(content).not.toContain('PARAMETER num_gpu');
      expect(content).not.toContain('PARAMETER num_batch');
      expect(content).not.toContain('PARAMETER num_thread');
      expect(content).not.toContain('PARAMETER num_predict');
      expect(content).not.toContain('PARAMETER num_keep');
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

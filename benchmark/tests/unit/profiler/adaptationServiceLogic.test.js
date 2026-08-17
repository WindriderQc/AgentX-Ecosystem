'use strict';

jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../models/HostProfile');
jest.mock('../../../src/services/profiler/namingConvention');

describe('adaptationService', () => {
  let service;
  let ModelAdaptation;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.mock('../../../models/ModelAdaptation');
    jest.mock('../../../models/HostProfile');
    jest.mock('../../../src/services/profiler/namingConvention');
    ModelAdaptation = require('../../../models/ModelAdaptation');
    service = require('../../../src/services/profiler/adaptationService');
  });

  // ── generateConfig ─────────────────────────────────────────────────────────

  describe('generateConfig()', () => {
    it('returns config using optimalNumCtx when no spill data', () => {
      const profile = { optimalNumCtx: 16384 };
      const config = service.generateConfig(profile, null);

      expect(config.num_ctx).toBe(16384);
      expect(config).toEqual({ num_ctx: 16384 });
    });

    it('leaves context unset when optimalNumCtx is absent', () => {
      const config = service.generateConfig({}, null);
      expect(config).not.toHaveProperty('num_ctx');
    });

    it('uses the profiled context as the runtime context', () => {
      const profile = { optimalNumCtx: 300000 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(300000);
    });

    it('does not flat-cap a verified context that is below the ceiling', () => {
      const profile = { optimalNumCtx: 65536 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(65536);
    });

    it('does not reject a positive measured throughput using an arbitrary ceiling', () => {
      expect(service.generateConfig({ optimalNumCtx: 8192, tokensPerSec: 1000000 }, null).num_ctx)
        .toBe(8192);
    });

    it('does not turn estimated VRAM headroom into hidden runtime parameters', () => {
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 9300 };
      const hostProfile = { gpu: { vramTotalMiB: 10000 } };
      const config = service.generateConfig(profile, hostProfile);

      expect(config).toEqual({ num_ctx: 8192 });
    });

    it('honors only an explicit thread override', () => {
      expect(service.generateConfig({ optimalNumCtx: 8192 }, {
        cpu: { cores: 24, threadOverride: 6 }
      })).toEqual({ num_ctx: 8192, num_thread: 6 });
    });
  });

  // ── generateModelfile ──────────────────────────────────────────────────────

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

    it('returns an object with content, generatedAt, and hash', () => {
      const result = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('generatedAt');
      expect(result).toHaveProperty('hash');
      expect(result.hash).toMatch(/^sha256:/);
    });

    it('starts with a valid FROM line', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content.startsWith('FROM llama3.1:8b-q4_K_M')).toBe(true);
    });

    it('includes measured context without guessed tuning parameters', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content).toMatch(/PARAMETER num_ctx 8192/);
      expect(content).not.toContain('PARAMETER num_gpu');
      expect(content).not.toContain('PARAMETER num_batch');
      expect(content).not.toContain('PARAMETER num_thread');
      expect(content).not.toContain('PARAMETER num_predict');
      expect(content).not.toContain('PARAMETER num_keep');
    });

    it('includes host display name in comment', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content).toMatch(/Host:.*Host Delta/);
    });

    it('includes GPU model and VRAM in host comment', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content).toMatch(/RTX 3090/);
      expect(content).toMatch(/24GB/);
    });

    it('includes a comment with profiled date', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content).toMatch(/Profiled:.*2026-04-01T10:00/);
    });

    it('includes baseline tok/s in comments', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content).toMatch(/42\.5 tok\/s/);
    });

    it('falls back to hostId in comment when displayName is absent', () => {
      const hp = { hostId: 'host-beta', gpu: { model: 'RTX 5070 Ti', vramTotalMiB: 16384 } };
      const { content } = service.generateModelfile('gemma2:9b', profile, hp);
      expect(content).toMatch(/Host:.*host-beta/);
    });

    it('handles null hostProfile gracefully', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, null);
      expect(content.startsWith('FROM llama3.1:8b-q4_K_M')).toBe(true);
      expect(content).toMatch(/PARAMETER num_ctx/);
    });
  });

  // ── getAdaptation ──────────────────────────────────────────────────────────

  describe('getAdaptation()', () => {
    it('fetches adaptation by modelName and hostId', async () => {
      const mockDoc = { modelName: 'llama3.1:8b-q4_K_M', hostId: 'host-delta' };
      const leanMock = jest.fn().mockResolvedValue(mockDoc);
      ModelAdaptation.findOne.mockReturnValue({ lean: leanMock });

      const result = await service.getAdaptation('llama3.1:8b-q4_K_M', 'host-delta');

      expect(ModelAdaptation.findOne).toHaveBeenCalledWith({
        modelName: 'llama3.1:8b-q4_K_M',
        hostId: 'host-delta'
      });
      expect(leanMock).toHaveBeenCalled();
      expect(result).toEqual(mockDoc);
    });

    it('returns null when no adaptation exists', async () => {
      const leanMock = jest.fn().mockResolvedValue(null);
      ModelAdaptation.findOne.mockReturnValue({ lean: leanMock });

      const result = await service.getAdaptation('unknown:7b', 'host-gamma');
      expect(result).toBeNull();
    });
  });

  // ── getAdaptedRoster ───────────────────────────────────────────────────────

  describe('getAdaptedRoster()', () => {
    it('returns all adaptations sorted by updatedAt desc when no filter', async () => {
      const mockDocs = [
        { modelName: 'llama3.1:8b', hostId: 'host-delta', updatedAt: new Date('2026-04-03') },
        { modelName: 'gemma2:9b',   hostId: 'host-beta',  updatedAt: new Date('2026-04-01') }
      ];
      const leanMock = jest.fn().mockResolvedValue(mockDocs);
      const sortMock = jest.fn().mockReturnValue({ lean: leanMock });
      ModelAdaptation.find.mockReturnValue({ sort: sortMock });

      const result = await service.getAdaptedRoster();

      expect(ModelAdaptation.find).toHaveBeenCalledWith({});
      expect(sortMock).toHaveBeenCalledWith({ updatedAt: -1 });
      expect(result).toEqual(mockDocs);
    });

    it('filters by hostId when provided', async () => {
      const leanMock = jest.fn().mockResolvedValue([]);
      const sortMock = jest.fn().mockReturnValue({ lean: leanMock });
      ModelAdaptation.find.mockReturnValue({ sort: sortMock });

      await service.getAdaptedRoster({ hostId: 'host-delta' });

      expect(ModelAdaptation.find).toHaveBeenCalledWith({ hostId: 'host-delta' });
    });

    it('filters by deployment status when provided', async () => {
      const leanMock = jest.fn().mockResolvedValue([]);
      const sortMock = jest.fn().mockReturnValue({ lean: leanMock });
      ModelAdaptation.find.mockReturnValue({ sort: sortMock });

      await service.getAdaptedRoster({ status: 'deployed' });

      expect(ModelAdaptation.find).toHaveBeenCalledWith({ 'deployment.status': 'deployed' });
    });

    it('combines hostId and status filters', async () => {
      const leanMock = jest.fn().mockResolvedValue([]);
      const sortMock = jest.fn().mockReturnValue({ lean: leanMock });
      ModelAdaptation.find.mockReturnValue({ sort: sortMock });

      await service.getAdaptedRoster({ hostId: 'host-beta', status: 'failed' });

      expect(ModelAdaptation.find).toHaveBeenCalledWith({
        hostId: 'host-beta',
        'deployment.status': 'failed'
      });
    });
  });

  // ── saveAdaptation ─────────────────────────────────────────────────────────

  describe('saveAdaptation()', () => {
    it('upserts by modelName + hostId', async () => {
      const data = {
        modelName: 'llama3.1:8b-q4_K_M',
        hostId: 'host-delta',
        adaptedName: 'ax/llama3.1:8b-q4_K_M'
      };
      const savedDoc = { ...data, _id: 'abc123' };
      ModelAdaptation.findOneAndUpdate.mockResolvedValue(savedDoc);

      const result = await service.saveAdaptation(data);

      expect(ModelAdaptation.findOneAndUpdate).toHaveBeenCalledWith(
        { modelName: data.modelName, hostId: data.hostId },
        { $set: data },
        { upsert: true, new: true, runValidators: true }
      );
      expect(result).toEqual(savedDoc);
    });
  });
});

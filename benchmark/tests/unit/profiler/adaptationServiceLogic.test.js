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
    delete process.env.MODEL_CONTEXT_OPERATIONAL_CAP;
    delete process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP;
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
      expect(config.num_gpu).toBe(99);
      expect(config.num_batch).toBe(512);
      expect(config.num_thread).toBe(6); // default 8 cores - 2
    });

    it('falls back to 8192 when optimalNumCtx is absent', () => {
      const config = service.generateConfig({}, null);
      expect(config.num_ctx).toBe(8192);
    });

    it('caps very large profiled contexts to the conservative operational runtime ceiling', () => {
      const profile = { optimalNumCtx: 300000 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(98304);
    });

    it('does not flat-cap a verified context that is below the ceiling', () => {
      const profile = { optimalNumCtx: 65536 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(65536);
    });

    it('allows operators to opt into a higher operational runtime ceiling', () => {
      process.env.MODEL_CONTEXT_OPERATIONAL_CAP = '202752';
      jest.resetModules();
      service = require('../../../src/services/profiler/adaptationService');

      const profile = { optimalNumCtx: 202752 };
      const config = service.generateConfig(profile, null);
      expect(config.num_ctx).toBe(202752);
    });

    it('rejects profiles with implausible throughput before generating config', () => {
      expect(() => service.generateConfig({ optimalNumCtx: 8192, tokensPerSec: 1000000 }, null))
        .toThrow(/Implausible profiler throughput/);
    });

    it('scales num_batch proportionally to VRAM headroom', () => {
      // 7% headroom: floor(0.07 * 512) = 35 → clamped to 128
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 9300 };
      const hostProfile = { gpu: { vramTotalMiB: 10000 } };
      const config = service.generateConfig(profile, hostProfile);

      expect(config.num_batch).toBe(128);
    });

    it('scales num_batch to 512 when headroom is high', () => {
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 5800 };
      const hostProfile = { gpu: { vramTotalMiB: 24576 } }; // headroom ~76%
      const config = service.generateConfig(profile, hostProfile);

      expect(config.num_batch).toBeGreaterThanOrEqual(128);
      expect(config.num_batch).toBeLessThanOrEqual(512);
    });

    it('defaults num_batch to 512 when hostProfile has no gpu info', () => {
      const profile = { optimalNumCtx: 8192, vramUsedMiB: 9500 };
      const hostProfile = {}; // no gpu → headroom = 1
      const config = service.generateConfig(profile, hostProfile);

      expect(config.num_batch).toBe(512);
    });

    it('includes num_predict and num_keep', () => {
      const config = service.generateConfig({}, null);
      expect(config).toHaveProperty('num_predict');
      expect(config).toHaveProperty('num_keep', 4);
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

    it('includes PARAMETER lines for all config keys', () => {
      const { content } = service.generateModelfile('llama3.1:8b-q4_K_M', profile, hostProfile);
      expect(content).toMatch(/PARAMETER num_ctx 8192/);
      expect(content).toMatch(/PARAMETER num_gpu 99/);
      expect(content).toMatch(/PARAMETER num_batch \d+/);
      expect(content).toMatch(/PARAMETER num_thread 10/);
      expect(content).toMatch(/PARAMETER num_predict \d+/);
      expect(content).toMatch(/PARAMETER num_keep 4/);
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

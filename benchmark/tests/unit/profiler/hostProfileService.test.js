'use strict';

jest.mock('../../../models/HostProfile');
jest.mock('../../../src/services/ollamaVramService');
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => []),
  normalizeHostUrl: jest.fn(value => String(value || '').trim().replace(/\/+$/, ''))
}));

const HostProfile = require('../../../models/HostProfile');
const { getConfiguredHosts } = require('../../../src/helpers/ollamaHostConfig');
const service = require('../../../src/services/profiler/hostProfileService');

beforeEach(() => {
  jest.clearAllMocks();
  getConfiguredHosts.mockReturnValue([]);
});

describe('hostProfileService', () => {
  describe('getAll()', () => {
    it('returns all host profiles', async () => {
      const mockProfiles = [
        { hostId: 'host-delta', hostUrl: 'http://192.0.2.66:11434', status: 'online' },
        { hostId: 'host-beta', hostUrl: 'http://192.0.2.12:11434', status: 'offline' },
      ];
      const leanMock = jest.fn().mockResolvedValue(mockProfiles);
      HostProfile.find.mockReturnValue({ lean: leanMock });

      const result = await service.getAll();

      expect(HostProfile.find).toHaveBeenCalledWith();
      expect(leanMock).toHaveBeenCalled();
      expect(result).toEqual(mockProfiles);
    });

    it('uses configured host identity and hides a baseline from a stale endpoint', async () => {
      getConfiguredHosts.mockReturnValue([{
        id: 'primary', name: 'Host Alpha', url: 'http://192.0.2.199:11434', vramMb: 49152
      }]);
      HostProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([{
        hostId: 'primary',
        hostUrl: 'http://192.0.2.119:11434',
        displayName: 'Host Alpha',
        baseline: { referenceModel: 'qwen2.5:3b', tokensPerSec: 12 },
        gpu: { model: 'RTX 3090', vramTotalMiB: 4096 },
        status: 'offline'
      }]) });

      const result = await service.getAll();

      expect(result).toEqual([expect.objectContaining({
        hostId: 'primary',
        hostUrl: 'http://192.0.2.199:11434',
        displayName: 'Host Alpha',
        baseline: null,
        gpu: { model: 'RTX 3090', vramTotalMiB: 49152 }
      })]);
    });

    it('includes configured hosts that do not have a stored profile yet', async () => {
      getConfiguredHosts.mockReturnValue([{
        id: 'tertiary', name: 'Host Gamma', url: 'http://192.0.2.99:11434', vramMb: 12288
      }]);
      HostProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

      await expect(service.getAll()).resolves.toEqual([{
        hostId: 'tertiary',
        hostUrl: 'http://192.0.2.99:11434',
        displayName: 'Host Gamma',
        gpu: { vramTotalMiB: 12288 },
        status: 'unknown'
      }]);
    });
  });

  describe('getById()', () => {
    it('returns a host by hostId', async () => {
      const mockProfile = { hostId: 'host-delta', hostUrl: 'http://192.0.2.66:11434', status: 'online' };
      const leanMock = jest.fn().mockResolvedValue(mockProfile);
      HostProfile.findOne.mockReturnValue({ lean: leanMock });

      const result = await service.getById('host-delta');

      expect(HostProfile.findOne).toHaveBeenCalledWith({ hostId: 'host-delta' });
      expect(leanMock).toHaveBeenCalled();
      expect(result).toEqual(mockProfile);
    });

    it('returns null when host is not found', async () => {
      const leanMock = jest.fn().mockResolvedValue(null);
      HostProfile.findOne.mockReturnValue({ lean: leanMock });

      const result = await service.getById('nonexistent');

      expect(result).toBeNull();
    });

    it('resolves a configured host even when its stored profile is missing', async () => {
      getConfiguredHosts.mockReturnValue([{
        id: 'primary', name: 'Host Alpha', url: 'http://192.0.2.199:11434', vramMb: 49152
      }]);
      HostProfile.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      await expect(service.getById('primary')).resolves.toEqual({
        hostId: 'primary',
        hostUrl: 'http://192.0.2.199:11434',
        displayName: 'Host Alpha',
        gpu: { vramTotalMiB: 49152 },
        status: 'unknown'
      });
    });
  });

  describe('upsert()', () => {
    it('rejects a forbidden hostUrl before it can be persisted', async () => {
      await expect(service.upsert({
        hostId: 'metadata',
        hostUrl: 'http://169.254.169.254:11434'
      })).rejects.toMatchObject({ code: 'OLLAMA_TARGET_REJECTED', statusCode: 400 });

      expect(HostProfile.findOne).not.toHaveBeenCalled();
      expect(HostProfile.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('upserts a host profile with findOneAndUpdate', async () => {
      const data = { hostId: 'host-delta', hostUrl: 'http://192.0.2.66:11434', status: 'online' };
      const updatedProfile = { ...data, displayName: 'Host Delta' };
      const leanMock = jest.fn().mockResolvedValue(null);
      HostProfile.findOne.mockReturnValue({ lean: leanMock });
      HostProfile.findOneAndUpdate.mockResolvedValue(updatedProfile);

      const result = await service.upsert(data);

      expect(HostProfile.findOne).toHaveBeenCalledWith({ hostId: data.hostId });
      expect(HostProfile.findOneAndUpdate).toHaveBeenCalledWith(
        { hostId: data.hostId },
        { $set: data },
        { upsert: true, new: true, runValidators: true }
      );
      expect(result).toEqual(updatedProfile);
    });

    it('clears stale baseline when a host slot moves to a new URL', async () => {
      const existing = {
        hostId: 'primary',
        hostUrl: 'http://192.0.2.99:11434',
        gpu: { vramTotalMiB: 49152 },
        baseline: { referenceModel: 'qwen2.5:14b-instruct-q4_K_M', tokensPerSec: 71.31 }
      };
      const data = {
        hostId: 'primary',
        hostUrl: 'http://192.0.2.199:11434',
        displayName: 'Host Alpha',
        gpu: { vramTotalMiB: 49152 },
        status: 'online'
      };
      // upsert() now flattens nested objects to dot paths and wraps in $set
      // so partial subdocuments merge instead of clobbering siblings.
      const expectedUpdate = {
        hostId: data.hostId,
        hostUrl: data.hostUrl,
        displayName: data.displayName,
        'gpu.vramTotalMiB': 49152,
        status: data.status,
        baseline: null
      };
      const updatedProfile = { ...data, baseline: null };
      const leanMock = jest.fn().mockResolvedValue(existing);
      HostProfile.findOne.mockReturnValue({ lean: leanMock });
      HostProfile.findOneAndUpdate.mockResolvedValue(updatedProfile);

      const result = await service.upsert(data);

      expect(HostProfile.findOneAndUpdate).toHaveBeenCalledWith(
        { hostId: data.hostId },
        { $set: expectedUpdate },
        { upsert: true, new: true, runValidators: true }
      );
      expect(result).toEqual(updatedProfile);
    });

    it('keeps baseline when host URL differs only by trailing slash', async () => {
      const existing = {
        hostId: 'tertiary',
        hostUrl: 'http://192.0.2.99:11434/',
        gpu: { vramTotalMiB: 12288 },
        baseline: { referenceModel: 'qwen2.5:3b', tokensPerSec: 147.7 }
      };
      const data = {
        hostId: 'tertiary',
        hostUrl: 'http://192.0.2.99:11434',
        displayName: 'Host Gamma',
        gpu: { vramTotalMiB: 12288 },
        status: 'online'
      };
      const updatedProfile = { ...data, baseline: existing.baseline };
      const leanMock = jest.fn().mockResolvedValue(existing);
      HostProfile.findOne.mockReturnValue({ lean: leanMock });
      HostProfile.findOneAndUpdate.mockResolvedValue(updatedProfile);

      const result = await service.upsert(data);

      expect(HostProfile.findOneAndUpdate).toHaveBeenCalledWith(
        { hostId: data.hostId },
        { $set: {
          hostId: data.hostId,
          hostUrl: data.hostUrl,
          displayName: data.displayName,
          'gpu.vramTotalMiB': 12288,
          status: data.status
        } },
        { upsert: true, new: true, runValidators: true }
      );
      expect(result).toEqual(updatedProfile);
    });
  });

  describe('checkStatus()', () => {
    let originalFetch;

    beforeEach(() => {
      jest.useFakeTimers();
      originalFetch = global.fetch;
      global.fetch = jest.fn();
    });

    afterEach(() => {
      jest.useRealTimers();
      global.fetch = originalFetch;
    });

    it('returns online status when host responds to /api/tags', async () => {
      const mockModels = { models: [{ name: 'llama3.2:3b' }, { name: 'mistral:7b' }] };
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockModels),
      });

      const result = await service.checkStatus('http://192.0.2.66:11434');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://192.0.2.66:11434/api/tags',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result.status).toBe('online');
      expect(result.models).toEqual(['llama3.2:3b', 'mistral:7b']);
    });

    it('returns offline status when fetch fails', async () => {
      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.checkStatus('http://192.0.2.99:11434');

      expect(result.status).toBe('offline');
      expect(result.models).toEqual([]);
      expect(result.error).toBe('ECONNREFUSED');
    });

    it('returns offline status when response is not ok', async () => {
      global.fetch.mockResolvedValue({ ok: false });

      const result = await service.checkStatus('http://192.0.2.12:11434');

      expect(result.status).toBe('offline');
      expect(result.models).toEqual([]);
    });
  });

  describe('updateBaseline()', () => {
    it('stores the latest host baseline fields', async () => {
      const updatedProfile = {
        hostId: 'host-gamma',
        baseline: {
          referenceModel: 'llama3.2:3b',
          tokensPerSec: 42.5,
          latencyMs: 875,
          ttftMs: 133,
          testedAt: new Date('2026-04-05T12:00:00.000Z')
        }
      };
      HostProfile.findOneAndUpdate.mockResolvedValue(updatedProfile);
      HostProfile.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(updatedProfile) });

      const baseline = {
        referenceModel: 'llama3.2:3b',
        tokensPerSec: 42.5,
        latencyMs: 875,
        ttftMs: 133,
        testedAt: new Date('2026-04-05T12:00:00.000Z')
      };

      const result = await service.updateBaseline('host-gamma', baseline);

      expect(HostProfile.findOneAndUpdate).toHaveBeenCalledWith(
        { hostId: 'host-gamma' },
        { $set: {
          hostId: 'host-gamma',
          'baseline.referenceModel': 'llama3.2:3b',
          'baseline.tokensPerSec': 42.5,
          'baseline.latencyMs': 875,
          'baseline.ttftMs': 133,
          'baseline.ttftMeasurement': undefined,
          'baseline.persistenceReceipt': null,
          'baseline.testedAt': baseline.testedAt
        } },
        { upsert: true, new: true, runValidators: true }
      );
      expect(result).toEqual(updatedProfile);
    });

    it('persists the configured identity with a fresh baseline after a host slot moves', async () => {
      getConfiguredHosts.mockReturnValue([{
        id: 'primary', name: 'Host Alpha', url: 'http://192.0.2.199:11434', vramMb: 49152
      }]);
      HostProfile.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({
        hostId: 'primary', hostUrl: 'http://192.0.2.119:11434'
      }) });
      HostProfile.findOneAndUpdate.mockResolvedValue({ hostId: 'primary' });
      const testedAt = new Date('2026-07-31T12:00:00.000Z');

      await service.updateBaseline('primary', {
        referenceModel: 'qwen2.5:3b', tokensPerSec: 75, latencyMs: 800, ttftMs: 120, testedAt
      });

      expect(HostProfile.findOneAndUpdate).toHaveBeenCalledWith(
        { hostId: 'primary' },
        { $set: expect.objectContaining({
          hostUrl: 'http://192.0.2.199:11434',
          displayName: 'Host Alpha',
          'gpu.vramTotalMiB': 49152,
          'baseline.referenceModel': 'qwen2.5:3b',
          'baseline.testedAt': testedAt
        }) },
        { upsert: true, new: true, runValidators: true }
      );
      expect(HostProfile.findOneAndUpdate.mock.calls[0][1].$set.baseline).toBeUndefined();
    });

    it('fences a rejected persistence receipt before conditionally restoring the prior baseline', async () => {
      HostProfile.updateOne
        .mockResolvedValueOnce({ matchedCount: 1 })
        .mockResolvedValueOnce({ matchedCount: 1 });
      const prior = { referenceModel: 'old:model', tokensPerSec: 10 };

      await expect(service.invalidateBaselineReceipt('primary', 'receipt-1', prior))
        .resolves.toEqual({ invalidated: true, persistenceReceipt: 'receipt-1' });

      expect(HostProfile.updateOne).toHaveBeenNthCalledWith(1,
        { hostId: 'primary' },
        { $addToSet: { rejectedBaselineReceipts: 'receipt-1' } }
      );
      expect(HostProfile.updateOne).toHaveBeenNthCalledWith(2,
        { hostId: 'primary', 'baseline.persistenceReceipt': 'receipt-1' },
        { $set: { baseline: prior } }
      );
    });

    it('refuses to publish a baseline whose persistence receipt was previously rejected', async () => {
      HostProfile.findOneAndUpdate.mockResolvedValue(null);
      HostProfile.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      await service.updateBaseline('primary', {
        referenceModel: 'reference:model',
        tokensPerSec: 21,
        persistenceReceipt: 'receipt-rejected'
      });

      expect(HostProfile.findOneAndUpdate).toHaveBeenCalledWith(
        {
          hostId: 'primary',
          rejectedBaselineReceipts: { $ne: 'receipt-rejected' }
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            'baseline.persistenceReceipt': 'receipt-rejected'
          })
        }),
        expect.objectContaining({ upsert: true, new: true, runValidators: true })
      );
    });
  });
});

'use strict';

jest.mock('../../../models/ModelPerformanceProfile');

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const service = require('../../../src/services/profiler/modelPerformanceProfileService');

describe('modelPerformanceProfileService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('activates exact evidence before retiring older evidence', async () => {
    const saved = { _id: 'evidence-new' };
    ModelPerformanceProfile.findOneAndUpdate.mockResolvedValue(saved);
    ModelPerformanceProfile.updateMany.mockResolvedValue({ modifiedCount: 1 });

    await expect(service.saveProfile({
      modelName: 'qwen3.5:9b',
      hostId: 'host-alpha',
      artifact: {
        digest: 'sha256:new',
        runtimeFingerprint: 'runtime-new'
      },
      profile: { profileDepth: 'standard' }
    })).resolves.toBe(saved);

    expect(ModelPerformanceProfile.findOneAndUpdate).toHaveBeenCalledWith(
      {
        modelName: 'qwen3.5:9b',
        hostId: 'host-alpha',
        'artifact.digest': 'sha256:new',
        'artifact.runtimeFingerprint': 'runtime-new'
      },
      { $set: expect.objectContaining({ active: true, stale: false }) },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    expect(ModelPerformanceProfile.updateMany).toHaveBeenCalledWith(
      {
        _id: { $ne: 'evidence-new' },
        modelName: 'qwen3.5:9b',
        hostId: 'host-alpha',
        active: true
      },
      { $set: { active: false, stale: true, staleReason: 'superseded' } }
    );
    expect(ModelPerformanceProfile.findOneAndUpdate.mock.invocationCallOrder[0])
      .toBeLessThan(ModelPerformanceProfile.updateMany.mock.invocationCallOrder[0]);
  });
});

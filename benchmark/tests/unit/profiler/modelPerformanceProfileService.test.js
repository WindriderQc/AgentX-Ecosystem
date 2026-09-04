'use strict';

jest.mock('../../../models/ModelPerformanceProfile');

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const service = require('../../../src/services/profiler/modelPerformanceProfileService');

describe('modelPerformanceProfileService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('activates exact evidence and retires older evidence only after authority commit', async () => {
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
    expect(ModelPerformanceProfile.updateMany).not.toHaveBeenCalled();

    await service.retireSupersededProfiles({
      modelName: 'qwen3.5:9b',
      hostId: 'host-alpha',
      evidenceId: 'evidence-new'
    });
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

  it('excludes stale rows from the active roster projection', async () => {
    const query = {
      sort: jest.fn(() => query),
      lean: jest.fn(async () => [])
    };
    ModelPerformanceProfile.find.mockReturnValue(query);

    await service.getRoster({ hostId: 'host-alpha' });

    expect(ModelPerformanceProfile.find).toHaveBeenCalledWith({
      active: true,
      stale: { $ne: true },
      hostId: 'host-alpha'
    });
  });

  it('invalidates only its own ambiguous authority write when the lease is lost after acknowledgement', async () => {
    let authorityLost = false;
    const loss = Object.assign(new Error('claim lost after profile write'), { code: 'BENCHMARK_CLAIM_LOST' });
    ModelPerformanceProfile.findOneAndUpdate.mockImplementation(async () => {
      authorityLost = true;
      return { _id: 'evidence-ambiguous' };
    });
    ModelPerformanceProfile.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const assertAuthorityActive = jest.fn(() => {
      if (authorityLost) throw loss;
    });

    await expect(service.saveProfile({
      modelName: 'qwen3.5:9b',
      hostId: 'host-alpha',
      artifact: { digest: 'sha256:new', runtimeFingerprint: 'runtime-new' },
      profile: { profileDepth: 'standard' }
    }, { assertAuthorityActive })).rejects.toBe(loss);

    expect(ModelPerformanceProfile.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'qwen3.5:9b',
        hostId: 'host-alpha',
        'artifact.digest': 'sha256:new',
        'artifact.runtimeFingerprint': 'runtime-new',
        authorityWriteId: expect.any(String)
      }),
      { $set: { active: false, stale: true, staleReason: 'profiler_authority_write_failed' } }
    );
  });

  it('marks compensation failure so the caller retains the runtime fences', async () => {
    ModelPerformanceProfile.findOneAndUpdate.mockRejectedValue(new Error('ambiguous database acknowledgement'));
    ModelPerformanceProfile.updateOne.mockRejectedValue(new Error('database unavailable during invalidation'));

    const error = await service.saveProfile({
      modelName: 'qwen3.5:9b',
      hostId: 'host-alpha',
      artifact: { digest: 'sha256:new', runtimeFingerprint: 'runtime-new' },
      profile: { profileDepth: 'standard' }
    }).catch(caught => caught);

    expect(error).toMatchObject({
      authorityInvalidationFailed: true,
      code: 'PROFILER_AUTHORITY_INVALIDATION_FAILED',
      compensationError: expect.any(Error)
    });
  });
});

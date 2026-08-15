jest.mock('../../../models/ModelProfile');
jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../models/BenchmarkResult', () => ({
  distinct: jest.fn()
}));

const ModelProfile = require('../../../models/ModelProfile');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const svc = require('../../../src/services/profiler/modelProfileService');

const mockProfiles = [
  {
    name: 'llama3.1:8b',
    readiness: { 'host-a': { stage: 'profiled' }, 'host-b': { stage: 'available' } }
  },
  {
    name: 'gemma3:12b',
    readiness: { 'host-a': { stage: 'benchmarked' } }
  },
  {
    name: 'phi4:14b',
    readiness: {}
  }
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getAll()', () => {
  it('returns all profiles when no filter', async () => {
    ModelProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockProfiles) });
    const result = await svc.getAll();
    expect(ModelProfile.find).toHaveBeenCalledWith();
    expect(result).toHaveLength(3);
  });

  it('filters by stage in JS after fetch', async () => {
    ModelProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockProfiles) });
    const result = await svc.getAll({ stage: 'profiled' });
    // Only llama3.1:8b has a host with stage === 'profiled'
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('llama3.1:8b');
  });

  it('returns empty array when no profile matches the stage', async () => {
    ModelProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockProfiles) });
    const result = await svc.getAll({ stage: 'adapted' });
    expect(result).toHaveLength(0);
  });

  it('excludes profiles with no readiness entries', async () => {
    ModelProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockProfiles) });
    const result = await svc.getAll({ stage: 'available' });
    // phi4:14b has empty readiness, should not appear; host-b on llama3.1:8b is 'available'
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('llama3.1:8b');
  });
});

describe('getByName()', () => {
  it('returns a single profile by name', async () => {
    const profile = mockProfiles[0];
    ModelProfile.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(profile) });
    const result = await svc.getByName('llama3.1:8b');
    expect(ModelProfile.findOne).toHaveBeenCalledWith({ name: 'llama3.1:8b' });
    expect(result.name).toBe('llama3.1:8b');
  });

  it('returns null when model not found', async () => {
    ModelProfile.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const result = await svc.getByName('nonexistent');
    expect(result).toBeNull();
  });
});

describe('upsert()', () => {
  it('calls findOneAndUpdate with upsert options', async () => {
    const data = { name: 'llama3.1:8b', provider: 'meta' };
    const saved = { ...data, _id: 'abc' };
    ModelProfile.findOneAndUpdate.mockResolvedValue(saved);

    const result = await svc.upsert(data);
    expect(ModelProfile.findOneAndUpdate).toHaveBeenCalledWith(
      { name: 'llama3.1:8b' },
      data,
      { upsert: true, new: true, runValidators: true }
    );
    expect(result).toEqual(saved);
  });
});

describe('updateReadiness()', () => {
  it('sets stage and no timestamp for "available"', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});
    await svc.updateReadiness('llama3.1:8b', 'host-a', 'available');
    const [, update] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(update.$set['readiness.host-a.stage']).toBe('available');
    expect(update.$set['readiness.host-a.profiledAt']).toBeUndefined();
    expect(update.$set['readiness.host-a.adaptedAt']).toBeUndefined();
    expect(update.$set['readiness.host-a.benchmarkedAt']).toBeUndefined();
  });

  it('sets stage + profiledAt when stage is "profiled"', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});
    await svc.updateReadiness('llama3.1:8b', 'host-a', 'profiled');
    const [, update] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(update.$set['readiness.host-a.stage']).toBe('profiled');
    expect(update.$set['readiness.host-a.profiledAt']).toBeInstanceOf(Date);
  });

  it('sets stage + adaptedAt when stage is "adapted"', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});
    await svc.updateReadiness('llama3.1:8b', 'host-b', 'adapted');
    const [, update] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(update.$set['readiness.host-b.stage']).toBe('adapted');
    expect(update.$set['readiness.host-b.adaptedAt']).toBeInstanceOf(Date);
  });

  it('sets stage + benchmarkedAt when stage is "benchmarked"', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});
    await svc.updateReadiness('gemma3:12b', 'host-a', 'benchmarked');
    const [, update] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(update.$set['readiness.host-a.stage']).toBe('benchmarked');
    expect(update.$set['readiness.host-a.benchmarkedAt']).toBeInstanceOf(Date);
  });

  it('merges extraFields into $set', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});
    await svc.updateReadiness('llama3.1:8b', 'host-a', 'profiled', { 'readiness.host-a.stale': false });
    const [, update] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(update.$set['readiness.host-a.stale']).toBe(false);
  });

  it('queries by model name', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});
    await svc.updateReadiness('phi4:14b', 'host-b', 'available');
    const [filter, , options] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ name: 'phi4:14b' });
    expect(options).toEqual({
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    });
  });
});

describe('updateThinkingCapability()', () => {
  it('sets top-level capability and host-specific thinking profile', async () => {
    ModelProfile.findOneAndUpdate.mockResolvedValue({});

    await svc.updateThinkingCapability('qwen3:8b', 'host-b', {
      profiledAt: new Date('2026-07-07T00:00:00Z'),
      supported: true,
      channel: 'hidden',
      visibleFinalAnswerOk: true,
      finalAnswerContractOk: true,
      thinkingOnlyResponse: false,
      runawayRisk: false,
      tokenMultiplier: 4,
      latencyMultiplier: 3,
      recommendedPolicy: 'metered',
      recommendationReason: 'safe but expensive'
    });

    const [filter, update, options] = ModelProfile.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ name: 'qwen3:8b' });
    expect(update.$set['capabilities.thinking']).toBe(true);
    expect(update.$set['capabilities.thinkingPolicy']).toBe('metered');
    expect(update.$set['thinkingProfiles.host-b']).toMatchObject({
      hostId: 'host-b',
      supported: true,
      channel: 'hidden',
      finalAnswerContractOk: true,
      recommendedPolicy: 'metered'
    });
    expect(options).toEqual({
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    });
  });
});

describe('getStalenessReport()', () => {
  it('queries ModelAdaptation for stale records', async () => {
    const staleRecords = [{ modelName: 'old:model', staleness: { stale: true, reason: 'age' } }];
    ModelAdaptation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(staleRecords) });

    const result = await svc.getStalenessReport();
    expect(ModelAdaptation.find).toHaveBeenCalledWith({ 'staleness.stale': true });
    expect(result).toEqual(staleRecords);
  });

  it('returns empty array when nothing is stale', async () => {
    ModelAdaptation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    const result = await svc.getStalenessReport();
    expect(result).toHaveLength(0);
  });
});

describe('getBenchmarkedModelNames()', () => {
  it('returns distinct successful benchmark model names normalized to base names', async () => {
    BenchmarkResult.distinct.mockResolvedValue([
      'gemma3:12b',
      'gemma3:12b:latest',
      'ax/phi4:14b',
      '',
      null
    ]);

    const result = await svc.getBenchmarkedModelNames();

    expect(BenchmarkResult.distinct).toHaveBeenCalledWith('model', { success: true });
    expect(result).toEqual(['gemma3:12b', 'phi4:14b']);
  });
});

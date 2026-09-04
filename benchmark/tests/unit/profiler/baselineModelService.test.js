'use strict';

const mockListModels = jest.fn();
const mockPullModel = jest.fn();
const mockHostProfileUpsert = jest.fn();
const mockGetAll = jest.fn();
const mockSave = jest.fn();

jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => [
    { id: 'primary', name: 'Host Alpha', url: 'http://primary:11434' },
    { id: 'tertiary', name: 'Host Gamma', url: 'http://tertiary:11434' }
  ])
}));

jest.mock('../../../src/clients/ollamaClient', () => ({
  listModels: (...args) => mockListModels(...args),
  pullModel: (...args) => mockPullModel(...args)
}));

jest.mock('../../../src/services/profiler/hostProfileService', () => ({
  upsert: (...args) => mockHostProfileUpsert(...args)
}));

jest.mock('../../../src/services/profiler/settingsService', () => ({
  getAll: (...args) => mockGetAll(...args),
  save: (...args) => mockSave(...args)
}));

jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const service = require('../../../src/services/profiler/baselineModelService');

describe('baselineModelService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAll.mockResolvedValue({ baselineModel: 'qwen2.5:3b' });
    mockHostProfileUpsert.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.OLLAMA_PULL_TIMEOUT_MS;
  });

  it('does not pull when the configured baseline is already installed', async () => {
    mockListModels.mockResolvedValue({ models: [{ name: 'qwen2.5:3b' }] });

    const result = await service.ensureBaselineModel('primary');

    expect(result).toMatchObject({ available: true, pulled: false, hostId: 'primary' });
    expect(mockPullModel).not.toHaveBeenCalled();
  });

  it('pulls a missing baseline on the selected configured host and verifies it', async () => {
    mockListModels
      .mockResolvedValueOnce({ models: [{ name: 'other:1b' }] })
      .mockResolvedValueOnce({ models: [{ name: 'qwen2.5:3b' }] });
    mockPullModel.mockResolvedValue({ status: 'success' });

    const result = await service.ensureBaselineModel('tertiary');

    expect(mockPullModel).toHaveBeenCalledWith(
      'http://tertiary:11434',
      'qwen2.5:3b',
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(result).toMatchObject({
      available: true,
      pulled: true,
      hostId: 'tertiary',
      hostName: 'Host Gamma'
    });
    expect(mockHostProfileUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'tertiary',
        reconciliation: expect.objectContaining({ state: 'pending_reconciliation', operation: 'baseline_pull' })
      }),
      expect.any(Object)
    );
  });

  it('rejects hosts outside the configured fleet before calling Ollama', async () => {
    await expect(service.ensureBaselineModel('unknown')).rejects.toThrow(/Unknown configured Ollama host/);
    expect(mockListModels).not.toHaveBeenCalled();
    expect(mockPullModel).not.toHaveBeenCalled();
  });

  it('persists durable pending reconciliation instead of treating short polling as terminal proof', async () => {
    const authorityLoss = Object.assign(new Error('workload heartbeat rejected'), { code: 'BENCHMARK_CLAIM_LOST' });
    mockListModels.mockResolvedValueOnce({ models: [] });
    mockPullModel.mockRejectedValue(authorityLoss);

    await expect(service.ensureBaselineModel('primary')).rejects.toMatchObject({
      code: 'BASELINE_PULL_RECONCILIATION_PENDING',
      retainAdmission: true,
      cause: authorityLoss
    });

    expect(mockHostProfileUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ reconciliation: expect.objectContaining({ state: 'pending_reconciliation' }) }),
      expect.any(Object)
    );
    expect(mockListModels).toHaveBeenCalledTimes(1);
  });

  it('keeps the reconciliation pending when authority is lost after pull acknowledgement', async () => {
    const authorityLoss = Object.assign(new Error('claim lost after pull acknowledgement'), { code: 'BENCHMARK_CLAIM_LOST' });
    mockListModels.mockResolvedValueOnce({ models: [] });
    let pulled = false;
    mockPullModel.mockImplementation(async () => { pulled = true; return { status: 'success' }; });
    const assertClaimActive = jest.fn(() => { if (pulled) throw authorityLoss; });

    await expect(service.ensureBaselineModel('primary', { assertClaimActive })).rejects.toMatchObject({
      code: 'BASELINE_PULL_RECONCILIATION_PENDING',
      retainAdmission: true,
      cause: authorityLoss
    });

    expect(mockPullModel).toHaveBeenCalledTimes(1);
    expect(mockListModels).toHaveBeenCalledTimes(1);
  });
});

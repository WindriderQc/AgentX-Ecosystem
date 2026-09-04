'use strict';

const mockListModels = jest.fn();
const mockPullModel = jest.fn();
const mockDeleteModel = jest.fn();
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
  pullModel: (...args) => mockPullModel(...args),
  deleteModel: (...args) => mockDeleteModel(...args)
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
    process.env.PROFILER_PULL_COMPENSATION_SETTLE_MS = '0';
  });

  afterEach(() => {
    delete process.env.PROFILER_PULL_COMPENSATION_SETTLE_MS;
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
  });

  it('rejects hosts outside the configured fleet before calling Ollama', async () => {
    await expect(service.ensureBaselineModel('unknown')).rejects.toThrow(/Unknown configured Ollama host/);
    expect(mockListModels).not.toHaveBeenCalled();
    expect(mockPullModel).not.toHaveBeenCalled();
  });

  it('inventories and removes an artifact that arrives after an aborted pull', async () => {
    const authorityLoss = Object.assign(new Error('workload heartbeat rejected'), { code: 'BENCHMARK_CLAIM_LOST' });
    mockListModels
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [{ name: 'qwen2.5:3b' }] })
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [] });
    mockPullModel.mockRejectedValue(authorityLoss);
    mockDeleteModel.mockResolvedValue({ status: 'success' });

    await expect(service.ensureBaselineModel('primary')).rejects.toBe(authorityLoss);

    expect(mockDeleteModel).toHaveBeenCalledWith(
      'http://primary:11434',
      'qwen2.5:3b',
      expect.objectContaining({ timeoutMs: 120_000 })
    );
    expect(mockListModels).toHaveBeenCalledTimes(5);
  });

  it('removes a newly installed artifact when claim authority is lost after pull acknowledgement', async () => {
    const authorityLoss = Object.assign(new Error('claim lost after pull acknowledgement'), { code: 'BENCHMARK_CLAIM_LOST' });
    mockListModels
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [{ name: 'qwen2.5:3b' }] })
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [] });
    mockPullModel.mockResolvedValue({ status: 'success' });
    mockDeleteModel.mockResolvedValue({ status: 'success' });
    let assertionCount = 0;
    const assertClaimActive = jest.fn(() => {
      assertionCount += 1;
      if (assertionCount === 4) throw authorityLoss;
    });

    await expect(service.ensureBaselineModel('primary', { assertClaimActive })).rejects.toBe(authorityLoss);

    expect(mockPullModel).toHaveBeenCalledTimes(1);
    expect(mockDeleteModel).toHaveBeenCalledWith(
      'http://primary:11434',
      'qwen2.5:3b',
      expect.objectContaining({ timeoutMs: 120_000 })
    );
    expect(mockListModels).toHaveBeenCalledTimes(5);
  });
});

'use strict';

const mockListModels = jest.fn();
const mockPullModel = jest.fn();
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
});

'use strict';

jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../models/HostProfile');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

describe('validateModelfile()', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.mock('../../../models/ModelAdaptation');
    jest.mock('../../../models/HostProfile');
    jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

    global.fetch = jest.fn();
    service = require('../../../src/services/profiler/adaptationService');
  });

  afterEach(() => {
    delete global.fetch;
  });

  const mockTagsResponse = (models) => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: models.map(name => ({ name })) })
    });
  };

  it('passes a valid Modelfile with existing model on host', async () => {
    mockTagsResponse(['llama3.1:8b-q4_K_M', 'gemma2:9b']);

    const content = [
      'FROM llama3.1:8b-q4_K_M',
      '',
      'PARAMETER num_ctx 8192',
      'PARAMETER temperature 0.7'
    ].join('\n');

    const result = await service.validateModelfile(content, 'http://192.0.2.66:11434');

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('fails when FROM model not found on host', async () => {
    mockTagsResponse(['gemma2:9b', 'phi3:mini']);

    const content = 'FROM llama3.1:8b-q4_K_M\nPARAMETER num_ctx 8192';

    const result = await service.validateModelfile(content, 'http://192.0.2.66:11434');

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('not found on host')])
    );
  });

  it('fails when FROM line is missing', async () => {
    const content = [
      '# Just some comments',
      'PARAMETER num_ctx 8192',
      'PARAMETER temperature 0.7'
    ].join('\n');

    const result = await service.validateModelfile(content, 'http://192.0.2.66:11434');

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing FROM directive')])
    );
    // Should not have called fetch since there's no model to check
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('warns on unknown PARAMETER names but still passes', async () => {
    mockTagsResponse(['llama3.1:8b-q4_K_M']);

    const content = [
      'FROM llama3.1:8b-q4_K_M',
      'PARAMETER num_ctx 8192',
      'PARAMETER banana 42'
    ].join('\n');

    const result = await service.validateModelfile(content, 'http://192.0.2.66:11434');

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown parameter "banana"')])
    );
  });

  it('fails when num_ctx is non-numeric', async () => {
    mockTagsResponse(['llama3.1:8b-q4_K_M']);

    const content = [
      'FROM llama3.1:8b-q4_K_M',
      'PARAMETER num_ctx large'
    ].join('\n');

    const result = await service.validateModelfile(content, 'http://192.0.2.66:11434');

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('num_ctx')])
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('numeric')])
    );
  });
});

'use strict';

jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../models/HostProfile');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

// Mock namingConvention — isAdaptedModel returns true only for names with ax/ prefix
jest.mock('../../../src/services/profiler/namingConvention', () => ({
  buildAdaptedName: jest.fn(),
  parseAdaptedName: jest.fn(),
  isAdaptedModel: jest.fn((name) => typeof name === 'string' && name.startsWith('ax/')),
  AX_PREFIX: 'ax/'
}));

describe('populateLineage()', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    jest.mock('../../../models/ModelAdaptation');
    jest.mock('../../../models/HostProfile');
    jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
    jest.mock('../../../src/services/profiler/namingConvention', () => ({
      buildAdaptedName: jest.fn(),
      parseAdaptedName: jest.fn(),
      isAdaptedModel: jest.fn((name) => typeof name === 'string' && name.startsWith('ax/')),
      AX_PREFIX: 'ax/'
    }));

    // Use REAL parseQuantization — it's a pure utility
    jest.unmock('../../../src/services/parameterDetection');

    service = require('../../../src/services/profiler/adaptationService');
  });

  it('extracts root model by stripping quantization suffix', () => {
    const result = service.populateLineage('llama3.1:8b-q4_K_M');

    expect(result.parentModel).toBe('llama3.1:8b-q4_K_M');
    expect(result.rootModel).toBe('llama3.1:8b');
    expect(result.quantization).toBe('Q4_K_M');
    expect(result.adaptedFrom).toBeNull();
    expect(result.createdVia).toBe('profiler');
  });

  it('handles models without quantization', () => {
    const result = service.populateLineage('llama3.1:8b');

    expect(result.parentModel).toBe('llama3.1:8b');
    expect(result.rootModel).toBe('llama3.1:8b');
    expect(result.quantization).toBeNull();
    expect(result.adaptedFrom).toBeNull();
    expect(result.createdVia).toBe('profiler');
  });

  it('detects already-adapted parent models and sets adaptedFrom', () => {
    const result = service.populateLineage('ax/llama3.1:8b-q4_K_M');

    expect(result.parentModel).toBe('ax/llama3.1:8b-q4_K_M');
    expect(result.adaptedFrom).toBe('ax/llama3.1:8b-q4_K_M');
  });

  it('marks manual createdVia when passed', () => {
    const result = service.populateLineage('llama3.1:8b', 'manual');

    expect(result.createdVia).toBe('manual');
    expect(result.parentModel).toBe('llama3.1:8b');
  });
});

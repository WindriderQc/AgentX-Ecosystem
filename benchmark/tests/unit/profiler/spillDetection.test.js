'use strict';

jest.mock('../../../src/services/hostTestService');
jest.mock('../../../src/services/contextProbeService');
jest.mock('../../../src/services/profiler/modelProfileService');
jest.mock('../../../src/services/profiler/adaptationService');
jest.mock('../../../src/services/profiler/hostProfileService');
jest.mock('../../../src/services/profiler/settingsService');
jest.mock('../../../src/services/profiler/namingConvention');
jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');

const HOST_URL = 'http://192.0.2.66:11434';
const MODEL_NAME = 'llama3:8b';

describe('_detectSpill()', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns no spill when size_vram === size (fully on GPU)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{
          name: MODEL_NAME,
          size: 4_000_000_000,
          size_vram: 4_000_000_000
        }]
      })
    });

    const result = await orchestrator._detectSpill(HOST_URL, MODEL_NAME);

    expect(result.spillDetected).toBe(false);
    expect(result.lastSafeNumCtx).toBeNull();
    expect(result.spillNumCtx).toBeNull();
    expect(result.vramAtSpill).toBeNull();
    expect(result.sizeVram).toBe(4_000_000_000);
    expect(result.sizeTotal).toBe(4_000_000_000);
  });

  it('detects spill when size_vram < size', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{
          name: MODEL_NAME,
          size: 4_000_000_000,
          size_vram: 3_000_000_000
        }]
      })
    });

    const result = await orchestrator._detectSpill(HOST_URL, MODEL_NAME);

    expect(result.spillDetected).toBe(true);
    expect(result.lastSafeNumCtx).toBeNull();
    expect(result.spillNumCtx).toBeNull();
    expect(result.vramAtSpill).toBe(Math.round(3_000_000_000 / (1024 * 1024)));
    expect(result.sizeVram).toBe(3_000_000_000);
    expect(result.sizeTotal).toBe(4_000_000_000);
  });

  it('returns safe defaults when model not found in /api/ps', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{
          name: 'some-other-model:7b',
          size: 2_000_000_000,
          size_vram: 2_000_000_000
        }]
      })
    });

    const result = await orchestrator._detectSpill(HOST_URL, MODEL_NAME);

    expect(result.spillDetected).toBe(false);
    expect(result.lastSafeNumCtx).toBeNull();
    expect(result.spillNumCtx).toBeNull();
    expect(result.vramAtSpill).toBeNull();
    expect(result.sizeVram).toBeNull();
    expect(result.sizeTotal).toBeNull();
  });

  it('handles fetch failure gracefully', async () => {
    global.fetch.mockRejectedValue(new Error('Connection refused'));

    const result = await orchestrator._detectSpill(HOST_URL, MODEL_NAME);

    expect(result.spillDetected).toBe(false);
    expect(result.lastSafeNumCtx).toBeNull();
    expect(result.spillNumCtx).toBeNull();
    expect(result.vramAtSpill).toBeNull();
    expect(result.sizeVram).toBeNull();
    expect(result.sizeTotal).toBeNull();
  });

  it('matches model with :latest suffix fallback', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{
          name: 'llama3:8b:latest',
          size: 4_000_000_000,
          size_vram: 4_000_000_000
        }]
      })
    });

    // Searching for 'llama3:8b' should also try 'llama3:8b:latest'
    const result = await orchestrator._detectSpill(HOST_URL, MODEL_NAME);

    expect(result.spillDetected).toBe(false);
    expect(result.sizeVram).toBe(4_000_000_000);
    expect(result.sizeTotal).toBe(4_000_000_000);
  });
});

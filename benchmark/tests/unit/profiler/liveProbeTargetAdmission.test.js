'use strict';

jest.mock('../../../src/services/profiler/hostProfileService', () => ({
  getByUrl: jest.fn(),
  upsertMetadata: jest.fn()
}));
jest.mock('../../../src/services/hostTestService', () => ({
  checkHost: jest.fn()
}));
jest.mock('../../../src/clients/ollamaClient', () => ({
  listRunning: jest.fn()
}));
jest.mock('../../../src/helpers/ollamaHostConfig', () => {
  const actual = jest.requireActual('../../../src/helpers/ollamaHostConfig');
  return {
    ...actual,
    getConfiguredHosts: jest.fn(() => [])
  };
});

const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const { checkHost } = require('../../../src/services/hostTestService');
const { detectOllamaHost, _internal } = require('../../../src/services/profiler/liveProbeService');

describe('live profiler target admission', () => {
  afterEach(() => jest.clearAllMocks());

  test('rejects a forbidden target before any network probe or persistence', async () => {
    await expect(detectOllamaHost({
      hostUrl: 'http://ollama:11434/?next=http://169.254.169.254/latest/meta-data'
    })).rejects.toMatchObject({
      code: 'OLLAMA_TARGET_REJECTED',
      statusCode: 400
    });

    expect(checkHost).not.toHaveBeenCalled();
    expect(hostProfileService.getByUrl).not.toHaveBeenCalled();
    expect(hostProfileService.upsertMetadata).not.toHaveBeenCalled();
  });

  test('admits and normalizes a Docker Ollama service before probing and persistence', async () => {
    checkHost.mockResolvedValue({ available: true, latency: 12, models: ['qwen:7b'] });
    hostProfileService.getByUrl.mockResolvedValue(null);
    hostProfileService.upsertMetadata.mockImplementation(async (value) => value);

    const result = await detectOllamaHost({
      hostUrl: 'ollama:11434/',
      displayName: 'Compose Ollama'
    });

    expect(checkHost).toHaveBeenCalledWith('http://ollama:11434');
    expect(hostProfileService.upsertMetadata).toHaveBeenCalledWith(expect.objectContaining({
      hostUrl: 'http://ollama:11434',
      displayName: 'Compose Ollama',
      status: 'online'
    }));
    expect(result.detection).toMatchObject({ available: true, modelCount: 1 });
  });

  test('keeps unavailable lab metrics explicitly unknown without inventing zero telemetry', () => {
    const telemetry = _internal.summarizeTelemetry({ ok: true, models: [] }, {
      gpu: { name: 'GPU', vramTotalMiB: 24576 }
    });
    expect(telemetry).toMatchObject({
      ok: true,
      source: 'ollama-ps',
      vramUsedMiB: 0,
      utilization: null,
      temperature: null,
      powerDrawW: null,
      capability: {
        contract: 'agentx.profiler-hardware-capability/v1',
        status: 'partial',
        qualificationAuthority: 'none',
        collector: {
          requiredContract: 'agentx.profiler-hardware-collector/v1',
          status: 'not_configured',
          ownershipBoundary: 'deployment_extension'
        }
      }
    });
    expect(telemetry.capability.metrics.temperature).toEqual({ status: 'unknown', source: 'none' });
    expect(telemetry.capability.metrics.topology).toEqual({ status: 'unknown', source: 'none' });
  });
});

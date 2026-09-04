'use strict';

const mockEvidenceFind = jest.fn();
const mockModelFind = jest.fn();
const mockGetHost = jest.fn();
const mockGetLiveProbe = jest.fn();
const mockCheckHost = jest.fn();

jest.mock('../../../models/ModelPerformanceProfile', () => ({ find: (...args) => mockEvidenceFind(...args) }));
jest.mock('../../../models/ModelProfile', () => ({ find: (...args) => mockModelFind(...args) }));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({ getById: (...args) => mockGetHost(...args) }));
jest.mock('../../../src/services/profiler/liveProbeService', () => ({ getLiveProbeStatus: (...args) => mockGetLiveProbe(...args) }));
jest.mock('../../../src/services/hostTestService', () => ({ checkHost: (...args) => mockCheckHost(...args) }));
jest.mock('../../../config/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildHostFitReport } = require('../../../src/services/profiler/hostFitReportService');

function leanResult(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function selectLean(value) {
  return { select: jest.fn(() => leanResult(value)) };
}

function readiness(overrides = {}) {
  return {
    artifact: { digest: 'sha256:model', runtimeFingerprint: 'runtime-a', registryQualified: true },
    evidenceId: 'evidence-1',
    profileDepth: 'standard',
    benchmarkQualified: true,
    stale: false,
    authorityReceipt: {
      version: 1,
      source: 'profiler_pipeline',
      evidenceId: 'evidence-1',
      digest: 'a'.repeat(64)
    },
    ...overrides
  };
}

describe('Host Fit authority gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHost.mockResolvedValue({
      hostId: 'host-a',
      hostUrl: 'http://host-a:11434',
      displayName: 'Host A',
      status: 'ready',
      gpu: { vramTotalMiB: 24576 },
      baseline: null
    });
    mockGetLiveProbe.mockResolvedValue({ telemetry: { vramTotalMiB: 24576 } });
    mockCheckHost.mockResolvedValue({ available: true, models: ['qwen:7b'] });
    mockEvidenceFind.mockReturnValue(leanResult([{
      _id: 'evidence-1',
      modelName: 'qwen:7b',
      artifact: { digest: 'sha256:model', runtimeFingerprint: 'runtime-a', registryQualified: true },
      profile: {
        profileDepth: 'standard',
        tokensPerSec: 50,
        recommendedInteractiveContext: 32768,
        recommendedDocumentContext: 65536,
        maxVerifiedContext: 262144,
        measurementQuality: { reliability: 'high' },
        spill: { verified: true, spillDetected: false, sizeTotal: 8 * 1024 * 1024 * 1024 }
      }
    }]));
  });

  test.each([
    ['Quick evidence', readiness({ profileDepth: 'quick' })],
    ['non-qualified evidence', readiness({ benchmarkQualified: false })],
    ['receipt-less evidence', readiness({ authorityReceipt: null })]
  ])('treats %s as unprofiled instead of recommendation authority', async (_label, hostReadiness) => {
    mockModelFind.mockReturnValue(selectLean([{
      name: 'qwen:7b',
      parameters: '7B',
      quantization: 'Q4_K_M',
      readiness: { 'host-a': hostReadiness }
    }]));

    const report = await buildHostFitReport('host-a');
    expect(report.measured).toHaveLength(0);
    expect(report.estimated).toHaveLength(1);
  });

  test('accepts exact Standard profiler authority and keeps max capacity separate from recommendations', async () => {
    mockModelFind.mockReturnValue(selectLean([{
      name: 'qwen:7b',
      parameters: '7B',
      quantization: 'Q4_K_M',
      readiness: { 'host-a': readiness() }
    }]));

    const report = await buildHostFitReport('host-a');
    expect(report.measured).toEqual([expect.objectContaining({
      modelName: 'qwen:7b',
      maxVerifiedContext: 262144,
      recommendedInteractiveContext: 32768,
      recommendedDocumentContext: 65536
    })]);
  });
});

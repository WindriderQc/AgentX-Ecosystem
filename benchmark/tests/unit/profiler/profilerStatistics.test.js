'use strict';

jest.mock('../../../src/services/hostTestService', () => ({}));
jest.mock('../../../src/services/contextProbeService', () => ({}));
jest.mock('../../../src/services/profiler/modelProfileService', () => ({}));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({}));
jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({}));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({}));
jest.mock('../../../src/services/profiler/settingsService', () => ({}));
jest.mock('../../../src/services/profiler/liveProbeService', () => ({}));
jest.mock('../../../src/services/profiler/prefillDecodeMatrix', () => ({}));
jest.mock('../../../src/services/profiler/thinkingProfileService', () => ({}));
jest.mock('../../../src/services/modelContextResolver', () => ({}));
jest.mock('../../../src/clients/ollamaClient', () => ({}));
jest.mock('../../../models/ModelProfile', () => ({}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/services/benchmark/buddySurfaceEvents', () => ({}));

const { summarizeThroughputSamples } = require('../../../src/services/profiler/profilerOrchestrator');

describe('profiler retained-sample statistics', () => {
  it('excludes discarded samples and reports p50/p95/CV/95% CI', () => {
    const summary = summarizeThroughputSamples([
      { status: 'pass', tokensPerSec: 999, discarded: true },
      ...[10, 11, 12, 13, 14].map(tokensPerSec => ({ status: 'pass', tokensPerSec }))
    ], { minimumRetainedSamples: 5 });

    expect(summary).toMatchObject({
      retainedSampleCount: 5,
      passingSampleCount: 5,
      tokensPerSecMean: 12,
      p50: 12,
      p95: 13.8
    });
    expect(summary.tokensPerSecMax).toBe(14);
    expect(summary.confidenceInterval95).toEqual(expect.objectContaining({ method: 'normal_approximation' }));
    expect(summary.reliability).not.toBe('unknown');
  });

  it('keeps reliability unknown below the requested retained minimum', () => {
    const summary = summarizeThroughputSamples([
      { status: 'pass', tokensPerSec: 10 },
      { status: 'pass', tokensPerSec: 11 }
    ], { minimumRetainedSamples: 5 });
    expect(summary.reliability).toBe('unknown');
  });
});

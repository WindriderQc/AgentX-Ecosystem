'use strict';

const {
  buildRuntimeFingerprint,
  exactModelNamesMatch,
  normalizeHostUrl,
  stableSerialize
} = require('../../../shared/artifactIdentity');
const {
  _normalizeReadinessEntry,
  clearReadinessCache,
  getBestReadiness,
  loadReadinessIndex
} = require('../../src/services/modelReadinessService');

function profilerV2Authority() {
  return {
    authorityVerified: true,
    authority: {
      contract: 'agentx.profiler-readiness/v2',
      verified: true,
      receiptVersion: 2,
      receiptVerified: true,
      liveIdentityVerified: true,
      evidenceQualified: true
    }
  };
}

describe('exact artifact identity', () => {
  it('preserves namespaces while accepting only the implicit latest alias', () => {
    expect(exactModelNamesMatch('owner/model:latest', 'owner/model')).toBe(true);
    expect(exactModelNamesMatch('AX/Model:8B', 'ax/model:8b')).toBe(true);
    expect(exactModelNamesMatch('ax/model:8b', 'model:8b')).toBe(false);
  });

  it('builds a deterministic fingerprint from runtime-relevant host fields', () => {
    const left = {
      hostId: 'host-a',
      hostUrl: 'HTTP://HOST-A:11434/',
      gpu: { model: 'GPU', vramTotalMiB: 24576 },
      ollama: { version: '1.0.0', backend: 'cuda' }
    };
    const reordered = {
      ollama: { backend: 'cuda', version: '1.0.0' },
      gpu: { vramTotalMiB: 24576, model: 'GPU' },
      hostUrl: 'http://host-a:11434',
      hostId: 'host-a'
    };

    expect(buildRuntimeFingerprint(left)).toBe(buildRuntimeFingerprint(reordered));
    expect(buildRuntimeFingerprint({ ...left, ollama: { version: '1.1.0', backend: 'cuda' } }))
      .not.toBe(buildRuntimeFingerprint(left));
    expect(normalizeHostUrl(left.hostUrl)).toBe('http://host-a:11434');
    expect(stableSerialize({ b: 1, a: 2 })).toBe(stableSerialize({ a: 2, b: 1 }));
  });

  it('marks only current benchmark-qualified readiness as ready', () => {
    expect(_normalizeReadinessEntry({
      stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, stale: false,
      ...profilerV2Authority()
    }).isReady).toBe(true);
    expect(_normalizeReadinessEntry({
      stage: 'available', profileDepth: 'full', benchmarkQualified: true, stale: false,
      ...profilerV2Authority()
    }).isReady).toBe(true);
    expect(_normalizeReadinessEntry({
      stage: 'profiled', profileDepth: 'quick', benchmarkQualified: false, stale: false
    }).isReady).toBe(false);
    expect(_normalizeReadinessEntry({
      stage: 'benchmarked', profileDepth: 'full', benchmarkQualified: true, stale: true
    }).isReady).toBe(false);
  });

  it('selects current qualified evidence ahead of a higher legacy display stage', () => {
    expect(getBestReadiness({
      'host-stale': {
        stage: 'benchmarked', profileDepth: 'full', benchmarkQualified: true, stale: true
      },
      'host-current': {
        stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, stale: false,
        ...profilerV2Authority()
      }
    })).toMatchObject({ hostId: 'host-current', isReady: true });
  });

  it('loads readiness through the Benchmark evidence client', async () => {
    clearReadinessCache();
    const benchmarkClient = {
      getReadinessProfiles: jest.fn(async () => [{
        name: 'owner/model:8b',
        readiness: {
          'host-a': {
            stage: 'profiled',
            profileDepth: 'standard',
            benchmarkQualified: true,
            stale: false,
            ...profilerV2Authority()
          }
        }
      }])
    };

    const index = await loadReadinessIndex({ useCache: false, benchmarkClient });

    expect(benchmarkClient.getReadinessProfiles).toHaveBeenCalledTimes(1);
    expect(index.get('owner/model:8b').bestReadiness).toMatchObject({
      hostId: 'host-a',
      isReady: true
    });
  });
});

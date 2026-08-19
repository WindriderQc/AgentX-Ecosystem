'use strict';

const {
  hasExactArtifact,
  retireLegacyReadiness
} = require('../../scripts/migrate-exact-artifact-profile-indexes');

const exactArtifact = {
  model: 'qwen3.5:9b',
  hostId: 'host-alpha',
  hostUrl: 'http://host-alpha:11434',
  digest: 'sha256:one',
  runtimeFingerprint: 'runtime-one',
  registryQualified: true
};

describe('exact-artifact profile migration', () => {
  it('recognizes only complete registry-qualified identities', () => {
    expect(hasExactArtifact(exactArtifact)).toBe(true);
    expect(hasExactArtifact({ ...exactArtifact, digest: null })).toBe(false);
    expect(hasExactArtifact({ ...exactArtifact, registryQualified: false })).toBe(false);
  });

  it('retires legacy readiness without upgrading it to benchmark-qualified evidence', () => {
    const result = retireLegacyReadiness({
      'host-alpha': {
        stage: 'adapted',
        adaptedAt: new Date('2026-01-01T00:00:00Z'),
        benchmarkQualified: true
      }
    });

    expect(result.changed).toBe(true);
    expect(result.readiness['host-alpha']).toMatchObject({
      stage: 'profiled',
      profileDepth: null,
      benchmarkQualified: false,
      stale: true,
      staleReason: 'legacy_profile_without_exact_artifact_identity'
    });
    expect(result.readiness['host-alpha']).not.toHaveProperty('adaptedAt');
  });

  it('preserves current exact-artifact readiness unchanged', () => {
    const readiness = {
      'host-alpha': {
        stage: 'benchmarked',
        profileDepth: 'standard',
        benchmarkQualified: true,
        stale: false,
        artifact: exactArtifact
      }
    };

    const result = retireLegacyReadiness(readiness);
    expect(result).toEqual({ changed: false, readiness });
  });
});

'use strict';

const {
  createProfilerAuthorityReceipt,
  verifyProfilerAuthorityReceipt,
  hasQualifiedProfilerAuthority
} = require('../../../src/services/profiler/profilerAuthorityReceipt');

const ARTIFACT = {
  model: 'qwen3:30b',
  hostId: 'host-alpha',
  hostUrl: 'http://192.0.2.10:11434',
  digest: 'sha256:model-a',
  runtimeFingerprint: 'ollama-1',
  registryId: 'registry-a',
  registryDigest: 'sha256:registry-a',
  registryQualified: true
};

function evidence() {
  return {
    _id: 'evidence-a',
    modelName: 'qwen3:30b',
    hostId: 'host-alpha',
    artifact: ARTIFACT,
    profile: {
      profileDepth: 'full',
      requiredRetainedSamples: 10,
      benchmarkQualified: true,
      qualificationFailures: [],
      measurementQuality: {
        passingSampleCount: 10,
        reliability: 'high',
        coefficientOfVariation: 0.04,
        confidence95: { low: 41, high: 44 }
      },
      tokensPerSec: 42.5,
      ttftP50Ms: 180,
      ttftP95Ms: 230,
      maxVerifiedContext: 262144,
      recommendedInteractiveContext: 8192,
      recommendedDocumentContext: 32768,
      gpu: { spillStatus: 'no_spill', sizeVram: 20_000_000_000 },
      throughputCurve: [{ concurrency: 1, tokensPerSec: 42.5 }],
      generationStability: { coefficientOfVariation: 0.03 },
      prefillDecodeMatrix: [{ promptTokens: 1024, decodeTokens: 128, prefillTokensPerSec: 700, decodeTokensPerSec: 42 }],
      loadTiming: { coldMs: 1800, warmMs: 120 },
      artifact: ARTIFACT
    }
  };
}

describe('profilerAuthorityReceipt', () => {
  it('recomputes the canonical evidence digest', () => {
    const record = evidence();
    const authorityReceipt = createProfilerAuthorityReceipt({
      ...record,
      profile: record.profile,
      evidenceId: record._id
    });
    const readiness = { evidenceId: record._id, authorityReceipt };

    expect(verifyProfilerAuthorityReceipt(readiness, record, {
      modelName: record.modelName,
      hostId: record.hostId
    })).toBe(true);
  });

  it('never promotes a sealed non-qualified profile through a forged readiness flag', () => {
    const record = evidence();
    record.profile.benchmarkQualified = false;
    const authorityReceipt = createProfilerAuthorityReceipt({
      ...record,
      profile: record.profile,
      evidenceId: record._id
    });
    const readiness = {
      evidenceId: record._id,
      benchmarkQualified: true,
      stale: false,
      profileDepth: 'full',
      authorityReceipt
    };

    expect(verifyProfilerAuthorityReceipt(readiness, record, {
      modelName: record.modelName,
      hostId: record.hostId
    })).toBe(true);
    expect(hasQualifiedProfilerAuthority(readiness, record, {
      modelName: record.modelName,
      hostId: record.hostId
    })).toBe(false);
  });

  it.each([
    ['well-formed forged digest', receipt => { receipt.digest = '0'.repeat(64); }],
    ['changed artifact digest', (_receipt, record) => { record.artifact = { ...record.artifact, digest: 'sha256:model-b' }; }],
    ['changed sample authority', (_receipt, record) => { record.profile.measurementQuality.passingSampleCount = 9; }],
    ['changed qualification decision', (_receipt, record) => { record.profile.benchmarkQualified = false; }],
    ['changed context recommendation', (_receipt, record) => { record.profile.recommendedInteractiveContext = 262144; }],
    ['changed context maximum', (_receipt, record) => { record.profile.maxVerifiedContext = 8192; }],
    ['changed throughput', (_receipt, record) => { record.profile.tokensPerSec = 999; }],
    ['changed TTFT distribution', (_receipt, record) => { record.profile.ttftP95Ms = 9999; }],
    ['changed confidence interval', (_receipt, record) => { record.profile.measurementQuality.confidence95.high = 99; }],
    ['changed GPU spill evidence', (_receipt, record) => { record.profile.gpu.spillStatus = 'unknown'; }],
    ['changed matrix evidence', (_receipt, record) => { record.profile.prefillDecodeMatrix[0].decodeTokensPerSec = 99; }],
    ['changed load timing', (_receipt, record) => { record.profile.loadTiming.coldMs = 99; }],
    ['changed issuance time', receipt => { receipt.issuedAt = '2099-01-01T00:00:00.000Z'; }],
    ['changed evidence identity', receipt => { receipt.evidenceId = 'evidence-b'; }]
  ])('rejects %s', (_label, mutate) => {
    const record = evidence();
    const authorityReceipt = createProfilerAuthorityReceipt({
      ...record,
      profile: record.profile,
      evidenceId: record._id
    });
    mutate(authorityReceipt, record);

    expect(verifyProfilerAuthorityReceipt({ evidenceId: record._id, authorityReceipt }, record, {
      modelName: record.modelName,
      hostId: record.hostId
    })).toBe(false);
  });
});

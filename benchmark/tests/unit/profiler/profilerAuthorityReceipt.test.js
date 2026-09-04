'use strict';

const {
  createProfilerAuthorityReceipt,
  verifyProfilerAuthorityReceipt
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
      measurementQuality: { passingSampleCount: 10 }
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

  it.each([
    ['well-formed forged digest', receipt => { receipt.digest = '0'.repeat(64); }],
    ['changed artifact digest', (_receipt, record) => { record.artifact = { ...record.artifact, digest: 'sha256:model-b' }; }],
    ['changed sample authority', (_receipt, record) => { record.profile.measurementQuality.passingSampleCount = 9; }],
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

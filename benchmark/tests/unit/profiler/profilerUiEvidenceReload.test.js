'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadClassifier() {
  const file = path.resolve(__dirname, '..', '..', '..', 'public', 'js', 'model-profiler', 'models-helpers.js');
  const source = fs.readFileSync(file, 'utf8').replace(/\bexport\s+/g, '');
  const context = { result: null };
  vm.runInNewContext(`${source}\nresult = classifyProfileEvidence;`, context);
  return context.result;
}

const classifyProfileEvidence = loadClassifier();
const digest = 'a'.repeat(64);
const evidence = {
  _id: 'evidence-1',
  active: true,
  stale: false,
  artifact: { digest: 'sha256:model', runtimeFingerprint: 'runtime-1' },
  profile: {
    profileDepth: 'full',
    recommendedInteractiveContext: 32768,
    recommendedDocumentContext: 65536
  }
};

function modelWithReadiness(overrides = {}) {
  return {
    readiness: {
      'host-a': {
        profileDepth: 'full',
        benchmarkQualified: true,
        authorityVerified: true,
        stale: false,
        evidenceId: 'evidence-1',
        artifact: { digest: 'sha256:model', runtimeFingerprint: 'runtime-1' },
        authority: {
          contract: 'agentx.profiler-readiness/v2',
          verified: true,
          liveIdentityVerified: true
        },
        authorityReceipt: {
          source: 'profiler_pipeline',
          version: 2,
          digest,
          evidenceId: 'evidence-1'
        },
        ...overrides
      }
    }
  };
}

describe('profiler UI reload authority reconstruction', () => {
  test('restores Qualified only from an exact Standard/Full authority receipt', () => {
    expect(classifyProfileEvidence(modelWithReadiness(), evidence, 'host-a')).toEqual(expect.objectContaining({
      status: 'qualified',
      benchmarkQualified: true,
      recommendationsAuthoritative: true
    }));
  });

  test('keeps a completed but unqualified Full profile non-authoritative after reload', () => {
    expect(classifyProfileEvidence(
      modelWithReadiness({ benchmarkQualified: false, qualificationReason: 'full_prefill_decode_matrix_incomplete' }),
      evidence,
      'host-a'
    )).toEqual(expect.objectContaining({
      status: 'not_qualified',
      benchmarkQualified: false,
      recommendationsAuthoritative: false,
      reason: 'full_prefill_decode_matrix_incomplete'
    }));
  });

  test('stale readiness dominates a previously valid receipt', () => {
    expect(classifyProfileEvidence(
      modelWithReadiness({ stale: true, staleReason: 'artifact_changed' }),
      evidence,
      'host-a'
    )).toEqual(expect.objectContaining({
      status: 'stale',
      benchmarkQualified: false,
      recommendationsAuthoritative: false,
      reason: 'artifact_changed'
    }));
  });

  test('rejects a mismatched evidence receipt after reload', () => {
    expect(classifyProfileEvidence(modelWithReadiness(), { ...evidence, _id: 'foreign-evidence' }, 'host-a'))
      .toEqual(expect.objectContaining({ status: 'not_qualified', recommendationsAuthoritative: false }));
  });
});

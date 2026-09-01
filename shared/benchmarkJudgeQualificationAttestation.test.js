'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { fingerprint } = require('./workerContract');
const {
  BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
  computeBenchmarkJudgeQualificationAttestationId,
  serializeBenchmarkJudgeQualificationAttestationSigningPayload,
  verifyBenchmarkJudgeQualificationAttestation,
} = require('./benchmarkJudgeQualificationAttestation');

function fixtureBody(workerIdentity) {
  return {
    schema: BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
    issuer: { issuerId: 'review-board', keyId: 'judge-key-v1' },
    issuedAt: '2026-08-31T00:00:00.000Z',
    validUntil: '2026-10-01T00:00:00.000Z',
    nonce: 'judge-qualification-nonce-000000001',
    judge: {
      identityFingerprint: fingerprint(workerIdentity),
      rubricFingerprint: '2'.repeat(64),
      corpusFingerprint: '3'.repeat(64),
      holdoutFingerprint: '4'.repeat(64),
      workerIdentity,
    },
    evidence: {
      status: 'qualified',
      validationSampleCount: 70,
      holdoutSampleCount: 105,
      overallMaeMicros: 900000,
      overallToleranceBasisPoints: 8600,
      reviewPrecisionBasisPoints: 8200,
      reviewRecallBasisPoints: 8300,
      spearmanBasisPoints: 8400,
      categoryMetrics: [
        'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation',
      ].map(category => ({
        category,
        validationSampleCount: 10,
        holdoutSampleCount: 15,
        maeMicros: 900000,
        toleranceBasisPoints: 8600,
        difficultyMetrics: [1, 2, 3, 4, 5].map(difficulty => ({
          difficulty,
          validationSampleCount: 2,
          holdoutSampleCount: 3,
          maeMicros: 900000,
          toleranceBasisPoints: 8600,
        })),
      })),
    },
  };
}

function signedFixture(keyPair, workerIdentity, overrides = {}) {
  const body = { ...fixtureBody(workerIdentity), ...overrides };
  const attestationId = computeBenchmarkJudgeQualificationAttestationId(body);
  const signature = crypto.sign(
    null,
    Buffer.from(serializeBenchmarkJudgeQualificationAttestationSigningPayload(body, attestationId), 'utf8'),
    keyPair.privateKey
  ).toString('base64url');
  return { ...body, attestationId, signature };
}

const keyPair = crypto.generateKeyPairSync('ed25519');
const workerIdentity = {
    harness: { name: 'judge-harness', version: '1.0.0' },
    adapter: { name: 'judge-adapter', version: '1.0.0' },
    provider: { name: 'judge-provider', version: '1.0.0' },
    model: {
      name: 'judge-model',
      version: '1.0.0',
      digest: `sha256:${'1'.repeat(64)}`,
      runtimeFingerprint: '5'.repeat(64),
    },
    api: { name: 'judge-api', version: '1.0.0' },
    environment: { id: 'judge-env', version: '1', fingerprint: '6'.repeat(64) },
};

test('verifies a current signed 35-cell category x difficulty qualification', () => {
  const attestation = signedFixture(keyPair, workerIdentity);
  assert.deepEqual(verifyBenchmarkJudgeQualificationAttestation(attestation, {
    publicKey: keyPair.publicKey,
    now: new Date('2026-09-01T00:00:00.000Z'),
  }), attestation);
});

test('rejects self-declared identity, weak cells, tampering, and expiry', () => {
    const body = fixtureBody(workerIdentity);
    const mismatchedIdentity = {
      ...body,
      judge: { ...body.judge, identityFingerprint: '7'.repeat(64) },
    };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(mismatchedIdentity),
    error => error.code === 'JUDGE_QUALIFICATION_IDENTITY_MISMATCH'
  );

    const weak = {
      ...body,
      evidence: {
        ...body.evidence,
        categoryMetrics: body.evidence.categoryMetrics.map((metric, index) => (
          index === 0 ? { ...metric, maeMicros: 1500001 } : metric
        )),
      },
    };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(weak),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );

    const weakCell = {
      ...body,
      evidence: {
        ...body.evidence,
        overallToleranceBasisPoints: 8569,
        categoryMetrics: body.evidence.categoryMetrics.map((metric, index) => (
          index === 0 ? {
            ...metric,
            toleranceBasisPoints: 8380,
            difficultyMetrics: metric.difficultyMetrics.map((cell, cellIndex) => (
              cellIndex === 0 ? { ...cell, toleranceBasisPoints: 7499 } : cell
            )),
          } : metric
        )),
      },
    };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(weakCell),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );

    const inconsistentOverall = {
      ...body,
      evidence: { ...body.evidence, overallMaeMicros: 899999 },
    };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(inconsistentOverall),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );

    const coherentButWeakOverall = {
      ...body,
      evidence: {
        ...body.evidence,
        overallMaeMicros: 1100000,
        categoryMetrics: body.evidence.categoryMetrics.map(metric => ({
          ...metric,
          maeMicros: 1100000,
          difficultyMetrics: metric.difficultyMetrics.map(cell => ({
            ...cell,
            maeMicros: 1100000,
          })),
        })),
      },
    };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(coherentButWeakOverall),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );

    const signed = signedFixture(keyPair, workerIdentity);
  assert.throws(() => verifyBenchmarkJudgeQualificationAttestation({
      ...signed,
      evidence: { ...signed.evidence, overallMaeMicros: 800000 },
    }, {
      publicKey: keyPair.publicKey,
      now: new Date('2026-09-01T00:00:00.000Z'),
    }));

  assert.throws(() => verifyBenchmarkJudgeQualificationAttestation(signed, {
      publicKey: keyPair.publicKey,
      now: new Date('2026-10-02T00:00:00.000Z'),
    }), error => error.code === 'JUDGE_QUALIFICATION_EXPIRED');
});

test('requires every category x difficulty cell with coherent category and corpus totals', () => {
  const body = fixtureBody(workerIdentity);
  for (const [field, value] of [
    ['validationSampleCount', 1],
    ['holdoutSampleCount', 2],
  ]) {
    const undersized = {
      ...body,
      evidence: {
        ...body.evidence,
        categoryMetrics: body.evidence.categoryMetrics.map((metric, index) => (
          index === 0 ? {
            ...metric,
            difficultyMetrics: metric.difficultyMetrics.map((cell, cellIndex) => (
              cellIndex === 0 ? { ...cell, [field]: value } : cell
            )),
          } : metric
        )),
      },
    };
    assert.throws(
      () => computeBenchmarkJudgeQualificationAttestationId(undersized),
      error => error.code === 'INVALID_JUDGE_QUALIFICATION_ATTESTATION'
    );
  }

  const missingDifficulty = {
    ...body,
    evidence: {
      ...body.evidence,
      categoryMetrics: body.evidence.categoryMetrics.map((metric, index) => (
        index === 0 ? { ...metric, difficultyMetrics: metric.difficultyMetrics.slice(0, 4) } : metric
      )),
    },
  };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(missingDifficulty),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );

  const duplicateDifficulty = {
    ...body,
    evidence: {
      ...body.evidence,
      categoryMetrics: body.evidence.categoryMetrics.map((metric, index) => (
        index === 0 ? {
          ...metric,
          difficultyMetrics: metric.difficultyMetrics.map((cell, cellIndex) => (
            cellIndex === 1 ? { ...cell, difficulty: 1 } : cell
          )),
        } : metric
      )),
    },
  };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(duplicateDifficulty),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );

  const legacyFourteenTwentyOne = {
    ...body,
    evidence: {
      ...body.evidence,
      validationSampleCount: 14,
      holdoutSampleCount: 21,
      categoryMetrics: body.evidence.categoryMetrics.map(metric => ({
        category: metric.category,
        validationSampleCount: 2,
        holdoutSampleCount: 3,
        maeMicros: metric.maeMicros,
        toleranceBasisPoints: metric.toleranceBasisPoints,
      })),
    },
  };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(legacyFourteenTwentyOne),
    error => error.code === 'INVALID_JUDGE_QUALIFICATION_ATTESTATION'
  );

  const inconsistentTotals = {
    ...body,
    evidence: { ...body.evidence, validationSampleCount: 71 },
  };
  assert.throws(
    () => computeBenchmarkJudgeQualificationAttestationId(inconsistentTotals),
    error => error.code === 'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET'
  );
});

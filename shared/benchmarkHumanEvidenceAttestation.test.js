'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
  computeBenchmarkHumanEvidenceAttestationId,
  computeBenchmarkHumanEvidenceSourceResultFingerprint,
  normalizeBenchmarkHumanEvidenceAttestation,
  serializeBenchmarkHumanEvidenceAttestationSigningPayload,
  verifyBenchmarkHumanEvidenceAttestation,
} = require('./benchmarkHumanEvidenceAttestation');

const NOW = new Date('2026-09-01T12:00:00.000Z');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function sourceProjection(overrides = {}) {
  return {
    sourceResultId: '1'.repeat(24),
    sourceBatchId: `batch_${'2'.repeat(32)}`,
    candidateId: `candidate_${'3'.repeat(32)}`,
    promptId: `prompt_${'4'.repeat(32)}`,
    repeatIndex: 0,
    repeatTotal: 2,
    model: 'model:exact',
    host: 'harness-target',
    modelDigest: 'sha256:' + '5'.repeat(64),
    promptFingerprint: '6'.repeat(64),
    responseFingerprint: '7'.repeat(64),
    category: 'reasoning',
    judgeIdentityFingerprint: '8'.repeat(64),
    judgeScoreMicros: 7_250_000,
    judgeReceiptFingerprint: '9'.repeat(64),
    executionReceiptFingerprint: 'a'.repeat(64),
    sourceCreatedAt: '2026-08-31T10:00:00.000Z',
    sourceUpdatedAt: '2026-08-31T10:00:00.000Z',
    ...overrides,
  };
}

function bodyFixture(overrides = {}) {
  const projection = sourceProjection();
  return {
    schema: BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
    issuer: { issuerId: 'human-review-board', keyId: 'review-key-2026-09' },
    issuedAt: '2026-09-01T11:00:00.000Z',
    validUntil: '2026-10-01T11:00:00.000Z',
    nonce: 'review-nonce-00000000000000000001',
    source: {
      sourceResultId: projection.sourceResultId,
      sourceBatchId: projection.sourceBatchId,
      sourceResultFingerprint: computeBenchmarkHumanEvidenceSourceResultFingerprint(projection),
      promptFingerprint: projection.promptFingerprint,
      responseFingerprint: projection.responseFingerprint,
      category: projection.category,
      judgeIdentityFingerprint: projection.judgeIdentityFingerprint,
      judgeScoreMicros: projection.judgeScoreMicros,
    },
    human: {
      provenanceClass: 'independent_human_score',
      reviewProtocol: 'blind_independent',
      expertScoreMicros: 8_000_000,
      dimensionScores: [
        { dimension: 'correctness', scoreMicros: 8_500_000 },
        { dimension: 'relevance', scoreMicros: 7_500_000 },
      ],
      expertRationale: 'Independent double review found the response materially correct.',
      reviewerId: 'reviewer-pseudonym-17',
      reviewedAt: '2026-09-01T10:30:00.000Z',
    },
    ...overrides,
  };
}

function signBody(body = bodyFixture(), key = privateKey) {
  const attestationId = computeBenchmarkHumanEvidenceAttestationId(body);
  const payload = serializeBenchmarkHumanEvidenceAttestationSigningPayload(body, attestationId);
  const signature = crypto.sign(null, Buffer.from(payload), key).toString('base64url');
  return { ...body, attestationId, signature };
}

test('normalizes and verifies one canonical Ed25519 human-evidence attestation', () => {
  const signed = signBody();
  assert.deepEqual(
    verifyBenchmarkHumanEvidenceAttestation(signed, { publicKey, now: NOW }),
    normalizeBenchmarkHumanEvidenceAttestation(signed)
  );
});

test('rejects tampered human content and the wrong issuer key', () => {
  const signed = signBody();
  const tamperedBody = {
    ...signed,
    human: { ...signed.human, expertScoreMicros: 1_000_000 },
  };
  assert.throws(
    () => verifyBenchmarkHumanEvidenceAttestation(tamperedBody, { publicKey, now: NOW }),
    error => error.code === 'HUMAN_EVIDENCE_ATTESTATION_ID_MISMATCH'
  );

  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(
    () => verifyBenchmarkHumanEvidenceAttestation(signed, { publicKey: other.publicKey, now: NOW }),
    error => error.code === 'HUMAN_EVIDENCE_ATTESTATION_SIGNATURE_INVALID'
  );
});

test('rejects expired, future-issued, malformed, and self-asserted verification fields', () => {
  assert.throws(
    () => verifyBenchmarkHumanEvidenceAttestation(signBody(bodyFixture({
      validUntil: '2026-09-01T11:30:00.000Z',
    })), { publicKey, now: NOW }),
    error => error.code === 'HUMAN_EVIDENCE_ATTESTATION_EXPIRED'
  );
  assert.throws(
    () => verifyBenchmarkHumanEvidenceAttestation(signBody(bodyFixture({
      issuedAt: '2026-09-01T13:00:00.000Z',
      validUntil: '2026-10-01T13:00:00.000Z',
      human: { ...bodyFixture().human, reviewedAt: '2026-09-01T12:30:00.000Z' },
    })), { publicKey, now: NOW, maxClockSkewMs: 0 }),
    error => error.code === 'HUMAN_EVIDENCE_ATTESTATION_NOT_YET_VALID'
  );
  assert.throws(
    () => normalizeBenchmarkHumanEvidenceAttestation({ ...signBody(), verified: true }),
    /unsupported keys: verified/
  );
  assert.throws(
    () => signBody(bodyFixture({
      human: { ...bodyFixture().human, reviewProtocol: 'judge_visible_single_review' },
    })),
    /single independent blind review/
  );
  assert.throws(
    () => signBody(bodyFixture({ nonce: 'too-short' })),
    /at least 32 characters/
  );
  assert.throws(
    () => signBody(bodyFixture({
      source: { ...bodyFixture().source, category: 'factual' },
    })),
    /source.category is not supported/
  );
});

test('source-result fingerprint is canonical and binds machine evidence', () => {
  const canonical = sourceProjection();
  const fingerprint = computeBenchmarkHumanEvidenceSourceResultFingerprint(canonical);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(
    computeBenchmarkHumanEvidenceSourceResultFingerprint({ ...canonical, judgeScoreMicros: 7_000_000 }),
    fingerprint
  );
  assert.throws(
    () => computeBenchmarkHumanEvidenceSourceResultFingerprint({ ...canonical, extra: true }),
    /unsupported keys: extra/
  );
});

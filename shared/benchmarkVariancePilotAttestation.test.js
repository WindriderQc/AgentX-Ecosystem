'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

const {
  BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
  computeBenchmarkVariancePilotAttestationId,
  computeBenchmarkVariancePilotCohortFingerprint,
  normalizeBenchmarkVariancePilotAttestation,
  serializeBenchmarkVariancePilotAttestationSigningPayload,
  verifyBenchmarkVariancePilotAttestation,
} = require('./benchmarkVariancePilotAttestation');

const keyPair = crypto.generateKeyPairSync('ed25519');
const promptFingerprints = Array.from({ length: 30 }, (_, index) => (
  crypto.createHash('sha256').update(`pilot-prompt-${index}`).digest('hex')
)).sort();

function signedFixture(overrides = {}) {
  const body = {
    schema: BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
    issuer: { issuerId: 'independent-statistics-board', keyId: 'pilot-key-2026-01' },
    issuedAt: '2026-08-31T00:00:00.000Z',
    validUntil: '2026-10-01T00:00:00.000Z',
    nonce: 'variance-pilot-2026-08-31-000001',
    evidence: {
      sourceReceiptId: '1'.repeat(64),
      resultInventoryFingerprint: '2'.repeat(64),
      varianceBasisFingerprint: '3'.repeat(64),
      cohortFingerprint: computeBenchmarkVariancePilotCohortFingerprint(promptFingerprints),
      promptFingerprints,
      repeatCount: 2,
      candidateInferenceContractFingerprint: '4'.repeat(64),
      promptSamplingPolicyFingerprint: '5'.repeat(64),
    },
    ...overrides,
  };
  const attestationId = computeBenchmarkVariancePilotAttestationId(body);
  const payload = serializeBenchmarkVariancePilotAttestationSigningPayload(body, attestationId);
  return {
    ...body,
    attestationId,
    signature: crypto.sign(null, Buffer.from(payload, 'utf8'), keyPair.privateKey).toString('base64url'),
  };
}

test('verifies a signed variance pilot with a canonical 30-prompt source inventory', () => {
  const attestation = signedFixture();
  assert.deepEqual(normalizeBenchmarkVariancePilotAttestation(attestation), attestation);
  assert.equal(verifyBenchmarkVariancePilotAttestation(attestation, {
    publicKey: keyPair.publicKey,
    now: new Date('2026-09-01T00:00:00.000Z'),
  }).attestationId, attestation.attestationId);
});

test('rejects invented cohorts, tampering, expiry and the wrong trust root', () => {
  const attestation = signedFixture();
  const invented = structuredClone(attestation);
  invented.evidence.cohortFingerprint = 'f'.repeat(64);
  assert.throws(() => normalizeBenchmarkVariancePilotAttestation(invented), /signed prompt inventory/);

  const tampered = structuredClone(attestation);
  tampered.evidence.resultInventoryFingerprint = 'e'.repeat(64);
  assert.throws(() => verifyBenchmarkVariancePilotAttestation(tampered, {
    publicKey: keyPair.publicKey,
    now: new Date('2026-09-01T00:00:00.000Z'),
  }), /attestationId does not match/);

  assert.throws(() => verifyBenchmarkVariancePilotAttestation(attestation, {
    publicKey: keyPair.publicKey,
    now: new Date('2026-10-02T00:00:00.000Z'),
  }), /expired/);

  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifyBenchmarkVariancePilotAttestation(attestation, {
    publicKey: otherKey,
    now: new Date('2026-09-01T00:00:00.000Z'),
  }), /signature is invalid/);
});

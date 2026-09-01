'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA,
  BENCHMARK_TRUST_RATIFICATION_SCHEMA,
  computeBenchmarkTrustRatificationAttestationId,
  computeBenchmarkTrustRatificationAuthorityFingerprint,
  serializeBenchmarkTrustRatificationAttestationSigningPayload,
  verifyBenchmarkTrustRatificationAttestation,
} = require('./benchmarkTrustRatificationAttestation');

const keyPair = crypto.generateKeyPairSync('ed25519');
const issuer = { issuerId: 'human-review-board', keyId: 'ratification-key-2026-09' };

function fixtureBody(overrides = {}) {
  return {
    schema: BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA,
    issuer,
    issuedAt: '2026-09-01T11:01:00.000Z',
    validUntil: '2026-09-30T00:00:00.000Z',
    nonce: 'benchmark-ratification-nonce-000000001',
    ratification: {
      schema: BENCHMARK_TRUST_RATIFICATION_SCHEMA,
      receiptId: '1'.repeat(64),
      status: 'ratified',
      ratifiedAt: '2026-09-01T11:00:00.000Z',
      authorityFingerprint: computeBenchmarkTrustRatificationAuthorityFingerprint(issuer),
      attestationFingerprint: '2'.repeat(64),
    },
    ...overrides,
  };
}

function signedFixture(body = fixtureBody()) {
  const attestationId = computeBenchmarkTrustRatificationAttestationId(body);
  const payload = serializeBenchmarkTrustRatificationAttestationSigningPayload(body, attestationId);
  return {
    ...body,
    attestationId,
    signature: crypto.sign(null, Buffer.from(payload), keyPair.privateKey).toString('base64url'),
  };
}

test('verifies a current signed ratification bound to an exact authority and decision', () => {
  const attestation = signedFixture();
  assert.deepEqual(verifyBenchmarkTrustRatificationAttestation(attestation, {
    publicKey: keyPair.publicKey,
    now: new Date('2026-09-01T12:00:00.000Z'),
  }), attestation);
  assert.equal(
    attestation.ratification.authorityFingerprint,
    computeBenchmarkTrustRatificationAuthorityFingerprint(issuer)
  );
  assert.notEqual(
    attestation.ratification.attestationFingerprint,
    attestation.attestationId,
    'the decision fingerprint and signed-envelope id remain separate'
  );
});

test('gives key rotation a distinct authority fingerprint and rejects issuer substitution', () => {
  assert.notEqual(
    computeBenchmarkTrustRatificationAuthorityFingerprint(issuer),
    computeBenchmarkTrustRatificationAuthorityFingerprint({
      ...issuer,
      keyId: 'ratification-key-2026-10',
    })
  );
  const body = fixtureBody({
    issuer: { ...issuer, keyId: 'ratification-key-2026-10' },
  });
  assert.throws(
    () => computeBenchmarkTrustRatificationAttestationId(body),
    error => error.code === 'BENCHMARK_TRUST_RATIFICATION_AUTHORITY_MISMATCH'
  );
});

test('rejects future decisions, tampering, expiry, and non-Ed25519 trust roots', () => {
  const futureDecision = fixtureBody({
    ratification: {
      ...fixtureBody().ratification,
      ratifiedAt: '2026-09-01T11:02:00.000Z',
    },
  });
  assert.throws(
    () => computeBenchmarkTrustRatificationAttestationId(futureDecision),
    error => error.code === 'BENCHMARK_TRUST_RATIFICATION_PREDATES_DECISION'
  );

  const signed = signedFixture();
  assert.throws(
    () => verifyBenchmarkTrustRatificationAttestation({
      ...signed,
      ratification: { ...signed.ratification, receiptId: '3'.repeat(64) },
    }, {
      publicKey: keyPair.publicKey,
      now: new Date('2026-09-01T12:00:00.000Z'),
    }),
    error => error.code === 'BENCHMARK_TRUST_RATIFICATION_ATTESTATION_ID_MISMATCH'
  );
  assert.throws(
    () => verifyBenchmarkTrustRatificationAttestation(signed, {
      publicKey: keyPair.publicKey,
      now: new Date('2026-10-01T00:00:00.000Z'),
    }),
    error => error.code === 'BENCHMARK_TRUST_RATIFICATION_EXPIRED'
  );

  const otherEd25519KeyPair = crypto.generateKeyPairSync('ed25519');
  assert.throws(
    () => verifyBenchmarkTrustRatificationAttestation(signed, {
      publicKey: otherEd25519KeyPair.publicKey,
      now: new Date('2026-09-01T12:00:00.000Z'),
    }),
    error => error.code === 'BENCHMARK_TRUST_RATIFICATION_SIGNATURE_INVALID'
  );

  const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () => verifyBenchmarkTrustRatificationAttestation(signed, {
      publicKey: rsaKeyPair.publicKey,
      now: new Date('2026-09-01T12:00:00.000Z'),
    }),
    error => error.code === 'BENCHMARK_TRUST_RATIFICATION_TRUST_ROOT_INVALID'
  );
});

test('supports a signed revocation without weakening the exact ratification schema', () => {
  const body = fixtureBody({
    ratification: { ...fixtureBody().ratification, status: 'revoked' },
  });
  const attestation = signedFixture(body);
  assert.equal(verifyBenchmarkTrustRatificationAttestation(attestation, {
    publicKey: keyPair.publicKey,
    now: new Date('2026-09-01T12:00:00.000Z'),
  }).ratification.status, 'revoked');
  assert.throws(
    () => computeBenchmarkTrustRatificationAttestationId({
      ...body,
      ratification: { ...body.ratification, reason: 'unsupported free text' },
    }),
    error => error.code === 'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION'
  );
});

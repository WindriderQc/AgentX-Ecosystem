'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('./artifactIdentity');
const {
  BENCHMARK_TRUST_RATIFICATION_SCHEMA,
  validateBenchmarkTrustRatification,
} = require('./benchmarkTrustReceipt');

const BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA =
  'agentx.benchmark-trust-ratification-attestation/v1';
const BENCHMARK_TRUST_RATIFICATION_AUTHORITY_SCHEMA =
  'agentx.benchmark-trust-ratification-authority/v1';
const BODY_KEYS = Object.freeze([
  'schema', 'issuer', 'issuedAt', 'validUntil', 'nonce', 'ratification',
]);
const ATTESTATION_KEYS = Object.freeze([...BODY_KEYS, 'attestationId', 'signature']);
const ISSUER_KEYS = Object.freeze(['issuerId', 'keyId']);
const RATIFICATION_KEYS = Object.freeze([
  'schema', 'receiptId', 'status', 'ratifiedAt', 'authorityFingerprint',
  'attestationFingerprint',
]);
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

function ratificationError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
  if (!isPlainObject(value)
      || Object.keys(value).some(key => !keys.includes(key))
      || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      `${label} must contain exactly ${keys.join(', ')}`
    );
  }
  return value;
}

function identifier(value, label, minimumLength = 1) {
  if (typeof value !== 'string' || value.length < minimumLength || value.length > 180
      || value !== value.trim() || !IDENTIFIER_PATTERN.test(value)) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      `${label} is invalid`
    );
  }
  return value;
}

function fingerprint(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      `${label} must be a lowercase SHA-256 fingerprint`
    );
  }
  return value;
}

function timestamp(value, label) {
  const parsed = typeof value === 'string' && TIMESTAMP_PATTERN.test(value)
    ? new Date(value)
    : new Date(NaN);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      `${label} is invalid`
    );
  }
  return value;
}

function normalizeIssuer(raw) {
  const value = exactObject(raw, ISSUER_KEYS, 'issuer');
  return {
    issuerId: identifier(value.issuerId, 'issuer.issuerId'),
    keyId: identifier(value.keyId, 'issuer.keyId'),
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeBenchmarkTrustRatificationAuthorityFingerprint(rawIssuer) {
  const issuer = normalizeIssuer(rawIssuer);
  return sha256(stableSerialize({
    schema: BENCHMARK_TRUST_RATIFICATION_AUTHORITY_SCHEMA,
    issuer,
  }));
}

function normalizeRatification(raw, issuer) {
  const value = exactObject(raw, RATIFICATION_KEYS, 'ratification');
  const validation = validateBenchmarkTrustRatification(value);
  if (!validation.valid) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      `ratification is invalid: ${validation.errors.join('; ')}`
    );
  }
  // attestationFingerprint identifies the underlying human decision artifact.
  // The signed envelope has its own attestationId, avoiding a circular digest.
  const authorityFingerprint = computeBenchmarkTrustRatificationAuthorityFingerprint(issuer);
  if (value.authorityFingerprint !== authorityFingerprint) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_AUTHORITY_MISMATCH',
      'ratification.authorityFingerprint does not match issuer identity',
      403
    );
  }
  return Object.fromEntries(RATIFICATION_KEYS.map(key => [key, value[key]]));
}

function normalizeBenchmarkTrustRatificationAttestationBody(raw) {
  const value = exactObject(raw, BODY_KEYS, 'attestation body');
  if (value.schema !== BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      `schema must be ${BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA}`
    );
  }
  const issuer = normalizeIssuer(value.issuer);
  const issuedAt = timestamp(value.issuedAt, 'issuedAt');
  const validUntil = timestamp(value.validUntil, 'validUntil');
  if (Date.parse(validUntil) <= Date.parse(issuedAt)) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      'validUntil must be later than issuedAt'
    );
  }
  const ratification = normalizeRatification(value.ratification, issuer);
  if (Date.parse(ratification.ratifiedAt) > Date.parse(issuedAt)) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_PREDATES_DECISION',
      'issuedAt must be at or after ratification.ratifiedAt'
    );
  }
  return {
    schema: BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA,
    issuer,
    issuedAt,
    validUntil,
    nonce: identifier(value.nonce, 'nonce', 32),
    ratification,
  };
}

function computeBenchmarkTrustRatificationAttestationId(rawBody) {
  return sha256(stableSerialize(normalizeBenchmarkTrustRatificationAttestationBody(rawBody)));
}

function serializeBenchmarkTrustRatificationAttestationSigningPayload(rawBody, attestationId = null) {
  const body = normalizeBenchmarkTrustRatificationAttestationBody(rawBody);
  const computedId = sha256(stableSerialize(body));
  if (attestationId !== null && fingerprint(attestationId, 'attestationId') !== computedId) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_ATTESTATION_ID_MISMATCH',
      'attestationId does not match the canonical body'
    );
  }
  return stableSerialize({ ...body, attestationId: computedId });
}

function normalizeBenchmarkTrustRatificationAttestation(raw) {
  const value = exactObject(raw, ATTESTATION_KEYS, 'attestation');
  const body = normalizeBenchmarkTrustRatificationAttestationBody(
    Object.fromEntries(BODY_KEYS.map(key => [key, value[key]]))
  );
  const attestationId = fingerprint(value.attestationId, 'attestationId');
  if (attestationId !== sha256(stableSerialize(body))) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_ATTESTATION_ID_MISMATCH',
      'attestationId does not match the canonical body'
    );
  }
  if (typeof value.signature !== 'string' || !SIGNATURE_PATTERN.test(value.signature)) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      'signature is invalid'
    );
  }
  const signature = Buffer.from(value.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== value.signature) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_ATTESTATION',
      'signature is invalid'
    );
  }
  return { ...body, attestationId, signature: value.signature };
}

function verifyBenchmarkTrustRatificationAttestation(raw, options = {}) {
  const attestation = normalizeBenchmarkTrustRatificationAttestation(raw);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const skew = Number.isSafeInteger(options.maxClockSkewMs) && options.maxClockSkewMs >= 0
    ? options.maxClockSkewMs
    : 300_000;
  if (!Number.isFinite(now.getTime())) {
    throw ratificationError(
      'INVALID_BENCHMARK_TRUST_RATIFICATION_VERIFICATION_TIME',
      'verification time is invalid'
    );
  }
  if (Date.parse(attestation.issuedAt) > now.getTime() + skew) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_NOT_YET_VALID',
      'benchmark trust ratification is not yet valid',
      403
    );
  }
  if (Date.parse(attestation.validUntil) < now.getTime()) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_EXPIRED',
      'benchmark trust ratification has expired',
      403
    );
  }
  let publicKey;
  try {
    publicKey = options.publicKey instanceof crypto.KeyObject
      ? options.publicKey
      : crypto.createPublicKey(options.publicKey);
  } catch (_error) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_TRUST_ROOT_INVALID',
      'configured public key is invalid',
      503
    );
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_TRUST_ROOT_INVALID',
      'configured public key must be Ed25519',
      503
    );
  }
  const body = Object.fromEntries(BODY_KEYS.map(key => [key, attestation[key]]));
  const payload = serializeBenchmarkTrustRatificationAttestationSigningPayload(
    body,
    attestation.attestationId
  );
  if (!crypto.verify(
    null,
    Buffer.from(payload, 'utf8'),
    publicKey,
    Buffer.from(attestation.signature, 'base64url')
  )) {
    throw ratificationError(
      'BENCHMARK_TRUST_RATIFICATION_SIGNATURE_INVALID',
      'benchmark trust ratification signature is invalid',
      403
    );
  }
  return attestation;
}

module.exports = {
  BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA,
  BENCHMARK_TRUST_RATIFICATION_AUTHORITY_SCHEMA,
  BENCHMARK_TRUST_RATIFICATION_SCHEMA,
  computeBenchmarkTrustRatificationAttestationId,
  computeBenchmarkTrustRatificationAuthorityFingerprint,
  normalizeBenchmarkTrustRatificationAttestation,
  normalizeBenchmarkTrustRatificationAttestationBody,
  serializeBenchmarkTrustRatificationAttestationSigningPayload,
  verifyBenchmarkTrustRatificationAttestation,
};

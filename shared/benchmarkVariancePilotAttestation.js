'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('./artifactIdentity');

const BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA =
  'agentx.benchmark-trust-variance-pilot-attestation/v1';
const VARIANCE_PILOT_COHORT_SCHEMA = 'agentx.benchmark-trust-variance-pilot-cohort/v1';
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const BODY_KEYS = Object.freeze([
  'schema', 'issuer', 'issuedAt', 'validUntil', 'nonce', 'evidence',
]);
const ATTESTATION_KEYS = Object.freeze([...BODY_KEYS, 'attestationId', 'signature']);
const ISSUER_KEYS = Object.freeze(['issuerId', 'keyId']);
const EVIDENCE_KEYS = Object.freeze([
  'sourceReceiptId',
  'resultInventoryFingerprint',
  'varianceBasisFingerprint',
  'cohortFingerprint',
  'promptFingerprints',
  'repeatCount',
  'candidateInferenceContractFingerprint',
  'promptSamplingPolicyFingerprint',
]);
const MINIMUM_PILOT_PROMPT_COUNT = 30;
const MAXIMUM_PILOT_PROMPT_COUNT = 100_000;

function pilotError(code, message, statusCode = 400) {
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
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', `${label} has invalid keys`);
  }
  return value;
}

function identifier(value, label, minimumLength = 1) {
  if (typeof value !== 'string' || value.length < minimumLength || value.length > 180
      || value !== value.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/.test(value)) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', `${label} is invalid`);
  }
  return value;
}

function fingerprint(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', `${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  const parsed = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', `${label} is invalid`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeBenchmarkVariancePilotCohortFingerprint(promptFingerprints) {
  if (!Array.isArray(promptFingerprints)
      || promptFingerprints.length < MINIMUM_PILOT_PROMPT_COUNT
      || promptFingerprints.length > MAXIMUM_PILOT_PROMPT_COUNT
      || promptFingerprints.some(value => typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value))
      || new Set(promptFingerprints).size !== promptFingerprints.length
      || promptFingerprints.join('\n') !== [...promptFingerprints].sort().join('\n')) {
    throw pilotError(
      'INVALID_VARIANCE_PILOT_ATTESTATION',
      'pilot prompt fingerprints must be a unique canonical independent cohort'
    );
  }
  return sha256(stableSerialize({
    schema: VARIANCE_PILOT_COHORT_SCHEMA,
    promptFingerprints,
  }));
}

function normalizeEvidence(raw) {
  const value = exactObject(raw, EVIDENCE_KEYS, 'evidence');
  const promptFingerprints = Array.isArray(value.promptFingerprints)
    ? [...value.promptFingerprints]
    : value.promptFingerprints;
  const cohortFingerprint = fingerprint(value.cohortFingerprint, 'evidence.cohortFingerprint');
  if (computeBenchmarkVariancePilotCohortFingerprint(promptFingerprints) !== cohortFingerprint) {
    throw pilotError(
      'VARIANCE_PILOT_COHORT_MISMATCH',
      'evidence.cohortFingerprint does not match the signed prompt inventory'
    );
  }
  if (!Number.isSafeInteger(value.repeatCount) || value.repeatCount < 1 || value.repeatCount > 5) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', 'evidence.repeatCount is invalid');
  }
  return {
    sourceReceiptId: fingerprint(value.sourceReceiptId, 'evidence.sourceReceiptId'),
    resultInventoryFingerprint: fingerprint(
      value.resultInventoryFingerprint,
      'evidence.resultInventoryFingerprint'
    ),
    varianceBasisFingerprint: fingerprint(
      value.varianceBasisFingerprint,
      'evidence.varianceBasisFingerprint'
    ),
    cohortFingerprint,
    promptFingerprints,
    repeatCount: value.repeatCount,
    candidateInferenceContractFingerprint: fingerprint(
      value.candidateInferenceContractFingerprint,
      'evidence.candidateInferenceContractFingerprint'
    ),
    promptSamplingPolicyFingerprint: fingerprint(
      value.promptSamplingPolicyFingerprint,
      'evidence.promptSamplingPolicyFingerprint'
    ),
  };
}

function normalizeBenchmarkVariancePilotAttestationBody(raw) {
  const value = exactObject(raw, BODY_KEYS, 'attestation body');
  if (value.schema !== BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA) {
    throw pilotError(
      'INVALID_VARIANCE_PILOT_ATTESTATION',
      `schema must be ${BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA}`
    );
  }
  const issuer = exactObject(value.issuer, ISSUER_KEYS, 'issuer');
  const issuedAt = timestamp(value.issuedAt, 'issuedAt');
  const validUntil = timestamp(value.validUntil, 'validUntil');
  if (Date.parse(validUntil) <= Date.parse(issuedAt)) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', 'validUntil must be later than issuedAt');
  }
  return {
    schema: BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
    issuer: {
      issuerId: identifier(issuer.issuerId, 'issuer.issuerId'),
      keyId: identifier(issuer.keyId, 'issuer.keyId'),
    },
    issuedAt,
    validUntil,
    nonce: identifier(value.nonce, 'nonce', 32),
    evidence: normalizeEvidence(value.evidence),
  };
}

function computeBenchmarkVariancePilotAttestationId(rawBody) {
  return sha256(stableSerialize(normalizeBenchmarkVariancePilotAttestationBody(rawBody)));
}

function serializeBenchmarkVariancePilotAttestationSigningPayload(rawBody, attestationId = null) {
  const body = normalizeBenchmarkVariancePilotAttestationBody(rawBody);
  const computedId = sha256(stableSerialize(body));
  if (attestationId !== null && fingerprint(attestationId, 'attestationId') !== computedId) {
    throw pilotError(
      'VARIANCE_PILOT_ATTESTATION_ID_MISMATCH',
      'attestationId does not match the canonical body'
    );
  }
  return stableSerialize({ ...body, attestationId: computedId });
}

function normalizeBenchmarkVariancePilotAttestation(raw) {
  const value = exactObject(raw, ATTESTATION_KEYS, 'attestation');
  const body = normalizeBenchmarkVariancePilotAttestationBody(
    Object.fromEntries(BODY_KEYS.map(key => [key, value[key]]))
  );
  const attestationId = fingerprint(value.attestationId, 'attestationId');
  if (attestationId !== sha256(stableSerialize(body))) {
    throw pilotError(
      'VARIANCE_PILOT_ATTESTATION_ID_MISMATCH',
      'attestationId does not match the canonical body'
    );
  }
  if (typeof value.signature !== 'string' || !SIGNATURE_PATTERN.test(value.signature)) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', 'signature is invalid');
  }
  const signature = Buffer.from(value.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== value.signature) {
    throw pilotError('INVALID_VARIANCE_PILOT_ATTESTATION', 'signature is invalid');
  }
  return { ...body, attestationId, signature: value.signature };
}

function verifyBenchmarkVariancePilotAttestation(raw, options = {}) {
  const attestation = normalizeBenchmarkVariancePilotAttestation(raw);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const skew = Number.isSafeInteger(options.maxClockSkewMs) && options.maxClockSkewMs >= 0
    ? options.maxClockSkewMs
    : 300_000;
  if (!Number.isFinite(now.getTime())) {
    throw pilotError('INVALID_VARIANCE_PILOT_VERIFICATION_TIME', 'verification time is invalid');
  }
  if (Date.parse(attestation.issuedAt) > now.getTime() + skew) {
    throw pilotError('VARIANCE_PILOT_NOT_YET_VALID', 'variance pilot is not yet valid', 403);
  }
  if (Date.parse(attestation.validUntil) < now.getTime()) {
    throw pilotError('VARIANCE_PILOT_EXPIRED', 'variance pilot has expired', 403);
  }
  let publicKey;
  try {
    publicKey = options.publicKey instanceof crypto.KeyObject
      ? options.publicKey
      : crypto.createPublicKey(options.publicKey);
  } catch (_error) {
    throw pilotError('VARIANCE_PILOT_TRUST_ROOT_INVALID', 'configured public key is invalid', 503);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw pilotError('VARIANCE_PILOT_TRUST_ROOT_INVALID', 'configured public key must be Ed25519', 503);
  }
  const body = Object.fromEntries(BODY_KEYS.map(key => [key, attestation[key]]));
  const payload = serializeBenchmarkVariancePilotAttestationSigningPayload(body, attestation.attestationId);
  if (!crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(attestation.signature, 'base64url'))) {
    throw pilotError('VARIANCE_PILOT_SIGNATURE_INVALID', 'variance pilot signature is invalid', 403);
  }
  return attestation;
}

module.exports = {
  BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
  MAXIMUM_PILOT_PROMPT_COUNT,
  MINIMUM_PILOT_PROMPT_COUNT,
  VARIANCE_PILOT_COHORT_SCHEMA,
  computeBenchmarkVariancePilotAttestationId,
  computeBenchmarkVariancePilotCohortFingerprint,
  normalizeBenchmarkVariancePilotAttestation,
  normalizeBenchmarkVariancePilotAttestationBody,
  serializeBenchmarkVariancePilotAttestationSigningPayload,
  verifyBenchmarkVariancePilotAttestation,
};

'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('./artifactIdentity');

const BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA = 'agentx.benchmark-human-evidence-attestation/v1';
const HUMAN_EVIDENCE_SOURCE_RESULT_SCHEMA = 'agentx.benchmark-human-evidence-source-result/v1';
const QUALIFIED_PROVENANCE = Object.freeze({
  // v1 attests one reviewer. Multi-review and adjudication labels require a
  // future composite contract that binds every reviewer and lineage edge.
  independent_human_score: Object.freeze(['blind_independent']),
});
const GROUND_TRUTH_CATEGORIES = Object.freeze([
  'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation',
]);

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_RESULT_ID_PATTERN = /^[0-9a-f]{24}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

const BODY_KEYS = Object.freeze(['schema', 'issuer', 'issuedAt', 'validUntil', 'nonce', 'source', 'human']);
const ATTESTATION_KEYS = Object.freeze([...BODY_KEYS, 'attestationId', 'signature']);
const ISSUER_KEYS = Object.freeze(['issuerId', 'keyId']);
const SOURCE_KEYS = Object.freeze([
  'sourceResultId',
  'sourceBatchId',
  'sourceResultFingerprint',
  'promptFingerprint',
  'responseFingerprint',
  'category',
  'judgeIdentityFingerprint',
  'judgeScoreMicros',
]);
const HUMAN_KEYS = Object.freeze([
  'provenanceClass',
  'reviewProtocol',
  'expertScoreMicros',
  'dimensionScores',
  'expertRationale',
  'reviewerId',
  'reviewedAt',
]);
const DIMENSION_SCORE_KEYS = Object.freeze(['dimension', 'scoreMicros']);
const SOURCE_RESULT_PROJECTION_KEYS = Object.freeze([
  'sourceResultId',
  'sourceBatchId',
  'candidateId',
  'promptId',
  'repeatIndex',
  'repeatTotal',
  'model',
  'host',
  'modelDigest',
  'promptFingerprint',
  'responseFingerprint',
  'category',
  'judgeIdentityFingerprint',
  'judgeScoreMicros',
  'judgeReceiptFingerprint',
  'executionReceiptFingerprint',
  'sourceCreatedAt',
  'sourceUpdatedAt',
]);

function attestationError(code, message, statusCode = 400) {
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

function exactObject(value, expectedKeys, label) {
  if (!isPlainObject(value)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', `${label} must be an object`);
  }
  const actualKeys = Object.keys(value);
  const missing = expectedKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actualKeys.filter(key => !expectedKeys.includes(key));
  if (missing.length || extra.length) {
    const details = [];
    if (missing.length) details.push(`missing keys: ${missing.join(', ')}`);
    if (extra.length) details.push(`unsupported keys: ${extra.join(', ')}`);
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', `${label} has ${details.join('; ')}`);
  }
  return value;
}

function exactText(value, label, max = 240) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > max) {
    throw attestationError(
      'INVALID_HUMAN_EVIDENCE_ATTESTATION',
      `${label} must be non-empty canonical text of at most ${max} characters`
    );
  }
  return value;
}

function opaqueId(value, label, max = 180) {
  const text = exactText(value, label, max);
  if (!OPAQUE_ID_PATTERN.test(text)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', `${label} must be an opaque logical identifier`);
  }
  return text;
}

function fingerprint(value, label) {
  const text = exactText(value, label, 64);
  if (!FINGERPRINT_PATTERN.test(text)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', `${label} must be a lowercase SHA-256 fingerprint`);
  }
  return text;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', `${label} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function scoreMicros(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw attestationError(
      'INVALID_HUMAN_EVIDENCE_ATTESTATION',
      `${label} must be an integer from 0 through 10000000`
    );
  }
  return value;
}

function normalizeDimensionScores(rawValue) {
  if (!Array.isArray(rawValue)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'human.dimensionScores must be an array');
  }
  const entries = rawValue.map((entry, index) => {
    const value = exactObject(entry, DIMENSION_SCORE_KEYS, `human.dimensionScores[${index}]`);
    return {
      dimension: opaqueId(value.dimension, `human.dimensionScores[${index}].dimension`, 120),
      scoreMicros: scoreMicros(value.scoreMicros, `human.dimensionScores[${index}].scoreMicros`),
    };
  });
  const names = entries.map(entry => entry.dimension);
  if (new Set(names).size !== names.length) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'human.dimensionScores must not contain duplicate dimensions');
  }
  const sorted = [...entries].sort((left, right) => left.dimension.localeCompare(right.dimension));
  if (stableSerialize(entries) !== stableSerialize(sorted)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'human.dimensionScores must be sorted by dimension');
  }
  return sorted;
}

function normalizeIssuer(rawValue) {
  const value = exactObject(rawValue, ISSUER_KEYS, 'issuer');
  return {
    issuerId: opaqueId(value.issuerId, 'issuer.issuerId'),
    keyId: opaqueId(value.keyId, 'issuer.keyId'),
  };
}

function normalizeSource(rawValue) {
  const value = exactObject(rawValue, SOURCE_KEYS, 'source');
  const sourceResultId = exactText(value.sourceResultId, 'source.sourceResultId', 24);
  if (!SOURCE_RESULT_ID_PATTERN.test(sourceResultId)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'source.sourceResultId must be a lowercase Mongo object identifier');
  }
  const sourceBatchId = exactText(value.sourceBatchId, 'source.sourceBatchId', 38);
  if (!SOURCE_BATCH_ID_PATTERN.test(sourceBatchId)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'source.sourceBatchId must be an opaque source-batch identifier');
  }
  if (!GROUND_TRUTH_CATEGORIES.includes(value.category)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'source.category is not supported');
  }
  return {
    sourceResultId,
    sourceBatchId,
    sourceResultFingerprint: fingerprint(value.sourceResultFingerprint, 'source.sourceResultFingerprint'),
    promptFingerprint: fingerprint(value.promptFingerprint, 'source.promptFingerprint'),
    responseFingerprint: fingerprint(value.responseFingerprint, 'source.responseFingerprint'),
    category: value.category,
    judgeIdentityFingerprint: fingerprint(value.judgeIdentityFingerprint, 'source.judgeIdentityFingerprint'),
    judgeScoreMicros: scoreMicros(value.judgeScoreMicros, 'source.judgeScoreMicros'),
  };
}

function normalizeHuman(rawValue) {
  const value = exactObject(rawValue, HUMAN_KEYS, 'human');
  const allowedProtocols = QUALIFIED_PROVENANCE[value.provenanceClass];
  if (!allowedProtocols || !allowedProtocols.includes(value.reviewProtocol)) {
    throw attestationError(
      'INVALID_HUMAN_EVIDENCE_ATTESTATION',
      'human provenanceClass/reviewProtocol must be a single independent blind review'
    );
  }
  return {
    provenanceClass: value.provenanceClass,
    reviewProtocol: value.reviewProtocol,
    expertScoreMicros: scoreMicros(value.expertScoreMicros, 'human.expertScoreMicros'),
    dimensionScores: normalizeDimensionScores(value.dimensionScores),
    expertRationale: exactText(value.expertRationale, 'human.expertRationale', 20_000),
    reviewerId: opaqueId(value.reviewerId, 'human.reviewerId'),
    reviewedAt: canonicalTimestamp(value.reviewedAt, 'human.reviewedAt'),
  };
}

function normalizeBenchmarkHumanEvidenceAttestationBody(rawValue) {
  const value = exactObject(rawValue, BODY_KEYS, 'attestation body');
  if (value.schema !== BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA) {
    throw attestationError(
      'INVALID_HUMAN_EVIDENCE_ATTESTATION',
      `schema must be ${BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA}`
    );
  }
  const issuedAt = canonicalTimestamp(value.issuedAt, 'issuedAt');
  const validUntil = canonicalTimestamp(value.validUntil, 'validUntil');
  const human = normalizeHuman(value.human);
  if (Date.parse(validUntil) <= Date.parse(issuedAt)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'validUntil must be later than issuedAt');
  }
  if (Date.parse(human.reviewedAt) > Date.parse(issuedAt)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'human.reviewedAt cannot be later than issuedAt');
  }
  const nonce = opaqueId(value.nonce, 'nonce', 128);
  if (nonce.length < 32) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'nonce must contain at least 32 characters');
  }
  return {
    schema: BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
    issuer: normalizeIssuer(value.issuer),
    issuedAt,
    validUntil,
    nonce,
    source: normalizeSource(value.source),
    human,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeBenchmarkHumanEvidenceAttestationId(rawBody) {
  const body = normalizeBenchmarkHumanEvidenceAttestationBody(rawBody);
  return sha256(stableSerialize(body));
}

function serializeBenchmarkHumanEvidenceAttestationSigningPayload(rawBody, attestationId = null) {
  const body = normalizeBenchmarkHumanEvidenceAttestationBody(rawBody);
  const computedId = sha256(stableSerialize(body));
  if (attestationId !== null && fingerprint(attestationId, 'attestationId') !== computedId) {
    throw attestationError('HUMAN_EVIDENCE_ATTESTATION_ID_MISMATCH', 'attestationId does not match the canonical body');
  }
  return stableSerialize({ ...body, attestationId: computedId });
}

function normalizeBenchmarkHumanEvidenceAttestation(rawValue) {
  const value = exactObject(rawValue, ATTESTATION_KEYS, 'attestation');
  const bodyInput = Object.fromEntries(BODY_KEYS.map(key => [key, value[key]]));
  const body = normalizeBenchmarkHumanEvidenceAttestationBody(bodyInput);
  const attestationId = fingerprint(value.attestationId, 'attestationId');
  const computedId = sha256(stableSerialize(body));
  if (attestationId !== computedId) {
    throw attestationError('HUMAN_EVIDENCE_ATTESTATION_ID_MISMATCH', 'attestationId does not match the canonical body');
  }
  const signature = exactText(value.signature, 'signature', 86);
  if (!ED25519_SIGNATURE_PATTERN.test(signature)) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'signature must be a canonical Ed25519 base64url signature');
  }
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64url') !== signature) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_ATTESTATION', 'signature must be a canonical Ed25519 base64url signature');
  }
  return { ...body, attestationId, signature };
}

function verifyBenchmarkHumanEvidenceAttestation(rawValue, options = {}) {
  const attestation = normalizeBenchmarkHumanEvidenceAttestation(rawValue);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_VERIFICATION_TIME', 'verification time is invalid');
  }
  const maxClockSkewMs = Number.isSafeInteger(options.maxClockSkewMs) && options.maxClockSkewMs >= 0
    ? options.maxClockSkewMs
    : 300_000;
  if (Date.parse(attestation.issuedAt) > now.getTime() + maxClockSkewMs) {
    throw attestationError('HUMAN_EVIDENCE_ATTESTATION_NOT_YET_VALID', 'attestation was issued in the future', 403);
  }
  if (Date.parse(attestation.validUntil) < now.getTime()) {
    throw attestationError('HUMAN_EVIDENCE_ATTESTATION_EXPIRED', 'attestation has expired', 403);
  }
  let publicKey;
  try {
    publicKey = options.publicKey instanceof crypto.KeyObject
      ? options.publicKey
      : crypto.createPublicKey(options.publicKey);
  } catch (_error) {
    throw attestationError('HUMAN_EVIDENCE_TRUST_ROOT_INVALID', 'configured public key is invalid', 503);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw attestationError('HUMAN_EVIDENCE_TRUST_ROOT_INVALID', 'configured public key must be Ed25519', 503);
  }
  const body = Object.fromEntries(BODY_KEYS.map(key => [key, attestation[key]]));
  const signingPayload = serializeBenchmarkHumanEvidenceAttestationSigningPayload(body, attestation.attestationId);
  const verified = crypto.verify(
    null,
    Buffer.from(signingPayload, 'utf8'),
    publicKey,
    Buffer.from(attestation.signature, 'base64url')
  );
  if (!verified) {
    throw attestationError('HUMAN_EVIDENCE_ATTESTATION_SIGNATURE_INVALID', 'attestation signature is invalid', 403);
  }
  return attestation;
}

function normalizeBenchmarkHumanEvidenceSourceResultProjection(rawValue) {
  const value = exactObject(rawValue, SOURCE_RESULT_PROJECTION_KEYS, 'source result projection');
  const source = normalizeSource({
    sourceResultId: value.sourceResultId,
    sourceBatchId: value.sourceBatchId,
    sourceResultFingerprint: '0'.repeat(64),
    promptFingerprint: value.promptFingerprint,
    responseFingerprint: value.responseFingerprint,
    category: value.category,
    judgeIdentityFingerprint: value.judgeIdentityFingerprint,
    judgeScoreMicros: value.judgeScoreMicros,
  });
  const requiredOpaque = (path, max = 240) => opaqueId(value[path], `source result projection.${path}`, max);
  const optionalFingerprint = (path) => value[path] === null
    ? null
    : fingerprint(value[path], `source result projection.${path}`);
  if (!Number.isSafeInteger(value.repeatIndex) || value.repeatIndex < 0) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_SOURCE', 'source result projection.repeatIndex is invalid');
  }
  if (!Number.isSafeInteger(value.repeatTotal) || value.repeatTotal < 1 || value.repeatIndex >= value.repeatTotal) {
    throw attestationError('INVALID_HUMAN_EVIDENCE_SOURCE', 'source result projection.repeatTotal is invalid');
  }
  return {
    sourceResultId: source.sourceResultId,
    sourceBatchId: source.sourceBatchId,
    candidateId: requiredOpaque('candidateId'),
    promptId: requiredOpaque('promptId'),
    repeatIndex: value.repeatIndex,
    repeatTotal: value.repeatTotal,
    model: exactText(value.model, 'source result projection.model', 240),
    host: exactText(value.host, 'source result projection.host', 500),
    modelDigest: value.modelDigest === null ? null : exactText(value.modelDigest, 'source result projection.modelDigest', 240),
    promptFingerprint: source.promptFingerprint,
    responseFingerprint: source.responseFingerprint,
    category: source.category,
    judgeIdentityFingerprint: source.judgeIdentityFingerprint,
    judgeScoreMicros: source.judgeScoreMicros,
    judgeReceiptFingerprint: fingerprint(value.judgeReceiptFingerprint, 'source result projection.judgeReceiptFingerprint'),
    executionReceiptFingerprint: optionalFingerprint('executionReceiptFingerprint'),
    sourceCreatedAt: canonicalTimestamp(value.sourceCreatedAt, 'source result projection.sourceCreatedAt'),
    sourceUpdatedAt: canonicalTimestamp(value.sourceUpdatedAt, 'source result projection.sourceUpdatedAt'),
  };
}

function computeBenchmarkHumanEvidenceSourceResultFingerprint(rawProjection) {
  const projection = normalizeBenchmarkHumanEvidenceSourceResultProjection(rawProjection);
  return sha256(stableSerialize({ schema: HUMAN_EVIDENCE_SOURCE_RESULT_SCHEMA, result: projection }));
}

module.exports = {
  BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
  GROUND_TRUTH_CATEGORIES,
  HUMAN_EVIDENCE_SOURCE_RESULT_SCHEMA,
  QUALIFIED_PROVENANCE,
  computeBenchmarkHumanEvidenceAttestationId,
  computeBenchmarkHumanEvidenceSourceResultFingerprint,
  normalizeBenchmarkHumanEvidenceAttestation,
  normalizeBenchmarkHumanEvidenceAttestationBody,
  normalizeBenchmarkHumanEvidenceSourceResultProjection,
  serializeBenchmarkHumanEvidenceAttestationSigningPayload,
  verifyBenchmarkHumanEvidenceAttestation,
};

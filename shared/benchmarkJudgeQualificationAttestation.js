'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('./artifactIdentity');
const { fingerprint: workerFingerprint } = require('./workerContract');

const BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA =
  'agentx.benchmark-judge-qualification-attestation/v1';
const QUALIFICATION_CATEGORIES = Object.freeze([
  'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation',
]);
const QUALIFICATION_DIFFICULTIES = Object.freeze([1, 2, 3, 4, 5]);
const BODY_KEYS = Object.freeze([
  'schema', 'issuer', 'issuedAt', 'validUntil', 'nonce', 'judge', 'evidence',
]);
const ATTESTATION_KEYS = Object.freeze([...BODY_KEYS, 'attestationId', 'signature']);
const ISSUER_KEYS = Object.freeze(['issuerId', 'keyId']);
const JUDGE_KEYS = Object.freeze([
  'identityFingerprint', 'rubricFingerprint', 'corpusFingerprint',
  'holdoutFingerprint', 'workerIdentity',
]);
const EVIDENCE_KEYS = Object.freeze([
  'status', 'validationSampleCount', 'holdoutSampleCount', 'overallMaeMicros',
  'overallToleranceBasisPoints', 'reviewPrecisionBasisPoints',
  'reviewRecallBasisPoints', 'spearmanBasisPoints', 'categoryMetrics',
]);
const CATEGORY_KEYS = Object.freeze([
  'category', 'validationSampleCount', 'holdoutSampleCount', 'maeMicros',
  'toleranceBasisPoints', 'difficultyMetrics',
]);
const DIFFICULTY_KEYS = Object.freeze([
  'difficulty', 'validationSampleCount', 'holdoutSampleCount', 'maeMicros',
  'toleranceBasisPoints',
]);
const MIN_VALIDATION_SAMPLES_PER_DIFFICULTY_CELL = 2;
const MIN_HOLDOUT_SAMPLES_PER_DIFFICULTY_CELL = 3;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

function qualificationError(code, message, statusCode = 400) {
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
    throw qualificationError(
      'INVALID_JUDGE_QUALIFICATION_ATTESTATION',
      `${label} must contain exactly ${keys.join(', ')}`
    );
  }
  return value;
}

function identifier(value, label, minimumLength = 1) {
  if (typeof value !== 'string' || value.length < minimumLength || value.length > 180
      || value !== value.trim() || !IDENTIFIER_PATTERN.test(value)) {
    throw qualificationError('INVALID_JUDGE_QUALIFICATION_ATTESTATION', `${label} is invalid`);
  }
  return value;
}

function sha256Fingerprint(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw qualificationError(
      'INVALID_JUDGE_QUALIFICATION_ATTESTATION',
      `${label} must be a lowercase SHA-256 fingerprint`
    );
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)
      || new Date(value).toISOString() !== value) {
    throw qualificationError('INVALID_JUDGE_QUALIFICATION_ATTESTATION', `${label} is invalid`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw qualificationError(
      'INVALID_JUDGE_QUALIFICATION_ATTESTATION',
      `${label} must be an integer from ${minimum} through ${maximum}`
    );
  }
  return value;
}

function weightedHoldoutMetric(metrics, field) {
  const denominator = metrics.reduce((sum, metric) => sum + metric.holdoutSampleCount, 0);
  const numerator = metrics.reduce(
    (sum, metric) => sum + (metric[field] * metric.holdoutSampleCount),
    0
  );
  return Math.round(numerator / denominator);
}

function normalizeIssuer(raw) {
  const value = exactObject(raw, ISSUER_KEYS, 'issuer');
  return {
    issuerId: identifier(value.issuerId, 'issuer.issuerId'),
    keyId: identifier(value.keyId, 'issuer.keyId'),
  };
}

function normalizeJudge(raw) {
  const value = exactObject(raw, JUDGE_KEYS, 'judge');
  if (!isPlainObject(value.workerIdentity)) {
    throw qualificationError(
      'INVALID_JUDGE_QUALIFICATION_ATTESTATION',
      'judge.workerIdentity must be an object'
    );
  }
  const identityFingerprint = sha256Fingerprint(value.identityFingerprint, 'judge.identityFingerprint');
  if (workerFingerprint(value.workerIdentity) !== identityFingerprint) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_IDENTITY_MISMATCH',
      'judge identityFingerprint does not match workerIdentity'
    );
  }
  return {
    identityFingerprint,
    rubricFingerprint: sha256Fingerprint(value.rubricFingerprint, 'judge.rubricFingerprint'),
    corpusFingerprint: sha256Fingerprint(value.corpusFingerprint, 'judge.corpusFingerprint'),
    holdoutFingerprint: sha256Fingerprint(value.holdoutFingerprint, 'judge.holdoutFingerprint'),
    workerIdentity: value.workerIdentity,
  };
}

function normalizeEvidence(raw) {
  const value = exactObject(raw, EVIDENCE_KEYS, 'evidence');
  if (value.status !== 'qualified') {
    throw qualificationError(
      'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
      'evidence.status must be qualified',
      409
    );
  }
  if (!Array.isArray(value.categoryMetrics) || value.categoryMetrics.length !== QUALIFICATION_CATEGORIES.length) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
      'evidence.categoryMetrics must cover all seven categories exactly once',
      409
    );
  }
  const categoryMetrics = value.categoryMetrics.map((rawMetric, index) => {
    const metric = exactObject(rawMetric, CATEGORY_KEYS, `evidence.categoryMetrics[${index}]`);
    if (!QUALIFICATION_CATEGORIES.includes(metric.category)) {
      throw qualificationError(
        'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
        `evidence.categoryMetrics[${index}].category is invalid`,
        409
      );
    }
    if (!Array.isArray(metric.difficultyMetrics)
        || metric.difficultyMetrics.length !== QUALIFICATION_DIFFICULTIES.length) {
      throw qualificationError(
        'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
        `evidence.categoryMetrics[${index}].difficultyMetrics must cover difficulties 1 through 5 exactly once`,
        409
      );
    }
    const difficultyMetrics = metric.difficultyMetrics.map((rawDifficulty, difficultyIndex) => {
      const difficulty = exactObject(
        rawDifficulty,
        DIFFICULTY_KEYS,
        `evidence.categoryMetrics[${index}].difficultyMetrics[${difficultyIndex}]`
      );
      return {
        difficulty: boundedInteger(
          difficulty.difficulty,
          `evidence.categoryMetrics[${index}].difficultyMetrics[${difficultyIndex}].difficulty`,
          1,
          5
        ),
        validationSampleCount: boundedInteger(
          difficulty.validationSampleCount,
          `evidence.categoryMetrics[${index}].difficultyMetrics[${difficultyIndex}].validationSampleCount`,
          MIN_VALIDATION_SAMPLES_PER_DIFFICULTY_CELL,
          1_000_000
        ),
        holdoutSampleCount: boundedInteger(
          difficulty.holdoutSampleCount,
          `evidence.categoryMetrics[${index}].difficultyMetrics[${difficultyIndex}].holdoutSampleCount`,
          MIN_HOLDOUT_SAMPLES_PER_DIFFICULTY_CELL,
          1_000_000
        ),
        maeMicros: boundedInteger(
          difficulty.maeMicros,
          `evidence.categoryMetrics[${index}].difficultyMetrics[${difficultyIndex}].maeMicros`,
          0,
          10_000_000
        ),
        toleranceBasisPoints: boundedInteger(
          difficulty.toleranceBasisPoints,
          `evidence.categoryMetrics[${index}].difficultyMetrics[${difficultyIndex}].toleranceBasisPoints`,
          0,
          10_000
        ),
      };
    });
    const difficulties = difficultyMetrics.map(entry => entry.difficulty);
    if (new Set(difficulties).size !== QUALIFICATION_DIFFICULTIES.length
        || stableSerialize(difficulties) !== stableSerialize(QUALIFICATION_DIFFICULTIES)) {
      throw qualificationError(
        'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
        `evidence.categoryMetrics[${index}].difficultyMetrics must be unique and sorted canonically`,
        409
      );
    }
    const validationSampleCount = boundedInteger(
      metric.validationSampleCount,
      `evidence.categoryMetrics[${index}].validationSampleCount`,
      MIN_VALIDATION_SAMPLES_PER_DIFFICULTY_CELL * QUALIFICATION_DIFFICULTIES.length,
      1_000_000
    );
    const holdoutSampleCount = boundedInteger(
      metric.holdoutSampleCount,
      `evidence.categoryMetrics[${index}].holdoutSampleCount`,
      MIN_HOLDOUT_SAMPLES_PER_DIFFICULTY_CELL * QUALIFICATION_DIFFICULTIES.length,
      1_000_000
    );
    if (validationSampleCount !== difficultyMetrics.reduce(
      (sum, entry) => sum + entry.validationSampleCount,
      0
    ) || holdoutSampleCount !== difficultyMetrics.reduce(
      (sum, entry) => sum + entry.holdoutSampleCount,
      0
    )) {
      throw qualificationError(
        'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
        `evidence.categoryMetrics[${index}] sample totals must equal its five difficulty-cell sums`,
        409
      );
    }
    const maeMicros = boundedInteger(
      metric.maeMicros,
      `evidence.categoryMetrics[${index}].maeMicros`,
      0,
      10_000_000
    );
    const toleranceBasisPoints = boundedInteger(
      metric.toleranceBasisPoints,
      `evidence.categoryMetrics[${index}].toleranceBasisPoints`,
      0,
      10_000
    );
    if (maeMicros !== weightedHoldoutMetric(difficultyMetrics, 'maeMicros')
        || toleranceBasisPoints !== weightedHoldoutMetric(difficultyMetrics, 'toleranceBasisPoints')) {
      throw qualificationError(
        'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
        `evidence.categoryMetrics[${index}] metrics must equal the holdout-weighted difficulty metrics`,
        409
      );
    }
    return {
      category: metric.category,
      validationSampleCount,
      holdoutSampleCount,
      maeMicros,
      toleranceBasisPoints,
      difficultyMetrics,
    };
  });
  const categories = categoryMetrics.map(metric => metric.category);
  if (new Set(categories).size !== QUALIFICATION_CATEGORIES.length
      || stableSerialize(categories) !== stableSerialize(QUALIFICATION_CATEGORIES)) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
      'evidence.categoryMetrics must be unique and sorted canonically',
      409
    );
  }
  const validationSampleCount = boundedInteger(
    value.validationSampleCount,
    'evidence.validationSampleCount',
    MIN_VALIDATION_SAMPLES_PER_DIFFICULTY_CELL
      * QUALIFICATION_DIFFICULTIES.length
      * QUALIFICATION_CATEGORIES.length,
    1_000_000
  );
  const holdoutSampleCount = boundedInteger(
    value.holdoutSampleCount,
    'evidence.holdoutSampleCount',
    MIN_HOLDOUT_SAMPLES_PER_DIFFICULTY_CELL
      * QUALIFICATION_DIFFICULTIES.length
      * QUALIFICATION_CATEGORIES.length,
    1_000_000
  );
  if (validationSampleCount !== categoryMetrics.reduce(
    (sum, metric) => sum + metric.validationSampleCount,
    0
  ) || holdoutSampleCount !== categoryMetrics.reduce(
    (sum, metric) => sum + metric.holdoutSampleCount,
    0
  )) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
      'evidence sample totals must equal the sums of the seven category sample counts',
      409
    );
  }
  const evidence = {
    status: 'qualified',
    validationSampleCount,
    holdoutSampleCount,
    overallMaeMicros: boundedInteger(value.overallMaeMicros, 'evidence.overallMaeMicros', 0, 10_000_000),
    overallToleranceBasisPoints: boundedInteger(
      value.overallToleranceBasisPoints,
      'evidence.overallToleranceBasisPoints',
      0,
      10_000
    ),
    reviewPrecisionBasisPoints: boundedInteger(
      value.reviewPrecisionBasisPoints,
      'evidence.reviewPrecisionBasisPoints',
      0,
      10_000
    ),
    reviewRecallBasisPoints: boundedInteger(
      value.reviewRecallBasisPoints,
      'evidence.reviewRecallBasisPoints',
      0,
      10_000
    ),
    spearmanBasisPoints: boundedInteger(value.spearmanBasisPoints, 'evidence.spearmanBasisPoints', -10_000, 10_000),
    categoryMetrics,
  };
  if (evidence.overallMaeMicros !== weightedHoldoutMetric(categoryMetrics, 'maeMicros')
      || evidence.overallToleranceBasisPoints !== weightedHoldoutMetric(
        categoryMetrics,
        'toleranceBasisPoints'
      )) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
      'overall judge metrics must equal the holdout-weighted category metrics',
      409
    );
  }
  if (evidence.overallMaeMicros > 1_000_000
      || evidence.overallToleranceBasisPoints < 8_500
      || evidence.reviewPrecisionBasisPoints < 8_000
      || evidence.reviewRecallBasisPoints < 8_000
      || evidence.spearmanBasisPoints < 8_000
      || categoryMetrics.some(metric => metric.maeMicros > 1_500_000
        || metric.toleranceBasisPoints < 7_500
        || metric.difficultyMetrics.some(difficulty => difficulty.maeMicros > 1_500_000
          || difficulty.toleranceBasisPoints < 7_500))) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_THRESHOLDS_NOT_MET',
      'signed judge evidence does not meet the frozen qualification thresholds',
      409
    );
  }
  return evidence;
}

function normalizeBenchmarkJudgeQualificationAttestationBody(raw) {
  const value = exactObject(raw, BODY_KEYS, 'attestation body');
  if (value.schema !== BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA) {
    throw qualificationError(
      'INVALID_JUDGE_QUALIFICATION_ATTESTATION',
      `schema must be ${BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA}`
    );
  }
  const issuedAt = timestamp(value.issuedAt, 'issuedAt');
  const validUntil = timestamp(value.validUntil, 'validUntil');
  if (Date.parse(validUntil) <= Date.parse(issuedAt)) {
    throw qualificationError(
      'INVALID_JUDGE_QUALIFICATION_ATTESTATION',
      'validUntil must be later than issuedAt'
    );
  }
  return {
    schema: BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
    issuer: normalizeIssuer(value.issuer),
    issuedAt,
    validUntil,
    nonce: identifier(value.nonce, 'nonce', 32),
    judge: normalizeJudge(value.judge),
    evidence: normalizeEvidence(value.evidence),
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeBenchmarkJudgeQualificationAttestationId(rawBody) {
  return sha256(stableSerialize(normalizeBenchmarkJudgeQualificationAttestationBody(rawBody)));
}

function serializeBenchmarkJudgeQualificationAttestationSigningPayload(rawBody, attestationId = null) {
  const body = normalizeBenchmarkJudgeQualificationAttestationBody(rawBody);
  const computedId = sha256(stableSerialize(body));
  if (attestationId !== null && sha256Fingerprint(attestationId, 'attestationId') !== computedId) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_ATTESTATION_ID_MISMATCH',
      'attestationId does not match the canonical body'
    );
  }
  return stableSerialize({ ...body, attestationId: computedId });
}

function normalizeBenchmarkJudgeQualificationAttestation(raw) {
  const value = exactObject(raw, ATTESTATION_KEYS, 'attestation');
  const body = normalizeBenchmarkJudgeQualificationAttestationBody(
    Object.fromEntries(BODY_KEYS.map(key => [key, value[key]]))
  );
  const attestationId = sha256Fingerprint(value.attestationId, 'attestationId');
  if (attestationId !== sha256(stableSerialize(body))) {
    throw qualificationError(
      'JUDGE_QUALIFICATION_ATTESTATION_ID_MISMATCH',
      'attestationId does not match the canonical body'
    );
  }
  if (typeof value.signature !== 'string' || !SIGNATURE_PATTERN.test(value.signature)) {
    throw qualificationError('INVALID_JUDGE_QUALIFICATION_ATTESTATION', 'signature is invalid');
  }
  const signature = Buffer.from(value.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== value.signature) {
    throw qualificationError('INVALID_JUDGE_QUALIFICATION_ATTESTATION', 'signature is invalid');
  }
  return { ...body, attestationId, signature: value.signature };
}

function verifyBenchmarkJudgeQualificationAttestation(raw, options = {}) {
  const attestation = normalizeBenchmarkJudgeQualificationAttestation(raw);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const skew = Number.isSafeInteger(options.maxClockSkewMs) && options.maxClockSkewMs >= 0
    ? options.maxClockSkewMs
    : 300_000;
  if (!Number.isFinite(now.getTime())) {
    throw qualificationError('INVALID_JUDGE_QUALIFICATION_VERIFICATION_TIME', 'verification time is invalid');
  }
  if (Date.parse(attestation.issuedAt) > now.getTime() + skew) {
    throw qualificationError('JUDGE_QUALIFICATION_NOT_YET_VALID', 'judge qualification is not yet valid', 403);
  }
  if (Date.parse(attestation.validUntil) < now.getTime()) {
    throw qualificationError('JUDGE_QUALIFICATION_EXPIRED', 'judge qualification has expired', 403);
  }
  let publicKey;
  try {
    publicKey = options.publicKey instanceof crypto.KeyObject
      ? options.publicKey
      : crypto.createPublicKey(options.publicKey);
  } catch (_error) {
    throw qualificationError('JUDGE_QUALIFICATION_TRUST_ROOT_INVALID', 'configured public key is invalid', 503);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw qualificationError('JUDGE_QUALIFICATION_TRUST_ROOT_INVALID', 'configured public key must be Ed25519', 503);
  }
  const body = Object.fromEntries(BODY_KEYS.map(key => [key, attestation[key]]));
  const payload = serializeBenchmarkJudgeQualificationAttestationSigningPayload(body, attestation.attestationId);
  if (!crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(attestation.signature, 'base64url'))) {
    throw qualificationError('JUDGE_QUALIFICATION_SIGNATURE_INVALID', 'judge qualification signature is invalid', 403);
  }
  return attestation;
}

module.exports = {
  BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
  MIN_HOLDOUT_SAMPLES_PER_DIFFICULTY_CELL,
  MIN_VALIDATION_SAMPLES_PER_DIFFICULTY_CELL,
  QUALIFICATION_CATEGORIES,
  QUALIFICATION_DIFFICULTIES,
  computeBenchmarkJudgeQualificationAttestationId,
  normalizeBenchmarkJudgeQualificationAttestation,
  normalizeBenchmarkJudgeQualificationAttestationBody,
  serializeBenchmarkJudgeQualificationAttestationSigningPayload,
  verifyBenchmarkJudgeQualificationAttestation,
};

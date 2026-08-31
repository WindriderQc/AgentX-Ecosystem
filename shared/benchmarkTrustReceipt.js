'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('./artifactIdentity');

const BENCHMARK_TRUST_RECEIPT_SCHEMA = 'agentx.benchmark-trust-receipt/v1';
const BENCHMARK_TRUST_RATIFICATION_SCHEMA = 'agentx.benchmark-trust-ratification/v1';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAMPAIGN_ID_PATTERN = /^campaign_[0-9a-f]{32}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;
const CANDIDATE_ID_PATTERN = /^candidate_[0-9a-f]{32}$/;

const CLAIM_SCOPES = Object.freeze(['capability', 'deployment_fit']);
const EVIDENCE_STATUSES = Object.freeze(['complete', 'incomplete', 'incompatible', 'invalid']);
const DECISION_OUTCOMES = Object.freeze(['winner', 'equivalence_set', 'inconclusive', 'not_evaluated']);
const FRESHNESS_STATUSES = Object.freeze(['fresh', 'stale', 'expired']);
const RATIFICATION_STATUSES = Object.freeze(['unratified', 'ratified', 'revoked']);
const JUDGE_QUALIFICATION_STATUSES = Object.freeze(['qualified', 'unqualified', 'expired']);
// v1 has one integrated estimand and one family-wise correction. Expanding
// these independently would allow a caller to mint a structurally valid
// winner that the Product statistics engine never computed.
const STATISTICAL_METHODS = Object.freeze(['paired-prompt-t-v1']);
const MULTIPLICITY_CORRECTIONS = Object.freeze(['bonferroni']);

const RECEIPT_KEYS = Object.freeze([
  'schema',
  'receiptId',
  'createdAt',
  'validUntil',
  'claimScope',
  'product',
  'execution',
  'judge',
  'statistics',
  'axes',
  'privacy',
]);

const RECEIPT_BODY_KEYS = Object.freeze(RECEIPT_KEYS.filter((key) => key !== 'receiptId'));
const PRODUCT_KEYS = Object.freeze(['revision', 'coreImageDigest', 'benchmarkImageDigest', 'ragImageDigest']);
const EXECUTION_KEYS = Object.freeze([
  'campaignId',
  'sourceBatchId',
  'campaignFingerprint',
  'inferenceProfileFingerprint',
  'promptCatalogFingerprint',
  'candidateSetFingerprint',
  'cellInventory',
  'promptCount',
  'expectedResultCount',
  'observedResultCount',
  'excludedResultCount',
  'exclusionManifestFingerprint',
  'candidates',
]);
const CELL_INVENTORY_KEYS = Object.freeze([
  'fingerprint',
  'cellCount',
  'minimumRepeatCount',
  'maximumRepeatCount',
]);
const CANDIDATE_KEYS = Object.freeze([
  'candidateId',
  'artifactFingerprint',
  'runtimeFingerprint',
  'environmentFingerprint',
  'resultSetFingerprint',
]);
const JUDGE_KEYS = Object.freeze([
  'qualificationReceiptId',
  'identityFingerprint',
  'rubricFingerprint',
  'corpusFingerprint',
  'holdoutFingerprint',
  'qualificationStatus',
  'validUntil',
]);
const STATISTICS_KEYS = Object.freeze([
  'unit',
  'method',
  'alphaBasisPoints',
  'multiplicityCorrection',
  'minimumEffectMicros',
  'preregistration',
  'rankingPolicyFingerprint',
  'decisionFingerprint',
  'winnerCandidateId',
  'equivalenceCandidateIds',
]);
const PREREGISTRATION_KEYS = Object.freeze(['repeatCount', 'analysisPlanFingerprint']);
const AXES_KEYS = Object.freeze([
  'evidenceStatus',
  'decisionOutcome',
  'freshnessStatus',
]);
const PRIVACY_KEYS = Object.freeze([
  'containsRawPrompts',
  'containsRawResponses',
  'containsPrivateEnvironmentIdentity',
  'containsProviderPayloads',
  'containsSecrets',
]);
const RATIFICATION_KEYS = Object.freeze([
  'schema',
  'receiptId',
  'status',
  'ratifiedAt',
  'authorityFingerprint',
  'attestationFingerprint',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (extra.length) errors.push(`${label} has unsupported keys: ${extra.join(', ')}`);
  return missing.length === 0 && extra.length === 0;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isFingerprint(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function copyCandidate(candidate) {
  const value = isPlainObject(candidate) ? candidate : {};
  return { ...value };
}

function normalizedCandidates(candidates) {
  if (!Array.isArray(candidates)) return candidates;
  return candidates
    .map(copyCandidate)
    .sort((left, right) => {
      const leftId = String(left.candidateId || '');
      const rightId = String(right.candidateId || '');
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

function candidateIdentity(candidate) {
  return {
    candidateId: candidate.candidateId,
    artifactFingerprint: candidate.artifactFingerprint,
    runtimeFingerprint: candidate.runtimeFingerprint,
    environmentFingerprint: candidate.environmentFingerprint,
  };
}

function computeCandidateSetFingerprint(candidates) {
  return sha256(stableSerialize(normalizedCandidates(candidates).map(candidateIdentity)));
}

function normalizeReceiptBody(input) {
  return {
    schema: input.schema,
    createdAt: input.createdAt,
    validUntil: input.validUntil,
    claimScope: input.claimScope,
    product: { ...input.product },
    execution: {
      ...input.execution,
      candidates: normalizedCandidates(input.execution?.candidates),
    },
    judge: { ...input.judge },
    statistics: {
      ...input.statistics,
      equivalenceCandidateIds: Array.isArray(input.statistics?.equivalenceCandidateIds)
        ? [...input.statistics.equivalenceCandidateIds].sort()
        : input.statistics?.equivalenceCandidateIds,
    },
    axes: { ...input.axes },
    privacy: { ...input.privacy },
  };
}

function computeBenchmarkTrustReceiptId(receiptOrBody) {
  const body = normalizeReceiptBody(receiptOrBody);
  return sha256(stableSerialize(body));
}

function buildBenchmarkTrustReceipt(input) {
  const keys = Object.keys(input || {});
  const expectedKeys = RECEIPT_BODY_KEYS;
  const missing = expectedKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !expectedKeys.includes(key));
  if (missing.length || extra.length) {
    const details = [];
    if (missing.length) details.push(`input is missing keys: ${missing.join(', ')}`);
    if (extra.length) details.push(`input has unsupported keys: ${extra.join(', ')}`);
    const error = new Error(`Invalid Agent X benchmark trust receipt input:\n- ${details.join('\n- ')}`);
    error.code = 'INVALID_BENCHMARK_TRUST_RECEIPT';
    error.details = details;
    throw error;
  }

  const body = normalizeReceiptBody(input);
  const receipt = { ...body, receiptId: computeBenchmarkTrustReceiptId(body) };
  return assertBenchmarkTrustReceipt(receipt);
}

function validateFingerprintFields(value, keys, label, errors) {
  for (const key of keys) {
    if (!isFingerprint(value?.[key])) {
      errors.push(`${label}.${key} must be a lowercase SHA-256 fingerprint`);
    }
  }
}

function validateBenchmarkTrustReceipt(receipt) {
  const errors = [];
  if (!hasExactKeys(receipt, RECEIPT_KEYS, 'receipt', errors)) return { valid: false, errors };

  if (receipt.schema !== BENCHMARK_TRUST_RECEIPT_SCHEMA) {
    errors.push(`receipt.schema must be ${BENCHMARK_TRUST_RECEIPT_SCHEMA}`);
  }
  if (!isFingerprint(receipt.receiptId)) {
    errors.push('receipt.receiptId must be a lowercase SHA-256 fingerprint');
  }
  if (!isCanonicalIsoTimestamp(receipt.createdAt)) {
    errors.push('receipt.createdAt must be a canonical UTC timestamp with milliseconds');
  }
  if (!isCanonicalIsoTimestamp(receipt.validUntil)) {
    errors.push('receipt.validUntil must be a canonical UTC timestamp with milliseconds');
  }
  if (
    isCanonicalIsoTimestamp(receipt.createdAt)
    && isCanonicalIsoTimestamp(receipt.validUntil)
    && Date.parse(receipt.validUntil) <= Date.parse(receipt.createdAt)
  ) {
    errors.push('receipt.validUntil must be later than receipt.createdAt');
  }
  if (!CLAIM_SCOPES.includes(receipt.claimScope)) {
    errors.push(`receipt.claimScope must be one of ${CLAIM_SCOPES.join(', ')}`);
  }

  if (hasExactKeys(receipt.product, PRODUCT_KEYS, 'receipt.product', errors)) {
    if (!GIT_REVISION_PATTERN.test(receipt.product.revision || '')) {
      errors.push('receipt.product.revision must be a full lowercase Git revision');
    }
    for (const key of ['coreImageDigest', 'benchmarkImageDigest', 'ragImageDigest']) {
      if (!IMAGE_DIGEST_PATTERN.test(receipt.product[key] || '')) {
        errors.push(`receipt.product.${key} must be a lowercase image digest`);
      }
    }
  }

  let candidateIds = [];
  if (hasExactKeys(receipt.execution, EXECUTION_KEYS, 'receipt.execution', errors)) {
    if (typeof receipt.execution.campaignId !== 'string' || !CAMPAIGN_ID_PATTERN.test(receipt.execution.campaignId)) {
      errors.push('receipt.execution.campaignId must be an opaque campaign identifier');
    }
    if (typeof receipt.execution.sourceBatchId !== 'string' || !SOURCE_BATCH_ID_PATTERN.test(receipt.execution.sourceBatchId)) {
      errors.push('receipt.execution.sourceBatchId must be an opaque source-batch identifier');
    }
    validateFingerprintFields(
      receipt.execution,
      ['campaignFingerprint', 'inferenceProfileFingerprint', 'promptCatalogFingerprint', 'candidateSetFingerprint'],
      'receipt.execution',
      errors
    );
    for (const key of ['promptCount', 'expectedResultCount', 'observedResultCount', 'excludedResultCount']) {
      if (!isNonNegativeSafeInteger(receipt.execution[key])) {
        errors.push(`receipt.execution.${key} must be a non-negative safe integer`);
      }
    }
    if (receipt.execution.promptCount === 0) {
      errors.push('receipt.execution.promptCount must be greater than zero');
    }
    if (receipt.execution.expectedResultCount === 0) {
      errors.push('receipt.execution.expectedResultCount must be greater than zero');
    }
    if (
      isNonNegativeSafeInteger(receipt.execution.expectedResultCount)
      && isNonNegativeSafeInteger(receipt.execution.observedResultCount)
      && isNonNegativeSafeInteger(receipt.execution.excludedResultCount)
      && receipt.execution.observedResultCount + receipt.execution.excludedResultCount !== receipt.execution.expectedResultCount
    ) {
      errors.push('receipt.execution observed plus excluded results must equal expected results');
    }
    if (receipt.execution.excludedResultCount === 0 && receipt.execution.exclusionManifestFingerprint !== null) {
      errors.push('receipt.execution.exclusionManifestFingerprint must be null when no results were excluded');
    }
    if (receipt.execution.excludedResultCount > 0 && !isFingerprint(receipt.execution.exclusionManifestFingerprint)) {
      errors.push('receipt.execution.exclusionManifestFingerprint must bind every excluded result');
    }
    if (hasExactKeys(receipt.execution.cellInventory, CELL_INVENTORY_KEYS, 'receipt.execution.cellInventory', errors)) {
      if (!isFingerprint(receipt.execution.cellInventory.fingerprint)) {
        errors.push('receipt.execution.cellInventory.fingerprint must be a lowercase SHA-256 fingerprint');
      }
      for (const key of ['cellCount', 'minimumRepeatCount', 'maximumRepeatCount']) {
        if (!isNonNegativeSafeInteger(receipt.execution.cellInventory[key])) {
          errors.push(`receipt.execution.cellInventory.${key} must be a non-negative safe integer`);
        }
      }
      if (
        isNonNegativeSafeInteger(receipt.execution.cellInventory.minimumRepeatCount)
        && isNonNegativeSafeInteger(receipt.execution.cellInventory.maximumRepeatCount)
        && receipt.execution.cellInventory.minimumRepeatCount > receipt.execution.cellInventory.maximumRepeatCount
      ) {
        errors.push('receipt.execution.cellInventory minimumRepeatCount cannot exceed maximumRepeatCount');
      }
    }

    if (!Array.isArray(receipt.execution.candidates) || receipt.execution.candidates.length < 2) {
      errors.push('receipt.execution.candidates must contain at least two candidates');
    } else {
      candidateIds = receipt.execution.candidates.map((candidate) => candidate?.candidateId);
      for (const [index, candidate] of receipt.execution.candidates.entries()) {
        const label = `receipt.execution.candidates[${index}]`;
        if (!hasExactKeys(candidate, CANDIDATE_KEYS, label, errors)) continue;
        if (typeof candidate.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidate.candidateId)) {
          errors.push(`${label}.candidateId must be an opaque candidate identifier`);
        }
        validateFingerprintFields(
          candidate,
          ['artifactFingerprint', 'runtimeFingerprint', 'environmentFingerprint', 'resultSetFingerprint'],
          label,
          errors
        );
      }
      if (new Set(candidateIds).size !== candidateIds.length) {
        errors.push('receipt.execution candidate identifiers must be unique');
      }
      if (candidateIds.join('\n') !== [...candidateIds].sort().join('\n')) {
        errors.push('receipt.execution.candidates must be sorted by candidateId');
      }
      if (
        receipt.execution.candidates.every((candidate) => hasExactKeysSilently(candidate, CANDIDATE_KEYS))
        && isFingerprint(receipt.execution.candidateSetFingerprint)
        && receipt.execution.candidateSetFingerprint !== computeCandidateSetFingerprint(receipt.execution.candidates)
      ) {
        errors.push('receipt.execution.candidateSetFingerprint does not match candidate identities');
      }
    }
  }

  if (hasExactKeys(receipt.judge, JUDGE_KEYS, 'receipt.judge', errors)) {
    validateFingerprintFields(
      receipt.judge,
      ['qualificationReceiptId', 'identityFingerprint', 'rubricFingerprint', 'corpusFingerprint', 'holdoutFingerprint'],
      'receipt.judge',
      errors
    );
    if (!JUDGE_QUALIFICATION_STATUSES.includes(receipt.judge.qualificationStatus)) {
      errors.push(`receipt.judge.qualificationStatus must be one of ${JUDGE_QUALIFICATION_STATUSES.join(', ')}`);
    }
    if (!isCanonicalIsoTimestamp(receipt.judge.validUntil)) {
      errors.push('receipt.judge.validUntil must be a canonical UTC timestamp with milliseconds');
    }
    if (
      receipt.judge.qualificationStatus === 'qualified'
      && isCanonicalIsoTimestamp(receipt.createdAt)
      && isCanonicalIsoTimestamp(receipt.judge.validUntil)
      && Date.parse(receipt.judge.validUntil) <= Date.parse(receipt.createdAt)
    ) {
      errors.push('a qualified judge must remain valid after receipt creation');
    }
  }

  if (hasExactKeys(receipt.statistics, STATISTICS_KEYS, 'receipt.statistics', errors)) {
    if (receipt.statistics.unit !== 'prompt') errors.push('receipt.statistics.unit must be prompt');
    if (!STATISTICAL_METHODS.includes(receipt.statistics.method)) {
      errors.push(`receipt.statistics.method must be one of ${STATISTICAL_METHODS.join(', ')}`);
    }
    if (
      !Number.isSafeInteger(receipt.statistics.alphaBasisPoints)
      || receipt.statistics.alphaBasisPoints < 1
      || receipt.statistics.alphaBasisPoints > 5000
    ) {
      errors.push('receipt.statistics.alphaBasisPoints must be an integer from 1 through 5000');
    }
    if (!MULTIPLICITY_CORRECTIONS.includes(receipt.statistics.multiplicityCorrection)) {
      errors.push(`receipt.statistics.multiplicityCorrection must be one of ${MULTIPLICITY_CORRECTIONS.join(', ')}`);
    }
    if (!isNonNegativeSafeInteger(receipt.statistics.minimumEffectMicros)) {
      errors.push('receipt.statistics.minimumEffectMicros must be a non-negative safe integer');
    }
    if (hasExactKeys(
      receipt.statistics.preregistration,
      PREREGISTRATION_KEYS,
      'receipt.statistics.preregistration',
      errors
    )) {
      if (!Number.isSafeInteger(receipt.statistics.preregistration.repeatCount)
        || receipt.statistics.preregistration.repeatCount <= 0) {
        errors.push('receipt.statistics.preregistration.repeatCount must be a positive safe integer');
      }
      if (!isFingerprint(receipt.statistics.preregistration.analysisPlanFingerprint)) {
        errors.push('receipt.statistics.preregistration.analysisPlanFingerprint must be a lowercase SHA-256 fingerprint');
      }
    }
    if (!isFingerprint(receipt.statistics.rankingPolicyFingerprint)) {
      errors.push('receipt.statistics.rankingPolicyFingerprint must be a lowercase SHA-256 fingerprint');
    }
    if (!isFingerprint(receipt.statistics.decisionFingerprint)) {
      errors.push('receipt.statistics.decisionFingerprint must be a lowercase SHA-256 fingerprint');
    }
    if (
      receipt.statistics.winnerCandidateId !== null
      && (typeof receipt.statistics.winnerCandidateId !== 'string'
        || !CANDIDATE_ID_PATTERN.test(receipt.statistics.winnerCandidateId))
    ) {
      errors.push('receipt.statistics.winnerCandidateId must be null or an opaque candidate identifier');
    }
    if (!Array.isArray(receipt.statistics.equivalenceCandidateIds)) {
      errors.push('receipt.statistics.equivalenceCandidateIds must be an array');
    } else {
      const equivalenceIds = receipt.statistics.equivalenceCandidateIds;
      if (equivalenceIds.some((candidateId) => typeof candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidateId))) {
        errors.push('receipt.statistics.equivalenceCandidateIds must contain opaque candidate identifiers');
      }
      if (new Set(equivalenceIds).size !== equivalenceIds.length) {
        errors.push('receipt.statistics.equivalenceCandidateIds must be unique');
      }
      if (equivalenceIds.join('\n') !== [...equivalenceIds].sort().join('\n')) {
        errors.push('receipt.statistics.equivalenceCandidateIds must be sorted');
      }
      if (equivalenceIds.some((candidateId) => !candidateIds.includes(candidateId))) {
        errors.push('receipt.statistics.equivalenceCandidateIds must reference declared candidates');
      }
    }
    if (
      receipt.statistics.winnerCandidateId !== null
      && !candidateIds.includes(receipt.statistics.winnerCandidateId)
    ) {
      errors.push('receipt.statistics.winnerCandidateId must reference a declared candidate');
    }
  }

  if (hasExactKeys(receipt.axes, AXES_KEYS, 'receipt.axes', errors)) {
    if (!EVIDENCE_STATUSES.includes(receipt.axes.evidenceStatus)) {
      errors.push(`receipt.axes.evidenceStatus must be one of ${EVIDENCE_STATUSES.join(', ')}`);
    }
    if (!DECISION_OUTCOMES.includes(receipt.axes.decisionOutcome)) {
      errors.push(`receipt.axes.decisionOutcome must be one of ${DECISION_OUTCOMES.join(', ')}`);
    }
    if (!FRESHNESS_STATUSES.includes(receipt.axes.freshnessStatus)) {
      errors.push(`receipt.axes.freshnessStatus must be one of ${FRESHNESS_STATUSES.join(', ')}`);
    }
  }

  validateDecisionConsistency(receipt, errors);
  validateInventoryConsistency(receipt, candidateIds, errors);

  if (hasExactKeys(receipt.privacy, PRIVACY_KEYS, 'receipt.privacy', errors)) {
    for (const key of PRIVACY_KEYS) {
      if (receipt.privacy[key] !== false) errors.push(`receipt.privacy.${key} must be false`);
    }
  }

  if (
    isFingerprint(receipt.receiptId)
    && receipt.receiptId !== computeBenchmarkTrustReceiptId(receipt)
  ) {
    errors.push('receipt.receiptId does not match the normalized immutable receipt body');
  }

  return { valid: errors.length === 0, errors };
}

function validateInventoryConsistency(receipt, candidateIds, errors) {
  if (!isPlainObject(receipt.execution) || !isPlainObject(receipt.statistics?.preregistration)) return;
  const { promptCount, expectedResultCount, observedResultCount, excludedResultCount } = receipt.execution;
  const { repeatCount } = receipt.statistics.preregistration;
  const cellInventory = receipt.execution.cellInventory;
  if (
    Number.isSafeInteger(promptCount)
    && Number.isSafeInteger(repeatCount)
    && candidateIds.length >= 2
    && Number.isSafeInteger(expectedResultCount)
    && expectedResultCount !== candidateIds.length * promptCount * repeatCount
  ) {
    errors.push('receipt.execution.expectedResultCount must equal candidates times prompts times preregistered repeats');
  }
  if (
    isPlainObject(cellInventory)
    && Number.isSafeInteger(promptCount)
    && cellInventory.cellCount !== candidateIds.length * promptCount
  ) {
    errors.push('receipt.execution.cellInventory.cellCount must equal candidates times prompts');
  }
  if (
    receipt.axes?.evidenceStatus === 'complete'
    && (
      excludedResultCount !== 0
      || observedResultCount !== expectedResultCount
      || cellInventory?.minimumRepeatCount !== repeatCount
      || cellInventory?.maximumRepeatCount !== repeatCount
    )
  ) {
    errors.push('complete evidence requires every preregistered candidate-prompt repetition and no exclusions');
  }
}

function hasExactKeysSilently(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateDecisionConsistency(receipt, errors) {
  if (!isPlainObject(receipt.statistics) || !isPlainObject(receipt.axes)) return;
  const outcome = receipt.axes.decisionOutcome;
  const winner = receipt.statistics.winnerCandidateId;
  const equivalence = receipt.statistics.equivalenceCandidateIds;
  if (!Array.isArray(equivalence)) return;

  if (outcome === 'winner') {
    if (winner === null) errors.push('winner decision requires receipt.statistics.winnerCandidateId');
    if (equivalence.length !== 0) errors.push('winner decision cannot include an equivalence set');
  }
  if (outcome === 'equivalence_set') {
    if (winner !== null) errors.push('equivalence_set decision cannot include a winner');
    if (equivalence.length < 2) errors.push('equivalence_set decision requires at least two candidates');
  }
  if (outcome === 'inconclusive' || outcome === 'not_evaluated') {
    if (winner !== null) errors.push(`${outcome} decision cannot include a winner`);
    if (equivalence.length !== 0) errors.push(`${outcome} decision cannot include an equivalence set`);
  }
  if (receipt.axes.evidenceStatus !== 'complete' && (outcome === 'winner' || outcome === 'equivalence_set')) {
    errors.push('incomplete, incompatible, or invalid evidence cannot declare a winner or equivalence set');
  }
  if (
    receipt.judge?.qualificationStatus !== 'qualified'
    && (outcome === 'winner' || outcome === 'equivalence_set')
  ) {
    errors.push('a winner or equivalence-set decision requires a qualified judge receipt');
  }
}

function assertBenchmarkTrustReceipt(receipt) {
  const result = validateBenchmarkTrustReceipt(receipt);
  if (!result.valid) {
    const error = new Error(`Invalid Agent X benchmark trust receipt:\n- ${result.errors.join('\n- ')}`);
    error.code = 'INVALID_BENCHMARK_TRUST_RECEIPT';
    error.details = result.errors;
    throw error;
  }
  return receipt;
}

function serializeBenchmarkTrustReceipt(receipt) {
  return stableSerialize(assertBenchmarkTrustReceipt(receipt));
}

function validateBenchmarkTrustRatification(ratification) {
  const errors = [];
  if (!hasExactKeys(ratification, RATIFICATION_KEYS, 'ratification', errors)) {
    return { valid: false, errors };
  }
  if (ratification.schema !== BENCHMARK_TRUST_RATIFICATION_SCHEMA) {
    errors.push(`ratification.schema must be ${BENCHMARK_TRUST_RATIFICATION_SCHEMA}`);
  }
  if (!isFingerprint(ratification.receiptId)) {
    errors.push('ratification.receiptId must be a lowercase SHA-256 fingerprint');
  }
  if (!['ratified', 'revoked'].includes(ratification.status)) {
    errors.push('ratification.status must be ratified or revoked');
  }
  if (!isCanonicalIsoTimestamp(ratification.ratifiedAt)) {
    errors.push('ratification.ratifiedAt must be a canonical UTC timestamp with milliseconds');
  }
  if (!isFingerprint(ratification.authorityFingerprint)) {
    errors.push('ratification.authorityFingerprint must be a lowercase SHA-256 fingerprint');
  }
  if (!isFingerprint(ratification.attestationFingerprint)) {
    errors.push('ratification.attestationFingerprint must be a lowercase SHA-256 fingerprint');
  }
  return { valid: errors.length === 0, errors };
}

function deriveBenchmarkQualification(receipt, ratification = null, options = {}) {
  const receiptValidation = validateBenchmarkTrustReceipt(receipt);
  const reasons = [];
  if (!receiptValidation.valid) reasons.push('invalid_receipt');
  if (receipt?.axes?.evidenceStatus !== 'complete') reasons.push('evidence_not_complete');
  if (receipt?.axes?.decisionOutcome !== 'winner') reasons.push('no_statistical_winner');
  if (receipt?.axes?.freshnessStatus !== 'fresh') reasons.push('evidence_not_fresh');
  if (receipt?.judge?.qualificationStatus !== 'qualified') reasons.push('judge_not_qualified');

  // The receipt only binds the opaque identity of a judge qualification. Its
  // status, holdout, corpus and validity are claims until a consumer verifies
  // the separate qualification attestation against its current trust root.
  if (typeof options.verifyJudgeQualification !== 'function') {
    reasons.push('judge_qualification_not_verified');
  } else {
    try {
      if (options.verifyJudgeQualification(receipt?.judge, receipt) !== true) {
        reasons.push('judge_qualification_not_verified');
      }
    } catch (_error) {
      reasons.push('judge_qualification_not_verified');
    }
  }

  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) {
    reasons.push('invalid_verification_time');
  } else {
    if (isCanonicalIsoTimestamp(receipt?.validUntil) && now.getTime() > Date.parse(receipt.validUntil)) {
      reasons.push('receipt_expired');
    }
    if (isCanonicalIsoTimestamp(receipt?.judge?.validUntil) && now.getTime() > Date.parse(receipt.judge.validUntil)) {
      reasons.push('judge_qualification_expired');
    }
  }

  const ratificationValidation = validateBenchmarkTrustRatification(ratification);
  let ratificationStatus = 'unratified';
  let ratificationVerified = false;
  if (!ratificationValidation.valid) {
    reasons.push('missing_or_invalid_ratification');
  } else {
    if (ratification.receiptId !== receipt?.receiptId) reasons.push('ratification_receipt_mismatch');
    if (
      isCanonicalIsoTimestamp(receipt?.createdAt)
      && Date.parse(ratification.ratifiedAt) < Date.parse(receipt.createdAt)
    ) {
      reasons.push('ratification_predates_receipt');
    }
    if (Number.isFinite(now.getTime()) && Date.parse(ratification.ratifiedAt) > now.getTime()) {
      reasons.push('ratification_in_future');
    }
    if (typeof options.verifyRatification !== 'function') {
      reasons.push('ratification_not_verified');
    } else {
      try {
        if (options.verifyRatification(ratification, receipt) === true) {
          ratificationVerified = true;
        } else {
          reasons.push('ratification_not_verified');
        }
      } catch (_error) {
        reasons.push('ratification_not_verified');
      }
    }
    if (
      ratificationVerified
      && ratification.receiptId === receipt?.receiptId
      && !reasons.includes('ratification_predates_receipt')
      && !reasons.includes('ratification_in_future')
    ) {
      ratificationStatus = ratification.status;
    }
  }

  if (ratificationStatus !== 'ratified') reasons.push('not_ratified');
  if (ratificationStatus === 'revoked') reasons.push('ratification_revoked');

  const uniqueReasons = [...new Set(reasons)];
  const qualified = uniqueReasons.length === 0;
  return {
    qualified,
    qualifiedWinner: qualified ? receipt.statistics.winnerCandidateId : null,
    ratificationStatus,
    reasons: uniqueReasons,
  };
}

module.exports = {
  BENCHMARK_TRUST_RATIFICATION_SCHEMA,
  BENCHMARK_TRUST_RECEIPT_SCHEMA,
  CLAIM_SCOPES,
  DECISION_OUTCOMES,
  EVIDENCE_STATUSES,
  FRESHNESS_STATUSES,
  JUDGE_QUALIFICATION_STATUSES,
  MULTIPLICITY_CORRECTIONS,
  RATIFICATION_STATUSES,
  STATISTICAL_METHODS,
  assertBenchmarkTrustReceipt,
  buildBenchmarkTrustReceipt,
  computeBenchmarkTrustReceiptId,
  computeCandidateSetFingerprint,
  deriveBenchmarkQualification,
  serializeBenchmarkTrustReceipt,
  validateBenchmarkTrustRatification,
  validateBenchmarkTrustReceipt,
};

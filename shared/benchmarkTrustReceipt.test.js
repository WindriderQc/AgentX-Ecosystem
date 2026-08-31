'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BENCHMARK_TRUST_RATIFICATION_SCHEMA,
  BENCHMARK_TRUST_RECEIPT_SCHEMA,
  buildBenchmarkTrustReceipt,
  computeCandidateSetFingerprint,
  deriveBenchmarkQualification,
  serializeBenchmarkTrustReceipt,
  validateBenchmarkTrustReceipt,
} = require('./benchmarkTrustReceipt');

const CANDIDATE_A = `candidate_${'a'.repeat(32)}`;
const CANDIDATE_B = `candidate_${'b'.repeat(32)}`;
const CAMPAIGN_ID = `campaign_${'c'.repeat(32)}`;
const SOURCE_BATCH_ID = `batch_${'d'.repeat(32)}`;

function bodyFixture(overrides = {}) {
  const { candidates: overriddenCandidates, ...bodyOverrides } = overrides;
  const candidates = overriddenCandidates || [
    {
      candidateId: CANDIDATE_A,
      artifactFingerprint: '1'.repeat(64),
      runtimeFingerprint: '2'.repeat(64),
      environmentFingerprint: '3'.repeat(64),
      resultSetFingerprint: '4'.repeat(64),
    },
    {
      candidateId: CANDIDATE_B,
      artifactFingerprint: '5'.repeat(64),
      runtimeFingerprint: '6'.repeat(64),
      environmentFingerprint: '7'.repeat(64),
      resultSetFingerprint: '8'.repeat(64),
    },
  ];
  return {
    schema: BENCHMARK_TRUST_RECEIPT_SCHEMA,
    createdAt: '2026-08-31T12:00:00.000Z',
    validUntil: '2026-09-30T12:00:00.000Z',
    claimScope: 'capability',
    product: {
      revision: 'a'.repeat(40),
      coreImageDigest: `sha256:${'b'.repeat(64)}`,
      benchmarkImageDigest: `sha256:${'c'.repeat(64)}`,
      ragImageDigest: `sha256:${'d'.repeat(64)}`,
    },
    execution: {
      campaignId: CAMPAIGN_ID,
      sourceBatchId: SOURCE_BATCH_ID,
      campaignFingerprint: 'e'.repeat(64),
      inferenceProfileFingerprint: 'f'.repeat(64),
      promptCatalogFingerprint: '0'.repeat(64),
      candidateSetFingerprint: computeCandidateSetFingerprint(candidates),
      cellInventory: {
        fingerprint: '3'.repeat(64),
        cellCount: 50,
        minimumRepeatCount: 2,
        maximumRepeatCount: 2,
      },
      promptCount: 25,
      expectedResultCount: 100,
      observedResultCount: 100,
      excludedResultCount: 0,
      exclusionManifestFingerprint: null,
      candidates,
    },
    judge: {
      qualificationReceiptId: '9'.repeat(64),
      identityFingerprint: 'a'.repeat(64),
      rubricFingerprint: 'b'.repeat(64),
      corpusFingerprint: 'c'.repeat(64),
      holdoutFingerprint: 'd'.repeat(64),
      qualificationStatus: 'qualified',
      validUntil: '2026-09-15T12:00:00.000Z',
    },
    statistics: {
      unit: 'prompt',
      method: 'paired-prompt-t-v1',
      alphaBasisPoints: 500,
      multiplicityCorrection: 'bonferroni',
      minimumEffectMicros: 25000,
      preregistration: {
        repeatCount: 2,
        analysisPlanFingerprint: '1'.repeat(64),
      },
      rankingPolicyFingerprint: '2'.repeat(64),
      decisionFingerprint: 'e'.repeat(64),
      winnerCandidateId: CANDIDATE_A,
      equivalenceCandidateIds: [],
    },
    axes: {
      evidenceStatus: 'complete',
      decisionOutcome: 'winner',
      freshnessStatus: 'fresh',
    },
    privacy: {
      containsRawPrompts: false,
      containsRawResponses: false,
      containsPrivateEnvironmentIdentity: false,
      containsProviderPayloads: false,
      containsSecrets: false,
    },
    ...bodyOverrides,
  };
}

function ratificationFixture(receipt, overrides = {}) {
  return {
    schema: BENCHMARK_TRUST_RATIFICATION_SCHEMA,
    receiptId: receipt.receiptId,
    status: 'ratified',
    ratifiedAt: '2026-08-31T13:00:00.000Z',
    authorityFingerprint: 'e'.repeat(64),
    attestationFingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

function qualificationOptions(now = '2026-09-01T00:00:00.000Z') {
  return { now, verifyRatification: () => true };
}

test('builds a strict content-addressed v1 receipt and derives no caller-owned qualification field', () => {
  const receipt = buildBenchmarkTrustReceipt(bodyFixture());
  assert.equal(validateBenchmarkTrustReceipt(receipt).valid, true);
  assert.equal(receipt.receiptId, '7f956c3ef9c72f0f2a0f0789c45fdc8530d077d3f6ac664baed3de37d27749bf');
  assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'qualified'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'qualifiedWinner'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(receipt.axes, 'ratificationStatus'), false);

  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /https?:\/\/|localhost|127\.0\.0\.1|[A-Z]:\\|\/home\//i);
  assert.doesNotMatch(serialized, /password|credential|bearer|private[_-]?key/i);
});

test('normalizes equivalent candidate and equivalence-set ordering to one receiptId', () => {
  const forward = bodyFixture();
  forward.axes.decisionOutcome = 'equivalence_set';
  forward.statistics.winnerCandidateId = null;
  forward.statistics.equivalenceCandidateIds = [CANDIDATE_A, CANDIDATE_B];

  const reverse = structuredClone(forward);
  reverse.execution.candidates.reverse();
  reverse.statistics.equivalenceCandidateIds.reverse();

  const left = buildBenchmarkTrustReceipt(forward);
  const right = buildBenchmarkTrustReceipt(reverse);
  assert.equal(left.receiptId, right.receiptId);
  assert.deepEqual(left, right);
  assert.equal(serializeBenchmarkTrustReceipt(left), serializeBenchmarkTrustReceipt(right));
});

test('detects tampering and requires callers to rebuild a new receipt identity', () => {
  const receipt = buildBenchmarkTrustReceipt(bodyFixture());
  receipt.statistics.minimumEffectMicros += 1;
  const errors = validateBenchmarkTrustReceipt(receipt).errors.join('\n');
  assert.match(errors, /receiptId does not match/);
});

test('rejects unknown fields, non-finite metrics, duplicate candidates, and fingerprint mismatch', () => {
  const unknown = buildBenchmarkTrustReceipt(bodyFixture());
  unknown.unreviewedClaim = true;
  assert.match(validateBenchmarkTrustReceipt(unknown).errors.join('\n'), /unsupported keys/);

  const unknownVersion = bodyFixture();
  unknownVersion.schema = 'agentx.benchmark-trust-receipt/v2';
  assert.throws(() => buildBenchmarkTrustReceipt(unknownVersion), /schema must be/);

  const unknownCandidateField = bodyFixture();
  unknownCandidateField.execution.candidates[0].provider = 'forbidden';
  assert.throws(() => buildBenchmarkTrustReceipt(unknownCandidateField), /unsupported keys: provider/);

  const nonFinite = bodyFixture();
  nonFinite.statistics.minimumEffectMicros = Number.POSITIVE_INFINITY;
  assert.throws(() => buildBenchmarkTrustReceipt(nonFinite), /minimumEffectMicros/);

  const duplicate = bodyFixture();
  duplicate.execution.candidates[1].candidateId = CANDIDATE_A;
  assert.throws(() => buildBenchmarkTrustReceipt(duplicate), /identifiers must be unique/);

  const mismatch = bodyFixture();
  mismatch.execution.candidateSetFingerprint = '9'.repeat(64);
  assert.throws(() => buildBenchmarkTrustReceipt(mismatch), /candidateSetFingerprint does not match/);
});

test('rejects contradictory winner, evidence, judge, and exclusion claims', () => {
  const noWinner = bodyFixture();
  noWinner.statistics.winnerCandidateId = null;
  assert.throws(() => buildBenchmarkTrustReceipt(noWinner), /winner decision requires/);

  const partialWinner = bodyFixture();
  partialWinner.axes.evidenceStatus = 'incomplete';
  assert.throws(() => buildBenchmarkTrustReceipt(partialWinner), /cannot declare a winner/);

  const unqualifiedJudge = bodyFixture();
  unqualifiedJudge.judge.qualificationStatus = 'unqualified';
  assert.throws(() => buildBenchmarkTrustReceipt(unqualifiedJudge), /requires a qualified judge/);

  const unqualifiedEquivalence = bodyFixture();
  unqualifiedEquivalence.judge.qualificationStatus = 'unqualified';
  unqualifiedEquivalence.axes.decisionOutcome = 'equivalence_set';
  unqualifiedEquivalence.statistics.winnerCandidateId = null;
  unqualifiedEquivalence.statistics.equivalenceCandidateIds = [CANDIDATE_A, CANDIDATE_B];
  assert.throws(() => buildBenchmarkTrustReceipt(unqualifiedEquivalence), /requires a qualified judge/);

  const selfRatified = bodyFixture();
  selfRatified.axes.ratificationStatus = 'ratified';
  assert.throws(() => buildBenchmarkTrustReceipt(selfRatified), /unsupported keys: ratificationStatus/);

  const missingExclusionInventory = bodyFixture();
  missingExclusionInventory.execution.observedResultCount = 99;
  missingExclusionInventory.execution.excludedResultCount = 1;
  missingExclusionInventory.execution.exclusionManifestFingerprint = '2'.repeat(64);
  assert.throws(() => buildBenchmarkTrustReceipt(missingExclusionInventory), /complete evidence requires every preregistered/);
});

test('binds repeatCount and rejects an unbalanced preregistered inventory', () => {
  const missingRepeatCount = bodyFixture();
  delete missingRepeatCount.statistics.preregistration.repeatCount;
  assert.throws(() => buildBenchmarkTrustReceipt(missingRepeatCount), /missing keys: repeatCount/);

  const invalidRepeatCount = bodyFixture();
  invalidRepeatCount.statistics.preregistration.repeatCount = 0;
  assert.throws(() => buildBenchmarkTrustReceipt(invalidRepeatCount), /repeatCount must be a positive/);

  const unbalanced = bodyFixture();
  unbalanced.execution.expectedResultCount = 98;
  unbalanced.execution.observedResultCount = 98;
  assert.throws(() => buildBenchmarkTrustReceipt(unbalanced), /must equal candidates times prompts times preregistered repeats/);

  const compensatedCell = bodyFixture();
  compensatedCell.execution.cellInventory.minimumRepeatCount = 1;
  compensatedCell.execution.cellInventory.maximumRepeatCount = 3;
  assert.throws(() => buildBenchmarkTrustReceipt(compensatedCell), /every preregistered candidate-prompt repetition/);

  const impossibleRange = bodyFixture();
  impossibleRange.axes.evidenceStatus = 'incomplete';
  impossibleRange.axes.decisionOutcome = 'inconclusive';
  impossibleRange.statistics.winnerCandidateId = null;
  impossibleRange.execution.cellInventory.minimumRepeatCount = 3;
  impossibleRange.execution.cellInventory.maximumRepeatCount = 1;
  assert.throws(() => buildBenchmarkTrustReceipt(impossibleRange), /cannot exceed maximumRepeatCount/);
});

test('qualifies only complete, decisive, fresh, ratified evidence with a current judge', () => {
  const receipt = buildBenchmarkTrustReceipt(bodyFixture());
  const result = deriveBenchmarkQualification(
    receipt,
    ratificationFixture(receipt),
    qualificationOptions()
  );
  assert.deepEqual(result, {
    qualified: true,
    qualifiedWinner: CANDIDATE_A,
    ratificationStatus: 'ratified',
    reasons: [],
  });

  const unverified = deriveBenchmarkQualification(receipt, ratificationFixture(receipt), {
    now: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(unverified.qualified, false);
  assert.equal(unverified.ratificationStatus, 'unratified');
  assert.ok(unverified.reasons.includes('ratification_not_verified'));
});

test('keeps inconclusive and equivalence outcomes honest and unqualified', () => {
  const inconclusive = bodyFixture();
  inconclusive.axes.decisionOutcome = 'inconclusive';
  inconclusive.statistics.winnerCandidateId = null;
  const receipt = buildBenchmarkTrustReceipt(inconclusive);
  assert.deepEqual(
    deriveBenchmarkQualification(receipt, ratificationFixture(receipt), qualificationOptions()),
    {
      qualified: false,
      qualifiedWinner: null,
      ratificationStatus: 'ratified',
      reasons: ['no_statistical_winner'],
    }
  );

  const equivalent = bodyFixture();
  equivalent.axes.decisionOutcome = 'equivalence_set';
  equivalent.statistics.winnerCandidateId = null;
  equivalent.statistics.equivalenceCandidateIds = [CANDIDATE_A, CANDIDATE_B];
  const equivalentReceipt = buildBenchmarkTrustReceipt(equivalent);
  assert.equal(
    deriveBenchmarkQualification(
      equivalentReceipt,
      ratificationFixture(equivalentReceipt),
      qualificationOptions()
    ).qualified,
    false
  );
});

test('rejects stale, expired, mismatched, and revoked qualification paths', () => {
  const staleBody = bodyFixture();
  staleBody.axes.freshnessStatus = 'stale';
  const stale = buildBenchmarkTrustReceipt(staleBody);
  assert.ok(deriveBenchmarkQualification(stale, ratificationFixture(stale), qualificationOptions()).reasons.includes('evidence_not_fresh'));

  const expired = buildBenchmarkTrustReceipt(bodyFixture());
  const expiredResult = deriveBenchmarkQualification(
    expired,
    ratificationFixture(expired),
    qualificationOptions('2026-10-01T00:00:00.000Z')
  );
  assert.ok(expiredResult.reasons.includes('receipt_expired'));
  assert.ok(expiredResult.reasons.includes('judge_qualification_expired'));

  const mismatched = buildBenchmarkTrustReceipt(bodyFixture());
  const mismatchResult = deriveBenchmarkQualification(
    mismatched,
    ratificationFixture(mismatched, { receiptId: '0'.repeat(64) }),
    qualificationOptions()
  );
  assert.ok(mismatchResult.reasons.includes('ratification_receipt_mismatch'));

  const revoked = buildBenchmarkTrustReceipt(bodyFixture());
  const revokedResult = deriveBenchmarkQualification(
    revoked,
    ratificationFixture(revoked, { status: 'revoked' }),
    qualificationOptions()
  );
  assert.equal(revokedResult.ratificationStatus, 'revoked');
  assert.ok(revokedResult.reasons.includes('not_ratified'));
  assert.ok(revokedResult.reasons.includes('ratification_revoked'));
});

test('privacy posture is fail-closed', () => {
  for (const key of Object.keys(bodyFixture().privacy)) {
    const body = bodyFixture();
    body.privacy[key] = true;
    assert.throws(() => buildBenchmarkTrustReceipt(body), new RegExp(`${key} must be false`));
  }

  const hostAsCandidate = bodyFixture();
  hostAsCandidate.execution.candidates[0].candidateId = '192.168.2.99';
  assert.throws(() => buildBenchmarkTrustReceipt(hostAsCandidate), /opaque candidate identifier/);

  const hostAsCampaign = bodyFixture();
  hostAsCampaign.execution.campaignId = 'ugalien';
  assert.throws(() => buildBenchmarkTrustReceipt(hostAsCampaign), /opaque campaign identifier/);

  const mongoIdAsBatch = bodyFixture();
  mongoIdAsBatch.execution.sourceBatchId = '507f1f77bcf86cd799439011';
  assert.throws(() => buildBenchmarkTrustReceipt(mongoIdAsBatch), /opaque source-batch identifier/);
});

module.exports = { bodyFixture, ratificationFixture };

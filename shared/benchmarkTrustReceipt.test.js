'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const HISTORICAL_V1_RECEIPT = require('./fixtures/benchmark-trust-receipt-v1-a51fcd1.json');

const {
  BENCHMARK_TRUST_RATIFICATION_SCHEMA,
  BENCHMARK_TRUST_RECEIPT_SCHEMA,
  BENCHMARK_TRUST_RECEIPT_SCHEMA_V1,
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
      method: 'paired-prompt-hoeffding-v1',
      alphaBasisPoints: 500,
      multiplicityCorrection: 'bonferroni',
      minimumEffectMicros: 25000,
      preregistration: {
        repeatCount: 2,
        poweredAlternativeEffectMicros: 50000,
        requiredIndependentPromptCount: 10,
        targetPowerBasisPoints: 8000,
        assumedMaxPairedStdDevMicros: 25000,
        varianceBasisFingerprint: '8'.repeat(64),
        variancePilotAttestationId: '7'.repeat(64),
        powerAnalysisFingerprint: '90e1cbc6b75f21a7579d7c49a392cacf28fa827b064c6ab7b93bea1435919a27',
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

function legacyV1BodyFixture() {
  const body = bodyFixture({ schema: BENCHMARK_TRUST_RECEIPT_SCHEMA_V1 });
  body.statistics.method = 'paired-prompt-t-v1';
  delete body.statistics.preregistration.poweredAlternativeEffectMicros;
  delete body.statistics.preregistration.varianceBasisFingerprint;
  delete body.statistics.preregistration.variancePilotAttestationId;
  return body;
}

function qualificationOptions(now = '2026-09-01T00:00:00.000Z') {
  return {
    now,
    verifyPromptIndependence: () => true,
    verifyVariancePilot: () => true,
    verifyJudgeQualification: () => true,
    verifyRatification: () => true,
  };
}

test('builds a strict content-addressed v2 receipt and derives no caller-owned qualification field', () => {
  const receipt = buildBenchmarkTrustReceipt(bodyFixture());
  assert.equal(validateBenchmarkTrustReceipt(receipt).valid, true);
  assert.equal(receipt.receiptId, 'acab9364c36dd7475047818e29fad99929de0aa2f94495bf84875f52a75b0dab');
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
  unknownVersion.schema = 'agentx.benchmark-trust-receipt/v3';
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

test('binds repeat and powered prompt counts and rejects an unbalanced preregistered inventory', () => {
  const missingRepeatCount = bodyFixture();
  delete missingRepeatCount.statistics.preregistration.repeatCount;
  assert.throws(() => buildBenchmarkTrustReceipt(missingRepeatCount), /missing keys: repeatCount/);

  const invalidRepeatCount = bodyFixture();
  invalidRepeatCount.statistics.preregistration.repeatCount = 0;
  assert.throws(() => buildBenchmarkTrustReceipt(invalidRepeatCount), /repeatCount must be a positive/);

  const missingPowerFields = bodyFixture();
  delete missingPowerFields.statistics.preregistration.powerAnalysisFingerprint;
  assert.throws(() => buildBenchmarkTrustReceipt(missingPowerFields), /missing keys: powerAnalysisFingerprint/);

  const missingVarianceBasis = bodyFixture();
  delete missingVarianceBasis.statistics.preregistration.varianceBasisFingerprint;
  assert.throws(() => buildBenchmarkTrustReceipt(missingVarianceBasis), /missing keys: varianceBasisFingerprint/);

  const underpowered = bodyFixture();
  underpowered.statistics.preregistration.requiredIndependentPromptCount = 26;
  assert.throws(() => buildBenchmarkTrustReceipt(underpowered), /underpowered prompt count cannot declare a winner/);

  const invalidPower = bodyFixture();
  invalidPower.statistics.preregistration.targetPowerBasisPoints = 7999;
  invalidPower.statistics.preregistration.assumedMaxPairedStdDevMicros = 0;
  assert.throws(
    () => buildBenchmarkTrustReceipt(invalidPower),
    /targetPowerBasisPoints must be an integer from 8000 through 9999.*assumedMaxPairedStdDevMicros must be a positive/s
  );

  const zeroMinimumEffect = bodyFixture();
  zeroMinimumEffect.statistics.minimumEffectMicros = 0;
  assert.throws(() => buildBenchmarkTrustReceipt(zeroMinimumEffect), /minimumEffectMicros must be a positive/);

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

test('keeps immutable v1 receipts readable but never newly qualifiable', () => {
  const receipt = buildBenchmarkTrustReceipt(legacyV1BodyFixture());
  assert.equal(receipt.schema, BENCHMARK_TRUST_RECEIPT_SCHEMA_V1);
  assert.equal(receipt.receiptId, '7ed78ea7365cdb613e2bde5848258cc2ea60812169bb49699ad30e454353757b');
  assert.equal(validateBenchmarkTrustReceipt(receipt).valid, true);
  assert.equal(JSON.parse(serializeBenchmarkTrustReceipt(receipt)).receiptId, receipt.receiptId);

  const qualification = deriveBenchmarkQualification(
    receipt,
    ratificationFixture(receipt),
    qualificationOptions()
  );
  assert.equal(qualification.qualified, false);
  assert.ok(qualification.reasons.includes('legacy_receipt_schema_not_qualifiable'));

  const rewrittenV1 = structuredClone(legacyV1BodyFixture());
  rewrittenV1.statistics.preregistration.unknownPowerField = 50000;
  assert.throws(
    () => buildBenchmarkTrustReceipt(rewrittenV1),
    /supported historical v1 shape exactly/
  );
});

test('reads every historical v1 preregistration shape but keeps each unqualifiable', () => {
  const base = legacyV1BodyFixture();
  const power = structuredClone(base.statistics.preregistration);
  const minimal = {
    repeatCount: power.repeatCount,
    analysisPlanFingerprint: power.analysisPlanFingerprint,
  };
  const variance = {
    ...power,
    varianceBasisFingerprint: '8'.repeat(64),
    variancePilotAttestationId: '7'.repeat(64),
  };
  const alternative = {
    repeatCount: variance.repeatCount,
    poweredAlternativeEffectMicros: 50000,
    requiredIndependentPromptCount: variance.requiredIndependentPromptCount,
    targetPowerBasisPoints: variance.targetPowerBasisPoints,
    assumedMaxPairedStdDevMicros: variance.assumedMaxPairedStdDevMicros,
    varianceBasisFingerprint: variance.varianceBasisFingerprint,
    variancePilotAttestationId: variance.variancePilotAttestationId,
    powerAnalysisFingerprint: variance.powerAnalysisFingerprint,
    analysisPlanFingerprint: variance.analysisPlanFingerprint,
  };

  for (const preregistration of [minimal, power, variance, alternative]) {
    const body = legacyV1BodyFixture();
    body.statistics.preregistration = preregistration;
    const receipt = buildBenchmarkTrustReceipt(body);
    assert.equal(validateBenchmarkTrustReceipt(receipt).valid, true);
    assert.equal(
      deriveBenchmarkQualification(receipt, ratificationFixture(receipt), qualificationOptions()).qualified,
      false
    );
  }
});

test('reads the literal a51fcd1 v1 receipt bytes under their historical identity', () => {
  assert.equal(HISTORICAL_V1_RECEIPT.receiptId, '7f956c3ef9c72f0f2a0f0789c45fdc8530d077d3f6ac664baed3de37d27749bf');
  assert.equal(validateBenchmarkTrustReceipt(HISTORICAL_V1_RECEIPT).valid, true);
  assert.deepEqual(
    JSON.parse(serializeBenchmarkTrustReceipt(HISTORICAL_V1_RECEIPT)),
    HISTORICAL_V1_RECEIPT
  );
  const rebuilt = buildBenchmarkTrustReceipt((({ receiptId, ...body }) => body)(HISTORICAL_V1_RECEIPT));
  assert.deepEqual(rebuilt, HISTORICAL_V1_RECEIPT);
  assert.equal(
    deriveBenchmarkQualification(
      HISTORICAL_V1_RECEIPT,
      ratificationFixture(HISTORICAL_V1_RECEIPT),
      qualificationOptions()
    ).qualified,
    false
  );
});

test('reads every historical a51fcd1 method and correction without qualifying v1', () => {
  const historicalVariants = [
    {
      method: 'paired-bootstrap-v1',
      multiplicityCorrection: 'bonferroni',
      receiptId: '1a2548581f7b8be653c40cde7f7a5182dbdf4c56b25378608cad4bf1e5bbaf59',
    },
    {
      method: 'paired-permutation-v1',
      multiplicityCorrection: 'holm-bonferroni',
      receiptId: 'baa8c40312a33ffbc5545c9dcb775f6b90293eee4ea508cd445d1c52dd233a91',
    },
    {
      method: 'paired-prompt-t-v1',
      multiplicityCorrection: 'none',
      receiptId: 'd03d4fd1c2445521b30e24ae8ddd953a45f11d42f6f7c3a045e27fc4faf2ed5e',
    },
  ];

  for (const variant of historicalVariants) {
    const body = structuredClone(HISTORICAL_V1_RECEIPT);
    delete body.receiptId;
    body.statistics.method = variant.method;
    body.statistics.multiplicityCorrection = variant.multiplicityCorrection;

    const receipt = buildBenchmarkTrustReceipt(body);
    assert.equal(receipt.receiptId, variant.receiptId);
    assert.equal(validateBenchmarkTrustReceipt(receipt).valid, true);
    assert.equal(
      deriveBenchmarkQualification(receipt, ratificationFixture(receipt), qualificationOptions()).qualified,
      false
    );
  }
});

test('reads the historical zero-margin v1 receipt but keeps it unqualifiable', () => {
  const body = structuredClone(HISTORICAL_V1_RECEIPT);
  delete body.receiptId;
  body.statistics.minimumEffectMicros = 0;

  const receipt = buildBenchmarkTrustReceipt(body);
  assert.equal(receipt.receiptId, 'b874bd47fde51e6412ad2872036b8ccb3dd6f5107bb91c4f7f698de08b7578ce');
  assert.equal(validateBenchmarkTrustReceipt(receipt).valid, true);
  assert.equal(
    deriveBenchmarkQualification(receipt, ratificationFixture(receipt), qualificationOptions()).qualified,
    false
  );
});

test('binds a powered alternative strictly above the superiority margin', () => {
  const equalToMargin = bodyFixture();
  equalToMargin.statistics.preregistration.poweredAlternativeEffectMicros =
    equalToMargin.statistics.minimumEffectMicros;
  assert.throws(
    () => buildBenchmarkTrustReceipt(equalToMargin),
    /poweredAlternativeEffectMicros must be a safe integer greater than minimumEffectMicros/
  );

  const impossibleAlternative = bodyFixture();
  impossibleAlternative.statistics.preregistration.poweredAlternativeEffectMicros = 10_000_001;
  assert.throws(
    () => buildBenchmarkTrustReceipt(impossibleAlternative),
    /at most the maximum score/
  );

  const impossibleMargin = bodyFixture();
  impossibleMargin.statistics.minimumEffectMicros = 10_000_000;
  impossibleMargin.statistics.preregistration.poweredAlternativeEffectMicros = 10_000_001;
  assert.throws(
    () => buildBenchmarkTrustReceipt(impossibleMargin),
    /minimumEffectMicros must be less than the maximum score/
  );
});

test('v2 rejects statistical methods or corrections the integrated engine does not compute', () => {
  const uncorrectedWinner = bodyFixture();
  uncorrectedWinner.statistics.multiplicityCorrection = 'none';
  assert.throws(() => buildBenchmarkTrustReceipt(uncorrectedWinner), /multiplicityCorrection must be one of bonferroni/);

  const unsupportedMethod = bodyFixture();
  unsupportedMethod.statistics.method = 'paired-bootstrap-v1';
  assert.throws(() => buildBenchmarkTrustReceipt(unsupportedMethod), /method must be one of paired-prompt-hoeffding-v1/);

  const legacyMethod = bodyFixture();
  legacyMethod.statistics.method = 'paired-prompt-t-v1';
  assert.throws(() => buildBenchmarkTrustReceipt(legacyMethod), /method must be one of paired-prompt-hoeffding-v1/);
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
    claimScope: 'capability',
    ratificationStatus: 'ratified',
    reasons: [],
  });

  const unverified = deriveBenchmarkQualification(receipt, ratificationFixture(receipt), {
    now: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(unverified.qualified, false);
  assert.equal(unverified.ratificationStatus, 'unratified');
  assert.ok(unverified.reasons.includes('variance_pilot_not_verified'));
  assert.ok(unverified.reasons.includes('prompt_independence_not_verified'));
  assert.ok(unverified.reasons.includes('judge_qualification_not_verified'));
  assert.ok(unverified.reasons.includes('ratification_not_verified'));

  const unverifiedJudge = deriveBenchmarkQualification(receipt, ratificationFixture(receipt), {
    now: '2026-09-01T00:00:00.000Z',
    verifyPromptIndependence: () => true,
    verifyVariancePilot: () => true,
    verifyJudgeQualification: () => false,
    verifyRatification: () => true,
  });
  assert.equal(unverifiedJudge.qualified, false);
  assert.equal(unverifiedJudge.ratificationStatus, 'ratified');
  assert.deepEqual(unverifiedJudge.reasons, ['judge_qualification_not_verified']);

  const dependentPrompts = deriveBenchmarkQualification(receipt, ratificationFixture(receipt), {
    ...qualificationOptions(),
    verifyPromptIndependence: () => false,
  });
  assert.equal(dependentPrompts.qualified, false);
  assert.deepEqual(dependentPrompts.reasons, ['prompt_independence_not_verified']);
});

test('derives qualification from frozen snapshots despite mutations in every verifier', () => {
  for (const verifierName of [
    'verifyPromptIndependence',
    'verifyVariancePilot',
    'verifyJudgeQualification',
    'verifyRatification',
  ]) {
    const receipt = buildBenchmarkTrustReceipt(bodyFixture());
    const ratification = ratificationFixture(receipt);
    const options = qualificationOptions();
    options[verifierName] = (...args) => {
      receipt.statistics.winnerCandidateId = CANDIDATE_B;
      ratification.status = 'revoked';
      for (const argument of args) {
        if (argument && typeof argument === 'object') {
          assert.equal(Object.isFrozen(argument), true);
        }
      }
      return true;
    };

    assert.deepEqual(
      deriveBenchmarkQualification(receipt, ratification, options),
      {
        qualified: true,
        qualifiedWinner: CANDIDATE_A,
        claimScope: 'capability',
        ratificationStatus: 'ratified',
        reasons: [],
      }
    );
  }
});

test('captures verifier authorities and time before any verifier can replace them', () => {
  const receipt = buildBenchmarkTrustReceipt(bodyFixture());
  const ratification = ratificationFixture(receipt);
  const options = {
    now: '2026-10-01T00:00:00.000Z',
    verifyPromptIndependence: () => {
      options.now = '2026-09-01T00:00:00.000Z';
      options.verifyVariancePilot = () => true;
      options.verifyJudgeQualification = () => true;
      options.verifyRatification = () => true;
      return true;
    },
    verifyVariancePilot: () => false,
    verifyJudgeQualification: () => false,
    verifyRatification: () => false,
  };

  const result = deriveBenchmarkQualification(receipt, ratification, options);
  assert.equal(result.qualified, false);
  assert.equal(result.qualifiedWinner, null);
  assert.equal(result.ratificationStatus, 'unratified');
  for (const reason of [
    'variance_pilot_not_verified',
    'judge_qualification_not_verified',
    'receipt_expired',
    'judge_qualification_expired',
    'ratification_not_verified',
    'not_ratified',
  ]) {
    assert.ok(result.reasons.includes(reason), `missing ${reason}`);
  }
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
      claimScope: 'capability',
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

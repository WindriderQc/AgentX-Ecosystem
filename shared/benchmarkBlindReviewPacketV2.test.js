'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_V2_SCHEMA,
  BENCHMARK_BLIND_REVIEW_PACKET_V2_SCHEMA,
  BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_V2_SCHEMA,
  BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA,
  CALIBRATION_CAPTURE_AUTHORITY_SCHEMA,
  REVIEW_RUBRIC_SCHEMA,
  buildBenchmarkBlindReviewPackageV2,
  normalizeBenchmarkBlindReviewSourceBundleV2,
} = require('./benchmarkBlindReviewPacketV2');
const { fingerprint } = require('./workerContract');

const categories = ['coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation'];
const dimensionNames = {
  coding: ['correctness', 'clarity', 'efficiency', 'robustness'],
  creative: ['originality', 'coherence', 'engagement', 'relevance'],
  instruction: ['instruction_adherence', 'constraint_compliance', 'format_accuracy', 'completeness'],
  knowledge: ['accuracy', 'completeness', 'clarity', 'objectivity'],
  math: ['answer_correctness', 'method', 'rigor', 'clarity'],
  reasoning: ['accuracy', 'logic_soundness', 'completeness', 'clarity'],
  translation: ['accuracy', 'fluency', 'grammar', 'cultural_fit'],
};

function rubric() {
  const scale = {
    minimumMicros: 0,
    maximumMicros: 10_000_000,
    anchors: [
      [0, 2_000_000, 'missing, wrong, or off-task'],
      [3_000_000, 4_000_000, 'major errors or gaps'],
      [5_000_000, 6_000_000, 'partially correct with notable errors or omissions'],
      [7_000_000, 8_000_000, 'correct and complete with minor flaws'],
      [9_000_000, 10_000_000, 'fully correct, complete, and precise'],
    ].map(([minimumMicros, maximumMicros, meaning]) => ({ minimumMicros, maximumMicros, meaning })),
  };
  const rubricCategories = categories.map(category => ({
    category,
    description: `${category} Product scoring dimensions`,
    dimensions: dimensionNames[category].map((name, index) => ({
      name,
      description: `${category} ${name}`,
      weightMicros: index === 0 ? 400_000 : 200_000,
    })),
  }));
  for (const category of rubricCategories) {
    const sum = category.dimensions.reduce((total, dimension) => total + dimension.weightMicros, 0);
    category.dimensions[0].weightMicros += 1_000_000 - sum;
  }
  const body = { schema: REVIEW_RUBRIC_SCHEMA, scale, categories: rubricCategories };
  return { ...body, rubricId: 'product-runtime-review-rubric-v1', rubricFingerprint: fingerprint(body) };
}

function sourceBundle() {
  const items = [];
  let sequence = 0;
  for (const category of categories) {
    for (const difficulty of [1, 2, 3, 4, 5]) {
      for (const split of ['validation', 'validation', 'holdout', 'holdout', 'holdout']) {
        const prompt = `Prompt ${sequence}`;
        const expectedAnswer = sequence % 2 === 0 ? `Expected ${sequence}` : null;
        const response = `Response ${sequence}`;
        const source = {
          captureItemId: fingerprint(`capture-item-${sequence}`),
          captureFingerprint: '',
          promptFingerprint: fingerprint(prompt),
          expectedAnswerFingerprint: expectedAnswer === null ? null : fingerprint(expectedAnswer),
          responseFingerprint: fingerprint(response),
          category,
          judgeIdentityFingerprint: fingerprint('exact-judge-identity'),
          judgeReceiptFingerprint: fingerprint(`judge-receipt-${sequence}`),
          judgeScoreMicros: (sequence % 11) * 1_000_000,
        };
        source.captureFingerprint = fingerprint({
          schema: 'agentx.benchmark-judge-calibration-capture-item/v1',
          captureItemId: source.captureItemId,
          promptFingerprint: source.promptFingerprint,
          expectedAnswerFingerprint: source.expectedAnswerFingerprint,
          responseFingerprint: source.responseFingerprint,
          category: source.category,
          judgeIdentityFingerprint: source.judgeIdentityFingerprint,
          judgeReceiptFingerprint: source.judgeReceiptFingerprint,
          judgeScoreMicros: source.judgeScoreMicros,
        });
        items.push({
          reviewId: `review-${String(sequence).padStart(3, '0')}`,
          split,
          category,
          difficulty,
          prompt,
          expectedAnswer,
          response,
          source,
        });
        sequence += 1;
      }
    }
  }
  return {
    schema: BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA,
    corpusId: 'benchmark-trust-v2-local-light-calibration-175',
    reviewerId: 'human-reviewer-01',
    reviewProtocol: 'blind_independent',
    captureAuthority: {
      schema: CALIBRATION_CAPTURE_AUTHORITY_SCHEMA,
      collectorRevision: '1'.repeat(40),
      productRevision: '2'.repeat(40),
      judgeTargetFingerprint: fingerprint('judge-target'),
      judgeModelDigest: `sha256:${'3'.repeat(64)}`,
      runtimeRubricFingerprint: fingerprint('runtime-rubric'),
      captureProfileFingerprint: fingerprint('capture-profile'),
      capturedAt: '2026-09-02T18:00:00.000Z',
      providerCostUsdMicros: 0,
      fallbackUsed: false,
    },
    rubric: rubric(),
    items,
  };
}

test('builds a 175-item v2 package with category-specific weighted dimensions', () => {
  const result = buildBenchmarkBlindReviewPackageV2(sourceBundle());
  assert.equal(result.packet.schema, BENCHMARK_BLIND_REVIEW_PACKET_V2_SCHEMA);
  assert.equal(result.controlManifest.schema, BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_V2_SCHEMA);
  assert.equal(result.responseTemplate.schema, BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_V2_SCHEMA);
  assert.equal(result.packet.items.length, 175);
  assert.deepEqual(
    result.responseTemplate.reviews[0].dimensionScores.map(entry => entry.dimension),
    dimensionNames.coding
  );
  const creativeReview = result.responseTemplate.reviews[25];
  assert.deepEqual(creativeReview.dimensionScores.map(entry => entry.dimension), dimensionNames.creative);
  assert.equal(creativeReview.dimensionScores.reduce((sum, entry) => sum + entry.weightMicros, 0), 1_000_000);
});

test('reviewer packet excludes split and local capture or judge authority', () => {
  const { packet } = buildBenchmarkBlindReviewPackageV2(sourceBundle());
  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /validation|holdout|captureAuthority|captureItem|judgeIdentity|judgeReceipt|judgeScore/);
  assert.doesNotMatch(serialized, /modelDigest|collectorRevision|productRevision|"host"|"model"/);
  assert.match(serialized, /weightMicros/);
  assert.match(serialized, /fully correct, complete, and precise/);
});

test('rejects altered rubric fingerprints, capture fingerprints, and non-zero cost', () => {
  const badRubric = sourceBundle();
  badRubric.rubric.categories[0].dimensions[0].description = 'drifted';
  assert.throws(() => normalizeBenchmarkBlindReviewSourceBundleV2(badRubric), /rubricFingerprint/);

  const badCapture = sourceBundle();
  badCapture.items[0].source.judgeScoreMicros = 1;
  assert.throws(() => normalizeBenchmarkBlindReviewSourceBundleV2(badCapture), /captureFingerprint/);

  const paid = sourceBundle();
  paid.captureAuthority.providerCostUsdMicros = 1;
  assert.throws(() => normalizeBenchmarkBlindReviewSourceBundleV2(paid), /zero-cost/);
});

test('generic packet builder dispatches v2 without weakening v1', () => {
  const { buildBenchmarkBlindReviewPackage } = require('./benchmarkBlindReviewPacket');
  assert.equal(buildBenchmarkBlindReviewPackage(sourceBundle()).packet.schema, BENCHMARK_BLIND_REVIEW_PACKET_V2_SCHEMA);
});

test('preserves non-blank response whitespace because fingerprints bind exact judged bytes', () => {
  const bundle = sourceBundle();
  bundle.items[0].response += '\n';
  bundle.items[0].source.responseFingerprint = fingerprint(bundle.items[0].response);
  const source = bundle.items[0].source;
  source.captureFingerprint = fingerprint({
    schema: 'agentx.benchmark-judge-calibration-capture-item/v1',
    captureItemId: source.captureItemId,
    promptFingerprint: source.promptFingerprint,
    expectedAnswerFingerprint: source.expectedAnswerFingerprint,
    responseFingerprint: source.responseFingerprint,
    category: source.category,
    judgeIdentityFingerprint: source.judgeIdentityFingerprint,
    judgeReceiptFingerprint: source.judgeReceiptFingerprint,
    judgeScoreMicros: source.judgeScoreMicros,
  });
  const result = buildBenchmarkBlindReviewPackageV2(bundle);
  assert.equal(result.packet.items[0].response.endsWith('\n'), true);
});

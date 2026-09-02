'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_SCHEMA,
  BENCHMARK_BLIND_REVIEW_PACKET_SCHEMA,
  BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_SCHEMA,
  BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA,
  CATEGORIES,
  DIFFICULTIES,
  EXPECTED_ITEM_COUNT,
  buildBenchmarkBlindReviewPackage,
  normalizeBenchmarkBlindReviewSourceBundle,
} = require('./benchmarkBlindReviewPacket');
const { fingerprint } = require('./workerContract');

const hex = (seed) => fingerprint(seed);

function sourceBundle() {
  let index = 0;
  const items = [];
  for (const category of CATEGORIES) {
    for (const difficulty of DIFFICULTIES) {
      for (const split of ['validation', 'validation', 'holdout', 'holdout', 'holdout']) {
        const sequence = index;
        const response = `Response ${sequence} for ${category} difficulty ${difficulty}`;
        items.push({
          reviewId: `review-${String(sequence).padStart(3, '0')}-${hex(`review-${sequence}`).slice(0, 12)}`,
          split,
          category,
          difficulty,
          prompt: `Prompt ${sequence}`,
          expectedAnswer: sequence % 2 === 0 ? `Reference ${sequence}` : null,
          response,
          source: {
            sourceResultId: sequence.toString(16).padStart(24, '0'),
            sourceBatchId: `batch_${hex(`batch-${sequence}`).slice(0, 32)}`,
            sourceResultFingerprint: hex(`source-${sequence}`),
            promptFingerprint: hex(`prompt-${sequence}`),
            responseFingerprint: fingerprint(response),
            category,
            judgeIdentityFingerprint: hex('judge'),
            judgeScoreMicros: (sequence % 11) * 1_000_000,
          },
        });
        index += 1;
      }
    }
  }
  return {
    schema: BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA,
    corpusId: 'benchmark-trust-v2-calibration-175',
    reviewerId: 'human-reviewer-01',
    reviewProtocol: 'blind_independent',
    rubric: {
      rubricId: 'benchmark-trust-general-v1',
      rubricFingerprint: hex('rubric'),
      dimensions: ['correctness', 'instruction_following', 'relevance'],
    },
    items,
  };
}

test('builds an exact 175-review packet, private control manifest, and response template', () => {
  const result = buildBenchmarkBlindReviewPackage(sourceBundle());

  assert.equal(result.packet.schema, BENCHMARK_BLIND_REVIEW_PACKET_SCHEMA);
  assert.equal(result.controlManifest.schema, BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_SCHEMA);
  assert.equal(result.responseTemplate.schema, BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_SCHEMA);
  assert.equal(result.packet.items.length, EXPECTED_ITEM_COUNT);
  assert.equal(result.controlManifest.items.length, EXPECTED_ITEM_COUNT);
  assert.equal(result.responseTemplate.reviews.length, EXPECTED_ITEM_COUNT);
  assert.match(result.packet.packetId, /^[0-9a-f]{64}$/);
  assert.match(result.controlManifest.manifestId, /^[0-9a-f]{64}$/);
});

test('the reviewer packet excludes split and all sealed judge/source authority', () => {
  const { packet } = buildBenchmarkBlindReviewPackage(sourceBundle());
  const serialized = JSON.stringify(packet);

  assert.doesNotMatch(serialized, /validation|holdout/);
  assert.doesNotMatch(serialized, /sourceResult|sourceBatch|judgeIdentity|judgeScore/);
  assert.doesNotMatch(serialized, /candidateId|modelDigest|\"model\"|\"host\"/);
  assert.equal(typeof packet.items[0].reviewId, 'string');
  assert.equal(typeof packet.items[0].category, 'string');
  assert.equal(typeof packet.items[0].difficulty, 'number');
  assert.equal(typeof packet.items[0].prompt, 'string');
  assert.equal(typeof packet.items[0].response, 'string');
});

test('rejects underfilled cells, duplicate sources, and response drift', () => {
  const underfilled = sourceBundle();
  underfilled.items.pop();
  assert.throws(
    () => normalizeBenchmarkBlindReviewSourceBundle(underfilled),
    /exactly 175 reviews/
  );

  const duplicate = sourceBundle();
  duplicate.items[1].source.sourceResultId = duplicate.items[0].source.sourceResultId;
  assert.throws(
    () => normalizeBenchmarkBlindReviewSourceBundle(duplicate),
    /identities must be unique/
  );

  const drifted = sourceBundle();
  drifted.items[0].response = 'Changed after sealing';
  assert.throws(
    () => normalizeBenchmarkBlindReviewSourceBundle(drifted),
    /does not match source.responseFingerprint/
  );
});

test('rejects reviewer-visible schema extensions and non-independent review labels', () => {
  const extended = sourceBundle();
  extended.items[0].candidateId = 'candidate-a';
  assert.throws(
    () => normalizeBenchmarkBlindReviewSourceBundle(extended),
    /must contain exactly/
  );

  const protocol = sourceBundle();
  protocol.reviewProtocol = 'blind_double_review';
  assert.throws(
    () => normalizeBenchmarkBlindReviewSourceBundle(protocol),
    /blind_independent/
  );
});

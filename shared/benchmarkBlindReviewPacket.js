'use strict';

const { fingerprint } = require('./workerContract');
const {
  BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA,
  buildBenchmarkBlindReviewPackageV2,
  normalizeBenchmarkBlindReviewSourceBundleV2,
} = require('./benchmarkBlindReviewPacketV2');

const BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA =
  'agentx.benchmark-blind-review-source-bundle/v1';
const BENCHMARK_BLIND_REVIEW_PACKET_SCHEMA =
  'agentx.benchmark-blind-review-packet/v1';
const BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_SCHEMA =
  'agentx.benchmark-blind-review-control-manifest/v1';
const BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_SCHEMA =
  'agentx.benchmark-blind-review-response-template/v1';
const REVIEW_PROTOCOL = 'blind_independent';
const CATEGORIES = Object.freeze([
  'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation',
]);
const DIFFICULTIES = Object.freeze([1, 2, 3, 4, 5]);
const EXPECTED_VALIDATION_PER_CELL = 2;
const EXPECTED_HOLDOUT_PER_CELL = 3;
const EXPECTED_ITEM_COUNT = CATEGORIES.length
  * DIFFICULTIES.length
  * (EXPECTED_VALIDATION_PER_CELL + EXPECTED_HOLDOUT_PER_CELL);

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_RESULT_ID_PATTERN = /^[0-9a-f]{24}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;

function packetError(message) {
  const error = new Error(message);
  error.code = 'INVALID_BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE';
  error.statusCode = 400;
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
    throw packetError(`${label} must contain exactly ${keys.join(', ')}`);
  }
  return value;
}

function identifier(value, label, max = 180) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > max
      || value !== value.trim()
      || !IDENTIFIER_PATTERN.test(value)) {
    throw packetError(`${label} must be an opaque logical identifier`);
  }
  return value;
}

function text(value, label, max = 100_000) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > max
      || value !== value.trim()) {
    throw packetError(`${label} must be non-empty canonical text`);
  }
  return value;
}

function optionalText(value, label, max = 100_000) {
  if (value === null) return null;
  return text(value, label, max);
}

function sha256(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw packetError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function scoreMicros(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw packetError(`${label} must be an integer from 0 through 10000000`);
  }
  return value;
}

function normalizeRubric(rawValue) {
  const value = exactObject(rawValue, ['rubricId', 'rubricFingerprint', 'dimensions'], 'rubric');
  if (!Array.isArray(value.dimensions) || value.dimensions.length < 1 || value.dimensions.length > 32) {
    throw packetError('rubric.dimensions must contain from 1 through 32 dimensions');
  }
  const dimensions = value.dimensions.map((entry, index) => (
    identifier(entry, `rubric.dimensions[${index}]`, 120)
  ));
  if (new Set(dimensions).size !== dimensions.length) {
    throw packetError('rubric.dimensions must be unique');
  }
  const sorted = [...dimensions].sort((left, right) => left.localeCompare(right));
  if (dimensions.join('\n') !== sorted.join('\n')) {
    throw packetError('rubric.dimensions must be sorted');
  }
  return {
    rubricId: identifier(value.rubricId, 'rubric.rubricId'),
    rubricFingerprint: sha256(value.rubricFingerprint, 'rubric.rubricFingerprint'),
    dimensions,
  };
}

function normalizeSource(rawValue, index) {
  const label = `items[${index}].source`;
  const value = exactObject(rawValue, [
    'sourceResultId',
    'sourceBatchId',
    'sourceResultFingerprint',
    'promptFingerprint',
    'responseFingerprint',
    'category',
    'judgeIdentityFingerprint',
    'judgeScoreMicros',
  ], label);
  if (!SOURCE_RESULT_ID_PATTERN.test(value.sourceResultId || '')) {
    throw packetError(`${label}.sourceResultId must be a lowercase Mongo object identifier`);
  }
  if (!SOURCE_BATCH_ID_PATTERN.test(value.sourceBatchId || '')) {
    throw packetError(`${label}.sourceBatchId must be an opaque source-batch identifier`);
  }
  if (!CATEGORIES.includes(value.category)) {
    throw packetError(`${label}.category is unsupported`);
  }
  return {
    sourceResultId: value.sourceResultId,
    sourceBatchId: value.sourceBatchId,
    sourceResultFingerprint: sha256(value.sourceResultFingerprint, `${label}.sourceResultFingerprint`),
    promptFingerprint: sha256(value.promptFingerprint, `${label}.promptFingerprint`),
    responseFingerprint: sha256(value.responseFingerprint, `${label}.responseFingerprint`),
    category: value.category,
    judgeIdentityFingerprint: sha256(
      value.judgeIdentityFingerprint,
      `${label}.judgeIdentityFingerprint`
    ),
    judgeScoreMicros: scoreMicros(value.judgeScoreMicros, `${label}.judgeScoreMicros`),
  };
}

function normalizeItem(rawValue, index) {
  const label = `items[${index}]`;
  const value = exactObject(rawValue, [
    'reviewId', 'split', 'category', 'difficulty',
    'prompt', 'expectedAnswer', 'response', 'source',
  ], label);
  if (!['validation', 'holdout'].includes(value.split)) {
    throw packetError(`${label}.split must be validation or holdout`);
  }
  if (!CATEGORIES.includes(value.category)) {
    throw packetError(`${label}.category is unsupported`);
  }
  if (!DIFFICULTIES.includes(value.difficulty)) {
    throw packetError(`${label}.difficulty must be an integer from 1 through 5`);
  }
  const response = text(value.response, `${label}.response`);
  const source = normalizeSource(value.source, index);
  if (source.category !== value.category) {
    throw packetError(`${label}.source.category must match the review category`);
  }
  if (source.responseFingerprint !== fingerprint(response)) {
    throw packetError(`${label}.response does not match source.responseFingerprint`);
  }
  return {
    reviewId: identifier(value.reviewId, `${label}.reviewId`),
    split: value.split,
    category: value.category,
    difficulty: value.difficulty,
    prompt: text(value.prompt, `${label}.prompt`),
    expectedAnswer: optionalText(value.expectedAnswer, `${label}.expectedAnswer`),
    response,
    source,
  };
}

function assertExactCoverage(items) {
  if (items.length !== EXPECTED_ITEM_COUNT) {
    throw packetError(`items must contain exactly ${EXPECTED_ITEM_COUNT} reviews`);
  }
  const counts = new Map();
  for (const item of items) {
    const key = `${item.category}\u0000${item.difficulty}\u0000${item.split}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const category of CATEGORIES) {
    for (const difficulty of DIFFICULTIES) {
      const validation = counts.get(`${category}\u0000${difficulty}\u0000validation`) || 0;
      const holdout = counts.get(`${category}\u0000${difficulty}\u0000holdout`) || 0;
      if (validation !== EXPECTED_VALIDATION_PER_CELL
          || holdout !== EXPECTED_HOLDOUT_PER_CELL) {
        throw packetError(
          `${category}/difficulty-${difficulty} must contain exactly `
          + `${EXPECTED_VALIDATION_PER_CELL} validation and ${EXPECTED_HOLDOUT_PER_CELL} holdout reviews`
        );
      }
    }
  }
}

function normalizeBenchmarkBlindReviewSourceBundleV1(rawValue) {
  const value = exactObject(rawValue, [
    'schema', 'corpusId', 'reviewerId', 'reviewProtocol', 'rubric', 'items',
  ], 'source bundle');
  if (value.schema !== BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA) {
    throw packetError(`schema must be ${BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA}`);
  }
  if (value.reviewProtocol !== REVIEW_PROTOCOL) {
    throw packetError(`reviewProtocol must be ${REVIEW_PROTOCOL}`);
  }
  if (!Array.isArray(value.items)) throw packetError('items must be an array');
  const items = value.items.map(normalizeItem);
  const reviewIds = items.map(item => item.reviewId);
  const sourceIds = items.map(item => item.source.sourceResultId);
  const sourceFingerprints = items.map(item => item.source.sourceResultFingerprint);
  if (new Set(reviewIds).size !== reviewIds.length
      || new Set(sourceIds).size !== sourceIds.length
      || new Set(sourceFingerprints).size !== sourceFingerprints.length) {
    throw packetError('review and sealed source identities must be unique');
  }
  assertExactCoverage(items);
  return {
    schema: BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA,
    corpusId: identifier(value.corpusId, 'corpusId'),
    reviewerId: identifier(value.reviewerId, 'reviewerId'),
    reviewProtocol: REVIEW_PROTOCOL,
    rubric: normalizeRubric(value.rubric),
    items,
  };
}

function buildBenchmarkBlindReviewPackage(rawBundle) {
  if (rawBundle?.schema === BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA) {
    return buildBenchmarkBlindReviewPackageV2(rawBundle);
  }
  const bundle = normalizeBenchmarkBlindReviewSourceBundleV1(rawBundle);
  const corpusFingerprint = fingerprint({
    schema: BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA,
    corpusId: bundle.corpusId,
    rubricFingerprint: bundle.rubric.rubricFingerprint,
    items: bundle.items,
  });
  const packetBody = {
    schema: BENCHMARK_BLIND_REVIEW_PACKET_SCHEMA,
    corpusId: bundle.corpusId,
    corpusFingerprint,
    reviewerId: bundle.reviewerId,
    reviewProtocol: bundle.reviewProtocol,
    rubric: bundle.rubric,
    items: bundle.items.map(item => ({
      reviewId: item.reviewId,
      category: item.category,
      difficulty: item.difficulty,
      prompt: item.prompt,
      expectedAnswer: item.expectedAnswer,
      response: item.response,
    })),
  };
  const packet = { ...packetBody, packetId: fingerprint(packetBody) };
  const manifestBody = {
    schema: BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_SCHEMA,
    packetId: packet.packetId,
    corpusId: bundle.corpusId,
    corpusFingerprint,
    reviewerId: bundle.reviewerId,
    reviewProtocol: bundle.reviewProtocol,
    rubricFingerprint: bundle.rubric.rubricFingerprint,
    items: bundle.items.map(item => ({
      reviewId: item.reviewId,
      split: item.split,
      category: item.category,
      difficulty: item.difficulty,
      source: item.source,
    })),
  };
  const controlManifest = { ...manifestBody, manifestId: fingerprint(manifestBody) };
  const responseTemplate = {
    schema: BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_SCHEMA,
    packetId: packet.packetId,
    reviewerId: bundle.reviewerId,
    reviewProtocol: bundle.reviewProtocol,
    reviews: packet.items.map(item => ({
      reviewId: item.reviewId,
      expertScoreMicros: null,
      dimensionScores: bundle.rubric.dimensions.map(dimension => ({
        dimension,
        scoreMicros: null,
      })),
      expertRationale: '',
      reviewedAt: null,
    })),
  };
  return { packet, controlManifest, responseTemplate };
}

function normalizeBenchmarkBlindReviewSourceBundle(rawValue) {
  if (rawValue?.schema === BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA) {
    return normalizeBenchmarkBlindReviewSourceBundleV2(rawValue);
  }
  return normalizeBenchmarkBlindReviewSourceBundleV1(rawValue);
}

module.exports = {
  BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_SCHEMA,
  BENCHMARK_BLIND_REVIEW_PACKET_SCHEMA,
  BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_SCHEMA,
  BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_SCHEMA,
  BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA,
  CATEGORIES,
  DIFFICULTIES,
  EXPECTED_HOLDOUT_PER_CELL,
  EXPECTED_ITEM_COUNT,
  EXPECTED_VALIDATION_PER_CELL,
  REVIEW_PROTOCOL,
  buildBenchmarkBlindReviewPackage,
  normalizeBenchmarkBlindReviewSourceBundle,
};

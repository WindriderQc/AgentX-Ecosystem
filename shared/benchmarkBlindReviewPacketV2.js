'use strict';

const { fingerprint } = require('./workerContract');

const BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA = 'agentx.benchmark-blind-review-source-bundle/v2';
const BENCHMARK_BLIND_REVIEW_PACKET_V2_SCHEMA = 'agentx.benchmark-blind-review-packet/v2';
const BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_V2_SCHEMA = 'agentx.benchmark-blind-review-control-manifest/v2';
const BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_V2_SCHEMA = 'agentx.benchmark-blind-review-response-template/v2';
const CALIBRATION_CAPTURE_AUTHORITY_SCHEMA = 'agentx.benchmark-judge-calibration-capture-authority/v1';
const REVIEW_RUBRIC_SCHEMA = 'agentx.benchmark-human-review-rubric/v1';
const REVIEW_PROTOCOL = 'blind_independent';
const CATEGORIES = Object.freeze(['coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation']);
const DIFFICULTIES = Object.freeze([1, 2, 3, 4, 5]);
const EXPECTED_ITEM_COUNT = 175;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

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
  if (typeof value !== 'string' || value.length < 1 || value.length > max
      || value !== value.trim() || !IDENTIFIER_PATTERN.test(value)) {
    throw packetError(`${label} must be an opaque logical identifier`);
  }
  return value;
}

function canonicalText(value, label, max = 100_000) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value !== value.trim()) {
    throw packetError(`${label} must be non-empty canonical text`);
  }
  return value;
}

function nullableText(value, label) {
  return value === null ? null : canonicalText(value, label);
}

function sha256(value, label) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw packetError(`${label} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || new Date(value).toISOString() !== value) {
    throw packetError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function scoreMicros(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw packetError(`${label} must be an integer from 0 through 10000000`);
  }
  return value;
}

function normalizeScale(rawValue) {
  const value = exactObject(rawValue, ['minimumMicros', 'maximumMicros', 'anchors'], 'rubric.scale');
  if (value.minimumMicros !== 0 || value.maximumMicros !== 10_000_000) {
    throw packetError('rubric.scale must cover exactly 0 through 10000000 micros');
  }
  if (!Array.isArray(value.anchors) || value.anchors.length !== 5) {
    throw packetError('rubric.scale.anchors must contain exactly five anchors');
  }
  const expected = [[0, 2_000_000], [3_000_000, 4_000_000], [5_000_000, 6_000_000], [7_000_000, 8_000_000], [9_000_000, 10_000_000]];
  const anchors = value.anchors.map((rawAnchor, index) => {
    const label = `rubric.scale.anchors[${index}]`;
    const anchor = exactObject(rawAnchor, ['minimumMicros', 'maximumMicros', 'meaning'], label);
    const normalized = {
      minimumMicros: scoreMicros(anchor.minimumMicros, `${label}.minimumMicros`),
      maximumMicros: scoreMicros(anchor.maximumMicros, `${label}.maximumMicros`),
      meaning: canonicalText(anchor.meaning, `${label}.meaning`, 500),
    };
    if (normalized.minimumMicros !== expected[index][0] || normalized.maximumMicros !== expected[index][1]) {
      throw packetError('rubric.scale.anchors must preserve the approved 0-2, 3-4, 5-6, 7-8, 9-10 bands');
    }
    return normalized;
  });
  return { minimumMicros: 0, maximumMicros: 10_000_000, anchors };
}

function normalizeRubric(rawValue) {
  const value = exactObject(rawValue, ['schema', 'rubricId', 'rubricFingerprint', 'scale', 'categories'], 'rubric');
  if (value.schema !== REVIEW_RUBRIC_SCHEMA) throw packetError(`rubric.schema must be ${REVIEW_RUBRIC_SCHEMA}`);
  if (!Array.isArray(value.categories) || value.categories.length !== CATEGORIES.length) {
    throw packetError('rubric.categories must contain exactly the seven Product categories');
  }
  const categories = value.categories.map((rawCategory, categoryIndex) => {
    const label = `rubric.categories[${categoryIndex}]`;
    const category = exactObject(rawCategory, ['category', 'description', 'dimensions'], label);
    if (category.category !== CATEGORIES[categoryIndex]) {
      throw packetError('rubric.categories must use canonical Product category order');
    }
    if (!Array.isArray(category.dimensions) || category.dimensions.length < 1 || category.dimensions.length > 16) {
      throw packetError(`${label}.dimensions must contain from 1 through 16 dimensions`);
    }
    const dimensions = category.dimensions.map((rawDimension, dimensionIndex) => {
      const dimensionLabel = `${label}.dimensions[${dimensionIndex}]`;
      const dimension = exactObject(rawDimension, ['name', 'description', 'weightMicros'], dimensionLabel);
      if (!Number.isSafeInteger(dimension.weightMicros) || dimension.weightMicros < 1 || dimension.weightMicros > 1_000_000) {
        throw packetError(`${dimensionLabel}.weightMicros must be a positive integer up to 1000000`);
      }
      return {
        name: identifier(dimension.name, `${dimensionLabel}.name`, 120),
        description: canonicalText(dimension.description, `${dimensionLabel}.description`, 500),
        weightMicros: dimension.weightMicros,
      };
    });
    if (new Set(dimensions.map(dimension => dimension.name)).size !== dimensions.length) {
      throw packetError(`${label}.dimensions must have unique names`);
    }
    if (dimensions.reduce((sum, dimension) => sum + dimension.weightMicros, 0) !== 1_000_000) {
      throw packetError(`${label}.dimension weights must sum to 1000000`);
    }
    return {
      category: category.category,
      description: canonicalText(category.description, `${label}.description`, 500),
      dimensions,
    };
  });
  const scale = normalizeScale(value.scale);
  const body = { schema: REVIEW_RUBRIC_SCHEMA, scale, categories };
  if (sha256(value.rubricFingerprint, 'rubric.rubricFingerprint') !== fingerprint(body)) {
    throw packetError('rubric.rubricFingerprint does not match the canonical review rubric');
  }
  return {
    schema: REVIEW_RUBRIC_SCHEMA,
    rubricId: identifier(value.rubricId, 'rubric.rubricId'),
    rubricFingerprint: value.rubricFingerprint,
    scale,
    categories,
  };
}

function normalizeCaptureAuthority(rawValue) {
  const value = exactObject(rawValue, [
    'schema', 'collectorRevision', 'productRevision', 'judgeTargetFingerprint', 'judgeModelDigest',
    'runtimeRubricFingerprint', 'captureProfileFingerprint', 'capturedAt', 'providerCostUsdMicros', 'fallbackUsed',
  ], 'captureAuthority');
  if (value.schema !== CALIBRATION_CAPTURE_AUTHORITY_SCHEMA) {
    throw packetError(`captureAuthority.schema must be ${CALIBRATION_CAPTURE_AUTHORITY_SCHEMA}`);
  }
  if (!GIT_REVISION_PATTERN.test(value.collectorRevision || '') || !GIT_REVISION_PATTERN.test(value.productRevision || '')) {
    throw packetError('captureAuthority revisions must be exact Git commits');
  }
  if (!IMAGE_DIGEST_PATTERN.test(value.judgeModelDigest || '')) {
    throw packetError('captureAuthority.judgeModelDigest must be an immutable SHA-256 digest');
  }
  if (value.providerCostUsdMicros !== 0 || value.fallbackUsed !== false) {
    throw packetError('calibration capture must be zero-cost and fail closed without fallback');
  }
  return {
    schema: CALIBRATION_CAPTURE_AUTHORITY_SCHEMA,
    collectorRevision: value.collectorRevision,
    productRevision: value.productRevision,
    judgeTargetFingerprint: sha256(value.judgeTargetFingerprint, 'captureAuthority.judgeTargetFingerprint'),
    judgeModelDigest: value.judgeModelDigest,
    runtimeRubricFingerprint: sha256(value.runtimeRubricFingerprint, 'captureAuthority.runtimeRubricFingerprint'),
    captureProfileFingerprint: sha256(value.captureProfileFingerprint, 'captureAuthority.captureProfileFingerprint'),
    capturedAt: timestamp(value.capturedAt, 'captureAuthority.capturedAt'),
    providerCostUsdMicros: 0,
    fallbackUsed: false,
  };
}

function normalizeSource(rawValue, item, index) {
  const label = `items[${index}].source`;
  const value = exactObject(rawValue, [
    'captureItemId', 'captureFingerprint', 'promptFingerprint', 'expectedAnswerFingerprint',
    'responseFingerprint', 'category', 'judgeIdentityFingerprint', 'judgeReceiptFingerprint', 'judgeScoreMicros',
  ], label);
  const normalized = {
    captureItemId: sha256(value.captureItemId, `${label}.captureItemId`),
    captureFingerprint: sha256(value.captureFingerprint, `${label}.captureFingerprint`),
    promptFingerprint: sha256(value.promptFingerprint, `${label}.promptFingerprint`),
    expectedAnswerFingerprint: value.expectedAnswerFingerprint === null ? null : sha256(value.expectedAnswerFingerprint, `${label}.expectedAnswerFingerprint`),
    responseFingerprint: sha256(value.responseFingerprint, `${label}.responseFingerprint`),
    category: value.category,
    judgeIdentityFingerprint: sha256(value.judgeIdentityFingerprint, `${label}.judgeIdentityFingerprint`),
    judgeReceiptFingerprint: sha256(value.judgeReceiptFingerprint, `${label}.judgeReceiptFingerprint`),
    judgeScoreMicros: scoreMicros(value.judgeScoreMicros, `${label}.judgeScoreMicros`),
  };
  if (normalized.category !== item.category
      || normalized.promptFingerprint !== fingerprint(item.prompt)
      || normalized.expectedAnswerFingerprint !== (item.expectedAnswer === null ? null : fingerprint(item.expectedAnswer))
      || normalized.responseFingerprint !== fingerprint(item.response)) {
    throw packetError(`${label} does not match the reviewer-visible calibration content`);
  }
  const captureFingerprint = fingerprint({
    schema: 'agentx.benchmark-judge-calibration-capture-item/v1',
    captureItemId: normalized.captureItemId,
    promptFingerprint: normalized.promptFingerprint,
    expectedAnswerFingerprint: normalized.expectedAnswerFingerprint,
    responseFingerprint: normalized.responseFingerprint,
    category: normalized.category,
    judgeIdentityFingerprint: normalized.judgeIdentityFingerprint,
    judgeReceiptFingerprint: normalized.judgeReceiptFingerprint,
    judgeScoreMicros: normalized.judgeScoreMicros,
  });
  if (normalized.captureFingerprint !== captureFingerprint) {
    throw packetError(`${label}.captureFingerprint does not match the canonical capture item`);
  }
  return normalized;
}

function normalizeItem(rawValue, index) {
  const label = `items[${index}]`;
  const value = exactObject(rawValue, ['reviewId', 'split', 'category', 'difficulty', 'prompt', 'expectedAnswer', 'response', 'source'], label);
  if (!['validation', 'holdout'].includes(value.split)) throw packetError(`${label}.split must be validation or holdout`);
  if (!CATEGORIES.includes(value.category) || !DIFFICULTIES.includes(value.difficulty)) {
    throw packetError(`${label} has an unsupported category or difficulty`);
  }
  const item = {
    reviewId: identifier(value.reviewId, `${label}.reviewId`),
    split: value.split,
    category: value.category,
    difficulty: value.difficulty,
    prompt: canonicalText(value.prompt, `${label}.prompt`),
    expectedAnswer: nullableText(value.expectedAnswer, `${label}.expectedAnswer`),
    response: canonicalText(value.response, `${label}.response`),
  };
  return { ...item, source: normalizeSource(value.source, item, index) };
}

function assertCoverage(items) {
  if (items.length !== EXPECTED_ITEM_COUNT) throw packetError(`items must contain exactly ${EXPECTED_ITEM_COUNT} reviews`);
  const counts = new Map();
  for (const item of items) {
    const key = `${item.category}\u0000${item.difficulty}\u0000${item.split}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const category of CATEGORIES) {
    for (const difficulty of DIFFICULTIES) {
      if ((counts.get(`${category}\u0000${difficulty}\u0000validation`) || 0) !== 2
          || (counts.get(`${category}\u0000${difficulty}\u0000holdout`) || 0) !== 3) {
        throw packetError(`${category}/difficulty-${difficulty} must contain exactly 2 validation and 3 holdout reviews`);
      }
    }
  }
}

function normalizeBenchmarkBlindReviewSourceBundleV2(rawValue) {
  const value = exactObject(rawValue, ['schema', 'corpusId', 'reviewerId', 'reviewProtocol', 'captureAuthority', 'rubric', 'items'], 'source bundle');
  if (value.schema !== BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA || value.reviewProtocol !== REVIEW_PROTOCOL) {
    throw packetError(`source bundle must use ${BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA} and ${REVIEW_PROTOCOL}`);
  }
  if (!Array.isArray(value.items)) throw packetError('items must be an array');
  const items = value.items.map(normalizeItem);
  assertCoverage(items);
  for (const selector of [item => item.reviewId, item => item.source.captureItemId, item => item.source.captureFingerprint, item => item.source.judgeReceiptFingerprint]) {
    if (new Set(items.map(selector)).size !== items.length) throw packetError('review and calibration capture identities must be unique');
  }
  return {
    schema: BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA,
    corpusId: identifier(value.corpusId, 'corpusId'),
    reviewerId: identifier(value.reviewerId, 'reviewerId'),
    reviewProtocol: REVIEW_PROTOCOL,
    captureAuthority: normalizeCaptureAuthority(value.captureAuthority),
    rubric: normalizeRubric(value.rubric),
    items,
  };
}

function buildBenchmarkBlindReviewPackageV2(rawBundle) {
  const bundle = normalizeBenchmarkBlindReviewSourceBundleV2(rawBundle);
  const corpusFingerprint = fingerprint({
    schema: bundle.schema,
    corpusId: bundle.corpusId,
    captureAuthority: bundle.captureAuthority,
    rubricFingerprint: bundle.rubric.rubricFingerprint,
    items: bundle.items,
  });
  const packetBody = {
    schema: BENCHMARK_BLIND_REVIEW_PACKET_V2_SCHEMA,
    corpusId: bundle.corpusId,
    corpusFingerprint,
    reviewerId: bundle.reviewerId,
    reviewProtocol: REVIEW_PROTOCOL,
    rubric: bundle.rubric,
    items: bundle.items.map(({ reviewId, category, difficulty, prompt, expectedAnswer, response }) => ({ reviewId, category, difficulty, prompt, expectedAnswer, response })),
  };
  const packet = { ...packetBody, packetId: fingerprint(packetBody) };
  const manifestBody = {
    schema: BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_V2_SCHEMA,
    packetId: packet.packetId,
    corpusId: bundle.corpusId,
    corpusFingerprint,
    reviewerId: bundle.reviewerId,
    reviewProtocol: REVIEW_PROTOCOL,
    captureAuthority: bundle.captureAuthority,
    rubricFingerprint: bundle.rubric.rubricFingerprint,
    items: bundle.items.map(({ reviewId, split, category, difficulty, source }) => ({ reviewId, split, category, difficulty, source })),
  };
  const controlManifest = { ...manifestBody, manifestId: fingerprint(manifestBody) };
  const dimensionsByCategory = new Map(bundle.rubric.categories.map(category => [category.category, category.dimensions]));
  const responseTemplate = {
    schema: BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_V2_SCHEMA,
    packetId: packet.packetId,
    reviewerId: bundle.reviewerId,
    reviewProtocol: REVIEW_PROTOCOL,
    reviews: packet.items.map(item => ({
      reviewId: item.reviewId,
      expertScoreMicros: null,
      dimensionScores: dimensionsByCategory.get(item.category).map(dimension => ({
        dimension: dimension.name,
        weightMicros: dimension.weightMicros,
        scoreMicros: null,
      })),
      expertRationale: '',
      reviewedAt: null,
    })),
  };
  return { packet, controlManifest, responseTemplate };
}

module.exports = {
  BENCHMARK_BLIND_REVIEW_CONTROL_MANIFEST_V2_SCHEMA,
  BENCHMARK_BLIND_REVIEW_PACKET_V2_SCHEMA,
  BENCHMARK_BLIND_REVIEW_RESPONSE_TEMPLATE_V2_SCHEMA,
  BENCHMARK_BLIND_REVIEW_SOURCE_BUNDLE_V2_SCHEMA,
  CALIBRATION_CAPTURE_AUTHORITY_SCHEMA,
  REVIEW_RUBRIC_SCHEMA,
  buildBenchmarkBlindReviewPackageV2,
  normalizeBenchmarkBlindReviewSourceBundleV2,
};

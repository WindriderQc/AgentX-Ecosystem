'use strict';

const RECOVERY_DRILL_RECEIPT_SCHEMA = 'agentx.recovery-drill-receipt/v1';
const RECOVERY_DRILL_OUTCOME = 'passed';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PRODUCT_PROFILES = Object.freeze(['demo', 'full']);

const ASSERTION_KEYS = Object.freeze([
  'pinnedDependencyImagesVerified',
  'renderedTopologyBound',
  'writersAbsentDuringCapture',
  'bundleVerifiedAfterCapture',
  'sourceDataDestroyedBeforeRestore',
  'corruptedBundleRejectedBeforeMutation',
  'corruptedBundleTargetUnchanged',
  'bundleVerifiedBeforeRestoreMutation',
  'mongodbRepresentativeStateRestored',
  'mongodbStateHashMatched',
  'qdrantRepresentativeStateRestored',
  'qdrantStateHashMatched',
  'exactProductIdentityVerified',
  'promptJourneyPassed',
  'ragJourneyPassed',
  'benchmarkJourneyPassed',
  'browserJourneyPassed',
  'scopedDockerResourcesRemoved',
  'temporaryWorkspaceRemoved',
]);

const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'receiptId',
  'createdAt',
  'outcome',
  'product',
  'topology',
  'sourceImages',
  'bundle',
  'dependencies',
  'measurements',
  'state',
  'productProof',
  'assertions',
  'privacy',
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

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateDatastoreState(value, label, countKey, errors) {
  if (!hasExactKeys(
    value,
    ['representativeRecords', countKey, 'sourceSha256', 'restoredSha256'],
    label,
    errors
  )) return;
  if (!isPositiveSafeInteger(value.representativeRecords)) {
    errors.push(`${label}.representativeRecords must be a positive safe integer`);
  }
  if (!isPositiveSafeInteger(value[countKey])) {
    errors.push(`${label}.${countKey} must be a positive safe integer`);
  }
  for (const key of ['sourceSha256', 'restoredSha256']) {
    if (typeof value[key] !== 'string' || !SHA256_PATTERN.test(value[key])) {
      errors.push(`${label}.${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (value.sourceSha256 !== value.restoredSha256) {
    errors.push(`${label} source and restored SHA-256 digests must match`);
  }
}

function validateRecoveryDrillReceipt(receipt) {
  const errors = [];
  if (!hasExactKeys(receipt, TOP_LEVEL_KEYS, 'receipt', errors)) {
    return { valid: false, errors };
  }

  if (receipt.schema !== RECOVERY_DRILL_RECEIPT_SCHEMA) {
    errors.push(`receipt.schema must be ${RECOVERY_DRILL_RECEIPT_SCHEMA}`);
  }
  if (typeof receipt.receiptId !== 'string' || !UUID_V4_PATTERN.test(receipt.receiptId)) {
    errors.push('receipt.receiptId must be a lowercase UUID v4');
  }
  if (!isCanonicalIsoTimestamp(receipt.createdAt)) {
    errors.push('receipt.createdAt must be a canonical UTC timestamp with milliseconds');
  }
  if (receipt.outcome !== RECOVERY_DRILL_OUTCOME) {
    errors.push(`receipt.outcome must be ${RECOVERY_DRILL_OUTCOME}`);
  }

  if (hasExactKeys(receipt.product, ['version', 'profile', 'revision'], 'receipt.product', errors)) {
    if (typeof receipt.product.version !== 'string' || !SEMVER_PATTERN.test(receipt.product.version)) {
      errors.push('receipt.product.version must be SemVer');
    }
    if (!PRODUCT_PROFILES.includes(receipt.product.profile)) {
      errors.push(`receipt.product.profile must be one of ${PRODUCT_PROFILES.join(', ')}`);
    }
    if (typeof receipt.product.revision !== 'string' || !GIT_REVISION_PATTERN.test(receipt.product.revision)) {
      errors.push('receipt.product.revision must be a full lowercase Git revision');
    }
  }

  if (hasExactKeys(
    receipt.topology,
    ['sha256', 'services', 'publishedPorts', 'hostBindMounts'],
    'receipt.topology',
    errors
  )) {
    if (typeof receipt.topology.sha256 !== 'string' || !SHA256_PATTERN.test(receipt.topology.sha256)) {
      errors.push('receipt.topology.sha256 must be a lowercase SHA-256 digest');
    }
    if (receipt.topology.services !== 6) errors.push('receipt.topology.services must be 6');
    if (receipt.topology.publishedPorts !== 0) errors.push('receipt.topology.publishedPorts must be 0');
    if (receipt.topology.hostBindMounts !== 0) errors.push('receipt.topology.hostBindMounts must be 0');
  }

  if (hasExactKeys(
    receipt.sourceImages,
    ['core', 'benchmark', 'rag', 'mongodb', 'qdrant'],
    'receipt.sourceImages',
    errors
  )) {
    for (const key of ['core', 'benchmark', 'rag', 'mongodb', 'qdrant']) {
      if (!IMAGE_DIGEST_PATTERN.test(receipt.sourceImages[key] || '')) {
        errors.push(`receipt.sourceImages.${key} must be a lowercase image digest`);
      }
    }
  }

  if (hasExactKeys(receipt.bundle, ['bundleId', 'manifestSha256'], 'receipt.bundle', errors)) {
    if (typeof receipt.bundle.bundleId !== 'string' || !UUID_V4_PATTERN.test(receipt.bundle.bundleId)) {
      errors.push('receipt.bundle.bundleId must be a lowercase UUID v4');
    }
    if (typeof receipt.bundle.manifestSha256 !== 'string' || !SHA256_PATTERN.test(receipt.bundle.manifestSha256)) {
      errors.push('receipt.bundle.manifestSha256 must be a lowercase SHA-256 digest');
    }
  }

  if (hasExactKeys(receipt.dependencies, ['mongodb', 'qdrant', 'transportHelper'], 'receipt.dependencies', errors)) {
    if (hasExactKeys(
      receipt.dependencies.mongodb,
      ['imageDigest', 'serverVersion', 'toolsVersion'],
      'receipt.dependencies.mongodb',
      errors
    )) {
      if (!IMAGE_DIGEST_PATTERN.test(receipt.dependencies.mongodb.imageDigest || '')) {
        errors.push('receipt.dependencies.mongodb.imageDigest must be a lowercase image digest');
      }
      if (!SEMVER_PATTERN.test(receipt.dependencies.mongodb.serverVersion || '')) {
        errors.push('receipt.dependencies.mongodb.serverVersion must be SemVer');
      }
      if (!SEMVER_PATTERN.test(receipt.dependencies.mongodb.toolsVersion || '')) {
        errors.push('receipt.dependencies.mongodb.toolsVersion must be SemVer');
      }
    }
    if (hasExactKeys(
      receipt.dependencies.qdrant,
      ['imageDigest', 'serverVersion'],
      'receipt.dependencies.qdrant',
      errors
    )) {
      if (!IMAGE_DIGEST_PATTERN.test(receipt.dependencies.qdrant.imageDigest || '')) {
        errors.push('receipt.dependencies.qdrant.imageDigest must be a lowercase image digest');
      }
      if (!SEMVER_PATTERN.test(receipt.dependencies.qdrant.serverVersion || '')) {
        errors.push('receipt.dependencies.qdrant.serverVersion must be SemVer');
      }
    }
    if (hasExactKeys(
      receipt.dependencies.transportHelper,
      ['imageDigest', 'version'],
      'receipt.dependencies.transportHelper',
      errors
    )) {
      if (!IMAGE_DIGEST_PATTERN.test(receipt.dependencies.transportHelper.imageDigest || '')) {
        errors.push('receipt.dependencies.transportHelper.imageDigest must be a lowercase image digest');
      }
      if (!SEMVER_PATTERN.test(receipt.dependencies.transportHelper.version || '')) {
        errors.push('receipt.dependencies.transportHelper.version must be SemVer');
      }
    }
  }

  if (hasExactKeys(
    receipt.measurements,
    ['captureMs', 'corruptionGateMs', 'restoreMs', 'totalMs'],
    'receipt.measurements',
    errors
  )) {
    for (const key of ['captureMs', 'corruptionGateMs', 'restoreMs', 'totalMs']) {
      if (!isNonNegativeSafeInteger(receipt.measurements[key])) {
        errors.push(`receipt.measurements.${key} must be a non-negative safe integer`);
      }
    }
    if (
      isNonNegativeSafeInteger(receipt.measurements.totalMs)
      && isNonNegativeSafeInteger(receipt.measurements.captureMs)
      && isNonNegativeSafeInteger(receipt.measurements.corruptionGateMs)
      && isNonNegativeSafeInteger(receipt.measurements.restoreMs)
      && receipt.measurements.totalMs < (
        receipt.measurements.captureMs
        + receipt.measurements.corruptionGateMs
        + receipt.measurements.restoreMs
      )
    ) {
      errors.push('receipt.measurements.totalMs must cover all measured phases');
    }
  }

  if (hasExactKeys(receipt.state, ['mongodb', 'qdrant'], 'receipt.state', errors)) {
    validateDatastoreState(receipt.state.mongodb, 'receipt.state.mongodb', 'collections', errors);
    validateDatastoreState(receipt.state.qdrant, 'receipt.state.qdrant', 'points', errors);
  }

  if (hasExactKeys(receipt.productProof, ['identities', 'journeys', 'schemas'], 'receipt.productProof', errors)) {
    if (hasExactKeys(
      receipt.productProof.identities,
      ['core', 'benchmark', 'rag'],
      'receipt.productProof.identities',
      errors
    )) {
      const expectedServices = { core: 'agentx-core', benchmark: 'agentx-benchmark', rag: 'agentx-rag' };
      for (const [key, service] of Object.entries(expectedServices)) {
        const identity = receipt.productProof.identities[key];
        if (!hasExactKeys(identity, ['service', 'version', 'profile', 'revision'], `receipt.productProof.identities.${key}`, errors)) continue;
        if (identity.service !== service) errors.push(`receipt.productProof.identities.${key}.service must be ${service}`);
        if (identity.version !== receipt.product?.version) errors.push(`receipt.productProof.identities.${key}.version must match receipt.product.version`);
        if (identity.profile !== receipt.product?.profile) errors.push(`receipt.productProof.identities.${key}.profile must match receipt.product.profile`);
        if (identity.revision !== receipt.product?.revision) errors.push(`receipt.productProof.identities.${key}.revision must match receipt.product.revision`);
      }
    }
    if (hasExactKeys(
      receipt.productProof.journeys,
      ['prompt', 'rag', 'benchmark', 'vector', 'browser'],
      'receipt.productProof.journeys',
      errors
    )) {
      for (const key of ['prompt', 'rag', 'benchmark', 'vector', 'browser']) {
        if (receipt.productProof.journeys[key] !== true) {
          errors.push(`receipt.productProof.journeys.${key} must be true`);
        }
      }
    }
    if (hasExactKeys(receipt.productProof.schemas, ['mongodb', 'qdrant'], 'receipt.productProof.schemas', errors)) {
      if (receipt.productProof.schemas.mongodb !== true) errors.push('receipt.productProof.schemas.mongodb must be true');
      if (receipt.productProof.schemas.qdrant !== true) errors.push('receipt.productProof.schemas.qdrant must be true');
    }
  }

  if (hasExactKeys(receipt.assertions, ASSERTION_KEYS, 'receipt.assertions', errors)) {
    for (const key of ASSERTION_KEYS) {
      if (receipt.assertions[key] !== true) {
        errors.push(`receipt.assertions.${key} must be true`);
      }
    }
  }

  if (hasExactKeys(
    receipt.privacy,
    ['containsAddresses', 'containsRawDocumentContent', 'containsSecrets'],
    'receipt.privacy',
    errors
  )) {
    for (const key of ['containsAddresses', 'containsRawDocumentContent', 'containsSecrets']) {
      if (receipt.privacy[key] !== false) {
        errors.push(`receipt.privacy.${key} must be false`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function assertRecoveryDrillReceipt(receipt) {
  const result = validateRecoveryDrillReceipt(receipt);
  if (!result.valid) {
    const error = new Error(`Invalid Agent X recovery drill receipt:\n- ${result.errors.join('\n- ')}`);
    error.code = 'INVALID_RECOVERY_DRILL_RECEIPT';
    error.details = result.errors;
    throw error;
  }
  return receipt;
}

module.exports = {
  ASSERTION_KEYS,
  IMAGE_DIGEST_PATTERN,
  RECOVERY_DRILL_OUTCOME,
  RECOVERY_DRILL_RECEIPT_SCHEMA,
  SHA256_PATTERN,
  assertRecoveryDrillReceipt,
  validateRecoveryDrillReceipt,
};

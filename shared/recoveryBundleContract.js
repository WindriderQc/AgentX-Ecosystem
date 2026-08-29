'use strict';

const RECOVERY_BUNDLE_SCHEMA = 'agentx.recovery-bundle/v1';
const PRODUCT_NAME = 'Agent X Ecosystem';
const CAPTURE_MODE = 'quiesced-compose';
const COMPATIBILITY_MODE = 'exact-product-revision';
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUNDLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_DATASTORE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_VERSION_LENGTH = 128;

const PRODUCT_PROFILES = Object.freeze(['demo', 'full']);
const SOURCE_IMAGE_KEYS = Object.freeze(['core', 'benchmark', 'rag', 'mongodb', 'qdrant']);

const OBSERVED_STOPPED_WRITERS = Object.freeze([
  'core',
  'benchmark',
  'rag',
]);

const PRODUCT_CONFIG_SOURCE_IDS = Object.freeze([
  'docker-compose.yml',
  'docker-compose.ollama.yml',
  'config/agentx.env',
  'config/rag-ingestion-policy.json',
  'config/product-surfaces.json',
  'config/adapter-consumer-contracts.json',
  'config/container-image-pins.json',
]);

const RECOVERY_ARTIFACTS = Object.freeze([
  Object.freeze({
    role: 'mongodb',
    path: 'artifacts/mongodb.archive.gz',
    mediaType: 'application/gzip',
  }),
  Object.freeze({
    role: 'qdrant',
    path: 'artifacts/qdrant.collection.snapshot',
    mediaType: 'application/octet-stream',
  }),
  Object.freeze({
    role: 'product-config',
    path: 'artifacts/product-config.tar.gz',
    mediaType: 'application/gzip',
  }),
]);

// V1 is intentionally an exact allowlist. These categories are not silently
// discovered or copied by a recovery capture implementation.
const RECOVERY_BUNDLE_EXCLUSIONS = Object.freeze([
  'logs',
  'secrets-and-credentials',
  'runtime-environment-files',
  'private-adapters-and-deployments',
  'ollama-model-volumes',
  'deployment-specific-benchmark-configuration',
  'prior-recovery-inventories',
  'personal-and-aiops-data',
  'system-crontabs',
  'generated-caches-and-build-output',
]);

const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'bundleId',
  'createdAt',
  'product',
  'sourceImages',
  'dependencies',
  'capture',
  'compatibility',
  'artifacts',
  'restoreVerified',
  'exclusions',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareExactArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function hasExactKeys(value, expectedKeys, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }

  const actualKeys = Object.keys(value);
  const missing = expectedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (extra.length) errors.push(`${label} has unsupported keys: ${extra.join(', ')}`);
  return missing.length === 0 && extra.length === 0;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBoundedSingleLineString(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\r\n\u2028\u2029]/.test(value);
}

function isSemVer(value) {
  return isBoundedSingleLineString(value, MAX_VERSION_LENGTH) && SEMVER_PATTERN.test(value);
}

function isSafeBundleRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..')
    && segments.join('/') === value;
}

function validateRecoveryBundleManifest(manifest) {
  const errors = [];
  if (!hasExactKeys(manifest, TOP_LEVEL_KEYS, 'manifest', errors)) {
    return { valid: false, errors };
  }

  if (manifest.schema !== RECOVERY_BUNDLE_SCHEMA) {
    errors.push(`manifest.schema must be ${RECOVERY_BUNDLE_SCHEMA}`);
  }
  if (typeof manifest.bundleId !== 'string' || !BUNDLE_ID_PATTERN.test(manifest.bundleId)) {
    errors.push('manifest.bundleId must be a lowercase UUID v4');
  }
  if (!isCanonicalIsoTimestamp(manifest.createdAt)) {
    errors.push('manifest.createdAt must be a canonical UTC timestamp with milliseconds');
  }

  if (hasExactKeys(manifest.product, ['name', 'version', 'profile', 'revision'], 'manifest.product', errors)) {
    if (manifest.product.name !== PRODUCT_NAME) {
      errors.push(`manifest.product.name must be ${PRODUCT_NAME}`);
    }
    if (!isSemVer(manifest.product.version)) {
      errors.push('manifest.product.version must be a bounded single-line SemVer version');
    }
    if (!PRODUCT_PROFILES.includes(manifest.product.profile)) {
      errors.push(`manifest.product.profile must be one of ${PRODUCT_PROFILES.join(', ')}`);
    }
    if (typeof manifest.product.revision !== 'string' || !GIT_REVISION_PATTERN.test(manifest.product.revision)) {
      errors.push('manifest.product.revision must be a full 40-character lowercase Git revision');
    }
  }

  if (hasExactKeys(manifest.sourceImages, SOURCE_IMAGE_KEYS, 'manifest.sourceImages', errors)) {
    for (const image of SOURCE_IMAGE_KEYS) {
      if (typeof manifest.sourceImages[image] !== 'string' || !IMAGE_DIGEST_PATTERN.test(manifest.sourceImages[image])) {
        errors.push(`manifest.sourceImages.${image} must be a lowercase sha256 image digest`);
      }
    }
  }

  if (hasExactKeys(manifest.dependencies, ['mongodb', 'qdrant'], 'manifest.dependencies', errors)) {
    if (hasExactKeys(
      manifest.dependencies.mongodb,
      ['serverVersion', 'toolsVersion', 'database'],
      'manifest.dependencies.mongodb',
      errors
    )) {
      if (!isSemVer(manifest.dependencies.mongodb.serverVersion)) {
        errors.push('manifest.dependencies.mongodb.serverVersion must be a bounded single-line SemVer version');
      }
      if (!isSemVer(manifest.dependencies.mongodb.toolsVersion)) {
        errors.push('manifest.dependencies.mongodb.toolsVersion must be a bounded single-line SemVer version');
      }
      if (
        typeof manifest.dependencies.mongodb.database !== 'string'
        || !SAFE_DATASTORE_IDENTIFIER_PATTERN.test(manifest.dependencies.mongodb.database)
      ) {
        errors.push('manifest.dependencies.mongodb.database must be a safe 1-64 character identifier');
      }
    }
    if (hasExactKeys(
      manifest.dependencies.qdrant,
      ['serverVersion', 'collection'],
      'manifest.dependencies.qdrant',
      errors
    )) {
      if (!isSemVer(manifest.dependencies.qdrant.serverVersion)) {
        errors.push('manifest.dependencies.qdrant.serverVersion must be a bounded single-line SemVer version');
      }
      if (
        typeof manifest.dependencies.qdrant.collection !== 'string'
        || !SAFE_DATASTORE_IDENTIFIER_PATTERN.test(manifest.dependencies.qdrant.collection)
      ) {
        errors.push('manifest.dependencies.qdrant.collection must be a safe 1-64 character identifier');
      }
    }
  }

  if (hasExactKeys(
    manifest.capture,
    ['mode', 'startedAt', 'completedAt', 'complete', 'observedStoppedWriters', 'configSourceIds'],
    'manifest.capture',
    errors
  )) {
    if (manifest.capture.mode !== CAPTURE_MODE) {
      errors.push(`manifest.capture.mode must be ${CAPTURE_MODE}`);
    }
    if (!isCanonicalIsoTimestamp(manifest.capture.startedAt)) {
      errors.push('manifest.capture.startedAt must be a canonical UTC timestamp with milliseconds');
    }
    if (!isCanonicalIsoTimestamp(manifest.capture.completedAt)) {
      errors.push('manifest.capture.completedAt must be a canonical UTC timestamp with milliseconds');
    }
    if (manifest.capture.complete !== true) {
      errors.push('manifest.capture.complete must be true');
    }
    if (!compareExactArray(manifest.capture.observedStoppedWriters, OBSERVED_STOPPED_WRITERS)) {
      errors.push(`manifest.capture.observedStoppedWriters must be exactly ${OBSERVED_STOPPED_WRITERS.join(', ')}`);
    }
    if (!compareExactArray(manifest.capture.configSourceIds, PRODUCT_CONFIG_SOURCE_IDS)) {
      errors.push('manifest.capture.configSourceIds must contain the exact ordered product-config source allowlist');
    }
  }

  if (
    isCanonicalIsoTimestamp(manifest.capture?.startedAt)
    && isCanonicalIsoTimestamp(manifest.capture?.completedAt)
    && new Date(manifest.capture.startedAt).getTime() > new Date(manifest.capture.completedAt).getTime()
  ) {
    errors.push('manifest.capture.startedAt must not be after manifest.capture.completedAt');
  }
  if (
    isCanonicalIsoTimestamp(manifest.capture?.completedAt)
    && isCanonicalIsoTimestamp(manifest.createdAt)
    && new Date(manifest.capture.completedAt).getTime() > new Date(manifest.createdAt).getTime()
  ) {
    errors.push('manifest.capture.completedAt must not be after manifest.createdAt');
  }

  if (hasExactKeys(
    manifest.compatibility,
    ['mode', 'productRevision'],
    'manifest.compatibility',
    errors
  )) {
    if (manifest.compatibility.mode !== COMPATIBILITY_MODE) {
      errors.push(`manifest.compatibility.mode must be ${COMPATIBILITY_MODE}`);
    }
    if (
      typeof manifest.compatibility.productRevision !== 'string'
      || !GIT_REVISION_PATTERN.test(manifest.compatibility.productRevision)
    ) {
      errors.push('manifest.compatibility.productRevision must be a full 40-character lowercase Git revision');
    }
    if (manifest.compatibility.productRevision !== manifest.product?.revision) {
      errors.push('manifest.compatibility.productRevision must exactly match manifest.product.revision');
    }
  }

  if (!Array.isArray(manifest.artifacts)) {
    errors.push('manifest.artifacts must be an array');
  } else {
    if (manifest.artifacts.length !== RECOVERY_ARTIFACTS.length) {
      errors.push(`manifest.artifacts must contain exactly ${RECOVERY_ARTIFACTS.length} entries`);
    }
    manifest.artifacts.forEach((artifact, index) => {
      const label = `manifest.artifacts[${index}]`;
      if (!hasExactKeys(artifact, ['role', 'path', 'bytes', 'sha256', 'mediaType'], label, errors)) return;
      const expected = RECOVERY_ARTIFACTS[index];
      if (!expected) {
        errors.push(`${label} is not supported by ${RECOVERY_BUNDLE_SCHEMA}`);
        return;
      }
      if (artifact.role !== expected.role) errors.push(`${label}.role must be ${expected.role}`);
      if (!isSafeBundleRelativePath(artifact.path)) errors.push(`${label}.path is not a safe bundle-relative path`);
      if (artifact.path !== expected.path) errors.push(`${label}.path must be ${expected.path}`);
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
        errors.push(`${label}.bytes must be a positive safe integer`);
      }
      if (typeof artifact.sha256 !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) {
        errors.push(`${label}.sha256 must be a lowercase SHA-256 digest`);
      }
      if (artifact.mediaType !== expected.mediaType) {
        errors.push(`${label}.mediaType must be ${expected.mediaType}`);
      }
    });
  }

  if (manifest.restoreVerified !== false) {
    errors.push('manifest.restoreVerified must be false until an offline restore rehearsal succeeds');
  }
  if (!compareExactArray(manifest.exclusions, RECOVERY_BUNDLE_EXCLUSIONS)) {
    errors.push('manifest.exclusions must contain the exact v1 recovery exclusion list');
  }

  return { valid: errors.length === 0, errors };
}

function assertRecoveryBundleManifest(manifest) {
  const result = validateRecoveryBundleManifest(manifest);
  if (!result.valid) {
    const error = new Error(`Invalid Agent X recovery bundle manifest:\n- ${result.errors.join('\n- ')}`);
    error.code = 'INVALID_RECOVERY_BUNDLE_MANIFEST';
    error.details = result.errors;
    throw error;
  }
  return manifest;
}

module.exports = {
  BUNDLE_ID_PATTERN,
  CAPTURE_MODE,
  COMPATIBILITY_MODE,
  GIT_REVISION_PATTERN,
  IMAGE_DIGEST_PATTERN,
  ISO_TIMESTAMP_PATTERN,
  MAX_VERSION_LENGTH,
  OBSERVED_STOPPED_WRITERS,
  PRODUCT_NAME,
  PRODUCT_CONFIG_SOURCE_IDS,
  PRODUCT_PROFILES,
  RECOVERY_ARTIFACTS,
  RECOVERY_BUNDLE_EXCLUSIONS,
  RECOVERY_BUNDLE_SCHEMA,
  SAFE_DATASTORE_IDENTIFIER_PATTERN,
  SEMVER_PATTERN,
  SHA256_PATTERN,
  SOURCE_IMAGE_KEYS,
  assertRecoveryBundleManifest,
  isBoundedSingleLineString,
  isCanonicalIsoTimestamp,
  isSafeBundleRelativePath,
  isSemVer,
  validateRecoveryBundleManifest,
};

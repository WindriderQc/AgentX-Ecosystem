'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAPTURE_MODE,
  COMPATIBILITY_MODE,
  OBSERVED_STOPPED_WRITERS,
  PRODUCT_NAME,
  PRODUCT_CONFIG_SOURCE_IDS,
  RECOVERY_ARTIFACTS,
  RECOVERY_BUNDLE_EXCLUSIONS,
  RECOVERY_BUNDLE_SCHEMA,
  assertRecoveryBundleManifest,
  isCanonicalIsoTimestamp,
  isSafeBundleRelativePath,
  validateRecoveryBundleManifest,
} = require('./recoveryBundleContract');

const REVISION = '8a128176b44230cfef77e359e0c15b3a9df16eb1';

function validManifest() {
  return {
    schema: RECOVERY_BUNDLE_SCHEMA,
    bundleId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-28T16:30:01.000Z',
    product: {
      name: PRODUCT_NAME,
      version: '0.1.1',
      profile: 'demo',
      revision: REVISION,
    },
    sourceImages: {
      core: `sha256:${'1'.repeat(64)}`,
      benchmark: `sha256:${'2'.repeat(64)}`,
      rag: `sha256:${'3'.repeat(64)}`,
      mongodb: `sha256:${'4'.repeat(64)}`,
      qdrant: `sha256:${'5'.repeat(64)}`,
    },
    dependencies: {
      mongodb: {
        serverVersion: '7.0.14',
        toolsVersion: '100.10.0',
        database: 'agentx',
      },
      qdrant: {
        serverVersion: '1.11.3',
        collection: 'agentx_embeddings',
      },
    },
    capture: {
      mode: CAPTURE_MODE,
      startedAt: '2026-08-28T16:30:00.000Z',
      completedAt: '2026-08-28T16:30:01.000Z',
      complete: true,
      observedStoppedWriters: [...OBSERVED_STOPPED_WRITERS],
      configSourceIds: [...PRODUCT_CONFIG_SOURCE_IDS],
    },
    compatibility: {
      mode: COMPATIBILITY_MODE,
      productRevision: REVISION,
    },
    artifacts: RECOVERY_ARTIFACTS.map((artifact, index) => ({
      ...artifact,
      bytes: index + 1,
      sha256: String(index + 1).repeat(64),
    })),
    restoreVerified: false,
    exclusions: [...RECOVERY_BUNDLE_EXCLUSIONS],
  };
}

test('accepts the exact v1 recovery bundle manifest contract', () => {
  const manifest = validManifest();
  assert.deepEqual(validateRecoveryBundleManifest(manifest), { valid: true, errors: [] });
  assert.equal(assertRecoveryBundleManifest(manifest), manifest);
});

test('requires exact object keys and rejects extension fields', () => {
  const manifest = validManifest();
  manifest.note = 'not part of v1';
  const result = validateRecoveryBundleManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /manifest has unsupported keys: note/);
});

test('requires exact source image and dependency object keys', () => {
  const manifest = validManifest();
  delete manifest.sourceImages.rag;
  manifest.sourceImages.redis = `sha256:${'6'.repeat(64)}`;
  delete manifest.dependencies.mongodb.toolsVersion;
  manifest.dependencies.qdrant.endpoint = 'http://qdrant:6333';
  const errors = validateRecoveryBundleManifest(manifest).errors.join('\n');
  assert.match(errors, /sourceImages is missing keys: rag/);
  assert.match(errors, /sourceImages has unsupported keys: redis/);
  assert.match(errors, /dependencies\.mongodb is missing keys: toolsVersion/);
  assert.match(errors, /dependencies\.qdrant has unsupported keys: endpoint/);
});

test('requires bounded SemVer product and dependency versions plus a supported profile', () => {
  const manifest = validManifest();
  manifest.product.version = 'v0.1.1';
  manifest.product.profile = 'production';
  manifest.dependencies.mongodb.serverVersion = '7.0\n14';
  manifest.dependencies.mongodb.toolsVersion = '100';
  manifest.dependencies.qdrant.serverVersion = '1.11.3'.repeat(30);
  const errors = validateRecoveryBundleManifest(manifest).errors.join('\n');
  assert.match(errors, /product\.version must be a bounded single-line SemVer/);
  assert.match(errors, /product\.profile must be one of demo, full/);
  assert.match(errors, /mongodb\.serverVersion must be a bounded single-line SemVer/);
  assert.match(errors, /mongodb\.toolsVersion must be a bounded single-line SemVer/);
  assert.match(errors, /qdrant\.serverVersion must be a bounded single-line SemVer/);
});

test('requires exact lowercase source image digests', () => {
  const manifest = validManifest();
  manifest.sourceImages.core = '1'.repeat(64);
  manifest.sourceImages.mongodb = `sha256:${'A'.repeat(64)}`;
  manifest.sourceImages.qdrant = 'sha256:short';
  const errors = validateRecoveryBundleManifest(manifest).errors.join('\n');
  assert.match(errors, /sourceImages\.core must be a lowercase sha256 image digest/);
  assert.match(errors, /sourceImages\.mongodb must be a lowercase sha256 image digest/);
  assert.match(errors, /sourceImages\.qdrant must be a lowercase sha256 image digest/);
});

test('requires safe bounded MongoDB and Qdrant identifiers', () => {
  const manifest = validManifest();
  manifest.dependencies.mongodb.database = '../agentx';
  manifest.dependencies.qdrant.collection = `a${'b'.repeat(64)}`;
  const errors = validateRecoveryBundleManifest(manifest).errors.join('\n');
  assert.match(errors, /mongodb\.database must be a safe 1-64 character identifier/);
  assert.match(errors, /qdrant\.collection must be a safe 1-64 character identifier/);
});

test('requires a lowercase UUID v4 and canonical ordered UTC dates', () => {
  const manifest = validManifest();
  manifest.bundleId = '123E4567-E89B-42D3-A456-426614174000';
  manifest.capture.startedAt = '2026-08-28T16:30:02.000Z';
  manifest.createdAt = '2026-08-28T16:30:00Z';
  const result = validateRecoveryBundleManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /lowercase UUID v4/);
  assert.match(result.errors.join('\n'), /createdAt must be a canonical UTC timestamp/);
  assert.match(result.errors.join('\n'), /startedAt must not be after/);
});

test('accepts only canonical UTC millisecond timestamps', () => {
  assert.equal(isCanonicalIsoTimestamp('2026-08-28T16:30:01.000Z'), true);
  assert.equal(isCanonicalIsoTimestamp('2026-02-30T16:30:01.000Z'), false);
  assert.equal(isCanonicalIsoTimestamp('2026-08-28T16:30:01Z'), false);
  assert.equal(isCanonicalIsoTimestamp('2026-08-28T12:30:01.000-04:00'), false);
});

test('requires a complete quiesced capture with every writer observed stopped', () => {
  const manifest = validManifest();
  manifest.capture.mode = 'online';
  manifest.capture.complete = false;
  manifest.capture.observedStoppedWriters = ['core', 'rag'];
  const result = validateRecoveryBundleManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /mode must be quiesced-compose/);
  assert.match(result.errors.join('\n'), /complete must be true/);
  assert.match(result.errors.join('\n'), /must be exactly core, benchmark, rag/);
});

test('requires the exact ordered secret-free product-config source allowlist', () => {
  assert.deepEqual(PRODUCT_CONFIG_SOURCE_IDS, [
    'docker-compose.yml',
    'docker-compose.ollama.yml',
    'config/agentx.env',
    'config/rag-ingestion-policy.json',
    'config/product-surfaces.json',
    'config/adapter-consumer-contracts.json',
    'config/container-image-pins.json',
  ]);
  const manifest = validManifest();
  manifest.capture.configSourceIds.reverse();
  const result = validateRecoveryBundleManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /exact ordered product-config source allowlist/);
});

test('requires exact lowercase product revision compatibility', () => {
  const manifest = validManifest();
  manifest.product.revision = REVISION.toUpperCase();
  manifest.compatibility.productRevision = '1'.repeat(40);
  const result = validateRecoveryBundleManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /product\.revision must be a full 40-character lowercase Git revision/);
  assert.match(result.errors.join('\n'), /must exactly match manifest\.product\.revision/);
});

test('requires exact artifact roles, safe fixed paths, sizes, hashes, and media types', () => {
  const manifest = validManifest();
  manifest.artifacts[0].role = 'database';
  manifest.artifacts[0].path = '../mongodb.archive.gz';
  manifest.artifacts[0].bytes = 0;
  manifest.artifacts[0].sha256 = 'A'.repeat(64);
  manifest.artifacts[0].mediaType = 'application/octet-stream';
  const result = validateRecoveryBundleManifest(manifest);
  assert.equal(result.valid, false);
  const errors = result.errors.join('\n');
  assert.match(errors, /role must be mongodb/);
  assert.match(errors, /not a safe bundle-relative path/);
  assert.match(errors, /bytes must be a positive safe integer/);
  assert.match(errors, /lowercase SHA-256 digest/);
  assert.match(errors, /mediaType must be application\/gzip/);
});

test('portable path validation rejects absolute, traversal, and platform-specific separators', () => {
  assert.equal(isSafeBundleRelativePath('artifacts/mongodb.archive.gz'), true);
  for (const unsafe of [
    '/artifacts/mongodb.archive.gz',
    '../artifacts/mongodb.archive.gz',
    'artifacts/../mongodb.archive.gz',
    'artifacts\\mongodb.archive.gz',
    'C:/artifacts/mongodb.archive.gz',
    'artifacts//mongodb.archive.gz',
  ]) assert.equal(isSafeBundleRelativePath(unsafe), false, unsafe);
});

test('restore proof and exclusions cannot be overstated or weakened', () => {
  assert.deepEqual(RECOVERY_BUNDLE_EXCLUSIONS, [
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
  const manifest = validManifest();
  manifest.restoreVerified = true;
  manifest.exclusions.pop();
  assert.throws(
    () => assertRecoveryBundleManifest(manifest),
    (error) => error.code === 'INVALID_RECOVERY_BUNDLE_MANIFEST'
      && /restoreVerified must be false/.test(error.message)
      && /exact v1 recovery exclusion list/.test(error.message)
  );
});

module.exports = { REVISION, validManifest };

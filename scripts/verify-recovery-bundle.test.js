'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
} = require('../shared/recoveryBundleContract');
const {
  MAX_MANIFEST_BYTES,
  parseArgs,
  verifyRecoveryBundle,
} = require('./verify-recovery-bundle');

const REVISION = '8a128176b44230cfef77e359e0c15b3a9df16eb1';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-recovery-bundle-'));
  const artifactsDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(artifactsDirectory);
  const artifactContents = [
    Buffer.alloc((2 * 1024 * 1024) + 17, 0x6d),
    Buffer.from('qdrant-collection-snapshot'),
    Buffer.from('bounded-product-configuration'),
  ];
  const artifacts = RECOVERY_ARTIFACTS.map((contract, index) => {
    const content = artifactContents[index];
    fs.writeFileSync(path.join(root, ...contract.path.split('/')), content);
    return {
      ...contract,
      bytes: content.length,
      sha256: digest(content),
    };
  });
  const manifest = {
    schema: RECOVERY_BUNDLE_SCHEMA,
    bundleId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-28T16:30:01.000Z',
    product: { name: PRODUCT_NAME, version: '0.1.1', profile: 'full', revision: REVISION },
    sourceImages: {
      core: `sha256:${'1'.repeat(64)}`,
      benchmark: `sha256:${'2'.repeat(64)}`,
      rag: `sha256:${'3'.repeat(64)}`,
      mongodb: `sha256:${'4'.repeat(64)}`,
      qdrant: `sha256:${'5'.repeat(64)}`,
    },
    dependencies: {
      mongodb: { serverVersion: '7.0.14', toolsVersion: '100.10.0', database: 'agentx' },
      qdrant: { serverVersion: '1.11.3', collection: 'agentx_embeddings' },
    },
    capture: {
      mode: CAPTURE_MODE,
      startedAt: '2026-08-28T16:30:00.000Z',
      completedAt: '2026-08-28T16:30:01.000Z',
      complete: true,
      observedStoppedWriters: [...OBSERVED_STOPPED_WRITERS],
      configSourceIds: [...PRODUCT_CONFIG_SOURCE_IDS],
    },
    compatibility: { mode: COMPATIBILITY_MODE, productRevision: REVISION },
    artifacts,
    restoreVerified: false,
    exclusions: [...RECOVERY_BUNDLE_EXCLUSIONS],
  };
  writeManifest(root, manifest);
  return { root, manifest };
}

function writeManifest(root, manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'manifest.json'), bytes);
  fs.writeFileSync(path.join(root, 'manifest.sha256'), `${digest(bytes)}\n`);
}

async function withBundle(run) {
  const bundle = createBundle();
  try {
    return await run(bundle);
  } finally {
    fs.rmSync(bundle.root, { recursive: true, force: true });
  }
}

test('streams and verifies the exact portable bundle without claiming a restore', async () => {
  await withBundle(async ({ root, manifest }) => {
    const result = await verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION });
    assert.equal(result.valid, true);
    assert.equal(result.bundleId, manifest.bundleId);
    assert.equal(result.productVersion, '0.1.1');
    assert.equal(result.productProfile, 'full');
    assert.equal(result.compatibility, COMPATIBILITY_MODE);
    assert.equal(result.captureComplete, true);
    assert.equal(result.restoreVerified, false);
    assert.deepEqual(result.dependencies, {
      mongodb: { serverVersion: '7.0.14', toolsVersion: '100.10.0' },
      qdrant: { serverVersion: '1.11.3' },
    });
    assert.doesNotMatch(JSON.stringify(result), /endpoint|mongodb:\/\/|qdrant:\/\//);
    assert.deepEqual(result.artifacts, manifest.artifacts);
  });
});

test('requires a directory path and an exact lowercase expected revision', async () => {
  await withBundle(async ({ root }) => {
    const filePath = path.join(root, 'manifest.json');
    await assert.rejects(
      verifyRecoveryBundle({ bundlePath: filePath, expectedProductRevision: REVISION }),
      (error) => error.code === 'RECOVERY_BUNDLE_NOT_DIRECTORY' && /must be a directory/.test(error.message)
    );
    await assert.rejects(
      verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION.toUpperCase() }),
      (error) => error.code === 'RECOVERY_BUNDLE_REVISION'
    );
  });
});

test('rejects missing and extra entries at both fixed directory levels', async (t) => {
  await t.test('missing top-level entry', async () => {
    await withBundle(async ({ root }) => {
      fs.rmSync(path.join(root, 'manifest.sha256'));
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /recovery bundle root must contain exactly/
      );
    });
  });
  await t.test('extra top-level entry', async () => {
    await withBundle(async ({ root }) => {
      fs.writeFileSync(path.join(root, 'notes.txt'), 'unexpected');
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /recovery bundle root must contain exactly/
      );
    });
  });
  await t.test('missing artifact entry', async () => {
    await withBundle(async ({ root }) => {
      fs.rmSync(path.join(root, 'artifacts', 'qdrant.collection.snapshot'));
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /artifacts directory must contain exactly/
      );
    });
  });
  await t.test('extra artifact entry', async () => {
    await withBundle(async ({ root }) => {
      fs.writeFileSync(path.join(root, 'artifacts', 'extra.archive'), 'unexpected');
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /artifacts directory must contain exactly/
      );
    });
  });
});

test('rejects a manifest larger than the bounded offline limit', async () => {
  await withBundle(async ({ root }) => {
    const oversized = Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20);
    fs.writeFileSync(path.join(root, 'manifest.json'), oversized);
    fs.writeFileSync(path.join(root, 'manifest.sha256'), `${digest(oversized)}\n`);
    await assert.rejects(
      verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
      /manifest\.json exceeds the 65536-byte limit/
    );
  });
});

test('rejects malformed and mismatched manifest checksums', async (t) => {
  await t.test('malformed checksum', async () => {
    await withBundle(async ({ root }) => {
      fs.writeFileSync(path.join(root, 'manifest.sha256'), 'A'.repeat(64));
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /must contain one lowercase SHA-256 digest/
      );
    });
  });
  await t.test('checksum mismatch', async () => {
    await withBundle(async ({ root }) => {
      fs.writeFileSync(path.join(root, 'manifest.sha256'), `${'0'.repeat(64)}\n`);
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /manifest\.json SHA-256 does not match/
      );
    });
  });
});

test('rejects malformed identity, dates, revision, and incomplete capture state', async () => {
  await withBundle(async ({ root, manifest }) => {
    manifest.bundleId = 'not-a-bundle-id';
    manifest.createdAt = 'not-a-date';
    manifest.product.revision = 'short';
    manifest.capture.complete = false;
    manifest.capture.observedStoppedWriters = ['core'];
    manifest.compatibility.productRevision = 'short';
    writeManifest(root, manifest);
    await assert.rejects(
      verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
      (error) => error.code === 'RECOVERY_BUNDLE_MANIFEST'
        && /lowercase UUID v4/.test(error.message)
        && /canonical UTC timestamp/.test(error.message)
        && /40-character lowercase Git revision/.test(error.message)
        && /capture\.complete must be true/.test(error.message)
    );
  });
});

test('rejects an exact-product-revision mismatch', async () => {
  await withBundle(async ({ root }) => {
    await assert.rejects(
      verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: '1'.repeat(40) }),
      (error) => error.code === 'RECOVERY_BUNDLE_REVISION' && /does not exactly match/.test(error.message)
    );
  });
});

test('rejects artifact byte-count and content-digest mismatches', async (t) => {
  await t.test('byte count mismatch', async () => {
    await withBundle(async ({ root, manifest }) => {
      manifest.artifacts[0].bytes += 1;
      writeManifest(root, manifest);
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /byte count does not match/
      );
    });
  });
  await t.test('content digest mismatch', async () => {
    await withBundle(async ({ root }) => {
      const artifactPath = path.join(root, 'artifacts', 'qdrant.collection.snapshot');
      const original = fs.readFileSync(artifactPath);
      fs.writeFileSync(artifactPath, Buffer.alloc(original.length, 0x78));
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /SHA-256 does not match/
      );
    });
  });
});

test('rejects non-regular artifact entries', async () => {
  await withBundle(async ({ root }) => {
    const artifactPath = path.join(root, 'artifacts', 'product-config.tar.gz');
    fs.rmSync(artifactPath);
    fs.mkdirSync(artifactPath);
    await assert.rejects(
      verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
      /must be a regular file/
    );
  });
});

test('rejects symbolic links or reparse points in the fixed topology', async (t) => {
  await withBundle(async ({ root }) => {
    const original = path.join(root, 'artifacts', 'qdrant.collection.snapshot');
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-recovery-link-target-'));
    const target = path.join(targetRoot, 'qdrant-target.snapshot');
    fs.copyFileSync(original, target);
    fs.rmSync(original);
    try {
      try {
        fs.symlinkSync(target, original, 'file');
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
          t.skip(`symbolic links are unavailable on this host: ${error.code}`);
          return;
        }
        throw error;
      }
      await assert.rejects(
        verifyRecoveryBundle({ bundlePath: root, expectedProductRevision: REVISION }),
        /must not be a symbolic link or reparse point/
      );
    } finally {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});

test('parses only the explicit verifier CLI arguments', () => {
  assert.deepEqual(
    parseArgs(['--bundle', 'bundle', '--product-revision', REVISION]),
    { bundlePath: 'bundle', expectedProductRevision: REVISION }
  );
  assert.throws(() => parseArgs(['--bundle', 'bundle']), /--product-revision is required/);
  assert.throws(() => parseArgs(['--other']), /unknown argument/);
});

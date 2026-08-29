'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MANIFEST_SCHEMA,
  RECEIPT_SCHEMA,
  SERVICES,
  assembleCandidateImageManifest,
  validateCandidateImageManifest,
} = require('./assemble-candidate-image-manifest');

const COMMIT = '8a128176b44230cfef77e359e0c15b3a9df16eb1';

function digest(service) {
  return `sha256:${String(SERVICES.indexOf(service) + 1).repeat(64)}`;
}

function receipt(service, overrides = {}) {
  const image = `ghcr.io/windriderqc/agentx-${service}`;
  const value = digest(service);
  return {
    schema: RECEIPT_SCHEMA,
    service,
    commit: COMMIT,
    image,
    digest: value,
    ref: `${image}@${value}`,
    ...overrides,
  };
}

function withReceipts(run, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-candidate-images-'));
  try {
    for (const service of SERVICES) {
      fs.writeFileSync(
        path.join(root, `${service}.json`),
        JSON.stringify(receipt(service, overrides[service])),
        'utf8'
      );
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('assembles a closed exact-commit candidate manifest from three receipts', () => {
  withReceipts((receiptsDir) => {
    const manifest = assembleCandidateImageManifest({ receiptsDir, commit: COMMIT });
    assert.equal(manifest.schema, MANIFEST_SCHEMA);
    assert.equal(manifest.commit, COMMIT);
    assert.deepEqual(Object.keys(manifest.images), SERVICES);
    assert.deepEqual(validateCandidateImageManifest(manifest, { expectedCommit: COMMIT }), []);
  });
});

test('rejects receipt commit drift and a noncanonical digest ref', () => {
  withReceipts((receiptsDir) => {
    assert.throws(
      () => assembleCandidateImageManifest({ receiptsDir, commit: COMMIT }),
      /benchmark immutable image receipt commit does not match/
    );
  }, { benchmark: { commit: 'a'.repeat(40) } });
  withReceipts((receiptsDir) => {
    assert.throws(
      () => assembleCandidateImageManifest({ receiptsDir, commit: COMMIT }),
      /rag immutable image receipt\.ref is not the canonical digest reference/
    );
  }, { rag: { ref: `ghcr.io/windriderqc/agentx-rag@sha256:${'f'.repeat(64)}` } });
});

test('rejects extra receipt files and extra manifest fields', () => {
  withReceipts((receiptsDir) => {
    fs.writeFileSync(path.join(receiptsDir, 'unexpected.json'), '{}', 'utf8');
    assert.throws(
      () => assembleCandidateImageManifest({ receiptsDir, commit: COMMIT }),
      /file set must be exactly/
    );
  });
  const manifest = {
    schema: MANIFEST_SCHEMA,
    commit: COMMIT,
    images: Object.fromEntries(SERVICES.map((service) => {
      const value = receipt(service);
      return [service, { image: value.image, digest: value.digest, ref: value.ref }];
    })),
    tag: 'latest',
  };
  assert.match(validateCandidateImageManifest(manifest).join('\n'), /shape is invalid/);
});

test('rejects an incomplete or incorrectly named service set', () => {
  const manifest = {
    schema: MANIFEST_SCHEMA,
    commit: COMMIT,
    images: { core: receipt('core') },
  };
  assert.match(validateCandidateImageManifest(manifest).join('\n'), /service set is not exact/);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SERVICES } = require('./verify-release-contract');
const { assembleReleaseImageManifest } = require('./assemble-release-image-manifest');

const COMMIT = '8a128176b44230cfef77e359e0c15b3a9df16eb1';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function receipts(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-release-images-'));
  for (const service of Object.keys(SERVICES)) {
    const receipt = {
      schemaVersion: 1,
      service,
      image: `ghcr.io/windriderqc/agentx-${service}`,
      digest: DIGEST,
      tag: 'v0.1.1',
      commit: COMMIT,
      ...(overrides[service] || {}),
    };
    fs.writeFileSync(path.join(root, `${service}.json`), JSON.stringify(receipt), 'utf8');
  }
  return root;
}

function withReceipts(run, overrides) {
  const root = receipts(overrides);
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('assembles the three immutable service refs into one release receipt', () => {
  withReceipts((receiptsDir) => {
    const manifest = assembleReleaseImageManifest({
      receiptsDir, tag: 'v0.1.1', commit: COMMIT,
    });
    assert.equal(manifest.version, '0.1.1');
    assert.deepEqual(Object.keys(manifest.images), ['core', 'benchmark', 'rag']);
    assert.equal(manifest.images.core.ref, `ghcr.io/windriderqc/agentx-core@${DIGEST}`);
  });
});

test('rejects a service receipt from another tag', () => {
  withReceipts((receiptsDir) => {
    assert.throws(
      () => assembleReleaseImageManifest({ receiptsDir, tag: 'v0.1.1', commit: COMMIT }),
      /benchmark receipt tag does not match/
    );
  }, { benchmark: { tag: 'v0.1.0' } });
});

test('rejects a service receipt from another commit', () => {
  withReceipts((receiptsDir) => {
    assert.throws(
      () => assembleReleaseImageManifest({ receiptsDir, tag: 'v0.1.1', commit: COMMIT }),
      /rag receipt commit does not match/
    );
  }, { rag: { commit: '1'.repeat(40) } });
});

test('rejects a malformed image digest', () => {
  withReceipts((receiptsDir) => {
    assert.throws(
      () => assembleReleaseImageManifest({ receiptsDir, tag: 'v0.1.1', commit: COMMIT }),
      /core receipt has an invalid image digest/
    );
  }, { core: { digest: 'sha256:not-a-digest' } });
});

test('rejects a missing service receipt', () => {
  withReceipts((receiptsDir) => {
    fs.rmSync(path.join(receiptsDir, 'rag.json'));
    assert.throws(
      () => assembleReleaseImageManifest({ receiptsDir, tag: 'v0.1.1', commit: COMMIT }),
      /rag\.json/
    );
  });
});

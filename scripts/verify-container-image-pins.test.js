'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  validateInventory,
  verifyContainerImagePins,
} = require('./verify-container-image-pins');

test('the repository pins every governed dependency and build image by exact digest', () => {
  const result = verifyContainerImagePins();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.governedDeclarations, 11);
  assert.deepEqual(Object.keys(result.images).sort(), ['mongodb', 'node-runtime', 'ollama', 'qdrant', 'recovery-helper']);
  for (const image of Object.values(result.images)) {
    assert.match(image.reference, /@sha256:[0-9a-f]{64}$/);
  }
});

test('inventory validation rejects moving, versionless, and malformed references', () => {
  const inventory = reference => ({
    schemaVersion: 1,
    images: { sample: { version: '1.0.0', reference } },
  });

  assert.notEqual(validateInventory(inventory('sample:latest@sha256:' + 'a'.repeat(64))).length, 0);
  assert.notEqual(validateInventory(inventory('sample:slim@sha256:' + 'a'.repeat(64))).length, 0);
  assert.notEqual(validateInventory(inventory('sample:1.0.0')).length, 0);
  assert.equal(validateInventory(inventory('sample:1.0.0@sha256:' + 'a'.repeat(64))).length, 0);
});

test('verification fails closed when a governed declaration drifts from its inventory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-image-pins-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docker'), { recursive: true });
    const inventory = {
      schemaVersion: 1,
      reviewedAt: '2026-08-28',
      images: {
        runtime: {
          version: '1.2.3',
          reference: `example/runtime:1.2.3@sha256:${'a'.repeat(64)}`,
        },
      },
    };
    fs.writeFileSync(
      path.join(root, 'docker', 'fixture.Dockerfile'),
      'FROM example/runtime:latest\n',
      'utf8'
    );

    assert.throws(
      () => verifyContainerImagePins({
        repoRoot: root,
        inventory,
        declarations: [{ file: 'docker/fixture.Dockerfile', kind: 'from', image: 'runtime', count: 1 }],
      }),
      error => error.code === 'CONTAINER_IMAGE_PIN_CONTRACT_FAILED'
        && /observed 0/.test(error.message)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

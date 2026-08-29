'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ASSERTION_KEYS,
  RECOVERY_DRILL_RECEIPT_SCHEMA,
  assertRecoveryDrillReceipt,
  validateRecoveryDrillReceipt,
} = require('./recoveryDrillReceiptContract');

function receiptFixture() {
  return {
    schema: RECOVERY_DRILL_RECEIPT_SCHEMA,
    receiptId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-28T18:30:00.000Z',
    outcome: 'passed',
    product: {
      version: '0.1.1',
      profile: 'full',
      revision: '8a128176b44230cfef77e359e0c15b3a9df16eb1',
    },
    topology: {
      sha256: '9'.repeat(64),
      services: 6,
      publishedPorts: 0,
      hostBindMounts: 0,
    },
    sourceImages: {
      core: `sha256:${'1'.repeat(64)}`,
      benchmark: `sha256:${'2'.repeat(64)}`,
      rag: `sha256:${'3'.repeat(64)}`,
      mongodb: `sha256:${'b'.repeat(64)}`,
      qdrant: `sha256:${'c'.repeat(64)}`,
    },
    bundle: {
      bundleId: '123e4567-e89b-42d3-a456-426614174001',
      manifestSha256: 'a'.repeat(64),
    },
    dependencies: {
      mongodb: {
        imageDigest: `sha256:${'b'.repeat(64)}`,
        serverVersion: '7.0.34',
        toolsVersion: '100.17.0',
      },
      qdrant: {
        imageDigest: `sha256:${'c'.repeat(64)}`,
        serverVersion: '1.18.1',
      },
      transportHelper: {
        imageDigest: `sha256:${'7'.repeat(64)}`,
        version: '20.20.2',
      },
    },
    measurements: {
      captureMs: 1200,
      corruptionGateMs: 800,
      restoreMs: 1100,
      totalMs: 4200,
    },
    state: {
      mongodb: {
        representativeRecords: 4,
        collections: 4,
        sourceSha256: 'd'.repeat(64),
        restoredSha256: 'd'.repeat(64),
      },
      qdrant: {
        representativeRecords: 3,
        points: 3,
        sourceSha256: 'e'.repeat(64),
        restoredSha256: 'e'.repeat(64),
      },
    },
    productProof: {
      identities: {
        core: {
          service: 'agentx-core',
          version: '0.1.1',
          profile: 'full',
          revision: '8a128176b44230cfef77e359e0c15b3a9df16eb1',
        },
        benchmark: {
          service: 'agentx-benchmark',
          version: '0.1.1',
          profile: 'full',
          revision: '8a128176b44230cfef77e359e0c15b3a9df16eb1',
        },
        rag: {
          service: 'agentx-rag',
          version: '0.1.1',
          profile: 'full',
          revision: '8a128176b44230cfef77e359e0c15b3a9df16eb1',
        },
      },
      journeys: { prompt: true, rag: true, benchmark: true, vector: true, browser: true },
      schemas: { mongodb: true, qdrant: true },
    },
    assertions: Object.fromEntries(ASSERTION_KEYS.map((key) => [key, true])),
    privacy: {
      containsAddresses: false,
      containsRawDocumentContent: false,
      containsSecrets: false,
    },
  };
}

test('accepts the exact v1 privacy-safe passed receipt', () => {
  const fixture = receiptFixture();
  assert.equal(validateRecoveryDrillReceipt(fixture).valid, true);
  assert.equal(assertRecoveryDrillReceipt(fixture), fixture);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /https?:\/\/|mongodb(?:\+srv)?:\/\/|localhost|127\.0\.0\.1/i);
  assert.doesNotMatch(serialized, /password|credential|bearer|private[_-]?key/i);
});

test('rejects missing, extra, or false assertions', () => {
  const missing = receiptFixture();
  delete missing.assertions.qdrantStateHashMatched;
  assert.match(validateRecoveryDrillReceipt(missing).errors.join('\n'), /missing keys/);

  const extra = receiptFixture();
  extra.assertions.unreviewedClaim = true;
  assert.match(validateRecoveryDrillReceipt(extra).errors.join('\n'), /unsupported keys/);

  const falseClaim = receiptFixture();
  falseClaim.assertions.corruptedBundleTargetUnchanged = false;
  assert.match(validateRecoveryDrillReceipt(falseClaim).errors.join('\n'), /must be true/);
});

test('rejects mismatched restored state hashes and non-exact image identity', () => {
  const fixture = receiptFixture();
  fixture.state.mongodb.restoredSha256 = 'f'.repeat(64);
  fixture.dependencies.qdrant.imageDigest = 'qdrant/qdrant:latest';
  const errors = validateRecoveryDrillReceipt(fixture).errors.join('\n');
  assert.match(errors, /source and restored SHA-256 digests must match/);
  assert.match(errors, /qdrant\.imageDigest must be a lowercase image digest/);
});

test('rejects address, content, or secret disclosure claims', () => {
  for (const key of ['containsAddresses', 'containsRawDocumentContent', 'containsSecrets']) {
    const fixture = receiptFixture();
    fixture.privacy[key] = true;
    assert.match(validateRecoveryDrillReceipt(fixture).errors.join('\n'), new RegExp(`${key} must be false`));
  }
});

test('binds all five source images, rendered topology, and exact restored product identity', () => {
  const missingImage = receiptFixture();
  delete missingImage.sourceImages.rag;
  assert.match(validateRecoveryDrillReceipt(missingImage).errors.join('\n'), /sourceImages is missing keys: rag/);

  const topology = receiptFixture();
  topology.topology.publishedPorts = 1;
  assert.match(validateRecoveryDrillReceipt(topology).errors.join('\n'), /publishedPorts must be 0/);

  const identity = receiptFixture();
  identity.productProof.identities.core.revision = 'f'.repeat(40);
  assert.match(validateRecoveryDrillReceipt(identity).errors.join('\n'), /must match receipt\.product\.revision/);

  const journey = receiptFixture();
  journey.productProof.journeys.browser = false;
  assert.match(validateRecoveryDrillReceipt(journey).errors.join('\n'), /journeys\.browser must be true/);
});

module.exports = { receiptFixture };

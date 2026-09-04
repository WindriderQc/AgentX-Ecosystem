'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RUNTIME_ARTIFACT_IDENTITY_CONTRACT,
  buildRuntimeArtifactReceipt,
  verifyRuntimeArtifactReceipt
} = require('./artifactIdentity');

const INPUT = Object.freeze({
  tag: 'ax/kidx-nestor:latest',
  hostId: 'household-gpu',
  hostUrl: 'http://ollama-household:11434/',
  digest: `sha256:${'a'.repeat(64)}`,
  artifactSize: 19_500_000_000,
  residentSize: 19_000_000_000,
  sizeVram: 19_000_000_000,
  contextLength: 32_768,
  runtimeVersion: '0.11.10'
});

test('builds one canonical server-owned live runtime artifact receipt', () => {
  const receipt = buildRuntimeArtifactReceipt(INPUT, {
    observedAt: '2026-09-04T18:00:00.000Z',
    freshnessMs: 30_000
  });

  assert.equal(receipt.contract, RUNTIME_ARTIFACT_IDENTITY_CONTRACT);
  assert.equal(receipt.model, 'ax/kidx-nestor');
  assert.equal(receipt.tag, 'ax/kidx-nestor:latest');
  assert.equal(receipt.hostUrl, 'http://ollama-household:11434');
  assert.equal(receipt.fullVram, true);
  assert.match(receipt.runtimeFingerprint, /^[a-f0-9]{64}$/);
  assert.match(receipt.receiptId, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.provenance, {
    authority: 'agentx-product-benchmark',
    mode: 'live_server_observation',
    tag: 'ollama:/api/tags',
    digest: 'ollama:/api/tags',
    artifactSize: 'ollama:/api/tags',
    residency: 'ollama:/api/ps',
    sizeVram: 'ollama:/api/ps',
    contextLength: 'ollama:/api/ps',
    runtimeVersion: 'ollama:/api/version'
  });
  assert.deepEqual(verifyRuntimeArtifactReceipt(receipt, {
    now: '2026-09-04T18:00:15.000Z'
  }), {
    valid: true,
    fresh: true,
    reasons: [],
    identity: receipt
  });
});

test('derives full-VRAM truth from the live resident sizes instead of trusting a caller flag', () => {
  const receipt = buildRuntimeArtifactReceipt({
    ...INPUT,
    sizeVram: 18_000_000_000,
    fullVram: true
  }, { observedAt: '2026-09-04T18:00:00.000Z' });

  assert.equal(receipt.fullVram, false);
});

test('canonicalizes the raw 64-hex Ollama tags digest with its sha256 algorithm', () => {
  const receipt = buildRuntimeArtifactReceipt({
    ...INPUT,
    digest: 'b'.repeat(64)
  }, { observedAt: '2026-09-04T18:00:00.000Z' });

  assert.equal(receipt.digest, `sha256:${'b'.repeat(64)}`);
});

test('fails closed on incomplete identity, stale evidence, and fingerprint drift', () => {
  assert.throws(
    () => buildRuntimeArtifactReceipt({ ...INPUT, contextLength: null }),
    /contextLength must be a positive safe integer/
  );

  const receipt = buildRuntimeArtifactReceipt(INPUT, {
    observedAt: '2026-09-04T18:00:00.000Z',
    freshnessMs: 30_000
  });
  assert.deepEqual(
    verifyRuntimeArtifactReceipt(receipt, { now: '2026-09-04T18:01:00.000Z' }).reasons,
    ['receipt_stale']
  );

  const altered = { ...receipt, contextLength: 65_536 };
  const verdict = verifyRuntimeArtifactReceipt(altered, { now: '2026-09-04T18:00:15.000Z' });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.includes('runtime_fingerprint_mismatch'));
  assert.ok(verdict.reasons.includes('receipt_id_mismatch'));
});

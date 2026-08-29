'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  EXPECTED_POLICY,
  LEGACY_IDENTITY_MODE,
  PREVIOUS_BASELINE_SCHEMA,
  baselineFromPolicy,
  loadLegacyReleasePolicy,
  previousReleaseBaselineTemplate,
  validateImmutablePreviousManifestBytes,
  validateLegacyReleasePolicy,
  validatePreviousManifestBytes,
  validatePreviousReleaseBaseline,
} = require('../upgrade-rollback-baseline');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'e2e', 'fixtures', 'upgrade-rollback-v0.1.1-images.json');
const WRAPPER = path.join(
  ROOT,
  'e2e',
  'fixtures',
  'upgrade-rollback-v0.1.1-previous-release-baseline.json'
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('committed policy is exactly one immutable v0.1.1 bootstrap entry', () => {
  const policy = loadLegacyReleasePolicy();
  const baseline = baselineFromPolicy(policy);
  assert.deepEqual(validateLegacyReleasePolicy(policy), []);
  assert.equal(policy.baselines.length, 1);
  assert.equal(baseline.tag, 'v0.1.1');
  assert.equal(baseline.version, '0.1.1');
  assert.equal(baseline.commit, '6888750556cecc5277bf36b91f64a27806ea42a5');
  assert.equal(baseline.manifestSha256, '9a6d1b84fec83bd6a42d2a79852d3ac3e4e17ab4b70b5bf7c59cdef350e4912a');
  assert.equal(baseline.profile, 'demo');
  assert.equal(baseline.oci.source, 'https://github.com/WindriderQc/AgentX-Ecosystem');
  assert.equal(baseline.oci.version, 'v0.1.1');
});

test('rejects a second entry, wildcard, or any policy identity change', () => {
  const second = clone(EXPECTED_POLICY);
  second.baselines.push(clone(second.baselines[0]));
  assert.match(validateLegacyReleasePolicy(second).join('\n'), /exact one-entry/);

  const wildcard = clone(EXPECTED_POLICY);
  wildcard.baselines[0].services.core.ref = '*';
  assert.match(validateLegacyReleasePolicy(wildcard).join('\n'), /exact one-entry/);

  const changedSource = clone(EXPECTED_POLICY);
  changedSource.baselines[0].oci.source = 'https://example.invalid/repository';
  assert.match(validateLegacyReleasePolicy(changedSource).join('\n'), /exact one-entry/);
});

test('binds exact historical manifest bytes as well as closed JSON content', () => {
  const policy = loadLegacyReleasePolicy();
  const bytes = fs.readFileSync(MANIFEST);
  assert.equal(bytes.length, 1029);
  const exact = validatePreviousManifestBytes(bytes, policy);
  assert.deepEqual(exact.errors, []);
  assert.equal(exact.manifestSha256, baselineFromPolicy(policy).manifestSha256);

  const whitespaceChanged = validatePreviousManifestBytes(Buffer.concat([bytes, Buffer.from(' ')]), policy);
  assert.match(whitespaceChanged.errors.join('\n'), /byte hash is not exact/);

  const contentChanged = Buffer.from(bytes.toString('utf8').replace('agentx-core', 'agentx-c0re'));
  const changed = validatePreviousManifestBytes(contentChanged, policy);
  assert.match(changed.errors.join('\n'), /byte hash is not exact/);
  assert.match(changed.errors.join('\n'), /content is not the exact/);
});

test('generic strict manifests are closed and bound to expected refs and revision', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const expectedImages = Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [
    service,
    { ref: manifest.images[service].ref, digest: manifest.images[service].digest },
  ]));
  assert.deepEqual(validateImmutablePreviousManifestBytes(fs.readFileSync(MANIFEST), {
    expectedRevision: manifest.commit,
    expectedImages,
  }).errors, []);

  manifest.fallback = '*';
  const generic = validateImmutablePreviousManifestBytes(Buffer.from(JSON.stringify(manifest)), {
    expectedRevision: manifest.commit,
    expectedImages,
  });
  assert.match(generic.errors.join('\n'), /metadata shape or identity is invalid/);
});

test('wrapper contract is exact, closed, and reusable by lifecycle verification', () => {
  const policy = loadLegacyReleasePolicy();
  const expected = previousReleaseBaselineTemplate(policy);
  const committed = JSON.parse(fs.readFileSync(WRAPPER, 'utf8'));
  assert.equal(expected.schema, PREVIOUS_BASELINE_SCHEMA);
  assert.equal(expected.identityEvidenceMode, LEGACY_IDENTITY_MODE);
  assert.deepEqual(committed, expected);
  assert.deepEqual(validatePreviousReleaseBaseline(committed, policy), []);

  const extra = clone(committed);
  extra.fallback = 'in-band-health';
  assert.match(validatePreviousReleaseBaseline(extra, policy).join('\n'), /exact closed/);
  const changedLabel = clone(committed);
  changedLabel.ociLabels.rag.revision = '0'.repeat(40);
  assert.match(validatePreviousReleaseBaseline(changedLabel, policy).join('\n'), /exact closed/);
});

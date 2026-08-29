'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PRODUCT_SERVICES,
  loadLegacyReleasePolicy,
  previousReleaseBaselineTemplate,
} = require('../e2e/upgrade-rollback-baseline');
const {
  assemblePreviousReleaseBaseline,
  inspectAndValidateOciEvidence,
  repoDigestsFromInspect,
} = require('./assemble-previous-release-baseline');

const FIXTURE = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'upgrade-rollback-v0.1.1-images.json');

function exactInspect(template, overrides = {}) {
  return (ref, field) => {
    const service = PRODUCT_SERVICES.find((name) => template.images[name].ref === ref);
    const value = overrides[`${service}.${field}`];
    if (value != null) return value;
    if (field === 'repoDigests') return JSON.stringify([ref]);
    return template.ociLabels[service][field];
  };
}

test('assembles the exact legacy wrapper only after raw asset and OCI evidence validation', () => {
  const policy = loadLegacyReleasePolicy();
  const expected = previousReleaseBaselineTemplate(policy);
  const pulled = [];
  const actual = assemblePreviousReleaseBaseline({
    manifestPath: FIXTURE,
    expectedTag: 'v0.1.1',
    inspect: exactInspect(expected),
    pull: ref => pulled.push(ref),
  });
  assert.deepEqual(actual, expected);
  assert.deepEqual(pulled, PRODUCT_SERVICES.map(service => expected.images[service].ref));
  assert.equal(actual.identityEvidenceMode, 'legacy-oci-bound');
  assert.equal(actual.manifestSha256, '9a6d1b84fec83bd6a42d2a79852d3ac3e4e17ab4b70b5bf7c59cdef350e4912a');
});

test('fails closed before OCI inspection when an exact image pull fails', () => {
  const expected = previousReleaseBaselineTemplate(loadLegacyReleasePolicy());
  let inspected = false;
  assert.throws(() => assemblePreviousReleaseBaseline({
    manifestPath: FIXTURE,
    expectedTag: 'v0.1.1',
    pull: () => { throw new Error('pull failed'); },
    inspect: () => { inspected = true; return ''; },
  }), /pull failed/);
  assert.equal(inspected, false);
  assert.equal(expected.identityEvidenceMode, 'legacy-oci-bound');
});

test('rejects byte drift, selected-tag drift, and any generic historical fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-legacy-manifest-'));
  const changed = path.join(root, 'changed.json');
  try {
    fs.writeFileSync(changed, `${fs.readFileSync(FIXTURE, 'utf8')}\n`, 'utf8');
    assert.throws(() => assemblePreviousReleaseBaseline({
      manifestPath: changed,
      expectedTag: 'v0.1.1',
      inspect: () => '',
    }), /byte hash is not exact/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const expected = previousReleaseBaselineTemplate(loadLegacyReleasePolicy());
  assert.throws(() => assemblePreviousReleaseBaseline({
    manifestPath: FIXTURE,
    expectedTag: 'v0.1.0',
    inspect: exactInspect(expected),
  }), /tag does not match/);
});

test('rejects RepoDigest and each OCI label mismatch independently', () => {
  const expected = previousReleaseBaselineTemplate(loadLegacyReleasePolicy());
  assert.throws(() => inspectAndValidateOciEvidence(expected, exactInspect(expected, {
    'core.repoDigests': JSON.stringify(['ghcr.io/windriderqc/agentx-core@sha256:' + '0'.repeat(64)]),
  })), /exact allowlisted RepoDigest/);
  for (const field of ['revision', 'version', 'source']) {
    assert.throws(() => inspectAndValidateOciEvidence(expected, exactInspect(expected, {
      [`benchmark.${field}`]: 'wrong',
    })), new RegExp(`benchmark pulled image .*${field}.*label is not exact`));
  }
});

test('rejects unbounded or malformed RepoDigests inspection output', () => {
  assert.throws(() => repoDigestsFromInspect('not-json', 'rag'), /not valid JSON/);
  assert.throws(() => repoDigestsFromInspect('[]', 'rag'), /not a bounded string array/);
  assert.throws(
    () => repoDigestsFromInspect(JSON.stringify(Array.from({ length: 33 }, () => 'x')), 'rag'),
    /not a bounded string array/
  );
});

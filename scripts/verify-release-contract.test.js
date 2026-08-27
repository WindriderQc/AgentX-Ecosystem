'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SERVICES, verifyReleaseContract } = require('./verify-release-contract');

function fixture(version = '0.1.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-release-contract-'));
  for (const [service, name] of Object.entries(SERVICES)) {
    const serviceRoot = path.join(root, service);
    fs.mkdirSync(serviceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(serviceRoot, 'package.json'),
      JSON.stringify({ name, version }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(serviceRoot, 'package-lock.json'),
      JSON.stringify({ name, version, lockfileVersion: 3, packages: { '': { name, version } } }),
      'utf8'
    );
  }
  return root;
}

function releaseNotes(root, tag) {
  const notesRoot = path.join(root, 'docs', 'releases');
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.writeFileSync(path.join(notesRoot, `${tag}.md`), `# Agent X Ecosystem ${tag}\n`, 'utf8');
}

function withFixture(run, version) {
  const root = fixture(version);
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts matching package and lockfile versions before release', () => {
  withFixture((root) => {
    const receipt = verifyReleaseContract({ root });
    assert.equal(receipt.version, '0.1.1');
    assert.equal(receipt.tag, null);
  });
});

test('accepts an exact stable tag with tag-specific release notes', () => {
  withFixture((root) => {
    releaseNotes(root, 'v0.1.1');
    const receipt = verifyReleaseContract({ root, tag: 'v0.1.1' });
    assert.equal(receipt.tag, 'v0.1.1');
  });
});

test('accepts an exact prerelease tag', () => {
  withFixture((root) => {
    releaseNotes(root, 'v0.2.0-rc.1');
    const receipt = verifyReleaseContract({ root, tag: 'v0.2.0-rc.1' });
    assert.equal(receipt.version, '0.2.0-rc.1');
  }, '0.2.0-rc.1');
});

test('rejects a malformed release tag', () => {
  withFixture((root) => {
    assert.throws(
      () => verifyReleaseContract({ root, tag: 'release-0.1.1' }),
      /exact semver with a v prefix/
    );
  });
});

test('rejects service version drift', () => {
  withFixture((root) => {
    const manifestPath = path.join(root, 'rag', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '0.1.2';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    assert.throws(() => verifyReleaseContract({ root }), /versions differ/);
  });
});

test('rejects package-lock root drift', () => {
  withFixture((root) => {
    const lockPath = path.join(root, 'benchmark', 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages[''].version = '0.1.0';
    fs.writeFileSync(lockPath, JSON.stringify(lock), 'utf8');
    assert.throws(() => verifyReleaseContract({ root }), /root package version/);
  });
});

test('requires release notes for the exact tag', () => {
  withFixture((root) => {
    assert.throws(
      () => verifyReleaseContract({ root, tag: 'v0.1.1' }),
      /release notes are missing/
    );
  });
});

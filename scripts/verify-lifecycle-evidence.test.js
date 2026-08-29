'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createUpgradeRollbackReceipt } = require('../e2e/upgrade-rollback-receipt');
const {
  loadLegacyReleasePolicy,
  previousReleaseBaselineTemplate,
  receiptBaselineBinding,
} = require('../e2e/upgrade-rollback-baseline');
const { ASSERTION_KEYS, validateRecoveryDrillReceipt } = require('../shared/recoveryDrillReceiptContract');
const { MANIFEST_SCHEMA, SERVICES } = require('./assemble-candidate-image-manifest');
const {
  loadDependencyPins,
  referenceFingerprint,
  readPreviousReleaseEvidence,
  resolveArtifactDirectory,
  validateLifecycleEvidence,
  validateStableReleaseManifest,
} = require('./verify-lifecycle-evidence');

const PREVIOUS_REVISION = 'a'.repeat(40);
const CANDIDATE_REVISION = 'b'.repeat(40);
const VERSION = '0.1.1';
const CANDIDATE_DIGESTS = Object.freeze({
  core: `sha256:${'1'.repeat(64)}`,
  benchmark: `sha256:${'2'.repeat(64)}`,
  rag: `sha256:${'3'.repeat(64)}`,
});
const PREVIOUS_DIGESTS = Object.freeze({
  core: `sha256:${'4'.repeat(64)}`,
  benchmark: `sha256:${'5'.repeat(64)}`,
  rag: `sha256:${'6'.repeat(64)}`,
});
const LEGACY_FIXTURE = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'upgrade-rollback-v0.1.1-images.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function imageSet(digests) {
  return Object.fromEntries(SERVICES.map((service) => {
    const image = `ghcr.io/windriderqc/agentx-${service}`;
    return [service, { image, digest: digests[service], ref: `${image}@${digests[service]}` }];
  }));
}

function candidateManifest() {
  return { schema: MANIFEST_SCHEMA, commit: CANDIDATE_REVISION, images: imageSet(CANDIDATE_DIGESTS) };
}

function previousManifest() {
  return {
    schemaVersion: 1,
    product: 'Agent X Ecosystem',
    version: '0.1.0',
    tag: 'v0.1.0',
    commit: PREVIOUS_REVISION,
    images: imageSet(PREVIOUS_DIGESTS),
  };
}

function identities(revision, version, profile = 'demo') {
  return Object.fromEntries(SERVICES.map((service) => [service, {
    service: `agentx-${service}`,
    version,
    profile,
    revision,
  }]));
}

function upgradeIdentities(revision, version, manifestBindingVerified) {
  return Object.fromEntries(SERVICES.map((service) => [service, {
    mode: 'in-band-health',
    service: `agentx-${service}`,
    version,
    profile: 'demo',
    revision,
    fieldSources: {
      service: 'live-health',
      version: 'live-health',
      profile: 'live-health',
      revision: 'live-health',
    },
    evidence: {
      httpStatus: 200,
      healthyStatusVerified: true,
      serviceHealthVerified: true,
      completeInBandIdentity: true,
      runtimeDigestVerified: true,
      renderedProfileVerified: true,
      runtimeProfileVerified: true,
      ociRevisionVerified: null,
      ociVersionVerified: null,
      ociSourceVerified: null,
      packagedVersionVerified: null,
      manifestBindingVerified,
    },
  }]));
}

function phase(revision, version, imageDigests, manifestBindingVerified) {
  return {
    imageDigests,
    imageSetVerified: true,
    identities: upgradeIdentities(revision, version, manifestBindingVerified),
    identityConsistent: true,
    expectedRevisionVerified: true,
    journeys: {
      coreState: { passed: true, records: 1 },
      benchmarkState: { passed: true, records: 1 },
      ragState: { passed: true, records: 1, chunks: 1 },
      vectorState: { passed: true, records: 1 },
    },
    schemas: {
      fixtureSchemaVersion: 1,
      mongo: { passed: true, records: 2 },
      qdrant: { passed: true, records: 1, vectorSize: 4 },
    },
    state: {
      mongoFingerprint: '7'.repeat(64),
      qdrantFingerprint: '8'.repeat(64),
      combinedFingerprint: '9'.repeat(64),
    },
  };
}

function upgradeReceipt(pins) {
  const candidate = candidateManifest();
  const previous = previousManifest();
  return createUpgradeRollbackReceipt({
    generatedAt: '2026-08-28T21:00:00.000Z',
    scenarioHash: '0'.repeat(12),
    expectedRevisions: { previous: PREVIOUS_REVISION, candidate: CANDIDATE_REVISION },
    previousRelease: {
      tag: previous.tag,
      version: previous.version,
      commit: previous.commit,
      manifestSha256: 'e'.repeat(64),
      profile: 'demo',
      identityEvidenceMode: 'in-band-health',
    },
    legacyBaseline: null,
    images: {
      previous: PREVIOUS_DIGESTS,
      candidate: CANDIDATE_DIGESTS,
      dependencies: { mongo: pins.mongo.digest, qdrant: pins.qdrant.digest },
      referenceFingerprints: {
        previous: Object.fromEntries(SERVICES.map((service) => [
          service, referenceFingerprint(previous.images[service].ref),
        ])),
        candidate: Object.fromEntries(SERVICES.map((service) => [
          service, referenceFingerprint(candidate.images[service].ref),
        ])),
        dependencies: { mongo: pins.mongo.fingerprint, qdrant: pins.qdrant.fingerprint },
      },
    },
    topology: {
      composeConfigHashes: { previous: 'c'.repeat(64), candidate: 'd'.repeat(64) },
      renderedVerified: true,
      runtimeVerified: true,
      serviceCount: 5,
      internalNetworkCount: 1,
      publishedPortCount: 0,
      bindMountCount: 0,
      persistentVolumeCount: 3,
      dataContainersStable: true,
    },
    phases: {
      before: phase(PREVIOUS_REVISION, '0.1.0', PREVIOUS_DIGESTS, true),
      upgraded: phase(CANDIDATE_REVISION, VERSION, CANDIDATE_DIGESTS, null),
      rolledBack: phase(PREVIOUS_REVISION, '0.1.0', PREVIOUS_DIGESTS, true),
    },
    cleanup: { verified: true, containers: 0, networks: 0, volumes: 0 },
  });
}

function recoveryReceipt(pins) {
  return {
    schema: 'agentx.recovery-drill-receipt/v1',
    receiptId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-28T21:05:00.000Z',
    outcome: 'passed',
    product: { version: VERSION, profile: 'full', revision: CANDIDATE_REVISION },
    topology: { sha256: 'e'.repeat(64), services: 6, publishedPorts: 0, hostBindMounts: 0 },
    sourceImages: {
      ...CANDIDATE_DIGESTS,
      mongodb: pins.mongo.digest,
      qdrant: pins.qdrant.digest,
    },
    bundle: {
      bundleId: '123e4567-e89b-42d3-a456-426614174001',
      manifestSha256: 'f'.repeat(64),
    },
    dependencies: {
      mongodb: { imageDigest: pins.mongo.digest, serverVersion: pins.mongo.version, toolsVersion: '100.17.0' },
      qdrant: { imageDigest: pins.qdrant.digest, serverVersion: pins.qdrant.version },
      transportHelper: { imageDigest: pins.transportHelper.digest, version: pins.transportHelper.version },
    },
    measurements: { captureMs: 10, corruptionGateMs: 10, restoreMs: 10, totalMs: 40 },
    state: {
      mongodb: { representativeRecords: 2, collections: 2, sourceSha256: '1'.repeat(64), restoredSha256: '1'.repeat(64) },
      qdrant: { representativeRecords: 1, points: 1, sourceSha256: '2'.repeat(64), restoredSha256: '2'.repeat(64) },
    },
    productProof: {
      identities: identities(CANDIDATE_REVISION, VERSION, 'full'),
      journeys: { prompt: true, rag: true, benchmark: true, vector: true, browser: true },
      schemas: { mongodb: true, qdrant: true },
    },
    assertions: Object.fromEntries(ASSERTION_KEYS.map((key) => [key, true])),
    privacy: { containsAddresses: false, containsRawDocumentContent: false, containsSecrets: false },
  };
}

function legacyPhase(revision, version, imageDigests) {
  const value = phase(revision, version, imageDigests, true);
  value.identities = Object.fromEntries(SERVICES.map((service) => [service, {
    ...value.identities[service],
    mode: 'legacy-oci-bound',
    fieldSources: {
      service: 'live-health',
      version: 'packaged-package-json',
      profile: 'rendered-runtime-profile',
      revision: 'oci-revision-label',
    },
    evidence: {
      ...value.identities[service].evidence,
      completeInBandIdentity: false,
      ociRevisionVerified: true,
      ociVersionVerified: true,
      ociSourceVerified: true,
      packagedVersionVerified: true,
    },
  }]));
  return value;
}

function legacyUpgradeReceipt(pins) {
  const policy = loadLegacyReleasePolicy();
  const wrapper = previousReleaseBaselineTemplate(policy);
  const binding = receiptBaselineBinding(policy);
  const previousDigests = Object.fromEntries(SERVICES.map((service) => [
    service, wrapper.images[service].digest,
  ]));
  return createUpgradeRollbackReceipt({
    generatedAt: '2026-08-28T21:00:00.000Z',
    scenarioHash: '0'.repeat(12),
    expectedRevisions: { previous: wrapper.commit, candidate: CANDIDATE_REVISION },
    previousRelease: {
      ...binding,
      identityEvidenceMode: 'legacy-oci-bound',
    },
    legacyBaseline: binding,
    images: {
      previous: previousDigests,
      candidate: CANDIDATE_DIGESTS,
      dependencies: { mongo: pins.mongo.digest, qdrant: pins.qdrant.digest },
      referenceFingerprints: {
        previous: Object.fromEntries(SERVICES.map((service) => [
          service, referenceFingerprint(wrapper.images[service].ref),
        ])),
        candidate: Object.fromEntries(SERVICES.map((service) => [
          service, referenceFingerprint(candidateManifest().images[service].ref),
        ])),
        dependencies: { mongo: pins.mongo.fingerprint, qdrant: pins.qdrant.fingerprint },
      },
    },
    topology: {
      composeConfigHashes: { previous: 'c'.repeat(64), candidate: 'd'.repeat(64) },
      renderedVerified: true,
      runtimeVerified: true,
      serviceCount: 5,
      internalNetworkCount: 1,
      publishedPortCount: 0,
      bindMountCount: 0,
      persistentVolumeCount: 3,
      dataContainersStable: true,
    },
    phases: {
      before: legacyPhase(wrapper.commit, wrapper.version, previousDigests),
      upgraded: phase(CANDIDATE_REVISION, VERSION, CANDIDATE_DIGESTS, null),
      rolledBack: legacyPhase(wrapper.commit, wrapper.version, previousDigests),
    },
    cleanup: { verified: true, containers: 0, networks: 0, volumes: 0 },
  });
}

test('accepts two distinct manifests and independently valid receipts bound to one candidate', () => {
  const pins = loadDependencyPins();
  const recovery = recoveryReceipt(pins);
  assert.deepEqual(validateRecoveryDrillReceipt(recovery), { valid: true, errors: [] });
  assert.deepEqual(validateLifecycleEvidence({
    candidate: candidateManifest(),
    previous: previousManifest(),
    previousManifestSha256: 'e'.repeat(64),
    previousIdentityEvidenceMode: 'in-band-health',
    upgrade: upgradeReceipt(pins),
    recovery,
    expectedCandidateRevision: CANDIDATE_REVISION,
    expectedPreviousRevision: PREVIOUS_REVISION,
    pins,
  }), []);
});

test('rebinds the one-time legacy receipt to the exact attached bytes, policy, wrapper, and refs', () => {
  const pins = loadDependencyPins();
  const previousEvidence = readPreviousReleaseEvidence(LEGACY_FIXTURE, { expectedTag: 'v0.1.1' });
  const wrapper = previousReleaseBaselineTemplate(loadLegacyReleasePolicy());
  const receipt = legacyUpgradeReceipt(pins);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.evidenceClass, 'release-bound-bootstrap');
  assert.match(validateLifecycleEvidence({
    candidate: candidateManifest(),
    previous: previousEvidence.manifest,
    previousManifestSha256: previousEvidence.manifestSha256,
    previousIdentityEvidenceMode: previousEvidence.identityEvidenceMode,
    upgrade: receipt,
    expectedCandidateRevision: CANDIDATE_REVISION,
    expectedPreviousRevision: wrapper.commit,
    expectedPreviousTag: wrapper.tag,
    pins,
  }).join('\n'), /requires the normalized previous release baseline wrapper/);
  assert.deepEqual(validateLifecycleEvidence({
    candidate: candidateManifest(),
    previous: previousEvidence.manifest,
    previousManifestSha256: previousEvidence.manifestSha256,
    previousIdentityEvidenceMode: previousEvidence.identityEvidenceMode,
    previousBaseline: wrapper,
    upgrade: receipt,
    expectedCandidateRevision: CANDIDATE_REVISION,
    expectedPreviousRevision: wrapper.commit,
    expectedPreviousTag: wrapper.tag,
    pins,
  }), []);

  const drifted = clone(receipt);
  drifted.previousRelease.manifestSha256 = '0'.repeat(64);
  assert.match(validateLifecycleEvidence({
    candidate: candidateManifest(),
    previous: previousEvidence.manifest,
    previousManifestSha256: previousEvidence.manifestSha256,
    previousIdentityEvidenceMode: previousEvidence.identityEvidenceMode,
    upgrade: drifted,
    expectedCandidateRevision: CANDIDATE_REVISION,
    pins,
  }).join('\n'), /previous release binding does not match the attached manifest/);
});

test('keeps generic previous releases on strict in-band health and forbids a legacy wrapper', () => {
  const pins = loadDependencyPins();
  const candidate = candidateManifest();
  const previous = previousManifest();
  const upgrade = upgradeReceipt(pins);
  assert.deepEqual(validateLifecycleEvidence({
    candidate,
    previous,
    previousManifestSha256: 'e'.repeat(64),
    previousIdentityEvidenceMode: 'in-band-health',
    upgrade,
    expectedCandidateRevision: CANDIDATE_REVISION,
    expectedPreviousRevision: PREVIOUS_REVISION,
    pins,
  }), []);
  const errors = validateLifecycleEvidence({
    candidate,
    previous,
    previousManifestSha256: 'e'.repeat(64),
    previousIdentityEvidenceMode: 'in-band-health',
    previousBaseline: previousReleaseBaselineTemplate(loadLegacyReleasePolicy()),
    upgrade,
    expectedCandidateRevision: CANDIDATE_REVISION,
    expectedPreviousRevision: PREVIOUS_REVISION,
    pins,
  }).join('\n');
  assert.match(errors, /baseline wrapper is allowed only for legacy-oci-bound evidence/);
});

test('fails closed on candidate digest drift in either independent receipt', () => {
  const pins = loadDependencyPins();
  const upgrade = clone(upgradeReceipt(pins));
  upgrade.images.candidate.core = `sha256:${'f'.repeat(64)}`;
  let errors = validateLifecycleEvidence({
    candidate: candidateManifest(), upgrade, expectedCandidateRevision: CANDIDATE_REVISION, pins,
  }).join('\n');
  assert.match(errors, /upgrade receipt candidate core digest does not match/);

  const recovery = recoveryReceipt(pins);
  recovery.sourceImages.rag = `sha256:${'f'.repeat(64)}`;
  errors = validateLifecycleEvidence({
    candidate: candidateManifest(), recovery, expectedCandidateRevision: CANDIDATE_REVISION, pins,
  }).join('\n');
  assert.match(errors, /recovery receipt rag digest does not match/);
});

test('requires distinct previous and candidate revisions and exact stable manifest shape', () => {
  const same = previousManifest();
  same.commit = CANDIDATE_REVISION;
  assert.match(validateStableReleaseManifest(same, { candidateRevision: CANDIDATE_REVISION }).join('\n'), /must be distinct/);
  const extra = previousManifest();
  extra.latest = true;
  assert.match(validateStableReleaseManifest(extra).join('\n'), /shape is invalid/);
  assert.match(
    validateStableReleaseManifest(previousManifest(), { expectedTag: 'v0.0.9' }).join('\n'),
    /does not match the selected GitHub release/
  );
});

test('binds both receipt dependency sets to the reviewed pin inventory', () => {
  const pins = loadDependencyPins();
  const upgrade = clone(upgradeReceipt(pins));
  upgrade.images.dependencies.mongo = `sha256:${'0'.repeat(64)}`;
  let errors = validateLifecycleEvidence({
    candidate: candidateManifest(), upgrade, expectedCandidateRevision: CANDIDATE_REVISION, pins,
  }).join('\n');
  assert.match(errors, /mongo digest does not match config\/container-image-pins\.json/);

  const recovery = recoveryReceipt(pins);
  recovery.dependencies.transportHelper.imageDigest = `sha256:${'0'.repeat(64)}`;
  errors = validateLifecycleEvidence({
    candidate: candidateManifest(), recovery, expectedCandidateRevision: CANDIDATE_REVISION, pins,
  }).join('\n');
  assert.match(errors, /transportHelper digest does not match config\/container-image-pins\.json/);

  for (const [dependency, field] of [
    ['mongodb', 'serverVersion'],
    ['qdrant', 'serverVersion'],
    ['transportHelper', 'version'],
  ]) {
    const versionDrift = recoveryReceipt(pins);
    versionDrift.dependencies[dependency][field] = '99.99.99';
    errors = validateLifecycleEvidence({
      candidate: candidateManifest(),
      recovery: versionDrift,
      expectedCandidateRevision: CANDIDATE_REVISION,
      pins,
    }).join('\n');
    assert.match(errors, new RegExp(`${dependency} version does not match config/container-image-pins\\.json`));
  }
});

test('artifact directory validation rejects extra or renamed content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-lifecycle-artifact-'));
  try {
    fs.writeFileSync(path.join(root, 'candidate-image-manifest.json'), '{}', 'utf8');
    assert.equal(resolveArtifactDirectory(root, 'candidate'), path.join(root, 'candidate-image-manifest.json'));
    fs.writeFileSync(path.join(root, 'unexpected.txt'), 'x', 'utf8');
    assert.throws(() => resolveArtifactDirectory(root, 'candidate'), /must contain exactly/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed candidate evidence fails closed without bypassing receipt validation', () => {
  const pins = loadDependencyPins();
  const malformed = { schema: MANIFEST_SCHEMA, commit: CANDIDATE_REVISION, images: {} };
  const receipt = clone(upgradeReceipt(pins));
  receipt.status = 'not-a-status';
  const errors = validateLifecycleEvidence({
    candidate: malformed,
    upgrade: receipt,
    expectedCandidateRevision: CANDIDATE_REVISION,
    pins,
  }).join('\n');
  assert.match(errors, /candidate image manifest service set is not exact/);
  assert.match(errors, /upgrade receipt: status is invalid/);
});

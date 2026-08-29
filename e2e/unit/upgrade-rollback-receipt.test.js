'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  ASSERTION_IDS,
  BOOTSTRAP_BASELINE,
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  createUpgradeRollbackReceipt,
  validateUpgradeRollbackReceipt,
} = require('../upgrade-rollback-receipt');
const {
  EXPECTED_POLICY,
  LEGACY_IDENTITY_MODE,
  baselineFromPolicy,
} = require('../upgrade-rollback-baseline');

const POLICY = baselineFromPolicy(EXPECTED_POLICY);
const PREVIOUS_REVISION = 'a'.repeat(40);
const CANDIDATE_REVISION = 'b'.repeat(40);
const MODERN_DIGESTS = Object.freeze({
  core: `sha256:${'c'.repeat(64)}`,
  benchmark: `sha256:${'d'.repeat(64)}`,
  rag: `sha256:${'e'.repeat(64)}`,
});
const BOOTSTRAP_DIGESTS = Object.freeze(Object.fromEntries(
  ['core', 'benchmark', 'rag'].map((service) => [service, POLICY.services[service].digest])
));

function refFingerprint(ref) {
  return crypto.createHash('sha256').update(ref).digest('hex');
}

function identity(service, revision, version, mode, { manifestBinding, supplemented = false } = {}) {
  const legacy = mode === LEGACY_IDENTITY_MODE;
  return {
    mode,
    service: `agentx-${service}`,
    version,
    profile: 'demo',
    revision,
    fieldSources: {
      service: 'live-health',
      version: legacy && supplemented ? 'packaged-package-json' : 'live-health',
      profile: legacy && supplemented ? 'rendered-runtime-profile' : 'live-health',
      revision: legacy && supplemented ? 'oci-revision-label' : 'live-health',
    },
    evidence: {
      httpStatus: 200,
      healthyStatusVerified: true,
      serviceHealthVerified: true,
      completeInBandIdentity: !supplemented,
      runtimeDigestVerified: true,
      renderedProfileVerified: true,
      runtimeProfileVerified: true,
      ociRevisionVerified: legacy ? true : null,
      ociVersionVerified: legacy ? true : null,
      ociSourceVerified: legacy ? true : null,
      packagedVersionVerified: legacy ? true : null,
      manifestBindingVerified: manifestBinding,
    },
  };
}

function phase(revision, version, imageDigests, mode, {
  fingerprint = 'f'.repeat(64),
  manifestBinding = true,
  supplemented = false,
} = {}) {
  return {
    imageDigests,
    imageSetVerified: true,
    identities: Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [
      service,
      identity(service, revision, version, mode, { manifestBinding, supplemented }),
    ])),
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
      mongoFingerprint: fingerprint,
      qdrantFingerprint: fingerprint,
      combinedFingerprint: fingerprint,
    },
  };
}

function baseInput({ bootstrap = false } = {}) {
  const previousRevision = bootstrap ? POLICY.commit : PREVIOUS_REVISION;
  const previousVersion = bootstrap ? POLICY.version : '1.2.3';
  const previousDigests = bootstrap ? BOOTSTRAP_DIGESTS : MODERN_DIGESTS;
  const previousMode = bootstrap ? LEGACY_IDENTITY_MODE : 'in-band-health';
  const candidateDigests = {
    core: `sha256:${'1'.repeat(64)}`,
    benchmark: `sha256:${'2'.repeat(64)}`,
    rag: `sha256:${'3'.repeat(64)}`,
  };
  const previousFingerprints = bootstrap
    ? Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [
      service,
      refFingerprint(POLICY.services[service].ref),
    ]))
    : { core: '9'.repeat(64), benchmark: 'a'.repeat(64), rag: 'b'.repeat(64) };
  return {
    generatedAt: '2026-08-28T21:00:00.000Z',
    scenarioHash: '4'.repeat(12),
    expectedRevisions: { previous: previousRevision, candidate: CANDIDATE_REVISION },
    previousRelease: {
      tag: bootstrap ? POLICY.tag : 'v1.2.3',
      version: previousVersion,
      commit: previousRevision,
      manifestSha256: bootstrap ? POLICY.manifestSha256 : '7'.repeat(64),
      profile: 'demo',
      identityEvidenceMode: previousMode,
    },
    legacyBaseline: bootstrap ? BOOTSTRAP_BASELINE : null,
    images: {
      previous: previousDigests,
      candidate: candidateDigests,
      dependencies: {
        mongo: `sha256:${'5'.repeat(64)}`,
        qdrant: `sha256:${'6'.repeat(64)}`,
      },
      referenceFingerprints: {
        previous: previousFingerprints,
        candidate: { core: 'c'.repeat(64), benchmark: 'd'.repeat(64), rag: 'e'.repeat(64) },
        dependencies: { mongo: 'f'.repeat(64), qdrant: '0'.repeat(64) },
      },
    },
    topology: {
      composeConfigHashes: { previous: '7'.repeat(64), candidate: '8'.repeat(64) },
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
      before: phase(previousRevision, previousVersion, previousDigests, previousMode, {
        supplemented: bootstrap,
      }),
      upgraded: phase(CANDIDATE_REVISION, '1.2.4', candidateDigests, 'in-band-health', {
        manifestBinding: null,
      }),
      rolledBack: phase(previousRevision, previousVersion, previousDigests, previousMode, {
        supplemented: bootstrap,
      }),
    },
    cleanup: { verified: true, containers: 0, networks: 0, volumes: 0 },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('creates exact schema-v2 strict modern release evidence', () => {
  const receipt = createUpgradeRollbackReceipt(baseInput());
  assert.equal(receipt.schemaVersion, RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.kind, RECEIPT_KIND);
  assert.equal(receipt.evidenceClass, 'release-bound');
  assert.equal(receipt.legacyBaseline, null);
  assert.equal(receipt.status, 'pass');
  assert.deepEqual(receipt.assertions.map((entry) => entry.id), ASSERTION_IDS);
  assert.deepEqual(receipt.assertions.map((entry) => entry.status), Array(ASSERTION_IDS.length).fill('pass'));
  assert.deepEqual(validateUpgradeRollbackReceipt(receipt), []);
});

test('accepts only the exact v0.1.1 release-bound bootstrap evidence', () => {
  const receipt = createUpgradeRollbackReceipt(baseInput({ bootstrap: true }));
  assert.equal(receipt.evidenceClass, 'release-bound-bootstrap');
  assert.deepEqual(receipt.legacyBaseline, BOOTSTRAP_BASELINE);
  assert.equal(receipt.phases.before.identities.core.mode, LEGACY_IDENTITY_MODE);
  assert.equal(receipt.phases.before.identities.core.fieldSources.version, 'packaged-package-json');
  assert.equal(receipt.phases.upgraded.identities.core.mode, 'in-band-health');
  assert.equal(receipt.status, 'pass');
  assert.deepEqual(validateUpgradeRollbackReceipt(receipt), []);

  for (const mutate of [
    (input) => { input.legacyBaseline.manifestSha256 = '0'.repeat(64); },
    (input) => { input.images.previous.core = `sha256:${'0'.repeat(64)}`; },
    (input) => { input.images.referenceFingerprints.previous.core = '0'.repeat(64); },
  ]) {
    const changed = clone(baseInput({ bootstrap: true }));
    mutate(changed);
    const failed = createUpgradeRollbackReceipt(changed);
    assert.equal(failed.assertions.find((entry) => entry.id === 'immutable-inputs').status, 'fail');
    assert.match(validateUpgradeRollbackReceipt(failed).join('\n'), /previousRelease binding is invalid/);
  }
});

test('candidate identity never accepts legacy supplementation', () => {
  const input = baseInput({ bootstrap: true });
  input.phases.upgraded.identities.core.fieldSources.version = 'packaged-package-json';
  input.phases.upgraded.identities.core.evidence.completeInBandIdentity = false;
  input.phases.upgraded.identities.core.evidence.packagedVersionVerified = true;
  const receipt = createUpgradeRollbackReceipt(input);
  assert.equal(receipt.assertions.find((entry) => entry.id === 'candidate-identities').status, 'fail');
  assert(receipt.failureCodes.includes('CANDIDATE_IDENTITY_MISMATCH'));
  assert.deepEqual(validateUpgradeRollbackReceipt(receipt), []);
});

test('strict previous health version must match its bound manifest version', () => {
  const input = baseInput();
  for (const phaseName of ['before', 'rolledBack']) {
    for (const service of ['core', 'benchmark', 'rag']) {
      input.phases[phaseName].identities[service].version = '9.9.9';
    }
  }
  const receipt = createUpgradeRollbackReceipt(input);
  assert.equal(receipt.assertions.find((entry) => entry.id === 'previous-identities').status, 'fail');
  assert.equal(receipt.assertions.find((entry) => entry.id === 'rollback-identities').status, 'fail');
  assert.deepEqual(validateUpgradeRollbackReceipt(receipt), []);
});

test('fails upgrade compatibility when persistent state changes', () => {
  const input = baseInput({ bootstrap: true });
  input.phases.upgraded.state.qdrantFingerprint = '7'.repeat(64);
  input.phases.upgraded.state.combinedFingerprint = '8'.repeat(64);
  const receipt = createUpgradeRollbackReceipt(input);
  assert.equal(receipt.assertions.find((entry) => entry.id === 'upgrade-schema-compatible').status, 'fail');
  assert(receipt.failureCodes.includes('UPGRADE_SCHEMA_INCOMPATIBLE'));
  assert.deepEqual(validateUpgradeRollbackReceipt(receipt), []);
});

test('rollback must repeat identity evidence and leave exact zero residue', () => {
  const input = clone(baseInput({ bootstrap: true }));
  input.phases.rolledBack.identities.rag.fieldSources.version = 'live-health';
  input.phases.rolledBack.state.combinedFingerprint = '0'.repeat(64);
  input.cleanup = { verified: false, containers: 1, networks: 0, volumes: 2 };
  const receipt = createUpgradeRollbackReceipt(input);
  for (const id of ['rollback-identities', 'rollback-data-compatible', 'zero-residue']) {
    assert.equal(receipt.assertions.find((entry) => entry.id === id).status, 'fail', id);
  }
  assert.deepEqual(validateUpgradeRollbackReceipt(receipt), []);
});

test('recomputes assertions, summary, status, and closed failure codes', () => {
  const receipt = clone(createUpgradeRollbackReceipt(baseInput()));
  receipt.phases.upgraded.journeys.ragState.passed = false;
  const errors = validateUpgradeRollbackReceipt(receipt).join('\n');
  assert.match(errors, /assertions are inconsistent/);
  assert.match(errors, /summary is inconsistent/);
  assert.match(errors, /status is inconsistent/);
  assert.match(errors, /failureCodes omit assertion failures/);

  const unknownCode = clone(createUpgradeRollbackReceipt(baseInput()));
  unknownCode.failureCodes = ['UNKNOWN_CODE'];
  unknownCode.status = 'fail';
  assert.match(validateUpgradeRollbackReceipt(unknownCode).join('\n'), /failureCodes are invalid/);
});

test('rejects addresses, refs, secrets, raw fixture content, and raw identifiers', () => {
  const cases = [
    'http://internal.invalid',
    'peer 127.0.0.1',
    'Bearer sensitive-value',
    'ghcr.io/example/agentx-core@sha256:' + '1'.repeat(64),
    'agentx-upgrade-rollback-document-v1',
    'Upgrade rollback fixture system instruction.',
    '66f000000000000000000001',
    '66f00000-0000-4000-8000-000000000003',
  ];
  for (const unsafe of cases) {
    const receipt = clone(createUpgradeRollbackReceipt(baseInput()));
    receipt.phases.before.state.mongoFingerprint = unsafe;
    assert.match(validateUpgradeRollbackReceipt(receipt).join('\n'), /unsafe receipt string/, unsafe);
  }
});

test('rejects extra fields and unbound or equal revisions', () => {
  const extra = clone(createUpgradeRollbackReceipt(baseInput()));
  extra.topology.projectName = '4'.repeat(12);
  assert.match(validateUpgradeRollbackReceipt(extra).join('\n'), /forbidden receipt field/);

  const genericFallback = baseInput();
  genericFallback.legacyBaseline = BOOTSTRAP_BASELINE;
  const fallbackReceipt = createUpgradeRollbackReceipt(genericFallback);
  assert.equal(fallbackReceipt.assertions.find((entry) => entry.id === 'immutable-inputs').status, 'fail');
  assert.match(validateUpgradeRollbackReceipt(fallbackReceipt).join('\n'), /previousRelease binding is invalid/);

  const unbound = baseInput();
  unbound.expectedRevisions.candidate = unbound.expectedRevisions.previous;
  unbound.phases.upgraded.expectedRevisionVerified = false;
  const receipt = createUpgradeRollbackReceipt(unbound);
  assert.equal(receipt.status, 'fail');
  assert.match(validateUpgradeRollbackReceipt(receipt).join('\n'), /expectedRevisions are invalid/);
});

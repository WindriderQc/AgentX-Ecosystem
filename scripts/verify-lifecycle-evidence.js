#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  SERVICES,
  assertCandidateImageManifest,
  exactKeys,
  expectedImage,
  readBoundedJson,
} = require('./assemble-candidate-image-manifest');
const { validateUpgradeRollbackReceipt } = require('../e2e/upgrade-rollback-receipt');
const {
  DEFAULT_POLICY_FILE: DEFAULT_LEGACY_POLICY_FILE,
  LEGACY_IDENTITY_MODE,
  loadLegacyReleasePolicy,
  normalizePreviousReleaseBaseline,
  validatePreviousManifestBytes,
} = require('../e2e/upgrade-rollback-baseline');
const { validateRecoveryDrillReceipt } = require('../shared/recoveryDrillReceiptContract');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PIN_FILE = path.join(ROOT, 'config', 'container-image-pins.json');
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PINNED_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const ARTIFACT_FILES = Object.freeze({
  candidate: 'candidate-image-manifest.json',
  upgrade: 'upgrade-rollback-receipt.json',
  recovery: 'recovery-drill-receipt.json',
});
const RUNTIME_IDENTITY_MODE = 'in-band-health';

function referenceFingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function digestFromReference(reference, label) {
  const value = String(reference || '');
  if (!PINNED_REFERENCE_PATTERN.test(value) || value.includes('//') || value.includes('..')) {
    throw new Error(`${label} is not an exact image@sha256 digest reference`);
  }
  return value.slice(value.lastIndexOf('@') + 1);
}

function loadDependencyPins(pinFile = DEFAULT_PIN_FILE) {
  const inventory = readBoundedJson(pinFile, 'container image pin inventory');
  if (inventory?.schemaVersion !== 1 || !exactKeys(inventory.images, [
    'node-runtime', 'recovery-helper', 'mongodb', 'ollama', 'qdrant',
  ])) throw new Error('container image pin inventory shape is invalid');
  const mapping = { mongo: 'mongodb', qdrant: 'qdrant', transportHelper: 'recovery-helper' };
  const pins = {};
  for (const [receiptName, inventoryName] of Object.entries(mapping)) {
    const descriptor = inventory.images[inventoryName];
    if (!exactKeys(descriptor, ['version', 'reference'])
        || !SEMVER_PATTERN.test(String(descriptor.version || ''))) {
      throw new Error(`${inventoryName} container image pin descriptor is invalid`);
    }
    pins[receiptName] = Object.freeze({
      version: descriptor.version,
      reference: descriptor.reference,
      digest: digestFromReference(descriptor.reference, `${inventoryName} container image pin`),
      fingerprint: referenceFingerprint(descriptor.reference),
    });
  }
  return Object.freeze(pins);
}

function repositoryProductVersion(repoRoot = ROOT) {
  const versions = SERVICES.map((service) => {
    const parsed = readBoundedJson(path.join(repoRoot, service, 'package.json'), `${service} package manifest`);
    if (!SEMVER_PATTERN.test(String(parsed?.version || ''))) {
      throw new Error(`${service} package version is invalid`);
    }
    return parsed.version;
  });
  if (new Set(versions).size !== 1) throw new Error('product package versions do not match');
  return versions[0];
}

function validateStableReleaseManifest(manifest, { candidateRevision = null, expectedTag = null } = {}) {
  const errors = [];
  if (!exactKeys(manifest, ['schemaVersion', 'product', 'version', 'tag', 'commit', 'images'])) {
    errors.push('previous stable image manifest shape is invalid');
    return errors;
  }
  if (manifest.schemaVersion !== 1) errors.push('previous stable image manifest schemaVersion is invalid');
  if (manifest.product !== 'Agent X Ecosystem') errors.push('previous stable image manifest product is invalid');
  if (!SEMVER_PATTERN.test(String(manifest.version || ''))) errors.push('previous stable image manifest version is invalid');
  if (manifest.tag !== `v${manifest.version}`) errors.push('previous stable image manifest tag/version binding is invalid');
  if (expectedTag != null && manifest.tag !== expectedTag) {
    errors.push('previous stable image manifest tag does not match the selected GitHub release');
  }
  if (!COMMIT_PATTERN.test(String(manifest.commit || ''))) errors.push('previous stable image manifest commit is invalid');
  if (candidateRevision != null && manifest.commit === candidateRevision) {
    errors.push('previous and candidate revisions must be distinct');
  }
  if (!exactKeys(manifest.images, SERVICES)) {
    errors.push('previous stable image manifest service set is not exact');
    return errors;
  }
  for (const service of SERVICES) {
    const record = manifest.images[service];
    const image = expectedImage(service);
    if (!exactKeys(record, ['image', 'digest', 'ref'])) {
      errors.push(`previous stable image manifest images.${service} shape is invalid`);
      continue;
    }
    if (record.image !== image) errors.push(`previous stable image manifest images.${service}.image is invalid`);
    if (!DIGEST_PATTERN.test(String(record.digest || ''))) {
      errors.push(`previous stable image manifest images.${service}.digest is invalid`);
    }
    if (record.ref !== `${image}@${record.digest}`) {
      errors.push(`previous stable image manifest images.${service}.ref is not canonical`);
    }
  }
  return errors;
}

function assertStableReleaseManifest(manifest, options = {}) {
  const errors = validateStableReleaseManifest(manifest, options);
  if (errors.length) throw new Error(`Invalid Agent X previous stable image manifest:\n- ${errors.join('\n- ')}`);
  return manifest;
}

function readPreviousReleaseEvidence(filePath, {
  expectedTag = null,
  policyFile = DEFAULT_LEGACY_POLICY_FILE,
} = {}) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('previous stable image manifest must be a regular file');
  }
  if (stat.size <= 0 || stat.size > 64 * 1024) {
    throw new Error('previous stable image manifest byte size is invalid');
  }
  const bytes = fs.readFileSync(resolved);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('previous stable image manifest is not valid JSON');
  }
  assertStableReleaseManifest(manifest, { expectedTag });
  const manifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const policy = loadLegacyReleasePolicy(policyFile);
  const legacyTag = policy.baselines[0].tag;
  const legacySelected = manifest.tag === legacyTag || expectedTag === legacyTag;
  if (legacySelected) {
    const validation = validatePreviousManifestBytes(bytes, policy);
    if (validation.errors.length) throw new Error(validation.errors[0]);
  }
  return Object.freeze({
    manifest,
    manifestSha256,
    identityEvidenceMode: legacySelected ? LEGACY_IDENTITY_MODE : RUNTIME_IDENTITY_MODE,
  });
}

function compareUpgradeEvidence({
  receipt,
  candidate,
  previous,
  previousManifestSha256,
  previousIdentityEvidenceMode,
  candidateRevision,
  expectedPreviousRevision,
  expectedProductVersion,
  pins,
}) {
  const errors = validateUpgradeRollbackReceipt(receipt).map((error) => `upgrade receipt: ${error}`);
  if (receipt?.status !== 'pass') errors.push('upgrade receipt status must be pass');
  const receiptMode = receipt?.previousRelease?.identityEvidenceMode;
  const expectedEvidenceClass = receiptMode === LEGACY_IDENTITY_MODE
    ? 'release-bound-bootstrap'
    : 'release-bound';
  if (receipt?.evidenceClass !== expectedEvidenceClass) {
    errors.push('upgrade receipt evidence class does not match the previous identity mode');
  }
  if (receipt?.expectedRevisions?.candidate !== candidateRevision) {
    errors.push('upgrade receipt candidate revision does not match the source SHA');
  }
  const previousRevision = receipt?.expectedRevisions?.previous;
  if (!COMMIT_PATTERN.test(String(previousRevision || ''))) errors.push('upgrade receipt previous revision is missing');
  if (previousRevision === candidateRevision) errors.push('upgrade receipt previous and candidate revisions must be distinct');
  if (expectedPreviousRevision && previousRevision !== expectedPreviousRevision) {
    errors.push('upgrade receipt previous revision does not match the expected stable revision');
  }
  if (previous && previousRevision !== previous.commit) {
    errors.push('upgrade receipt previous revision does not match the stable manifest');
  }
  if (previous) {
    const binding = receipt?.previousRelease;
    if (binding?.tag !== previous.tag
        || binding?.version !== previous.version
        || binding?.commit !== previous.commit
        || binding?.manifestSha256 !== previousManifestSha256
        || binding?.profile !== receipt?.profile
        || binding?.identityEvidenceMode !== previousIdentityEvidenceMode) {
      errors.push('upgrade receipt previous release binding does not match the attached manifest');
    }
  }
  if (expectedPreviousRevision && receipt?.previousRelease?.commit !== expectedPreviousRevision) {
    errors.push('upgrade receipt previous release binding does not match the expected stable revision');
  }
  if (receiptMode === LEGACY_IDENTITY_MODE && receipt?.legacyBaseline == null) {
    errors.push('legacy upgrade receipt must retain the exact baseline policy binding');
  }
  if (receiptMode === RUNTIME_IDENTITY_MODE && receipt?.legacyBaseline !== null) {
    errors.push('modern upgrade receipt must not retain a legacy baseline binding');
  }
  for (const service of SERVICES) {
    if (receipt?.phases?.upgraded?.identities?.[service]?.version !== expectedProductVersion) {
      errors.push(`upgrade receipt candidate ${service} version does not match the source packages`);
    }
    if (previous && (receipt?.phases?.before?.identities?.[service]?.version !== previous.version
        || receipt?.phases?.rolledBack?.identities?.[service]?.version !== previous.version)) {
      errors.push(`upgrade receipt previous ${service} version does not match the stable manifest`);
    }
    if (receipt?.phases?.upgraded?.identities?.[service]?.mode !== RUNTIME_IDENTITY_MODE) {
      errors.push(`upgrade receipt candidate ${service} must use in-band-health identity`);
    }
    if (receipt?.phases?.before?.identities?.[service]?.mode !== receiptMode
        || receipt?.phases?.rolledBack?.identities?.[service]?.mode !== receiptMode) {
      errors.push(`upgrade receipt previous ${service} identity mode is inconsistent`);
    }
  }
  for (const service of SERVICES) {
    if (receipt?.images?.candidate?.[service] !== candidate.images[service].digest) {
      errors.push(`upgrade receipt candidate ${service} digest does not match the candidate manifest`);
    }
    if (receipt?.images?.referenceFingerprints?.candidate?.[service]
        !== referenceFingerprint(candidate.images[service].ref)) {
      errors.push(`upgrade receipt candidate ${service} reference does not match the candidate manifest`);
    }
    if (previous) {
      if (receipt?.images?.previous?.[service] !== previous.images[service].digest) {
        errors.push(`upgrade receipt previous ${service} digest does not match the stable manifest`);
      }
      if (receipt?.images?.referenceFingerprints?.previous?.[service]
          !== referenceFingerprint(previous.images[service].ref)) {
        errors.push(`upgrade receipt previous ${service} reference does not match the stable manifest`);
      }
    }
  }
  for (const dependency of ['mongo', 'qdrant']) {
    if (receipt?.images?.dependencies?.[dependency] !== pins[dependency].digest) {
      errors.push(`upgrade receipt ${dependency} digest does not match config/container-image-pins.json`);
    }
    if (receipt?.images?.referenceFingerprints?.dependencies?.[dependency]
        !== pins[dependency].fingerprint) {
      errors.push(`upgrade receipt ${dependency} reference does not match config/container-image-pins.json`);
    }
  }
  return errors;
}

function compareRecoveryEvidence({ receipt, candidate, candidateRevision, expectedProductVersion, pins }) {
  const validation = validateRecoveryDrillReceipt(receipt);
  const errors = (validation?.errors || []).map((error) => `recovery receipt: ${error}`);
  if (validation?.valid !== true) errors.push('recovery receipt contract validation failed');
  if (receipt?.outcome !== 'passed') errors.push('recovery receipt outcome must be passed');
  if (receipt?.product?.revision !== candidateRevision) {
    errors.push('recovery receipt product revision does not match the source SHA');
  }
  if (receipt?.product?.version !== expectedProductVersion) {
    errors.push('recovery receipt product version does not match the source packages');
  }
  for (const service of SERVICES) {
    if (receipt?.sourceImages?.[service] !== candidate.images[service].digest) {
      errors.push(`recovery receipt ${service} digest does not match the candidate manifest`);
    }
    const identity = receipt?.productProof?.identities?.[service];
    if (identity != null && (identity.revision !== candidateRevision
        || identity.service !== `agentx-${service}`
        || identity.version !== receipt?.product?.version
        || identity.profile !== receipt?.product?.profile)) {
      errors.push(`recovery receipt ${service} product proof does not match the candidate`);
    }
  }
  const dependencyFields = [
    ['mongodb', 'mongo', 'serverVersion'],
    ['qdrant', 'qdrant', 'serverVersion'],
    ['transportHelper', 'transportHelper', 'version'],
  ];
  for (const [receiptName, pinName, versionField] of dependencyFields) {
    if (receipt?.dependencies?.[receiptName]?.imageDigest !== pins[pinName].digest) {
      errors.push(`recovery receipt ${receiptName} digest does not match config/container-image-pins.json`);
    }
    if (receipt?.dependencies?.[receiptName]?.[versionField] !== pins[pinName].version) {
      errors.push(`recovery receipt ${receiptName} version does not match config/container-image-pins.json`);
    }
  }
  for (const [sourceName, pinName] of [['mongodb', 'mongo'], ['qdrant', 'qdrant']]) {
    if (receipt?.sourceImages?.[sourceName] !== pins[pinName].digest) {
      errors.push(`recovery receipt source ${sourceName} digest does not match config/container-image-pins.json`);
    }
  }
  return errors;
}

function validateLifecycleEvidence({
  candidate = null,
  previous = null,
  previousManifestSha256 = null,
  previousIdentityEvidenceMode = null,
  previousBaseline = null,
  upgrade = null,
  recovery = null,
  expectedCandidateRevision,
  expectedPreviousRevision = null,
  expectedPreviousTag = null,
  expectedProductVersion = repositoryProductVersion(),
  pins,
}) {
  const errors = [];
  let candidateValid = false;
  let previousValid = false;
  const candidateRevision = String(expectedCandidateRevision || '');
  if (!COMMIT_PATTERN.test(candidateRevision)) errors.push('expected candidate revision must be a full lowercase Git SHA');
  if (expectedPreviousRevision != null && !COMMIT_PATTERN.test(String(expectedPreviousRevision))) {
    errors.push('expected previous revision must be a full lowercase Git SHA');
  }
  if (expectedPreviousTag != null && !/^v/.test(String(expectedPreviousTag))) {
    errors.push('expected previous tag is invalid');
  }
  if (!SEMVER_PATTERN.test(String(expectedProductVersion || ''))) errors.push('expected product version is invalid');
  if (candidate) {
    try {
      assertCandidateImageManifest(candidate, { expectedCommit: candidateRevision });
      candidateValid = true;
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (previous) {
    try {
      assertStableReleaseManifest(previous, { candidateRevision, expectedTag: expectedPreviousTag });
      previousValid = true;
    } catch (error) {
      errors.push(error.message);
    }
    if (expectedPreviousRevision && previous.commit !== expectedPreviousRevision) {
      errors.push('stable manifest commit does not match the expected previous revision');
    }
    if (!/^[0-9a-f]{64}$/.test(String(previousManifestSha256 || ''))) {
      errors.push('previous stable image manifest byte hash is required');
    }
    if (![LEGACY_IDENTITY_MODE, RUNTIME_IDENTITY_MODE].includes(previousIdentityEvidenceMode)) {
      errors.push('previous stable image manifest identity evidence mode is invalid');
    }
    if (previous.tag === 'v0.1.1' && previousIdentityEvidenceMode !== LEGACY_IDENTITY_MODE) {
      errors.push('the exact v0.1.1 previous release requires legacy-oci-bound evidence');
    }
    if (previous.tag !== 'v0.1.1' && previousIdentityEvidenceMode === LEGACY_IDENTITY_MODE) {
      errors.push('legacy-oci-bound evidence is restricted to the exact v0.1.1 previous release');
    }
    if (previousBaseline) {
      try {
        const policy = loadLegacyReleasePolicy();
        normalizePreviousReleaseBaseline(previousBaseline, policy);
        if (previousIdentityEvidenceMode !== LEGACY_IDENTITY_MODE) {
          errors.push('a previous release baseline wrapper is allowed only for legacy-oci-bound evidence');
        }
        if (previousBaseline.manifestSha256 !== previousManifestSha256) {
          errors.push('previous release baseline wrapper does not match the attached manifest bytes');
        }
      } catch (error) {
        errors.push(error.message);
      }
    } else if (upgrade && previousIdentityEvidenceMode === LEGACY_IDENTITY_MODE) {
      errors.push('legacy upgrade evidence requires the normalized previous release baseline wrapper');
    }
  }
  if ((upgrade || recovery) && !candidate) errors.push('candidate manifest is required when validating lifecycle receipts');
  if (upgrade && !candidateValid) {
    errors.push(...validateUpgradeRollbackReceipt(upgrade).map((error) => `upgrade receipt: ${error}`));
    if (upgrade?.status !== 'pass') errors.push('upgrade receipt status must be pass');
    if (!['release-bound', 'release-bound-bootstrap'].includes(upgrade?.evidenceClass)) {
      errors.push('upgrade receipt evidence class is not release-bound');
    }
  }
  if (upgrade && candidateValid) errors.push(...compareUpgradeEvidence({
    receipt: upgrade,
    candidate,
    previous: previousValid ? previous : null,
    previousManifestSha256: previousValid ? previousManifestSha256 : null,
    previousIdentityEvidenceMode: previousValid ? previousIdentityEvidenceMode : null,
    candidateRevision,
    expectedPreviousRevision,
    expectedProductVersion,
    pins,
  }));
  if (recovery && !candidateValid) {
    const validation = validateRecoveryDrillReceipt(recovery);
    errors.push(...(validation?.errors || []).map((error) => `recovery receipt: ${error}`));
    if (validation?.valid !== true) errors.push('recovery receipt contract validation failed');
    if (recovery?.outcome !== 'passed') errors.push('recovery receipt outcome must be passed');
  }
  if (recovery && candidateValid) errors.push(...compareRecoveryEvidence({
    receipt: recovery,
    candidate,
    candidateRevision,
    expectedProductVersion,
    pins,
  }));
  if (!candidate && !previous) errors.push('candidate or previous stable manifest is required');
  return [...new Set(errors)];
}

function resolveArtifactDirectory(directory, type) {
  const expectedName = ARTIFACT_FILES[type];
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${type} artifact must be a regular directory`);
  }
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== expectedName || !entries[0].isFile()) {
    throw new Error(`${type} artifact must contain exactly ${expectedName}`);
  }
  return path.join(resolved, expectedName);
}

function parseArgs(argv) {
  const values = {};
  const mapping = {
    '--candidate': 'candidate',
    '--candidate-artifact': 'candidateArtifact',
    '--previous': 'previous',
    '--previous-baseline': 'previousBaseline',
    '--upgrade': 'upgrade',
    '--upgrade-artifact': 'upgradeArtifact',
    '--recovery': 'recovery',
    '--recovery-artifact': 'recoveryArtifact',
    '--expected-candidate-revision': 'expectedCandidateRevision',
    '--expected-previous-revision': 'expectedPreviousRevision',
    '--expected-previous-tag': 'expectedPreviousTag',
    '--dependency-pins': 'pinFile',
    '--github-output': 'githubOutput',
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const key = mapping[argument];
    if (!key) throw new Error(`unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires one value`);
    seen.add(argument);
    values[key] = value;
  }
  if (values.candidate && values.candidateArtifact) throw new Error('candidate file and artifact are mutually exclusive');
  if (values.upgrade && values.upgradeArtifact) throw new Error('upgrade file and artifact are mutually exclusive');
  if (values.recovery && values.recoveryArtifact) throw new Error('recovery file and artifact are mutually exclusive');
  if (!values.expectedCandidateRevision) throw new Error('--expected-candidate-revision is required');
  for (const key of ['candidate', 'previous', 'previousBaseline', 'upgrade', 'recovery', 'pinFile', 'githubOutput']) {
    if (values[key]) values[key] = path.resolve(values[key]);
  }
  for (const type of ['candidate', 'upgrade', 'recovery']) {
    const artifactKey = `${type}Artifact`;
    if (values[artifactKey]) values[type] = resolveArtifactDirectory(values[artifactKey], type);
  }
  values.pinFile = values.pinFile || DEFAULT_PIN_FILE;
  return values;
}

function appendManifestOutputs(outputPath, candidate, previous, previousEvidence, upgrade) {
  const rows = [];
  if (candidate) {
    rows.push(`candidate_revision=${candidate.commit}`);
    for (const service of SERVICES) {
      rows.push(`candidate_${service}_digest=${candidate.images[service].digest}`);
      rows.push(`candidate_${service}_ref=${candidate.images[service].ref}`);
    }
  }
  if (previous) {
    rows.push(`previous_revision=${previous.commit}`);
    rows.push(`previous_tag=${previous.tag}`);
    rows.push(`previous_version=${previous.version}`);
    rows.push(`previous_manifest_sha256=${previousEvidence.manifestSha256}`);
    rows.push(`previous_identity_evidence_mode=${previousEvidence.identityEvidenceMode}`);
    for (const service of SERVICES) {
      rows.push(`previous_${service}_digest=${previous.images[service].digest}`);
      rows.push(`previous_${service}_ref=${previous.images[service].ref}`);
    }
  }
  if (upgrade?.previousRelease) {
    rows.push(`upgrade_previous_tag=${upgrade.previousRelease.tag}`);
    rows.push(`upgrade_previous_version=${upgrade.previousRelease.version}`);
    rows.push(`upgrade_previous_revision=${upgrade.previousRelease.commit}`);
    rows.push(`upgrade_previous_manifest_sha256=${upgrade.previousRelease.manifestSha256}`);
    rows.push(`upgrade_previous_identity_evidence_mode=${upgrade.previousRelease.identityEvidenceMode}`);
  }
  fs.appendFileSync(outputPath, `${rows.join('\n')}\n`, 'utf8');
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const candidate = options.candidate ? readBoundedJson(options.candidate, 'candidate image manifest') : null;
    const previousEvidence = options.previous
      ? readPreviousReleaseEvidence(options.previous, { expectedTag: options.expectedPreviousTag })
      : null;
    const previous = previousEvidence?.manifest || null;
    const previousBaseline = options.previousBaseline
      ? readBoundedJson(options.previousBaseline, 'previous release baseline wrapper')
      : null;
    const upgrade = options.upgrade ? readBoundedJson(options.upgrade, 'upgrade rollback receipt') : null;
    const recovery = options.recovery ? readBoundedJson(options.recovery, 'recovery drill receipt') : null;
    const pins = loadDependencyPins(options.pinFile);
    const errors = validateLifecycleEvidence({
      candidate,
      previous,
      previousManifestSha256: previousEvidence?.manifestSha256 || null,
      previousIdentityEvidenceMode: previousEvidence?.identityEvidenceMode || null,
      previousBaseline,
      upgrade,
      recovery,
      expectedCandidateRevision: options.expectedCandidateRevision,
      expectedPreviousRevision: options.expectedPreviousRevision,
      expectedPreviousTag: options.expectedPreviousTag,
      expectedProductVersion: repositoryProductVersion(),
      pins,
    });
    if (errors.length) throw new Error(`Invalid Agent X lifecycle evidence:\n- ${errors.join('\n- ')}`);
    if (options.githubOutput) appendManifestOutputs(
      options.githubOutput,
      candidate,
      previous,
      previousEvidence,
      upgrade
    );
    const validated = [candidate && 'candidate', previous && 'previous', upgrade && 'upgrade', recovery && 'recovery']
      .filter(Boolean).join(',');
    process.stdout.write(`lifecycle evidence ok: ${validated}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ARTIFACT_FILES,
  DEFAULT_PIN_FILE,
  appendManifestOutputs,
  assertStableReleaseManifest,
  compareRecoveryEvidence,
  compareUpgradeEvidence,
  digestFromReference,
  loadDependencyPins,
  referenceFingerprint,
  readPreviousReleaseEvidence,
  repositoryProductVersion,
  resolveArtifactDirectory,
  validateLifecycleEvidence,
  validateStableReleaseManifest,
};

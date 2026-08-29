'use strict';

const crypto = require('node:crypto');
const {
  EXPECTED_POLICY,
  LEGACY_IDENTITY_MODE,
  baselineFromPolicy,
  receiptBaselineBinding,
} = require('./upgrade-rollback-baseline');

const RECEIPT_SCHEMA_VERSION = 2;
const RECEIPT_KIND = 'agentx.upgrade-rollback-rehearsal';
const RECEIPT_PROFILE = 'demo';
const IN_BAND_IDENTITY_MODE = 'in-band-health';
const PRODUCT_SERVICES = Object.freeze(['core', 'benchmark', 'rag']);
const BOOTSTRAP_BASELINE = receiptBaselineBinding(EXPECTED_POLICY);
const BOOTSTRAP_POLICY = baselineFromPolicy(EXPECTED_POLICY);
const FIELD_SOURCE_VALUES = Object.freeze([
  'live-health',
  'packaged-package-json',
  'rendered-runtime-profile',
  'oci-revision-label',
]);
const ASSERTION_IDS = Object.freeze([
  'immutable-inputs',
  'isolated-topology',
  'previous-image-set',
  'previous-identities',
  'previous-journeys',
  'candidate-image-set',
  'candidate-identities',
  'candidate-journeys',
  'upgrade-schema-compatible',
  'rollback-image-set',
  'rollback-identities',
  'rollback-journeys',
  'rollback-data-compatible',
  'zero-residue',
]);
const FAILURE_CODES = Object.freeze([
  'INPUT_NOT_IMMUTABLE',
  'TOPOLOGY_NOT_ISOLATED',
  'PREVIOUS_IMAGE_MISMATCH',
  'PREVIOUS_IDENTITY_MISMATCH',
  'PREVIOUS_JOURNEY_FAILED',
  'CANDIDATE_IMAGE_MISMATCH',
  'CANDIDATE_IDENTITY_MISMATCH',
  'CANDIDATE_JOURNEY_FAILED',
  'UPGRADE_SCHEMA_INCOMPATIBLE',
  'ROLLBACK_IMAGE_MISMATCH',
  'ROLLBACK_IDENTITY_MISMATCH',
  'ROLLBACK_JOURNEY_FAILED',
  'ROLLBACK_DATA_INCOMPATIBLE',
  'CLEANUP_RESIDUE',
  'REHEARSAL_EXECUTION_FAILED',
]);
const ASSERTION_FAILURE_CODES = Object.freeze({
  'immutable-inputs': 'INPUT_NOT_IMMUTABLE',
  'isolated-topology': 'TOPOLOGY_NOT_ISOLATED',
  'previous-image-set': 'PREVIOUS_IMAGE_MISMATCH',
  'previous-identities': 'PREVIOUS_IDENTITY_MISMATCH',
  'previous-journeys': 'PREVIOUS_JOURNEY_FAILED',
  'candidate-image-set': 'CANDIDATE_IMAGE_MISMATCH',
  'candidate-identities': 'CANDIDATE_IDENTITY_MISMATCH',
  'candidate-journeys': 'CANDIDATE_JOURNEY_FAILED',
  'upgrade-schema-compatible': 'UPGRADE_SCHEMA_INCOMPATIBLE',
  'rollback-image-set': 'ROLLBACK_IMAGE_MISMATCH',
  'rollback-identities': 'ROLLBACK_IDENTITY_MISMATCH',
  'rollback-journeys': 'ROLLBACK_JOURNEY_FAILED',
  'rollback-data-compatible': 'ROLLBACK_DATA_INCOMPATIBLE',
  'zero-residue': 'CLEANUP_RESIDUE',
});
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHORT_HASH_PATTERN = /^[0-9a-f]{12}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_RECEIPT_BYTES = 64 * 1024;
const IDENTITY_KEYS = Object.freeze([
  'mode', 'service', 'version', 'profile', 'revision', 'fieldSources', 'evidence',
]);
const EVIDENCE_KEYS = Object.freeze([
  'httpStatus', 'healthyStatusVerified', 'serviceHealthVerified', 'completeInBandIdentity',
  'runtimeDigestVerified', 'renderedProfileVerified', 'runtimeProfileVerified',
  'ociRevisionVerified', 'ociVersionVerified', 'ociSourceVerified',
  'packagedVersionVerified', 'manifestBindingVerified',
]);
const FORBIDDEN_KEYS = new Set([
  'address', 'authorization', 'containerId', 'credential', 'hostUrl', 'image', 'networkName',
  'origin', 'password', 'path', 'projectName', 'rawContent', 'rawPrompt', 'rawResponse',
  'ref', 'repository', 'secret', 'source', 'systemPrompt', 'token', 'url', 'uri', 'volumeName',
]);
const UNSAFE_STRING_PATTERNS = Object.freeze([
  /https?:\/\//i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /(?:^|[\s[(])(?:(?:[A-Fa-f0-9]{1,4}:){2,}[A-Fa-f0-9:]{0,39}|::1)(?=$|[\s)\]])/,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/i,
  /(?:password|passwd|secret|token|credential)\s*[=:]/i,
  /(?:^|\s)(?:[a-z0-9.-]+\.[a-z]{2,}\/|(?:mongo|node|qdrant\/qdrant|ollama\/ollama)(?=[:@]))[a-z0-9._:/-]+/i,
  /agentx[_-]upgrade[_-]rollback[_-](?:fixture|document)/i,
  /upgrade rollback fixture system instruction/i,
  /deterministic upgrade rollback compatibility state/i,
  /\b[0-9a-f]{24}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
]);
const PASS_ROOT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'evidenceClass', 'generatedAt', 'scenarioHash', 'profile',
  'expectedRevisions', 'previousRelease', 'legacyBaseline', 'images', 'topology', 'phases',
  'cleanup', 'assertions', 'summary', 'privacy',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function allDigests(value, keys) {
  return keys.every((key) => DIGEST_PATTERN.test(String(value?.[key] || '')));
}

function allHashes(value, keys) {
  return keys.every((key) => HASH_PATTERN.test(String(value?.[key] || '')));
}

function expectedBootstrapFingerprints() {
  return Object.fromEntries(PRODUCT_SERVICES.map((service) => [
    service,
    crypto.createHash('sha256').update(BOOTSTRAP_POLICY.services[service].ref).digest('hex'),
  ]));
}

function exactBootstrapBaseline(value) {
  return sameKeys(value, ['tag', 'version', 'commit', 'manifestSha256', 'profile'])
    && Object.keys(BOOTSTRAP_BASELINE).every((key) => value[key] === BOOTSTRAP_BASELINE[key]);
}

function previousReleaseStatus(input) {
  const release = input?.previousRelease;
  if (!sameKeys(release, [
    'tag', 'version', 'commit', 'manifestSha256', 'profile', 'identityEvidenceMode',
  ])) return false;
  if (!VERSION_PATTERN.test(String(release.version || ''))
    || release.tag !== `v${release.version}`
    || !REVISION_PATTERN.test(String(release.commit || ''))
    || !HASH_PATTERN.test(String(release.manifestSha256 || ''))
    || release.profile !== RECEIPT_PROFILE
    || ![IN_BAND_IDENTITY_MODE, LEGACY_IDENTITY_MODE].includes(release.identityEvidenceMode)
    || release.commit !== input?.expectedRevisions?.previous) return false;
  if (release.identityEvidenceMode === IN_BAND_IDENTITY_MODE) {
    return input?.legacyBaseline === null && input?.evidenceClass === 'release-bound';
  }
  const expectedFingerprints = expectedBootstrapFingerprints();
  return input?.evidenceClass === 'release-bound-bootstrap'
    && exactBootstrapBaseline(input?.legacyBaseline)
    && release.tag === BOOTSTRAP_BASELINE.tag
    && release.version === BOOTSTRAP_BASELINE.version
    && release.commit === BOOTSTRAP_BASELINE.commit
    && release.manifestSha256 === BOOTSTRAP_BASELINE.manifestSha256
    && release.profile === BOOTSTRAP_BASELINE.profile
    && PRODUCT_SERVICES.every((service) => input?.images?.previous?.[service] === BOOTSTRAP_POLICY.services[service].digest
      && input?.images?.referenceFingerprints?.previous?.[service] === expectedFingerprints[service]);
}

function identityEvidenceStatus(identity, expectedMode, manifestBindingExpected) {
  if (!sameKeys(identity, IDENTITY_KEYS)
    || !sameKeys(identity?.fieldSources, ['service', 'version', 'profile', 'revision'])
    || !sameKeys(identity?.evidence, EVIDENCE_KEYS)
    || identity.mode !== expectedMode
    || identity.fieldSources.service !== 'live-health'
    || identity.evidence.httpStatus !== 200
    || identity.evidence.healthyStatusVerified !== true
    || identity.evidence.serviceHealthVerified !== true
    || identity.evidence.runtimeDigestVerified !== true
    || identity.evidence.renderedProfileVerified !== true
    || identity.evidence.runtimeProfileVerified !== true
    || identity.evidence.manifestBindingVerified !== manifestBindingExpected) return false;

  if (expectedMode === IN_BAND_IDENTITY_MODE) {
    return identity.evidence.completeInBandIdentity === true
      && ['version', 'profile', 'revision'].every((field) => identity.fieldSources[field] === 'live-health')
      && ['ociRevisionVerified', 'ociVersionVerified', 'ociSourceVerified', 'packagedVersionVerified']
        .every((key) => identity.evidence[key] === null);
  }
  return typeof identity.evidence.completeInBandIdentity === 'boolean'
    && ['ociRevisionVerified', 'ociVersionVerified', 'ociSourceVerified', 'packagedVersionVerified']
      .every((key) => identity.evidence[key] === true)
    && ['live-health', 'packaged-package-json'].includes(identity.fieldSources.version)
    && ['live-health', 'rendered-runtime-profile'].includes(identity.fieldSources.profile)
    && ['live-health', 'oci-revision-label'].includes(identity.fieldSources.revision);
}

function phaseIdentityStatus(phase, expectedRevision, expectedMode, manifestBindingExpected, expectedVersion = null) {
  const identities = phase?.identities;
  if (!identities || phase?.identityConsistent !== true || phase?.expectedRevisionVerified !== true) return false;
  const values = PRODUCT_SERVICES.map((service) => identities[service]);
  if (!values.every((identity, index) => identity?.service === `agentx-${PRODUCT_SERVICES[index]}`
    && identity?.profile === RECEIPT_PROFILE
    && identity?.revision === expectedRevision
    && REVISION_PATTERN.test(String(identity?.revision || ''))
    && VERSION_PATTERN.test(String(identity?.version || ''))
    && identityEvidenceStatus(identity, expectedMode, manifestBindingExpected))) return false;
  if (new Set(values.map((identity) => identity.version)).size !== 1) return false;
  if (expectedVersion != null && values.some((identity) => identity.version !== expectedVersion)) return false;
  if (expectedMode === LEGACY_IDENTITY_MODE) {
    return values.every((identity) => identity.version === BOOTSTRAP_BASELINE.version);
  }
  return true;
}

function phaseJourneyStatus(phase) {
  const journeys = phase?.journeys;
  const schemas = phase?.schemas;
  const state = phase?.state;
  return journeys?.coreState?.passed === true
    && journeys?.coreState?.records === 1
    && journeys?.benchmarkState?.passed === true
    && journeys?.benchmarkState?.records === 1
    && journeys?.ragState?.passed === true
    && journeys?.ragState?.records === 1
    && journeys?.ragState?.chunks === 1
    && journeys?.vectorState?.passed === true
    && journeys?.vectorState?.records === 1
    && schemas?.fixtureSchemaVersion === 1
    && schemas?.mongo?.passed === true
    && schemas?.mongo?.records === 2
    && schemas?.qdrant?.passed === true
    && schemas?.qdrant?.records === 1
    && schemas?.qdrant?.vectorSize === 4
    && HASH_PATTERN.test(String(state?.mongoFingerprint || ''))
    && HASH_PATTERN.test(String(state?.qdrantFingerprint || ''))
    && HASH_PATTERN.test(String(state?.combinedFingerprint || ''));
}

function phaseImageStatus(phase, expected) {
  return phase?.imageSetVerified === true
    && allDigests(phase?.imageDigests, PRODUCT_SERVICES)
    && PRODUCT_SERVICES.every((service) => phase.imageDigests[service] === expected?.[service]);
}

function sameIdentity(left, right) {
  return PRODUCT_SERVICES.every((service) => {
    const before = left?.identities?.[service];
    const after = right?.identities?.[service];
    return IDENTITY_KEYS.filter((key) => !['fieldSources', 'evidence'].includes(key))
      .every((key) => before?.[key] === after?.[key])
      && ['service', 'version', 'profile', 'revision']
        .every((key) => before?.fieldSources?.[key] === after?.fieldSources?.[key])
      && EVIDENCE_KEYS.every((key) => before?.evidence?.[key] === after?.evidence?.[key]);
  });
}

function sameState(left, right) {
  return ['mongoFingerprint', 'qdrantFingerprint', 'combinedFingerprint']
    .every((key) => left?.state?.[key] === right?.state?.[key]);
}

function deriveAssertionStatuses(input) {
  const before = input?.phases?.before;
  const upgraded = input?.phases?.upgraded;
  const rolledBack = input?.phases?.rolledBack;
  const expectedPreviousRevision = input?.expectedRevisions?.previous;
  const expectedCandidateRevision = input?.expectedRevisions?.candidate;
  const previousMode = input?.previousRelease?.identityEvidenceMode;
  const revisionsBound = REVISION_PATTERN.test(String(expectedPreviousRevision || ''))
    && REVISION_PATTERN.test(String(expectedCandidateRevision || ''))
    && expectedPreviousRevision !== expectedCandidateRevision;
  const immutableInputs = revisionsBound
    && previousReleaseStatus(input)
    && allDigests(input?.images?.previous, PRODUCT_SERVICES)
    && allDigests(input?.images?.candidate, PRODUCT_SERVICES)
    && allDigests(input?.images?.dependencies, ['mongo', 'qdrant'])
    && allHashes(input?.images?.referenceFingerprints?.previous, PRODUCT_SERVICES)
    && allHashes(input?.images?.referenceFingerprints?.candidate, PRODUCT_SERVICES)
    && allHashes(input?.images?.referenceFingerprints?.dependencies, ['mongo', 'qdrant']);
  const topology = input?.topology;
  const topologyPass = topology?.renderedVerified === true
    && topology?.runtimeVerified === true
    && HASH_PATTERN.test(String(topology?.composeConfigHashes?.previous || ''))
    && HASH_PATTERN.test(String(topology?.composeConfigHashes?.candidate || ''))
    && topology?.serviceCount === 5
    && topology?.internalNetworkCount === 1
    && topology?.publishedPortCount === 0
    && topology?.bindMountCount === 0
    && topology?.persistentVolumeCount === 3
    && topology?.dataContainersStable === true;
  const beforeIdentity = phaseIdentityStatus(
    before,
    expectedPreviousRevision,
    previousMode,
    true,
    input?.previousRelease?.version
  );
  const candidateIdentity = phaseIdentityStatus(
    upgraded,
    expectedCandidateRevision,
    IN_BAND_IDENTITY_MODE,
    null
  );
  const rollbackIdentity = phaseIdentityStatus(
    rolledBack,
    expectedPreviousRevision,
    previousMode,
    true,
    input?.previousRelease?.version
  )
    && sameIdentity(before, rolledBack);
  const beforeJourney = phaseJourneyStatus(before);
  const candidateJourney = phaseJourneyStatus(upgraded);
  const rollbackJourney = phaseJourneyStatus(rolledBack);

  const statuses = {
    'immutable-inputs': immutableInputs,
    'isolated-topology': topologyPass,
    'previous-image-set': phaseImageStatus(before, input?.images?.previous),
    'previous-identities': beforeIdentity,
    'previous-journeys': beforeJourney,
    'candidate-image-set': phaseImageStatus(upgraded, input?.images?.candidate),
    'candidate-identities': candidateIdentity,
    'candidate-journeys': candidateJourney,
    'upgrade-schema-compatible': beforeJourney && candidateJourney && sameState(before, upgraded),
    'rollback-image-set': phaseImageStatus(rolledBack, input?.images?.previous),
    'rollback-identities': rollbackIdentity,
    'rollback-journeys': rollbackJourney,
    'rollback-data-compatible': beforeJourney && rollbackJourney && sameState(before, rolledBack),
    'zero-residue': input?.cleanup?.verified === true
      && input?.cleanup?.containers === 0
      && input?.cleanup?.networks === 0
      && input?.cleanup?.volumes === 0,
  };
  return ASSERTION_IDS.map((id) => Object.freeze({
    id,
    status: statuses[id] === true ? 'pass' : statuses[id] === false ? 'fail' : 'not-observed',
  }));
}

function createUpgradeRollbackReceipt(input) {
  const bootstrap = input?.previousRelease?.identityEvidenceMode === LEGACY_IDENTITY_MODE;
  const normalizedInput = {
    ...input,
    evidenceClass: bootstrap ? 'release-bound-bootstrap' : 'release-bound',
    legacyBaseline: input?.legacyBaseline ?? null,
  };
  const assertions = deriveAssertionStatuses(normalizedInput);
  const assertionCodes = assertions
    .filter((entry) => entry.status !== 'pass')
    .map((entry) => ASSERTION_FAILURE_CODES[entry.id]);
  const suppliedCodes = Array.isArray(input?.failureCodes) ? input.failureCodes : [];
  const failureCodes = [...new Set([...assertionCodes, ...suppliedCodes])].sort();
  const passed = assertions.filter((entry) => entry.status === 'pass').length;
  const failed = assertions.length - passed;
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    status: failed === 0 && failureCodes.length === 0 ? 'pass' : 'fail',
    evidenceClass: normalizedInput.evidenceClass,
    generatedAt: input?.generatedAt ?? null,
    scenarioHash: input?.scenarioHash ?? null,
    profile: RECEIPT_PROFILE,
    expectedRevisions: input?.expectedRevisions ?? { previous: null, candidate: null },
    previousRelease: input?.previousRelease ?? null,
    legacyBaseline: normalizedInput.legacyBaseline,
    images: input?.images ?? null,
    topology: input?.topology ?? null,
    phases: input?.phases ?? { before: null, upgraded: null, rolledBack: null },
    cleanup: input?.cleanup ?? null,
    assertions,
    summary: { expected: ASSERTION_IDS.length, passed, failed },
    privacy: {
      addressesIncluded: false,
      identifiersIncluded: false,
      stateIncluded: 'fingerprints-and-counts-only',
      secretsIncluded: false,
    },
  };
  if (failureCodes.length) receipt.failureCodes = failureCodes;
  return Object.freeze(receipt);
}

function privacyIssues(receipt) {
  const errors = [];
  const visit = (value, key = '') => {
    const finalKey = key.split('.').at(-1)?.replace(/\[\d+\]$/, '');
    if (FORBIDDEN_KEYS.has(finalKey)) errors.push(`forbidden receipt field: ${key}`);
    if (typeof value === 'string') {
      for (const pattern of UNSAFE_STRING_PATTERNS) {
        if (pattern.test(value)) errors.push(`unsafe receipt string at ${key || '<root>'}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${key}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, key ? `${key}.${childKey}` : childKey);
      }
    }
  };
  visit(receipt);
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > MAX_RECEIPT_BYTES) {
    errors.push('receipt exceeds byte limit');
  }
  return [...new Set(errors)];
}

function identityShape(identity) {
  if (!sameKeys(identity, IDENTITY_KEYS)
    || !sameKeys(identity?.fieldSources, ['service', 'version', 'profile', 'revision'])
    || !sameKeys(identity?.evidence, EVIDENCE_KEYS)
    || ![IN_BAND_IDENTITY_MODE, LEGACY_IDENTITY_MODE].includes(identity.mode)
    || Object.values(identity.fieldSources).some((source) => !FIELD_SOURCE_VALUES.includes(source))) return false;
  const booleanOrNull = (value) => value === true || value === false || value === null;
  return (identity.evidence.httpStatus === 200 || identity.evidence.httpStatus === null)
    && Object.entries(identity.evidence)
      .filter(([key]) => key !== 'httpStatus')
      .every(([, value]) => booleanOrNull(value));
}

function phaseShape(phase) {
  if (phase == null) return true;
  if (!sameKeys(phase, [
    'imageDigests', 'imageSetVerified', 'identities', 'identityConsistent',
    'expectedRevisionVerified', 'journeys', 'schemas', 'state',
  ])) return false;
  if (!sameKeys(phase.imageDigests, PRODUCT_SERVICES)
    || !sameKeys(phase.identities, PRODUCT_SERVICES)
    || PRODUCT_SERVICES.some((service) => !identityShape(phase.identities[service]))) return false;
  return sameKeys(phase.journeys, ['coreState', 'benchmarkState', 'ragState', 'vectorState'])
    && sameKeys(phase.journeys.coreState, ['passed', 'records'])
    && sameKeys(phase.journeys.benchmarkState, ['passed', 'records'])
    && sameKeys(phase.journeys.ragState, ['passed', 'records', 'chunks'])
    && sameKeys(phase.journeys.vectorState, ['passed', 'records'])
    && sameKeys(phase.schemas, ['fixtureSchemaVersion', 'mongo', 'qdrant'])
    && sameKeys(phase.schemas.mongo, ['passed', 'records'])
    && sameKeys(phase.schemas.qdrant, ['passed', 'records', 'vectorSize'])
    && sameKeys(phase.state, ['mongoFingerprint', 'qdrantFingerprint', 'combinedFingerprint']);
}

function validateUpgradeRollbackReceipt(receipt) {
  const errors = [];
  const expectedRootKeys = receipt?.status === 'fail' ? [...PASS_ROOT_KEYS, 'failureCodes'] : [...PASS_ROOT_KEYS];
  if (!sameKeys(receipt, expectedRootKeys)) errors.push('receipt root shape is invalid');
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) errors.push('schemaVersion is invalid');
  if (receipt?.kind !== RECEIPT_KIND) errors.push('kind is invalid');
  if (!['pass', 'fail'].includes(receipt?.status)) errors.push('status is invalid');
  const expectedEvidenceClass = receipt?.previousRelease?.identityEvidenceMode === LEGACY_IDENTITY_MODE
    ? 'release-bound-bootstrap'
    : 'release-bound';
  if (receipt?.evidenceClass !== expectedEvidenceClass) errors.push('evidenceClass is inconsistent');
  if (receipt?.profile !== RECEIPT_PROFILE) errors.push('profile is invalid');
  if (!SHORT_HASH_PATTERN.test(String(receipt?.scenarioHash || ''))) errors.push('scenarioHash is invalid');
  if (!canonicalTimestamp(receipt?.generatedAt)) errors.push('generatedAt is invalid');
  if (!sameKeys(receipt?.expectedRevisions, ['previous', 'candidate'])
    || !REVISION_PATTERN.test(String(receipt?.expectedRevisions?.previous || ''))
    || !REVISION_PATTERN.test(String(receipt?.expectedRevisions?.candidate || ''))
    || receipt?.expectedRevisions?.previous === receipt?.expectedRevisions?.candidate) {
    errors.push('expectedRevisions are invalid');
  }
  if (!previousReleaseStatus(receipt)) errors.push('previousRelease binding is invalid');
  if (receipt?.legacyBaseline !== null
    && !sameKeys(receipt.legacyBaseline, ['tag', 'version', 'commit', 'manifestSha256', 'profile'])) {
    errors.push('legacyBaseline shape is invalid');
  }
  if (!sameKeys(receipt?.images, ['previous', 'candidate', 'dependencies', 'referenceFingerprints'])
    || !sameKeys(receipt?.images?.previous, PRODUCT_SERVICES)
    || !sameKeys(receipt?.images?.candidate, PRODUCT_SERVICES)
    || !sameKeys(receipt?.images?.dependencies, ['mongo', 'qdrant'])
    || !sameKeys(receipt?.images?.referenceFingerprints, ['previous', 'candidate', 'dependencies'])
    || !sameKeys(receipt?.images?.referenceFingerprints?.previous, PRODUCT_SERVICES)
    || !sameKeys(receipt?.images?.referenceFingerprints?.candidate, PRODUCT_SERVICES)
    || !sameKeys(receipt?.images?.referenceFingerprints?.dependencies, ['mongo', 'qdrant'])) {
    errors.push('images shape is invalid');
  }
  if (!sameKeys(receipt?.topology, [
    'composeConfigHashes', 'renderedVerified', 'runtimeVerified', 'serviceCount',
    'internalNetworkCount', 'publishedPortCount', 'bindMountCount',
    'persistentVolumeCount', 'dataContainersStable',
  ]) || !sameKeys(receipt?.topology?.composeConfigHashes, ['previous', 'candidate'])) {
    errors.push('topology shape is invalid');
  }
  if (!sameKeys(receipt?.phases, ['before', 'upgraded', 'rolledBack'])) errors.push('phases shape is invalid');
  for (const phase of Object.values(receipt?.phases || {})) {
    if (!phaseShape(phase)) errors.push('phase shape is invalid');
  }
  if (!sameKeys(receipt?.cleanup, ['verified', 'containers', 'networks', 'volumes'])) {
    errors.push('cleanup shape is invalid');
  }

  const expectedAssertions = deriveAssertionStatuses(receipt);
  if (JSON.stringify(receipt?.assertions) !== JSON.stringify(expectedAssertions)) {
    errors.push('assertions are inconsistent with evidence');
  }
  const passed = expectedAssertions.filter((entry) => entry.status === 'pass').length;
  const expectedSummary = { expected: ASSERTION_IDS.length, passed, failed: ASSERTION_IDS.length - passed };
  if (JSON.stringify(receipt?.summary) !== JSON.stringify(expectedSummary)) errors.push('summary is inconsistent');
  const codes = receipt?.failureCodes || [];
  if (!Array.isArray(codes) || new Set(codes).size !== codes.length
    || codes.some((code) => !FAILURE_CODES.includes(code))) errors.push('failureCodes are invalid');
  const requiredCodes = expectedAssertions
    .filter((entry) => entry.status !== 'pass')
    .map((entry) => ASSERTION_FAILURE_CODES[entry.id]);
  if (requiredCodes.some((code) => !codes.includes(code))) errors.push('failureCodes omit assertion failures');
  const shouldPass = expectedSummary.failed === 0 && codes.length === 0;
  if (receipt?.status !== (shouldPass ? 'pass' : 'fail')) errors.push('status is inconsistent');
  if (shouldPass && Object.hasOwn(receipt, 'failureCodes')) errors.push('passing receipt must omit failureCodes');
  if (!shouldPass && codes.length === 0) errors.push('failing receipt requires failureCodes');
  if (!Array.isArray(receipt?.assertions)
    || receipt.assertions.length !== ASSERTION_IDS.length
    || receipt.assertions.some((entry) => !sameKeys(entry, ['id', 'status']))) {
    errors.push('assertions shape is invalid');
  }
  if (!sameKeys(receipt?.summary, ['expected', 'passed', 'failed'])) errors.push('summary shape is invalid');
  if (!sameKeys(receipt?.privacy, ['addressesIncluded', 'identifiersIncluded', 'stateIncluded', 'secretsIncluded'])) {
    errors.push('privacy shape is invalid');
  } else if (receipt?.privacy?.addressesIncluded !== false
    || receipt?.privacy?.identifiersIncluded !== false
    || receipt?.privacy?.stateIncluded !== 'fingerprints-and-counts-only'
    || receipt?.privacy?.secretsIncluded !== false) errors.push('privacy declaration is invalid');
  errors.push(...privacyIssues(receipt));
  return [...new Set(errors)];
}

module.exports = {
  ASSERTION_IDS,
  BOOTSTRAP_BASELINE,
  DIGEST_PATTERN,
  FAILURE_CODES,
  IN_BAND_IDENTITY_MODE,
  MAX_RECEIPT_BYTES,
  PRODUCT_SERVICES,
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  createUpgradeRollbackReceipt,
  deriveAssertionStatuses,
  privacyIssues,
  validateUpgradeRollbackReceipt,
};

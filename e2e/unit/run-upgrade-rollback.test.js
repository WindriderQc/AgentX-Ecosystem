'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  composeEnvironment,
  exactImageReference,
  normalizePhaseObservation,
  parseArgs,
  runControl,
  validateRenderedTopology,
  validateRuntimeVolumeMounts,
} = require('../run-upgrade-rollback');
const {
  EXPECTED_POLICY,
  LEGACY_IDENTITY_MODE,
  baselineFromPolicy,
} = require('../upgrade-rollback-baseline');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PREVIOUS_REVISION = 'b'.repeat(40);
const CANDIDATE_REVISION = 'c'.repeat(40);

function productRef(name, digest = DIGEST) {
  return `ghcr.io/example/agentx-${name}@${digest}`;
}

function manifestBase64(values) {
  const images = Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => {
    const ref = values[`--previous-${service}-image`];
    const [image, digest] = ref.split('@');
    return [service, { image, digest, ref }];
  }));
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    product: 'Agent X Ecosystem',
    version: '1.2.3',
    tag: 'v1.2.3',
    commit: values['--expected-previous-revision'],
    images,
  }, null, 2)}\n`).toString('base64');
}

function argv(overrides = {}) {
  const values = {
    '--previous-core-image': productRef('core'),
    '--previous-benchmark-image': productRef('benchmark'),
    '--previous-rag-image': productRef('rag'),
    '--candidate-core-image': productRef('core', `sha256:${'d'.repeat(64)}`),
    '--candidate-benchmark-image': productRef('benchmark', `sha256:${'e'.repeat(64)}`),
    '--candidate-rag-image': productRef('rag', `sha256:${'f'.repeat(64)}`),
    '--expected-previous-revision': PREVIOUS_REVISION,
    '--expected-candidate-revision': CANDIDATE_REVISION,
    '--project': 'agentx-upgrade-rollback-unit-123456',
    '--output': 'test-results/upgrade-rollback.json',
    ...overrides,
  };
  if (!Object.hasOwn(values, '--previous-manifest')
    && !Object.hasOwn(values, '--previous-manifest-base64')) {
    values['--previous-manifest-base64'] = manifestBase64(values);
  }
  return Object.entries(values).flat();
}

function parse(argvValue = argv(), env = {}) {
  return parseArgs(argvValue, env, {
    dependencyPins: {
      mongoImage: exactImageReference(`mongo:7.0.34@${DIGEST}`),
      qdrantImage: exactImageReference(`qdrant/qdrant:v1.18.1@${DIGEST}`),
    },
  });
}

function renderedFixture(options, setName = 'previous') {
  const env = composeEnvironment(options, setName, {});
  const project = options.project;
  const services = {};
  for (const service of ['mongo', 'qdrant', 'core', 'benchmark', 'rag']) {
    const environmentKey = `AGENTX_UPGRADE_ROLLBACK_${service.toUpperCase()}_IMAGE`;
    services[service] = {
      image: env[environmentKey],
      networks: { 'upgrade-rollback': null },
      ...(service === 'mongo' ? { volumes: [
        { type: 'volume', source: 'mongo-data', target: '/data/db' },
        { type: 'volume', source: 'mongo-config-data', target: '/data/configdb' },
      ] } : {}),
      ...(service === 'qdrant' ? { volumes: [{ type: 'volume', source: 'qdrant-data', target: '/qdrant/storage' }] } : {}),
      ...(['core', 'benchmark', 'rag'].includes(service) ? { tmpfs: ['/tmp'] } : {}),
      ...(['core', 'benchmark', 'rag'].includes(service) ? { environment: { AGENTX_PROFILE: 'demo' } } : {}),
    };
  }
  return {
    services,
    networks: { 'upgrade-rollback': { name: `${project}_upgrade-rollback`, internal: true } },
    volumes: {
      'mongo-data': { name: `${project}_mongo-data` },
      'mongo-config-data': { name: `${project}_mongo-config-data` },
      'qdrant-data': { name: `${project}_qdrant-data` },
    },
  };
}

test('accepts exact tagless or tagged digest refs and rejects mutable-only refs', () => {
  assert.equal(exactImageReference(productRef('core')).digest, DIGEST);
  assert.equal(exactImageReference(`mongo:7.0.34@${DIGEST}`).digest, DIGEST);
  assert.equal(exactImageReference(`qdrant/qdrant:v1.18.1@${DIGEST}`).digest, DIGEST);
  assert.throws(() => exactImageReference('ghcr.io/example/agentx-core:latest'), /image@sha256/);
  assert.throws(() => exactImageReference('https://ghcr.io/example/core@sha256:' + 'a'.repeat(64)), /image@sha256|invalid repository/);
  assert.throws(() => exactImageReference('ghcr.io/example/core@sha256:' + 'A'.repeat(64)), /image@sha256/);
});

test('parses version-agnostic image sets with reviewed dependency-pin defaults', () => {
  const options = parse();
  assert.equal(options.images.previousCoreImage.ref, productRef('core'));
  assert.equal(options.images.candidateRagImage.digest, `sha256:${'f'.repeat(64)}`);
  assert.equal(options.images.mongoImage.ref, `mongo:7.0.34@${DIGEST}`);
  assert.equal(options.expectedPreviousRevision, PREVIOUS_REVISION);
  assert.equal(options.expectedCandidateRevision, CANDIDATE_REVISION);
  assert.equal(options.waitTimeoutSeconds, 300);
  assert.equal(options.previousIdentityMode, 'in-band-health');
  assert.equal(options.receiptBaseline, null);
});

test('accepts CI-provided environment refs without requiring a release version', () => {
  const environment = {
    AGENTX_UPGRADE_ROLLBACK_PREVIOUS_CORE_IMAGE: productRef('core'),
    AGENTX_UPGRADE_ROLLBACK_PREVIOUS_BENCHMARK_IMAGE: productRef('benchmark'),
    AGENTX_UPGRADE_ROLLBACK_PREVIOUS_RAG_IMAGE: productRef('rag'),
    AGENTX_UPGRADE_ROLLBACK_CANDIDATE_CORE_IMAGE: productRef('core', `sha256:${'d'.repeat(64)}`),
    AGENTX_UPGRADE_ROLLBACK_CANDIDATE_BENCHMARK_IMAGE: productRef('benchmark', `sha256:${'e'.repeat(64)}`),
    AGENTX_UPGRADE_ROLLBACK_CANDIDATE_RAG_IMAGE: productRef('rag', `sha256:${'f'.repeat(64)}`),
    AGENTX_UPGRADE_ROLLBACK_EXPECTED_PREVIOUS_REVISION: PREVIOUS_REVISION,
    AGENTX_UPGRADE_ROLLBACK_EXPECTED_CANDIDATE_REVISION: CANDIDATE_REVISION,
    AGENTX_UPGRADE_ROLLBACK_PREVIOUS_MANIFEST_BASE64: manifestBase64({
      '--previous-core-image': productRef('core'),
      '--previous-benchmark-image': productRef('benchmark'),
      '--previous-rag-image': productRef('rag'),
      '--expected-previous-revision': PREVIOUS_REVISION,
    }),
    AGENTX_UPGRADE_ROLLBACK_OUTPUT: 'receipt.json',
  };
  const options = parse([], environment);
  assert.match(options.project, /^agentx-upgrade-rollback-/);
  assert.equal(options.expectedPreviousRevision, PREVIOUS_REVISION);
  assert.equal(options.expectedCandidateRevision, CANDIDATE_REVISION);
});

test('enables the legacy lane only for exact v0.1.1 manifest and wrapper inputs', () => {
  const baseline = baselineFromPolicy(EXPECTED_POLICY);
  const fixture = path.join(__dirname, '..', 'fixtures', 'upgrade-rollback-v0.1.1-images.json');
  const wrapper = path.join(
    __dirname,
    '..',
    'fixtures',
    'upgrade-rollback-v0.1.1-previous-release-baseline.json'
  );
  const legacyArgs = argv({
    '--previous-core-image': baseline.services.core.ref,
    '--previous-benchmark-image': baseline.services.benchmark.ref,
    '--previous-rag-image': baseline.services.rag.ref,
    '--expected-previous-revision': baseline.commit,
    '--previous-manifest': fixture,
    '--previous-baseline': wrapper,
  });
  const options = parse(legacyArgs);
  assert.equal(options.previousIdentityMode, LEGACY_IDENTITY_MODE);
  assert.equal(options.previousManifest.manifestSha256, baseline.manifestSha256);
  assert.equal(options.previousBaseline.identityEvidenceMode, LEGACY_IDENTITY_MODE);
  assert.equal(options.receiptBaseline.commit, baseline.commit);

  const strictWithoutWrapper = parse(argv({
    '--previous-core-image': baseline.services.core.ref,
    '--previous-benchmark-image': baseline.services.benchmark.ref,
    '--previous-rag-image': baseline.services.rag.ref,
    '--expected-previous-revision': baseline.commit,
    '--previous-manifest': fixture,
  }));
  assert.equal(strictWithoutWrapper.previousIdentityMode, 'in-band-health');
  assert.equal(strictWithoutWrapper.previousBaseline, null);

  const changedBytes = Buffer.concat([fs.readFileSync(fixture), Buffer.from(' ')]).toString('base64');
  assert.throws(() => parse(argv({
    '--previous-core-image': baseline.services.core.ref,
    '--previous-benchmark-image': baseline.services.benchmark.ref,
    '--previous-rag-image': baseline.services.rag.ref,
    '--expected-previous-revision': baseline.commit,
    '--previous-manifest-base64': changedBytes,
    '--previous-baseline': wrapper,
  })), /byte hash is not exact/);
});

test('rejects duplicate, ambiguous, weakened, or non-unique inputs', () => {
  assert.throws(() => parse([...argv(), '--output', 'again.json']), /too many command-line arguments|duplicate argument/);
  assert.throws(() => parse(argv({ '--previous-core-image': 'ghcr.io/example/core:latest' })), /image@sha256/);
  assert.throws(() => parse(argv({ '--expected-candidate-revision': 'working-tree' })), /full lowercase commit SHA/);
  assert.throws(() => parse(argv({ '--project': 'agentx-ecosystem' })), /unique agentx-upgrade-rollback/);
  assert.throws(() => parse(argv({ '--wait-timeout-seconds': '29' })), /between 30 and 900/);
  assert.throws(
    () => parse(argv({ '--expected-candidate-revision': PREVIOUS_REVISION })),
    /must be distinct/
  );
});

test('validates the exact rendered digest-only isolated topology', () => {
  const options = parse();
  const rendered = renderedFixture(options);
  const refs = {
    mongo: options.images.mongoImage.ref,
    qdrant: options.images.qdrantImage.ref,
    core: options.images.previousCoreImage.ref,
    benchmark: options.images.previousBenchmarkImage.ref,
    rag: options.images.previousRagImage.ref,
  };
  assert.deepEqual(validateRenderedTopology(rendered, { project: options.project, refs }), []);

  const unsafe = structuredClone(rendered);
  unsafe.services.core.build = { context: '.' };
  unsafe.services.core.ports = [{ target: 3080, published: 3180 }];
  unsafe.services.rag.volumes = [{ type: 'bind', source: '.', target: '/workspace' }];
  unsafe.networks['upgrade-rollback'].internal = false;
  assert.match(validateRenderedTopology(unsafe, { project: options.project, refs }).join('\n'), /build definition/);
  assert.match(validateRenderedTopology(unsafe, { project: options.project, refs }).join('\n'), /publishes a port/);
  assert.match(validateRenderedTopology(unsafe, { project: options.project, refs }).join('\n'), /bind/);
  assert.match(validateRenderedTopology(unsafe, { project: options.project, refs }).join('\n'), /not one internal/);
});

test('requires the Mongo image-declared config volume to be explicitly project-scoped', () => {
  const project = 'agentx-upgrade-rollback-unit-123456';
  const valid = validateRuntimeVolumeMounts([
    { Type: 'volume', Name: `${project}_mongo-data`, Destination: '/data/db' },
    { Type: 'volume', Name: `${project}_mongo-config-data`, Destination: '/data/configdb' },
  ], { project, service: 'mongo' });
  assert.deepEqual(valid.errors, []);

  const anonymous = validateRuntimeVolumeMounts([
    { Type: 'volume', Name: `${project}_mongo-data`, Destination: '/data/db' },
    { Type: 'volume', Name: 'a'.repeat(64), Destination: '/data/configdb' },
  ], { project, service: 'mongo' });
  assert.match(anonymous.errors.join('\n'), /unexpected named volume/);
  assert.match(anonymous.errors.join('\n'), /missing a required named volume/);
});

test('uses Qdrant exact cosine-normalized float32 semantics without tolerance', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'upgrade-rollback-control.js'),
    'utf8'
  );
  const input = [0.1, 0.2, 0.3, 0.4];
  const magnitude = Math.hypot(...input);
  const canonical = Array.from(Float32Array.from(input.map((value) => value / magnitude)));
  const qdrantJsonRoundTrip = Array.from(Float32Array.from([
    0.18257418,
    0.36514837,
    0.5477226,
    0.73029673,
  ]));

  assert.deepEqual(canonical, [
    0.18257418274879456,
    0.3651483654975891,
    0.547722578048706,
    0.7302967309951782,
  ]);
  assert.deepEqual(qdrantJsonRoundTrip, canonical);
  assert.notDeepEqual(canonical, input);
  assert.match(source, /VECTOR_MAGNITUDE = Math\.hypot\(\.\.\.VECTOR\)/);
  assert.match(source, /VECTOR\.map\(\(value\) => value \/ VECTOR_MAGNITUDE\)/);
  assert.match(source, /observedQdrantVector = Array\.from\(Float32Array\.from\(point\?\.vector \|\| \[\]\)\)/);
  assert.match(source, /JSON\.stringify\(observedQdrantVector\) === JSON\.stringify\(CANONICAL_QDRANT_VECTOR\)/);
  assert.doesNotMatch(source, /Math\.abs\([^\n]+point\?\.vector|Number\.EPSILON/);
});

test('normalizes only privacy-safe identity, count, boolean, and fingerprint fields', () => {
  const identities = Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [service, {
    httpStatus: 200,
    healthyStatusVerified: true,
    okFieldPresent: true,
    ok: true,
    service: `agentx-${service}`,
    serviceVerified: true,
    fields: {
      version: { present: true, value: '0.1.1' },
      profile: { present: true, value: 'demo' },
      revision: { present: true, value: CANDIDATE_REVISION },
    },
    rawContent: 'must not survive',
  }]));
  const runtimeEvidence = Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [service, {
    runtimeDigestVerified: true,
    renderedProfileVerified: true,
    runtimeProfileVerified: true,
  }]));
  const observation = normalizePhaseObservation({
    identities,
    journeys: {
      coreState: { passed: true, records: 1, rawContent: 'hidden' },
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
      mongoFingerprint: '1'.repeat(64),
      qdrantFingerprint: '2'.repeat(64),
      combinedFingerprint: '3'.repeat(64),
      rawContent: 'hidden',
    },
  }, {
    digests: { core: DIGEST, benchmark: DIGEST, rag: DIGEST },
    imageSetVerified: true,
    expectedRevision: CANDIDATE_REVISION,
    identityMode: 'in-band-health',
    runtimeEvidence,
    manifestBindingVerified: null,
  });

  assert.equal(observation.identityConsistent, true);
  assert.equal(observation.expectedRevisionVerified, true);
  assert.doesNotMatch(JSON.stringify(observation), /rawContent|must not survive|hidden/);
});

test('supplements only missing legacy fields and rejects present disagreement', () => {
  const baseline = baselineFromPolicy(EXPECTED_POLICY);
  const health = Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [service, {
    httpStatus: 200,
    healthyStatusVerified: true,
    okFieldPresent: false,
    ok: null,
    service: `agentx-${service}`,
    serviceVerified: true,
    fields: {
      version: { present: false, value: null },
      profile: { present: false, value: null },
      revision: { present: false, value: null },
    },
  }]));
  health.core.okFieldPresent = true;
  health.core.ok = true;
  health.core.fields.version = { present: true, value: baseline.version };
  health.rag.okFieldPresent = true;
  health.rag.ok = true;
  const runtimeEvidence = Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [service, {
    runtimeDigestVerified: true,
    renderedProfileVerified: true,
    runtimeProfileVerified: true,
    ociRevision: baseline.commit,
    ociVersion: baseline.oci.version,
    ociSource: baseline.oci.source,
    packagedVersion: baseline.version,
  }]));
  const options = {
    digests: Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [service, baseline.services[service].digest])),
    imageSetVerified: true,
    expectedRevision: baseline.commit,
    identityMode: LEGACY_IDENTITY_MODE,
    runtimeEvidence,
    legacyBaseline: baseline,
    manifestBindingVerified: true,
  };
  const compatible = normalizePhaseObservation({ identities: health }, options);
  assert.equal(compatible.identityConsistent, true);
  assert.equal(compatible.expectedRevisionVerified, true);
  assert.equal(compatible.identities.core.version, '0.1.1');
  assert.equal(compatible.identities.core.fieldSources.version, 'live-health');
  assert.equal(compatible.identities.benchmark.fieldSources.version, 'packaged-package-json');
  assert.equal(compatible.identities.core.fieldSources.revision, 'oci-revision-label');

  const disagreement = structuredClone(health);
  disagreement.core.fields.version = { present: true, value: '9.9.9' };
  const rejected = normalizePhaseObservation({ identities: disagreement }, options);
  assert.equal(rejected.identityConsistent, false);
  assert.equal(rejected.expectedRevisionVerified, false);
  assert.equal(rejected.identities.core.version, '9.9.9');
  assert.equal(rejected.identities.core.fieldSources.version, 'live-health');
});

test('requires exactly one marked bounded control result', () => {
  const options = parse();
  const command = (_program, _args, callOptions) => {
    assert.match(callOptions.input, /MODE/);
    return 'noise\nAGENTX_UPGRADE_ROLLBACK_CONTROL={"seeded":true,"schemaVersion":1}\n';
  };
  assert.deepEqual(runControl(command, options, 'previous', 'seed', 'const MODE = true;'), {
    seeded: true,
    schemaVersion: 1,
  });
  assert.throws(
    () => runControl(() => 'no marker\n', options, 'previous', 'seed', 'source'),
    /did not emit one bounded result/
  );
});

test('the committed topology contains no build, published port, bind mount, or global name', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.upgrade-rollback.yml'), 'utf8');
  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /^\s*container_name:/m);
  assert.doesNotMatch(compose, /^\s*extra_hosts:/m);
  assert.doesNotMatch(compose, /(?:^|\s)-\s*\.[:/]/m);
  assert.match(compose, /upgrade-rollback:\r?\n\s+internal: true/);
  for (const service of ['CORE', 'BENCHMARK', 'RAG', 'MONGO', 'QDRANT']) {
    assert.match(compose, new RegExp(`AGENTX_UPGRADE_ROLLBACK_${service}_IMAGE:\\?`));
  }
});

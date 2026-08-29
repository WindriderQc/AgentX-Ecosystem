'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ASSERTION_KEYS,
  validateRecoveryDrillReceipt,
} = require('../shared/recoveryDrillReceiptContract');

const {
  PINNED_HELPER_IMAGE,
  PINNED_MONGODB_IMAGE,
  PINNED_QDRANT_IMAGE,
  assertPinnedImageReference,
  buildReceipt,
  imageDigestFromReference,
  loadDependencyPins,
  parseArgs,
  proveCorruptedBundleFailsClosed,
  renderAndValidateTopology,
  removeWorkspace,
} = require('./run-recovery-drill');

const ROOT = path.resolve(__dirname, '..');
const REVISION = '8a128176b44230cfef77e359e0c15b3a9df16eb1';
const productRef = (service, character) => `ghcr.io/example/agentx-${service}:v0.1.1@sha256:${character.repeat(64)}`;

function argv(overrides = {}) {
  const values = {
    '--output': path.join(os.tmpdir(), `agentx-recovery-receipt-${process.pid}-${Math.random()}.json`),
    '--expected-candidate-revision': REVISION,
    '--candidate-core-image': productRef('core', '1'),
    '--candidate-benchmark-image': productRef('benchmark', '2'),
    '--candidate-rag-image': productRef('rag', '3'),
    '--run-scope': 'unit-test-1234',
    ...overrides,
  };
  return Object.entries(values).flat();
}

test('loads the exact reviewed dependency and helper refs from the one pin inventory', () => {
  const pins = loadDependencyPins();
  assert.equal(pins.mongodb.reference, PINNED_MONGODB_IMAGE);
  assert.equal(pins.qdrant.reference, PINNED_QDRANT_IMAGE);
  assert.equal(pins.transportHelper.reference, PINNED_HELPER_IMAGE);
  assert.equal(pins.mongodb.version, '7.0.34');
  assert.equal(pins.qdrant.version, '1.18.1');
  assert.equal(pins.transportHelper.version, '20.20.2');
  assert.match(pins.transportHelper.reference, /^node:20\.20\.2-slim@sha256:[0-9a-f]{64}$/);
  assert.match(PINNED_MONGODB_IMAGE, /^mongo:7\.0\.34@sha256:[0-9a-f]{64}$/);
  assert.match(PINNED_QDRANT_IMAGE, /^qdrant\/qdrant:v1\.18\.1@sha256:[0-9a-f]{64}$/);
});

test('requires exact product image refs, revision, and a new receipt destination', () => {
  const options = parseArgs(argv());
  assert.equal(options.productRevision, REVISION);
  assert.equal(options.productProfile, 'demo');
  assert.equal(options.coreImage, productRef('core', '1'));
  assert.equal(options.mongodbImage, PINNED_MONGODB_IMAGE);
  assert.equal(options.qdrantImage, PINNED_QDRANT_IMAGE);
  assert.equal(options.helperImage, PINNED_HELPER_IMAGE);
  assert.equal(options.runScope, 'unit-test-1234');

  assert.throws(() => parseArgs(argv({ '--candidate-core-image': `sha256:${'1'.repeat(64)}` })), /name@sha256/);
  assert.throws(() => parseArgs(argv({ '--candidate-rag-image': 'ghcr.io/example/rag:latest' })), /name@sha256/);
  assert.throws(() => parseArgs(argv({ '--expected-candidate-revision': 'short' })), /full lowercase Git revision/);
  assert.throws(
    () => parseArgs(argv({ '--mongo-image': `mongo:7.0.34@sha256:${'f'.repeat(64)}` })),
    /must match config\/container-image-pins\.json/
  );
  assert.throws(
    () => parseArgs([...argv(), '--receipt', path.join(os.tmpdir(), 'duplicate-receipt.json')]),
    /conflicts with another value for receiptPath/
  );
});

test('parses tagged and tagless immutable refs but rejects floating and malformed refs', () => {
  const tagged = productRef('core', 'a');
  assert.equal(assertPinnedImageReference(tagged, 'test'), tagged);
  assert.equal(imageDigestFromReference(tagged, 'test'), `sha256:${'a'.repeat(64)}`);
  assert.equal(
    assertPinnedImageReference(`registry.example/repository@sha256:${'b'.repeat(64)}`, 'test'),
    `registry.example/repository@sha256:${'b'.repeat(64)}`
  );
  for (const invalid of ['mongo:7', 'mongo@sha256:short', 'MONGO:7@sha256:' + 'a'.repeat(64), '../mongo@sha256:' + 'a'.repeat(64)]) {
    assert.throws(() => assertPinnedImageReference(invalid, 'test'), /exact lowercase/);
  }
});

test('the isolated topology has exact services, no host port, no bind, and required image inputs', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.recovery-drill.yml'), 'utf8');
  const serviceHeaders = [...compose.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(serviceHeaders.slice(0, 6).sort(), ['benchmark', 'core', 'helper', 'mongo', 'qdrant', 'rag']);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.doesNotMatch(compose, /container_name:|network_mode:|extra_hosts:|privileged:/);
  assert.doesNotMatch(compose, /(?:^|\s)(?:\.\/|\/|[A-Za-z]:\\).*:/);
  assert.match(compose, /default:\s*\r?\n\s+internal: true/);
  for (const variable of [
    'AGENTX_RECOVERY_DRILL_MONGODB_IMAGE',
    'AGENTX_RECOVERY_DRILL_QDRANT_IMAGE',
    'AGENTX_RECOVERY_DRILL_HELPER_IMAGE',
    'AGENTX_RECOVERY_DRILL_CORE_IMAGE',
    'AGENTX_RECOVERY_DRILL_BENCHMARK_IMAGE',
    'AGENTX_RECOVERY_DRILL_RAG_IMAGE',
  ]) assert.match(compose, new RegExp(`\\$\\{${variable}:\\?`));
  const helper = compose.slice(compose.indexOf('\n  helper:'), compose.indexOf('\n  core:'));
  assert.match(helper, /command:\s*\["sleep", "infinity"\]/);
});

test('renders and hashes the exact six-service recovery topology', () => {
  const topology = renderAndValidateTopology(parseArgs(argv()));
  assert.match(topology.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(topology, {
    sha256: topology.sha256,
    services: 6,
    publishedPorts: 0,
    hostBindMounts: 0,
  });
});

test('uses exact cosine-normalized float32 vector evidence without tolerance', () => {
  const source = fs.readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'recovery-drill-control.js'), 'utf8');
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
  assert.match(source, /VECTOR_MAGNITUDE = Math\.hypot\(\.\.\.VECTOR\)/);
  assert.match(source, /VECTOR\.map\(\(value\) => value \/ VECTOR_MAGNITUDE\)/);
  assert.match(source, /observedQdrantVector = Array\.from\(Float32Array\.from\(point\?\.vector \|\| \[\]\)\)/);
  assert.match(source, /JSON\.stringify\(observedQdrantVector\) === JSON\.stringify\(CANONICAL_QDRANT_VECTOR\)/);
  assert.doesNotMatch(source, /Math\.abs\([^\n]+point\?\.vector|Number\.EPSILON/);
});

test('corrupted-bundle gate rejects before mutation and proves the target hash is unchanged', async () => {
  let inspections = 0;
  let mutations = 0;
  const state = {
    mongodb: { records: 0, collections: 0, sha256: 'a'.repeat(64) },
    qdrant: { records: 0, collections: 0, sha256: 'b'.repeat(64) },
  };
  const result = await proveCorruptedBundleFailsClosed({
    corruptedPath: 'not-read-by-stub',
    expectedProductRevision: REVISION,
    verify: async () => {
      const error = new Error('digest mismatch');
      error.code = 'RECOVERY_BUNDLE_INTEGRITY';
      throw error;
    },
    inspectTarget: async () => {
      inspections += 1;
      return state;
    },
    mutateTarget: async () => { mutations += 1; },
  });
  assert.deepEqual(result, { rejected: true, unchanged: true });
  assert.equal(inspections, 2);
  assert.equal(mutations, 0);
});

test('builds a privacy-safe receipt that binds topology, five images, and product journeys', () => {
  const options = parseArgs(argv());
  const state = {
    mongodb: { records: 2, collections: 2, sha256: 'a'.repeat(64) },
    qdrant: { records: 1, points: 1, sha256: 'b'.repeat(64) },
  };
  const productProof = {
    identities: Object.fromEntries([
      ['core', 'agentx-core'],
      ['benchmark', 'agentx-benchmark'],
      ['rag', 'agentx-rag'],
    ].map(([key, service]) => [key, {
      service,
      version: options.productVersion,
      profile: options.productProfile,
      revision: options.productRevision,
    }])),
    journeys: { prompt: true, rag: true, benchmark: true, vector: true, browser: true },
    schemas: { mongo: true, qdrant: true },
  };
  const receipt = buildReceipt({
    options,
    topology: { sha256: 'c'.repeat(64), services: 6, publishedPorts: 0, hostBindMounts: 0 },
    bundle: { bundleId: '123e4567-e89b-42d3-a456-426614174000', manifestSha256: 'd'.repeat(64) },
    versions: {
      mongodb: { serverVersion: '7.0.34', toolsVersion: '100.17.0' },
      qdrant: { serverVersion: '1.18.1' },
      transportHelper: { version: '20.20.2' },
    },
    measurements: { captureMs: 1, corruptionGateMs: 1, restoreMs: 1, totalMs: 4 },
    sourceState: state,
    restoredState: state,
    productProof,
    assertions: Object.fromEntries(ASSERTION_KEYS.map((key) => [key, true])),
  });
  assert.equal(validateRecoveryDrillReceipt(receipt).valid, true);
  assert.deepEqual(Object.keys(receipt.sourceImages), ['core', 'benchmark', 'rag', 'mongodb', 'qdrant']);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /https?:\/\/|mongodb(?:\+srv)?:\/\/|localhost|127\.0\.0\.1/i);
  for (const forbidden of [
    'agentx_recovery_fixture',
    'Agent X recovery fixture',
    'Deterministic product recovery state.',
    'systemPrompt',
    'originalText',
    'MONGODB_URI',
    'QDRANT_URL',
  ]) assert.equal(serialized.includes(forbidden), false, `receipt disclosed ${forbidden}`);
});

test('corrupted-bundle gate fails closed if verification unexpectedly accepts', async () => {
  await assert.rejects(
    proveCorruptedBundleFailsClosed({
      corruptedPath: 'not-read-by-stub',
      expectedProductRevision: REVISION,
      verify: async () => ({ valid: true }),
      inspectTarget: async () => ({
        mongodb: { records: 0, collections: 0, sha256: 'a'.repeat(64) },
        qdrant: { records: 0, collections: 0, sha256: 'b'.repeat(64) },
      }),
    }),
    (error) => error.code === 'RECOVERY_DRILL_NEGATIVE_GATE'
  );
});

test('corrupted-bundle gate rejects even empty collection residue', async () => {
  let inspection = 0;
  await assert.rejects(
    proveCorruptedBundleFailsClosed({
      corruptedPath: 'not-read-by-stub',
      expectedProductRevision: REVISION,
      verify: async () => {
        const error = new Error('digest mismatch');
        error.code = 'RECOVERY_BUNDLE_INTEGRITY';
        throw error;
      },
      inspectTarget: async () => {
        inspection += 1;
        return {
          mongodb: {
            records: 0,
            collections: inspection === 1 ? 0 : 1,
            sha256: (inspection === 1 ? 'a' : 'c').repeat(64),
          },
          qdrant: { records: 0, collections: 0, sha256: 'b'.repeat(64) },
        };
      },
    }),
    (error) => error.code === 'RECOVERY_DRILL_NEGATIVE_GATE'
  );
});

test('capture/restore source orders quiescence and verification before mutations', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'run-recovery-drill.js'), 'utf8');
  const runStart = source.indexOf('async function runRecoveryDrill');
  const run = source.slice(runStart);
  assert.ok(run.indexOf('stopProductWriters(projects.source') < run.indexOf('captureBundle({'));
  assert.ok(run.indexOf('cleanupProject(projects.source') < run.indexOf('restoreMongo(projects.positive'));
  const positiveVerify = run.indexOf("bundlePath: bundle.bundlePath", run.indexOf('const restoreStarted'));
  assert.ok(positiveVerify >= 0 && positiveVerify < run.indexOf('restoreMongo(projects.positive'));
  assert.ok(run.indexOf('restoreMongo(projects.positive') < run.indexOf('startProductServices(projects.positive'));
  assert.match(run, /cleanupProject\(projects\.positive/);
  assert.match(source, /\['down', '--volumes', '--remove-orphans'/);
});

test('workspace cleanup accepts only the exact generated temp scope', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-recovery-drill-'));
  fs.writeFileSync(path.join(workspace, 'fixture'), 'bounded');
  removeWorkspace(workspace);
  assert.equal(fs.existsSync(workspace), false);
  assert.throws(() => removeWorkspace(os.tmpdir()), /refusing/);
});

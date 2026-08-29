#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CAPTURE_MODE,
  COMPATIBILITY_MODE,
  IMAGE_DIGEST_PATTERN,
  OBSERVED_STOPPED_WRITERS,
  PRODUCT_CONFIG_SOURCE_IDS,
  PRODUCT_NAME,
  PRODUCT_PROFILES,
  RECOVERY_ARTIFACTS,
  RECOVERY_BUNDLE_EXCLUSIONS,
  RECOVERY_BUNDLE_SCHEMA,
  SEMVER_PATTERN,
} = require('../shared/recoveryBundleContract');
const {
  ASSERTION_KEYS,
  RECOVERY_DRILL_OUTCOME,
  RECOVERY_DRILL_RECEIPT_SCHEMA,
  assertRecoveryDrillReceipt,
} = require('../shared/recoveryDrillReceiptContract');
const { verifyRecoveryBundle } = require('./verify-recovery-bundle');

const ROOT = path.resolve(__dirname, '..');
const DRILL_COMPOSE_FILE = path.join(ROOT, 'docker-compose.recovery-drill.yml');
const PRODUCT_CONTROL_FILE = path.join(ROOT, 'e2e', 'fixtures', 'recovery-drill-control.js');
const IMAGE_PIN_INVENTORY_PATH = path.join(ROOT, 'config', 'container-image-pins.json');
const MONGODB_DATABASE = 'agentx_product';
const QDRANT_COLLECTION = 'agentx_product_embeddings';
const MONGO_SENTINEL = 'AGENTX_RECOVERY_DRILL_STATE=';
const PRODUCT_CONTROL_SENTINEL = 'AGENTX_RECOVERY_PRODUCT_PROOF=';
const MONGO_COLLECTIONS = Object.freeze([
  'promptconfigs',
  'benchmarktemplates',
]);
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180000;
const QDRANT_TIMEOUT_MS = 120000;
const RUN_SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{5,24}$/;
const PROJECT_PATTERN = /^agentx-rd-[a-z0-9][a-z0-9-]{5,24}-(?:source|negative|positive)$/;
const PINNED_IMAGE_PATTERN = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::[a-z0-9][a-z0-9._-]{0,127})?@sha256:[0-9a-f]{64}$/;

function required(condition, message, code = 'RECOVERY_DRILL_INVALID') {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function elapsedMs(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1000000n);
}

function assertPinnedImageReference(value, label) {
  required(
    typeof value === 'string' && PINNED_IMAGE_PATTERN.test(value),
    `${label} must be an exact lowercase name@sha256:<64 hex> image reference`,
    'RECOVERY_DRILL_IMAGE_IDENTITY'
  );
  return value;
}

function imageDigestFromReference(value, label) {
  assertPinnedImageReference(value, label);
  const digest = value.slice(value.lastIndexOf('@') + 1);
  required(IMAGE_DIGEST_PATTERN.test(digest), `${label} digest is invalid`, 'RECOVERY_DRILL_IMAGE_IDENTITY');
  return digest;
}

function loadDependencyPins(inventoryPath = IMAGE_PIN_INVENTORY_PATH) {
  let inventory;
  try {
    inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  } catch (error) {
    required(false, `container image pin inventory cannot be read: ${error.message}`, 'RECOVERY_DRILL_IMAGE_IDENTITY');
  }
  required(inventory?.schemaVersion === 1, 'container image pin inventory schemaVersion must be 1');
  const descriptors = {
    mongodb: inventory?.images?.mongodb,
    qdrant: inventory?.images?.qdrant,
    transportHelper: inventory?.images?.['recovery-helper'],
  };
  for (const [key, descriptor] of Object.entries(descriptors)) {
    assertPinnedImageReference(descriptor?.reference, `${key} inventory image`);
    required(SEMVER_PATTERN.test(descriptor?.version || ''), `${key} inventory version must be SemVer`);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, Object.freeze({
      reference: descriptor.reference,
      version: descriptor.version,
      digest: imageDigestFromReference(descriptor.reference, `${key} inventory image`),
    })])
  ));
}

const DEPENDENCY_PINS = loadDependencyPins();
const PINNED_MONGODB_IMAGE = DEPENDENCY_PINS.mongodb.reference;
const PINNED_QDRANT_IMAGE = DEPENDENCY_PINS.qdrant.reference;
const PINNED_HELPER_IMAGE = DEPENDENCY_PINS.transportHelper.reference;

function runCommand(command, args, options = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    input = undefined,
    inputFile = null,
    outputFile = null,
    label = command,
    timeout = COMMAND_TIMEOUT_MS,
  } = options;
  required(!(input !== undefined && inputFile), `${label} cannot use both input and inputFile`);

  let resolvedInput = input;
  if (inputFile) {
    const stat = fs.statSync(inputFile);
    required(stat.isFile(), `${label} input must be a regular file`);
    required(stat.size <= MAX_COMMAND_OUTPUT_BYTES, `${label} input exceeds the drill limit`);
    resolvedInput = fs.readFileSync(inputFile);
  }

  const result = spawnSync(command, args, {
    cwd,
    env,
    input: resolvedInput,
    encoding: null,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout,
    windowsHide: true,
    shell: false,
  });

  if (result.error || result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim().slice(-2000)
      : '';
    const suffix = detail ? `: ${detail}` : '';
    const error = new Error(`${label} failed${suffix}`);
    error.code = 'RECOVERY_DRILL_COMMAND_FAILED';
    error.exitCode = result.status;
    throw error;
  }

  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  required(stdout.length <= MAX_COMMAND_OUTPUT_BYTES, `${label} output exceeds the drill limit`);
  if (outputFile) {
    fs.writeFileSync(outputFile, stdout, { flag: 'wx', mode: 0o600 });
  }
  return stdout;
}

function commandText(command, args, options = {}) {
  return runCommand(command, args, options).toString('utf8');
}

function composeEnvironment(options) {
  return {
    ...process.env,
    AGENTX_RECOVERY_DRILL_MONGODB_IMAGE: options.mongodbImage,
    AGENTX_RECOVERY_DRILL_QDRANT_IMAGE: options.qdrantImage,
    AGENTX_RECOVERY_DRILL_HELPER_IMAGE: options.helperImage,
    AGENTX_RECOVERY_DRILL_CORE_IMAGE: options.coreImage,
    AGENTX_RECOVERY_DRILL_BENCHMARK_IMAGE: options.benchmarkImage,
    AGENTX_RECOVERY_DRILL_RAG_IMAGE: options.ragImage,
    AGENTX_RECOVERY_DRILL_PRODUCT_PROFILE: options.productProfile,
    COMPOSE_STATUS_STDOUT: '1',
    NO_COLOR: '1',
  };
}

function composeCommand(project, options, args, commandOptions = {}) {
  required(PROJECT_PATTERN.test(project), 'refusing an unscoped recovery drill project name');
  return runCommand(
    'docker',
    ['compose', '--file', DRILL_COMPOSE_FILE, '--project-name', project, ...args],
    {
      ...commandOptions,
      env: composeEnvironment(options),
      label: commandOptions.label || `recovery drill Compose ${args[0] || 'command'}`,
    }
  );
}

function composeText(project, options, args, commandOptions = {}) {
  return composeCommand(project, options, args, commandOptions).toString('utf8');
}

function expectedImageReferences(options) {
  return {
    mongo: options.mongodbImage,
    qdrant: options.qdrantImage,
    helper: options.helperImage,
    core: options.coreImage,
    benchmark: options.benchmarkImage,
    rag: options.ragImage,
  };
}

function renderAndValidateTopology(options) {
  const project = 'agentx-rd-000000000000-source';
  const renderedBytes = composeText(project, options, ['config', '--format', 'json'], {
    label: 'recovery drill topology render',
  });
  let rendered;
  try {
    rendered = JSON.parse(renderedBytes);
  } catch {
    required(false, 'recovery drill topology did not render as JSON', 'RECOVERY_DRILL_TOPOLOGY');
  }
  const expectedRefs = expectedImageReferences(options);
  const services = rendered?.services || {};
  required(
    JSON.stringify(Object.keys(services).sort())
      === JSON.stringify(['benchmark', 'core', 'helper', 'mongo', 'qdrant', 'rag']),
    'rendered recovery drill service set is not exact',
    'RECOVERY_DRILL_TOPOLOGY'
  );
  for (const [service, reference] of Object.entries(expectedRefs)) {
    const definition = services[service];
    required(definition?.image === reference, `${service} rendered image reference does not match`);
    required(definition.build == null && definition.container_name == null, `${service} rendered topology is not image-only and project-scoped`);
    required(!Array.isArray(definition.ports) || definition.ports.length === 0, `${service} publishes a port`);
    required(definition.network_mode == null && definition.privileged !== true, `${service} uses an unsafe runtime mode`);
    required(definition.extra_hosts == null && definition.devices == null && definition.secrets == null, `${service} has an unsupported attachment`);
    for (const mount of definition.volumes || []) {
      required(mount?.type !== 'bind', `${service} contains a host bind mount`);
      if (mount?.type === 'volume') {
        required(['mongodb_data', 'qdrant_data'].includes(mount.source), `${service} contains an unexpected volume`);
      } else {
        required(mount?.type === 'tmpfs', `${service} contains an unsupported mount type`);
      }
    }
  }
  const networks = rendered?.networks || {};
  required(Object.keys(networks).length === 1, 'recovery drill must render exactly one network');
  const network = Object.values(networks)[0];
  required(network?.internal === true && network?.external !== true, 'recovery drill network must be internal');
  const volumes = rendered?.volumes || {};
  required(
    JSON.stringify(Object.keys(volumes).sort()) === JSON.stringify(['mongodb_data', 'qdrant_data']),
    'recovery drill volume set is not exact'
  );
  for (const definition of Object.values(volumes)) {
    required(definition?.external !== true, 'recovery drill volume must be project-scoped');
  }
  const canonical = `${JSON.stringify(canonicalize(rendered))}\n`;
  return {
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    services: 6,
    publishedPorts: 0,
    hostBindMounts: 0,
  };
}

const INTERNAL_HTTP_HELPER = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
  "const body = input.bodyBase64 == null ? undefined : Buffer.from(input.bodyBase64, 'base64');",
  "fetch('http://qdrant:6333' + input.route, {",
  '  method: input.method,',
  '  headers: input.headers,',
  '  body,',
  '  signal: AbortSignal.timeout(120000),',
  '}).then(async (response) => {',
  '  const bytes = Buffer.from(await response.arrayBuffer());',
  '  if (bytes.length > 67108864) throw new Error("response exceeds helper limit");',
  '  process.stdout.write(JSON.stringify({ status: response.status, bodyBase64: bytes.toString("base64") }));',
  '}).catch(() => process.exit(71));',
].join('\n');

function qdrantRequest(project, drillOptions, route, options = {}) {
  const {
    method = 'GET',
    body = undefined,
    headers = undefined,
    allowedStatuses = [200],
    expectJson = true,
  } = options;
  const bodyBuffer = body === undefined
    ? null
    : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  required(!bodyBuffer || bodyBuffer.length <= MAX_SNAPSHOT_BYTES, 'Qdrant request exceeds the drill limit');
  const request = JSON.stringify({
    route,
    method,
    headers,
    bodyBase64: bodyBuffer ? bodyBuffer.toString('base64') : null,
  });
  const output = composeText(project, drillOptions, [
    'exec', '--no-TTY', 'helper', 'node', '-e', INTERNAL_HTTP_HELPER,
  ], {
    input: request,
    label: 'internal Qdrant transport',
    timeout: QDRANT_TIMEOUT_MS,
  });
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    required(false, 'internal Qdrant transport returned an invalid envelope', 'RECOVERY_DRILL_QDRANT');
  }
  required(allowedStatuses.includes(envelope.status), `Qdrant request returned HTTP ${envelope.status}`, 'RECOVERY_DRILL_QDRANT');
  const bytes = Buffer.from(envelope.bodyBase64 || '', 'base64');
  required(bytes.length <= (expectJson ? MAX_HTTP_JSON_BYTES : MAX_SNAPSHOT_BYTES), 'Qdrant response exceeded the drill limit');
  if (!expectJson) return { status: envelope.status, bytes };
  try {
    return { status: envelope.status, body: JSON.parse(bytes.toString('utf8')) };
  } catch {
    required(false, 'Qdrant returned invalid JSON', 'RECOVERY_DRILL_QDRANT');
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQdrant(project, options) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const result = qdrantRequest(project, options, '/');
      if (result.body?.version) return result.body;
    } catch {
      // Container startup is expected to race the first probe.
    }
    await delay(500);
  }
  required(false, 'Qdrant did not become ready', 'RECOVERY_DRILL_QDRANT');
}

async function startProject(project, options, { includeProduct = false } = {}) {
  const selectedServices = includeProduct
    ? ['mongo', 'qdrant', 'helper', 'core', 'benchmark', 'rag']
    : ['mongo', 'qdrant', 'helper'];
  composeCommand(project, options, [
    'up', '--detach', '--wait', '--wait-timeout', '120', ...selectedServices,
  ]);
  const services = composeText(project, options, ['ps', '--services', '--status', 'running'])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const expected = includeProduct
    ? ['benchmark', 'core', 'helper', 'mongo', 'qdrant', 'rag']
    : ['helper', 'mongo', 'qdrant'];
  required(
    JSON.stringify(services) === JSON.stringify(expected),
    'isolated drill project has an unexpected running service set',
    'RECOVERY_DRILL_TOPOLOGY'
  );
  const identity = await waitForQdrant(project, options);
  return { qdrantVersion: identity.version };
}

function stopProductWriters(project, options) {
  composeCommand(project, options, ['stop', '--timeout', '30', 'core', 'benchmark', 'rag'], {
    label: 'recovery drill writer quiescence',
  });
  const running = composeText(project, options, ['ps', '--services', '--status', 'running'])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  required(
    JSON.stringify(running) === JSON.stringify(['helper', 'mongo', 'qdrant']),
    'Core, Benchmark, and RAG were not all stopped for capture',
    'RECOVERY_DRILL_CAPTURE_NOT_QUIESCED'
  );
  return true;
}

async function startProductServices(project, options) {
  composeCommand(project, options, [
    'up', '--detach', '--wait', '--wait-timeout', '120', 'core', 'benchmark', 'rag',
  ], { label: 'post-restore product startup' });
  const services = composeText(project, options, ['ps', '--services', '--status', 'running'])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  required(
    JSON.stringify(services) === JSON.stringify(['benchmark', 'core', 'helper', 'mongo', 'qdrant', 'rag']),
    'post-restore product service set is incomplete',
    'RECOVERY_DRILL_PRODUCT_PROOF'
  );
}

function runProductControl(project, options, mode) {
  required(['seed', 'probe'].includes(mode), 'invalid product control mode');
  const source = fs.readFileSync(PRODUCT_CONTROL_FILE, 'utf8');
  const output = composeText(project, options, [
    'exec',
    '--no-TTY',
    '--env', `AGENTX_RECOVERY_DRILL_MODE=${mode}`,
    '--env', `AGENTX_RECOVERY_EXPECTED_PROFILE=${options.productProfile}`,
    '--env', `AGENTX_RECOVERY_EXPECTED_REVISION=${options.productRevision}`,
    '--env', `AGENTX_RECOVERY_EXPECTED_VERSION=${options.productVersion}`,
    'core',
    'node',
  ], {
    input: source,
    label: `recovery product ${mode} control`,
    timeout: 60000,
  });
  const marker = output
    .split(/\r?\n/)
    .find((line) => line.startsWith(PRODUCT_CONTROL_SENTINEL));
  required(marker, `recovery product ${mode} control returned no bounded result`, 'RECOVERY_DRILL_PRODUCT_PROOF');
  try {
    return JSON.parse(marker.slice(PRODUCT_CONTROL_SENTINEL.length));
  } catch {
    required(false, `recovery product ${mode} control returned invalid JSON`, 'RECOVERY_DRILL_PRODUCT_PROOF');
  }
}

function assertProductProof(proof, options) {
  for (const [service, identityName] of Object.entries({
    core: 'agentx-core',
    benchmark: 'agentx-benchmark',
    rag: 'agentx-rag',
  })) {
    const identity = proof?.identities?.[service];
    required(identity?.valid === true, `${service} restored identity is invalid`, 'RECOVERY_DRILL_PRODUCT_PROOF');
    required(identity.service === identityName, `${service} restored service identity does not match`, 'RECOVERY_DRILL_PRODUCT_PROOF');
    required(identity.version === options.productVersion, `${service} restored version does not match`, 'RECOVERY_DRILL_PRODUCT_PROOF');
    required(identity.profile === options.productProfile, `${service} restored profile does not match`, 'RECOVERY_DRILL_PRODUCT_PROOF');
    required(identity.revision === options.productRevision, `${service} restored revision does not match`, 'RECOVERY_DRILL_PRODUCT_PROOF');
  }
  for (const journey of ['prompt', 'rag', 'benchmark', 'vector', 'browser']) {
    required(proof?.journeys?.[journey] === true, `${journey} restored journey failed`, 'RECOVERY_DRILL_PRODUCT_PROOF');
  }
  required(proof?.schemas?.mongo === true, 'restored MongoDB schema compatibility failed', 'RECOVERY_DRILL_PRODUCT_PROOF');
  required(proof?.schemas?.qdrant === true, 'restored Qdrant schema compatibility failed', 'RECOVERY_DRILL_PRODUCT_PROOF');
  required(/^[0-9a-f]{64}$/.test(proof?.fingerprints?.combined || ''), 'restored product fingerprint is invalid');
  return proof;
}

function mongoExec(project, options, args, commandOptions = {}) {
  return composeCommand(project, options, ['exec', '--no-TTY', 'mongo', ...args], commandOptions);
}

function mongoText(project, options, args, commandOptions = {}) {
  return mongoExec(project, options, args, commandOptions).toString('utf8');
}

function parseSentinelJson(output) {
  const line = String(output || '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(MONGO_SENTINEL));
  required(line, 'MongoDB state probe returned no bounded result', 'RECOVERY_DRILL_MONGODB');
  try {
    return JSON.parse(line.slice(MONGO_SENTINEL.length));
  } catch {
    required(false, 'MongoDB state probe returned invalid JSON', 'RECOVERY_DRILL_MONGODB');
  }
}

function mongoShell(project, options, script) {
  const output = mongoText(project, options, [
    'mongosh',
    '--quiet',
    '--host',
    '127.0.0.1',
    '--port',
    '27017',
    MONGODB_DATABASE,
    '--eval',
    script,
  ], { label: 'MongoDB recovery drill operation' });
  return parseSentinelJson(output);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  required(
    value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value),
    'state contains a non-canonical value'
  );
  return value;
}

function digestCanonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function inspectMongoState(project, options) {
  const script = [
    'const state = {};',
    `for (const name of ${JSON.stringify(MONGO_COLLECTIONS)}) {`,
    '  state[name] = db.getCollection(name).find({ recoverySchemaVersion: 1 }).sort({ _id: 1 }).toArray();',
    '}',
    `print('${MONGO_SENTINEL}' + JSON.stringify(state));`,
  ].join('\n');
  const state = mongoShell(project, options, script);
  const records = Object.values(state).reduce((sum, rows) => sum + rows.length, 0);
  const collections = Object.values(state).filter((rows) => rows.length > 0).length;
  return { state, records, collections, sha256: digestCanonical(state) };
}

function inspectMongoTargetState(project, options) {
  const script = [
    "const names = db.getCollectionNames().filter((name) => !name.startsWith('system.')).sort();",
    'const state = {};',
    'let records = 0;',
    'for (const name of names) {',
    '  const count = db.getCollection(name).countDocuments({});',
    '  state[name] = { records: count };',
    '  records += count;',
    '}',
    `print('${MONGO_SENTINEL}' + JSON.stringify({ state, records, collections: names.length }));`,
  ].join('\n');
  const result = mongoShell(project, options, script);
  return {
    records: result.records,
    collections: result.collections,
    sha256: digestCanonical(result.state),
  };
}

function mongoVersions(project, options) {
  const server = mongoShell(
    project,
    options,
    `print('${MONGO_SENTINEL}' + JSON.stringify({ version: db.version() }));`
  ).version;
  const toolsOutput = mongoText(project, options, ['mongodump', '--version'], {
    label: 'MongoDB tools version probe',
  });
  const tools = /mongodump version:\s*v?([^\s]+)/i.exec(toolsOutput)?.[1];
  required(SEMVER_PATTERN.test(server || ''), 'MongoDB server version is not SemVer');
  required(SEMVER_PATTERN.test(tools || ''), 'MongoDB tools version is not SemVer');
  return { serverVersion: server, toolsVersion: tools };
}

async function inspectQdrantState(project, options) {
  const collection = qdrantRequest(project, options, `/collections/${QDRANT_COLLECTION}`, {
    allowedStatuses: [200, 404],
  });
  if (collection.status === 404) {
    const state = { collectionExists: false, vectors: null, points: [] };
    return { state, records: 0, points: 0, collections: 0, sha256: digestCanonical(state) };
  }
  const scroll = qdrantRequest(project, options, `/collections/${QDRANT_COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100, with_payload: true, with_vector: true }),
  });
  required(!scroll.body?.result?.next_page_offset, 'Qdrant recovery fixture exceeded one bounded page');
  const points = Array.isArray(scroll.body?.result?.points) ? scroll.body.result.points : [];
  points.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const state = {
    collectionExists: true,
    vectors: collection.body?.result?.config?.params?.vectors,
    points,
  };
  return { state, records: points.length, points: points.length, collections: 1, sha256: digestCanonical(state) };
}

async function downloadQdrantSnapshot(project, options, artifactPath) {
  const created = qdrantRequest(project, options, `/collections/${QDRANT_COLLECTION}/snapshots?wait=true`, {
    method: 'POST',
  });
  const snapshotName = created.body?.result?.name;
  required(
    typeof snapshotName === 'string' && /^[A-Za-z0-9._-]+$/.test(snapshotName),
    'Qdrant returned an unsafe snapshot name',
    'RECOVERY_DRILL_QDRANT'
  );
  const response = qdrantRequest(
    project,
    options,
    `/collections/${QDRANT_COLLECTION}/snapshots/${encodeURIComponent(snapshotName)}`,
    { expectJson: false }
  );
  required(response.bytes.length > 0, 'Qdrant snapshot is empty');
  fs.writeFileSync(artifactPath, response.bytes, { flag: 'wx', mode: 0o600 });
}

async function uploadQdrantSnapshot(project, options, artifactPath) {
  const stat = fs.statSync(artifactPath);
  required(stat.isFile() && stat.size > 0 && stat.size <= MAX_SNAPSHOT_BYTES, 'Qdrant snapshot is invalid');
  const boundary = `agentx-recovery-${crypto.randomBytes(12).toString('hex')}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="snapshot"; filename="qdrant.collection.snapshot"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fs.readFileSync(artifactPath), footer]);
  const result = qdrantRequest(
    project,
    options,
    `/collections/${QDRANT_COLLECTION}/snapshots/upload?priority=snapshot&wait=true`,
    {
      method: 'POST',
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
    }
  );
  required(result.body?.status === 'ok' || result.body?.result === true, 'Qdrant snapshot restore was not acknowledged');
}

function assertSafeConfigSources() {
  const rootRealPath = fs.realpathSync(ROOT);
  for (const sourceId of PRODUCT_CONFIG_SOURCE_IDS) {
    const sourcePath = path.join(ROOT, ...sourceId.split('/'));
    const stat = fs.lstatSync(sourcePath);
    required(stat.isFile() && !stat.isSymbolicLink(), `product config source ${sourceId} must be a regular file`);
    const realPath = fs.realpathSync(sourcePath);
    const relative = path.relative(rootRealPath, realPath);
    required(
      relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
      `product config source ${sourceId} resolves outside the repository`
    );
  }
}

function createProductConfigArchive(artifactPath) {
  assertSafeConfigSources();
  runCommand('tar', ['-czf', artifactPath, '--', ...PRODUCT_CONFIG_SOURCE_IDS], {
    cwd: ROOT,
    label: 'bounded product configuration archive',
  });
  const stat = fs.statSync(artifactPath);
  required(stat.isFile() && stat.size > 0, 'product configuration archive is empty');
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(handle);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function writeBundleManifest(partialPath, manifest) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  fs.writeFileSync(path.join(partialPath, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(partialPath, 'manifest.sha256'), `${manifestHash}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return manifestHash;
}

function safeBundleName(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  return `agentx-recovery-v1-${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

async function captureBundle({ sourceProject, workspace, options, versions }) {
  const bundleId = crypto.randomUUID();
  const partialPath = path.join(workspace, `.agentx-recovery-partial-${bundleId}`);
  const bundlePath = path.join(workspace, safeBundleName());
  const artifactsPath = path.join(partialPath, 'artifacts');
  fs.mkdirSync(artifactsPath, { recursive: true });
  const captureStartedAt = new Date().toISOString();

  const mongoArtifact = path.join(artifactsPath, 'mongodb.archive.gz');
  mongoExec(sourceProject, options, [
    'mongodump',
    '--quiet',
    '--host',
    '127.0.0.1',
    '--port',
    '27017',
    '--db',
    MONGODB_DATABASE,
    '--archive',
    '--gzip',
  ], { outputFile: mongoArtifact, label: 'MongoDB archive capture' });

  const qdrantArtifact = path.join(artifactsPath, 'qdrant.collection.snapshot');
  await downloadQdrantSnapshot(sourceProject, options, qdrantArtifact);

  const configArtifact = path.join(artifactsPath, 'product-config.tar.gz');
  createProductConfigArchive(configArtifact);

  const artifactEntries = RECOVERY_ARTIFACTS.map((contract) => ({
    ...contract,
    ...hashFile(path.join(partialPath, ...contract.path.split('/'))),
  }));
  const captureCompletedAt = new Date().toISOString();
  const manifest = {
    schema: RECOVERY_BUNDLE_SCHEMA,
    bundleId,
    createdAt: captureCompletedAt,
    product: {
      name: PRODUCT_NAME,
      version: options.productVersion,
      profile: options.productProfile,
      revision: options.productRevision,
    },
    sourceImages: {
      core: imageDigestFromReference(options.coreImage, 'Core image'),
      benchmark: imageDigestFromReference(options.benchmarkImage, 'Benchmark image'),
      rag: imageDigestFromReference(options.ragImage, 'RAG image'),
      mongodb: imageDigestFromReference(options.mongodbImage, 'MongoDB image'),
      qdrant: imageDigestFromReference(options.qdrantImage, 'Qdrant image'),
    },
    dependencies: {
      mongodb: {
        serverVersion: versions.mongodb.serverVersion,
        toolsVersion: versions.mongodb.toolsVersion,
        database: MONGODB_DATABASE,
      },
      qdrant: {
        serverVersion: versions.qdrant.serverVersion,
        collection: QDRANT_COLLECTION,
      },
    },
    capture: {
      mode: CAPTURE_MODE,
      startedAt: captureStartedAt,
      completedAt: captureCompletedAt,
      complete: true,
      observedStoppedWriters: [...OBSERVED_STOPPED_WRITERS],
      configSourceIds: [...PRODUCT_CONFIG_SOURCE_IDS],
    },
    compatibility: {
      mode: COMPATIBILITY_MODE,
      productRevision: options.productRevision,
    },
    artifacts: artifactEntries,
    restoreVerified: false,
    exclusions: [...RECOVERY_BUNDLE_EXCLUSIONS],
  };
  const manifestSha256 = writeBundleManifest(partialPath, manifest);
  await verifyRecoveryBundle({ bundlePath: partialPath, expectedProductRevision: options.productRevision });
  fs.renameSync(partialPath, bundlePath);
  await verifyRecoveryBundle({ bundlePath, expectedProductRevision: options.productRevision });
  return { bundlePath, bundleId, manifestSha256 };
}

function restoreMongo(project, options, bundlePath) {
  mongoExec(project, options, [
    'mongorestore',
    '--quiet',
    '--host',
    '127.0.0.1',
    '--port',
    '27017',
    '--archive',
    '--gzip',
    '--drop',
    '--nsInclude',
    `${MONGODB_DATABASE}.*`,
  ], {
    inputFile: path.join(bundlePath, 'artifacts', 'mongodb.archive.gz'),
    label: 'MongoDB isolated restore',
  });
}

function corruptBundle(bundlePath, corruptedPath) {
  fs.cpSync(bundlePath, corruptedPath, { recursive: true, errorOnExist: true, force: false });
  const artifactPath = path.join(corruptedPath, 'artifacts', 'qdrant.collection.snapshot');
  const stat = fs.statSync(artifactPath);
  required(stat.isFile() && stat.size > 0, 'corruption target must be a non-empty regular file');
  const handle = fs.openSync(artifactPath, 'r+');
  try {
    const offset = Math.floor(stat.size / 2);
    const byte = Buffer.alloc(1);
    fs.readSync(handle, byte, 0, 1, offset);
    byte[0] ^= 0xff;
    fs.writeSync(handle, byte, 0, 1, offset);
  } finally {
    fs.closeSync(handle);
  }
}

async function proveCorruptedBundleFailsClosed({
  corruptedPath,
  expectedProductRevision,
  inspectTarget,
  verify = verifyRecoveryBundle,
}) {
  const before = await inspectTarget();
  let rejection = null;
  try {
    await verify({ bundlePath: corruptedPath, expectedProductRevision });
  } catch (error) {
    rejection = error;
  }
  required(rejection, 'corrupted recovery bundle was accepted', 'RECOVERY_DRILL_NEGATIVE_GATE');
  required(
    rejection.code === 'RECOVERY_BUNDLE_INTEGRITY',
    'corrupted recovery bundle did not fail at the integrity gate',
    'RECOVERY_DRILL_NEGATIVE_GATE'
  );
  const after = await inspectTarget();
  required(
    before.mongodb.records === 0
      && before.mongodb.collections === 0
      && before.qdrant.records === 0
      && before.qdrant.collections === 0,
    'negative target was not empty before verification',
    'RECOVERY_DRILL_NEGATIVE_GATE'
  );
  required(
    after.mongodb.records === 0
      && after.mongodb.collections === 0
      && after.qdrant.records === 0
      && after.qdrant.collections === 0,
    'corrupted bundle verification partially mutated the target',
    'RECOVERY_DRILL_NEGATIVE_GATE'
  );
  required(
    before.mongodb.sha256 === after.mongodb.sha256 && before.qdrant.sha256 === after.qdrant.sha256,
    'negative target state changed during corrupted bundle verification',
    'RECOVERY_DRILL_NEGATIVE_GATE'
  );
  return { rejected: true, unchanged: true };
}

function projectResourceIds(project) {
  required(PROJECT_PATTERN.test(project), 'refusing to inspect an unscoped recovery drill project');
  const filter = `label=com.docker.compose.project=${project}`;
  const query = (args) => commandText('docker', args, {
    label: 'recovery drill cleanup audit',
  }).trim().split(/\r?\n/).filter(Boolean);
  return {
    containers: query(['ps', '--all', '--quiet', '--filter', filter]),
    volumes: query(['volume', 'ls', '--quiet', '--filter', filter]),
    networks: query(['network', 'ls', '--quiet', '--filter', filter]),
  };
}

async function assertProjectRemoved(project) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const resources = projectResourceIds(project);
    if (Object.values(resources).every((items) => items.length === 0)) return true;
    await delay(250);
  }
  required(false, `scoped Docker resources remain for ${project}`, 'RECOVERY_DRILL_CLEANUP');
}

async function cleanupProject(project, options) {
  composeCommand(project, options, ['down', '--volumes', '--remove-orphans', '--timeout', '10'], {
    label: 'scoped recovery drill cleanup',
  });
  return assertProjectRemoved(project);
}

function assertSafeWorkspace(workspace) {
  const resolved = path.resolve(workspace);
  const expectedParent = path.resolve(os.tmpdir());
  required(path.dirname(resolved) === expectedParent, 'refusing to clean a workspace outside the OS temp directory');
  required(/^agentx-recovery-drill-[A-Za-z0-9_-]+$/.test(path.basename(resolved)), 'refusing an unscoped workspace cleanup');
  return resolved;
}

function removeWorkspace(workspace) {
  const resolved = assertSafeWorkspace(workspace);
  fs.rmSync(resolved, { recursive: true, force: true });
  required(!fs.existsSync(resolved), 'temporary recovery drill workspace remains', 'RECOVERY_DRILL_CLEANUP');
}

function exactProductVersion() {
  const versions = ['core', 'benchmark', 'rag'].map((service) => {
    const value = JSON.parse(fs.readFileSync(path.join(ROOT, service, 'package.json'), 'utf8')).version;
    required(SEMVER_PATTERN.test(value || ''), `${service} package version is not SemVer`);
    return value;
  });
  required(new Set(versions).size === 1, 'Core, Benchmark, and RAG package versions must match');
  return versions[0];
}

function validateOptions(options) {
  required(options && typeof options === 'object', 'recovery drill options are required');
  required(typeof options.receiptPath === 'string' && options.receiptPath.trim(), '--output is required');
  required(!fs.existsSync(path.resolve(options.receiptPath)), 'receipt destination already exists');
  required(SEMVER_PATTERN.test(options.productVersion || ''), '--product-version must be SemVer');
  required(PRODUCT_PROFILES.includes(options.productProfile), '--product-profile must be demo or full');
  required(/^[0-9a-f]{40}$/.test(options.productRevision || ''), '--expected-candidate-revision must be a full lowercase Git revision');
  assertPinnedImageReference(options.coreImage, '--candidate-core-image');
  assertPinnedImageReference(options.benchmarkImage, '--candidate-benchmark-image');
  assertPinnedImageReference(options.ragImage, '--candidate-rag-image');
  assertPinnedImageReference(options.mongodbImage, '--mongo-image');
  assertPinnedImageReference(options.qdrantImage, '--qdrant-image');
  assertPinnedImageReference(options.helperImage, 'transport helper image');
  required(options.mongodbImage === PINNED_MONGODB_IMAGE, 'MongoDB image must match config/container-image-pins.json');
  required(options.qdrantImage === PINNED_QDRANT_IMAGE, 'Qdrant image must match config/container-image-pins.json');
  required(options.helperImage === PINNED_HELPER_IMAGE, 'transport helper image must match config/container-image-pins.json');
  required(RUN_SCOPE_PATTERN.test(options.runScope || ''), '--run-scope must be 6-25 lowercase letters, digits, or hyphens');
  return options;
}

function publishReceipt(receiptPath, receipt) {
  assertRecoveryDrillReceipt(receipt);
  const destination = path.resolve(receiptPath);
  const parent = path.dirname(destination);
  required(fs.statSync(parent).isDirectory(), 'receipt parent must be an existing directory');
  required(!fs.existsSync(destination), 'receipt destination already exists');
  const partial = path.join(parent, `.agentx-recovery-receipt-partial-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(partial, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.linkSync(partial, destination);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return destination;
}

function buildReceipt({
  options,
  topology,
  bundle,
  versions,
  measurements,
  sourceState,
  restoredState,
  productProof,
  assertions,
}) {
  required(
    JSON.stringify(Object.keys(assertions)) === JSON.stringify(ASSERTION_KEYS),
    'recovery drill assertions are not in the canonical v1 order'
  );
  const receipt = {
    schema: RECOVERY_DRILL_RECEIPT_SCHEMA,
    receiptId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    outcome: RECOVERY_DRILL_OUTCOME,
    product: {
      version: options.productVersion,
      profile: options.productProfile,
      revision: options.productRevision,
    },
    topology,
    sourceImages: {
      core: imageDigestFromReference(options.coreImage, 'Core image'),
      benchmark: imageDigestFromReference(options.benchmarkImage, 'Benchmark image'),
      rag: imageDigestFromReference(options.ragImage, 'RAG image'),
      mongodb: imageDigestFromReference(options.mongodbImage, 'MongoDB image'),
      qdrant: imageDigestFromReference(options.qdrantImage, 'Qdrant image'),
    },
    bundle: {
      bundleId: bundle.bundleId,
      manifestSha256: bundle.manifestSha256,
    },
    dependencies: {
      mongodb: {
        imageDigest: imageDigestFromReference(options.mongodbImage, 'MongoDB image'),
        serverVersion: versions.mongodb.serverVersion,
        toolsVersion: versions.mongodb.toolsVersion,
      },
      qdrant: {
        imageDigest: imageDigestFromReference(options.qdrantImage, 'Qdrant image'),
        serverVersion: versions.qdrant.serverVersion,
      },
      transportHelper: {
        imageDigest: imageDigestFromReference(options.helperImage, 'transport helper image'),
        version: versions.transportHelper.version,
      },
    },
    measurements,
    state: {
      mongodb: {
        representativeRecords: sourceState.mongodb.records,
        collections: sourceState.mongodb.collections,
        sourceSha256: sourceState.mongodb.sha256,
        restoredSha256: restoredState.mongodb.sha256,
      },
      qdrant: {
        representativeRecords: sourceState.qdrant.records,
        points: sourceState.qdrant.points,
        sourceSha256: sourceState.qdrant.sha256,
        restoredSha256: restoredState.qdrant.sha256,
      },
    },
    productProof: {
      identities: Object.fromEntries(['core', 'benchmark', 'rag'].map((service) => [service, {
        service: productProof.identities[service].service,
        version: productProof.identities[service].version,
        profile: productProof.identities[service].profile,
        revision: productProof.identities[service].revision,
      }])),
      journeys: {
        prompt: productProof.journeys.prompt,
        rag: productProof.journeys.rag,
        benchmark: productProof.journeys.benchmark,
        vector: productProof.journeys.vector,
        browser: productProof.journeys.browser,
      },
      schemas: {
        mongodb: productProof.schemas.mongo,
        qdrant: productProof.schemas.qdrant,
      },
    },
    assertions,
    privacy: {
      containsAddresses: false,
      containsRawDocumentContent: false,
      containsSecrets: false,
    },
  };
  assertRecoveryDrillReceipt(receipt);
  return receipt;
}

async function runRecoveryDrill(rawOptions) {
  const options = validateOptions({ ...rawOptions });
  const startedAt = process.hrtime.bigint();
  const projects = {
    source: `agentx-rd-${options.runScope}-source`,
    negative: `agentx-rd-${options.runScope}-negative`,
    positive: `agentx-rd-${options.runScope}-positive`,
  };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-recovery-drill-'));
  const assertions = Object.fromEntries(ASSERTION_KEYS.map((key) => [key, false]));
  let completed = false;
  let primaryError = null;

  try {
    for (const project of Object.values(projects)) await assertProjectRemoved(project);
    const topology = renderAndValidateTopology(options);
    assertions.renderedTopologyBound = true;

    const captureStarted = process.hrtime.bigint();
    const sourceRuntime = await startProject(projects.source, options, { includeProduct: true });
    const seeded = runProductControl(projects.source, options, 'seed');
    required(seeded?.seeded === true && seeded?.schemaVersion === 1, 'representative product state was not seeded');
    const sourceState = {
      mongodb: inspectMongoState(projects.source, options),
      qdrant: await inspectQdrantState(projects.source, options),
    };
    required(sourceState.mongodb.records === 2 && sourceState.mongodb.collections === 2, 'MongoDB representative state is incomplete');
    required(sourceState.qdrant.records === 1 && sourceState.qdrant.points === 1, 'Qdrant representative state is incomplete');
    const helperVersionOutput = composeText(projects.source, options, [
      'exec', '--no-TTY', 'helper', 'node', '--version',
    ], { label: 'transport helper version probe' }).trim();
    const helperVersion = helperVersionOutput.replace(/^v/, '');
    const versions = {
      mongodb: mongoVersions(projects.source, options),
      qdrant: { serverVersion: sourceRuntime.qdrantVersion },
      transportHelper: { version: helperVersion },
    };
    required(SEMVER_PATTERN.test(versions.qdrant.serverVersion || ''), 'Qdrant server version is not SemVer');
    required(versions.mongodb.serverVersion === DEPENDENCY_PINS.mongodb.version, 'MongoDB runtime version does not match the reviewed pin');
    required(versions.qdrant.serverVersion === DEPENDENCY_PINS.qdrant.version, 'Qdrant runtime version does not match the reviewed pin');
    required(helperVersion === DEPENDENCY_PINS.transportHelper.version, 'transport helper runtime version does not match the reviewed pin');
    assertions.pinnedDependencyImagesVerified = true;
    stopProductWriters(projects.source, options);
    assertions.writersAbsentDuringCapture = true;
    const bundle = await captureBundle({
      sourceProject: projects.source,
      workspace,
      options,
      versions,
    });
    assertions.bundleVerifiedAfterCapture = true;
    const captureMs = elapsedMs(captureStarted);

    await cleanupProject(projects.source, options);
    assertions.sourceDataDestroyedBeforeRestore = true;

    const corruptionStarted = process.hrtime.bigint();
    await startProject(projects.negative, options);
    const corruptedPath = path.join(workspace, 'corrupted-bundle');
    corruptBundle(bundle.bundlePath, corruptedPath);
    const negative = await proveCorruptedBundleFailsClosed({
      corruptedPath,
      expectedProductRevision: options.productRevision,
      inspectTarget: async () => ({
        mongodb: inspectMongoTargetState(projects.negative, options),
        qdrant: await inspectQdrantState(projects.negative, options),
      }),
    });
    assertions.corruptedBundleRejectedBeforeMutation = negative.rejected;
    assertions.corruptedBundleTargetUnchanged = negative.unchanged;
    await cleanupProject(projects.negative, options);
    const corruptionGateMs = elapsedMs(corruptionStarted);

    const restoreStarted = process.hrtime.bigint();
    await startProject(projects.positive, options);
    const emptyPositiveMongo = inspectMongoState(projects.positive, options);
    const emptyPositiveQdrant = await inspectQdrantState(projects.positive, options);
    required(emptyPositiveMongo.records === 0 && emptyPositiveQdrant.records === 0, 'positive target was not empty');
    await verifyRecoveryBundle({
      bundlePath: bundle.bundlePath,
      expectedProductRevision: options.productRevision,
    });
    assertions.bundleVerifiedBeforeRestoreMutation = true;
    restoreMongo(projects.positive, options, bundle.bundlePath);
    await uploadQdrantSnapshot(
      projects.positive,
      options,
      path.join(bundle.bundlePath, 'artifacts', 'qdrant.collection.snapshot')
    );
    const restoredState = {
      mongodb: inspectMongoState(projects.positive, options),
      qdrant: await inspectQdrantState(projects.positive, options),
    };
    required(restoredState.mongodb.records === sourceState.mongodb.records, 'MongoDB representative record count did not restore');
    assertions.mongodbRepresentativeStateRestored = true;
    required(restoredState.mongodb.sha256 === sourceState.mongodb.sha256, 'MongoDB restored state hash does not match source');
    assertions.mongodbStateHashMatched = true;
    required(restoredState.qdrant.records === sourceState.qdrant.records, 'Qdrant representative point count did not restore');
    assertions.qdrantRepresentativeStateRestored = true;
    required(restoredState.qdrant.sha256 === sourceState.qdrant.sha256, 'Qdrant restored state hash does not match source');
    assertions.qdrantStateHashMatched = true;
    await startProductServices(projects.positive, options);
    const productProof = assertProductProof(
      runProductControl(projects.positive, options, 'probe'),
      options
    );
    assertions.exactProductIdentityVerified = true;
    assertions.promptJourneyPassed = true;
    assertions.ragJourneyPassed = true;
    assertions.benchmarkJourneyPassed = true;
    assertions.browserJourneyPassed = true;
    await cleanupProject(projects.positive, options);
    const restoreMs = elapsedMs(restoreStarted);

    for (const project of Object.values(projects)) await assertProjectRemoved(project);
    assertions.scopedDockerResourcesRemoved = true;
    removeWorkspace(workspace);
    assertions.temporaryWorkspaceRemoved = true;

    const measurements = {
      captureMs,
      corruptionGateMs,
      restoreMs,
      totalMs: elapsedMs(startedAt),
    };
    const receipt = buildReceipt({
      options,
      topology,
      bundle,
      versions,
      measurements,
      sourceState,
      restoredState,
      productProof,
      assertions,
    });
    const receiptPath = publishReceipt(options.receiptPath, receipt);
    completed = true;
    return { receipt, receiptPath };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const project of Object.values(projects)) {
      try {
        await cleanupProject(project, options);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (fs.existsSync(workspace)) removeWorkspace(workspace);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length && primaryError) primaryError.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length && !primaryError && !completed) {
      throw new AggregateError(cleanupErrors, 'recovery drill cleanup failed');
    }
  }
}

function readArgValue(argv, index, argument) {
  const value = argv[index + 1];
  required(value && !value.startsWith('--'), `${argument} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    productVersion: exactProductVersion(),
    productProfile: 'demo',
    mongodbImage: PINNED_MONGODB_IMAGE,
    qdrantImage: PINNED_QDRANT_IMAGE,
    helperImage: PINNED_HELPER_IMAGE,
    runScope: process.env.AGENTX_RECOVERY_DRILL_RUN_SCOPE || crypto.randomBytes(6).toString('hex'),
  };
  const seen = new Set();
  const mapping = {
    '--output': 'receiptPath',
    '--receipt': 'receiptPath',
    '--product-version': 'productVersion',
    '--product-profile': 'productProfile',
    '--expected-candidate-revision': 'productRevision',
    '--product-revision': 'productRevision',
    '--candidate-core-image': 'coreImage',
    '--core-image': 'coreImage',
    '--candidate-benchmark-image': 'benchmarkImage',
    '--benchmark-image': 'benchmarkImage',
    '--candidate-rag-image': 'ragImage',
    '--rag-image': 'ragImage',
    '--mongo-image': 'mongodbImage',
    '--mongodb-image': 'mongodbImage',
    '--qdrant-image': 'qdrantImage',
    '--run-scope': 'runScope',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = mapping[argument];
    required(key, `unknown argument: ${argument}`);
    required(!seen.has(key), `${argument} conflicts with another value for ${key}`);
    seen.add(key);
    options[key] = readArgValue(argv, index, argument);
    index += 1;
  }
  return validateOptions(options);
}

const USAGE = [
  'Usage: node scripts/run-recovery-drill.js --output <new.json>',
  '  --expected-candidate-revision <40-lowercase-hex>',
  '  --candidate-core-image image@sha256:<64-hex>',
  '  --candidate-benchmark-image image@sha256:<64-hex>',
  '  --candidate-rag-image image@sha256:<64-hex> [--product-profile demo|full]',
  '  [--product-version <semver>] [--mongo-image name@sha256:<64-hex>]',
  '  [--qdrant-image name@sha256:<64-hex>]',
  '  [--run-scope <unique-lowercase-scope>]',
  'Aliases: --receipt, --product-revision, --core-image, --benchmark-image,',
  '  --rag-image, and --mongodb-image.',
].join('\n');

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    let options;
    try {
      options = parseArgs(process.argv.slice(2));
    } catch (error) {
      process.stderr.write(`Agent X recovery drill argument error: ${error.message}\n${USAGE}\n`);
      process.exitCode = 2;
    }
    if (options) {
      runRecoveryDrill(options)
        .then(({ receipt, receiptPath }) => {
          process.stdout.write(
            `recovery drill passed: receipt=${receiptPath} bundle=${receipt.bundle.manifestSha256}\n`
          );
        })
        .catch((error) => {
          process.stderr.write(`Agent X recovery drill failed: ${error.message}\n`);
          if (error.cleanupErrors?.length) {
            process.stderr.write(`cleanup failures: ${error.cleanupErrors.length}\n`);
          }
          process.exitCode = 1;
        });
    }
  }
}

module.exports = {
  DRILL_COMPOSE_FILE,
  MAX_SNAPSHOT_BYTES,
  MONGO_COLLECTIONS,
  PINNED_HELPER_IMAGE,
  PINNED_MONGODB_IMAGE,
  PINNED_QDRANT_IMAGE,
  PROJECT_PATTERN,
  RUN_SCOPE_PATTERN,
  QDRANT_COLLECTION,
  USAGE,
  assertPinnedImageReference,
  buildReceipt,
  canonicalize,
  corruptBundle,
  digestCanonical,
  exactProductVersion,
  imageDigestFromReference,
  inspectMongoTargetState,
  loadDependencyPins,
  parseArgs,
  proveCorruptedBundleFailsClosed,
  renderAndValidateTopology,
  removeWorkspace,
  runRecoveryDrill,
  validateOptions,
};

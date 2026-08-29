#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  PRODUCT_SERVICES,
  createUpgradeRollbackReceipt,
  validateUpgradeRollbackReceipt,
} = require('./upgrade-rollback-receipt');
const {
  LEGACY_IDENTITY_MODE,
  baselineFromPolicy,
  loadLegacyReleasePolicy,
  readPreviousManifest,
  readPreviousReleaseBaseline,
  receiptBaselineBinding,
} = require('./upgrade-rollback-baseline');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_COMPOSE_FILE = path.join(ROOT_DIR, 'docker-compose.upgrade-rollback.yml');
const CONTROL_SOURCE_PATH = path.join(__dirname, 'fixtures', 'upgrade-rollback-control.js');
const DEFAULT_PIN_FILE = path.join(ROOT_DIR, 'config', 'container-image-pins.json');
const RUNTIME_SERVICES = Object.freeze(['mongo', 'qdrant', 'core', 'benchmark', 'rag']);
const IMAGE_REF_PATTERN = /^([a-z0-9][a-z0-9._:/-]*)@sha256:([0-9a-f]{64})$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const PROJECT_PATTERN = /^agentx-upgrade-rollback-[a-z0-9][a-z0-9-]{5,35}$/;
const CONTROL_MARKER = 'AGENTX_UPGRADE_ROLLBACK_CONTROL=';
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024;
const PERSISTENT_VOLUME_KEYS = Object.freeze(['mongo-data', 'mongo-config-data', 'qdrant-data']);
const OCI_LABELS = Object.freeze({
  revision: 'org.opencontainers.image.revision',
  version: 'org.opencontainers.image.version',
  source: 'org.opencontainers.image.source',
});

const ARGUMENTS = Object.freeze({
  '--previous-core-image': 'previousCoreImage',
  '--previous-benchmark-image': 'previousBenchmarkImage',
  '--previous-rag-image': 'previousRagImage',
  '--candidate-core-image': 'candidateCoreImage',
  '--candidate-benchmark-image': 'candidateBenchmarkImage',
  '--candidate-rag-image': 'candidateRagImage',
  '--mongo-image': 'mongoImage',
  '--qdrant-image': 'qdrantImage',
  '--expected-previous-revision': 'expectedPreviousRevision',
  '--expected-candidate-revision': 'expectedCandidateRevision',
  '--previous-manifest': 'previousManifestPath',
  '--previous-manifest-base64': 'previousManifestBase64',
  '--previous-manifest-sha256': 'previousManifestSha256',
  '--previous-baseline': 'previousBaselinePath',
  '--project': 'project',
  '--output': 'outputPath',
  '--wait-timeout-seconds': 'waitTimeoutSeconds',
});

const ENVIRONMENT_OPTIONS = Object.freeze({
  previousCoreImage: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_CORE_IMAGE',
  previousBenchmarkImage: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_BENCHMARK_IMAGE',
  previousRagImage: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_RAG_IMAGE',
  candidateCoreImage: 'AGENTX_UPGRADE_ROLLBACK_CANDIDATE_CORE_IMAGE',
  candidateBenchmarkImage: 'AGENTX_UPGRADE_ROLLBACK_CANDIDATE_BENCHMARK_IMAGE',
  candidateRagImage: 'AGENTX_UPGRADE_ROLLBACK_CANDIDATE_RAG_IMAGE',
  mongoImage: 'AGENTX_UPGRADE_ROLLBACK_MONGO_IMAGE',
  qdrantImage: 'AGENTX_UPGRADE_ROLLBACK_QDRANT_IMAGE',
  expectedPreviousRevision: 'AGENTX_UPGRADE_ROLLBACK_EXPECTED_PREVIOUS_REVISION',
  expectedCandidateRevision: 'AGENTX_UPGRADE_ROLLBACK_EXPECTED_CANDIDATE_REVISION',
  previousManifestPath: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_MANIFEST',
  previousManifestBase64: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_MANIFEST_BASE64',
  previousManifestSha256: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_MANIFEST_SHA256',
  previousBaselinePath: 'AGENTX_UPGRADE_ROLLBACK_PREVIOUS_BASELINE',
  outputPath: 'AGENTX_UPGRADE_ROLLBACK_OUTPUT',
});

class RehearsalError extends Error {
  constructor(message, { receipt, cause } = {}) {
    super(message, { cause });
    this.name = 'RehearsalError';
    this.receipt = receipt;
  }
}

function exactImageReference(value, label = 'image') {
  const ref = String(value || '').trim();
  const match = ref.match(IMAGE_REF_PATTERN);
  if (!match) {
    throw new Error(`${label} must be an image@sha256 digest reference`);
  }
  if (match[1].includes('..') || match[1].includes('//')) throw new Error(`${label} has an invalid repository name`);
  return Object.freeze({ ref, digest: `sha256:${match[2]}` });
}

function dependencyPins(pinFile = DEFAULT_PIN_FILE) {
  const parsed = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  if (parsed?.schemaVersion !== 1) throw new Error('container image pin schemaVersion must be 1');
  return Object.freeze({
    mongoImage: exactImageReference(parsed?.images?.mongodb?.reference, 'mongodb pin'),
    qdrantImage: exactImageReference(parsed?.images?.qdrant?.reference, 'qdrant pin'),
  });
}

function generatedProjectName(randomBytes = crypto.randomBytes, now = Date.now) {
  return `agentx-upgrade-rollback-${now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function parsePositiveInteger(value, label, { minimum, maximum }) {
  if (!/^[0-9]+$/.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env, dependencies = {}) {
  const values = {};
  if (argv.length > Object.keys(ARGUMENTS).length * 2) throw new Error('too many command-line arguments');
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = ARGUMENTS[flag];
    if (!key) throw new Error(`unknown argument: ${flag}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument: ${flag}`);
    if (index + 1 >= argv.length || String(argv[index + 1]).startsWith('--')) {
      throw new Error(`${flag} requires one value`);
    }
    values[key] = argv[index + 1];
  }

  for (const [key, environmentName] of Object.entries(ENVIRONMENT_OPTIONS)) {
    if (values[key] === undefined && env[environmentName] !== undefined) values[key] = env[environmentName];
  }
  const pinnedDependencies = dependencies.dependencyPins || dependencyPins(dependencies.pinFile || DEFAULT_PIN_FILE);
  if (!values.mongoImage) values.mongoImage = pinnedDependencies.mongoImage.ref;
  if (!values.qdrantImage) values.qdrantImage = pinnedDependencies.qdrantImage.ref;
  const requiredImages = [
    'previousCoreImage', 'previousBenchmarkImage', 'previousRagImage',
    'candidateCoreImage', 'candidateBenchmarkImage', 'candidateRagImage',
    'mongoImage', 'qdrantImage',
  ];
  for (const key of requiredImages) {
    if (!values[key]) throw new Error(`${ENVIRONMENT_OPTIONS[key]} or its matching CLI argument is required`);
  }
  if (!values.outputPath) throw new Error('--output or AGENTX_UPGRADE_ROLLBACK_OUTPUT is required');

  const images = Object.fromEntries(requiredImages.map((key) => [key, exactImageReference(values[key], key)]));
  const project = String(values.project || generatedProjectName(
    dependencies.randomBytes || crypto.randomBytes,
    dependencies.nowMilliseconds || Date.now
  )).trim().toLowerCase();
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error('project must be a unique agentx-upgrade-rollback-* name using lowercase letters, digits, and hyphens');
  }
  const expectedPreviousRevision = values.expectedPreviousRevision
    ? String(values.expectedPreviousRevision).trim().toLowerCase()
    : null;
  const expectedCandidateRevision = values.expectedCandidateRevision
    ? String(values.expectedCandidateRevision).trim().toLowerCase()
    : null;
  if (expectedPreviousRevision && !REVISION_PATTERN.test(expectedPreviousRevision)) {
    throw new Error('expected previous revision must be a full lowercase commit SHA');
  }
  if (expectedCandidateRevision && !REVISION_PATTERN.test(expectedCandidateRevision)) {
    throw new Error('expected candidate revision must be a full lowercase commit SHA');
  }
  if (!expectedPreviousRevision || !expectedCandidateRevision) {
    throw new Error('the CLI requires both expected previous and candidate revisions for release-bound evidence');
  }
  if (expectedPreviousRevision === expectedCandidateRevision) {
    throw new Error('expected previous and candidate revisions must be distinct');
  }

  const legacyPolicy = dependencies.legacyPolicy || loadLegacyReleasePolicy(dependencies.legacyPolicyFile);
  const legacyBootstrap = Boolean(values.previousBaselinePath);
  const expectedPreviousImages = Object.fromEntries([
    ['core', 'previousCoreImage'],
    ['benchmark', 'previousBenchmarkImage'],
    ['rag', 'previousRagImage'],
  ].map(([service, optionKey]) => [service, images[optionKey]]));
  const previousManifest = readPreviousManifest({
    manifestPath: values.previousManifestPath,
    manifestBase64: values.previousManifestBase64,
    manifestSha256: values.previousManifestSha256,
  }, {
    expectedRevision: expectedPreviousRevision,
    expectedImages: expectedPreviousImages,
    legacyPolicy: legacyBootstrap ? legacyPolicy : null,
  });
  let previousBaseline = null;
  let receiptBaseline = null;
  if (legacyBootstrap) {
    const baseline = baselineFromPolicy(legacyPolicy);
    if (expectedPreviousRevision !== baseline.commit) {
      throw new Error('expected previous revision does not match the one-time v0.1.1 baseline');
    }
    for (const service of PRODUCT_SERVICES) {
      if (expectedPreviousImages[service].ref !== baseline.services[service].ref
        || expectedPreviousImages[service].digest !== baseline.services[service].digest) {
        throw new Error(`${service} previous image does not match the one-time v0.1.1 baseline`);
      }
    }
    previousBaseline = readPreviousReleaseBaseline(values.previousBaselinePath, legacyPolicy);
    if (previousManifest.manifestSha256 !== previousBaseline.manifestSha256) {
      throw new Error('previous manifest and baseline wrapper hashes do not match');
    }
    receiptBaseline = receiptBaselineBinding(legacyPolicy);
  }

  return Object.freeze({
    images,
    expectedPreviousRevision,
    expectedCandidateRevision,
    project,
    outputPath: path.resolve(String(values.outputPath)),
    waitTimeoutSeconds: values.waitTimeoutSeconds
      ? parsePositiveInteger(values.waitTimeoutSeconds, 'wait timeout', { minimum: 30, maximum: 900 })
      : 300,
    composeFile: DEFAULT_COMPOSE_FILE,
    legacyPolicy,
    previousManifest,
    previousBaseline,
    previousIdentityMode: legacyBootstrap ? LEGACY_IDENTITY_MODE : 'in-band-health',
    receiptBaseline,
  });
}

function defaultCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: options.env || process.env,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/, 1)[0];
    throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function composeArguments(options, trailing) {
  return ['compose', '--project-name', options.project, '--file', options.composeFile, ...trailing];
}

function composeEnvironment(options, setName, base = process.env) {
  const set = setName === 'candidate' ? {
    core: options.images.candidateCoreImage.ref,
    benchmark: options.images.candidateBenchmarkImage.ref,
    rag: options.images.candidateRagImage.ref,
  } : {
    core: options.images.previousCoreImage.ref,
    benchmark: options.images.previousBenchmarkImage.ref,
    rag: options.images.previousRagImage.ref,
  };
  return {
    ...base,
    AGENTX_UPGRADE_ROLLBACK_MONGO_IMAGE: options.images.mongoImage.ref,
    AGENTX_UPGRADE_ROLLBACK_QDRANT_IMAGE: options.images.qdrantImage.ref,
    AGENTX_UPGRADE_ROLLBACK_CORE_IMAGE: set.core,
    AGENTX_UPGRADE_ROLLBACK_BENCHMARK_IMAGE: set.benchmark,
    AGENTX_UPGRADE_ROLLBACK_RAG_IMAGE: set.rag,
  };
}

function expectedRefs(options, setName) {
  const candidate = setName === 'candidate';
  return {
    mongo: options.images.mongoImage.ref,
    qdrant: options.images.qdrantImage.ref,
    core: options.images[candidate ? 'candidateCoreImage' : 'previousCoreImage'].ref,
    benchmark: options.images[candidate ? 'candidateBenchmarkImage' : 'previousBenchmarkImage'].ref,
    rag: options.images[candidate ? 'candidateRagImage' : 'previousRagImage'].ref,
  };
}

function imageDigests(options, setName) {
  const candidate = setName === 'candidate';
  return Object.freeze({
    core: options.images[candidate ? 'candidateCoreImage' : 'previousCoreImage'].digest,
    benchmark: options.images[candidate ? 'candidateBenchmarkImage' : 'previousBenchmarkImage'].digest,
    rag: options.images[candidate ? 'candidateRagImage' : 'previousRagImage'].digest,
  });
}

function referenceFingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function referenceFingerprints(options) {
  const productSet = (candidate) => ({
    core: referenceFingerprint(options.images[candidate ? 'candidateCoreImage' : 'previousCoreImage'].ref),
    benchmark: referenceFingerprint(options.images[candidate ? 'candidateBenchmarkImage' : 'previousBenchmarkImage'].ref),
    rag: referenceFingerprint(options.images[candidate ? 'candidateRagImage' : 'previousRagImage'].ref),
  });
  return Object.freeze({
    previous: Object.freeze(productSet(false)),
    candidate: Object.freeze(productSet(true)),
    dependencies: Object.freeze({
      mongo: referenceFingerprint(options.images.mongoImage.ref),
      qdrant: referenceFingerprint(options.images.qdrantImage.ref),
    }),
  });
}

function networkKeys(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function renderedVolumeName(definition, fallback) {
  return String(definition?.name || fallback || '');
}

function environmentValues(environment, name) {
  if (Array.isArray(environment)) {
    return environment
      .filter((entry) => String(entry).startsWith(`${name}=`))
      .map((entry) => String(entry).slice(name.length + 1));
  }
  if (environment && typeof environment === 'object' && Object.hasOwn(environment, name)) {
    return [String(environment[name])];
  }
  return [];
}

function validateRenderedTopology(rendered, { project, refs }) {
  const errors = [];
  const services = rendered?.services || {};
  const serviceNames = Object.keys(services).sort();
  if (JSON.stringify(serviceNames) !== JSON.stringify([...RUNTIME_SERVICES].sort())) {
    errors.push('rendered service set is not exact');
  }
  for (const service of RUNTIME_SERVICES) {
    const definition = services[service];
    if (!definition) continue;
    if (definition.image !== refs[service]) errors.push(`${service} image does not match the selected digest reference`);
    if (definition.build != null) errors.push(`${service} contains a build definition`);
    if (definition.container_name != null) errors.push(`${service} contains a global container name`);
    if (Array.isArray(definition.ports) && definition.ports.length) errors.push(`${service} publishes a port`);
    if (definition.extra_hosts != null) errors.push(`${service} contains extra hosts`);
    if (definition.privileged === true) errors.push(`${service} is privileged`);
    if (definition.network_mode != null || definition.pid != null || definition.ipc != null) {
      errors.push(`${service} uses a shared namespace`);
    }
    if (definition.secrets != null || definition.configs != null || definition.devices != null) {
      errors.push(`${service} contains an unsupported attachment`);
    }
    if (PRODUCT_SERVICES.includes(service)) {
      const profiles = environmentValues(definition.environment, 'AGENTX_PROFILE');
      if (profiles.length !== 1 || profiles[0] !== 'demo') {
        errors.push(`${service} rendered AGENTX_PROFILE is not exactly demo`);
      }
    }
    const networks = networkKeys(definition.networks);
    if (networks.length !== 1 || networks[0] !== 'upgrade-rollback') {
      errors.push(`${service} is not attached only to the isolated network`);
    }
    const renderedNamedMounts = [];
    for (const mount of definition.volumes || []) {
      const type = typeof mount === 'string' ? 'unknown' : mount.type;
      if (type === 'bind' || type === 'unknown') errors.push(`${service} contains a bind or untyped mount`);
      if (type === 'volume') {
        renderedNamedMounts.push([String(mount.source || ''), String(mount.target || '')]);
        if (!PERSISTENT_VOLUME_KEYS.includes(String(mount.source || ''))) {
          errors.push(`${service} contains an unexpected persistent volume`);
        }
      }
    }
    const expectedNamedMounts = service === 'mongo'
      ? [['mongo-config-data', '/data/configdb'], ['mongo-data', '/data/db']]
      : service === 'qdrant' ? [['qdrant-data', '/qdrant/storage']] : [];
    const sortedMounts = (mounts) => [...mounts].sort((left, right) => left[0].localeCompare(right[0]));
    if (JSON.stringify(sortedMounts(renderedNamedMounts)) !== JSON.stringify(sortedMounts(expectedNamedMounts))) {
      errors.push(`${service} persistent volume targets are not exact`);
    }
  }

  const networks = rendered?.networks || {};
  const isolated = networks['upgrade-rollback'];
  if (Object.keys(networks).length !== 1 || isolated?.internal !== true || isolated?.external === true) {
    errors.push('rendered network is not one internal project network');
  }
  if (isolated && renderedVolumeName(isolated, '').startsWith('/') ) errors.push('invalid rendered network');
  const volumes = rendered?.volumes || {};
  if (JSON.stringify(Object.keys(volumes).sort()) !== JSON.stringify([...PERSISTENT_VOLUME_KEYS].sort())) {
    errors.push('rendered volume set is not exact');
  }
  for (const name of PERSISTENT_VOLUME_KEYS) {
    const definition = volumes[name];
    if (definition?.external === true) errors.push(`${name} is external`);
    const renderedName = renderedVolumeName(definition, `${project}_${name}`);
    if (renderedName !== `${project}_${name}`) errors.push(`${name} is not project-scoped`);
  }
  return errors;
}

function validateRuntimeVolumeMounts(mounts, { project, service }) {
  const expected = service === 'mongo'
    ? {
      '/data/db': `${project}_mongo-data`,
      '/data/configdb': `${project}_mongo-config-data`,
    }
    : service === 'qdrant'
      ? { '/qdrant/storage': `${project}_qdrant-data` }
      : {};
  const errors = [];
  let bindMountCount = 0;
  const observedTargets = new Set();
  for (const mount of mounts || []) {
    if (mount.Type === 'bind') {
      bindMountCount += 1;
      errors.push(`${service} has a bind mount`);
      continue;
    }
    if (mount.Type !== 'volume') continue;
    const destination = String(mount.Destination || '');
    const expectedName = expected[destination];
    if (!expectedName || mount.Name !== expectedName) {
      errors.push(`${service} has an unexpected named volume`);
      continue;
    }
    observedTargets.add(destination);
  }
  for (const destination of Object.keys(expected)) {
    if (!observedTargets.has(destination)) errors.push(`${service} is missing a required named volume`);
  }
  return Object.freeze({ errors: Object.freeze(errors), bindMountCount });
}

function nonemptyLines(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function projectResources(command, project) {
  const filter = `label=com.docker.compose.project=${project}`;
  return {
    containers: nonemptyLines(command('docker', ['container', 'ls', '--all', '--quiet', '--filter', filter])),
    networks: nonemptyLines(command('docker', ['network', 'ls', '--quiet', '--filter', filter])),
    volumes: nonemptyLines(command('docker', ['volume', 'ls', '--quiet', '--filter', filter])),
  };
}

function ensureFreshProject(command, project) {
  const resources = projectResources(command, project);
  if (resources.containers.length || resources.networks.length || resources.volumes.length) {
    throw new Error('the selected Compose project already owns Docker resources');
  }
}

function pullAndInspectImages(command, options) {
  const descriptors = new Map();
  for (const image of Object.values(options.images)) {
    if (descriptors.has(image.ref)) continue;
    command('docker', ['pull', '--quiet', image.ref], { timeoutMs: COMMAND_TIMEOUT_MS });
    const parsed = JSON.parse(command('docker', ['image', 'inspect', image.ref]));
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('image inspection did not return one image');
    const descriptor = parsed[0];
    if (!IMAGE_ID_PATTERN.test(String(descriptor?.Id || ''))) throw new Error('image inspection returned an invalid content identity');
    const repoDigests = Array.isArray(descriptor?.RepoDigests) ? descriptor.RepoDigests : [];
    if (!repoDigests.some((entry) => String(entry).endsWith(`@${image.digest}`))) {
      throw new Error('pulled image does not expose the selected repository digest');
    }
    descriptors.set(image.ref, Object.freeze({
      id: descriptor.Id,
      digest: image.digest,
      labels: Object.freeze({ ...(descriptor?.Config?.Labels || {}) }),
    }));
  }
  return descriptors;
}

function inspectRuntime(command, options, setName, descriptors) {
  const env = composeEnvironment(options, setName);
  const containerIds = nonemptyLines(command('docker', composeArguments(options, ['ps', '--all', '--quiet']), { env }));
  if (containerIds.length !== RUNTIME_SERVICES.length) throw new Error('runtime container set is not exact');
  const containers = JSON.parse(command('docker', ['container', 'inspect', ...containerIds]));
  const byService = new Map();
  const refs = expectedRefs(options, setName);
  const expectedNetwork = `${options.project}_upgrade-rollback`;
  let publishedPortCount = 0;
  let bindMountCount = 0;
  const identityEvidence = {};

  for (const container of containers) {
    const labels = container?.Config?.Labels || {};
    const service = labels['com.docker.compose.service'];
    if (!RUNTIME_SERVICES.includes(service) || byService.has(service)) throw new Error('runtime service labels are not exact');
    if (labels['com.docker.compose.project'] !== options.project) throw new Error('runtime project label mismatch');
    if (container?.Config?.Image !== refs[service]) throw new Error(`${service} runtime image reference mismatch`);
    const descriptor = descriptors.get(refs[service]);
    if (!descriptor || container?.Image !== descriptor.id) throw new Error(`${service} runtime image content mismatch`);
    if (container?.State?.Running !== true) throw new Error(`${service} is not running`);
    if (service !== 'qdrant' && container?.State?.Health?.Status !== 'healthy') throw new Error(`${service} is not healthy`);
    if (container?.HostConfig?.Privileged === true) throw new Error(`${service} is privileged`);
    if ((container?.HostConfig?.ExtraHosts || []).length) throw new Error(`${service} has extra hosts`);
    if (container?.HostConfig?.NetworkMode !== expectedNetwork) throw new Error(`${service} network mode mismatch`);
    const attachedNetworks = Object.keys(container?.NetworkSettings?.Networks || {});
    if (attachedNetworks.length !== 1 || attachedNetworks[0] !== expectedNetwork) {
      throw new Error(`${service} has an unexpected network attachment`);
    }
    for (const bindings of Object.values(container?.NetworkSettings?.Ports || {})) {
      if (Array.isArray(bindings)) publishedPortCount += bindings.length;
    }
    const mountValidation = validateRuntimeVolumeMounts(container?.Mounts, {
      project: options.project,
      service,
    });
    bindMountCount += mountValidation.bindMountCount;
    if (mountValidation.errors.length) throw new Error(mountValidation.errors[0]);
    byService.set(service, container);
    if (PRODUCT_SERVICES.includes(service)) {
      const profiles = environmentValues(container?.Config?.Env, 'AGENTX_PROFILE');
      identityEvidence[service] = {
        runtimeDigestVerified: true,
        renderedProfileVerified: true,
        runtimeProfileVerified: profiles.length === 1 && profiles[0] === 'demo',
        ociRevision: setName === 'previous' ? descriptor.labels[OCI_LABELS.revision] ?? null : null,
        ociVersion: setName === 'previous' ? descriptor.labels[OCI_LABELS.version] ?? null : null,
        ociSource: setName === 'previous' ? descriptor.labels[OCI_LABELS.source] ?? null : null,
        packagedVersion: null,
      };
    }
  }
  if (byService.size !== RUNTIME_SERVICES.length || publishedPortCount !== 0 || bindMountCount !== 0) {
    throw new Error('runtime boundary verification failed');
  }

  const network = JSON.parse(command('docker', ['network', 'inspect', expectedNetwork]));
  if (!Array.isArray(network) || network.length !== 1 || network[0]?.Internal !== true) {
    throw new Error('runtime network is not internal');
  }
  const networkMembers = Object.keys(network[0]?.Containers || {}).sort();
  if (networkMembers.length !== RUNTIME_SERVICES.length
    || networkMembers.some((id) => !containerIds.some((containerId) => containerId.startsWith(id) || id.startsWith(containerId)))) {
    throw new Error('runtime network membership is not exact');
  }
  for (const volumeName of PERSISTENT_VOLUME_KEYS.map((name) => `${options.project}_${name}`)) {
    const volume = JSON.parse(command('docker', ['volume', 'inspect', volumeName]));
    if (!Array.isArray(volume) || volume.length !== 1
      || volume[0]?.Labels?.['com.docker.compose.project'] !== options.project) {
      throw new Error('runtime volume is not project-scoped');
    }
  }

  if (setName === 'previous') {
    for (const service of PRODUCT_SERVICES) {
      const versionLines = nonemptyLines(command('docker', composeArguments(options, [
        'exec', '-T', service, 'node', '-p', "require('/app/package.json').version",
      ]), { env, timeoutMs: 30_000 }));
      if (versionLines.length !== 1) throw new Error(`${service} package version evidence is not exact`);
      identityEvidence[service].packagedVersion = versionLines[0];
    }
  }

  const runtimeProfilesVerified = PRODUCT_SERVICES.every(
    (service) => identityEvidence[service]?.runtimeProfileVerified === true
  );

  return Object.freeze({
    verified: runtimeProfilesVerified,
    publishedPortCount,
    bindMountCount,
    containerIds: Object.freeze(Object.fromEntries(
      RUNTIME_SERVICES.map((service) => [service, byService.get(service).Id])
    )),
    identityEvidence: Object.freeze(Object.fromEntries(PRODUCT_SERVICES.map((service) => [
      service,
      Object.freeze(identityEvidence[service]),
    ]))),
  });
}

function runControl(command, options, setName, mode, controlSource) {
  const env = composeEnvironment(options, setName);
  const output = command('docker', composeArguments(options, [
    'exec', '-T', '-e', `AGENTX_UPGRADE_ROLLBACK_MODE=${mode}`, 'core', 'node',
  ]), { env, input: controlSource, timeoutMs: 60_000 });
  const markerLines = nonemptyLines(output).filter((line) => line.startsWith(CONTROL_MARKER));
  if (markerLines.length !== 1) throw new Error('control probe did not emit one bounded result');
  return JSON.parse(markerLines[0].slice(CONTROL_MARKER.length));
}

function safeIdentityValue(field, value) {
  if (typeof value !== 'string') return null;
  if (field === 'revision') return REVISION_PATTERN.test(value) ? value : null;
  if (field === 'version') return VERSION_PATTERN.test(value) ? value : null;
  if (field === 'profile') return /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) ? value : null;
  return null;
}

function normalizeServiceIdentity(service, health, {
  identityMode,
  expectedRevision,
  runtimeEvidence,
  legacyBaseline,
  manifestBindingVerified,
}) {
  const expectedService = `agentx-${service}`;
  const fields = health?.fields || {};
  const observed = Object.fromEntries(['version', 'profile', 'revision'].map((field) => [
    field,
    {
      present: fields[field]?.present === true,
      value: safeIdentityValue(field, fields[field]?.value),
    },
  ]));
  const bootstrap = identityMode === LEGACY_IDENTITY_MODE;
  const version = bootstrap && !observed.version.present
    ? legacyBaseline?.version ?? null
    : observed.version.value;
  const profile = bootstrap && !observed.profile.present
    ? legacyBaseline?.profile ?? null
    : observed.profile.value;
  const revision = bootstrap && !observed.revision.present
    ? legacyBaseline?.commit ?? null
    : observed.revision.value;
  const completeInBandIdentity = ['version', 'profile', 'revision']
    .every((field) => observed[field].present && observed[field].value != null);
  const liveHealthVerified = health?.httpStatus === 200
    && health?.healthyStatusVerified === true
    && health?.serviceVerified === true
    && health?.service === expectedService;
  const baselineService = legacyBaseline?.services?.[service];
  const evidence = {
    httpStatus: health?.httpStatus === 200 ? 200 : null,
    healthyStatusVerified: health?.healthyStatusVerified === true,
    serviceHealthVerified: health?.serviceVerified === true && health?.service === expectedService,
    completeInBandIdentity,
    runtimeDigestVerified: runtimeEvidence?.runtimeDigestVerified === true,
    renderedProfileVerified: runtimeEvidence?.renderedProfileVerified === true,
    runtimeProfileVerified: runtimeEvidence?.runtimeProfileVerified === true,
    ociRevisionVerified: bootstrap ? runtimeEvidence?.ociRevision === legacyBaseline?.commit : null,
    ociVersionVerified: bootstrap ? runtimeEvidence?.ociVersion === legacyBaseline?.oci?.version : null,
    ociSourceVerified: bootstrap ? runtimeEvidence?.ociSource === legacyBaseline?.oci?.source : null,
    packagedVersionVerified: bootstrap ? runtimeEvidence?.packagedVersion === legacyBaseline?.version : null,
    manifestBindingVerified: manifestBindingVerified == null ? null : manifestBindingVerified === true,
  };
  const fieldSources = {
    service: 'live-health',
    version: bootstrap && !observed.version.present ? 'packaged-package-json' : 'live-health',
    profile: bootstrap && !observed.profile.present ? 'rendered-runtime-profile' : 'live-health',
    revision: bootstrap && !observed.revision.present ? 'oci-revision-label' : 'live-health',
  };
  const healthFieldsAgree = (!observed.version.present || observed.version.value === legacyBaseline?.version)
    && (!observed.profile.present || observed.profile.value === legacyBaseline?.profile)
    && (!observed.revision.present || observed.revision.value === legacyBaseline?.commit);
  const legacyValid = bootstrap
    && baselineService?.service === expectedService
    && baselineService?.digest != null
    && liveHealthVerified
    && healthFieldsAgree
    && version === legacyBaseline?.version
    && profile === legacyBaseline?.profile
    && revision === legacyBaseline?.commit
    && Object.entries(evidence).every(([key, value]) => key === 'completeInBandIdentity' || value === true || key === 'httpStatus' && value === 200);
  const inBandValid = !bootstrap
    && liveHealthVerified
    && health?.okFieldPresent === true
    && health?.ok === true
    && completeInBandIdentity
    && version != null
    && profile === 'demo'
    && revision === expectedRevision
    && evidence.runtimeDigestVerified === true
    && evidence.renderedProfileVerified === true
    && evidence.runtimeProfileVerified === true
    && evidence.manifestBindingVerified !== false;
  return Object.freeze({
    identity: Object.freeze({
      mode: identityMode,
      service: liveHealthVerified ? expectedService : null,
      version,
      profile,
      revision,
      fieldSources: Object.freeze(fieldSources),
      evidence: Object.freeze(evidence),
    }),
    valid: bootstrap ? legacyValid : inBandValid,
  });
}

function normalizePhaseObservation(probe, {
  digests,
  imageSetVerified,
  expectedRevision,
  identityMode = 'in-band-health',
  runtimeEvidence = {},
  legacyBaseline = null,
  manifestBindingVerified = true,
}) {
  const identities = {};
  const validIdentities = [];
  for (const service of PRODUCT_SERVICES) {
    const normalized = normalizeServiceIdentity(service, probe?.identities?.[service], {
      identityMode,
      expectedRevision,
      runtimeEvidence: runtimeEvidence?.[service],
      legacyBaseline,
      manifestBindingVerified,
    });
    identities[service] = normalized.identity;
    validIdentities.push(normalized.valid);
  }
  const identityValues = Object.values(identities);
  const identityConsistent = validIdentities.every(Boolean)
    && new Set(identityValues.map((value) => value.version)).size === 1
    && new Set(identityValues.map((value) => value.profile)).size === 1
    && new Set(identityValues.map((value) => value.revision)).size === 1;
  const revision = identityValues[0]?.revision;
  const expectedRevisionVerified = revision === expectedRevision && identityConsistent;
  return Object.freeze({
    imageDigests: digests,
    imageSetVerified: imageSetVerified === true,
    identities: Object.freeze(identities),
    identityConsistent,
    expectedRevisionVerified,
    journeys: {
      coreState: { passed: probe?.journeys?.coreState?.passed === true, records: probe?.journeys?.coreState?.records ?? null },
      benchmarkState: { passed: probe?.journeys?.benchmarkState?.passed === true, records: probe?.journeys?.benchmarkState?.records ?? null },
      ragState: {
        passed: probe?.journeys?.ragState?.passed === true,
        records: probe?.journeys?.ragState?.records ?? null,
        chunks: probe?.journeys?.ragState?.chunks ?? null,
      },
      vectorState: { passed: probe?.journeys?.vectorState?.passed === true, records: probe?.journeys?.vectorState?.records ?? null },
    },
    schemas: {
      fixtureSchemaVersion: probe?.schemas?.fixtureSchemaVersion ?? null,
      mongo: { passed: probe?.schemas?.mongo?.passed === true, records: probe?.schemas?.mongo?.records ?? null },
      qdrant: {
        passed: probe?.schemas?.qdrant?.passed === true,
        records: probe?.schemas?.qdrant?.records ?? null,
        vectorSize: probe?.schemas?.qdrant?.vectorSize ?? null,
      },
    },
    state: {
      mongoFingerprint: probe?.state?.mongoFingerprint ?? null,
      qdrantFingerprint: probe?.state?.qdrantFingerprint ?? null,
      combinedFingerprint: probe?.state?.combinedFingerprint ?? null,
    },
  });
}

function startInitialRuntime(command, options) {
  const env = composeEnvironment(options, 'previous');
  command('docker', composeArguments(options, [
    'up', '--detach', '--wait', '--wait-timeout', String(options.waitTimeoutSeconds),
  ]), { env, timeoutMs: COMMAND_TIMEOUT_MS });
}

function replaceProductImages(command, options, setName) {
  const env = composeEnvironment(options, setName);
  command('docker', composeArguments(options, [
    'up', '--detach', '--no-deps', '--force-recreate', '--wait',
    '--wait-timeout', String(options.waitTimeoutSeconds), 'core',
  ]), { env, timeoutMs: COMMAND_TIMEOUT_MS });
  command('docker', composeArguments(options, [
    'up', '--detach', '--no-deps', '--force-recreate', '--wait',
    '--wait-timeout', String(options.waitTimeoutSeconds), 'benchmark', 'rag',
  ]), { env, timeoutMs: COMMAND_TIMEOUT_MS });
}

function cleanupProject(command, options, setName) {
  const env = composeEnvironment(options, setName);
  try {
    command('docker', composeArguments(options, [
      'down', '--volumes', '--remove-orphans', '--timeout', '30',
    ]), { env, timeoutMs: 120_000 });
  } catch {
    // Continue to the exact label-scoped recovery pass below.
  }

  let resources = projectResources(command, options.project);
  const total = resources.containers.length + resources.networks.length + resources.volumes.length;
  if (total > 10) throw new Error('cleanup resource bound exceeded');
  if (resources.containers.length) command('docker', ['container', 'rm', '--force', ...resources.containers]);
  if (resources.networks.length) command('docker', ['network', 'rm', ...resources.networks]);
  if (resources.volumes.length) command('docker', ['volume', 'rm', ...resources.volumes]);
  resources = projectResources(command, options.project);
  return Object.freeze({
    verified: resources.containers.length === 0 && resources.networks.length === 0 && resources.volumes.length === 0,
    containers: resources.containers.length,
    networks: resources.networks.length,
    volumes: resources.volumes.length,
  });
}

function writeReceipt(outputPath, receipt) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

async function runRehearsal(options, dependencies = {}) {
  const command = dependencies.command || defaultCommand;
  const now = dependencies.now || (() => new Date());
  const controlSource = dependencies.controlSource || fs.readFileSync(CONTROL_SOURCE_PATH, 'utf8');
  const scenarioHash = crypto.createHash('sha256').update(options.project).digest('hex').slice(0, 12);
  const phases = { before: null, upgraded: null, rolledBack: null };
  let topology = {
    composeConfigHashes: { previous: null, candidate: null },
    renderedVerified: false,
    runtimeVerified: false,
    serviceCount: 5,
    internalNetworkCount: 1,
    publishedPortCount: 0,
    bindMountCount: 0,
    persistentVolumeCount: 3,
    dataContainersStable: false,
  };
  let cleanup = { verified: false, containers: null, networks: null, volumes: null };
  let ownershipEstablished = false;
  let activeSet = 'previous';
  const failureCodes = [];
  const legacyBaseline = options.previousIdentityMode === LEGACY_IDENTITY_MODE
    ? baselineFromPolicy(options.legacyPolicy)
    : null;

  try {
    command('docker', ['compose', 'version']);
    ensureFreshProject(command, options.project);
    ownershipEstablished = true;

    const composeConfigHashes = {};
    for (const setName of ['previous', 'candidate']) {
      const env = composeEnvironment(options, setName);
      const renderedBytes = command('docker', composeArguments(options, ['config', '--format', 'json']), { env });
      const rendered = JSON.parse(renderedBytes);
      const renderedErrors = validateRenderedTopology(rendered, {
        project: options.project,
        refs: expectedRefs(options, setName),
      });
      if (renderedErrors.length) throw new Error(`rendered topology failed: ${renderedErrors.join('; ')}`);
      composeConfigHashes[setName] = crypto.createHash('sha256').update(renderedBytes).digest('hex');
    }
    topology = { ...topology, composeConfigHashes, renderedVerified: true };

    const descriptors = pullAndInspectImages(command, options);
    startInitialRuntime(command, options);
    let runtime = inspectRuntime(command, options, 'previous', descriptors);
    const dataContainerIds = { mongo: runtime.containerIds.mongo, qdrant: runtime.containerIds.qdrant };
    runControl(command, options, 'previous', 'seed', controlSource);
    phases.before = normalizePhaseObservation(
      runControl(command, options, 'previous', 'probe', controlSource),
      {
        digests: imageDigests(options, 'previous'),
        imageSetVerified: runtime.verified,
        expectedRevision: options.expectedPreviousRevision,
        identityMode: options.previousIdentityMode,
        runtimeEvidence: runtime.identityEvidence,
        legacyBaseline,
        manifestBindingVerified: true,
      }
    );

    activeSet = 'candidate';
    replaceProductImages(command, options, activeSet);
    runtime = inspectRuntime(command, options, activeSet, descriptors);
    const candidateDataStable = runtime.containerIds.mongo === dataContainerIds.mongo
      && runtime.containerIds.qdrant === dataContainerIds.qdrant;
    phases.upgraded = normalizePhaseObservation(
      runControl(command, options, activeSet, 'probe', controlSource),
      {
        digests: imageDigests(options, activeSet),
        imageSetVerified: runtime.verified,
        expectedRevision: options.expectedCandidateRevision,
        identityMode: 'in-band-health',
        runtimeEvidence: runtime.identityEvidence,
        manifestBindingVerified: null,
      }
    );

    activeSet = 'previous';
    replaceProductImages(command, options, activeSet);
    runtime = inspectRuntime(command, options, activeSet, descriptors);
    const rollbackDataStable = runtime.containerIds.mongo === dataContainerIds.mongo
      && runtime.containerIds.qdrant === dataContainerIds.qdrant;
    phases.rolledBack = normalizePhaseObservation(
      runControl(command, options, activeSet, 'probe', controlSource),
      {
        digests: imageDigests(options, activeSet),
        imageSetVerified: runtime.verified,
        expectedRevision: options.expectedPreviousRevision,
        identityMode: options.previousIdentityMode,
        runtimeEvidence: runtime.identityEvidence,
        legacyBaseline,
        manifestBindingVerified: true,
      }
    );
    topology = {
      ...topology,
      runtimeVerified: runtime.verified,
      publishedPortCount: runtime.publishedPortCount,
      bindMountCount: runtime.bindMountCount,
      dataContainersStable: candidateDataStable && rollbackDataStable,
    };
  } catch (error) {
    failureCodes.push('REHEARSAL_EXECUTION_FAILED');
    if (dependencies.onExecutionError) dependencies.onExecutionError(error);
  } finally {
    if (ownershipEstablished) {
      try {
        cleanup = cleanupProject(command, options, activeSet);
      } catch (error) {
        cleanup = { verified: false, containers: null, networks: null, volumes: null };
        if (dependencies.onCleanupError) dependencies.onCleanupError(error);
      }
    }
  }

  const receipt = createUpgradeRollbackReceipt({
    generatedAt: now().toISOString(),
    scenarioHash,
    expectedRevisions: {
      previous: options.expectedPreviousRevision,
      candidate: options.expectedCandidateRevision,
    },
    previousRelease: {
      tag: options.previousManifest.manifest.tag,
      version: options.previousManifest.manifest.version,
      commit: options.previousManifest.manifest.commit,
      manifestSha256: options.previousManifest.manifestSha256,
      profile: 'demo',
      identityEvidenceMode: options.previousIdentityMode,
    },
    legacyBaseline: options.receiptBaseline,
    images: {
      previous: imageDigests(options, 'previous'),
      candidate: imageDigests(options, 'candidate'),
      dependencies: {
        mongo: options.images.mongoImage.digest,
        qdrant: options.images.qdrantImage.digest,
      },
      referenceFingerprints: referenceFingerprints(options),
    },
    topology,
    phases,
    cleanup,
    failureCodes,
  });
  const receiptErrors = validateUpgradeRollbackReceipt(receipt);
  if (receiptErrors.length) throw new RehearsalError(`upgrade rollback receipt validation failed: ${receiptErrors.join('; ')}`);
  writeReceipt(options.outputPath, receipt);
  if (receipt.status !== 'pass') throw new RehearsalError('upgrade rollback rehearsal failed closed', { receipt });
  return receipt;
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, dependencies.env || process.env, dependencies);
  return runRehearsal(options, dependencies);
}

if (require.main === module) {
  runCli()
    .then((receipt) => {
      process.stdout.write(`upgrade rollback rehearsal ok: assertions=${receipt.summary.passed}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONTROL_MARKER,
  DEFAULT_COMPOSE_FILE,
  DEFAULT_PIN_FILE,
  IMAGE_REF_PATTERN,
  PROJECT_PATTERN,
  RehearsalError,
  PERSISTENT_VOLUME_KEYS,
  cleanupProject,
  composeArguments,
  composeEnvironment,
  dependencyPins,
  exactImageReference,
  expectedRefs,
  generatedProjectName,
  imageDigests,
  normalizePhaseObservation,
  parseArgs,
  projectResources,
  referenceFingerprint,
  referenceFingerprints,
  runCli,
  runControl,
  runRehearsal,
  validateRenderedTopology,
  validateRuntimeVolumeMounts,
};

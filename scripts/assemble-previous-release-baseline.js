#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_POLICY_FILE,
  PRODUCT_SERVICES,
  loadLegacyReleasePolicy,
  previousReleaseBaselineTemplate,
  validatePreviousManifestBytes,
  validatePreviousReleaseBaseline,
} = require('../e2e/upgrade-rollback-baseline');

const OCI_LABELS = Object.freeze({
  revision: 'org.opencontainers.image.revision',
  version: 'org.opencontainers.image.version',
  source: 'org.opencontainers.image.source',
});
const MAX_INSPECT_OUTPUT_BYTES = 16 * 1024;

function defaultPull(ref) {
  try {
    childProcess.execFileSync('docker', ['pull', '--quiet', ref], {
      encoding: 'utf8',
      maxBuffer: MAX_INSPECT_OUTPUT_BYTES,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw new Error('failed to pull an exact allowlisted previous release image');
  }
}

function defaultInspect(ref, field) {
  const format = field === 'repoDigests'
    ? '{{json .RepoDigests}}'
    : `{{ index .Config.Labels "${OCI_LABELS[field]}" }}`;
  const output = childProcess.execFileSync('docker', [
    'image', 'inspect', '--format', format, ref,
  ], {
    encoding: 'utf8',
    maxBuffer: MAX_INSPECT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return output.trim();
}

function repoDigestsFromInspect(value, service) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${service} image RepoDigests inspection is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32
      || parsed.some((entry) => typeof entry !== 'string' || entry.length > 512)) {
    throw new Error(`${service} image RepoDigests inspection is not a bounded string array`);
  }
  return parsed;
}

function inspectAndValidateOciEvidence(template, inspect = defaultInspect) {
  for (const service of PRODUCT_SERVICES) {
    const image = template.images[service];
    const labels = template.ociLabels[service];
    const repoDigests = repoDigestsFromInspect(inspect(image.ref, 'repoDigests'), service);
    if (!repoDigests.includes(image.ref)) {
      throw new Error(`${service} pulled image does not expose the exact allowlisted RepoDigest`);
    }
    for (const field of Object.keys(OCI_LABELS)) {
      const observed = String(inspect(image.ref, field));
      if (observed !== labels[field]) {
        throw new Error(`${service} pulled image ${OCI_LABELS[field]} label is not exact`);
      }
    }
  }
}

function assemblePreviousReleaseBaseline({
  manifestPath,
  expectedTag,
  policyFile = DEFAULT_POLICY_FILE,
  inspect = defaultInspect,
  pull = null,
}) {
  const policy = loadLegacyReleasePolicy(policyFile);
  const baseline = previousReleaseBaselineTemplate(policy);
  const bytes = fs.readFileSync(path.resolve(manifestPath));
  const raw = validatePreviousManifestBytes(bytes, policy);
  if (raw.errors.length) throw new Error(raw.errors[0]);
  if (raw.manifest.tag !== expectedTag) {
    throw new Error('previous release manifest tag does not match the selected GitHub release');
  }
  if (pull) {
    for (const service of PRODUCT_SERVICES) pull(baseline.images[service].ref);
  }
  inspectAndValidateOciEvidence(baseline, inspect);
  const errors = validatePreviousReleaseBaseline(baseline, policy);
  if (errors.length) throw new Error(errors[0]);
  return baseline;
}

function parseArgs(argv) {
  const options = {};
  const mapping = {
    '--manifest': 'manifestPath',
    '--output': 'outputPath',
    '--expected-tag': 'expectedTag',
    '--policy': 'policyFile',
    '--github-output': 'githubOutput',
    '--pull-exact-images': 'pullExactImages',
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
    options[key] = ['expectedTag', 'pullExactImages'].includes(key) ? value : path.resolve(value);
  }
  for (const key of ['manifestPath', 'outputPath', 'expectedTag']) {
    if (!options[key]) throw new Error(`${key} is required`);
  }
  options.policyFile = options.policyFile || DEFAULT_POLICY_FILE;
  if (options.pullExactImages != null && options.pullExactImages !== 'true') {
    throw new Error('--pull-exact-images accepts only true');
  }
  options.pull = options.pullExactImages === 'true' ? defaultPull : null;
  return options;
}

function appendGithubOutputs(outputPath, baseline) {
  const rows = [
    `previous_identity_evidence_mode=${baseline.identityEvidenceMode}`,
    `previous_tag=${baseline.tag}`,
    `previous_version=${baseline.version}`,
    `previous_revision=${baseline.commit}`,
    `previous_manifest_sha256=${baseline.manifestSha256}`,
    `previous_profile=${baseline.profile}`,
  ];
  for (const service of PRODUCT_SERVICES) {
    rows.push(`previous_${service}_digest=${baseline.images[service].digest}`);
    rows.push(`previous_${service}_ref=${baseline.images[service].ref}`);
  }
  fs.appendFileSync(outputPath, `${rows.join('\n')}\n`, 'utf8');
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const baseline = assemblePreviousReleaseBaseline(options);
    fs.writeFileSync(options.outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    if (options.githubOutput) appendGithubOutputs(options.githubOutput, baseline);
    process.stdout.write(`previous release baseline ok: ${baseline.tag} ${baseline.identityEvidenceMode}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_INSPECT_OUTPUT_BYTES,
  OCI_LABELS,
  appendGithubOutputs,
  assemblePreviousReleaseBaseline,
  defaultInspect,
  defaultPull,
  inspectAndValidateOciEvidence,
  parseArgs,
  repoDigestsFromInspect,
};

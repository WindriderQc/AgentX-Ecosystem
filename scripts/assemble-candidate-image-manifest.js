#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SCHEMA = 'agentx.candidate-image-manifest/v1';
const RECEIPT_SCHEMA = 'agentx.immutable-image-receipt/v1';
const SERVICES = Object.freeze(['core', 'benchmark', 'rag']);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 64 * 1024;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function expectedImage(service) {
  return `ghcr.io/windriderqc/agentx-${service}`;
}

function readBoundedJson(filePath, label = path.basename(filePath)) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} must be between 1 and ${MAX_JSON_BYTES} bytes`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateImageRecord(record, service, commit, label) {
  const errors = [];
  if (!exactKeys(record, ['image', 'digest', 'ref'])) {
    errors.push(`${label} shape is invalid`);
    return errors;
  }
  const image = expectedImage(service);
  if (record.image !== image) errors.push(`${label}.image must be ${image}`);
  if (!DIGEST_PATTERN.test(String(record.digest || ''))) errors.push(`${label}.digest is invalid`);
  if (record.ref !== `${image}@${record.digest}`) errors.push(`${label}.ref is not the canonical digest reference`);
  if (!COMMIT_PATTERN.test(commit)) errors.push(`${label} commit binding is invalid`);
  return errors;
}

function validateImmutableImageReceipt(receipt, { service, commit }) {
  const errors = [];
  const label = `${service} immutable image receipt`;
  if (!exactKeys(receipt, ['schema', 'service', 'commit', 'image', 'digest', 'ref'])) {
    errors.push(`${label} shape is invalid`);
    return errors;
  }
  if (receipt.schema !== RECEIPT_SCHEMA) errors.push(`${label} schema is invalid`);
  if (receipt.service !== service) errors.push(`${label} service is invalid`);
  if (receipt.commit !== commit) errors.push(`${label} commit does not match ${commit}`);
  errors.push(...validateImageRecord({
    image: receipt.image,
    digest: receipt.digest,
    ref: receipt.ref,
  }, service, commit, label));
  return errors;
}

function validateCandidateImageManifest(manifest, { expectedCommit = null } = {}) {
  const errors = [];
  if (!exactKeys(manifest, ['schema', 'commit', 'images'])) {
    errors.push('candidate image manifest shape is invalid');
    return errors;
  }
  if (manifest.schema !== MANIFEST_SCHEMA) errors.push('candidate image manifest schema is invalid');
  if (!COMMIT_PATTERN.test(String(manifest.commit || ''))) errors.push('candidate image manifest commit is invalid');
  if (expectedCommit != null && manifest.commit !== expectedCommit) {
    errors.push(`candidate image manifest commit does not match ${expectedCommit}`);
  }
  if (!exactKeys(manifest.images, SERVICES)) {
    errors.push('candidate image manifest service set is not exact');
    return errors;
  }
  for (const service of SERVICES) {
    errors.push(...validateImageRecord(
      manifest.images[service],
      service,
      manifest.commit,
      `candidate image manifest images.${service}`
    ));
  }
  return errors;
}

function assertCandidateImageManifest(manifest, options = {}) {
  const errors = validateCandidateImageManifest(manifest, options);
  if (errors.length) throw new Error(`Invalid Agent X candidate image manifest:\n- ${errors.join('\n- ')}`);
  return manifest;
}

function assembleCandidateImageManifest({ receiptsDir, commit }) {
  const normalizedCommit = String(commit || '').trim().toLowerCase();
  if (!COMMIT_PATTERN.test(normalizedCommit)) {
    throw new Error(`candidate commit must be a full lowercase Git SHA; received ${JSON.stringify(commit)}`);
  }
  const entries = fs.readdirSync(receiptsDir, { withFileTypes: true });
  const expectedFiles = SERVICES.map((service) => `${service}.json`).sort();
  const actualFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile())
      || JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`immutable image receipt file set must be exactly ${expectedFiles.join(', ')}`);
  }

  const images = {};
  const errors = [];
  for (const service of SERVICES) {
    const receipt = readBoundedJson(path.join(receiptsDir, `${service}.json`));
    const receiptErrors = validateImmutableImageReceipt(receipt, { service, commit: normalizedCommit });
    errors.push(...receiptErrors);
    if (!receiptErrors.length) {
      images[service] = { image: receipt.image, digest: receipt.digest, ref: receipt.ref };
    }
  }
  if (errors.length) throw new Error(`Invalid Agent X immutable image receipts:\n- ${errors.join('\n- ')}`);
  return assertCandidateImageManifest({ schema: MANIFEST_SCHEMA, commit: normalizedCommit, images }, {
    expectedCommit: normalizedCommit,
  });
}

function parseArgs(argv) {
  const options = {};
  const mapping = {
    '--receipts': 'receiptsDir',
    '--output': 'output',
    '--commit': 'commit',
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
    options[key] = key === 'commit' ? value : path.resolve(value);
  }
  for (const key of ['receiptsDir', 'output', 'commit']) {
    if (!options[key]) throw new Error(`${key} is required`);
  }
  return options;
}

function appendGithubOutputs(outputPath, manifest) {
  const rows = [`commit=${manifest.commit}`];
  for (const service of SERVICES) {
    rows.push(`${service}_image=${manifest.images[service].image}`);
    rows.push(`${service}_digest=${manifest.images[service].digest}`);
    rows.push(`${service}_ref=${manifest.images[service].ref}`);
  }
  fs.appendFileSync(outputPath, `${rows.join('\n')}\n`, 'utf8');
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = assembleCandidateImageManifest(options);
    fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (options.githubOutput) appendGithubOutputs(options.githubOutput, manifest);
    process.stdout.write(`candidate image manifest ok: ${path.basename(options.output)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  MANIFEST_SCHEMA,
  MAX_JSON_BYTES,
  RECEIPT_SCHEMA,
  SERVICES,
  appendGithubOutputs,
  assembleCandidateImageManifest,
  assertCandidateImageManifest,
  exactKeys,
  expectedImage,
  readBoundedJson,
  validateCandidateImageManifest,
  validateImmutableImageReceipt,
};

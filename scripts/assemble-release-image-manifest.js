#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { SERVICES, VERSION_PATTERN } = require('./verify-release-contract');

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--receipts') options.receiptsDir = path.resolve(argv[++index] || '');
    else if (arg === '--output') options.output = path.resolve(argv[++index] || '');
    else if (arg === '--tag') options.tag = argv[++index] || '';
    else if (arg === '--commit') options.commit = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['receiptsDir', 'output', 'tag', 'commit']) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return options;
}

function readReceipt(filePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${path.basename(filePath)}: ${error.message}`);
    return null;
  }
}

function assembleReleaseImageManifest({ receiptsDir, tag, commit }) {
  const errors = [];
  const normalizedTag = String(tag || '').trim();
  const version = normalizedTag.startsWith('v') ? normalizedTag.slice(1) : '';
  const normalizedCommit = String(commit || '').trim().toLowerCase();
  if (!normalizedTag.startsWith('v') || !VERSION_PATTERN.test(version)) {
    errors.push(`release tag must be exact semver with a v prefix; received ${JSON.stringify(tag)}`);
  }
  if (!COMMIT_PATTERN.test(normalizedCommit)) {
    errors.push(`release commit must be a full lowercase Git SHA; received ${JSON.stringify(commit)}`);
  }

  const images = {};
  for (const service of Object.keys(SERVICES)) {
    const receiptPath = path.join(receiptsDir, `${service}.json`);
    const receipt = readReceipt(receiptPath, errors);
    if (!receipt) continue;
    const expectedImage = `ghcr.io/windriderqc/agentx-${service}`;
    if (receipt.schemaVersion !== 1) errors.push(`${service} receipt schemaVersion must be 1`);
    if (receipt.service !== service) errors.push(`${service} receipt has service ${JSON.stringify(receipt.service)}`);
    if (receipt.image !== expectedImage) errors.push(`${service} receipt image must be ${expectedImage}`);
    if (receipt.tag !== normalizedTag) errors.push(`${service} receipt tag does not match ${normalizedTag}`);
    if (String(receipt.commit || '').toLowerCase() !== normalizedCommit) errors.push(`${service} receipt commit does not match ${normalizedCommit}`);
    if (!DIGEST_PATTERN.test(String(receipt.digest || ''))) errors.push(`${service} receipt has an invalid image digest`);
    images[service] = {
      image: expectedImage,
      digest: receipt.digest,
      ref: `${expectedImage}@${receipt.digest}`,
    };
  }

  if (errors.length) {
    throw new Error(`Agent X release image receipt failed:\n- ${errors.join('\n- ')}`);
  }
  return {
    schemaVersion: 1,
    product: 'Agent X Ecosystem',
    version,
    tag: normalizedTag,
    commit: normalizedCommit,
    images,
  };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = assembleReleaseImageManifest(options);
    fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`release image manifest ok: ${path.basename(options.output)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  assembleReleaseImageManifest,
};

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SERVICES = Object.freeze({
  core: 'agentx-core',
  benchmark: 'agentx-benchmark',
  rag: 'agentx-rag',
});
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(filePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${path.relative(process.cwd(), filePath) || filePath}: ${error.message}`);
    return null;
  }
}

function normalizeTag(tag, errors) {
  if (!tag) return null;
  if (!tag.startsWith('v') || !VERSION_PATTERN.test(tag.slice(1))) {
    errors.push(`release tag must be exact semver with a v prefix; received ${JSON.stringify(tag)}`);
    return null;
  }
  return tag.slice(1);
}

function verifyReleaseContract({ root = path.resolve(__dirname, '..'), tag = '' } = {}) {
  const errors = [];
  const expectedFromTag = normalizeTag(String(tag || '').trim(), errors);
  const versions = {};

  for (const [service, expectedName] of Object.entries(SERVICES)) {
    const serviceRoot = path.join(root, service);
    const packagePath = path.join(serviceRoot, 'package.json');
    const lockPath = path.join(serviceRoot, 'package-lock.json');
    const manifest = readJson(packagePath, errors);
    const lock = readJson(lockPath, errors);
    if (!manifest || !lock) continue;

    const packageVersion = String(manifest.version || '');
    const lockVersion = String(lock.version || '');
    const lockRootVersion = String(lock.packages?.['']?.version || '');
    versions[service] = packageVersion;

    if (manifest.name !== expectedName) {
      errors.push(`${service}/package.json name must be ${expectedName}; received ${JSON.stringify(manifest.name)}`);
    }
    if (!VERSION_PATTERN.test(packageVersion)) {
      errors.push(`${service}/package.json has an invalid semver version ${JSON.stringify(packageVersion)}`);
    }
    if (lockVersion !== packageVersion) {
      errors.push(`${service}/package-lock.json version ${JSON.stringify(lockVersion)} does not match package version ${JSON.stringify(packageVersion)}`);
    }
    if (lockRootVersion !== packageVersion) {
      errors.push(`${service}/package-lock.json root package version ${JSON.stringify(lockRootVersion)} does not match package version ${JSON.stringify(packageVersion)}`);
    }
    if (expectedFromTag && packageVersion !== expectedFromTag) {
      errors.push(`${service} package version ${packageVersion} does not match release tag v${expectedFromTag}`);
    }
  }

  const distinctVersions = [...new Set(Object.values(versions))];
  if (distinctVersions.length > 1) {
    errors.push(`Core, Benchmark, and RAG versions differ: ${JSON.stringify(versions)}`);
  }

  if (expectedFromTag) {
    const notesPath = path.join(root, 'docs', 'releases', `v${expectedFromTag}.md`);
    if (!fs.existsSync(notesPath)) {
      errors.push(`release notes are missing: docs/releases/v${expectedFromTag}.md`);
    } else {
      const notes = fs.readFileSync(notesPath, 'utf8');
      if (!notes.includes(`# Agent X Ecosystem v${expectedFromTag}`)) {
        errors.push(`release notes must contain the exact heading: # Agent X Ecosystem v${expectedFromTag}`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`Agent X release contract failed:\n- ${errors.join('\n- ')}`);
  }

  return Object.freeze({
    tag: expectedFromTag ? `v${expectedFromTag}` : null,
    version: expectedFromTag || distinctVersions[0],
    services: Object.freeze({ ...versions }),
  });
}

function parseArgs(argv) {
  const options = { root: path.resolve(__dirname, '..'), tag: process.env.AGENTX_RELEASE_TAG || '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--tag') options.tag = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const receipt = verifyReleaseContract(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `release contract ok: version=${receipt.version} tag=${receipt.tag || 'not-set'} services=${Object.keys(receipt.services).join(',')}\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { SERVICES, VERSION_PATTERN, verifyReleaseContract };

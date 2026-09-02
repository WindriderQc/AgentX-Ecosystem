#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  buildBenchmarkBlindReviewPackage,
} = require('../../shared/benchmarkBlindReviewPacket');

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const OUTPUT_FILES = Object.freeze({
  packet: 'review-packet.json',
  controlManifest: 'control-manifest.operator-only.json',
  responseTemplate: 'review-response-template.json',
});

function parseArgs(argv = process.argv.slice(2)) {
  const options = { inputPath: null, outputDirectory: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inline] = argument.includes('=') ? argument.split(/=(.*)/s, 2) : [argument, null];
    const take = () => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--input') options.inputPath = path.resolve(String(take()));
    else if (flag === '--output-dir') options.outputDirectory = path.resolve(String(take()));
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.help) {
    if (!options.inputPath) throw new Error('--input is required');
    if (!options.outputDirectory) throw new Error('--output-dir is required');
    if (options.inputPath === options.outputDirectory
        || options.outputDirectory.startsWith(`${options.inputPath}${path.sep}`)) {
      throw new Error('output directory must be separate from the source bundle');
    }
  }
  return options;
}

function readBoundedJson(filePath, dependencies = {}) {
  const statSync = dependencies.statSync || fs.statSync;
  const readFileSync = dependencies.readFileSync || fs.readFileSync;
  let metadata;
  try {
    metadata = statSync(filePath);
  } catch (_error) {
    throw new Error('source bundle is unavailable');
  }
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SOURCE_BYTES) {
    throw new Error(`source bundle must be a non-empty file no larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (_error) {
    throw new Error('source bundle is not valid JSON');
  }
  return parsed;
}

function writePackage(outputDirectory, reviewPackage, dependencies = {}) {
  const mkdirSync = dependencies.mkdirSync || fs.mkdirSync;
  const writeFileSync = dependencies.writeFileSync || fs.writeFileSync;
  if ((dependencies.existsSync || fs.existsSync)(outputDirectory)) {
    throw new Error('output directory already exists; packet preparation never overwrites review evidence');
  }
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const artifacts = {
    packet: reviewPackage.packet,
    controlManifest: reviewPackage.controlManifest,
    responseTemplate: reviewPackage.responseTemplate,
  };
  for (const [name, value] of Object.entries(artifacts)) {
    writeFileSync(
      path.join(outputDirectory, OUTPUT_FILES[name]),
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
  }
  return Object.fromEntries(
    Object.entries(OUTPUT_FILES).map(([name, file]) => [name, path.join(outputDirectory, file)])
  );
}

function printHelp() {
  process.stdout.write(
    'Usage: node benchmark/scripts/prepare-blind-review-packet.js '
    + '--input SOURCE_BUNDLE.json --output-dir NEW_DIRECTORY\n\n'
    + 'Builds a reviewer-safe packet, a separate operator-only control manifest, and a blank response template. '
    + 'The source bundle must contain exactly 175 sealed results with 2 validation and 3 holdout reviews per category/difficulty cell. '
    + 'The command never launches a campaign, calls a model/provider, creates a key, signs evidence, or overwrites an existing directory.\n'
  );
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) return printHelp();
  const source = readBoundedJson(options.inputPath, dependencies);
  const reviewPackage = buildBenchmarkBlindReviewPackage(source);
  const files = writePackage(options.outputDirectory, reviewPackage, dependencies);
  const receipt = {
    schema: 'agentx.benchmark-blind-review-package-preparation-receipt/v1',
    packetId: reviewPackage.packet.packetId,
    manifestId: reviewPackage.controlManifest.manifestId,
    corpusFingerprint: reviewPackage.packet.corpusFingerprint,
    itemCount: reviewPackage.packet.items.length,
    files,
    authorization: 'offline preparation only; no campaign, inference, signing, import, ratification, or promotion',
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Blind review packet preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_SOURCE_BYTES,
  OUTPUT_FILES,
  main,
  parseArgs,
  readBoundedJson,
  writePackage,
};

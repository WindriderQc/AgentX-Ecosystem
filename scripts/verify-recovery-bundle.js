#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  GIT_REVISION_PATTERN,
  RECOVERY_ARTIFACTS,
  SHA256_PATTERN,
  assertRecoveryBundleManifest,
} = require('../shared/recoveryBundleContract');

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKSUM_BYTES = 65;
const ROOT_ENTRIES = Object.freeze(['artifacts', 'manifest.json', 'manifest.sha256']);
const ARTIFACT_ENTRIES = Object.freeze(RECOVERY_ARTIFACTS.map(({ path: artifactPath }) => (
  artifactPath.slice('artifacts/'.length)
)));

class RecoveryBundleVerificationError extends Error {
  constructor(message, code = 'RECOVERY_BUNDLE_INVALID') {
    super(message);
    this.name = 'RecoveryBundleVerificationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new RecoveryBundleVerificationError(message, code);
}

function normalizeComparablePath(value) {
  let normalized = path.resolve(value);
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\/, '').toLowerCase();
  }
  return normalized.replace(/[\\/]+$/, '');
}

function samePath(left, right) {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function lstatOrFail(targetPath, label) {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} is missing`, 'RECOVERY_BUNDLE_TOPOLOGY');
    fail(`${label} cannot be inspected: ${error.message}`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
}

async function assertSafeDirectory(directoryPath, label, containmentRoot = null) {
  const stat = await lstatOrFail(directoryPath, label);
  if (stat.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link or reparse point`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  if (!stat.isDirectory()) {
    fail(`${label} must be a directory`, 'RECOVERY_BUNDLE_NOT_DIRECTORY');
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(directoryPath);
  } catch (error) {
    fail(`${label} cannot be resolved safely: ${error.message}`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  const resolvedPath = path.resolve(directoryPath);
  if (!samePath(realPath, resolvedPath)) {
    fail(`${label} resolves through a symbolic link or reparse point`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  if (containmentRoot && !isWithin(containmentRoot, realPath)) {
    fail(`${label} resolves outside the recovery bundle`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  return realPath;
}

async function assertExactDirectoryEntries(directoryPath, expectedEntries, label) {
  let entries;
  try {
    entries = await fs.promises.readdir(directoryPath);
  } catch (error) {
    fail(`${label} cannot be listed: ${error.message}`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  const actual = [...entries].sort();
  const expected = [...expectedEntries].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    fail(
      `${label} must contain exactly ${expected.join(', ')}; received ${actual.join(', ') || '(empty)'}`,
      'RECOVERY_BUNDLE_TOPOLOGY'
    );
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openSafeRegularFile(filePath, rootRealPath, label) {
  const initial = await lstatOrFail(filePath, label);
  if (initial.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link or reparse point`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  if (!initial.isFile()) {
    fail(`${label} must be a regular file`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(filePath);
  } catch (error) {
    fail(`${label} cannot be resolved safely: ${error.message}`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }
  if (!samePath(realPath, path.resolve(filePath)) || !isWithin(rootRealPath, realPath)) {
    fail(`${label} resolves through a symbolic link, reparse point, or outside the bundle`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }

  let flags = fs.constants.O_RDONLY;
  if (Number.isInteger(fs.constants.O_NOFOLLOW)) flags |= fs.constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fs.promises.open(filePath, flags);
  } catch (error) {
    fail(`${label} cannot be opened safely: ${error.message}`, 'RECOVERY_BUNDLE_TOPOLOGY');
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) {
      fail(`${label} changed identity while it was being opened`, 'RECOVERY_BUNDLE_TOPOLOGY');
    }
    return { handle, opened };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function streamRegularFile(filePath, rootRealPath, label, options = {}) {
  const { maxBytes = null, collect = false } = options;
  const { handle, opened } = await openSafeRegularFile(filePath, rootRealPath, label);
  if (!Number.isSafeInteger(opened.size) || opened.size < 0) {
    await handle.close().catch(() => {});
    fail(`${label} has an unsupported byte size`, 'RECOVERY_BUNDLE_INTEGRITY');
  }
  if (maxBytes !== null && opened.size > maxBytes) {
    await handle.close().catch(() => {});
    fail(`${label} exceeds the ${maxBytes}-byte limit`, 'RECOVERY_BUNDLE_INTEGRITY');
  }

  const hash = crypto.createHash('sha256');
  const chunks = [];
  let bytes = 0;
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes) || (maxBytes !== null && bytes > maxBytes)) {
        fail(`${label} changed or exceeded its byte limit while being read`, 'RECOVERY_BUNDLE_INTEGRITY');
      }
      hash.update(chunk);
      if (collect) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || bytes !== opened.size
    ) {
      fail(`${label} changed while it was being verified`, 'RECOVERY_BUNDLE_INTEGRITY');
    }
    return {
      bytes,
      sha256: hash.digest('hex'),
      buffer: collect ? Buffer.concat(chunks, bytes) : null,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseManifestChecksum(buffer) {
  const text = buffer.toString('utf8');
  const match = /^([0-9a-f]{64})\n?$/.exec(text);
  if (!match || !SHA256_PATTERN.test(match[1])) {
    fail('manifest.sha256 must contain one lowercase SHA-256 digest and an optional final LF', 'RECOVERY_BUNDLE_INTEGRITY');
  }
  return match[1];
}

function parseManifest(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    fail(`manifest.json is not valid JSON: ${error.message}`, 'RECOVERY_BUNDLE_MANIFEST');
  }
}

async function verifyRecoveryBundle({ bundlePath, expectedProductRevision } = {}) {
  if (typeof bundlePath !== 'string' || !bundlePath.trim()) {
    fail('bundlePath must name a recovery bundle directory', 'RECOVERY_BUNDLE_NOT_DIRECTORY');
  }
  if (typeof expectedProductRevision !== 'string' || !GIT_REVISION_PATTERN.test(expectedProductRevision)) {
    fail('expectedProductRevision must be a full 40-character lowercase Git revision', 'RECOVERY_BUNDLE_REVISION');
  }

  const resolvedBundlePath = path.resolve(bundlePath);
  const bundleRealPath = await assertSafeDirectory(resolvedBundlePath, 'recovery bundle path');
  await assertExactDirectoryEntries(resolvedBundlePath, ROOT_ENTRIES, 'recovery bundle root');

  const artifactsDirectory = path.join(resolvedBundlePath, 'artifacts');
  await assertSafeDirectory(artifactsDirectory, 'artifacts directory', bundleRealPath);
  await assertExactDirectoryEntries(artifactsDirectory, ARTIFACT_ENTRIES, 'artifacts directory');

  const manifestPath = path.join(resolvedBundlePath, 'manifest.json');
  const checksumPath = path.join(resolvedBundlePath, 'manifest.sha256');
  const manifestFile = await streamRegularFile(manifestPath, bundleRealPath, 'manifest.json', {
    maxBytes: MAX_MANIFEST_BYTES,
    collect: true,
  });
  const checksumFile = await streamRegularFile(checksumPath, bundleRealPath, 'manifest.sha256', {
    maxBytes: MAX_CHECKSUM_BYTES,
    collect: true,
  });
  const expectedManifestChecksum = parseManifestChecksum(checksumFile.buffer);
  if (manifestFile.sha256 !== expectedManifestChecksum) {
    fail('manifest.json SHA-256 does not match manifest.sha256', 'RECOVERY_BUNDLE_INTEGRITY');
  }

  const manifest = parseManifest(manifestFile.buffer);
  try {
    assertRecoveryBundleManifest(manifest);
  } catch (error) {
    fail(error.message, 'RECOVERY_BUNDLE_MANIFEST');
  }
  if (manifest.product.revision !== expectedProductRevision) {
    fail(
      `bundle product revision ${manifest.product.revision} does not exactly match expected revision ${expectedProductRevision}`,
      'RECOVERY_BUNDLE_REVISION'
    );
  }

  const verifiedArtifacts = [];
  for (const artifact of manifest.artifacts) {
    const artifactFile = await streamRegularFile(
      path.join(resolvedBundlePath, ...artifact.path.split('/')),
      bundleRealPath,
      artifact.path
    );
    if (artifactFile.bytes !== artifact.bytes) {
      fail(`${artifact.path} byte count does not match its manifest entry`, 'RECOVERY_BUNDLE_INTEGRITY');
    }
    if (artifactFile.sha256 !== artifact.sha256) {
      fail(`${artifact.path} SHA-256 does not match its manifest entry`, 'RECOVERY_BUNDLE_INTEGRITY');
    }
    verifiedArtifacts.push({
      role: artifact.role,
      path: artifact.path,
      bytes: artifactFile.bytes,
      sha256: artifactFile.sha256,
      mediaType: artifact.mediaType,
    });
  }

  return {
    valid: true,
    schema: manifest.schema,
    bundleId: manifest.bundleId,
    productVersion: manifest.product.version,
    productProfile: manifest.product.profile,
    productRevision: manifest.product.revision,
    compatibility: manifest.compatibility.mode,
    dependencies: {
      mongodb: {
        serverVersion: manifest.dependencies.mongodb.serverVersion,
        toolsVersion: manifest.dependencies.mongodb.toolsVersion,
      },
      qdrant: {
        serverVersion: manifest.dependencies.qdrant.serverVersion,
      },
    },
    captureComplete: manifest.capture.complete,
    restoreVerified: false,
    artifacts: verifiedArtifacts,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--bundle') {
      if (options.bundlePath !== undefined) throw new Error('--bundle may only be provided once');
      options.bundlePath = argv[++index];
    } else if (argument === '--product-revision') {
      if (options.expectedProductRevision !== undefined) throw new Error('--product-revision may only be provided once');
      options.expectedProductRevision = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.bundlePath) throw new Error('--bundle is required');
  if (!options.expectedProductRevision) throw new Error('--product-revision is required');
  return options;
}

if (require.main === module) {
  (async () => {
    try {
      const result = await verifyRecoveryBundle(parseArgs(process.argv.slice(2)));
      process.stdout.write(
        `recovery bundle verified: ${result.bundleId} at product revision ${result.productRevision}\n`
      );
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  ARTIFACT_ENTRIES,
  MAX_CHECKSUM_BYTES,
  MAX_MANIFEST_BYTES,
  ROOT_ENTRIES,
  RecoveryBundleVerificationError,
  parseArgs,
  parseManifestChecksum,
  streamRegularFile,
  verifyRecoveryBundle,
};

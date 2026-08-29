'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const INVENTORY_PATH = path.join(REPO_ROOT, 'config', 'container-image-pins.json');
const DIGEST_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$/;

const EXPECTED_DECLARATIONS = Object.freeze([
  Object.freeze({ file: 'docker-compose.yml', kind: 'image', image: 'mongodb', count: 1 }),
  Object.freeze({ file: 'docker-compose.yml', kind: 'image', image: 'qdrant', count: 1 }),
  Object.freeze({ file: 'docker-compose.ollama.yml', kind: 'image', image: 'ollama', count: 1 }),
  Object.freeze({ file: 'docker-compose.live-cancellation.yml', kind: 'image', image: 'mongodb', count: 1 }),
  Object.freeze({ file: 'docker/core.Dockerfile', kind: 'from', image: 'mongodb', count: 1 }),
  Object.freeze({ file: 'docker/core.Dockerfile', kind: 'from', image: 'node-runtime', count: 1 }),
  Object.freeze({ file: 'docker/benchmark.Dockerfile', kind: 'from', image: 'node-runtime', count: 1 }),
  Object.freeze({ file: 'docker/rag.Dockerfile', kind: 'from', image: 'node-runtime', count: 1 }),
  Object.freeze({ file: 'docker/live-cancellation-fixture.Dockerfile', kind: 'from', image: 'node-runtime', count: 1 }),
  Object.freeze({ file: 'benchmark/Dockerfile', kind: 'from', image: 'node-runtime', count: 1 }),
  Object.freeze({ file: 'scripts/run-recovery-drill.js', kind: 'inventory-key', image: 'recovery-helper', count: 1 }),
]);

function countExactDeclaration(source, kind, reference) {
  if (kind === 'inventory-key') {
    const marker = `inventory?.images?.['${reference}']`;
    return source.split(marker).length - 1;
  }
  const prefix = kind === 'from' ? 'FROM' : 'image:';
  return source
    .split(/\r?\n/)
    .filter(line => line.trim().startsWith(prefix))
    .filter(line => {
      const normalized = line.trim().replace(/^FROM\s+/i, '').replace(/^image:\s*/, '');
      return normalized === reference || normalized.startsWith(`${reference} AS `);
    })
    .length;
}

function validateInventory(inventory) {
  const errors = [];
  if (!inventory || inventory.schemaVersion !== 1 || !inventory.images || typeof inventory.images !== 'object') {
    return ['container image inventory must use schemaVersion 1 and define images'];
  }

  for (const [name, image] of Object.entries(inventory.images)) {
    if (!image || typeof image.version !== 'string' || !image.version.trim()) {
      errors.push(`${name} must declare an explicit version`);
    }
    if (!image || typeof image.reference !== 'string' || !DIGEST_REF_PATTERN.test(image.reference)) {
      errors.push(`${name} must use an exact tag plus lowercase sha256 digest`);
      continue;
    }
    if (/:latest@/.test(image.reference) || /:(?:slim|alpine|jammy|bookworm)@/.test(image.reference)) {
      errors.push(`${name} must not use a moving or versionless tag`);
    }
  }

  return errors;
}

function verifyContainerImagePins(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const inventory = options.inventory || JSON.parse(fs.readFileSync(
    options.inventoryPath || path.join(repoRoot, 'config', 'container-image-pins.json'),
    'utf8'
  ));
  const declarations = options.declarations || EXPECTED_DECLARATIONS;
  const errors = validateInventory(inventory);

  for (const declaration of declarations) {
    const image = inventory.images?.[declaration.image];
    if (!image || typeof image.reference !== 'string') {
      errors.push(`${declaration.file} references unknown inventory image ${declaration.image}`);
      continue;
    }

    const absolutePath = path.join(repoRoot, declaration.file);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`governed image source is missing: ${declaration.file}`);
      continue;
    }

    const source = fs.readFileSync(absolutePath, 'utf8');
    const expectedValue = declaration.kind === 'inventory-key' ? declaration.image : image.reference;
    const observed = countExactDeclaration(source, declaration.kind, expectedValue);
    if (observed !== declaration.count) {
      errors.push(
        `${declaration.file} must declare ${declaration.kind === 'inventory-key' ? declaration.image : image.reference} exactly ${declaration.count} time(s); observed ${observed}`
      );
    }
  }

  if (errors.length > 0) {
    const error = new Error(`Container image pin contract failed:\n- ${errors.join('\n- ')}`);
    error.code = 'CONTAINER_IMAGE_PIN_CONTRACT_FAILED';
    error.details = errors;
    throw error;
  }

  return {
    schemaVersion: inventory.schemaVersion,
    reviewedAt: inventory.reviewedAt,
    images: Object.fromEntries(Object.entries(inventory.images).map(([name, image]) => [name, {
      version: image.version,
      reference: image.reference,
    }])),
    governedDeclarations: declarations.length,
  };
}

if (require.main === module) {
  try {
    const result = verifyContainerImagePins();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DIGEST_REF_PATTERN,
  EXPECTED_DECLARATIONS,
  countExactDeclaration,
  validateInventory,
  verifyContainerImagePins,
};

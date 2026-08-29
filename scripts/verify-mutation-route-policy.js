#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INVENTORY_PATH = path.join(REPOSITORY_ROOT, 'config', 'mutation-route-policy.json');
const MUTATION_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
const CLASSIFICATIONS = Object.freeze([
  'action-observation',
  'user-mutation',
  'destructive-mutation',
  'scoped-machine-call',
]);

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSource(value) {
  return String(value || '').replaceAll('\\', '/');
}

function routeKey(source, method, declaredPath) {
  return `${normalizeSource(source)}#${String(method).toUpperCase()} ${declaredPath}`;
}

function readInventory(filePath = DEFAULT_INVENTORY_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateInventory(inventory) {
  required(isPlainObject(inventory), 'Mutation route policy must be an object');
  required(inventory.schemaVersion === 1, 'Mutation route policy schemaVersion must be 1');
  required(isPlainObject(inventory.classifications), 'Mutation route classifications are missing');
  required(
    Object.keys(inventory.classifications).length === CLASSIFICATIONS.length
      && CLASSIFICATIONS.every((name) => typeof inventory.classifications[name] === 'string'
        && inventory.classifications[name].trim().length > 0),
    `Mutation route classifications must define exactly: ${CLASSIFICATIONS.join(', ')}`
  );
  required(isPlainObject(inventory.routeRoots), 'Mutation route roots are missing');
  required(Object.keys(inventory.routeRoots).length > 0, 'At least one mutation route root is required');
  required(isPlainObject(inventory.routeEntrypoints), 'Mutation route entrypoints are missing');
  required(
    Object.keys(inventory.routeEntrypoints).length === Object.keys(inventory.routeRoots).length
      && Object.keys(inventory.routeRoots).every((service) => Array.isArray(inventory.routeEntrypoints[service])),
    'Mutation route entrypoints must define an array for every route-root service'
  );
  required(isPlainObject(inventory.routes), 'Mutation route policies are missing');

  const roots = [];
  const seenDirectories = new Set();
  for (const [service, directoryValue] of Object.entries(inventory.routeRoots)) {
    required(['core', 'benchmark', 'rag'].includes(service), `Unknown mutation route service: ${service}`);
    const directory = normalizeSource(directoryValue);
    required(
      directory === `${service}/routes`,
      `Mutation route root for ${service} must be ${service}/routes`
    );
    required(!seenDirectories.has(directory), `Duplicate mutation route root: ${directory}`);
    seenDirectories.add(directory);
    roots.push({ service, directory });
  }

  const entrypoints = [];
  const seenEntrypoints = new Set();
  for (const [service, sourceValues] of Object.entries(inventory.routeEntrypoints)) {
    required(Object.hasOwn(inventory.routeRoots, service), `Mutation route entrypoints have no route root: ${service}`);
    for (const sourceValue of sourceValues) {
      const source = normalizeSource(sourceValue);
      required(source === sourceValue, `Mutation route entrypoint must use forward slashes: ${sourceValue}`);
      required(source.startsWith(`${service}/`) && source.endsWith('.js'), `Invalid ${service} mutation route entrypoint: ${source}`);
      required(!seenEntrypoints.has(source), `Duplicate mutation route entrypoint: ${source}`);
      seenEntrypoints.add(source);
      entrypoints.push({ service, source });
    }
  }

  const policies = new Map();
  for (const [sourceValue, declarations] of Object.entries(inventory.routes)) {
    const source = normalizeSource(sourceValue);
    required(source === sourceValue, `Mutation route source must use forward slashes: ${sourceValue}`);
    const root = roots.find((candidate) => source.startsWith(`${candidate.directory}/`));
    const entrypoint = entrypoints.find((candidate) => candidate.source === source);
    required(root || entrypoint, `Mutation route source is outside the declared route sources: ${source}`);
    required(source.endsWith('.js'), `Mutation route source must be a JavaScript file: ${source}`);
    required(isPlainObject(declarations), `Mutation route declarations must be an object: ${source}`);
    required(Object.keys(declarations).length > 0, `Mutation route source has no declarations: ${source}`);

    for (const [declaration, classification] of Object.entries(declarations)) {
      const match = /^(POST|PUT|PATCH|DELETE) (\/.*)$/.exec(declaration);
      required(match, `Invalid mutation route declaration in ${source}: ${declaration}`);
      required(CLASSIFICATIONS.includes(classification), `Invalid classification for ${source}#${declaration}: ${classification}`);
      const key = routeKey(source, match[1], match[2]);
      required(!policies.has(key), `Duplicate mutation route policy: ${key}`);
      policies.set(key, Object.freeze({
        service: (root || entrypoint).service,
        source,
        method: match[1],
        declaredPath: match[2],
        classification,
      }));
    }
  }
  required(policies.size > 0, 'Mutation route policies are empty');

  return Object.freeze({
    roots: Object.freeze(roots),
    entrypoints: Object.freeze(entrypoints),
    policies,
  });
}

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    });
}

function discoverMutationRoutes(rootDir, validatedInventory) {
  const discovered = new Map();
  const directCallPattern = /^\s*([A-Za-z_$][\w$]*)\s*\.\s*(post|put|patch|delete)\s*\(/gm;
  const literalDeclarationPattern = /^\s*([A-Za-z_$][\w$]*)\s*\.\s*(post|put|patch|delete)\s*\(\s*(['"])(\/[^'"\r\n]*)\3/gm;

  for (const { service, directory } of validatedInventory.roots) {
    const absoluteDirectory = path.resolve(rootDir, directory);
    required(fs.existsSync(absoluteDirectory), `Mutation route root does not exist: ${directory}`);

    const entrypointSources = validatedInventory.entrypoints
      .filter((entrypoint) => entrypoint.service === service)
      .map((entrypoint) => path.resolve(rootDir, entrypoint.source));
    for (const absoluteEntrypoint of entrypointSources) {
      required(fs.existsSync(absoluteEntrypoint), `Mutation route entrypoint does not exist: ${normalizeSource(path.relative(rootDir, absoluteEntrypoint))}`);
    }

    for (const absoluteSource of [...listJavaScriptFiles(absoluteDirectory), ...entrypointSources]) {
      const sourceText = fs.readFileSync(absoluteSource, 'utf8');
      const relativeSource = normalizeSource(path.relative(rootDir, absoluteSource));
      const routeReceivers = new Set(['router', 'app']);
      for (const match of sourceText.matchAll(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\.\s*)?Router\s*\(/g
      )) {
        routeReceivers.add(match[1]);
      }
      const directCalls = [...sourceText.matchAll(directCallPattern)]
        .filter((match) => routeReceivers.has(match[1]));
      const literalDeclarations = [...sourceText.matchAll(literalDeclarationPattern)]
        .filter((match) => routeReceivers.has(match[1]));
      const chainedMutationCalls = [...sourceText.matchAll(
        /^\s*([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(/gm
      )].filter((match) => {
        if (!routeReceivers.has(match[1])) return false;
        const statement = sourceText.slice(match.index).split(';', 1)[0];
        return /\.\s*(post|put|patch|delete)\s*\(/.test(statement);
      });
      required(
        chainedMutationCalls.length === 0,
        `Unsupported chained mutation route declaration in ${relativeSource}; use router.METHOD('/literal-path', ...)`
      );
      required(
        directCalls.length === literalDeclarations.length,
        `Unsupported dynamic mutation route declaration in ${relativeSource}; use router.METHOD('/literal-path', ...)`
      );

      for (const match of literalDeclarations) {
        const method = match[2].toUpperCase();
        const declaredPath = match[4];
        const key = routeKey(relativeSource, method, declaredPath);
        const line = sourceText.slice(0, match.index).split(/\r?\n/).length;
        required(!discovered.has(key), `Duplicate mutation route declaration: ${key}`);
        discovered.set(key, Object.freeze({ service, source: relativeSource, method, declaredPath, line }));
      }
    }
  }
  return discovered;
}

function verifyMutationRoutePolicy(options = {}) {
  const rootDir = path.resolve(options.rootDir || REPOSITORY_ROOT);
  const inventory = options.inventory || readInventory(options.inventoryPath);
  const validated = validateInventory(inventory);
  const discovered = discoverMutationRoutes(rootDir, validated);

  const unclassified = [...discovered.keys()].filter((key) => !validated.policies.has(key)).sort();
  const stale = [...validated.policies.keys()].filter((key) => !discovered.has(key)).sort();
  required(
    unclassified.length === 0,
    `Unclassified mutation route${unclassified.length === 1 ? '' : 's'}:\n${unclassified.join('\n')}`
  );
  required(
    stale.length === 0,
    `Stale mutation route polic${stale.length === 1 ? 'y' : 'ies'}:\n${stale.join('\n')}`
  );

  const byService = {};
  const byClassification = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0]));
  for (const policy of validated.policies.values()) {
    byService[policy.service] = (byService[policy.service] || 0) + 1;
    byClassification[policy.classification] += 1;
  }
  return Object.freeze({
    schemaVersion: 1,
    total: discovered.size,
    byService: Object.freeze(byService),
    byClassification: Object.freeze(byClassification),
  });
}

function main() {
  try {
    const receipt = verifyMutationRoutePolicy();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Mutation route policy verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CLASSIFICATIONS,
  DEFAULT_INVENTORY_PATH,
  MUTATION_METHODS,
  discoverMutationRoutes,
  readInventory,
  routeKey,
  validateInventory,
  verifyMutationRoutePolicy,
};

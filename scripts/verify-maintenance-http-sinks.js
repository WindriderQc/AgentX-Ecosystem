#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  discoverSourceSinks,
  locatorKey,
} = require('./verify-outbound-http-sinks');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INVENTORY_PATH = path.join(REPOSITORY_ROOT, 'config', 'maintenance-http-sinks.json');
const REVIEW_SEMANTICS = 'This is a bounded static reviewed-direct inventory—not executor enforcement. It covers recognized direct HTTP constructors in the declared operator and maintenance source scope and is not whole-program dataflow analysis.';

const EXPECTED_SCOPE = Object.freeze({
  directories: Object.freeze(['scripts', 'core/scripts', 'benchmark/scripts']),
  files: Object.freeze(['agentx.ps1']),
  excludedDirectoryNames: Object.freeze([
    '__tests__',
    'build',
    'coverage',
    'dist',
    'fixtures',
    'generated',
    'node_modules',
    'test',
    'tests',
    'vendor',
  ]),
  excludedFileSuffixes: Object.freeze(['.test.cjs', '.test.js', '.test.mjs']),
});

const JAVASCRIPT_SOURCE_PATTERN = /\.(?:cjs|js|mjs)$/;
const POWERSHELL_CONSTRUCTORS = Object.freeze([
  'HttpClient.SendAsync',
  'Invoke-RestMethod',
  'Invoke-WebRequest',
]);
const JAVASCRIPT_CONSTRUCTORS = Object.freeze([
  'fetch',
  'fetchImpl',
  'fetchFn',
  'deps.fetch',
  'deps.fetchImpl',
  'http.get',
  'http.request',
  'https.get',
  'https.request',
]);
const AUTHORITY_SOURCES = Object.freeze([
  'configured-or-loopback-default',
  'loopback-fixed',
  'loopback-with-configured-port',
  'operator-supplied',
]);
const REDIRECT_MODES = Object.freeze(['client-default', 'follow', 'manual']);

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeSource(value) {
  return String(value || '').replaceAll('\\', '/');
}

function sourceLocation(sourceText, index) {
  const lineStart = sourceText.lastIndexOf('\n', index - 1) + 1;
  return Object.freeze({
    line: sourceText.slice(0, index).split('\n').length,
    column: index - lineStart + 1,
  });
}

function readInventory(filePath = DEFAULT_INVENTORY_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourceLanguage(source) {
  if (JAVASCRIPT_SOURCE_PATTERN.test(source)) return 'javascript';
  if (source.endsWith('.ps1')) return 'powershell';
  return null;
}

function sourceIsInScope(source, scope = EXPECTED_SCOPE) {
  return scope.files.includes(source)
    || scope.directories.some((directory) => source.startsWith(`${directory}/`));
}

function validateSource(rawSource, scope, {
  label = 'Maintenance HTTP sink source',
  rootDir = REPOSITORY_ROOT,
  mustExist = false,
} = {}) {
  const source = normalizeSource(rawSource);
  const unsafeLabel = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  required(source === rawSource, `${label} must use forward slashes: ${rawSource}`);
  required(
    !path.posix.isAbsolute(source)
      && !path.win32.isAbsolute(source)
      && !source.split('/').includes('..'),
    `Dynamic or unsafe ${unsafeLabel}: ${source}`
  );
  required(sourceIsInScope(source, scope), `${label} is outside the declared maintenance scope: ${source}`);
  required(
    !source.split('/').some((segment) => scope.excludedDirectoryNames.includes(segment)),
    `${label} is explicitly excluded: ${source}`
  );
  required(
    !scope.excludedFileSuffixes.some((suffix) => source.endsWith(suffix)),
    `${label} is a test file: ${source}`
  );
  required(
    JAVASCRIPT_SOURCE_PATTERN.test(source) || scope.files.includes(source),
    `${label} has an unsupported source type: ${source}`
  );

  const absolute = path.resolve(rootDir, source);
  const relative = path.relative(rootDir, absolute);
  required(
    relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    `Dynamic or unsafe ${unsafeLabel}: ${source}`
  );
  if (mustExist) required(fs.existsSync(absolute), `${label} does not exist: ${source}`);
  return Object.freeze({ absolute, source });
}

function validateInventory(inventory, { rootDir = REPOSITORY_ROOT } = {}) {
  required(isPlainObject(inventory), 'Maintenance HTTP sink inventory must be an object');
  required(
    Object.keys(inventory).sort().join(',') === [
      'reviewSemantics',
      'schemaVersion',
      'scope',
      'sinks',
    ].sort().join(','),
    'Maintenance HTTP sink inventory must define exactly the supported top-level fields'
  );
  required(inventory.schemaVersion === 1, 'Maintenance HTTP sink inventory schemaVersion must be 1');
  required(
    inventory.reviewSemantics === REVIEW_SEMANTICS,
    'Maintenance HTTP sink reviewSemantics must state the static non-enforcement boundary exactly'
  );
  required(isPlainObject(inventory.scope), 'Maintenance HTTP sink scope is missing');
  required(
    Object.keys(inventory.scope).sort().join(',') === Object.keys(EXPECTED_SCOPE).sort().join(','),
    'Maintenance HTTP sink scope must define exactly directories, files, excludedDirectoryNames, and excludedFileSuffixes'
  );
  for (const field of Object.keys(EXPECTED_SCOPE)) {
    required(
      arraysEqual(inventory.scope[field], EXPECTED_SCOPE[field]),
      `Maintenance HTTP sink scope ${field} does not match the supported operator and maintenance scope`
    );
  }

  required(Array.isArray(inventory.sinks), 'Maintenance HTTP sinks must be an array');
  const ids = new Set();
  const sinks = new Map();
  for (const sink of inventory.sinks) {
    required(isPlainObject(sink), 'Maintenance HTTP sink entry must be an object');
    required(
      Object.keys(sink).sort().join(',') === [
        'authoritySource',
        'column',
        'constructor',
        'deadlineBound',
        'id',
        'line',
        'purpose',
        'redirectMode',
        'responseBound',
        'source',
      ].sort().join(','),
      `Maintenance HTTP sink ${sink.id || '<unknown>'} must define exactly the required sink fields`
    );
    required(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(sink.id), `Invalid maintenance HTTP sink ID: ${sink.id}`);
    required(!ids.has(sink.id), `Duplicate maintenance HTTP sink ID: ${sink.id}`);
    ids.add(sink.id);

    const { source } = validateSource(sink.source, inventory.scope, { rootDir, mustExist: true });
    const language = sourceLanguage(source);
    required(Number.isInteger(sink.line) && sink.line > 0, `Invalid maintenance HTTP sink line: ${sink.id}`);
    required(Number.isInteger(sink.column) && sink.column > 0, `Invalid maintenance HTTP sink column: ${sink.id}`);
    required(
      (language === 'javascript' && JAVASCRIPT_CONSTRUCTORS.includes(sink.constructor))
        || (language === 'powershell' && POWERSHELL_CONSTRUCTORS.includes(sink.constructor)),
      `Unsupported maintenance HTTP constructor for ${sink.id}: ${sink.constructor}`
    );
    required(
      AUTHORITY_SOURCES.includes(sink.authoritySource),
      `Invalid authoritySource for ${sink.id}: ${sink.authoritySource}`
    );
    required(typeof sink.deadlineBound === 'boolean', `deadlineBound must be boolean for ${sink.id}`);
    required(typeof sink.responseBound === 'boolean', `responseBound must be boolean for ${sink.id}`);
    required(REDIRECT_MODES.includes(sink.redirectMode), `Invalid redirectMode for ${sink.id}: ${sink.redirectMode}`);
    required(typeof sink.purpose === 'string' && sink.purpose.trim(), `Purpose is missing for ${sink.id}`);

    const key = locatorKey(source, sink.line, sink.column, sink.constructor);
    required(!sinks.has(key), `Duplicate maintenance HTTP sink locator: ${key}`);
    sinks.set(key, Object.freeze({ ...sink, source, language }));
  }

  return Object.freeze({
    schemaVersion: inventory.schemaVersion,
    scope: inventory.scope,
    sinks,
  });
}

function listJavaScriptFiles(directory, excludedDirectoryNames, excludedFileSuffixes) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (excludedDirectoryNames.has(entry.name)) return [];
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listJavaScriptFiles(entryPath, excludedDirectoryNames, excludedFileSuffixes);
      }
      return entry.isFile()
        && JAVASCRIPT_SOURCE_PATTERN.test(entry.name)
        && !excludedFileSuffixes.some((suffix) => entry.name.endsWith(suffix))
        ? [entryPath]
        : [];
    });
}

function maskPowerShellNonCode(sourceText) {
  const masked = sourceText.split('');
  const mask = (index) => {
    if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };
  const atLineStart = (index) => index === 0 || sourceText[index - 1] === '\n' || sourceText[index - 1] === '\r';
  const stack = [{ type: 'code' }];

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    const state = stack.at(-1);

    if (state.type === 'code' || state.type === 'subexpression') {
      if (char === '<' && next === '#') {
        mask(index); mask(index + 1); index += 1; stack.push({ type: 'block-comment' });
      } else if (char === '#') {
        mask(index); stack.push({ type: 'line-comment' });
      } else if (char === '@' && (next === "'" || next === '"')
          && (sourceText[index + 2] === '\n' || sourceText[index + 2] === '\r')) {
        mask(index); mask(index + 1); index += 1;
        stack.push({ type: next === "'" ? 'single-here' : 'double-here' });
      } else if (char === "'") {
        mask(index); stack.push({ type: 'single-quote' });
      } else if (char === '"') {
        mask(index); stack.push({ type: 'double-quote' });
      } else if (state.type === 'subexpression' && char === '(') {
        state.depth += 1;
      } else if (state.type === 'subexpression' && char === ')') {
        state.depth -= 1;
        if (state.depth === 0) {
          mask(index);
          stack.pop();
        }
      }
      continue;
    }

    mask(index);
    if (state.type === 'line-comment' && (char === '\n' || char === '\r')) {
      stack.pop();
    } else if (state.type === 'block-comment' && char === '#' && next === '>') {
      mask(index + 1); index += 1; stack.pop();
    } else if (state.type === 'single-quote' && char === "'" && next === "'") {
      mask(index + 1); index += 1;
    } else if (state.type === 'single-quote' && char === "'") {
      stack.pop();
    } else if ((state.type === 'double-quote' || state.type === 'double-here') && char === '`') {
      if (index + 1 < sourceText.length) { mask(index + 1); index += 1; }
    } else if ((state.type === 'double-quote' || state.type === 'double-here') && char === '$' && next === '(') {
      mask(index + 1); index += 1; stack.push({ type: 'subexpression', depth: 1 });
    } else if (state.type === 'double-quote' && char === '"') {
      stack.pop();
    } else if (state.type === 'single-here' && atLineStart(index) && char === "'" && next === '@') {
      mask(index + 1); index += 1; stack.pop();
    } else if (state.type === 'double-here' && atLineStart(index) && char === '"' && next === '@') {
      mask(index + 1); index += 1; stack.pop();
    }
  }
  return masked.join('');
}

function discoverPowerShellSinks(sourceText, source) {
  const code = maskPowerShellNonCode(sourceText);
  const discovered = [];
  const cmdletPattern = /(?<![A-Za-z0-9_-])(Invoke-WebRequest|Invoke-RestMethod)\b/gi;
  for (const match of code.matchAll(cmdletPattern)) {
    const constructorName = match[1].toLowerCase() === 'invoke-webrequest'
      ? 'Invoke-WebRequest'
      : 'Invoke-RestMethod';
    const location = sourceLocation(sourceText, match.index);
    discovered.push({
      index: match.index,
      language: 'powershell',
      source,
      line: location.line,
      column: location.column,
      constructor: constructorName,
    });
  }

  const httpClientPattern = /(?<![A-Za-z0-9_-])\$[A-Za-z_][A-Za-z0-9_]*\.SendAsync\b(?=\s*\()/gi;
  for (const match of code.matchAll(httpClientPattern)) {
    const location = sourceLocation(sourceText, match.index);
    discovered.push({
      index: match.index,
      language: 'powershell',
      source,
      line: location.line,
      column: location.column,
      constructor: 'HttpClient.SendAsync',
    });
  }

  return Object.freeze(discovered
    .sort((left, right) => left.index - right.index)
    .map(({ index, ...sink }) => Object.freeze(sink)));
}

function discoverMaintenanceHttpSinks(rootDir = REPOSITORY_ROOT, scope = EXPECTED_SCOPE) {
  const root = path.resolve(rootDir);
  const excludedDirectoryNames = new Set(scope.excludedDirectoryNames);
  const discovered = new Map();
  let sourcesScanned = 0;

  const record = (sink) => {
    const key = locatorKey(sink.source, sink.line, sink.column, sink.constructor);
    required(!discovered.has(key), `Duplicate discovered maintenance HTTP sink: ${key}`);
    discovered.set(key, Object.freeze(sink));
  };

  for (const directory of scope.directories) {
    const absoluteDirectory = path.join(root, directory);
    required(fs.existsSync(absoluteDirectory), `Maintenance HTTP source directory does not exist: ${directory}`);
    for (const absolute of listJavaScriptFiles(
      absoluteDirectory,
      excludedDirectoryNames,
      scope.excludedFileSuffixes
    )) {
      const source = normalizeSource(path.relative(root, absolute));
      validateSource(source, scope, { rootDir: root });
      const sourceText = fs.readFileSync(absolute, 'utf8');
      sourcesScanned += 1;
      for (const sink of discoverSourceSinks(sourceText, source, 'maintenance')) {
        record({
          language: 'javascript',
          source: sink.source,
          line: sink.line,
          column: sink.column,
          constructor: sink.constructor,
        });
      }
    }
  }

  for (const file of scope.files) {
    const { absolute, source } = validateSource(file, scope, { rootDir: root, mustExist: true });
    sourcesScanned += 1;
    for (const sink of discoverPowerShellSinks(fs.readFileSync(absolute, 'utf8'), source)) record(sink);
  }

  return Object.freeze({ sinks: discovered, sourcesScanned });
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function verifyMaintenanceHttpSinks(options = {}) {
  const rootDir = path.resolve(options.rootDir || REPOSITORY_ROOT);
  const inventory = options.inventory || readInventory(options.inventoryPath);
  const validated = validateInventory(inventory, { rootDir });
  const discovery = discoverMaintenanceHttpSinks(rootDir, validated.scope);

  const missing = [...discovery.sinks.keys()].filter((key) => !validated.sinks.has(key)).sort();
  const stale = [...validated.sinks.keys()].filter((key) => !discovery.sinks.has(key)).sort();
  required(
    missing.length === 0,
    `Unregistered maintenance HTTP sink${missing.length === 1 ? '' : 's'}:\n${missing.join('\n')}`
  );
  required(
    stale.length === 0,
    `Stale maintenance HTTP sink entr${stale.length === 1 ? 'y' : 'ies'}:\n${stale.join('\n')}`
  );

  const byLanguage = {};
  const byConstructor = {};
  const byAuthoritySource = {};
  const byRedirectMode = {};
  const deadlineBound = { bounded: 0, unbounded: 0 };
  const responseBound = { bounded: 0, unbounded: 0 };
  for (const sink of validated.sinks.values()) {
    increment(byLanguage, sink.language);
    increment(byConstructor, sink.constructor);
    increment(byAuthoritySource, sink.authoritySource);
    increment(byRedirectMode, sink.redirectMode);
    increment(deadlineBound, sink.deadlineBound ? 'bounded' : 'unbounded');
    increment(responseBound, sink.responseBound ? 'bounded' : 'unbounded');
  }

  return Object.freeze({
    schemaVersion: validated.schemaVersion,
    total: discovery.sinks.size,
    sourcesScanned: discovery.sourcesScanned,
    byLanguage: Object.freeze(byLanguage),
    byConstructor: Object.freeze(byConstructor),
    byAuthoritySource: Object.freeze(byAuthoritySource),
    deadlineBound: Object.freeze(deadlineBound),
    responseBound: Object.freeze(responseBound),
    byRedirectMode: Object.freeze(byRedirectMode),
  });
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(verifyMaintenanceHttpSinks(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Maintenance HTTP sink verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  AUTHORITY_SOURCES,
  DEFAULT_INVENTORY_PATH,
  EXPECTED_SCOPE,
  JAVASCRIPT_CONSTRUCTORS,
  POWERSHELL_CONSTRUCTORS,
  REDIRECT_MODES,
  REVIEW_SEMANTICS,
  discoverMaintenanceHttpSinks,
  discoverPowerShellSinks,
  maskPowerShellNonCode,
  readInventory,
  validateInventory,
  verifyMaintenanceHttpSinks,
};

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INVENTORY_PATH = path.join(REPOSITORY_ROOT, 'config', 'outbound-http-sinks.json');
const EXPECTATION_SEMANTICS = 'Requirements for the future shared outbound executor; this inventory verifier proves coverage and metadata, not runtime transport enforcement.';
const V2_EXPECTATION_SEMANTICS = 'Schema v2 is a bounded static CI guard for recognized direct/static HTTP constructors in long-running product service processes and exact reviewed executor transportAdapter bindings; it validates logical-operation graph metadata and freezes explicitly named legacy direct sinks as migration debt. It is not whole-program JavaScript dataflow analysis; approved transports and sanctioned injection callers remain part of the in-process trusted computing base. Product CLI and maintenance-script egress is outside this registry and must be reviewed separately.';

const EXPECTED_RUNTIME_SOURCES = Object.freeze({
  core: Object.freeze({
    directories: Object.freeze(['core/src', 'core/routes']),
    files: Object.freeze(['core/server.js']),
  }),
  benchmark: Object.freeze({
    directories: Object.freeze(['benchmark/src', 'benchmark/routes']),
    files: Object.freeze(['benchmark/server.js']),
  }),
  rag: Object.freeze({
    directories: Object.freeze(['rag/src', 'rag/routes']),
    files: Object.freeze(['rag/app.js', 'rag/server.js']),
  }),
  shared: Object.freeze({
    directories: Object.freeze(['shared']),
    files: Object.freeze([]),
  }),
});

const REQUIRED_EXCLUSIONS = Object.freeze([
  '__tests__',
  'build',
  'coverage',
  'dist',
  'fixtures',
  'generated',
  'node_modules',
  'public',
  'scripts',
  'test',
  'tests',
  'vendor',
]);
const REQUIRED_EXCLUDED_FILE_SUFFIXES = Object.freeze(['.test.cjs', '.test.js', '.test.mjs']);
const JAVASCRIPT_SOURCE_PATTERN = /\.(?:cjs|js|mjs)$/;

const CONSTRUCTORS = Object.freeze([
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
const TARGET_AUTHORITY_SOURCES = Object.freeze(['canonical', 'configured', 'request-admitted']);
const REDIRECT_EXPECTATIONS = Object.freeze(['manual-no-cross-authority']);
const DEADLINE_EXPECTATIONS = Object.freeze(['full-response-lifecycle', 'stream-lifecycle']);
const BODY_BOUND_EXPECTATIONS = Object.freeze(['bounded', 'streaming-bounded-by-consumer']);
const PAYLOAD_SENSITIVITY_TAGS = Object.freeze([
  'credentials',
  'document-content',
  'model-artifact',
  'model-input',
  'model-output',
  'operational-metadata',
  'recovery-data',
  'search-query',
  'telemetry',
]);
const RESPONSE_MODES = Object.freeze(['bytes', 'discard', 'json', 'stream', 'text']);
const ENFORCEMENT_STATUSES = Object.freeze(['enforced']);
const HTTP_METHODS = Object.freeze(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
const MAX_PATH_PATTERN_LENGTH = 256;
const REGEX_PREFIX_KEYWORDS = new Set(Object.freeze([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
  'of', 'return', 'throw', 'typeof', 'void', 'yield',
]));

// Schema v2 is intentionally monotonic: these are the only direct constructor
// IDs allowed to remain while migration is in progress. A migration may remove
// entries from this baseline, but a new direct sink must fail CI and be built
// behind an approved transport instead of expanding the debt allowlist.
const LEGACY_DIRECT_SINK_IDS = new Set(Object.freeze([
  'benchmark.batch.execute',
  'benchmark.buddy-event.deliver',
  'benchmark.cloud-lane.transport',
  'benchmark.decomposed-judge.generate',
  'benchmark.dedication.ps',
  'benchmark.execution-host.tags',
  'benchmark.huggingface.catalog',
  'benchmark.inference-contract.resolve',
  'benchmark.judge-call.generate',
  'benchmark.judge-readiness.tags',
  'benchmark.judge-validator.show',
  'benchmark.judge-validator.tags',
  'benchmark.ollama-client.request',
  'benchmark.preflight.tags',
  'benchmark.reference.contradiction',
  'benchmark.reference.key-point',
  'benchmark.reference.similarity',
  'benchmark.server.core-models',
  'benchmark.server.validate-judge-tags',
  'benchmark.setup.tags',
  'benchmark.shared-http.execute',
  'benchmark.test-execution.generate',
  'core.artifact-identity.tags',
  'core.backup.rag-request',
  'core.backup.snapshot-download',
  'core.benchmark-proxy.request',
  'core.chat.generate',
  'core.chat.stream',
  'core.cluster-live.ps',
  'core.cross-service.request',
  'core.custom-model.create',
  'core.host-pin.ps',
  'core.host-preference.generate',
  'core.host-preference.inventory',
  'core.host-preferences.ps',
  'core.inference.embed',
  'core.inference.embed-probe',
  'core.inference.list-models',
  'core.model-aggregator.tags',
  'core.model-context.show',
  'core.model-router.fallback',
  'core.model-router.primary',
  'core.model-sync.tags',
  'core.nerve-center.rag-documents',
  'core.nerve-center.rag-refresh',
  'core.ollama-enrichment.ps',
  'core.ollama-enrichment.tags',
  'core.ollama-enrichment.version',
  'core.ollama-health.tags',
  'core.ollama-hosts.proxy',
  'core.ollama-hosts.tags',
  'core.ollama-model-operation',
  'core.pin-reconciler.ps',
  'core.portal-status.probe',
  'core.prompt-analysis.generate',
  'core.roundtable.agent',
  'core.roundtable.agent-stream',
  'core.roundtable.quality',
  'core.roundtable.runtime-participant',
  'core.routing.execute',
  'core.routing.show',
  'core.server.ollama-tags',
  'core.trusted-runtime.forward',
  'core.web-search.query',
]));
const LEGACY_DIRECT_FINGERPRINT_SHA256 = '9d740d671783d46a1f872b7e63be1776e9f8e391e8093269b93c465b8b4e5a59';

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSource(value) {
  return String(value || '').replaceAll('\\', '/');
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function locatorKey(source, line, column, constructorName) {
  return `${normalizeSource(source)}#${line}:${column} ${constructorName}`;
}

function readInventory(filePath = DEFAULT_INVENTORY_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourceBelongsToService(source, service, runtimeSources) {
  const scope = runtimeSources[service];
  return scope.files.includes(source)
    || scope.directories.some((directory) => source.startsWith(`${directory}/`));
}

function validateRuntimeSource(rawSource, service, runtimeSources, exclusions, {
  label,
  mustExist = false,
  rootDir = REPOSITORY_ROOT,
} = {}) {
  const source = normalizeSource(rawSource);
  const description = label || 'Outbound HTTP runtime source';
  const unsafeDescription = `${description.charAt(0).toLowerCase()}${description.slice(1)}`;
  required(source === rawSource, `${description} must use forward slashes: ${rawSource}`);
  required(
    !path.posix.isAbsolute(source) && !path.win32.isAbsolute(source) && !source.split('/').includes('..'),
    `Dynamic or unsafe ${unsafeDescription}: ${source}`
  );
  required(JAVASCRIPT_SOURCE_PATTERN.test(source), `${description} must be JavaScript: ${source}`);
  required(
    sourceBelongsToService(source, service, runtimeSources),
    `${description} is outside ${service} runtime scope: ${source}`
  );
  required(
    !source.split('/').some((segment) => exclusions.has(segment)),
    `${description} is explicitly excluded: ${source}`
  );
  const absolute = path.resolve(rootDir, source);
  const relative = path.relative(rootDir, absolute);
  required(
    relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    `Dynamic or unsafe ${unsafeDescription}: ${source}`
  );
  if (mustExist) required(fs.existsSync(absolute), `${description} does not exist: ${source}`);
  return Object.freeze({ absolute, source });
}

function validateInventoryV1(inventory, { allowUnusedPolicies = false, rootDir = REPOSITORY_ROOT } = {}) {
  required(isPlainObject(inventory), 'Outbound HTTP sink inventory must be an object');
  required(
    Object.keys(inventory).sort().join(',') === [
      'expectationSemantics',
      'policies',
      'schemaVersion',
      'scope',
      'sinks',
    ].sort().join(','),
    'Outbound HTTP sink inventory must define exactly the supported top-level fields'
  );
  required(inventory.schemaVersion === 1, 'Outbound HTTP sink inventory schemaVersion must be 1');
  required(
    inventory.expectationSemantics === EXPECTATION_SEMANTICS,
    'Outbound HTTP sink expectationSemantics must state the non-enforcement boundary exactly'
  );
  required(isPlainObject(inventory.scope), 'Outbound HTTP sink scope is missing');
  required(
    Object.keys(inventory.scope).sort().join(',') === [
      'excludedDirectoryNames',
      'excludedFileSuffixes',
      'runtimeSources',
    ].sort().join(','),
    'Outbound HTTP sink scope must define exactly runtimeSources, excludedDirectoryNames, and excludedFileSuffixes'
  );
  required(isPlainObject(inventory.scope.runtimeSources), 'Outbound HTTP runtimeSources are missing');
  const expectedRuntimeSourceKeys = Object.keys(EXPECTED_RUNTIME_SOURCES).sort().join(',');
  required(
    Object.keys(inventory.scope.runtimeSources).sort().join(',') === expectedRuntimeSourceKeys,
    `Outbound HTTP runtimeSources must define exactly ${expectedRuntimeSourceKeys}`
  );

  for (const [service, expected] of Object.entries(EXPECTED_RUNTIME_SOURCES)) {
    const actual = inventory.scope.runtimeSources[service];
    required(isPlainObject(actual), `Outbound HTTP runtimeSources are missing ${service}`);
    required(
      arraysEqual(actual.directories, expected.directories) && arraysEqual(actual.files, expected.files),
      `Outbound HTTP runtimeSources for ${service} do not match the supported product runtime scope`
    );
  }
  required(
    arraysEqual(inventory.scope.excludedDirectoryNames, REQUIRED_EXCLUSIONS),
    'Outbound HTTP excludedDirectoryNames must explicitly match the supported exclusions'
  );
  required(
    arraysEqual(inventory.scope.excludedFileSuffixes, REQUIRED_EXCLUDED_FILE_SUFFIXES),
    'Outbound HTTP excludedFileSuffixes must explicitly match the supported exclusions'
  );

  required(isPlainObject(inventory.policies), 'Outbound HTTP policies are missing');
  required(Object.keys(inventory.policies).length > 0, 'Outbound HTTP policies are empty');
  const policies = new Map();
  for (const [policyId, policy] of Object.entries(inventory.policies)) {
    required(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(policyId), `Invalid outbound HTTP policy ID: ${policyId}`);
    required(!policies.has(policyId), `Duplicate outbound HTTP policy ID: ${policyId}`);
    required(isPlainObject(policy), `Outbound HTTP policy must be an object: ${policyId}`);
    required(
      Object.keys(policy).sort().join(',') === [
        'bodyBoundExpectation',
        'deadlineExpectation',
        'payloadSensitivity',
        'purpose',
        'redirectExpectation',
        'targetAuthoritySource',
      ].sort().join(','),
      `Outbound HTTP policy ${policyId} must define exactly the required policy fields`
    );
    required(typeof policy.purpose === 'string' && policy.purpose.trim(), `Outbound HTTP policy purpose is missing: ${policyId}`);
    required(
      TARGET_AUTHORITY_SOURCES.includes(policy.targetAuthoritySource),
      `Invalid targetAuthoritySource for ${policyId}: ${policy.targetAuthoritySource}`
    );
    required(
      REDIRECT_EXPECTATIONS.includes(policy.redirectExpectation),
      `Invalid redirectExpectation for ${policyId}: ${policy.redirectExpectation}`
    );
    required(
      DEADLINE_EXPECTATIONS.includes(policy.deadlineExpectation),
      `Invalid deadlineExpectation for ${policyId}: ${policy.deadlineExpectation}`
    );
    required(
      BODY_BOUND_EXPECTATIONS.includes(policy.bodyBoundExpectation),
      `Invalid bodyBoundExpectation for ${policyId}: ${policy.bodyBoundExpectation}`
    );
    required(
      Array.isArray(policy.payloadSensitivity) && policy.payloadSensitivity.length > 0,
      `Outbound HTTP policy payloadSensitivity is missing: ${policyId}`
    );
    required(
      [...new Set(policy.payloadSensitivity)].length === policy.payloadSensitivity.length
        && policy.payloadSensitivity.every((tag) => PAYLOAD_SENSITIVITY_TAGS.includes(tag)),
      `Invalid or duplicate payloadSensitivity tag for ${policyId}`
    );
    policies.set(policyId, Object.freeze({ ...policy }));
  }

  required(Array.isArray(inventory.sinks), 'Outbound HTTP sinks must be an array');
  required(inventory.sinks.length > 0, 'Outbound HTTP sinks are empty');
  const sinks = new Map();
  const ids = new Set();
  const usedPolicyIds = new Set();
  for (const sink of inventory.sinks) {
    required(isPlainObject(sink), 'Outbound HTTP sink entry must be an object');
    required(
      Object.keys(sink).sort().join(',') === ['column', 'constructor', 'id', 'line', 'policyId', 'service', 'source'].sort().join(','),
      `Outbound HTTP sink ${sink.id || '<unknown>'} must define exactly the required sink fields`
    );
    required(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(sink.id), `Invalid outbound HTTP sink ID: ${sink.id}`);
    required(!ids.has(sink.id), `Duplicate outbound HTTP sink ID: ${sink.id}`);
    ids.add(sink.id);
    required(Object.hasOwn(EXPECTED_RUNTIME_SOURCES, sink.service), `Unknown outbound HTTP sink service: ${sink.service}`);
    const { source } = validateRuntimeSource(
      sink.source,
      sink.service,
      inventory.scope.runtimeSources,
      new Set(inventory.scope.excludedDirectoryNames),
      { label: 'Outbound HTTP sink source', rootDir }
    );
    required(Number.isInteger(sink.line) && sink.line > 0, `Invalid outbound HTTP sink line: ${sink.id}`);
    required(Number.isInteger(sink.column) && sink.column > 0, `Invalid outbound HTTP sink column: ${sink.id}`);
    required(CONSTRUCTORS.includes(sink.constructor), `Unsupported outbound HTTP constructor for ${sink.id}: ${sink.constructor}`);
    required(policies.has(sink.policyId), `Unknown outbound HTTP policy for ${sink.id}: ${sink.policyId}`);
    usedPolicyIds.add(sink.policyId);
    const key = locatorKey(source, sink.line, sink.column, sink.constructor);
    required(!sinks.has(key), `Duplicate outbound HTTP sink locator: ${key}`);
    sinks.set(key, Object.freeze({ ...sink, source }));
  }
  const unusedPolicyIds = [...policies.keys()].filter((policyId) => !usedPolicyIds.has(policyId)).sort();
  if (!allowUnusedPolicies) {
    required(
      unusedPolicyIds.length === 0,
      `Stale outbound HTTP polic${unusedPolicyIds.length === 1 ? 'y' : 'ies'}:\n${unusedPolicyIds.join('\n')}`
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    runtimeSources: inventory.scope.runtimeSources,
    exclusions: new Set(inventory.scope.excludedDirectoryNames),
    excludedFileSuffixes: Object.freeze([...inventory.scope.excludedFileSuffixes]),
    policies,
    sinks,
  });
}

function quotedExecutableLiteralCount(sourceText, value) {
  const expected = String(value);
  let count = 0;
  const stack = [{ type: 'code' }];

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    const state = stack.at(-1);

    if (state.type === 'code' || state.type === 'template-expression') {
      if (char === '/' && next === '/') {
        index += 1;
        stack.push({ type: 'line-comment' });
      } else if (char === '/' && next === '*') {
        index += 1;
        stack.push({ type: 'block-comment' });
      } else if (char === "'" || char === '"') {
        const quote = char;
        let raw = '';
        let escaped = false;
        let cursor = index + 1;
        for (; cursor < sourceText.length; cursor += 1) {
          const literalChar = sourceText[cursor];
          if (literalChar === '\\') {
            escaped = true;
            cursor += 1;
            continue;
          }
          if (literalChar === quote) break;
          raw += literalChar;
        }
        if (!escaped && cursor < sourceText.length && raw === expected) count += 1;
        index = cursor;
      } else if (char === '`') {
        stack.push({ type: 'template' });
      } else if (state.type === 'template-expression' && char === '{') {
        state.depth += 1;
      } else if (state.type === 'template-expression' && char === '}') {
        state.depth -= 1;
        if (state.depth === 0) stack.pop();
      }
      continue;
    }

    if (state.type === 'line-comment' && (char === '\n' || char === '\r')) stack.pop();
    else if (state.type === 'block-comment' && char === '*' && next === '/') {
      index += 1;
      stack.pop();
    } else if (state.type === 'template' && char === '\\') {
      index += 1;
    } else if (state.type === 'template' && char === '`') stack.pop();
    else if (state.type === 'template' && char === '$' && next === '{') {
      index += 1;
      stack.push({ type: 'template-expression', depth: 1 });
    }
  }

  return count;
}

function findMatchingDelimiter(code, openIndex) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const expectedClose = pairs[code[openIndex]];
  if (!expectedClose) return -1;
  const stack = [expectedClose];
  for (let index = openIndex + 1; index < code.length; index += 1) {
    const char = code[index];
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function normalizeBindingExpression(expression) {
  return String(expression || '').replace(/\s+/g, '');
}

function findTopLevelPropertyExpressions(code, objectOpen, objectClose, propertyName) {
  const expressions = [];
  let depth = 1;
  for (let index = objectOpen + 1; index < objectClose; index += 1) {
    const char = code[index];
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 1 || !code.startsWith(propertyName, index)) continue;
    const previous = code[index - 1];
    const afterName = index + propertyName.length;
    if ((previous && /[\w$]/.test(previous)) || /[\w$]/.test(code[afterName] || '')) continue;
    let colon = afterName;
    while (/\s/.test(code[colon] || '')) colon += 1;
    if (code[colon] !== ':') continue;
    let valueStart = colon + 1;
    while (/\s/.test(code[valueStart] || '')) valueStart += 1;
    let valueDepth = 1;
    let valueEnd = valueStart;
    for (; valueEnd < objectClose; valueEnd += 1) {
      const valueChar = code[valueEnd];
      if (valueChar === '{' || valueChar === '[' || valueChar === '(') valueDepth += 1;
      else if (valueChar === '}' || valueChar === ']' || valueChar === ')') valueDepth -= 1;
      else if (valueChar === ',' && valueDepth === 1) break;
    }
    expressions.push(normalizeBindingExpression(code.slice(valueStart, valueEnd)));
    index = valueEnd;
  }
  return expressions;
}

function discoverExecutorTransportBindings(sourceText) {
  const code = maskNonCode(sourceText);
  const bindings = [];
  const callPattern = /(?<![\w$.])createOutboundHttpExecutor\s*\(/g;
  for (const match of code.matchAll(callPattern)) {
    const prefix = code.slice(Math.max(0, match.index - 24), match.index);
    if (/\bfunction\s*$/.test(prefix)) continue;
    const callOpen = code.indexOf('(', match.index);
    const callClose = findMatchingDelimiter(code, callOpen);
    let objectOpen = callOpen + 1;
    while (/\s/.test(code[objectOpen] || '')) objectOpen += 1;
    if (callClose === -1 || code[objectOpen] !== '{') {
      bindings.push(Object.freeze({ index: match.index, transportAdapterExpressions: [] }));
      continue;
    }
    const objectClose = findMatchingDelimiter(code, objectOpen);
    if (objectClose === -1 || objectClose > callClose) {
      bindings.push(Object.freeze({ index: match.index, transportAdapterExpressions: [] }));
      continue;
    }
    bindings.push(Object.freeze({
      index: match.index,
      transportAdapterExpressions: Object.freeze(findTopLevelPropertyExpressions(
        code,
        objectOpen,
        objectClose,
        'transportAdapter'
      )),
    }));
  }
  return bindings;
}

function validateInventoryV2(inventory, { rootDir = REPOSITORY_ROOT } = {}) {
  required(isPlainObject(inventory), 'Outbound HTTP registry must be an object');
  required(
    Object.keys(inventory).sort().join(',') === [
      'approvedTransportSinkIds',
      'delegates',
      'expectationSemantics',
      'operations',
      'policies',
      'schemaVersion',
      'scope',
      'sinks',
    ].sort().join(','),
    'Outbound HTTP registry v2 must define exactly the supported top-level fields'
  );
  required(inventory.schemaVersion === 2, 'Outbound HTTP registry schemaVersion must be 2');
  required(
    inventory.expectationSemantics === V2_EXPECTATION_SEMANTICS,
    'Outbound HTTP registry v2 expectationSemantics must state its enforcement boundary exactly'
  );

  // Reuse the v1 physical-constructor, scope, policy, and exact-locator
  // validation. Schema v2 adds logical operations and an acyclic delegation
  // graph without weakening the recognized direct/static constructor inventory.
  const base = validateInventoryV1({
    schemaVersion: 1,
    expectationSemantics: EXPECTATION_SEMANTICS,
    scope: inventory.scope,
    policies: inventory.policies,
    sinks: inventory.sinks,
  }, { allowUnusedPolicies: true, rootDir });
  const sinksById = new Map([...base.sinks.values()].map((sink) => [sink.id, sink]));

  required(
    Array.isArray(inventory.approvedTransportSinkIds)
      && inventory.approvedTransportSinkIds.length > 0
      && new Set(inventory.approvedTransportSinkIds).size === inventory.approvedTransportSinkIds.length,
    'Outbound HTTP registry v2 approvedTransportSinkIds must be a non-empty unique array'
  );
  const approvedTransportSinkIds = new Set();
  for (const sinkId of inventory.approvedTransportSinkIds) {
    required(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(sinkId), `Invalid approved outbound transport sink ID: ${sinkId}`);
    required(sinksById.has(sinkId), `Approved outbound transport sink does not exist: ${sinkId}`);
    approvedTransportSinkIds.add(sinkId);
  }

  required(Array.isArray(inventory.delegates), 'Outbound HTTP registry v2 delegates must be an array');
  const delegates = new Map();
  for (const delegate of inventory.delegates) {
    required(isPlainObject(delegate), 'Outbound HTTP delegate must be an object');
    required(
      Object.keys(delegate).sort().join(',') === [
        'id',
        'service',
        'source',
        'target',
        'transportAdapterExpression',
      ].sort().join(','),
      `Outbound HTTP delegate ${delegate.id || '<unknown>'} must define exactly id, service, source, target, and transportAdapterExpression`
    );
    required(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(delegate.id), `Invalid outbound HTTP delegate ID: ${delegate.id}`);
    required(!delegates.has(delegate.id), `Duplicate outbound HTTP delegate ID: ${delegate.id}`);
    required(Object.hasOwn(EXPECTED_RUNTIME_SOURCES, delegate.service), `Unknown outbound HTTP delegate service: ${delegate.service}`);
    const { absolute, source } = validateRuntimeSource(
      delegate.source,
      delegate.service,
      inventory.scope.runtimeSources,
      base.exclusions,
      { label: 'Outbound HTTP delegate source', mustExist: true, rootDir }
    );
    required(typeof delegate.transportAdapterExpression === 'string'
      && delegate.transportAdapterExpression.length > 0
      && delegate.transportAdapterExpression.length <= 512
      && delegate.transportAdapterExpression === normalizeBindingExpression(delegate.transportAdapterExpression),
    `Outbound HTTP delegate transport binding is invalid: ${delegate.id}`);
    const executorBindings = discoverExecutorTransportBindings(fs.readFileSync(absolute, 'utf8'));
    required(executorBindings.length === 1,
      `Outbound HTTP delegate source must contain one executable shared-executor call: ${delegate.id}`);
    required(executorBindings[0].transportAdapterExpressions.length === 1,
      `Outbound HTTP delegate source must bind one exact transportAdapter expression: ${delegate.id}`);
    required(
      executorBindings[0].transportAdapterExpressions[0] === delegate.transportAdapterExpression,
      `Outbound HTTP delegate transportAdapter expression does not match its reviewed binding: ${delegate.id}`
    );
    required(isPlainObject(delegate.target)
      && Object.keys(delegate.target).sort().join(',') === 'id,kind'
      && ['delegate', 'sink'].includes(delegate.target.kind)
      && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(delegate.target.id),
    `Outbound HTTP delegate target is invalid: ${delegate.id}`);
    delegates.set(delegate.id, Object.freeze({ ...delegate, source }));
  }

  required(Array.isArray(inventory.operations) && inventory.operations.length > 0, 'Outbound HTTP registry v2 operations must be a non-empty array');
  const operations = new Map();
  const usedDelegates = new Set();
  const usedPolicies = new Set();
  for (const operation of inventory.operations) {
    required(isPlainObject(operation), 'Outbound HTTP operation must be an object');
    required(
      Object.keys(operation).sort().join(',') === [
        'allowSearch',
        'authoritySource',
        'deadlineMs',
        'delegateId',
        'enforcementStatus',
        'id',
        'maxRequestBytes',
        'maxResponseBytes',
        'method',
        'pathPattern',
        'policyId',
        'registrationSource',
        'responseMode',
        'service',
      ].sort().join(','),
      `Outbound HTTP operation ${operation.id || '<unknown>'} must define exactly the required operation fields`
    );
    required(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(operation.id), `Invalid outbound HTTP operation ID: ${operation.id}`);
    required(!operations.has(operation.id), `Duplicate outbound HTTP operation ID: ${operation.id}`);
    required(Object.hasOwn(EXPECTED_RUNTIME_SOURCES, operation.service), `Unknown outbound HTTP operation service: ${operation.service}`);
    required(base.policies.has(operation.policyId), `Unknown outbound HTTP operation policy: ${operation.id}`);
    const policy = base.policies.get(operation.policyId);
    required(operation.authoritySource === policy.targetAuthoritySource, `Outbound HTTP operation authority does not match its policy: ${operation.id}`);
    required(HTTP_METHODS.includes(operation.method), `Invalid outbound HTTP operation method: ${operation.id}`);
    required(typeof operation.allowSearch === 'boolean', `Invalid outbound HTTP operation allowSearch: ${operation.id}`);
    required(
      typeof operation.pathPattern === 'string'
        && operation.pathPattern.length > 2
        && operation.pathPattern.length <= MAX_PATH_PATTERN_LENGTH
        && operation.pathPattern.startsWith('^')
        && operation.pathPattern.endsWith('$')
        && !operation.pathPattern.includes('://'),
      `Invalid outbound HTTP operation pathPattern: ${operation.id}`
    );
    try {
      new RegExp(operation.pathPattern);
    } catch {
      throw new Error(`Invalid outbound HTTP operation pathPattern: ${operation.id}`);
    }
    required(RESPONSE_MODES.includes(operation.responseMode), `Invalid outbound HTTP operation responseMode: ${operation.id}`);
    required(ENFORCEMENT_STATUSES.includes(operation.enforcementStatus), `Invalid outbound HTTP operation enforcementStatus: ${operation.id}`);
    required(Number.isSafeInteger(operation.deadlineMs) && operation.deadlineMs > 0 && operation.deadlineMs <= 2_147_483_647, `Invalid outbound HTTP operation deadline: ${operation.id}`);
    required(Number.isSafeInteger(operation.maxRequestBytes) && operation.maxRequestBytes >= 0, `Invalid outbound HTTP operation request bound: ${operation.id}`);
    required(Number.isSafeInteger(operation.maxResponseBytes) && operation.maxResponseBytes >= 0, `Invalid outbound HTTP operation response bound: ${operation.id}`);
    required(delegates.has(operation.delegateId), `Unknown outbound HTTP operation delegate: ${operation.id}`);
    const operationDelegate = delegates.get(operation.delegateId);
    required(operationDelegate.service === operation.service, `Outbound HTTP operation crosses a service delegate boundary: ${operation.id}`);
    const { absolute: absoluteRegistration, source: registrationSource } = validateRuntimeSource(
      operation.registrationSource,
      operation.service,
      inventory.scope.runtimeSources,
      base.exclusions,
      { label: 'Outbound HTTP operation registration source', mustExist: true, rootDir }
    );
    required(
      registrationSource === operationDelegate.source,
      `Outbound HTTP operation registration must be owned by its delegate source: ${operation.id}`
    );
    const literalCount = quotedExecutableLiteralCount(fs.readFileSync(absoluteRegistration, 'utf8'), operation.id);
    required(literalCount === 1, `Outbound HTTP operation ID must have one exact runtime registration (${literalCount} found): ${operation.id}`);
    usedDelegates.add(operation.delegateId);
    usedPolicies.add(operation.policyId);
    operations.set(operation.id, Object.freeze({ ...operation, registrationSource }));
  }

  const resolvedSinkByDelegate = new Map();
  const resolving = new Set();
  const resolveDelegate = (delegateId) => {
    if (resolvedSinkByDelegate.has(delegateId)) return resolvedSinkByDelegate.get(delegateId);
    required(!resolving.has(delegateId), `Outbound HTTP delegate graph contains a cycle at: ${delegateId}`);
    const delegate = delegates.get(delegateId);
    required(delegate, `Outbound HTTP delegate target does not exist: ${delegateId}`);
    resolving.add(delegateId);
    let sink;
    if (delegate.target.kind === 'delegate') {
      const nestedDelegate = delegates.get(delegate.target.id);
      required(nestedDelegate, `Outbound HTTP delegate target does not exist: ${delegate.target.id}`);
      required(nestedDelegate.service === delegate.service, `Outbound HTTP delegate crosses a service boundary: ${delegateId}`);
      usedDelegates.add(delegate.target.id);
      sink = resolveDelegate(delegate.target.id);
    } else {
      sink = sinksById.get(delegate.target.id);
      required(sink, `Outbound HTTP delegate sink target does not exist: ${delegate.target.id}`);
      required(sink.service === delegate.service, `Outbound HTTP delegate terminates in another service transport: ${delegateId}`);
    }
    resolving.delete(delegateId);
    required(approvedTransportSinkIds.has(sink.id), `Outbound HTTP enforced delegate terminates at an unapproved transport: ${delegateId}`);
    resolvedSinkByDelegate.set(delegateId, sink);
    return sink;
  };
  for (const operation of operations.values()) resolveDelegate(operation.delegateId);

  const staleDelegates = [...delegates.keys()].filter((id) => !usedDelegates.has(id)).sort();
  required(staleDelegates.length === 0, `Stale outbound HTTP delegate${staleDelegates.length === 1 ? '' : 's'}:\n${staleDelegates.join('\n')}`);
  const approvedSinks = [...sinksById.values()].filter((sink) => approvedTransportSinkIds.has(sink.id));
  const resolvedSinkIds = new Set([...resolvedSinkByDelegate.values()].map((sink) => sink.id));
  const staleApprovedSinks = approvedSinks.filter((sink) => !resolvedSinkIds.has(sink.id)).map((sink) => sink.id).sort();
  required(staleApprovedSinks.length === 0, `Unreferenced approved outbound transport sink${staleApprovedSinks.length === 1 ? '' : 's'}:\n${staleApprovedSinks.join('\n')}`);

  const legacySinks = [...sinksById.values()].filter((sink) => !approvedTransportSinkIds.has(sink.id));
  const unexpectedLegacySinkIds = legacySinks
    .map((sink) => sink.id)
    .filter((id) => !LEGACY_DIRECT_SINK_IDS.has(id))
    .sort();
  required(
    unexpectedLegacySinkIds.length === 0,
    `New legacy direct outbound sink${unexpectedLegacySinkIds.length === 1 ? ' is' : 's are'} forbidden; register an enforced operation and approved transport instead:\n${unexpectedLegacySinkIds.join('\n')}`
  );
  const legacyFingerprint = legacySinks
    .map(({ id, service, source, constructor, policyId }) => ({
      id, service, source, constructor, policyId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const legacyFingerprintHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(legacyFingerprint))
    .digest('hex');
  required(
    legacyFingerprintHash === LEGACY_DIRECT_FINGERPRINT_SHA256,
    'Legacy direct outbound sink fingerprints changed; migrate the sink or explicitly review the frozen baseline'
  );
  for (const sink of legacySinks) usedPolicies.add(sink.policyId);
  const unusedPolicyIds = [...base.policies.keys()].filter((policyId) => !usedPolicies.has(policyId)).sort();
  required(unusedPolicyIds.length === 0, `Stale outbound HTTP polic${unusedPolicyIds.length === 1 ? 'y' : 'ies'}:\n${unusedPolicyIds.join('\n')}`);

  return Object.freeze({
    ...base,
    schemaVersion: 2,
    approvedTransportSinkIds,
    delegates,
    legacySinks: new Map(legacySinks.map((sink) => [sink.id, sink])),
    operations,
    resolvedSinkByDelegate,
  });
}

function validateInventory(inventory, options = {}) {
  if (inventory?.schemaVersion === 2) return validateInventoryV2(inventory, options);
  return validateInventoryV1(inventory);
}

function listJavaScriptFiles(directory, excludedDirectoryNames, excludedFileSuffixes) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (excludedDirectoryNames.has(entry.name)) return [];
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJavaScriptFiles(entryPath, excludedDirectoryNames, excludedFileSuffixes);
      return entry.isFile()
        && JAVASCRIPT_SOURCE_PATTERN.test(entry.name)
        && !excludedFileSuffixes.some((suffix) => entry.name.endsWith(suffix))
        ? [entryPath]
        : [];
    });
}

function canStartRegexLiteral(masked, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(masked[cursor])) cursor -= 1;
  if (cursor < 0) return true;

  const previous = masked[cursor];
  if ('=([{,:;!?&|+-*%^~<>'.includes(previous)) return true;
  if (previous === '>' && masked[cursor - 1] === '=') return true;
  if (!/[A-Za-z0-9_$]/.test(previous)) return false;

  let start = cursor;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(masked[start])) start -= 1;
  const previousWord = masked.slice(start + 1, cursor + 1).join('');
  return REGEX_PREFIX_KEYWORDS.has(previousWord);
}

function maskNonCode(sourceText) {
  const masked = sourceText.split('');
  const mask = (index) => {
    if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };
  const stack = [{ type: 'code' }];
  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    const state = stack.at(-1);
    if (state.type === 'code' || state.type === 'template-expression') {
      if (index === 0 && char === '#' && next === '!') {
        mask(index); mask(index + 1); index += 1; stack.push({ type: 'line-comment' });
      } else if (char === '/' && next === '/') {
        mask(index); mask(index + 1); index += 1; stack.push({ type: 'line-comment' });
      } else if (char === '/' && next === '*') {
        mask(index); mask(index + 1); index += 1; stack.push({ type: 'block-comment' });
      } else if (char === "'") {
        mask(index); stack.push({ type: 'single-quote' });
      } else if (char === '"') {
        mask(index); stack.push({ type: 'double-quote' });
      } else if (char === '`') {
        mask(index); stack.push({ type: 'template' });
      } else if (char === '/' && canStartRegexLiteral(masked, index)) {
        mask(index); stack.push({ type: 'regex', inCharacterClass: false });
      } else if (state.type === 'template-expression' && char === '{') {
        state.depth += 1;
      } else if (state.type === 'template-expression' && char === '}') {
        state.depth -= 1;
        if (state.depth === 0) {
          mask(index);
          stack.pop();
        }
      }
      continue;
    }
    mask(index);
    if (state.type === 'line-comment' && (char === '\n' || char === '\r')) stack.pop();
    else if (state.type === 'block-comment' && char === '*' && next === '/') {
      mask(index + 1); index += 1; stack.pop();
    } else if (['single-quote', 'double-quote', 'template'].includes(state.type) && char === '\\') {
      if (index + 1 < sourceText.length) { mask(index + 1); index += 1; }
    } else if (state.type === 'regex' && char === '\\') {
      if (index + 1 < sourceText.length) { mask(index + 1); index += 1; }
    } else if (state.type === 'regex' && char === '[') {
      state.inCharacterClass = true;
    } else if (state.type === 'regex' && char === ']') {
      state.inCharacterClass = false;
    } else if (state.type === 'regex' && char === '/' && !state.inCharacterClass) {
      while (/[A-Za-z]/.test(sourceText[index + 1] || '')) {
        mask(index + 1);
        index += 1;
      }
      stack.pop();
    } else if (state.type === 'single-quote' && char === "'") stack.pop();
    else if (state.type === 'double-quote' && char === '"') stack.pop();
    else if (state.type === 'template' && char === '`') stack.pop();
    else if (state.type === 'template' && char === '$' && next === '{') {
      mask(index + 1);
      index += 1;
      stack.push({ type: 'template-expression', depth: 1 });
    }
  }
  return masked.join('');
}

function sourceLocation(sourceText, index) {
  const lineStart = sourceText.lastIndexOf('\n', index - 1) + 1;
  return Object.freeze({
    line: sourceText.slice(0, index).split('\n').length,
    column: index - lineStart + 1,
  });
}

function splitTopLevelArguments(code, openIndex, closeIndex) {
  const argumentsList = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let start = openIndex + 1;
  for (let index = start; index < closeIndex; index += 1) {
    const char = code[index];
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) stack.pop();
    else if (char === ',' && stack.length === 0) {
      argumentsList.push(Object.freeze({ source: code.slice(start, index), start }));
      start = index + 1;
    }
  }
  argumentsList.push(Object.freeze({ source: code.slice(start, closeIndex), start }));
  return argumentsList;
}

function discoverSourceSinks(sourceText, source, service) {
  const code = maskNonCode(sourceText);
  const isCodeAt = (index) => code[index] !== ' ' && code[index] !== '\t';
  const unsupportedModulePattern = /\b(?:require|import)\s*\(\s*(['"])(?:axios|got|http2|node:http2|undici)\1\s*\)|\bfrom\s*(['"])(?:axios|got|http2|node:http2|undici)\2/g;
  for (const match of sourceText.matchAll(unsupportedModulePattern)) {
    if (!isCodeAt(match.index)) continue;
    const location = sourceLocation(sourceText, match.index);
    throw new Error(`Unsupported outbound HTTP module in ${source}:${location.line}:${location.column}`);
  }

  const directRequireCallPattern = /\brequire\s*\(\s*(['"])(?:node:)?https?\1\s*\)\s*(?:\.|\?\.)\s*(?:get|request)\s*(?:\?\.)?\s*\(/g;
  for (const match of sourceText.matchAll(directRequireCallPattern)) {
    if (!isCodeAt(match.index)) continue;
    const location = sourceLocation(sourceText, match.index);
    throw new Error(`Unsupported inline-module outbound HTTP constructor in ${source}:${location.line}:${location.column}`);
  }

  const nativeModuleOccurrencePattern = /\b(?:require|import)\s*\(\s*(['"])(?:node:)?(http|https)\1\s*\)|\bimport\s+[^;\n]*?\bfrom\s*(['"])(?:node:)?(http|https)\3/g;
  const allowedNativeBindingRanges = [];
  const allowedNativeBindingPattern = /\bconst\s+(http|https)\s*=\s*require\s*\(\s*(['"])(?:node:)?(http|https)\2\s*\)/g;
  for (const match of sourceText.matchAll(allowedNativeBindingPattern)) {
    if (isCodeAt(match.index) && match[1] === match[3]) {
      allowedNativeBindingRanges.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of sourceText.matchAll(nativeModuleOccurrencePattern)) {
    if (!isCodeAt(match.index)) continue;
    const allowed = allowedNativeBindingRanges.some(([start, end]) => match.index >= start && match.index < end);
    if (!allowed) {
      const location = sourceLocation(sourceText, match.index);
      throw new Error(`Unsupported aliased outbound HTTP module binding in ${source}:${location.line}:${location.column}`);
    }
  }

  const nativeCapabilityAliasPattern = /(?<![\w$.])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(http|https)\s*(?:\.|\?\.)\s*(get|request)\b(?!\s*(?:\?\.)?\s*\()/g;
  for (const match of code.matchAll(nativeCapabilityAliasPattern)) {
    const location = sourceLocation(sourceText, match.index);
    throw new Error(`Unsupported escaped outbound HTTP capability in ${source}:${location.line}:${location.column}`);
  }

  const unsupportedMemberPattern = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:\.|\?\.)\s*(fetch|fetchImpl|fetchFn)\s*(?:\?\.)?\s*\(/g;
  for (const match of code.matchAll(unsupportedMemberPattern)) {
    if (match[1] !== 'deps' || !['fetch', 'fetchImpl'].includes(match[2])) {
      const location = sourceLocation(sourceText, match.index);
      throw new Error(`Unsupported dynamic/member outbound HTTP constructor in ${source}:${location.line}:${location.column}: ${match[1]}.${match[2]}`);
    }
  }
  const computedLiteralCallPattern = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\[\s*(['"])(fetch|fetchImpl|fetchFn|get|request)\2\s*\]\s*(?:\?\.)?\s*\(/g;
  for (const match of sourceText.matchAll(computedLiteralCallPattern)) {
    if (!isCodeAt(match.index)) continue;
    const location = sourceLocation(sourceText, match.index);
    throw new Error(`Unsupported computed outbound HTTP constructor in ${source}:${location.line}:${location.column}`);
  }
  const computedCallPattern = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\[\s*(?:[A-Za-z_$][\w$]*|\s*)\s*\]\s*(?:\?\.)?\s*\(/g;
  for (const match of code.matchAll(computedCallPattern)) {
    const rawCall = sourceText.slice(match.index, match.index + match[0].length);
    const bracket = rawCall.match(/\[([^\]]*)\]/)?.[1] || '';
    if (/fetch|request|get/i.test(bracket) || ['http', 'https'].includes(match[1])) {
      const location = sourceLocation(sourceText, match.index);
      throw new Error(`Unsupported computed outbound HTTP constructor in ${source}:${location.line}:${location.column}`);
    }
  }

  const callPattern = /(?<![\w$.])(?:(deps)\s*(?:\.|\?\.)\s*)?(fetch|fetchImpl|fetchFn)\s*(?:\?\.)?\s*\(|(?<![\w$.])(https?)\s*(?:\.|\?\.)\s*(get|request)\s*(?:\?\.)?\s*\(/g;
  const discovered = [];
  for (const match of code.matchAll(callPattern)) {
    const prefix = code.slice(Math.max(0, match.index - 24), match.index);
    if (/\bfunction\s*$/.test(prefix)) continue;
    const constructorName = match[2]
      ? `${match[1] ? 'deps.' : ''}${match[2]}`
      : `${match[3]}.${match[4]}`;
    const location = sourceLocation(sourceText, match.index);
    discovered.push(Object.freeze({
      service,
      source,
      line: location.line,
      column: location.column,
      constructor: constructorName,
    }));
  }

  // Trace simple aliases of fetch capabilities so renaming `fetch` cannot
  // make a physical call disappear from the inventory. Complex/computed
  // aliasing is deliberately unsupported and must be rewritten explicitly.
  const aliases = new Set(['fetch', 'fetchImpl', 'fetchFn']);
  const nodeFetchBindingPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:require\s*\(\s*(['"])node-fetch\2\s*\)|[^;\n]*?import\s*\(\s*(['"])node-fetch\3\s*\))/g;
  for (const match of sourceText.matchAll(nodeFetchBindingPattern)) {
    if (isCodeAt(match.index)) aliases.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      const [, left, expression] = match;
      if (aliases.has(left)) continue;
      const aliasesCapability = [...aliases].some((candidate) => {
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|\\|\\||\\?\\?)\\s*${escaped}\\s*(?:,?\\s*$|\\|\\||\\?\\?)`).test(expression.trim());
      });
      if (aliasesCapability) {
        aliases.add(left);
        changed = true;
      }
    }
  }

  const localFunctionParameters = new Map();
  const simpleFunctionPattern = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g;
  for (const match of code.matchAll(simpleFunctionPattern)) {
    const parameters = match[2].trim()
      ? match[2].split(',').map((parameter) => parameter.trim())
      : [];
    if (parameters.every((parameter) => /^[A-Za-z_$][\w$]*$/.test(parameter))) {
      localFunctionParameters.set(match[1], parameters);
    }
  }

  const capabilityConstructor = (expression) => {
    const normalized = String(expression || '').replace(/\s+/g, '').replaceAll('?.', '.');
    if (aliases.has(normalized)) return 'fetch';
    if (normalized === 'deps.fetch' || normalized === 'deps.fetchImpl') return normalized;
    const native = normalized.match(/^(http|https)\.(get|request)$/);
    return native ? `${native[1]}.${native[2]}` : null;
  };
  const controlCallNames = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
  const simpleCallPattern = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/g;
  for (const match of code.matchAll(simpleCallPattern)) {
    const callee = match[1];
    if (controlCallNames.has(callee) || aliases.has(callee)) continue;
    const prefix = code.slice(Math.max(0, match.index - 32), match.index);
    if (/\bfunction\s*$/.test(prefix)) continue;
    const openIndex = code.indexOf('(', match.index);
    const closeIndex = findMatchingDelimiter(code, openIndex);
    if (closeIndex === -1) continue;
    const suffix = code.slice(closeIndex + 1).match(/^\s*(=>|\{)/)?.[1];
    if (suffix) continue;
    const receiverParameters = localFunctionParameters.get(callee);
    for (const [argumentIndex, argument] of splitTopLevelArguments(code, openIndex, closeIndex).entries()) {
      const constructorName = capabilityConstructor(argument.source);
      if (!constructorName) continue;
      if (receiverParameters && aliases.has(receiverParameters[argumentIndex])) {
        continue;
      }
      const leadingWhitespace = argument.source.length - argument.source.trimStart().length;
      const location = sourceLocation(sourceText, argument.start + leadingWhitespace);
      throw new Error(`Unsupported escaped outbound HTTP capability in ${source}:${location.line}:${location.column}`);
    }
  }

  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const capabilityMethodPattern = new RegExp(`(?<![\\w$.])${escaped}\\s*\\.\\s*(?:bind|call|apply)\\s*\\(`, 'g');
    const capabilityEscapePattern = new RegExp(`(?:[{,]\\s*)([A-Za-z_$][\\w$]*)\\s*:\\s*${escaped}\\s*(?=[,}])`, 'g');
    for (const match of code.matchAll(capabilityMethodPattern)) {
      const location = sourceLocation(sourceText, match.index);
      throw new Error(`Unsupported escaped outbound fetch capability in ${source}:${location.line}:${location.column}`);
    }
    for (const match of code.matchAll(capabilityEscapePattern)) {
      if (['fetch', 'fetchImpl', 'fetchFn'].includes(match[1])) continue;
      const lineStart = sourceText.lastIndexOf('\n', match.index - 1) + 1;
      const lineEnd = sourceText.indexOf('\n', match.index);
      const sourceLine = sourceText.slice(lineStart, lineEnd === -1 ? sourceText.length : lineEnd);
      if (/^\s*(?:const|let|var)\s*\{.*\}\s*=\s*require\s*\(\s*['"]\./.test(sourceLine)) continue;
      const location = sourceLocation(sourceText, match.index);
      throw new Error(`Unsupported escaped outbound fetch capability in ${source}:${location.line}:${location.column}`);
    }
  }
  for (const alias of [...aliases].filter((name) => !['fetch', 'fetchImpl', 'fetchFn'].includes(name))) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aliasCallPattern = new RegExp(`(?<![\\w$.])${escaped}\\s*(?:\\?\\.)?\\s*\\(`, 'g');
    for (const match of code.matchAll(aliasCallPattern)) {
      const prefix = code.slice(Math.max(0, match.index - 32), match.index);
      if (/\bfunction\s*$/.test(prefix)) continue;
      const location = sourceLocation(sourceText, match.index);
      const key = locatorKey(source, location.line, location.column, 'fetch');
      if (discovered.some((sink) => locatorKey(sink.source, sink.line, sink.column, sink.constructor) === key)) continue;
      discovered.push(Object.freeze({
        service,
        source,
        line: location.line,
        column: location.column,
        constructor: 'fetch',
      }));
    }
  }
  return discovered;
}

function discoverOutboundHttpSinks(rootDir, validatedInventory) {
  const discovered = new Map();
  for (const [service, scope] of Object.entries(validatedInventory.runtimeSources)) {
    const absoluteSources = [];
    for (const directory of scope.directories) {
      const absoluteDirectory = path.resolve(rootDir, directory);
      required(fs.existsSync(absoluteDirectory), `Outbound HTTP runtime directory does not exist: ${directory}`);
      absoluteSources.push(...listJavaScriptFiles(
        absoluteDirectory,
        validatedInventory.exclusions,
        validatedInventory.excludedFileSuffixes
      ));
    }
    for (const source of scope.files) {
      const absoluteSource = path.resolve(rootDir, source);
      required(fs.existsSync(absoluteSource), `Outbound HTTP runtime file does not exist: ${source}`);
      absoluteSources.push(absoluteSource);
    }

    for (const absoluteSource of [...new Set(absoluteSources)].sort()) {
      const source = normalizeSource(path.relative(rootDir, absoluteSource));
      const sourceText = fs.readFileSync(absoluteSource, 'utf8');
      for (const sink of discoverSourceSinks(sourceText, source, service)) {
        const key = locatorKey(sink.source, sink.line, sink.column, sink.constructor);
        required(!discovered.has(key), `Duplicate discovered outbound HTTP sink: ${key}`);
        discovered.set(key, sink);
      }
    }
  }
  return discovered;
}

function verifyOutboundHttpSinks(options = {}) {
  const rootDir = path.resolve(options.rootDir || REPOSITORY_ROOT);
  const inventory = options.inventory || readInventory(options.inventoryPath);
  const validated = validateInventory(inventory, { rootDir });
  const discovered = discoverOutboundHttpSinks(rootDir, validated);

  const missing = [...discovered.keys()].filter((key) => !validated.sinks.has(key)).sort();
  const stale = [...validated.sinks.keys()].filter((key) => !discovered.has(key)).sort();
  required(missing.length === 0, `Unregistered outbound HTTP sink${missing.length === 1 ? '' : 's'}:\n${missing.join('\n')}`);
  required(stale.length === 0, `Stale outbound HTTP sink entr${stale.length === 1 ? 'y' : 'ies'}:\n${stale.join('\n')}`);

  const byService = {};
  const byConstructor = {};
  const byAuthoritySource = {};
  const payloadSensitivity = {};
  const accountingEntries = validated.schemaVersion === 2
    ? [
      ...validated.legacySinks.values(),
      ...validated.operations.values(),
    ]
    : [...validated.sinks.values()];
  for (const sink of validated.sinks.values()) {
    byService[sink.service] = (byService[sink.service] || 0) + 1;
    byConstructor[sink.constructor] = (byConstructor[sink.constructor] || 0) + 1;
  }
  for (const entry of accountingEntries) {
    const policy = validated.policies.get(entry.policyId);
    byAuthoritySource[policy.targetAuthoritySource] = (byAuthoritySource[policy.targetAuthoritySource] || 0) + 1;
    for (const tag of policy.payloadSensitivity) payloadSensitivity[tag] = (payloadSensitivity[tag] || 0) + 1;
  }
  const receipt = {
    schemaVersion: validated.schemaVersion,
    total: discovered.size,
    byService: Object.freeze(byService),
    byConstructor: Object.freeze(byConstructor),
    byAuthoritySource: Object.freeze(byAuthoritySource),
    payloadSensitivity: Object.freeze(payloadSensitivity),
  };
  if (validated.schemaVersion === 2) {
    receipt.logicalOperations = validated.operations.size;
    receipt.enforcedOperations = validated.operations.size;
    receipt.delegates = validated.delegates.size;
    receipt.approvedTransportSinks = validated.sinks.size - validated.legacySinks.size;
    receipt.legacyDirectSinks = validated.legacySinks.size;
  }
  return Object.freeze(receipt);
}

function main() {
  try {
    const receipt = verifyOutboundHttpSinks();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Outbound HTTP sink verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  BODY_BOUND_EXPECTATIONS,
  CONSTRUCTORS,
  DEADLINE_EXPECTATIONS,
  DEFAULT_INVENTORY_PATH,
  EXPECTED_RUNTIME_SOURCES,
  EXPECTATION_SEMANTICS,
  PAYLOAD_SENSITIVITY_TAGS,
  REDIRECT_EXPECTATIONS,
  RESPONSE_MODES,
  REQUIRED_EXCLUSIONS,
  REQUIRED_EXCLUDED_FILE_SUFFIXES,
  TARGET_AUTHORITY_SOURCES,
  V2_EXPECTATION_SEMANTICS,
  discoverExecutorTransportBindings,
  discoverOutboundHttpSinks,
  discoverSourceSinks,
  locatorKey,
  maskNonCode,
  readInventory,
  quotedExecutableLiteralCount,
  validateInventory,
  verifyOutboundHttpSinks,
};

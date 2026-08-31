'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EXPECTATION_SEMANTICS,
  EXPECTED_RUNTIME_SOURCES,
  REQUIRED_EXCLUSIONS,
  REQUIRED_EXCLUDED_FILE_SUFFIXES,
  discoverExecutorTransportBindings,
  discoverSourceSinks,
  quotedExecutableLiteralCount,
  readInventory,
  validateInventory,
  verifyOutboundHttpSinks,
} = require('./verify-outbound-http-sinks');

function fixturePolicy(overrides = {}) {
  return {
    purpose: 'Exercise one fixture request.',
    targetAuthoritySource: 'configured',
    redirectExpectation: 'manual-no-cross-authority',
    deadlineExpectation: 'full-response-lifecycle',
    bodyBoundExpectation: 'bounded',
    payloadSensitivity: ['operational-metadata'],
    ...overrides,
  };
}

function fixtureInventory(sinks = []) {
  return {
    schemaVersion: 1,
    expectationSemantics: EXPECTATION_SEMANTICS,
    scope: {
      runtimeSources: JSON.parse(JSON.stringify(EXPECTED_RUNTIME_SOURCES)),
      excludedDirectoryNames: [...REQUIRED_EXCLUSIONS],
      excludedFileSuffixes: [...REQUIRED_EXCLUDED_FILE_SUFFIXES],
    },
    policies: { 'configured.fixture': fixturePolicy() },
    sinks,
  };
}

function sinkFrom(sourceText, overrides = {}) {
  const [sink] = discoverSourceSinks(sourceText, 'core/src/example.js', 'core');
  return {
    id: 'core.fixture.fetch',
    ...sink,
    policyId: 'configured.fixture',
    ...overrides,
  };
}

function withFixture(sourceText, run) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-outbound-http-'));
  for (const scope of Object.values(EXPECTED_RUNTIME_SOURCES)) {
    for (const directory of scope.directories) fs.mkdirSync(path.join(rootDir, directory), { recursive: true });
    for (const file of scope.files) {
      fs.mkdirSync(path.dirname(path.join(rootDir, file)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, file), '');
    }
  }
  fs.writeFileSync(path.join(rootDir, 'core', 'src', 'example.js'), sourceText);
  try {
    return run(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test('checked-in registry covers every recognized physical constructor and reports the staged v2 enforcement graph', () => {
  const receipt = verifyOutboundHttpSinks();
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.total, 69);
  assert.deepEqual(receipt.byService, { core: 43, benchmark: 25, rag: 1 });
  assert.deepEqual(receipt.byConstructor, {
    fetch: 54,
    'deps.fetch': 1,
    fetchImpl: 10,
    fetchFn: 2,
    'deps.fetchImpl': 1,
    'https.get': 1,
  });
  assert.deepEqual(receipt.byAuthoritySource, { configured: 82, 'request-admitted': 31, canonical: 2 });
  assert.equal(receipt.logicalOperations, 49);
  assert.equal(receipt.enforcedOperations, 49);
  assert.equal(receipt.delegates, 9);
  assert.equal(receipt.approvedTransportSinks, 3);
  assert.equal(receipt.legacyDirectSinks, 66);
});

test('fails closed when a runtime constructor has no exact inventory entry', () => withFixture(
  "const response = await fetch('http://configured.example/status');\n",
  (rootDir) => {
    const unrelatedEntry = {
      id: 'core.fixture.stale',
      service: 'core',
      source: 'core/server.js',
      line: 1,
      column: 1,
      constructor: 'fetch',
      policyId: 'configured.fixture',
    };
    assert.throws(
      () => verifyOutboundHttpSinks({ rootDir, inventory: fixtureInventory([unrelatedEntry]) }),
      /Unregistered outbound HTTP sink:\ncore\/src\/example\.js#1:24 fetch/
    );
  }
));

test('fails closed when an inventory entry no longer matches its source location', () => {
  return withFixture('', (rootDir) => {
    const sink = {
      id: 'core.fixture.fetch',
      service: 'core',
      source: 'core/src/example.js',
      line: 99,
      column: 1,
      constructor: 'fetch',
      policyId: 'configured.fixture',
    };
    assert.throws(
      () => verifyOutboundHttpSinks({ rootDir, inventory: fixtureInventory([sink]) }),
      /Stale outbound HTTP sink entry:\ncore\/src\/example\.js#99:1 fetch/
    );
  });
});

test('inventory validation rejects duplicate IDs and duplicate exact locators', () => {
  const sourceText = "fetch('http://configured.example/status');\n";
  const sink = sinkFrom(sourceText);
  assert.throws(
    () => validateInventory(fixtureInventory([sink, { ...sink, line: 2 }])),
    /Duplicate outbound HTTP sink ID/
  );
  assert.throws(
    () => validateInventory(fixtureInventory([sink, { ...sink, id: 'core.fixture.second' }])),
    /Duplicate outbound HTTP sink locator/
  );
});

test('inventory validation rejects stale policy definitions', () => {
  const sourceText = "fetch('http://configured.example/status');\n";
  const inventory = fixtureInventory([sinkFrom(sourceText)]);
  inventory.policies['configured.unused'] = fixturePolicy();
  assert.throws(() => validateInventory(inventory), /Stale outbound HTTP policy:\nconfigured\.unused/);
});

test('inventory validation rejects dynamic, broad, excluded, and unknown source declarations', () => {
  const sourceText = "fetch('http://configured.example/status');\n";
  const sink = sinkFrom(sourceText);

  assert.throws(
    () => validateInventory(fixtureInventory([{ ...sink, source: '../core/src/example.js' }])),
    /Dynamic or unsafe outbound HTTP sink source/
  );
  assert.throws(
    () => validateInventory(fixtureInventory([{ ...sink, source: 'core/public/example.js' }])),
    /outside core runtime scope/
  );
  assert.throws(
    () => validateInventory(fixtureInventory([{ ...sink, constructor: 'client.request' }])),
    /Unsupported outbound HTTP constructor/
  );

  const broadScope = fixtureInventory([sink]);
  broadScope.scope.runtimeSources.core.directories = ['core'];
  assert.throws(() => validateInventory(broadScope), /do not match the supported product runtime scope/);
});

test('scanner ignores comments and strings while recognizing all supported static forms', () => {
  const sourceText = [
    "// fetch('http://comment.example')",
    "const example = \"https.get('https://string.example')\";",
    "const interpolated = `${fetch('http://template-expression.example')}`;",
    "fetch('http://one.example');",
    "fetchImpl('http://two.example');",
    "fetchFn('http://three.example');",
    "deps.fetch('http://four.example');",
    "deps.fetchImpl('http://five.example');",
    "http.get('http://six.example');",
    "http.request('http://seven.example');",
    "https.get('https://eight.example');",
    "https.request('https://nine.example');",
  ].join('\n');
  assert.deepEqual(
    discoverSourceSinks(sourceText, 'core/src/example.js', 'core').map((sink) => sink.constructor),
    ['fetch', 'fetch', 'fetchImpl', 'fetchFn', 'deps.fetch', 'deps.fetchImpl', 'http.get', 'http.request', 'https.get', 'https.request']
  );
});

test('scanner masks regular-expression literals without hiding later constructors', () => {
  const sourceText = [
    String.raw`const quotedUrl = /\\bhttps?:\\/\\/[^\\s"'<>]+/i;`,
    String.raw`const commentLike = /['"/\\][/*]/g;`,
    'const ratio = numerator / denominator;',
    "fetchImpl('http://after-regex.example');",
    "https.get('https://also-visible.example');",
  ].join('\n');
  const regexSourceText = [
    '#!/usr/bin/env node',
    String.raw`const quotedUrl = /\bhttps?:\/\/[^\s"'<>]+/i;`,
    String.raw`const commentLike = /["'\/\*]/g;`,
    'const ratio = numerator / denominator;',
    "fetchImpl('http://after-regex.example');",
    "https.get('https://also-visible.example');",
  ].join('\n');
  assert.deepEqual(
    discoverSourceSinks(regexSourceText, 'core/src/example.js', 'core').map((sink) => sink.constructor),
    ['fetchImpl', 'https.get']
  );
});

test('scanner rejects unsupported member and computed fetch constructors', () => {
  assert.throws(
    () => discoverSourceSinks("globalThis.fetch('http://example.test');", 'core/src/example.js', 'core'),
    /Unsupported dynamic\/member outbound HTTP constructor/
  );
  assert.throws(
    () => discoverSourceSinks("client[fetchMethod]('http://example.test');", 'core/src/example.js', 'core'),
    /Unsupported computed outbound HTTP constructor/
  );
  assert.throws(
    () => discoverSourceSinks("client['fetch']('http://example.test');", 'core/src/example.js', 'core'),
    /Unsupported computed outbound HTTP constructor/
  );
  assert.throws(
    () => discoverSourceSinks("https['request']('https://example.test');", 'core/src/example.js', 'core'),
    /Unsupported computed outbound HTTP constructor/
  );
  assert.throws(
    () => discoverSourceSinks("require('node:https').request('https://example.test');", 'core/src/example.js', 'core'),
    /Unsupported inline-module outbound HTTP constructor/
  );
  assert.throws(
    () => discoverSourceSinks("const axios = require('axios');", 'core/src/example.js', 'core'),
    /Unsupported outbound HTTP module/
  );
  for (const bypass of [
    "const { request } = require('node:https'); request(url);",
    "const h = require('node:http'); h.get(url);",
    "import { request as send } from 'node:https'; send(url);",
  ]) {
    assert.throws(
      () => discoverSourceSinks(bypass, 'core/src/example.js', 'core'),
      /Unsupported aliased outbound HTTP module binding/
    );
  }
  for (const bypass of [
    'const send = fetch.bind(globalThis); send(url);',
    'const box = { send: fetch }; box.send(url);',
    "const http = require('node:http'); const send = http.request; send(url);",
    "const https = require('node:https'); let send = https.get; send(url);",
    'function invoke(fn) { fn(url); } invoke(fetch);',
    'function invoke(fn) { fn(url); } const send = fetch; invoke(send);',
    'function invoke(fn) { fn(url); } invoke(https.request);',
  ]) {
    assert.throws(
      () => discoverSourceSinks(bypass, 'core/src/example.js', 'core'),
      /Unsupported escaped outbound (?:fetch|HTTP) capability/
    );
  }
  assert.throws(
    () => discoverSourceSinks("const method = 'request'; https[method](url);", 'core/src/example.js', 'core'),
    /Unsupported computed outbound HTTP constructor/
  );
});

test('scanner permits a named fetch parameter only when its physical call remains directly discoverable', () => {
  const sourceText = [
    'async function fetchResponse(fetchImpl, url) {',
    '  return fetchImpl(url);',
    '}',
    'fetchResponse(fetchImpl, url);',
  ].join('\n');
  assert.deepEqual(
    discoverSourceSinks(sourceText, 'core/src/example.js', 'core').map((sink) => sink.constructor),
    ['fetchImpl']
  );
});

test('scanner recognizes optional calls and simple imported or assigned fetch aliases', () => {
  const sourceText = [
    "fetch?.('http://one.example');",
    "deps?.fetch?.('http://two.example');",
    'const send = fetch;',
    "send('http://three.example');",
    "const nodeFetch = require('node-fetch');",
    "nodeFetch('http://four.example');",
    "https?.request?.('https://five.example');",
  ].join('\n');
  assert.deepEqual(
    discoverSourceSinks(sourceText, 'core/src/example.js', 'core').map((sink) => sink.constructor),
    ['fetch', 'deps.fetch', 'https.request', 'fetch', 'fetch']
  );
});

test('delegate proof ignores comments and strings and extracts the executable transport binding', () => {
  const operationId = 'core.fixture.operation';
  const decoys = [
    `// '${operationId}' createOutboundHttpExecutor({ transportAdapter: wrong })`,
    `const note = \"createOutboundHttpExecutor({ transportAdapter: wrong }) '${operationId}'\";`,
    `const template = \`createOutboundHttpExecutor({ transportAdapter: wrong }) '${operationId}'\`;`,
    'function createOutboundHttpExecutor({ transportAdapter: wrong }) {}',
  ].join('\n');
  assert.equal(quotedExecutableLiteralCount(decoys, operationId), 0);
  assert.deepEqual(discoverExecutorTransportBindings(decoys), []);

  const executable = [
    `const OPERATION_ID = '${operationId}';`,
    'const executor = createOutboundHttpExecutor({',
    '  operations,',
    '  transportAdapter: createPinnedTransport({ lookup: options.lookup }),',
    '});',
  ].join('\n');
  assert.equal(quotedExecutableLiteralCount(executable, operationId), 1);
  assert.deepEqual(
    discoverExecutorTransportBindings(executable)
      .map((binding) => binding.transportAdapterExpressions),
    [['createPinnedTransport({lookup:options.lookup})']]
  );
});

test('explicitly excluded browser, test, generated, build, and dependency trees are not scanned', () => withFixture(
  "fetch('http://configured.example/status');\n",
  (rootDir) => {
    const sourceText = fs.readFileSync(path.join(rootDir, 'core', 'src', 'example.js'), 'utf8');
    const sink = sinkFrom(sourceText);
    for (const directory of ['public', 'tests', 'generated', 'build', 'node_modules', 'vendor']) {
      const target = path.join(rootDir, 'core', 'src', directory);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'ignored.js'), "fetch('http://ignored.example');\n");
    }
    const receipt = verifyOutboundHttpSinks({ rootDir, inventory: fixtureInventory([sink]) });
    assert.equal(receipt.total, 1);
  }
));

test('new shared runtime files are scanned without a manual scope-list update', () => withFixture(
  "fetch('http://configured.example/status');\n",
  (rootDir) => {
    const sourceText = fs.readFileSync(path.join(rootDir, 'core', 'src', 'example.js'), 'utf8');
    fs.writeFileSync(
      path.join(rootDir, 'shared', 'futureRuntime.cjs'),
      "fetch('http://unregistered.example/status');\n"
    );
    assert.throws(
      () => verifyOutboundHttpSinks({ rootDir, inventory: fixtureInventory([sinkFrom(sourceText)]) }),
      /shared\/futureRuntime\.cjs#1:1 fetch/
    );
  }
));

test('checked-in JSON is structurally valid before runtime source discovery', () => {
  const validated = validateInventory(readInventory());
  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.sinks.size, 69);
  assert.equal(validated.operations.size, 49);
  assert.equal(validated.delegates.size, 9);
  assert.equal(validated.legacySinks.size, 66);
  assert(validated.policies.size > 0);
});

test('schema v2 rejects cycles, unregistered operation literals, and any new direct-constructor debt', () => {
  const cycle = readInventory();
  cycle.delegates = JSON.parse(JSON.stringify(cycle.delegates));
  cycle.delegates[0].target = { kind: 'delegate', id: cycle.delegates[0].id };
  assert.throws(() => validateInventory(cycle), /delegate graph contains a cycle/);

  const crossService = readInventory();
  crossService.delegates = JSON.parse(JSON.stringify(crossService.delegates));
  crossService.delegates[0].target = { kind: 'sink', id: 'rag.core-outbound.execute' };
  assert.throws(
    () => validateInventory(crossService),
    /terminates in another service transport/
  );

  const missingLiteral = readInventory();
  missingLiteral.operations = JSON.parse(JSON.stringify(missingLiteral.operations));
  missingLiteral.operations[0].id = 'benchmark.core-api.unregistered-literal';
  assert.throws(
    () => validateInventory(missingLiteral),
    /must have one exact runtime registration \(0 found\)/
  );

  const newLegacyDebt = readInventory();
  newLegacyDebt.sinks = JSON.parse(JSON.stringify(newLegacyDebt.sinks));
  const legacyIndex = newLegacyDebt.sinks.findIndex((sink) => sink.id === 'core.server.ollama-tags');
  newLegacyDebt.sinks[legacyIndex].id = 'core.server.new-direct-constructor';
  assert.throws(
    () => validateInventory(newLegacyDebt),
    /New legacy direct outbound sink is forbidden/
  );

  const reusedLegacyId = readInventory();
  reusedLegacyId.sinks = JSON.parse(JSON.stringify(reusedLegacyId.sinks));
  const reusedIndex = reusedLegacyId.sinks.findIndex((sink) => sink.id === 'core.server.ollama-tags');
  reusedLegacyId.sinks[reusedIndex].policyId = 'configured.external-observation';
  assert.throws(
    () => validateInventory(reusedLegacyId),
    /Legacy direct outbound sink fingerprints changed/
  );

  const sameSourceShadow = readInventory();
  sameSourceShadow.sinks = JSON.parse(JSON.stringify(sameSourceShadow.sinks));
  const approved = sameSourceShadow.sinks.find((sink) => sink.id === 'benchmark.transport.peer-verified-node-fetch');
  sameSourceShadow.sinks.push({ ...approved, id: 'benchmark.transport.shadow', column: approved.column + 1 });
  assert.throws(
    () => validateInventory(sameSourceShadow),
    /New legacy direct outbound sink is forbidden/
  );
});

test('schema v2 rejects unsafe graph sources and open method/path contracts', () => {
  const unsafeDelegate = readInventory();
  unsafeDelegate.delegates = JSON.parse(JSON.stringify(unsafeDelegate.delegates));
  unsafeDelegate.delegates.find((delegate) => delegate.id === 'core.peer-verified-node-fetch.request').source = 'core/src/../tests/unit/mcpSkillBus.test.js';
  assert.throws(
    () => validateInventory(unsafeDelegate),
    /Dynamic or unsafe outbound HTTP delegate source/
  );

  const unsafeRegistration = readInventory();
  unsafeRegistration.operations = JSON.parse(JSON.stringify(unsafeRegistration.operations));
  const coreOperation = unsafeRegistration.operations.find((operation) => operation.id === 'core.mcp.loopback-budget');
  coreOperation.registrationSource = 'core/src/../tests/unit/mcpSkillBus.test.js';
  assert.throws(
    () => validateInventory(unsafeRegistration),
    /Dynamic or unsafe outbound HTTP operation registration source/
  );

  const unrelatedDelegate = readInventory();
  unrelatedDelegate.delegates = JSON.parse(JSON.stringify(unrelatedDelegate.delegates));
  unrelatedDelegate.delegates.find((delegate) => delegate.id === 'core.peer-verified-node-fetch.request').source = 'core/src/services/chatService.js';
  assert.throws(
    () => validateInventory(unrelatedDelegate),
    /must contain one executable shared-executor call/
  );

  const wrongTransportBinding = readInventory();
  wrongTransportBinding.delegates = JSON.parse(JSON.stringify(wrongTransportBinding.delegates));
  wrongTransportBinding.delegates[0].transportAdapterExpression = 'wrongTransportAdapter';
  assert.throws(
    () => validateInventory(wrongTransportBinding),
    /transportAdapter expression does not match its reviewed binding/
  );

  const openMethod = readInventory();
  openMethod.operations = JSON.parse(JSON.stringify(openMethod.operations));
  openMethod.operations[0].method = 'TRACE';
  assert.throws(() => validateInventory(openMethod), /Invalid outbound HTTP operation method/);

  const openPath = readInventory();
  openPath.operations = JSON.parse(JSON.stringify(openPath.operations));
  openPath.operations[0].pathPattern = '.*';
  assert.throws(() => validateInventory(openPath), /Invalid outbound HTTP operation pathPattern/);
});

test('inventory validation rejects unknown top-level and scope fields', () => {
  const inventory = fixtureInventory([]);
  inventory.unreviewed = true;
  assert.throws(
    () => validateInventory(inventory),
    /exactly the supported top-level fields/
  );

  delete inventory.unreviewed;
  inventory.scope.unreviewed = true;
  assert.throws(
    () => validateInventory(inventory),
    /exactly runtimeSources, excludedDirectoryNames, and excludedFileSuffixes/
  );
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EXPECTED_SCOPE,
  REVIEW_SEMANTICS,
  discoverPowerShellSinks,
  readInventory,
  validateInventory,
  verifyMaintenanceHttpSinks,
} = require('./verify-maintenance-http-sinks');
const { discoverSourceSinks } = require('./verify-outbound-http-sinks');

function fixtureInventory(sinks = []) {
  return {
    schemaVersion: 1,
    reviewSemantics: REVIEW_SEMANTICS,
    scope: JSON.parse(JSON.stringify(EXPECTED_SCOPE)),
    sinks,
  };
}

function fixtureMetadata(overrides = {}) {
  return {
    authoritySource: 'configured-or-loopback-default',
    deadlineBound: true,
    responseBound: false,
    redirectMode: 'manual',
    purpose: 'Exercise one fixture maintenance request.',
    ...overrides,
  };
}

function javascriptSink(sourceText, source = 'scripts/probe.js', overrides = {}) {
  const [sink] = discoverSourceSinks(sourceText, source, 'maintenance');
  return {
    id: 'maintenance.fixture.javascript',
    source: sink.source,
    line: sink.line,
    column: sink.column,
    constructor: sink.constructor,
    ...fixtureMetadata(),
    ...overrides,
  };
}

function powershellSink(sourceText, overrides = {}) {
  const [sink] = discoverPowerShellSinks(sourceText, 'agentx.ps1');
  return {
    id: 'maintenance.fixture.powershell',
    source: sink.source,
    line: sink.line,
    column: sink.column,
    constructor: sink.constructor,
    ...fixtureMetadata({ authoritySource: 'loopback-fixed', redirectMode: 'client-default' }),
    ...overrides,
  };
}

function withFixture(files, run) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-maintenance-http-'));
  for (const directory of EXPECTED_SCOPE.directories) {
    fs.mkdirSync(path.join(rootDir, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(rootDir, 'agentx.ps1'), files['agentx.ps1'] || '');
  for (const [source, contents] of Object.entries(files)) {
    if (source === 'agentx.ps1') continue;
    const absolute = path.join(rootDir, source);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  try {
    return run(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test('checked-in maintenance registry covers every reviewed direct call and reports its boundedness honestly', () => {
  const receipt = verifyMaintenanceHttpSinks();
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.total, 10);
  assert(receipt.sourcesScanned >= 28);
  assert.deepEqual(receipt.byLanguage, { javascript: 9, powershell: 1 });
  assert.deepEqual(receipt.byConstructor, {
    fetchImpl: 8,
    fetch: 1,
    'HttpClient.SendAsync': 1,
  });
  assert.deepEqual(receipt.deadlineBound, { bounded: 10, unbounded: 0 });
  assert.deepEqual(receipt.responseBound, { bounded: 10, unbounded: 0 });
  assert.deepEqual(receipt.byRedirectMode, { manual: 9, follow: 1 });
});

test('review semantics explicitly preserve the static inventory and non-enforcement boundary', () => {
  assert.match(REVIEW_SEMANTICS, /bounded static reviewed-direct inventory—not executor enforcement/);
  const validated = validateInventory(readInventory());
  assert.equal(validated.sinks.size, 10);
});

test('fails closed when a new JavaScript constructor has no exact inventory entry', () => withFixture(
  { 'scripts/probe.js': "const response = await fetch('http://127.0.0.1/status');\n" },
  (rootDir) => assert.throws(
    () => verifyMaintenanceHttpSinks({ rootDir, inventory: fixtureInventory() }),
    /Unregistered maintenance HTTP sink:\nscripts\/probe\.js#1:24 fetch/
  )
));

test('fails closed when a new PowerShell command has no exact inventory entry', () => withFixture(
  { 'agentx.ps1': "Invoke-RestMethod -Uri 'http://127.0.0.1/status'\n" },
  (rootDir) => assert.throws(
    () => verifyMaintenanceHttpSinks({ rootDir, inventory: fixtureInventory() }),
    /Unregistered maintenance HTTP sink:\nagentx\.ps1#1:1 Invoke-RestMethod/
  )
));

test('fails closed when a new PowerShell HttpClient send has no exact inventory entry', () => withFixture(
  { 'agentx.ps1': '$response = $client.SendAsync($request)\n' },
  (rootDir) => assert.throws(
    () => verifyMaintenanceHttpSinks({ rootDir, inventory: fixtureInventory() }),
    /Unregistered maintenance HTTP sink:\nagentx\.ps1#1:13 HttpClient\.SendAsync/
  )
));

test('fails closed when an inventoried locator becomes stale', () => withFixture(
  { 'scripts/probe.js': "// request removed\n" },
  (rootDir) => {
    const stale = {
      id: 'maintenance.fixture.stale',
      source: 'scripts/probe.js',
      line: 1,
      column: 1,
      constructor: 'fetch',
      ...fixtureMetadata(),
    };
    assert.throws(
      () => verifyMaintenanceHttpSinks({ rootDir, inventory: fixtureInventory([stale]) }),
      /Stale maintenance HTTP sink entry:\nscripts\/probe\.js#1:1 fetch/
    );
  }
));

test('PowerShell scanner ignores comments and literals but sees executable interpolation', () => {
  const sourceText = [
    '# Invoke-WebRequest -Uri http://comment.example',
    '<# Invoke-RestMethod -Uri http://block.example #>',
    '# $commentClient.SendAsync($request)',
    "$single = 'Invoke-WebRequest'",
    '$double = "Invoke-RestMethod"',
    '$literal = "$literalClient.SendAsync($request)"',
    '$methodReference = $client.SendAsync',
    '$expanded = "$(Invoke-RestMethod -Uri $uri)"',
    '$response = $client.SendAsync($request)',
    'Invoke-WebRequest -Uri $uri',
  ].join('\n');
  assert.deepEqual(
    discoverPowerShellSinks(sourceText, 'agentx.ps1').map((sink) => sink.constructor),
    ['Invoke-RestMethod', 'HttpClient.SendAsync', 'Invoke-WebRequest']
  );
});

test('non-test scope is recursive and excludes tests, generated trees, and dependencies', () => withFixture(
  {
    'scripts/nested/probe.js': "fetchImpl('http://127.0.0.1/status');\n",
    'scripts/ignored.test.js': "fetch('http://ignored.test');\n",
    'scripts/tests/ignored.js': "fetch('http://ignored.test');\n",
    'core/scripts/generated/ignored.js': "fetch('http://ignored.test');\n",
    'benchmark/scripts/node_modules/ignored.js': "fetch('http://ignored.test');\n",
  },
  (rootDir) => {
    const sourceText = "fetchImpl('http://127.0.0.1/status');\n";
    const sink = javascriptSink(sourceText, 'scripts/nested/probe.js');
    const receipt = verifyMaintenanceHttpSinks({ rootDir, inventory: fixtureInventory([sink]) });
    assert.equal(receipt.total, 1);
    assert.deepEqual(receipt.byLanguage, { javascript: 1 });
  }
));

test('inventory rejects unsafe, test, broad, and backslash source paths', () => withFixture(
  { 'scripts/probe.js': "fetch('http://127.0.0.1/status');\n" },
  (rootDir) => {
    const sourceText = "fetch('http://127.0.0.1/status');\n";
    const sink = javascriptSink(sourceText);
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, source: '../scripts/probe.js' }]), { rootDir }),
      /Dynamic or unsafe maintenance HTTP sink source/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, source: 'scripts\\probe.js' }]), { rootDir }),
      /must use forward slashes/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, source: 'scripts/probe.test.js' }]), { rootDir }),
      /test file/
    );
    const broad = fixtureInventory([sink]);
    broad.scope.directories = ['scripts', 'core', 'benchmark/scripts'];
    assert.throws(() => validateInventory(broad, { rootDir }), /scope directories does not match/);
  }
));

test('inventory freezes unique IDs, exact locators, and required review metadata', () => withFixture(
  { 'scripts/probe.js': "fetch('http://127.0.0.1/status');\n" },
  (rootDir) => {
    const sink = javascriptSink("fetch('http://127.0.0.1/status');\n");
    assert.throws(
      () => validateInventory(fixtureInventory([sink, { ...sink, line: 2 }]), { rootDir }),
      /Duplicate maintenance HTTP sink ID/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([sink, { ...sink, id: 'maintenance.fixture.second' }]), { rootDir }),
      /Duplicate maintenance HTTP sink locator/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, deadlineBound: 'yes' }]), { rootDir }),
      /deadlineBound must be boolean/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, responseBound: null }]), { rootDir }),
      /responseBound must be boolean/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, authoritySource: 'unknown' }]), { rootDir }),
      /Invalid authoritySource/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, redirectMode: 'unreviewed' }]), { rootDir }),
      /Invalid redirectMode/
    );
    assert.throws(
      () => validateInventory(fixtureInventory([{ ...sink, undocumented: true }]), { rootDir }),
      /exactly the required sink fields/
    );
  }
));

test('JavaScript capability forms that cannot be safely classified fail the inventory scan', () => withFixture(
  {
    'scripts/probe.js': [
      'const send = fetch.bind(globalThis);',
      "send('http://127.0.0.1/status');",
    ].join('\n'),
  },
  (rootDir) => assert.throws(
    () => verifyMaintenanceHttpSinks({ rootDir, inventory: fixtureInventory() }),
    /Unsupported escaped outbound fetch capability/
  )
));

test('inventory rejects unknown top-level and scope fields', () => {
  const inventory = fixtureInventory();
  inventory.unreviewed = true;
  assert.throws(() => validateInventory(inventory), /exactly the supported top-level fields/);

  delete inventory.unreviewed;
  inventory.scope.unreviewed = true;
  assert.throws(
    () => validateInventory(inventory),
    /exactly directories, files, excludedDirectoryNames, and excludedFileSuffixes/
  );
});

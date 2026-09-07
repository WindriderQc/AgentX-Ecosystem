'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exitCode } = require('./runJest');
const { suiteDatabase, withDatabase } = require('./mongoIdentity');
const launcher = path.join(__dirname, 'runJest.js');
function fixture(source, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-runner-test-'));
  const bin = path.join(dir, 'node_modules/jest/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'jest.js'), source);
  const result = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(launcher)}).run(${JSON.stringify(dir)}).then(code=>{process.exitCode=code}).catch(e=>{console.error(e.message);process.exitCode=1})`],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, TEST_USE_EXTERNAL_MONGO: 'false', ...env } });
  return { dir, result };
}
test('null status is never success, including signals', () => {
  assert.equal(exitCode(null, 'SIGTERM'), 1);
  assert.equal(exitCode(null, 'SIGINT'), 130);
  assert.equal(exitCode(null, null), 1);
  assert.equal(exitCode(7, null), 7);
});
test('runner preserves failure, arguments and test environment and retains logs', () => {
  const { dir, result } = fixture(`console.log(JSON.stringify({ args:process.argv.slice(2), env:process.env.NODE_ENV, uri:process.env.MONGODB_URI }));process.exit(7)`);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /"env":"test"/);
  const id = fs.readdirSync(path.join(dir, 'test-results'))[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'test-results', id, 'result.json'))).status, 7);
  assert.match(fs.readFileSync(path.join(dir, 'test-results', id, 'run.log'), 'utf8'), /"args"/);
});
test('runner times out a hung child with a nonzero result', () => {
  const { result } = fixture('setInterval(()=>{},1000)', { TEST_RUN_TIMEOUT_MS: '300' });
  assert.equal(result.status, 124, result.stderr);
});
test('child killed by signal cannot produce success', () => {
  const { result } = fixture("process.kill(process.pid, 'SIGTERM')");
  assert.notEqual(result.status, 0, result.stderr);
});
test('external target must be explicit', () => {
  const { result } = fixture('process.exit(0)', { TEST_USE_EXTERNAL_MONGO: 'true', MONGODB_URI_TEST: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MONGODB_URI_TEST explicitly/);
});
test('database identity varies with suite and run; replica-set options survive', () => {
  const original = process.env.JEST_MONGO_RUN_ID;
  try {
    process.env.JEST_MONGO_RUN_ID = 'one';
    const first = suiteDatabase('/first');
    assert.equal(first, suiteDatabase('/first'));
    assert.notEqual(first, suiteDatabase('/second'));
    process.env.JEST_MONGO_RUN_ID = 'two';
    assert.notEqual(first, suiteDatabase('/first'));
    assert.equal(withDatabase('mongodb://user:pass@one:27017,two:27017/app?replicaSet=rs&authSource=admin', first),
      `mongodb://user:pass@one:27017,two:27017/${first}?replicaSet=rs&authSource=admin`);
    assert.throws(() => withDatabase('', first), /explicit/);
  } finally {
    if (original === undefined) delete process.env.JEST_MONGO_RUN_ID;
    else process.env.JEST_MONGO_RUN_ID = original;
  }
});
test('no-DB guard rejects a real Mongo startup and a socket connection', () => {
  for (const source of ["require('net').connect(27017)", "require('child_process').spawn('mongod')"]) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'noDatabase.js'))});${source}`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NO_DB_TEST/);
  }
});

'use strict';
// Destructive only to the child Jest/Mongo processes created by this probe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function probe(service, mode) {
  const dir = path.join(root, service);
  const fixtureDir = path.join(dir, 'tests', '.tmp');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixture = path.join(fixtureDir, `owned-mongo-${randomUUID()}.test.js`);
  const readyFile = `${fixture}.json`;
  const setup = service === 'core'
    ? `const fs = require('fs'); const state = JSON.parse(fs.readFileSync(process.env.JEST_MONGO_JSON_FILE)); fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify(state));`
    : `const { MongoMemoryServer } = require('mongodb-memory-server'); let mongo; beforeAll(async()=>{mongo=await MongoMemoryServer.create(); require('fs').writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({ownerPid:process.pid,mongoPid:mongo.instanceInfo.instance.mongodProcess.pid}));}); afterAll(async()=>{await mongo?.stop()});`;
  fs.writeFileSync(fixture, `${setup}\ntest('intentional hang', async()=>{await new Promise(resolve=>setTimeout(resolve,60000))},70000);\n`);
  let output = '';
  let owned;
  let signalled = false;
  const child = spawn(process.execPath, ['scripts/run-jest.js', '--runTestsByPath', fixture, '--verbose=false'], {
    cwd: dir, windowsHide: true, env: { ...process.env, TEST_USE_EXTERNAL_MONGO: 'false', TEST_RUN_TIMEOUT_MS: '10000', MONGOMS_RUNTIME_DOWNLOAD: 'false' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const read = data => {
    output += data;
  };
  const monitor = setInterval(() => {
    if (!owned && fs.existsSync(readyFile)) {
      try { owned = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch { /* write pending */ }
    }
    if (owned && (mode === 'signal' || mode === 'launcher') && !signalled) {
      signalled = true;
      process.kill(mode === 'launcher' ? child.pid : owned.ownerPid, 'SIGTERM');
    }
  }, 100);
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.ok(owned?.mongoPid, `Mongo never became ready: ${output}`);
    assert.notEqual(result.code, 0, output);
    if (mode === 'timeout') assert.equal(result.code, 124, output);
    const deadline = Date.now() + 10000;
    while ((alive(owned.mongoPid) || (owned.pid && alive(owned.pid))) && Date.now() < deadline) await delay(100);
    assert.equal(alive(owned.mongoPid), false, `owned Mongo ${owned.mongoPid} survived`);
    if (owned.pid) assert.equal(alive(owned.pid), false, `owned daemon ${owned.pid} survived`);
    const receipt = { service, mode, ...result, mongoPid: owned.mongoPid, mongoStopped: true };
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally {
    clearInterval(monitor);
    fs.unlinkSync(fixture);
    if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
  }
}
(async () => {
  const receipts = [];
  for (const service of ['core', 'benchmark']) {
    for (const mode of ['signal', 'timeout', 'launcher']) receipts.push(await probe(service, mode));
  }
  const receiptDir = path.join(root, 'core', 'test-results');
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(path.join(receiptDir, 'mongo-interruption-acceptance.json'), JSON.stringify(receipts, null, 2));
})().catch(err => { console.error(err); process.exitCode = 1; });

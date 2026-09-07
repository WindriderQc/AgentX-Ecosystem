'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
function exitCode(code, signal) { return Number.isInteger(code) ? code : (signal === 'SIGINT' ? 130 : 1); }
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // Kill the tree before its root disappears.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else process.kill(-pid, 'SIGKILL');
  } catch (err) { if (process.platform !== 'win32' && err.code !== 'ESRCH') throw err; }
}
async function run(serviceDir, args = process.argv.slice(2)) {
  const jestBin = path.join(serviceDir, 'node_modules/jest/bin/jest.js');
  if (!fs.existsSync(jestBin)) throw new Error(`Jest is missing. Run npm ci in ${serviceDir}`);
  const timeout = Number(process.env.TEST_RUN_TIMEOUT_MS || 1800000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('TEST_RUN_TIMEOUT_MS must be positive');
  const id = randomUUID();
  const env = { ...process.env, NODE_ENV: 'test', TEST_LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
    MONGOMS_VERSION: process.env.MONGOMS_VERSION || '7.0.24', JEST_MONGO_RUN_ID: id,
    TEST_RUN_OWNER_PID: String(process.pid) };
  if (env.TEST_USE_EXTERNAL_MONGO === 'true') {
    if (!env.MONGODB_URI_TEST) throw new Error('External tests require MONGODB_URI_TEST explicitly');
  } else {
    delete env.MONGODB_URI_TEST;
    delete env.MONGODB_URI;
    delete env.MONGODB_TEST_URI;
  }
  delete env.JEST_MONGO_JSON_FILE;
  delete env.JEST_MONGO_URI_FILE;
  const outputDir = path.join(serviceDir, 'test-results', id);
  fs.mkdirSync(outputDir, { recursive: true });
  env.TEST_RUN_OUTPUT_DIR = outputDir;
  const startedAt = Date.now();
  const resultFile = path.join(outputDir, 'result.json');
  fs.writeFileSync(resultFile, JSON.stringify({ id, state: 'running', status: null }, null, 2));
  const log = fs.createWriteStream(path.join(outputDir, 'run.log'));
  const workerMode = args.some(arg => /^--(?:runInBand|maxWorkers)(?:=|$)/.test(arg) || /^-w(?:\d+)?$/.test(arg));
  console.log(`[test-run ${id}] log: ${path.join(outputDir, 'run.log')}`);
  const child = spawn(process.execPath, ['--max-old-space-size=4096', '--require', path.join(__dirname, 'ownerWatchdog.js'), jestBin,
    ...(!workerMode ? ['--maxWorkers=2'] : []), ...args], {
    cwd: serviceDir, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
  child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
  let interrupted = 0;
  const onInt = () => { interrupted = 130; killTree(child.pid); };
  const onTerm = () => { interrupted = 143; killTree(child.pid); };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timer = setTimeout(() => {
    const message = `Test run exceeded ${timeout}ms; terminating owned processes.`;
    console.error(message);
    log.write(`${message}\n`);
    interrupted = 124;
    killTree(child.pid);
  }, timeout);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    const stateFile = path.join(serviceDir, 'tests', '.jest-mongo', id, 'state.json');
    try {
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.runId === id && state.ownerPid === child.pid) killTree(state.pid);
      }
    } finally { await new Promise(resolve => log.end(resolve)); }
  }
  const status = interrupted || exitCode(result.code, result.signal);
  fs.writeFileSync(resultFile, JSON.stringify({ id, state: 'completed', status, ...result, elapsedMs: Date.now() - startedAt }, null, 2));
  return status;
}
module.exports = { run, exitCode, killTree };

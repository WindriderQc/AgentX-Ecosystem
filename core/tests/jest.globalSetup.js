'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { prepareMongoFiles, removeMongoFiles } = require('./mongoMemoryFiles');
const { sleep, terminateProcessTree } = require('./mongoMemoryProcess');
module.exports = async () => {
  if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
    if (!process.env.MONGODB_URI_TEST) throw new Error('External tests require MONGODB_URI_TEST explicitly');
    return;
  }
  process.env.MONGOMS_VERSION ||= '7.0.24';
  const files = prepareMongoFiles();
  process.env.JEST_MONGO_OWNER_PID = String(process.pid);
  global.__AGENTX_JEST_MONGO_FILES = files;
  fs.mkdirSync(files.stateDir, { recursive: true });
  const logFile = path.join(process.env.TEST_RUN_OUTPUT_DIR || files.stateDir, 'mongo.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'mongoMemoryServerDaemon.js')], {
    detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: { ...process.env }
  });
  fs.closeSync(logFd);
  global.__AGENTX_JEST_MONGO_DAEMON_PID = child.pid;
  let failure;
  child.on('error', err => { failure = err.message; });
  child.on('exit', (code, signal) => { failure = `daemon exited: code=${code}, signal=${signal}`; });
  child.unref();
  const timeout = Number(process.env.JEST_MONGO_START_TIMEOUT_MS || 120000);
  try {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('JEST_MONGO_START_TIMEOUT_MS must be positive');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (fs.existsSync(files.jsonFile)) {
        let state;
        try { state = JSON.parse(fs.readFileSync(files.jsonFile, 'utf8')); } catch { /* atomic startup may be pending */ }
        if (state?.error) throw new Error(state.error);
        if (!failure && state?.baseUri && fs.existsSync(files.uriFile)) return;
      }
      if (failure) throw new Error(failure);
      await sleep(100);
    }
    throw new Error(`startup exceeded ${timeout}ms`);
  } catch (err) {
    await terminateProcessTree(child.pid);
    removeMongoFiles(files);
    throw new Error(`Test Mongo startup failed (run=${files.runId}; log=${logFile}): ${err.message}`);
  }
};

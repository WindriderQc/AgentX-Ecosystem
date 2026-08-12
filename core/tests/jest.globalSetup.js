const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  listMongoStateFiles,
  prepareMongoFiles,
  removeMongoFiles
} = require('./mongoMemoryFiles');
const { processExists, sleep, terminateProcessTree } = require('./mongoMemoryProcess');
const { sweepStaleMongoTmpDirs } = require('./mongoMemoryTmpSweeper');
const DAEMON_SCRIPT = path.join(__dirname, 'mongoMemoryServerDaemon.js');

function getStartupDeadlineMs() {
  const configured = Number(process.env.JEST_MONGO_START_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return process.platform === 'win32' ? 120000 : 30000;
}

async function cleanupStaleMongoDaemons(currentJsonFile) {
  for (const files of listMongoStateFiles()) {
    if (files.jsonFile === currentJsonFile || !fs.existsSync(files.jsonFile)) continue;

    let shouldRemoveFiles = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(files.jsonFile, 'utf8'));
      const ownerPid = parsed?.ownerPid;
      const daemonPid = parsed?.pid;

      if (ownerPid && processExists(ownerPid)) {
        shouldRemoveFiles = false;
        continue;
      }
      if (daemonPid) await terminateProcessTree(daemonPid);
    } catch {
      // ignore stale or partially-written state files
    } finally {
      if (shouldRemoveFiles) {
        removeMongoFiles(files);
      }
    }
  }
}

module.exports = async () => {
  const useExternalMongo = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
  if (useExternalMongo) return;

  const files = prepareMongoFiles();
  process.env.JEST_MONGO_OWNER_PID = String(process.pid);
  global.__AGENTX_JEST_MONGO_FILES = files;

  await cleanupStaleMongoDaemons(files.jsonFile);

  // Sweep orphaned mongodb-memory-server dbPath folders (mongo-mem-*) left in
  // the OS temp dir by hard-killed runs. Active dbPaths (locked) and recent
  // ones are skipped; this only reclaims stale ~300 MB leftovers.
  try {
    const swept = sweepStaleMongoTmpDirs();
    if (swept.removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`Swept ${swept.removed} stale mongo-mem-* temp dir(s) before test run.`);
    }
  } catch {
    // Best-effort cleanup; never block the test run on it.
  }

  // Clean up any stale files from this run id.
  removeMongoFiles(files);
  fs.mkdirSync(files.stateDir, { recursive: true });

  // Start a persistent daemon process that owns MongoMemoryServer.
  // This avoids mongodb-memory-server's internal parent-death killer from
  // terminating mongod when Jest's globalSetup process exits.
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env }
  });
  let daemonExit = null;
  child.on('exit', (code, signal) => {
    daemonExit = { code, signal };
  });
  global.__AGENTX_JEST_MONGO_DAEMON_PID = child.pid;
  child.unref();

  // Wait for the daemon to write connection info.
  const deadline = Date.now() + getStartupDeadlineMs();
  let lastDaemonError = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(files.jsonFile) && fs.existsSync(files.uriFile)) {
      const raw = fs.readFileSync(files.jsonFile, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.baseUri) return;
        if (parsed && parsed.error) lastDaemonError = parsed.error;
      } catch {
        // keep waiting
      }
    } else if (fs.existsSync(files.jsonFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(files.jsonFile, 'utf8'));
        if (parsed && parsed.error) lastDaemonError = parsed.error;
      } catch {
        // keep waiting
      }
    }
    await sleep(100);
  }

  // Fall back to per-process MongoMemoryServer startup in setup-env.js.
  // This is slower, but avoids hard-failing on Windows when the first
  // binary download or extraction takes longer than expected.
  await terminateProcessTree(child.pid);
  removeMongoFiles(files);
  // eslint-disable-next-line no-console
  console.warn([
    'Jest Mongo daemon did not become ready before the startup deadline; falling back to per-process startup.',
    `runId=${files.runId}`,
    `pid=${child.pid || 'unknown'}`,
    `stateFile=${files.jsonFile}`,
    `uriFile=${files.uriFile}`,
    `exit=${daemonExit ? JSON.stringify(daemonExit) : 'not observed'}`,
    `error=${lastDaemonError || 'none'}`
  ].join(' '));
};

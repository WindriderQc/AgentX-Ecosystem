const fs = require('fs');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getMongoFiles, removeMongoFiles } = require('./mongoMemoryFiles');
const { pickMongoMemoryPort } = require('./mongoMemoryPort');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getReadyTimeoutMs() {
  const configured = Number(process.env.JEST_MONGO_READY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return process.platform === 'win32' ? 15000 : 5000;
}

async function waitForMongoReady(uri) {
  const deadline = Date.now() + getReadyTimeoutMs();
  let lastError = null;

  while (Date.now() < deadline) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 1000,
      family: 4
    });

    try {
      await client.db().admin().ping();
      return;
    } catch (err) {
      lastError = err;
      await sleep(100);
    } finally {
      await client.close().catch(() => {});
    }
  }

  throw lastError || new Error(`MongoMemoryServer did not become ready at ${uri}`);
}

async function main() {
  const useExternalMongo = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
  if (useExternalMongo) {
    process.exit(0);
  }

  const files = getMongoFiles();
  fs.mkdirSync(files.stateDir, { recursive: true });
  const port = await pickMongoMemoryPort();

  const mongod = await MongoMemoryServer.create({
    instance: {
      port,
      dbName: 'agentx_test',
      launchTimeout: 30000
    },
    spawn: {
      windowsHide: true
    }
  });

  const baseUri = mongod.getUri();
  await waitForMongoReady(mongod.getUri('agentx_test'));

  const payload = {
    baseUri,
    pid: process.pid,
    ownerPid: Number(process.env.JEST_MONGO_OWNER_PID) || null,
    runId: files.runId,
    startedAt: new Date().toISOString()
  };

  fs.writeFileSync(files.jsonFile, JSON.stringify(payload), 'utf8');
  fs.writeFileSync(files.uriFile, baseUri, 'utf8');

  const shutdown = async () => {
    try {
      await mongod.stop();
    } catch {
      // ignore
    }

    removeMongoFiles(files);

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep the process alive for the duration of the Jest run.
  setInterval(() => {}, 1 << 30);
}

main().catch(err => {
  try {
    const files = getMongoFiles();
    fs.mkdirSync(files.stateDir, { recursive: true });
    fs.writeFileSync(files.jsonFile, JSON.stringify({ error: String(err) }), 'utf8');
  } catch {
    // ignore
  }
  // eslint-disable-next-line no-console
  console.error('mongoMemoryServerDaemon failed:', err);
  process.exit(1);
});

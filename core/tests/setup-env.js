/**
 * Test environment setup
 * Runs before each test file in the same environment context.
 */

const fs = require('fs');
const { MongoClient } = require('mongodb');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const connectDB = require('../config/db');
const { destroyAgents } = require('../src/helpers/httpAgent');
const { getMongoFiles, LEGACY_URI_FILE } = require('./mongoMemoryFiles');
const { pickMongoMemoryPort } = require('./mongoMemoryPort');

const TEST_DB_STATE_KEY = Symbol.for('agentx.testDbState');
const SHARED_MONGO_HEALTH_KEY = Symbol.for('agentx.sharedMongoHealth');

function getDisconnectIdleMs() {
  if (process.env.JEST_DB_IDLE_DISCONNECT_MS !== undefined) {
    const configured = Number(process.env.JEST_DB_IDLE_DISCONNECT_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : 0;
  }

  return 0;
}

const DISCONNECT_IDLE_MS = getDisconnectIdleMs();

function getTestDbState() {
  if (!process[TEST_DB_STATE_KEY]) {
    process[TEST_DB_STATE_KEY] = {
      connectPromise: null,
      disconnectTimer: null,
      mongoServer: null,
      mongoUriSource: null
    };
  }

  return process[TEST_DB_STATE_KEY];
}

function getSharedMongoHealth() {
  if (!process[SHARED_MONGO_HEALTH_KEY]) {
    process[SHARED_MONGO_HEALTH_KEY] = {
      disabled: false,
      failure: null
    };
  }

  return process[SHARED_MONGO_HEALTH_KEY];
}

function clearPendingDisconnect(state) {
  if (!state.disconnectTimer) return;

  clearTimeout(state.disconnectTimer);
  state.disconnectTimer = null;
}

function resolveWorkerMongoUri(state) {
  if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
    state.mongoUriSource = 'external';
    return process.env.MONGODB_URI || null;
  }

  const sharedHealth = getSharedMongoHealth();
  if (sharedHealth.disabled) {
    return null;
  }

  const files = getMongoFiles();
  const mongoUriFile = fs.existsSync(files.uriFile) ? files.uriFile : LEGACY_URI_FILE;

  if (fs.existsSync(mongoUriFile)) {
    const baseUri = fs.readFileSync(mongoUriFile, 'utf8').trim().replace(/\/+$/, '');
    const workerId = process.env.JEST_WORKER_ID || '0';
    const uri = `${baseUri}/agentx_test_${workerId}`;
    process.env.MONGODB_URI = uri;
    state.mongoUriSource = mongoUriFile === LEGACY_URI_FILE ? 'legacy-shared-daemon' : 'shared-daemon';
    return uri;
  }

  if (state.mongoServer) {
    const uri = state.mongoServer.getUri('agentx_test');
    process.env.MONGODB_URI = uri;
    state.mongoUriSource = 'local-fallback';
    return uri;
  }

  return null;
}

async function ensureMongoUri(state) {
  const uri = resolveWorkerMongoUri(state);
  if (uri || process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
    return uri;
  }

  return startFallbackMongoServer(state);
}

async function startFallbackMongoServer(state) {
  const port = await pickMongoMemoryPort();
  state.mongoServer = await MongoMemoryServer.create({
    instance: {
      port,
      dbName: 'agentx_test',
      launchTimeout: 30000
    },
    spawn: {
      windowsHide: true
    }
  });

  const fallbackUri = state.mongoServer.getUri('agentx_test');
  process.env.MONGODB_URI = fallbackUri;
  state.mongoUriSource = 'local-fallback';
  return fallbackUri;
}

async function stopFallbackMongoServer(state) {
  if (!state.mongoServer) return;

  try {
    await state.mongoServer.stop({ doCleanup: true, force: true });
  } finally {
    state.mongoServer = null;
  }
}

function getSharedDaemonState() {
  const files = getMongoFiles();
  let parsed = null;
  let error = null;

  try {
    if (fs.existsSync(files.jsonFile)) {
      parsed = JSON.parse(fs.readFileSync(files.jsonFile, 'utf8'));
    }
  } catch (err) {
    error = err.message;
  }

  return {
    runId: files.runId,
    jsonFile: files.jsonFile,
    uriFile: files.uriFile,
    parsed,
    error
  };
}

function formatSharedDaemonDiagnostic(err) {
  const state = getSharedDaemonState();
  const parsed = state.parsed || {};
  const parts = [
    `runId=${state.runId}`,
    `pid=${parsed.pid || 'unknown'}`,
    `ownerPid=${parsed.ownerPid || 'unknown'}`,
    `baseUri=${parsed.baseUri || 'unknown'}`,
    `stateFile=${state.jsonFile}`,
    `uriFile=${state.uriFile}`,
    `stateError=${state.error || 'none'}`,
    `connectError=${err.message}`
  ];

  return parts.join('; ');
}

async function pingMongoUri(uri) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 1000,
    family: 4
  });

  try {
    await client.db().admin().ping();
  } finally {
    await client.close().catch(() => {});
  }
}

async function switchToLocalFallback(state, reason) {
  const sharedHealth = getSharedMongoHealth();
  sharedHealth.disabled = true;
  sharedHealth.failure = reason;

  await mongoose.disconnect().catch(() => {});
  await stopFallbackMongoServer(state).catch(() => {});
  delete process.env.MONGODB_URI;

  await startFallbackMongoServer(state);
}

async function connectMongoose() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await connectDB();

  const { waitForConnection } = require('./helpers/dbHelper');
  await waitForConnection();

  // eslint-disable-next-line no-console
  console.log('✅ Test environment: MongoDB connected and ready');
}

async function recoverMongoAfterConnectFailure(state, err) {
  if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
    throw err;
  }

  if (state.mongoUriSource === 'shared-daemon' || state.mongoUriSource === 'legacy-shared-daemon') {
    const diagnostic = formatSharedDaemonDiagnostic(err);
    // eslint-disable-next-line no-console
    console.warn(`⚠️ Shared Jest Mongo daemon unavailable; this worker is switching to a local fallback MongoMemoryServer. ${diagnostic}`);
    await switchToLocalFallback(state, diagnostic);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn('⚠️ Test Mongo connection failed; restarting local fallback MongoMemoryServer:', err.message);
  await switchToLocalFallback(state, err.message);
}

async function disconnectTestResources(state) {
  try {
    destroyAgents();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Warning: preventing test hang - Error resetting singleton services:', err.message);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close(true);
      // eslint-disable-next-line no-console
      console.log('✅ Test environment: MongoDB disconnected');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Warning: preventing test hang - Error closing MongoDB:', err.message);
  }

  try {
    await stopFallbackMongoServer(state);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Warning: preventing test hang - Error stopping MongoMemoryServer:', err.message);
  }
}

function scheduleDisconnect(state) {
  clearPendingDisconnect(state);

  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    void disconnectTestResources(state);
  }, DISCONNECT_IDLE_MS);

  if (typeof state.disconnectTimer.unref === 'function') {
    state.disconnectTimer.unref();
  }
}

process.env.NODE_ENV = 'test';

if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
if (!process.env.OLLAMA_HOST_SECONDARY && !process.env.OLLAMA_HOST_2) {
  process.env.OLLAMA_HOST_SECONDARY = 'http://127.0.0.1:11435';
}
if (!process.env.EMBEDDING_MODEL) process.env.EMBEDDING_MODEL = 'nomic-embed-text:v1.5';
if (!process.env.EMBEDDING_DIMENSION) process.env.EMBEDDING_DIMENSION = '768';

beforeAll(async () => {
  const state = getTestDbState();
  clearPendingDisconnect(state);

  if (!state.connectPromise) {
    state.connectPromise = (async () => {
      await ensureMongoUri(state);
      if (state.mongoUriSource === 'shared-daemon' || state.mongoUriSource === 'legacy-shared-daemon') {
        try {
          await pingMongoUri(process.env.MONGODB_URI);
        } catch (err) {
          await recoverMongoAfterConnectFailure(state, err);
        }
      }

      try {
        await connectMongoose();
      } catch (err) {
        await recoverMongoAfterConnectFailure(state, err);
        await connectMongoose();
      }
    })().finally(() => {
      state.connectPromise = null;
    });
  }

  await state.connectPromise;
}, 60000);

afterAll(async () => {
  // Stop the modelRouterConfig pin-cache interval and await any in-flight
  // refresh — but only if the module is already loaded. Force-loading it
  // here would make every test file pay the initial Mongo-touching refresh
  // cost. We check require.cache so unrelated unit tests stay fast (task 0192).
  try {
    const modulePath = require.resolve('../src/services/modelRouterConfig');
    if (require.cache[modulePath]) {
      const { stopPinCacheRefresh } = require.cache[modulePath].exports || {};
      if (typeof stopPinCacheRefresh === 'function') {
        await stopPinCacheRefresh();
      }
    }
  } catch {
    // ignore
  }

  const state = getTestDbState();
  if (DISCONNECT_IDLE_MS > 0) {
    scheduleDisconnect(state);
    return;
  }

  clearPendingDisconnect(state);
  await disconnectTestResources(state);
});

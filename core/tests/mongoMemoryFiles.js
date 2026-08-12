const fs = require('fs');
const path = require('path');

const STATE_ROOT = path.join(__dirname, '.jest-mongo');
const LEGACY_JSON_FILE = path.join(__dirname, '.jest-mongo.json');
const LEGACY_URI_FILE = path.join(__dirname, '.jest-mongo-uri');

function sanitizeRunId(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getMongoRunId() {
  return sanitizeRunId(process.env.JEST_MONGO_RUN_ID || 'default');
}

function ensureMongoRunId() {
  if (!process.env.JEST_MONGO_RUN_ID) {
    process.env.JEST_MONGO_RUN_ID = `${process.pid}-${Date.now()}`;
  }

  return getMongoRunId();
}

function getMongoFiles(runId = getMongoRunId()) {
  const stateDir = path.join(STATE_ROOT, sanitizeRunId(runId));

  return {
    runId: sanitizeRunId(runId),
    stateDir,
    jsonFile: process.env.JEST_MONGO_JSON_FILE || path.join(stateDir, 'state.json'),
    uriFile: process.env.JEST_MONGO_URI_FILE || path.join(stateDir, 'uri')
  };
}

function prepareMongoFiles(runId = ensureMongoRunId()) {
  const stateDir = path.join(STATE_ROOT, sanitizeRunId(runId));
  const files = {
    runId: sanitizeRunId(runId),
    stateDir,
    jsonFile: path.join(stateDir, 'state.json'),
    uriFile: path.join(stateDir, 'uri')
  };

  process.env.JEST_MONGO_JSON_FILE = files.jsonFile;
  process.env.JEST_MONGO_URI_FILE = files.uriFile;
  fs.mkdirSync(files.stateDir, { recursive: true });

  return files;
}

function listMongoStateFiles() {
  const files = [];

  if (fs.existsSync(STATE_ROOT)) {
    for (const entry of fs.readdirSync(STATE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      files.push({
        stateDir: path.join(STATE_ROOT, entry.name),
        jsonFile: path.join(STATE_ROOT, entry.name, 'state.json'),
        uriFile: path.join(STATE_ROOT, entry.name, 'uri')
      });
    }
  }

  files.push({
    stateDir: __dirname,
    jsonFile: LEGACY_JSON_FILE,
    uriFile: LEGACY_URI_FILE,
    legacy: true
  });

  return files;
}

function removeMongoFiles(files) {
  try { fs.unlinkSync(files.jsonFile); } catch { /* ignore */ }
  try { fs.unlinkSync(files.uriFile); } catch { /* ignore */ }

  if (!files.legacy) {
    try { fs.rmdirSync(files.stateDir); } catch { /* ignore */ }
  }
}

module.exports = {
  LEGACY_JSON_FILE,
  LEGACY_URI_FILE,
  STATE_ROOT,
  ensureMongoRunId,
  getMongoFiles,
  listMongoStateFiles,
  prepareMongoFiles,
  removeMongoFiles
};

'use strict';
const fs = require('fs');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { destroyAgents } = require('../src/helpers/httpAgent');
const { getMongoFiles } = require('./mongoMemoryFiles');
const { suiteDatabase, withDatabase } = require('../../shared/testing/mongoIdentity');
process.env.NODE_ENV = 'test';
process.env.AGENTX_PROFILE ||= 'full';
process.env.OLLAMA_HOST ||= 'http://127.0.0.1:11434';
if (!process.env.OLLAMA_HOST_SECONDARY && !process.env.OLLAMA_HOST_2) process.env.OLLAMA_HOST_SECONDARY = 'http://127.0.0.1:11435';
process.env.EMBEDDING_MODEL ||= 'nomic-embed-text:v1.5';
process.env.EMBEDDING_DIMENSION ||= '768';
const database = suiteDatabase(expect.getState().testPath);
const external = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
const baseUri = external ? process.env.MONGODB_URI_TEST : fs.readFileSync(getMongoFiles().uriFile, 'utf8').trim();
const uri = withDatabase(baseUri, database);
// Set all existing test aliases to the same owned database before modules load.
process.env.MONGODB_URI = uri;
process.env.MONGODB_URI_TEST = uri;
process.env.MONGODB_TEST_URI = uri;
mongoose.set('bufferCommands', false);
beforeAll(async () => {
  try {
    await connectDB();
    await mongoose.connection.db.admin().ping();
  } catch (err) {
    throw new Error(`Test Mongo setup failed (run=${process.env.JEST_MONGO_RUN_ID}, db=${database}): ${err.message}`, { cause: err });
  }
}, 30000);
afterAll(async () => {
  try {
    const modulePath = require.resolve('../src/services/modelRouterConfig');
    const stop = require.cache[modulePath]?.exports?.stopPinCacheRefresh;
    if (typeof stop === 'function') await stop();
  } finally {
    destroyAgents();
    await mongoose.disconnect();
  }
});

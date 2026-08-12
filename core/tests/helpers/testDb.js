/**
 * Shared test database helper
 * Provides consistent MongoDB setup for all integration tests
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const logger = require('../../config/logger');

let mongoServer;

/**
 * Connect to in-memory MongoDB for testing
 * Safe to call multiple times (no-op if already connected to test DB)
 */
async function connectTestDb() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  try {
    const sharedUri = process.env.MONGODB_URI;
    const uri = sharedUri || await (async () => {
      mongoServer = await MongoMemoryServer.create();
      return mongoServer.getUri();
    })();

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10
    });

    logger.debug('Test DB connected', { uri });
  } catch (err) {
    logger.error('Test DB connection failed', { error: err.message });
    throw err;
  }
}

/**
 * Disconnect and stop MongoDB server
 */
async function disconnectTestDb() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    if (mongoServer) {
      await mongoServer.stop();
      mongoServer = null;
    }

    logger.debug('Test DB disconnected');
  } catch (err) {
    logger.error('Test DB disconnect failed', { error: err.message });
    throw err;
  }
}

/**
 * Clear all collections in test database
 * Useful for test isolation between test cases
 */
async function clearTestDb() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Cannot clear database: Not connected');
  }

  const collections = mongoose.connection.collections;

  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
}

module.exports = {
  connectTestDb,
  disconnectTestDb,
  clearTestDb
};

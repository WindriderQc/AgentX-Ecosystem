/**
 * Database Helper for Tests
 * Ensures MongoDB connection is ready before queries
 */

const mongoose = require('mongoose');

/**
 * Wait for MongoDB connection to be ready
 * @param {number} timeoutMs - Max time to wait (default: 30000ms)
 * @returns {Promise<void>}
 */
async function waitForConnection(timeoutMs = 30000) {
  const startTime = Date.now();

  while (mongoose.connection.readyState !== 1) { // 1 = connected
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`MongoDB connection timeout after ${timeoutMs}ms`);
    }

    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Additional check: ensure we can ping the database
  try {
    await mongoose.connection.db.admin().ping();
  } catch (err) {
    throw new Error(`MongoDB ping failed: ${err.message}`);
  }
}

/**
 * Ensure connection is ready before executing operation
 * Wrapper for test operations that query the database
 * @param {Function} operation - Async function to execute
 * @returns {Promise<any>}
 */
async function withConnection(operation) {
  await waitForConnection();
  return operation();
}

/**
 * Check if MongoDB is connected
 * @returns {boolean}
 */
function isConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Get connection state as string
 * @returns {string}
 */
function getConnectionState() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  return states[mongoose.connection.readyState] || 'unknown';
}

module.exports = {
  waitForConnection,
  withConnection,
  isConnected,
  getConnectionState
};

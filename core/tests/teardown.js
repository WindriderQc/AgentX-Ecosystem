/**
 * Global test teardown
 * Closes all database connections after tests complete
 */

const mongoose = require('mongoose');

module.exports = async () => {
  // Close all mongoose connections
  await mongoose.disconnect();

  // Close all remaining MongoDB connections (session store)
  const { MongoClient } = require('mongodb');
  // Force close any lingering connections
  if (global.gc) {
    global.gc();
  }

  // Give a moment for cleanup
  await new Promise(resolve => setTimeout(resolve, 500));
};

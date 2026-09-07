'use strict';
// Bound connection growth across independent test files and agent executions.
// A dead socket must fail within the test's infrastructure deadline.
module.exports = Object.freeze({
  maxPoolSize: 2,
  minPoolSize: 0,
  maxConnecting: 1,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10000,
  family: 4
});

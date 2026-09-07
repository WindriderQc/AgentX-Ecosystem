'use strict';
const { createHash, randomUUID } = require('crypto');
function runId() { return process.env.JEST_MONGO_RUN_ID ||= randomUUID(); }
function suiteDatabase(testPath) {
  return `agentx_test_${createHash('sha256').update(`${runId()}:${testPath}`).digest('hex').slice(0, 24)}`;
}
function withDatabase(uri, database) {
  const match = (uri || '').match(/^(mongodb(?:\+srv)?:\/\/[^/ ?]+)(?:\/[^?]*)?(\?.*)?$/);
  if (!match) throw new Error('An explicit valid MongoDB test URI is required');
  return `${match[1]}/${database}${match[2] || ''}`;
}
module.exports = { runId, suiteDatabase, withDatabase };

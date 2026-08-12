const { findConnectablePort } = require('./helpers/localTcpPort');

const DEFAULT_MONGO_PORT_START = 37018;
const DEFAULT_MONGO_PORT_END = 37117;

function readPortEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

function getMongoPortRange() {
  const start = readPortEnv('JEST_MONGO_PORT_START', DEFAULT_MONGO_PORT_START);
  const end = readPortEnv('JEST_MONGO_PORT_END', DEFAULT_MONGO_PORT_END);

  if (end < start) {
    throw new Error(`Invalid JEST_MONGO_PORT range: ${start}-${end}`);
  }

  return { start, end };
}

async function pickMongoMemoryPort() {
  return findConnectablePort(getMongoPortRange());
}

module.exports = {
  DEFAULT_MONGO_PORT_END,
  DEFAULT_MONGO_PORT_START,
  getMongoPortRange,
  pickMongoMemoryPort
};

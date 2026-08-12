const path = require('path');
const dotenv = require('dotenv');

process.env.NODE_ENV = 'test';

// Pin MongoMemoryServer to 7.0.24 — the 8.2.1 binary seg-faults on this host.
// Must be set before MongoMemoryServer is first imported.
process.env.MONGOMS_VERSION = '7.0.24';

dotenv.config({
  path: path.join(__dirname, '..', '..', '.env')
});

function deriveTestMongoUri(mongoUri) {
  try {
    const parsed = new URL(mongoUri);
    parsed.pathname = '/agentx_test';
    return parsed.toString();
  } catch (_err) {
    return null;
  }
}

// Integration suites call config/db directly, without importing server.js.
// Load the service .env here and keep test writes out of the live app DB.
if (!process.env.MONGODB_URI_TEST && process.env.MONGODB_URI) {
  const testUri = deriveTestMongoUri(process.env.MONGODB_URI);
  if (testUri) {
    process.env.MONGODB_URI_TEST = testUri;
  }
}

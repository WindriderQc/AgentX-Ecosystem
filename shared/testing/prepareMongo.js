'use strict';
process.env.MONGOMS_VERSION ||= '7.0.24';
const { MongoMemoryServer } = require(require.resolve('mongodb-memory-server', { paths: [process.cwd()] }));
(async () => {
  const mongo = await MongoMemoryServer.create({ spawn: { windowsHide: true } });
  try { console.log(`MongoDB ${process.env.MONGOMS_VERSION} prepared and started successfully`); }
  finally { await mongo.stop(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });

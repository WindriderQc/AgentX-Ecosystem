'use strict';
const fs = require('fs');
const { getMongoFiles, removeMongoFiles } = require('./mongoMemoryFiles');
const { terminateProcessTree, processExists, sleep } = require('./mongoMemoryProcess');
module.exports = async () => {
  if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') return;
  const files = global.__AGENTX_JEST_MONGO_FILES || getMongoFiles();
  if (fs.existsSync(files.jsonFile)) {
    const state = JSON.parse(fs.readFileSync(files.jsonFile, 'utf8'));
    if (state.runId !== files.runId) throw new Error('Refusing to stop a Mongo daemon owned by another run');
    if (state.pid) {
      fs.writeFileSync(`${files.jsonFile}.stop`, 'stop');
      const deadline = Date.now() + 5000;
      while (processExists(state.pid) && Date.now() < deadline) await sleep(100);
      await terminateProcessTree(state.pid);
    }
  }
  removeMongoFiles(files);
};

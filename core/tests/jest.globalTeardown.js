const fs = require('fs');
const mongoose = require('mongoose');
const { getMongoFiles, removeMongoFiles } = require('./mongoMemoryFiles');
const { terminateProcessTree } = require('./mongoMemoryProcess');

module.exports = async () => {
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }

  try {
    const files = global.__AGENTX_JEST_MONGO_FILES || getMongoFiles();
    if (fs.existsSync(files.jsonFile)) {
      const raw = fs.readFileSync(files.jsonFile, 'utf8');
      const parsed = JSON.parse(raw);
      const pid = parsed?.pid;
      if (pid) {
        await terminateProcessTree(pid);
      }
    }
  } catch {
    // ignore
  } finally {
    removeMongoFiles(global.__AGENTX_JEST_MONGO_FILES || getMongoFiles());
  }

  if (global.gc) {
    global.gc();
  }

  await new Promise(resolve => setTimeout(resolve, 250));
};

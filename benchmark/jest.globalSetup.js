// Sweep orphaned mongodb-memory-server dbPath folders (mongo-mem-*) left in the
// OS temp dir by hard-killed runs. Benchmark has no daemon; each test file
// spawns its own MongoMemoryServer, so a killed run leaks a ~300 MB dbPath per
// suite. Reuses core's sweeper (monorepo already cross-references core from
// benchmark, e.g. the shared ../core/views templates). Active dbPaths (locked)
// and recent ones are skipped — see core/tests/mongoMemoryTmpSweeper.js.
const { sweepStaleMongoTmpDirs } = require('../core/tests/mongoMemoryTmpSweeper');

module.exports = async () => {
  try {
    const swept = sweepStaleMongoTmpDirs();
    if (swept.removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`Swept ${swept.removed} stale mongo-mem-* temp dir(s) before test run.`);
    }
  } catch {
    // Best-effort cleanup; never block the test run on it.
  }
};

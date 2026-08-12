const fs = require('fs');
const os = require('os');
const path = require('path');

// mongodb-memory-server creates its dbPath under the OS temp dir as
// `mongo-mem-XXXXXX`. On a graceful shutdown `mongod.stop()` removes it, but
// when Jest is killed hard (--forceExit, Ctrl-C, a crashed/timed-out run, CI
// teardown) the mongod child is terminated before cleanup runs and WiredTiger's
// ~300 MB journal dbPath is orphaned. Nothing ever swept those, so they piled
// up in Temp. This sweeps them before each run.
//
// Safety: a live mongod holds `mongod.lock` / `WiredTiger.wt` open, so on
// Windows `fs.rmSync` throws (EBUSY/EPERM) and we skip that folder — a
// concurrently running test suite's active dbPath is never removed. An age
// guard adds a second layer so a folder younger than the window is left alone
// even if the lock check would have passed.

const TMP_DIR_PREFIX = 'mongo-mem-';

function getSweepMinAgeMs() {
  const configured = Number(process.env.JEST_MONGO_TMP_SWEEP_MIN_AGE_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  // Default: only sweep folders untouched for 30 min, comfortably longer than a
  // normal suite run, so an in-flight concurrent run is doubly protected.
  return 30 * 60 * 1000;
}

function sweepStaleMongoTmpDirs({ tmpDir = os.tmpdir(), minAgeMs = getSweepMinAgeMs(), now = Date.now() } = {}) {
  const summary = { removed: 0, skippedActive: 0, skippedRecent: 0 };

  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return summary;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TMP_DIR_PREFIX)) continue;

    const dir = path.join(tmpDir, entry.name);

    if (minAgeMs > 0) {
      try {
        const { mtimeMs } = fs.statSync(dir);
        if (now - mtimeMs < minAgeMs) {
          summary.skippedRecent += 1;
          continue;
        }
      } catch {
        // Vanished under us or unreadable — nothing to sweep.
        continue;
      }
    }

    try {
      // Non-recursive rmdir first: an orphaned dbPath with an open lock file
      // fails here on Windows, so a live mongod is never nuked. rmSync recursive
      // then clears the (now confirmed idle) folder.
      fs.rmSync(dir, { recursive: true, force: false });
      summary.removed += 1;
    } catch {
      // In use by a live mongod (locked files) or a concurrent sweeper won the
      // race — leave it alone.
      summary.skippedActive += 1;
    }
  }

  return summary;
}

module.exports = { sweepStaleMongoTmpDirs, TMP_DIR_PREFIX };

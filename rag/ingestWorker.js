const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});

const mongoose = require('mongoose');

const connectDB = require('./config/db');
const logger = require('./config/logger');
const { runIngestScan } = require('./src/services/ingestWorker');

function getArgValue(flag) {
  const matched = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return matched ? matched.slice(flag.length + 1) : undefined;
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.error('Usage: node ingestWorker.js --run [--limit=25]');
    process.exit(1);
  }

  await connectDB();

  const limit = Number(getArgValue('--limit') || 0);
  const summary = await runIngestScan({ limit: limit > 0 ? limit : undefined });

  console.log(JSON.stringify({
    ok: true,
    data: {
      totalCandidates: summary.totalCandidates,
      processed: summary.processed,
      ingested: summary.ingested,
      updated: summary.updated,
      unchanged: summary.unchanged,
      skipped: summary.skipped,
      failed: summary.failed
    }
  }, null, 2));

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.error('Ingest worker failed', { error: error.message, stack: error.stack });
    try {
      await mongoose.disconnect();
    } catch (_disconnectError) {
      // Ignore disconnect failures during shutdown.
    }
    process.exit(1);
  });
}

module.exports = { main };

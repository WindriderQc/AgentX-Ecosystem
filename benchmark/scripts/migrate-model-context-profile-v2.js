#!/usr/bin/env node
'use strict';

/**
 * Additive, lossless ModelContextProfile v2 backfill.
 *
 * Current runtime ceilings remain readable through verifiedMaxContext while
 * the new fields separate current verification, historical maximum and
 * workload recommendations. Use --dry-run to inspect counts only.
 */
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');

function migrationPipeline() {
  return [{
    $set: {
      maxVerifiedContext: { $ifNull: ['$maxVerifiedContext', '$verifiedMaxContext'] },
      historicalMaxVerifiedContext: { $ifNull: ['$historicalMaxVerifiedContext', { $ifNull: ['$verifiedMaxContext', '$recommendedContext'] }] },
      // Legacy `recommendedContext` was historically the largest request that
      // happened to succeed, not a workload recommendation. Preserve it only
      // as capacity history; recommendations stay unknown until re-profiled.
      recommendedInteractiveContext: null,
      recommendedDocumentContext: null,
      recommendedContext: null,
      recommendationStatus: 'unknown',
      revalidationRequired: true,
      stale: true,
      staleReason: 'legacy_context_revalidation_required',
      recommendationThresholds: {
        $ifNull: ['$recommendationThresholds', {
          interactiveDegradationPct: 15,
          documentDegradationPct: 30
        }]
      }
    }
  }];
}

async function migrate() {
  await mongoose.connect(MONGO_URI);
  const collection = mongoose.connection.collection('modelcontextprofiles');
  const filter = { $or: [
    { maxVerifiedContext: { $exists: false } },
    { historicalMaxVerifiedContext: { $exists: false } },
    { recommendedInteractiveContext: { $exists: false } },
    { recommendedDocumentContext: { $exists: false } },
    { recommendationStatus: { $exists: false } },
    { revalidationRequired: { $exists: false } }
  ] };
  const matched = await collection.countDocuments(filter);
  if (DRY_RUN) return { dryRun: true, matched, modified: 0 };
  const result = await collection.updateMany(filter, migrationPipeline());
  return { dryRun: false, matched, modified: result.modifiedCount };
}

if (require.main === module) {
  migrate()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { migrate, migrationPipeline };

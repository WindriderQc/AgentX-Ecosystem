#!/usr/bin/env node
'use strict';

/**
 * Retire profile state that predates exact artifact identity and install the
 * exact-evidence indexes. Legacy adaptation documents are removed only when
 * the operator supplies --purge-legacy-adaptations.
 *
 * Usage:
 *   node scripts/migrate-exact-artifact-profile-indexes.js --dry-run
 *   node scripts/migrate-exact-artifact-profile-indexes.js
 *   node scripts/migrate-exact-artifact-profile-indexes.js --purge-legacy-adaptations
 */
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');
const PURGE_LEGACY_ADAPTATIONS = process.argv.includes('--purge-legacy-adaptations');
const LEGACY_CONTEXT_INDEX = 'model_context_profile_model_host_unique';
const EXACT_CONTEXT_INDEX = 'exact_model_context_profile_unique';
const EXACT_PERFORMANCE_INDEX = 'exact_model_host_runtime_profile_unique';
const LEGACY_REASON = 'legacy_profile_without_exact_artifact_identity';

function hasExactArtifact(artifact) {
  return Boolean(
    artifact?.model
    && artifact?.hostId
    && artifact?.hostUrl
    && artifact?.digest
    && artifact?.runtimeFingerprint
    && artifact?.registryQualified === true
  );
}

function retireLegacyReadiness(readiness = {}) {
  let changed = false;
  const next = {};
  for (const [hostId, raw] of Object.entries(readiness || {})) {
    const entry = raw && typeof raw === 'object' ? { ...raw } : {};
    if (!hasExactArtifact(entry.artifact)) {
      changed = true;
      entry.stage = entry.stage === 'available' ? 'available' : 'profiled';
      entry.profileDepth = null;
      entry.benchmarkQualified = false;
      entry.stale = true;
      entry.staleReason = LEGACY_REASON;
      delete entry.adaptedAt;
    }
    next[hostId] = entry;
  }
  return { changed, readiness: next };
}

async function collectionExists(name) {
  const rows = await mongoose.connection.db.listCollections({ name }, { nameOnly: true }).toArray();
  return rows.length > 0;
}

async function migrate() {
  await mongoose.connect(MONGO_URI);
  const contextProfiles = mongoose.connection.collection('modelcontextprofiles');
  const modelProfiles = mongoose.connection.collection('modelprofiles');
  const performanceProfiles = mongoose.connection.collection('modelperformanceprofiles');
  const legacyContextFilter = {
    $or: [
      { artifactDigest: { $exists: false } },
      { artifactDigest: null },
      { runtimeFingerprint: { $exists: false } },
      { runtimeFingerprint: null }
    ]
  };
  const contextCollectionExists = await collectionExists('modelcontextprofiles');
  const legacyContextRows = contextCollectionExists
    ? await contextProfiles.countDocuments(legacyContextFilter)
    : 0;
  const contextIndexes = contextCollectionExists ? await contextProfiles.indexes() : [];
  const hasLegacyContextIndex = contextIndexes.some((index) => index.name === LEGACY_CONTEXT_INDEX);

  const readinessUpdates = [];
  const profileDocs = await modelProfiles.find(
    { readiness: { $exists: true } },
    { projection: { readiness: 1 } }
  ).toArray();
  let legacyReadinessEntries = 0;
  for (const doc of profileDocs) {
    const retired = retireLegacyReadiness(doc.readiness);
    if (!retired.changed) continue;
    legacyReadinessEntries += Object.values(doc.readiness || {})
      .filter((entry) => !hasExactArtifact(entry?.artifact)).length;
    readinessUpdates.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { readiness: retired.readiness } }
      }
    });
  }

  const legacyAdaptationCollectionExists = await collectionExists('modeladaptations');
  const legacyAdaptationRows = legacyAdaptationCollectionExists
    ? await mongoose.connection.collection('modeladaptations').countDocuments({})
    : 0;

  const summary = {
    dryRun: DRY_RUN,
    legacyContextRows,
    legacyReadinessEntries,
    legacyAdaptationRows,
    dropLegacyContextIndex: hasLegacyContextIndex ? LEGACY_CONTEXT_INDEX : null,
    createIndexes: [EXACT_CONTEXT_INDEX, EXACT_PERFORMANCE_INDEX],
    purgeLegacyAdaptations: PURGE_LEGACY_ADAPTATIONS
  };
  if (DRY_RUN) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (legacyContextRows) {
    await contextProfiles.updateMany(legacyContextFilter, {
      $set: { stale: true, staleReason: LEGACY_REASON }
    });
  }
  if (readinessUpdates.length) await modelProfiles.bulkWrite(readinessUpdates, { ordered: false });
  if (hasLegacyContextIndex) await contextProfiles.dropIndex(LEGACY_CONTEXT_INDEX);
  await contextProfiles.createIndex(
    { modelName: 1, hostUrl: 1, artifactDigest: 1, runtimeFingerprint: 1 },
    { unique: true, name: EXACT_CONTEXT_INDEX }
  );
  await performanceProfiles.createIndex(
    { modelName: 1, hostId: 1, 'artifact.digest': 1, 'artifact.runtimeFingerprint': 1 },
    { unique: true, name: EXACT_PERFORMANCE_INDEX }
  );

  if (PURGE_LEGACY_ADAPTATIONS && legacyAdaptationCollectionExists) {
    await mongoose.connection.collection('modeladaptations').drop();
  }

  console.log(JSON.stringify({
    ...summary,
    dryRun: false,
    legacyContextRowsMarkedStale: legacyContextRows,
    legacyReadinessEntriesRetired: legacyReadinessEntries,
    legacyAdaptationRowsPurged: PURGE_LEGACY_ADAPTATIONS ? legacyAdaptationRows : 0
  }, null, 2));
}

if (require.main === module) {
  migrate()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect());
}

module.exports = { hasExactArtifact, migrate, retireLegacyReadiness };

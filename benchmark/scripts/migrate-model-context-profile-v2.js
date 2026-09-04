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
const RECOMMENDATION_EVIDENCE_VERSION = 'context-probe-degradation-v3';
const LEGACY_EVIDENCE_VERSION = 'legacy-unverified';

function migrationPipeline() {
  const hasVerifiedCurrentRecommendations = {
    $and: [
      { $eq: ['$recommendationStatus', 'verified'] },
      { $eq: ['$recommendationEvidenceVersion', RECOMMENDATION_EVIDENCE_VERSION] },
      { $ne: ['$revalidationRequired', true] },
      { $ne: ['$stale', true] },
      { $gt: ['$recommendedInteractiveContext', 0] },
      { $gt: ['$recommendedDocumentContext', 0] }
    ]
  };
  return [{
    $set: {
      maxVerifiedContext: { $ifNull: ['$maxVerifiedContext', '$verifiedMaxContext'] },
      historicalMaxVerifiedContext: {
        $ifNull: [
          '$historicalMaxVerifiedContext',
          { $ifNull: ['$maxVerifiedContext', { $ifNull: ['$verifiedMaxContext', '$recommendedContext'] }] }
        ]
      },
      // Legacy `recommendedContext` was historically the largest request that
      // happened to succeed, not a workload recommendation. Preserve it only
      // as capacity history; recommendations stay unknown until re-profiled.
      recommendedInteractiveContext: {
        $cond: [hasVerifiedCurrentRecommendations, '$recommendedInteractiveContext', null]
      },
      recommendedDocumentContext: {
        $cond: [hasVerifiedCurrentRecommendations, '$recommendedDocumentContext', null]
      },
      recommendedContext: {
        $cond: [
          hasVerifiedCurrentRecommendations,
          { $ifNull: ['$recommendedContext', '$recommendedDocumentContext'] },
          null
        ]
      },
      recommendationStatus: { $cond: [hasVerifiedCurrentRecommendations, 'verified', 'unknown'] },
      recommendationEvidenceVersion: {
        $cond: [hasVerifiedCurrentRecommendations, RECOMMENDATION_EVIDENCE_VERSION, LEGACY_EVIDENCE_VERSION]
      },
      revalidationRequired: { $cond: [hasVerifiedCurrentRecommendations, false, true] },
      stale: { $cond: [hasVerifiedCurrentRecommendations, { $ifNull: ['$stale', false] }, true] },
      staleReason: {
        $cond: [
          hasVerifiedCurrentRecommendations,
          { $ifNull: ['$staleReason', null] },
          'legacy_context_revalidation_required'
        ]
      },
      recommendationThresholds: {
        $mergeObjects: [{
          interactiveDegradationPct: 15,
          documentDegradationPct: 30,
          performanceKneeDegradationPct: 15
        }, { $ifNull: ['$recommendationThresholds', {}] }]
      },
      performanceKneeContext: { $ifNull: ['$performanceKneeContext', null] },
      performanceKneeDegradationPct: { $ifNull: ['$performanceKneeDegradationPct', 15] },
      qualityVerifiedContext: { $ifNull: ['$qualityVerifiedContext', null] },
      qualityContextStatus: {
        $cond: [
          { $and: [{ $eq: ['$qualityContextStatus', 'verified'] }, { $gt: ['$qualityVerifiedContext', 0] }] },
          'verified',
          'unknown'
        ]
      }
    }
  }];
}

async function migrate() {
  await mongoose.connect(MONGO_URI);
  const collection = mongoose.connection.collection('modelcontextprofiles');
  const filter = migrationFilter();
  const matched = await collection.countDocuments(filter);
  if (DRY_RUN) return { dryRun: true, matched, modified: 0 };
  const result = await collection.updateMany(filter, migrationPipeline());
  return { dryRun: false, matched, modified: result.modifiedCount };
}

function migrationFilter() {
  return { $or: [
    { maxVerifiedContext: { $exists: false } },
    { historicalMaxVerifiedContext: { $exists: false } },
    { recommendedInteractiveContext: { $exists: false } },
    { recommendedDocumentContext: { $exists: false } },
    { recommendationStatus: { $exists: false } },
    { performanceKneeContext: { $exists: false } },
    { qualityContextStatus: { $exists: false } },
    { revalidationRequired: { $exists: false } },
    { recommendationEvidenceVersion: { $nin: [RECOMMENDATION_EVIDENCE_VERSION, LEGACY_EVIDENCE_VERSION] } }
  ] };
}

if (require.main === module) {
  migrate()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { migrate, migrationFilter, migrationPipeline };

'use strict';

const crypto = require('crypto');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');

async function saveProfile({ modelName, hostId, artifact, profile }, options = {}) {
  const authorityWriteId = crypto.randomUUID();
  const identity = {
    modelName,
    hostId,
    'artifact.digest': artifact.digest,
    'artifact.runtimeFingerprint': artifact.runtimeFingerprint
  };
  let writeStarted = false;
  try {
    options.assertAuthorityActive?.();
    writeStarted = true;
    const saved = await ModelPerformanceProfile.findOneAndUpdate(
      identity,
      { $set: { artifact, profile, authorityWriteId, active: true, stale: false, staleReason: null } },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        ...(options.signal ? { signal: options.signal } : {})
      }
    );
    options.assertAuthorityActive?.();
    return saved;
  } catch (error) {
    if (writeStarted) {
      try {
        await ModelPerformanceProfile.updateOne(
          { ...identity, authorityWriteId },
          { $set: { active: false, stale: true, staleReason: 'profiler_authority_write_failed' } }
        );
      } catch (compensationError) {
        error.compensationError = compensationError;
        error.authorityInvalidationFailed = true;
        error.code = error.code || 'PROFILER_AUTHORITY_INVALIDATION_FAILED';
      }
    }
    throw error;
  }
}

async function retireSupersededProfiles({ modelName, hostId, evidenceId, assertAuthorityActive, signal }) {
  assertAuthorityActive?.();
  const filter = { _id: { $ne: evidenceId }, modelName, hostId, active: true };
  const update = { $set: { active: false, stale: true, staleReason: 'superseded' } };
  if (signal) await ModelPerformanceProfile.updateMany(filter, update, { signal });
  else await ModelPerformanceProfile.updateMany(filter, update);
  assertAuthorityActive?.();
}

async function getActiveProfile(modelName, hostId) {
  return ModelPerformanceProfile.findOne({ modelName, hostId, active: true, stale: { $ne: true } })
    .sort({ updatedAt: -1 })
    .lean();
}

async function getRoster(filter = {}) {
  // The roster is a current-view projection, not an audit-history endpoint.
  // A stale active row must never be merged back into the UI after reload.
  const query = { active: true, stale: { $ne: true } };
  if (filter.hostId) query.hostId = filter.hostId;
  if (filter.modelName) query.modelName = filter.modelName;
  return ModelPerformanceProfile.find(query).sort({ updatedAt: -1 }).lean();
}

async function invalidateProfile(evidenceId, reason = 'authority_write_failed') {
  if (!evidenceId) return { modifiedCount: 0 };
  return ModelPerformanceProfile.updateOne(
    { _id: evidenceId },
    { $set: { active: false, stale: true, staleReason: reason } }
  );
}

module.exports = {
  getActiveProfile,
  getRoster,
  invalidateProfile,
  retireSupersededProfiles,
  saveProfile
};

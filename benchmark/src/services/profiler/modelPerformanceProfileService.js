'use strict';

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');

async function saveProfile({ modelName, hostId, artifact, profile }, options = {}) {
  options.assertAuthorityActive?.();
  const saved = await ModelPerformanceProfile.findOneAndUpdate(
    {
      modelName,
      hostId,
      'artifact.digest': artifact.digest,
      'artifact.runtimeFingerprint': artifact.runtimeFingerprint
    },
    { $set: { artifact, profile, active: true, stale: false, staleReason: null } },
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
  const query = { active: true };
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

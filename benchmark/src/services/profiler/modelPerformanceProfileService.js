'use strict';

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');

async function saveProfile({ modelName, hostId, artifact, profile }) {
  const saved = await ModelPerformanceProfile.findOneAndUpdate(
    {
      modelName,
      hostId,
      'artifact.digest': artifact.digest,
      'artifact.runtimeFingerprint': artifact.runtimeFingerprint
    },
    { $set: { artifact, profile, active: true, stale: false, staleReason: null } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
  await ModelPerformanceProfile.updateMany(
    { _id: { $ne: saved._id }, modelName, hostId, active: true },
    { $set: { active: false, stale: true, staleReason: 'superseded' } }
  );
  return saved;
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

module.exports = { getActiveProfile, getRoster, saveProfile };

const ModelProfile = require('../../../models/ModelProfile');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { parseAdaptedName } = require('./namingConvention');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

function normalizeBenchmarkModelName(name) {
  const normalized = normalizeModelName(name);
  return parseAdaptedName(normalized)?.baseName || normalized;
}

async function getAll(filter = {}) {
  if (filter.stage) {
    const docs = await ModelProfile.find().lean();
    return docs.filter(doc => {
      if (!doc.readiness) return false;
      const readinessMap = doc.readiness instanceof Map
        ? Object.fromEntries(doc.readiness)
        : doc.readiness;
      return Object.values(readinessMap).some(r => r.stage === filter.stage);
    });
  }
  return ModelProfile.find().lean();
}

async function getByName(name) {
  return ModelProfile.findOne({ name }).lean();
}

async function upsert(data) {
  return ModelProfile.findOneAndUpdate(
    { name: data.name },
    data,
    { upsert: true, new: true, runValidators: true }
  );
}

async function updateReadiness(modelName, hostId, stage, extraFields = {}) {
  const setFields = { [`readiness.${hostId}.stage`]: stage };
  if (stage === 'profiled') setFields[`readiness.${hostId}.profiledAt`] = new Date();
  if (stage === 'adapted') setFields[`readiness.${hostId}.adaptedAt`] = new Date();
  if (stage === 'benchmarked') setFields[`readiness.${hostId}.benchmarkedAt`] = new Date();
  Object.assign(setFields, extraFields);
  return ModelProfile.findOneAndUpdate(
    { name: modelName },
    { $set: setFields },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

async function updateThinkingCapability(modelName, hostId, thinkingProfile = {}) {
  const policy = thinkingProfile.recommendedPolicy || 'unknown';
  const supported = !!thinkingProfile.supported;
  const profiledAt = thinkingProfile.profiledAt || new Date();
  const capability = {
    profileVersion: thinkingProfile.profileVersion ?? null,
    profiledAt,
    hostId,
    probeCount: thinkingProfile.probeCount ?? null,
    probeAttempts: thinkingProfile.probeAttempts ?? null,
    retryProbeCount: thinkingProfile.retryProbeCount ?? null,
    maxProbeNumPredict: thinkingProfile.maxProbeNumPredict ?? null,
    defaultProbeNumPredict: thinkingProfile.defaultProbeNumPredict ?? null,
    supported,
    supportSignals: Array.isArray(thinkingProfile.supportSignals) ? thinkingProfile.supportSignals : [],
    channel: thinkingProfile.channel || 'unknown',
    visibleFinalAnswerOk: !!thinkingProfile.visibleFinalAnswerOk,
    finalAnswerContractOk: !!thinkingProfile.finalAnswerContractOk,
    thinkingOnlyResponse: !!thinkingProfile.thinkingOnlyResponse,
    runawayRisk: !!thinkingProfile.runawayRisk,
    contractSensitive: !!thinkingProfile.contractSensitive,
    contractlessVisibleAnswerOk: !!thinkingProfile.contractlessVisibleAnswerOk,
    stressVisibleAnswerOk: !!thinkingProfile.stressVisibleAnswerOk,
    tokenMultiplier: thinkingProfile.tokenMultiplier ?? null,
    latencyMultiplier: thinkingProfile.latencyMultiplier ?? null,
    recommendedPolicy: policy,
    recommendationReason: thinkingProfile.recommendationReason || null
  };

  return ModelProfile.findOneAndUpdate(
    { name: modelName },
    {
      $set: {
        'capabilities.thinking': supported,
        'capabilities.thinkingPolicy': policy,
        [`thinkingProfiles.${hostId}`]: capability
      }
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

async function updateHostAvailability(modelName, hostId, available) {
  return ModelProfile.findOneAndUpdate(
    { name: modelName },
    {
      $set: {
        [`hosts.${hostId}.available`]: available,
        [`hosts.${hostId}.lastSeen`]: available ? new Date() : undefined
      }
    },
    { new: true }
  );
}

async function getStalenessReport() {
  return ModelAdaptation.find({ 'staleness.stale': true }).lean();
}

async function getReadinessFunnel() {
  const profiles = await ModelProfile.find().lean();
  const counts = { available: 0, profiled: 0, adapted: 0, benchmarked: 0 };
  for (const profile of profiles) {
    const readinessMap = profile.readiness instanceof Map
      ? Object.fromEntries(profile.readiness)
      : (profile.readiness || {});
    const stages = Object.values(readinessMap).map(r => r.stage);
    const highest = ['benchmarked', 'adapted', 'profiled', 'available']
      .find(s => stages.includes(s)) || 'available';
    counts[highest]++;
  }
  return counts;
}

async function getBenchmarkedModelNames() {
  const names = await BenchmarkResult.distinct('model', { success: true });
  return [...new Set(names.map(normalizeBenchmarkModelName).filter(Boolean))].sort();
}

module.exports = {
  getAll,
  getByName,
  upsert,
  updateReadiness,
  updateThinkingCapability,
  updateHostAvailability,
  getStalenessReport,
  getReadinessFunnel,
  getBenchmarkedModelNames
};

/**
 * ModelRegistry Query Helpers
 *
 * Extracted from ModelRegistry.js statics to keep the schema file lean.
 * Each function uses a lazy getter for the Model to avoid circular requires
 * (ModelRegistry.js requires this file for delegation stubs).
 *
 * @see /models/ModelRegistry.js
 */

// Lazy-require to break circular dependency (ModelRegistry.js → this file → ModelRegistry.js)
let _ModelRegistry;
function getModel() {
  if (!_ModelRegistry) _ModelRegistry = require('../../models/ModelRegistry');
  return _ModelRegistry;
}

/**
 * Get all active models
 */
async function getActive(filters = {}) {
  return getModel().find({
    isActive: true,
    status: 'active',
    ...filters
  })
  .sort({ displayName: 1 })
  .lean();
}

/**
 * Find models by category
 */
async function findByCategory(category) {
  return getModel().find({
    categories: category,
    isActive: true
  })
  .sort({ 'benchmarkStats.avgCompositeScore': -1 })
  .lean();
}

/**
 * Find models by tag
 */
async function findByTag(tag) {
  return getModel().find({
    tags: tag,
    isActive: true
  })
  .sort({ displayName: 1 })
  .lean();
}

/**
 * Find models with minimum context window
 */
async function findByMinContext(minContext) {
  return getModel().find({
    'capabilities.maxContext': { $gte: minContext },
    isActive: true
  })
  .sort({ 'capabilities.maxContext': -1 })
  .lean();
}

/**
 * Get best model for specific task type
 *
 * @param {string} taskType - Task type from routingRules.preferredFor
 * @param {object} constraints - Optional constraints { maxLatency, minContext }
 * @returns {Promise<Model>} Best matching model
 */
async function getBestForTask(taskType, constraints = {}) {
  const query = {
    'routingRules.preferredFor': taskType,
    isActive: true,
    status: 'active'
  };

  if (constraints.maxLatency) {
    query['capabilities.p95LatencyMs'] = { $lte: constraints.maxLatency };
  }
  if (constraints.minContext) {
    query['capabilities.maxContext'] = { $gte: constraints.minContext };
  }

  const models = await getModel().find(query)
    .sort({
      'routingRules.priority': -1,
      'benchmarkStats.avgCompositeScore': -1
    })
    .limit(1)
    .lean();

  return models[0] || null;
}

/**
 * Get models grouped by category
 */
async function getGroupedByCategory() {
  const models = await getModel().find({ isActive: true }).lean();

  // Build dynamically from schema enum so new categories are never silently dropped
  const categoryEnum = getModel().schema.path('categories').caster.enumValues || [];
  const grouped = Object.fromEntries(categoryEnum.map(c => [c, []]));

  models.forEach(model => {
    model.categories.forEach(category => {
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(model);
    });
  });

  // Sort each group by composite score
  Object.keys(grouped).forEach(category => {
    grouped[category].sort((a, b) => {
      const scoreA = a.benchmarkStats?.avgCompositeScore || 0;
      const scoreB = b.benchmarkStats?.avgCompositeScore || 0;
      return scoreB - scoreA;
    });
  });

  return grouped;
}

/**
 * Get category statistics
 */
async function getCategoryStats() {
  const models = await getModel().find({ isActive: true }).lean();

  const stats = {};

  models.forEach(model => {
    model.categories.forEach(category => {
      if (!stats[category]) {
        stats[category] = {
          count: 0,
          benchmarkedCount: 0,
          latencyCount: 0,
          avgCompositeScore: 0,
          avgLatency: 0,
          models: []
        };
      }

      stats[category].count += 1;
      stats[category].models.push(model.modelName);

      if (model.benchmarkStats?.avgCompositeScore) {
        stats[category].avgCompositeScore += model.benchmarkStats.avgCompositeScore;
        stats[category].benchmarkedCount += 1;
      }
      if (model.capabilities?.avgLatencyMs) {
        stats[category].avgLatency += model.capabilities.avgLatencyMs;
        stats[category].latencyCount += 1;
      }
    });
  });

  // Calculate averages using only models that have data
  Object.keys(stats).forEach(category => {
    if (stats[category].benchmarkedCount > 0) {
      stats[category].avgCompositeScore /= stats[category].benchmarkedCount;
      stats[category].avgCompositeScore = Math.round(stats[category].avgCompositeScore * 10) / 10;
    }
    if (stats[category].latencyCount > 0) {
      stats[category].avgLatency /= stats[category].latencyCount;
      stats[category].avgLatency = Math.round(stats[category].avgLatency);
    }
    // Clean up internal counters
    delete stats[category].benchmarkedCount;
    delete stats[category].latencyCount;
  });

  return stats;
}

/**
 * Persist a host performance snapshot and recalculate capabilities.
 * Keeps max 50 snapshots (latest per host, FIFO for old entries).
 * Recalculates: avgTokensPerSec, avgLatencyMs, p95LatencyMs from stored snapshots.
 *
 * @param {string} modelName
 * @param {object} snapshot - HostPerformanceStepSchema-compatible object
 * @returns {Promise<Model>} Updated model
 */
async function updateHostPerformance(modelName, snapshot) {
  const pushResult = await getModel().findOneAndUpdate(
    { modelName },
    {
      $push: {
        hostPerformance: {
          $each: [snapshot],
          $sort: { testedAt: -1 },
          $slice: 50
        }
      },
      $set: { lastUpdated: new Date() }
    },
    { new: true }
  );
  if (!pushResult) return null;

  // Recalculate capabilities from passing snapshots
  const passing = pushResult.hostPerformance.filter(s => s.status === 'pass');
  if (passing.length > 0) {
    const avgTps = passing.reduce((sum, s) => sum + s.tokensPerSec, 0) / passing.length;
    const avgLat = passing.reduce((sum, s) => sum + s.latencyMs, 0) / passing.length;
    const sortedLat = passing.map(s => s.latencyMs).sort((a, b) => a - b);
    const p95Idx = Math.min(Math.ceil(sortedLat.length * 0.95) - 1, sortedLat.length - 1);

    await getModel().updateOne({ modelName }, {
      $set: {
        'capabilities.avgTokensPerSec': Number(avgTps.toFixed(2)),
        'capabilities.avgLatencyMs': Math.round(avgLat),
        'capabilities.p95LatencyMs': Math.round(sortedLat[p95Idx])
      }
    });
  }

  return getModel().findOne({ modelName });
}

/**
 * Summarize host performance snapshots for a model document.
 * @param {object} modelDoc - Model document (plain or lean)
 * @returns {{ latestAny, latestPass, byHost }}
 */
function summarizeHostPerformance(modelDoc) {
  const snapshots = Array.isArray(modelDoc?.hostPerformance) ? modelDoc.hostPerformance : [];
  const byHost = {};
  let latestAny = null;
  let latestPass = null;

  for (const snapshot of snapshots) {
    if (!latestAny) latestAny = snapshot;
    if (!latestPass && snapshot?.status === 'pass') latestPass = snapshot;

    const hostKey = snapshot?.hostUrl || snapshot?.hostId;
    if (!hostKey) continue;

    if (!byHost[hostKey]) {
      byHost[hostKey] = {
        latest: snapshot,
        latestPass: snapshot?.status === 'pass' ? snapshot : null
      };
      continue;
    }

    if (!byHost[hostKey].latestPass && snapshot?.status === 'pass') {
      byHost[hostKey].latestPass = snapshot;
    }
  }

  return { latestAny, latestPass, byHost };
}

/**
 * Get latest host performance summaries for a list of model names.
 * @param {string[]} modelNames
 * @returns {Promise<Object>} Map of modelName -> performance summary
 */
async function getLatestHostPerformanceForModels(modelNames = []) {
  if (!Array.isArray(modelNames) || modelNames.length === 0) {
    return {};
  }

  const models = await getModel().find(
    { modelName: { $in: modelNames } },
    { modelName: 1, hostPerformance: 1 }
  ).lean();

  return models.reduce((acc, modelDoc) => {
    acc[modelDoc.modelName] = summarizeHostPerformance(modelDoc);
    return acc;
  }, {});
}

module.exports = {
  getActive,
  findByCategory,
  findByTag,
  findByMinContext,
  getBestForTask,
  getGroupedByCategory,
  getCategoryStats,
  updateHostPerformance,
  summarizeHostPerformance,
  getLatestHostPerformanceForModels
};

/**
 * Model Aggregator Service
 *
 * Aggregates models from multiple sources into unified catalog:
 * 1. Live Ollama models (from primary/secondary hosts)
 * 2. Custom models (from CustomModel DB)
 * 3. Model Registry metadata (from ModelRegistry DB)
 *
 * Provides single source of truth for "what models can I use right now?"
 */

const CustomModel = require('../../models/CustomModel');
const ModelRegistry = require('../../models/ModelRegistry');
const fetch = require('node-fetch');
// BenchmarkResult collection is owned by agentx-benchmark — read-only access for enrichment
let BenchmarkResult;
try {
  BenchmarkResult = require('../../models/BenchmarkResult');
} catch {
  // Schema removed — create minimal read-only schema for aggregation queries
  const mongoose = require('mongoose');
  BenchmarkResult = mongoose.models.BenchmarkResult || mongoose.model('BenchmarkResult',
    new mongoose.Schema({}, { collection: 'benchmarkresults', strict: false }));
}
const logger = require('../../config/logger');
const { getHostUrls, getConfiguredHosts, normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const {
  getModelReadiness,
  compareReadiness,
  normalizeModelName
} = require('./modelReadinessService');
const { modelNameIdentityKey } = require('../helpers/modelNameNormalization');
const {
  getThinkingCapabilityStatus,
  resolveCapabilityContract: resolveArtifactCapabilityContract
} = require('./inferenceContractService');

/** Resolve friendly hostname (e.g. "Host Delta") from an Ollama host URL */
function resolveHostName(hostUrl) {
  if (!hostUrl) return null;
  const hosts = getConfiguredHosts();
  const normalized = normalizeHostUrl(hostUrl);
  const match = hosts.find(h => normalizeHostUrl(h.url) === normalized);
  return match ? match.name : null;
}

function registryStatusRank(status) {
  const ranks = {
    active: 0,
    available: 1,
    staged: 2,
    retired: 3,
    gone: 4
  };
  return ranks[String(status || '').toLowerCase()] ?? 2;
}

function selectRegistryRecord(current, candidate) {
  if (!current) return candidate;
  const currentRank = registryStatusRank(current.status);
  const candidateRank = registryStatusRank(candidate.status);
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank ? candidate : current;
  }
  const currentTime = new Date(current.updatedAt || current.lastSeenAt || 0).getTime();
  const candidateTime = new Date(candidate.updatedAt || candidate.lastSeenAt || 0).getTime();
  return candidateTime > currentTime ? candidate : current;
}

function isActiveRegistryRecord(record) {
  if (!record) return false;
  if (record.isActive === false) return false;
  return String(record.status || 'active').toLowerCase() !== 'retired';
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function applyThinkingCapability(model, capabilityContract, fallbackSupported) {
  const status = getThinkingCapabilityStatus(capabilityContract, fallbackSupported);
  model.capabilities.supportsThinking = status.supported;
  model.capabilities.thinkingQualified = status.qualified;
  model.capabilities.thinkingSource = status.source;
  model.capabilities.thinkingQualificationState = status.qualificationState;
  model.capabilities.visibleFinalQualified = status.visibleFinalQualified;
}

// Cache for aggregated models (5 min TTL)
let modelCache = null;
let cacheTimestamp = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get all models from all sources
 * @param {Object} options - Filter options
 * @param {Boolean} options.includeOllama - Include Ollama models (default: true)
 * @param {Boolean} options.includeCustom - Include custom models (default: true)
 * @param {Boolean} options.includeRegistry - Include registry metadata (default: true)
 * @param {Object} options.filters - Additional filters (provider, category, tag, search)
 * @param {Boolean} options.useCache - Use cached results (default: true)
 * @returns {Promise<Array>} Array of unified model objects
 */
async function getAllModels(options = {}) {
  const {
    includeOllama = true,
    includeCustom = true,
    includeRegistry = true,
    filters = {},
    useCache = true,
    deduplicateOllama = true,
    resolveCapabilityContract = resolveArtifactCapabilityContract
  } = options;

  // Cache only applies when all sources are included (default case).
  // Partial-source requests bypass cache to avoid stale cross-caller pollution.
  const allSourcesIncluded = includeOllama && includeCustom && includeRegistry;
  const cacheEligible = allSourcesIncluded && deduplicateOllama;
  if (useCache && cacheEligible && modelCache && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_TTL_MS)) {
    logger.debug('Returning cached models', { count: modelCache.length, age: Date.now() - cacheTimestamp });
    return applyFilters(modelCache, filters);
  }

  logger.info('Aggregating models from all sources', { includeOllama, includeCustom, includeRegistry });

  const models = [];
  const readinessHost = filters.host || null;

  // Fetch from all sources in parallel
  const [ollamaModels, customModels, registryData, benchmarkData] = await Promise.all([
    includeOllama ? fetchOllamaModels() : Promise.resolve([]),
    includeCustom ? fetchCustomModels() : Promise.resolve([]),
    includeRegistry ? fetchRegistryMetadata() : Promise.resolve([]),
    fetchBenchmarkData()
  ]);
  const registryByModelKey = new Map();
  for (const reg of registryData) {
    const key = modelNameIdentityKey(reg.modelName);
    if (key) registryByModelKey.set(key, selectRegistryRecord(registryByModelKey.get(key), reg));
  }
  const benchmarkByModelKey = new Map();
  for (const benchmark of benchmarkData) {
    const key = modelNameIdentityKey(benchmark.model);
    if (key && !benchmarkByModelKey.has(key)) benchmarkByModelKey.set(key, benchmark);
  }
  const capabilityContracts = new Map();
  async function capabilityContractFor(model, host, registryEntry) {
    const key = `${modelNameIdentityKey(model) || model}@@${normalizeHostUrl(host) || ''}`;
    if (!capabilityContracts.has(key)) {
      capabilityContracts.set(key, resolveCapabilityContract(
        { model, host },
        { registryEntry }
      ).catch(() => null));
    }
    return capabilityContracts.get(key);
  }

  // Daily-use callers get one logical model (primary host wins). The models
  // operations catalog opts out so each host installation remains actionable.
  const seenOllamaModels = new Set();
  for (const ollamaModel of ollamaModels) {
    // Normalize: strip ":latest" to match registry convention (syncOrchestrator strips it on save)
    const normalizedName = normalizeModelName(ollamaModel.name);
    const modelKey = modelNameIdentityKey(ollamaModel.name);
    if (deduplicateOllama && seenOllamaModels.has(modelKey)) continue;
    seenOllamaModels.add(modelKey);
    const hostName = resolveHostName(ollamaModel.host);
    const readinessData = await getModelReadiness(normalizedName, readinessHost || ollamaModel.host);
    const unified = {
      id: `ollama:${ollamaModel.host}:${normalizedName}`,
      name: normalizedName,
      displayName: normalizedName,
      provider: 'ollama',
      size: ollamaModel.size,
      details: ollamaModel.details,
      source: {
        type: 'ollama-host',
        url: ollamaModel.host,
        hostName: hostName || undefined,
        metadata: {
          size: ollamaModel.size,
          digest: ollamaModel.digest,
          modified: ollamaModel.modified_at
        }
      },
      capabilities: {
        maxContext: positiveInteger(ollamaModel.details?.context_length),
        supportsStreaming: true,
        supportsThinking: false,
        avgLatencyMs: null // Will be enriched from benchmarks
      },
      deployment: {
        status: 'available',
        deployedAt: ollamaModel.modified_at,
        ollamaHost: ollamaModel.host,
        // Preserve the raw Ollama tag so chat/routing can address the exact
        // variant (e.g. "ax/gemma4:26b") while the catalog key stays bare.
        resolvedName: ollamaModel.name
      },
      categories: [],
      tags: [],
      readiness: readinessData.readiness,
      bestReadiness: readinessData.bestReadiness,
      chatAllowed: true,
      benchmarkStats: null,
      benchmarkEligibility: null,
      cost: { promptCostPer1M: 0, completionCostPer1M: 0, currency: 'USD' } // Local = free
    };

    // Enrich with registry metadata (auto-populated by modelSync on startup)
    const registryMatch = registryByModelKey.get(modelKey);
    if (registryMatch) {
      unified.categories = registryMatch.categories || [];
      unified.tags = registryMatch.tags || [];
      unified.capabilities.maxContext = positiveInteger(registryMatch.capabilities?.maxContext)
        || unified.capabilities.maxContext;
      unified.capabilities.supportsThinking = registryMatch.capabilities?.supportsThinking ?? unified.capabilities.supportsThinking;
      unified.benchmarkStats = registryMatch.benchmarkStats;
      unified.benchmarkEligibility = registryMatch.benchmarkEligibility || null;
      // Propagate registry fields added by auto-sync
      if (registryMatch.displayName) unified.displayName = registryMatch.displayName;
      if (registryMatch.vendor) unified.vendor = registryMatch.vendor;
      if (registryMatch.description) unified.description = registryMatch.description;
      if (registryMatch.sourceType) unified.sourceType = registryMatch.sourceType;
      if (registryMatch.executionDefaults) unified.executionDefaults = registryMatch.executionDefaults;
      if (registryMatch.executionOverrides) unified.executionOverrides = registryMatch.executionOverrides;
      if (registryMatch.parameterSize) unified.parameterSize = registryMatch.parameterSize;
      if (registryMatch.quantization) unified.quantization = registryMatch.quantization;
      if (registryMatch.family) unified.family = registryMatch.family;
      if (registryMatch.status) unified.registryStatus = registryMatch.status;
      if (registryMatch.userNote) unified.userNote = registryMatch.userNote;
      unified.registryModelName = registryMatch.modelName;
    }
    applyThinkingCapability(
      unified,
      await capabilityContractFor(ollamaModel.name, ollamaModel.host, registryMatch),
      registryMatch?.capabilities?.supportsThinking
    );

    // Enrich with benchmark data
    const benchmarkMatch = benchmarkByModelKey.get(modelKey);
    if (benchmarkMatch) {
      unified.capabilities.avgLatencyMs = benchmarkMatch.avgLatency;
      if (!unified.benchmarkStats) {
        unified.benchmarkStats = {
          avgCompositeScore: benchmarkMatch.avgScore,
          totalTests: benchmarkMatch.testCount
        };
      }
    }

    models.push(unified);
  }


  for (const customModel of customModels) {
    const modelName = normalizeModelName(customModel.modelName || customModel.modelId);
    const readinessData = await getModelReadiness(
      modelName,
      readinessHost || customModel.deployedHost || customModel.ollamaHost
    );
    const unified = {
      id: `custom:${customModel._id}`,
      name: modelName,
      displayName: `${customModel.displayName || modelName} (custom)`,
      provider: 'custom',
      source: {
        type: 'custom-modelfile',
        url: null,
        metadata: {
          baseModel: customModel.baseModel,
          customizations: customModel.customizations,
          modelfile: customModel.generatedModelfile
        }
      },
      capabilities: {
        maxContext: positiveInteger(customModel.advancedConfig?.num_ctx),
        supportsStreaming: true,
        supportsThinking: false,
        avgLatencyMs: null
      },
      deployment: {
        status: customModel.status,
        deployedAt: customModel.lastDeployedAt,
        ollamaHost: customModel.deployedHost
      },
      categories: customModel.categories || [],
      tags: customModel.tags || ['custom'],
      readiness: readinessData.readiness,
      bestReadiness: readinessData.bestReadiness,
      chatAllowed: true,
      benchmarkStats: customModel.performance,
      benchmarkEligibility: null,
      cost: { promptCostPer1M: 0, completionCostPer1M: 0, currency: 'USD' }
    };
    const customRegistryMatch = registryByModelKey.get(modelNameIdentityKey(modelName));
    applyThinkingCapability(
      unified,
      await capabilityContractFor(
        modelName,
        customModel.deployedHost || customModel.ollamaHost,
        customRegistryMatch
      ),
      customRegistryMatch?.capabilities?.supportsThinking
        ?? customModel.capabilities?.supportsThinking
    );

    models.push(unified);
  }

  // Include registry-only entries ("guest book") — models removed from hosts
  // but still carrying stats, benchmarks, categories, etc.
  if (includeRegistry) {
    const seenRegistryNames = new Set();
    for (const reg of registryByModelKey.values()) {
      const normalizedRegName = normalizeModelName(reg.modelName);
      const modelKey = modelNameIdentityKey(reg.modelName);
      if (seenOllamaModels.has(modelKey)) continue; // already merged above
      if (seenRegistryNames.has(modelKey)) continue; // dedup :latest/case variants
      seenRegistryNames.add(modelKey);
      const benchmarkMatch = benchmarkByModelKey.get(modelKey);
      const hostName = resolveHostName(reg.host);
      const readinessData = await getModelReadiness(normalizedRegName, readinessHost || reg.host);
      const registryOnlyModel = {
        id: `registry:${normalizedRegName}`,
        name: normalizedRegName,
        displayName: reg.displayName || normalizedRegName,
        provider: 'ollama',
        size: null,
        details: reg.details || {},
        source: {
          type: 'ollama-host',
          url: reg.host || null,
          hostName: hostName || undefined,
        },
        capabilities: {
          maxContext: positiveInteger(reg.capabilities?.maxContext),
          supportsStreaming: true,
          supportsThinking: false,
          supportsVision: reg.capabilities?.supportsVision ?? false,
          avgLatencyMs: benchmarkMatch?.avgLatency || reg.capabilities?.avgLatencyMs || null,
          avgTokensPerSec: reg.capabilities?.avgTokensPerSec || null,
          judgeTier: reg.capabilities?.judgeTier || null,
          curatedJudgeTier: reg.capabilities?.curatedJudgeTier || null,
          judgeReliability: reg.capabilities?.judgeReliability || null,
        },
        deployment: { status: 'gone', deployedAt: null, ollamaHost: reg.host },
        categories: reg.categories || [],
        tags: reg.tags || [],
        readiness: readinessData.readiness,
        bestReadiness: readinessData.bestReadiness,
        chatAllowed: true,
        benchmarkStats: reg.benchmarkStats || (benchmarkMatch ? {
          avgCompositeScore: benchmarkMatch.avgScore,
          totalTests: benchmarkMatch.testCount
        } : null),
        benchmarkEligibility: reg.benchmarkEligibility || null,
        executionDefaults: reg.executionDefaults || null,
        executionOverrides: reg.executionOverrides || null,
        parameterSize: reg.parameterSize || null,
        quantization: reg.quantization || null,
        family: reg.family || null,
        sourceType: reg.sourceType || null,
        registryStatus: reg.status || null,
        registryModelName: reg.modelName,
        vendor: reg.vendor || null,
        description: reg.description || null,
        userNote: reg.userNote || null,
        routingRules: reg.routingRules || null,
        cost: { promptCostPer1M: 0, completionCostPer1M: 0, currency: 'USD' },
      };
      applyThinkingCapability(
        registryOnlyModel,
        await capabilityContractFor(
          reg.modelName,
          reg.host || reg.sourceHost,
          reg
        ),
        reg.capabilities?.supportsThinking
      );
      models.push(registryOnlyModel);
    }
  }

  // Only cache full-source results to avoid stale data for partial callers
  if (cacheEligible) {
    modelCache = models;
    cacheTimestamp = Date.now();
  }

  const goneCount = models.filter(m => m.deployment?.status === 'gone').length;
  logger.info('Model aggregation complete', {
    total: models.length,
    ollama: ollamaModels.length,
    custom: customModels.length,
    registryOnly: goneCount
  });

  return applyFilters(models, filters);
}

const AX_PREFIX = 'ax/';

/**
 * Fetch models from Ollama hosts.
 * Hides base models that have a deployed ax/ counterpart on the same host
 * so services only see adapted (profiled) models when available.
 */
async function fetchOllamaModels() {
  const models = [];

  const hosts = getHostUrls();

  logger.debug('Fetching models from Ollama hosts', { hosts });

  for (const host of hosts) {
    try {
      const response = await fetch(`${host}/api/tags`, { timeout: 5000 });

      if (!response.ok) {
        logger.warn('Ollama host unreachable', { host, status: response.status });
        continue;
      }

      const data = await response.json();

      if (data.models && Array.isArray(data.models)) {
        // Collect the set of adapted model base names on this host
        const adaptedBaseNames = new Set();
        for (const model of data.models) {
          if (model.name.startsWith(AX_PREFIX)) {
            adaptedBaseNames.add(modelNameIdentityKey(model.name.slice(AX_PREFIX.length)));
          }
        }
        for (const model of data.models) {
          // Hide base model when its adapted version exists on this host
          if (!model.name.startsWith(AX_PREFIX) && adaptedBaseNames.has(modelNameIdentityKey(model.name))) {
            continue;
          }
          models.push({
            ...model,
            host
          });
        }
      }
    } catch (error) {
      logger.error('Failed to fetch from Ollama host', { host, error: error.message });
    }
  }

  return models;
}


async function fetchCustomModels() {
  try {
    return await CustomModel.find({}).lean();
  } catch (error) {
    logger.error('Failed to fetch custom models', { error: error.message });
    return [];
  }
}

/**
 * Fetch registry metadata from database
 */
async function fetchRegistryMetadata() {
  try {
    return await ModelRegistry.find({}).lean();
  } catch (error) {
    logger.error('Failed to fetch registry metadata', { error: error.message });
    return [];
  }
}

/**
 * Fetch benchmark data for enrichment
 */
async function fetchBenchmarkData() {
  try {
    const results = await BenchmarkResult.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: '$model',
          avgLatency: { $avg: '$result.latency' },
          avgScore: { $avg: '$result.score' },
          testCount: { $sum: 1 }
        }
      },
      { $project: { _id: 0, model: '$_id', avgLatency: 1, avgScore: 1, testCount: 1 } }
    ]);

    return results;
  } catch (error) {
    logger.error('Failed to fetch benchmark data', { error: error.message });
    return [];
  }
}

/**
 * Apply filters to model list
 */
function applyFilters(models, filters) {
  let filtered = [...models];

  if (filters.provider) {
    filtered = filtered.filter(m => m.provider === filters.provider);
  }

  if (filters.category) {
    filtered = filtered.filter(m => m.categories?.includes(filters.category));
  }

  if (filters.tag) {
    filtered = filtered.filter(m => m.tags?.includes(filters.tag));
  }

  if (filters.search) {
    const search = filters.search.toLowerCase();
    filtered = filtered.filter(m =>
      m.name.toLowerCase().includes(search) ||
      m.displayName.toLowerCase().includes(search)
    );
  }

  if (filters.status) {
    filtered = filtered.filter(m => m.deployment?.status === filters.status);
  }

  if (filters.host) {
    const normalizedHost = normalizeHostUrl(filters.host);
    filtered = filtered.filter((model) => {
      const sourceHost = normalizeHostUrl(model?.source?.url);
      const deploymentHost = normalizeHostUrl(model?.deployment?.ollamaHost);
      return normalizedHost && (sourceHost === normalizedHost || deploymentHost === normalizedHost);
    });
  }

  filtered.sort((left, right) => {
    const readinessOrder = compareReadiness(left.readiness, right.readiness);
    if (readinessOrder !== 0) return readinessOrder;

    const leftAvailable = left.deployment?.status === 'available' ? 0 : 1;
    const rightAvailable = right.deployment?.status === 'available' ? 0 : 1;
    if (leftAvailable !== rightAvailable) return leftAvailable - rightAvailable;

    return String(left.displayName || left.name || '').localeCompare(String(right.displayName || right.name || ''));
  });

  return filtered;
}

/**
 * Get model sources summary
 */
async function getModelSources() {
  const [models, registryData] = await Promise.all([
    getAllModels({ useCache: true }),
    fetchRegistryMetadata()
  ]);
  const activeRegistryData = registryData.filter(isActiveRegistryRecord);
  const activeRegistryKeys = new Set(activeRegistryData.map(reg => modelNameIdentityKey(reg.modelName)).filter(Boolean));
  const liveOllamaModels = models.filter(model =>
    model.provider === 'ollama' && model.deployment?.status === 'available'
  );
  const liveOllamaKeys = new Set(liveOllamaModels.map(model =>
    modelNameIdentityKey(model.deployment?.resolvedName || model.name)
  ).filter(Boolean));
  const registryBackedCatalogKeys = new Set(models
    .filter(model => model.registryStatus || model.registryModelName || String(model.id || '').startsWith('registry:'))
    .map(model => modelNameIdentityKey(model.registryModelName || model.deployment?.resolvedName || model.name))
    .filter(key => activeRegistryKeys.has(key))
    .filter(Boolean));

  const sources = {
    ollama: {
      hosts: [],
      count: 0
    },
    custom: {
      count: 0
    },
    registry: {
      count: 0
    }
  };

  // Mutating UI controls need the complete configured fleet, including an
  // online host that currently has zero visible models.
  sources.ollama.hosts = getConfiguredHosts().map(host => ({
    id: host.id,
    url: host.url,
    name: host.name || host.url
  }));
  sources.ollama.count = liveOllamaModels.length;



  // Registry count must reflect registry records, not "has categories".
  sources.registry.count = activeRegistryData.length;
  sources.registry.identityCount = activeRegistryKeys.size;
  sources.registry.catalogBackedCount = registryBackedCatalogKeys.size;
  sources.registry.unregisteredAvailableCount = liveOllamaModels.filter(model =>
    !activeRegistryKeys.has(modelNameIdentityKey(model.deployment?.resolvedName || model.name))
  ).length;
  sources.registry.missingFromCatalogCount = activeRegistryData.filter(reg =>
    !liveOllamaKeys.has(modelNameIdentityKey(reg.modelName)) &&
    !registryBackedCatalogKeys.has(modelNameIdentityKey(reg.modelName))
  ).length;

  return sources;
}

/**
 * Get model by name (fuzzy match across all sources)
 */
async function getModelByName(name, provider = null) {
  const models = await getAllModels({ useCache: true });
  const lookupKey = modelNameIdentityKey(name);

  let matches = models.filter(m =>
    modelNameIdentityKey(m.name) === lookupKey ||
    modelNameIdentityKey(m.displayName) === lookupKey
  );

  if (provider) {
    matches = matches.filter(m => m.provider === provider);
  }

  if (matches.length === 0) {
    // Fuzzy search
    matches = models.filter(m =>
      m.name.includes(name) || m.displayName.includes(name)
    );
  }

  return matches[0] || null;
}

/**
 * Refresh model cache (force re-fetch)
 */
async function refreshModelCache() {
  logger.info('Refreshing model cache (forced)');
  modelCache = null;
  cacheTimestamp = null;

  const models = await getAllModels({ useCache: false });
  // Use the freshly-populated cache instead of re-fetching everything
  const sources = await getModelSources();

  return {
    modelsFound: models.length,
    sources,
    timestamp: new Date()
  };
}

/**
 * Clear model cache
 */
function clearCache() {
  modelCache = null;
  cacheTimestamp = null;
  logger.debug('Model cache cleared');
}

module.exports = {
  getAllModels,
  getModelSources,
  getModelByName,
  refreshModelCache,
  clearCache
};

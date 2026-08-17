'use strict';

/**
 * OpenClaw export — format ModelRegistry entries so they can be pasted into
 * `openclaw.json` as provider.models[] entries. Optionally diffs against the
 * live openclaw.json and reports what's new, what's drifted, what's orphaned.
 *
 * Read-only. Never writes to openclaw.json (protected file, human-only).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const ModelRegistry = require('../../models/ModelRegistry');
const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const { normalizeModelName } = require('../helpers/modelNameNormalization');
const {
  getThinkingCapabilityStatus,
  resolveCapabilityContract
} = require('./inferenceContractService');

const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || path.join(os.homedir(), '.openclaw', 'openclaw.json');

// Produce a stable provider id from the configured source host. Environment-
// specific aliases belong in the consuming runtime, not in product code.
function suggestProviderId(host) {
  if (!host) return 'agentx-unknown';
  return 'agentx-' + host.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

function isEmbeddingEntry(entry) {
  if ((entry.categories || []).includes('embedding')) return true;
  if (/embed|bge-|nomic/i.test(entry.modelName || '')) return true;
  return false;
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function getContextProbeModel() {
  if (mongoose.models.ModelContextProbeSnapshot) {
    return mongoose.models.ModelContextProbeSnapshot;
  }
  return mongoose.model('ModelContextProbeSnapshot', new mongoose.Schema({}, {
    collection: 'modelcontextprobesnapshots',
    strict: false
  }));
}

function getContextProfileModel() {
  if (mongoose.models.ModelContextProfile) {
    return mongoose.models.ModelContextProfile;
  }
  return mongoose.model('ModelContextProfile', new mongoose.Schema({}, {
    collection: 'modelcontextprofiles',
    strict: false
  }));
}

function contextProbeKey(modelName, hostUrl) {
  const modelKey = normalizeModelName(modelName);
  const hostKey = normalizeHostUrl(hostUrl);
  if (!modelKey || !hostKey) return null;
  return `${modelKey}@@${hostKey}`;
}

const contextProfileKey = contextProbeKey;

function modelLookupNames(modelName) {
  const raw = String(modelName || '').trim().replace(/:latest$/i, '');
  const normalized = normalizeModelName(raw);
  return Array.from(new Set([raw, normalized].filter(Boolean)));
}

function resolveContextWindow(entry) {
  const overrideCtx = positiveInteger(entry.executionOverrides && entry.executionOverrides.num_ctx);
  if (overrideCtx) return { value: overrideCtx, source: 'user_override' };

  const profileCtx = positiveInteger(entry._contextProfile && (
    entry._contextProfile.verifiedMaxContext || entry._contextProfile.recommendedContext
  ));
  if (profileCtx) {
    return {
      value: profileCtx,
      source: 'model_context_profile',
      verifiedMaxContext: positiveInteger(entry._contextProfile.verifiedMaxContext) || profileCtx,
      verifiedInputTokens: positiveInteger(entry._contextProfile.verifiedInputTokens) || null,
      profiledAt: entry._contextProfile.lastValidatedAt || null,
    };
  }

  const probeCtx = positiveInteger(entry._contextProbe && entry._contextProbe.testedNumCtx);
  if (probeCtx) {
    return {
      value: probeCtx,
      source: 'benchmark_context_probe',
      verifiedMaxContext: probeCtx,
      profiledAt: entry._contextProbe.testedAt || null
    };
  }

  const testedCtx = entry.contextTest
    && entry.contextTest.status === 'completed'
    && positiveInteger(entry.contextTest.testedNumCtx);
  if (testedCtx) return { value: testedCtx, source: 'context_test', verifiedMaxContext: testedCtx };

  return { value: null, source: 'unresolved' };
}

async function loadLatestContextProfileMap(entries) {
  if (mongoose.connection.readyState !== 1) return new Map();

  const hostSet = new Set();
  const modelSet = new Set();
  for (const entry of entries) {
    const host = normalizeHostUrl(entry.sourceHost);
    if (!host) continue;
    hostSet.add(host);
    for (const name of modelLookupNames(entry.modelName)) modelSet.add(name);
  }
  if (hostSet.size === 0 || modelSet.size === 0) return new Map();

  try {
    const Profile = getContextProfileModel();
    const profiles = await Profile.find({
      modelName: { $in: Array.from(modelSet) },
      hostUrl: { $in: Array.from(hostSet) },
      stale: { $ne: true },
      $or: [
        { verifiedMaxContext: { $gt: 0 } },
        { recommendedContext: { $gt: 0 } }
      ]
    })
      .sort({ lastValidatedAt: -1 })
      .lean();

    const byKey = new Map();
    for (const profile of profiles) {
      const key = contextProfileKey(profile.modelName, profile.hostUrl);
      if (key && !byKey.has(key)) byKey.set(key, profile);
    }
    return byKey;
  } catch (err) {
    return new Map();
  }
}

async function loadLatestContextProbeMap(entries) {
  if (mongoose.connection.readyState !== 1) return new Map();

  const hostSet = new Set();
  const modelSet = new Set();
  for (const entry of entries) {
    const host = normalizeHostUrl(entry.sourceHost);
    if (!host) continue;
    hostSet.add(host);
    for (const name of modelLookupNames(entry.modelName)) modelSet.add(name);
  }
  if (hostSet.size === 0 || modelSet.size === 0) return new Map();

  try {
    const Probe = getContextProbeModel();
    const probes = await Probe.find({
      modelName: { $in: Array.from(modelSet) },
      hostUrl: { $in: Array.from(hostSet) },
      status: 'completed',
      testedNumCtx: { $gt: 0 }
    })
      .sort({ testedAt: -1 })
      .lean();

    const byKey = new Map();
    for (const probe of probes) {
      const key = contextProbeKey(probe.modelName, probe.hostUrl);
      if (key && !byKey.has(key)) byKey.set(key, probe);
    }
    return byKey;
  } catch (err) {
    return new Map();
  }
}

// Derive a kebab-case short name that fits OpenClaw's `name` convention
// (examples from openclaw.json: "gemma4-26b", "qwen25-7b", "claude-sonnet-46")
function shortName(modelName) {
  if (!modelName) return 'unknown';
  return modelName
    .toLowerCase()
    .replace(/[:/]/g, '-')
    .replace(/\.(?=\d)/g, '')
    .replace(/-instruct-q\d+_k_m/i, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert a ModelRegistry document into an OpenClaw model[] entry.
 * The extra `_source` block is metadata — OpenClaw ignores unknown fields but
 * it helps the operator review what's being proposed.
 */
function toOpenClawModel(entry, capabilityContract = null) {
  const isEmbedding = isEmbeddingEntry(entry);
  const thinking = getThinkingCapabilityStatus(
    capabilityContract,
    entry.capabilities?.supportsThinking
  );

  const resolvedContext = resolveContextWindow(entry);
  const contextWindow = resolvedContext.value;

  const model = {
    id: entry.modelName,
    name: shortName(entry.modelName),
    reasoning: thinking.qualified
      || (thinking.source === 'model_registry_fallback' && thinking.supported),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: isEmbedding ? 512 : 8192,
    _source: {
      host: entry.sourceHost || null,
      profiledAt: resolvedContext.profiledAt || (entry.contextTest && entry.contextTest.completedAt) || entry.lastSeenAt || null,
      contextTestStatus: (entry.contextTest && entry.contextTest.status) || 'not-tested',
      contextWindowSource: resolvedContext.source,
      contextMaxVerified: resolvedContext.verifiedMaxContext || null,
      contextInputVerified: resolvedContext.verifiedInputTokens || null,
      contextProfileStatus: entry._contextProfile ? (entry._contextProfile.stale ? 'stale' : 'active') : null,
      contextProbeStatus: (entry._contextProbe && entry._contextProbe.status) || null,
      parameterSize: entry.parameterSize || null,
      quantization: entry.quantization || null,
      categories: entry.categories || [],
      thinkingSource: thinking.source,
      thinkingQualified: thinking.qualified,
      thinkingQualificationState: thinking.qualificationState,
      visibleFinalQualified: thinking.visibleFinalQualified
    }
  };

  if (contextWindow) model.contextWindow = contextWindow;

  if (!isEmbedding && contextWindow) {
    model.params = { num_ctx: contextWindow };
    model._source.runtimeNumCtx = contextWindow;
  }

  return model;
}

function runtimeNumCtx(model) {
  return positiveInteger(model && model.params && model.params.num_ctx);
}

function modelConfigDrift(current, exported) {
  const drift = {};
  if (exported.contextWindow != null && current.contextWindow !== exported.contextWindow) {
    drift.contextWindow = true;
  }
  const exportedNumCtx = runtimeNumCtx(exported);
  if (exportedNumCtx != null && runtimeNumCtx(current) !== exportedNumCtx) {
    drift.num_ctx = true;
  }
  return drift;
}

/**
 * Build the full export: one provider suggestion per sourceHost, populated
 * from ModelRegistry entries that are active and not retired.
 */
async function buildExport(options = {}) {
  const entries = await ModelRegistry.find({
    isActive: { $ne: false },
    status: { $ne: 'retired' }
  })
    .select('modelName categories capabilities contextTest executionDefaults executionOverrides sourceHost lastSeenAt parameterSize quantization family')
    .sort({ sourceHost: 1, modelName: 1 })
    .lean();

  const byHost = new Map();
  const contextProfileMap = await loadLatestContextProfileMap(entries);
  const contextProbeMap = await loadLatestContextProbeMap(entries);
  const capabilityResolver = options.resolveCapabilityContract || resolveCapabilityContract;
  const resolvedEntries = await Promise.all(entries.map(async (entry) => {
    try {
      const capabilityContract = await capabilityResolver({
        model: entry.modelName,
        host: entry.sourceHost
      }, { registryEntry: entry });
      return { entry, capabilityContract };
    } catch {
      return { entry, capabilityContract: null };
    }
  }));
  for (const { entry: e, capabilityContract } of resolvedEntries) {
    const profile = contextProfileMap.get(contextProfileKey(e.modelName, e.sourceHost));
    if (profile) e._contextProfile = profile;
    const probe = contextProbeMap.get(contextProbeKey(e.modelName, e.sourceHost));
    if (probe) e._contextProbe = probe;
    const host = e.sourceHost || 'unknown';
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(toOpenClawModel(e, capabilityContract));
  }

  const providers = {};
  for (const [host, models] of byHost.entries()) {
    const providerId = suggestProviderId(host);
    providers[providerId] = {
      baseUrl: host,
      api: 'ollama',
      authHeader: false,
      apiKey: 'ollama-local',
      models
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    registryCount: entries.length,
    providers
  };
}

/**
 * Diff the export against the live openclaw.json. Identifies:
 *  - new:     in registry, not in openclaw.json
 *  - updated: in both, contextWindow or params.num_ctx differs
 *  - unknown: in openclaw.json, not in registry (remote/cloud providers or
 *             orphaned entries — operator should review)
 */
async function buildDiff() {
  const exportData = await buildExport();

  let openclawConfig;
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    openclawConfig = JSON.parse(raw);
  } catch (err) {
    return {
      error: `Could not read openclaw config at ${OPENCLAW_CONFIG_PATH}: ${err.message}`,
      configPath: OPENCLAW_CONFIG_PATH
    };
  }

  const currentById = new Map();
  const providers = (openclawConfig.models && openclawConfig.models.providers) || {};
  for (const [pid, pdef] of Object.entries(providers)) {
    for (const m of (pdef.models || [])) {
      currentById.set(m.id, { ...m, _provider: pid });
    }
  }

  const newModels = [];
  const updatedModels = [];
  const exportedIds = new Set();

  for (const [pid, pdef] of Object.entries(exportData.providers)) {
    for (const m of pdef.models) {
      exportedIds.add(m.id);
      const current = currentById.get(m.id);
      if (!current) {
        newModels.push({ ...m, _suggestedProvider: pid });
        continue;
      }
      const drift = modelConfigDrift(current, m);
      if (Object.keys(drift).length > 0) {
        updatedModels.push({
          id: m.id,
          suggestedProvider: pid,
          drift,
          current: {
            contextWindow: current.contextWindow,
            params: { num_ctx: runtimeNumCtx(current) },
            provider: current._provider
          },
          registry: {
            contextWindow: m.contextWindow,
            params: { num_ctx: runtimeNumCtx(m) },
            profiledAt: m._source && m._source.profiledAt,
            contextTestStatus: m._source && m._source.contextTestStatus,
            contextWindowSource: m._source && m._source.contextWindowSource
          }
        });
      }
    }
  }

  const unknownModels = [];
  for (const [id, m] of currentById.entries()) {
    if (!exportedIds.has(id)) {
      unknownModels.push({
        id,
        provider: m._provider,
        contextWindow: m.contextWindow,
        params: { num_ctx: runtimeNumCtx(m) }
      });
    }
  }

  return {
    generatedAt: exportData.generatedAt,
    configPath: OPENCLAW_CONFIG_PATH,
    summary: {
      new: newModels.length,
      updated: updatedModels.length,
      unknown: unknownModels.length,
      totalExported: exportedIds.size,
      totalInOpenclaw: currentById.size
    },
    new: newModels,
    updated: updatedModels,
    unknown: unknownModels
  };
}

module.exports = {
  buildExport,
  buildDiff,
  // exposed for tests
  toOpenClawModel,
  suggestProviderId,
  shortName
};

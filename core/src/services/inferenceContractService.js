'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { getContextInfo } = require('./modelContextInfoService');
const {
  getConfiguredHosts,
  hostUrlKey,
  normalizeHostUrl
} = require('../helpers/ollamaHostConfig');
const { getTokenCounter } = require('./tokenCounter');
const { modelLookupNames } = require('../helpers/modelNameNormalization');
const {
  profileMatchesArtifact,
  readLiveDigest,
  resolveArtifactIdentity
} = require('./artifactIdentityService');

const CONTRACT_VERSION = 'agentx.inference-contract.v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const PROFILED_STAGES = new Set(['profiled', 'benchmarked']);
const VALIDATED_CONTEXT_SOURCES = new Set([
  'model_context_profile',
  'context_test',
  'profiled'
]);

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function mapValue(mapLike, key) {
  if (!mapLike || !key) return null;
  if (mapLike instanceof Map) return mapLike.get(key) || null;
  return mapLike[key] || null;
}

async function readArtifactDigest(model, host, deps = {}) {
  return readLiveDigest(model, host, deps);
}

function resolveHostIdentity(host, configuredHosts = getConfiguredHosts()) {
  const normalizedHost = normalizeHostUrl(host);
  const key = hostUrlKey(normalizedHost);
  const configured = (configuredHosts || []).find((candidate) =>
    key && hostUrlKey(candidate?.url) === key
  );
  return {
    host: configured?.url || normalizedHost || null,
    hostId: configured?.id || null,
    hostName: configured?.name || null
  };
}

function unknownThinkingCapability(source = 'unqualified') {
  return {
    supported: null,
    modes: ['off'],
    channel: 'unknown',
    recommendedPolicy: 'unknown',
    visibleFinalAnswer: {
      required: true,
      qualified: false,
      thinkingOnlyObserved: false
    },
    autoRankable: false,
    source
  };
}

async function readHostProfile(host, deps = {}) {
  const normalizedHost = normalizeHostUrl(host);
  if (!normalizedHost) return null;

  try {
    const collection = deps.hostProfilesCollection
      || (mongoose.connection.readyState === 1
        ? mongoose.connection.collection('hostprofiles')
        : null);
    if (!collection) return null;
    return await collection.findOne(
      { hostUrl: normalizedHost },
      { projection: { hostId: 1, hostUrl: 1, displayName: 1, gpu: 1, ollama: 1, cpu: 1 } }
    );
  } catch {
    return null;
  }
}

async function readModelProfile(model, deps = {}) {
  const names = modelLookupNames(model);
  if (names.length === 0) return null;

  try {
    const collection = deps.modelProfilesCollection
      || (mongoose.connection.readyState === 1
        ? mongoose.connection.collection('modelprofiles')
        : null);
    if (!collection) return null;
    return await collection.findOne(
      { name: { $in: names } },
      {
        projection: {
          name: 1,
          capabilities: 1,
          thinkingProfiles: 1,
          readiness: 1,
          updatedAt: 1
        }
      }
    );
  } catch {
    return null;
  }
}

async function readRegistryThinking(model, deps = {}) {
  try {
    if (deps.registryEntry
      && typeof deps.registryEntry.capabilities?.supportsThinking === 'boolean') {
      return {
        supported: deps.registryEntry.capabilities.supportsThinking,
        modelName: deps.registryEntry.modelName || null
      };
    }
    if (!deps.ModelRegistry && mongoose.connection.readyState !== 1) return null;
    const ModelRegistry = deps.ModelRegistry || require('../../models/ModelRegistry');
    const entry = await ModelRegistry.findOne({
      modelName: { $in: modelLookupNames(model) }
    })
      .select('modelName capabilities.supportsThinking')
      .lean();
    if (!entry || typeof entry.capabilities?.supportsThinking !== 'boolean') return null;
    return {
      supported: entry.capabilities.supportsThinking,
      modelName: entry.modelName || null
    };
  } catch {
    return null;
  }
}

async function resolveCapabilities(model, host, deps = {}) {
  const configuredIdentity = resolveHostIdentity(host, deps.configuredHosts);
  const hostProfile = await readHostProfile(configuredIdentity.host, deps);
  const identity = {
    host: hostProfile?.hostUrl || configuredIdentity.host,
    hostId: hostProfile?.hostId || configuredIdentity.hostId,
    hostName: hostProfile?.displayName || configuredIdentity.hostName
  };
  const [profile, exactArtifact] = await Promise.all([
    readModelProfile(model, deps),
    deps.includeArtifactIdentity === true
      ? resolveArtifactIdentity(model, identity.host, {
        ...deps,
        hostProfile: hostProfile || undefined
      })
      : null
  ]);
  if (exactArtifact?.hostId) identity.hostId = exactArtifact.hostId;
  const thinkingProfile = mapValue(profile?.thinkingProfiles, identity.hostId);
  const readiness = mapValue(profile?.readiness, identity.hostId);
  const stage = readiness?.stage || (thinkingProfile ? 'profiled' : 'unknown');
  const exactProfile = profileMatchesArtifact(readiness?.artifact, exactArtifact);
  const qualified = PROFILED_STAGES.has(stage)
    && !!identity.hostId
    && readiness?.benchmarkQualified === true
    && readiness?.stale !== true
    && exactProfile;

  let thinking = unknownThinkingCapability();
  if (thinkingProfile) {
    const supported = thinkingProfile.supported === true;
    const policy = thinkingProfile.recommendedPolicy || 'unknown';
    thinking = {
      supported,
      modes: supported && policy !== 'disallowed' ? ['off', 'on'] : ['off'],
      channel: thinkingProfile.channel || 'unknown',
      recommendedPolicy: policy,
      visibleFinalAnswer: {
        required: true,
        qualified: thinkingProfile.visibleFinalAnswerOk === true
          && thinkingProfile.finalAnswerContractOk === true
          && thinkingProfile.thinkingOnlyResponse !== true,
        thinkingOnlyObserved: thinkingProfile.thinkingOnlyResponse === true
      },
      autoRankable: false,
      profiledAt: thinkingProfile.profiledAt || null,
      source: 'benchmark_model_profile'
    };
  } else {
    const legacy = await readRegistryThinking(model, deps);
    if (legacy) {
      thinking = {
        ...unknownThinkingCapability('model_registry_fallback'),
        supported: legacy.supported,
        modes: legacy.supported ? ['off', 'on'] : ['off'],
        matchedModel: legacy.modelName
      };
    }
  }

  const toolsSupported = typeof profile?.capabilities?.tools === 'boolean'
    ? profile.capabilities.tools
    : null;

  return {
    artifact: {
      model: exactArtifact?.model || model,
      hostId: exactArtifact?.hostId || identity.hostId,
      host: exactArtifact?.hostUrl || identity.host,
      digest: exactArtifact?.digest || null,
      runtimeFingerprint: exactArtifact?.runtimeFingerprint || null,
      registryId: exactArtifact?.registryId || null,
      registryDigest: exactArtifact?.registryDigest || null,
      registryQualified: exactArtifact?.registryQualified === true,
      identityQualified: exactArtifact?.identityQualified === true,
      identitySource: exactArtifact?.identityQualified ? 'core_registry+ollama_tags' : 'unresolved',
      matchedProfile: profile?.name || null,
      hostName: identity.hostName
    },
    qualification: {
      state: stage,
      qualified,
      stale: readiness?.stale === true,
      exactArtifact: exactProfile,
      source: profile ? 'benchmark_model_profile' : 'fallback'
    },
    thinking,
    tools: {
      supported: toolsSupported,
      qualified: qualified && toolsSupported !== null,
      source: profile ? 'benchmark_model_profile' : 'unqualified'
    },
    streaming: {
      supported: null,
      qualified: false,
      source: 'unqualified'
    }
  };
}

function requestText({ prompt, system, messages }) {
  if (Array.isArray(messages)) {
    return messages.map((message) => String(message?.content || '')).join('\n');
  }
  return [system, prompt].filter((value) => typeof value === 'string').join('\n');
}

function estimateInputTokens(input = {}) {
  const text = requestText(input);
  const contentTokens = getTokenCounter().countTokens(text);
  const messageOverhead = Array.isArray(input.messages)
    ? (input.messages.length * 4) + 2
    : 0;
  return {
    tokens: contentTokens + messageOverhead,
    characters: text.length,
    method: 'token_counter_plus_message_overhead',
    exact: false
  };
}

async function resolveContextBudget(input, deps = {}) {
  const requestedNumCtx = positiveInteger(input.requestedNumCtx);
  let resolved = null;
  try {
    const canUseDefaultResolver = mongoose.connection.readyState === 1;
    if (deps.resolveContextDetails) {
      resolved = await deps.resolveContextDetails(input.model, {
        targetHost: input.host,
        deps: deps.contextDeps
      });
    } else if (canUseDefaultResolver) {
      resolved = await getContextInfo(input.model, input.host, {
        artifactIdentity: deps.artifactIdentity || null
      });
    }
  } catch {
    resolved = null;
  }

  const resolvedTokens = positiveInteger(resolved?.num_ctx);
  const windowTokens = requestedNumCtx || resolvedTokens;
  const explicitOutput = positiveInteger(input.requestedMaxOutputTokens);
  const defaultOutput = windowTokens
    ? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.max(256, Math.floor(windowTokens / 4)))
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const reservedOutputTokens = windowTokens
    ? Math.min(windowTokens, explicitOutput || defaultOutput)
    : (explicitOutput || defaultOutput);
  const availableInputTokens = windowTokens
    ? Math.max(0, windowTokens - reservedOutputTokens)
    : null;
  const estimate = estimateInputTokens(input);
  const overflowTokens = availableInputTokens == null
    ? null
    : Math.max(0, estimate.tokens - availableInputTokens);
  const profiledWindowTokens = positiveInteger(
    resolved?.details?.verifiedMaxContext || resolved?.verifiedMaxContext
  );
  const validatedWindowTokens = profiledWindowTokens
    || (VALIDATED_CONTEXT_SOURCES.has(resolved?.source) ? resolvedTokens : null);
  const validatedInputTokens = positiveInteger(
    resolved?.details?.verifiedInputTokens || resolved?.verifiedInputTokens
  );
  const validatedInputOverflowTokens = validatedInputTokens
    ? Math.max(0, estimate.tokens - validatedInputTokens)
    : null;
  const warnings = [];

  if (!windowTokens) {
    warnings.push('runtime context is unresolved; no context window was inferred');
  }
  if (overflowTokens > 0) {
    warnings.push('estimated input exceeds the available context budget; upstream truncation is possible');
  }
  if (windowTokens && validatedWindowTokens && windowTokens > validatedWindowTokens) {
    warnings.push('runtime context exceeds the latest validated host/model context');
  }
  if (validatedInputOverflowTokens > 0) {
    warnings.push('estimated input exceeds the largest measured successful prompt; execution remains report-only');
  }

  return {
    windowTokens,
    source: requestedNumCtx ? (input.numCtxSource || 'caller') : (resolved?.source || 'unresolved'),
    resolvedWindowTokens: resolvedTokens,
    resolvedSource: resolved?.source || 'unresolved',
    validatedWindowTokens,
    validatedInputTokens,
    output: {
      reservedTokens: reservedOutputTokens,
      source: explicitOutput ? 'caller' : 'default_reserve'
    },
    input: {
      estimatedTokens: estimate.tokens,
      characters: estimate.characters,
      availableTokens: availableInputTokens,
      remainingTokens: availableInputTokens == null
        ? null
        : Math.max(0, availableInputTokens - estimate.tokens),
      overflowTokens,
      fits: overflowTokens == null ? null : overflowTokens === 0,
      validatedOverflowTokens: validatedInputOverflowTokens,
      validatedFits: validatedInputTokens ? validatedInputOverflowTokens === 0 : null,
      estimation: {
        method: estimate.method,
        exact: estimate.exact
      }
    },
    transformations: {
      condensation: { applied: false, removedTokens: 0 },
      truncation: { applied: false, removedTokens: 0 },
      upstreamTruncationRisk: overflowTokens > 0
    },
    enforcement: 'report_only',
    warnings
  };
}

async function resolveInferenceContract(input = {}, deps = {}) {
  const capabilityContract = await resolveCapabilityContract(input, deps);
  const contextBudget = await resolveContextBudget(input, {
    ...deps,
    artifactIdentity: capabilityContract.artifact
  });

  return {
    ...capabilityContract,
    contextBudget
  };
}

async function resolveCapabilityContract(input = {}, deps = {}) {
  const resolved = await resolveCapabilities(input.model, input.host, deps);
  return {
    version: CONTRACT_VERSION,
    artifact: resolved.artifact,
    qualification: resolved.qualification,
    capabilities: {
      thinking: resolved.thinking,
      tools: resolved.tools,
      streaming: resolved.streaming
    }
  };
}

function hasQualifiedThinkingCapability(contract) {
  const thinking = contract?.capabilities?.thinking;
  return thinking?.supported === true
    && thinking.source === 'benchmark_model_profile'
    && contract?.qualification?.qualified === true
    && thinking.visibleFinalAnswer?.qualified === true;
}

function getThinkingCapabilityStatus(contract, fallbackSupported) {
  const thinking = contract?.capabilities?.thinking;
  if (typeof thinking?.supported === 'boolean') {
    return {
      supported: thinking.supported,
      qualified: hasQualifiedThinkingCapability(contract),
      source: thinking.source || 'capability_contract',
      qualificationState: contract?.qualification?.state || 'unknown',
      visibleFinalQualified: thinking.visibleFinalAnswer?.qualified === true
    };
  }
  if (typeof fallbackSupported === 'boolean') {
    return {
      supported: fallbackSupported,
      qualified: false,
      source: 'model_registry_fallback',
      qualificationState: 'unknown',
      visibleFinalQualified: false
    };
  }
  return {
    supported: false,
    qualified: false,
    source: 'unqualified',
    qualificationState: contract?.qualification?.state || 'unknown',
    visibleFinalQualified: false
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function snapshotFingerprint(contract) {
  return crypto
    .createHash('sha256')
    .update(stableSerialize(contract))
    .digest('hex');
}

async function resolveInferenceContractSnapshot(input = {}, deps = {}) {
  const contract = await resolveInferenceContract({
    model: input.model,
    host: input.host,
    requestedNumCtx: input.requestedNumCtx,
    numCtxSource: input.numCtxSource,
    requestedMaxOutputTokens: input.requestedMaxOutputTokens
  }, { ...deps, includeArtifactIdentity: true });
  return {
    ...contract,
    snapshot: {
      schemaVersion: 1,
      fingerprint: snapshotFingerprint(contract),
      resolvedAt: (deps.now || new Date()).toISOString(),
      scope: 'deployed_artifact_host',
      freezeRecommended: true,
      reusePolicy: 'resolve_once_per_campaign'
    }
  };
}

module.exports = {
  CONTRACT_VERSION,
  estimateInputTokens,
  getThinkingCapabilityStatus,
  hasQualifiedThinkingCapability,
  modelLookupNames,
  readArtifactDigest,
  resolveCapabilities,
  resolveCapabilityContract,
  resolveContextBudget,
  resolveHostIdentity,
  resolveInferenceContract,
  resolveInferenceContractSnapshot,
  snapshotFingerprint
};

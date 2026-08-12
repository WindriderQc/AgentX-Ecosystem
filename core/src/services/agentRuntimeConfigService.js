'use strict';

/**
 * Agent runtime config export.
 *
 * Read-only source-of-truth view for runtimes that sit outside AgentX but
 * must stay aligned with AgentX model/context policy. This intentionally does
 * not write Hermes/OpenClaw files; protected runtime configs should be updated
 * by an operator or a separately approved sync step.
 */

const ModelRegistry = require('../../models/ModelRegistry');
const hostPrefService = require('./hostPreferenceService');
const { buildRouterConfigPayload } = require('./modelRouterConfig');
const { getContextInfo } = require('./modelContextInfoService');
const { modelsMatch } = require('../helpers/modelNameNormalization');
const {
  getThinkingCapabilityStatus,
  resolveInferenceContract
} = require('./inferenceContractService');

const DEFAULT_CORE_BASE_URL = 'http://localhost:3080';
const DEFAULT_OPERATIONAL_CONTEXT_CAP = 131072;
const HERMES_AUTHORITY_DECISION_DATE = '2026-07-02';
const DEFAULT_HERMES_AUTHORITY_MODEL = 'openrouter/z-ai/glm-5.2';
const DEFAULT_HERMES_CLOUD_CONTEXT = 131072;

const LANE_EXECUTION_POLICIES = Object.freeze({
  daily: Object.freeze({
    responseMode: 'native',
    thinkingMode: 'auto',
    visibleFinalRequired: true
  }),
  codingSpecialist: Object.freeze({
    responseMode: 'final_only',
    thinkingMode: 'off',
    visibleFinalRequired: true,
    recommendedOutputTokens: 4096
  }),
  masterBrain: Object.freeze({
    responseMode: 'explicit_thinking',
    thinkingMode: 'on',
    visibleFinalRequired: true,
    recommendedOutputTokens: 4096,
    measuredLatencyCaveatMs: 36008
  })
});

function cleanBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_CORE_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function operationalContextCap() {
  return positiveInteger(
    process.env.MODEL_CONTEXT_OPERATIONAL_CAP
      || process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP
      || DEFAULT_OPERATIONAL_CONTEXT_CAP
  );
}

function applyOperationalContextCap(lane, warnings) {
  const cap = operationalContextCap();
  if (!cap || !lane.contextSize || lane.contextSize <= cap) return lane;
  warnings.push(`Capping ${lane.role} runtime context from ${lane.contextSize} to ${cap}; verified/profiled context remains visible in contextInfo.`);
  return {
    ...lane,
    verifiedContextSize: lane.contextSize,
    operationalContextCap: cap,
    contextSize: cap,
    contextSource: `${lane.contextSource || 'context_info'}_operational_cap`
  };
}

function applyContractContextBudget(lane, contract) {
  const contextBudget = contract?.contextBudget || null;
  if (!contextBudget) return lane;

  const validatedWindowTokens = positiveInteger(contextBudget.validatedWindowTokens);
  const contractWindowTokens = validatedWindowTokens || positiveInteger(contextBudget.windowTokens);
  const resolvedSource = contextBudget.resolvedSource || contextBudget.source || 'inference_contract';
  const withBudget = { ...lane, contextBudget };

  if (!contractWindowTokens || contractWindowTokens === lane.contextSize) return withBudget;

  if (lane.pinAligned) {
    lane.warnings.push(
      `Pinned ${lane.role} context ${lane.contextSize} differs from inference-contract context ${contractWindowTokens}; preserving the operator pin to avoid an implicit resident-model reload.`
    );
    return withBudget;
  }

  lane.warnings.push(
    `Using inference-contract context ${contractWindowTokens} for ${lane.model} instead of discovered context ${lane.contextSize}.`
  );
  return {
    ...withBudget,
    discoveredContextSize: lane.contextSize,
    contextSize: contractWindowTokens,
    contextSource: `inference_contract_${resolvedSource}`
  };
}

function shortName(modelName) {
  return String(modelName || 'unknown')
    .toLowerCase()
    .replace(/[:/]/g, '-')
    .replace(/\.(?=\d)/g, '')
    .replace(/-instruct-q\d+_k_m/i, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}

function adaptedModelName(modelName) {
  const raw = String(modelName || '').trim();
  if (!raw || raw.includes('/')) return null;
  return `ax/${raw}`;
}

function providerUrl(provider) {
  return provider?.apiBase || provider?.baseURL || provider?.baseUrl || provider?.url || null;
}

function urlsSame(left, right) {
  return String(left || '').replace(/\/+$/, '') === String(right || '').replace(/\/+$/, '');
}

function aliasBaseUrl(alias) {
  return alias?.baseUrl || alias?.base_url || alias?.apiBase || null;
}

function openClawProviderCandidates(providers, expectedOpenClaw) {
  const rows = [];
  const seen = new Set();
  function push(id, alias = null) {
    if (!id || seen.has(id) || !providers[id]) return;
    seen.add(id);
    rows.push({ id, provider: providers[id], alias });
  }
  push(expectedOpenClaw.providerId);
  for (const alias of asArray(expectedOpenClaw.providerAliases)) {
    push(alias.id, alias);
  }
  return rows;
}

function providerBaseAligned(candidate, expectedUrl) {
  const currentUrl = providerUrl(candidate.provider);
  const allowed = [expectedUrl, aliasBaseUrl(candidate.alias)].filter(Boolean);
  if (!allowed.length || !currentUrl) return true;
  return allowed.some((url) => urlsSame(currentUrl, url));
}

function findContextOverride(providerId, modelId, context, expectedOpenClaw) {
  return asArray(expectedOpenClaw.contextOverrides).find((row) => {
    const overrideContext = positiveInteger(row?.contextWindow || row?.context_window || row?.params?.num_ctx);
    return row?.provider === providerId &&
      modelsMatch(modelId, row?.model) &&
      overrideContext &&
      context === overrideContext;
  }) || null;
}

function isCloudModel(model) {
  return /^[a-z0-9_-]+\//i.test(String(model || '')) && !String(model || '').toLowerCase().startsWith('ax/');
}

function firstPinnedEntry(pref) {
  return hostPrefService.getPinnedEntries(pref)[0] || null;
}

function findPinnedEntry(pref, model) {
  return hostPrefService.getPinnedEntries(pref).find((entry) => modelsMatch(entry.model, model)) || null;
}

function normalizeHostMap(prefs) {
  const byUrl = new Map();
  for (const pref of prefs || []) {
    if (pref?.hostUrl) byUrl.set(pref.hostUrl, pref);
  }
  return byUrl;
}

async function resolveLane(taskType, role, routerConfig, prefsByUrl) {
  const task = routerConfig.taskModels?.[taskType] || routerConfig.defaults?.taskModels?.general_chat;
  const hostKey = task?.host || null;
  const hostUrl = hostKey ? routerConfig.hosts?.[hostKey] : null;
  const taskModel = task?.model || null;
  let model = taskModel;
  const pref = hostUrl ? prefsByUrl.get(hostUrl) : null;
  const pinnedEntry = pref && taskModel ? findPinnedEntry(pref, taskModel) : null;
  const primaryPinnedEntry = pref ? firstPinnedEntry(pref) : null;
  const warnings = [];

  if (pinnedEntry?.model) model = pinnedEntry.model;

  let contextSize = positiveInteger(pinnedEntry?.contextSize);
  let contextSource = contextSize ? 'host_preference_pin' : null;
  let contextInfo = null;

  if (!hostUrl) warnings.push(`No host URL configured for host key ${hostKey || '(missing)'}`);
  if (!taskModel) warnings.push(`No model configured for task ${taskType}`);
  if (taskModel && pref && !pinnedEntry) {
    warnings.push(`Task model ${taskModel} is not pinned on ${pref.displayName || hostUrl}; using context-info fallback.`);
  }

  if (!contextSize && taskModel) {
    try {
      contextInfo = await getContextInfo(taskModel, hostUrl);
      model = taskModel;

      const adapted = adaptedModelName(taskModel);
      if (adapted && contextInfo?.source !== 'modelfile') {
        const adaptedInfo = await getContextInfo(adapted, hostUrl);
        if (adaptedInfo?.source === 'modelfile' && positiveInteger(adaptedInfo.num_ctx)) {
          contextInfo = adaptedInfo;
          model = adapted;
          warnings.push(`Exporting adapted runtime model ${adapted} for task model ${taskModel} to preserve Modelfile context.`);
        }
      }

      contextSize = positiveInteger(contextInfo?.num_ctx);
      contextSource = contextInfo?.source || 'context_info';
    } catch (err) {
      warnings.push(`Could not resolve context info for ${taskModel}: ${err.message}`);
    }
  }

  if (!contextSize) {
    contextSize = 8192;
    contextSource = 'fallback';
    warnings.push(`Falling back to ${contextSize} context for ${model || taskType}`);
  }

  const lane = {
    role,
    taskType,
    taskModel,
    model,
    hostKey,
    hostUrl,
    contextSize,
    contextSource,
    pinAligned: Boolean(pinnedEntry),
    pinnedModel: pinnedEntry?.model || null,
    primaryPinnedModel: primaryPinnedEntry?.model || null,
    keepAlive: pinnedEntry?.keepAlive ?? null,
    autoRestore: pinnedEntry?.autoRestore ?? null,
    hostPreference: pref ? {
      displayName: pref.displayName || null,
      status: pref.status || null,
      loadedModel: pref.loadedModel || null,
      loadedModels: pref.loadedModels || [],
      maxConcurrentModels: pref.maxConcurrentModels || null,
      vramTotalMiB: pref.vramTotalMiB || null
    } : null,
    contextInfo,
    executionPolicy: LANE_EXECUTION_POLICIES[role] || null,
    warnings
  };

  return applyOperationalContextCap(lane, warnings);
}

function toOpenClawModel(lane) {
  const thinking = getThinkingCapabilityStatus(lane.capabilityContract);
  return {
    id: lane.model,
    name: shortName(lane.model),
    reasoning: thinking.qualified,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: positiveInteger(lane.executionPolicy?.recommendedOutputTokens) || 8192,
    contextWindow: lane.contextSize,
    params: { num_ctx: lane.contextSize },
    _source: {
      agentxRuntimeConfig: true,
      role: lane.role,
      taskType: lane.taskType,
      host: lane.hostUrl,
      hostKey: lane.hostKey,
      contextSource: lane.contextSource,
      pinAligned: lane.pinAligned,
      thinkingSource: thinking.source,
      thinkingQualified: thinking.qualified,
      thinkingQualificationState: thinking.qualificationState,
      executionPolicy: lane.executionPolicy
    }
  };
}

function buildHermesExport(lanes, coreBaseUrl) {
  const daily = lanes.daily;
  const codingSpecialist = lanes.codingSpecialist;
  const masterBrain = lanes.masterBrain;
  const baseUrl = `${coreBaseUrl}/api/hermes-openai/v1`;
  const authorityModel = String(process.env.HERMES_AUTHORITY_MODEL || DEFAULT_HERMES_AUTHORITY_MODEL).trim();
  const authorityContext = positiveInteger(process.env.HERMES_AUTHORITY_CONTEXT)
    || (isCloudModel(authorityModel) ? DEFAULT_HERMES_CLOUD_CONTEXT : daily.contextSize);
  const authorityIsCloud = isCloudModel(authorityModel);

  const defaultModelConfig = {
    default: authorityModel || daily.model,
    provider: 'custom',
    base_url: baseUrl,
    context_length: authorityContext,
    api_key: 'no-key-required'
  };

  if (!authorityIsCloud) {
    defaultModelConfig.ollama_num_ctx = authorityContext;
  }

  const localFallbackModelConfig = {
    default: daily.model,
    provider: 'custom',
    base_url: baseUrl,
    context_length: daily.contextSize,
    api_key: 'no-key-required',
    ollama_num_ctx: daily.contextSize
  };

  const masterBrainModelConfig = {
    default: masterBrain.model,
    provider: 'custom',
    base_url: baseUrl,
    context_length: masterBrain.contextSize,
    api_key: 'no-key-required',
    ollama_num_ctx: masterBrain.contextSize
  };

  const codingSpecialistModelConfig = {
    default: codingSpecialist.model,
    provider: 'custom',
    base_url: baseUrl,
    context_length: codingSpecialist.contextSize,
    api_key: 'no-key-required',
    ollama_num_ctx: codingSpecialist.contextSize
  };

  return {
    proxyBaseUrl: baseUrl,
    defaultModelConfig,
    localFallbackModelConfig,
    codingSpecialistModelConfig,
    masterBrainModelConfig,
    authority: {
      policy: 'cloud_first_via_agentx_proxy',
      decisionDate: HERMES_AUTHORITY_DECISION_DATE,
      expectedBaseUrl: baseUrl,
      expectedModel: defaultModelConfig.default,
      expectedContext: defaultModelConfig.context_length,
      localFallbackModel: daily.model,
      localFallbackContext: daily.contextSize,
      liveConfigValidation: 'protected_human_gated',
      directRuntimeBypass: 'pending_drift_until_classified',
      credentialPolicy: authorityIsCloud
        ? 'provider key stays server-side in AgentX environment'
        : 'no provider key required for local model'
    },
    notes: [
      'Use defaultModelConfig for the Hermes command gateway. It must point at the AgentX proxy, not directly at a provider or Ollama host.',
      'Use localFallbackModelConfig only when cloud routing is intentionally unavailable or denied by policy.',
      'Use codingSpecialistModelConfig for explicit coding work; its final-only mode and output budget are declared in lanes.codingSpecialist.executionPolicy.',
      'Use masterBrainModelConfig only for an explicit quality-max lane; do not make it a second pinned default unless VRAM headroom is validated.'
    ]
  };
}

function buildOpenClawExport(lanes, coreBaseUrl) {
  const models = [];
  const seenModels = new Set();
  for (const lane of [lanes.daily, lanes.codingSpecialist, lanes.masterBrain]) {
    if (!lane?.model || seenModels.has(lane.model)) continue;
    seenModels.add(lane.model);
    models.push(toOpenClawModel(lane));
  }
  const apiBase = `${coreBaseUrl}/api/openclaw-ollama`;

  return {
    providerId: 'ollama',
    provider: {
      apiBase,
      api: 'ollama',
      authHeader: false,
      apiKey: 'ollama-local',
      models
    },
    defaults: {
      primary: `ollama/${lanes.daily.model}`,
      codingSpecialist: lanes.codingSpecialist.model ? `ollama/${lanes.codingSpecialist.model}` : null,
      masterBrain: lanes.masterBrain.model ? `ollama/${lanes.masterBrain.model}` : null
    },
    providerAliases: [
      {
        id: 'host-alpha-ollama',
        aliasOf: 'ollama',
        baseUrl: apiBase,
        status: 'intentional_compatibility_alias',
        reason: 'OpenClaw specialist model chains keep the Host Alpha provider label while routing through the AgentX OpenClaw proxy.'
      },
      {
        id: 'host-gamma-ollama',
        aliasOf: 'host-alpha-ollama',
        baseUrl: apiBase,
        status: 'legacy_live_session_alias',
        reason: 'Historical live session labels may still report host-gamma-ollama; treat as a stale compatibility alias, not an active route target.'
      }
    ],
    contextOverrides: [],
    notes: [
      'Patch the existing provider block; do not add a second direct-Host Gamma provider for daily traffic.',
      'host-alpha-ollama is an OpenClaw compatibility alias over the same AgentX proxy base URL, not a direct Ollama host route.',
      'contextWindow and params.num_ctx must stay equal to the lane contextSize resolved from AgentX profile/contract sources; do not restore historical hard-coded context overrides.',
      'The coding specialist is final-only. The quality-max lane requires explicit thinking and a visible final answer.'
    ]
  };
}

function parseParameterB(modelName, parameterSize) {
  const fromSize = String(parameterSize || '').match(/(\d+(?:\.\d+)?)\s*B/i);
  if (fromSize) return Number(fromSize[1]);
  const fromName = String(modelName || '').match(/(?:^|[:/_-])(\d+(?:\.\d+)?)b(?:$|[:/_-])/i);
  return fromName ? Number(fromName[1]) : null;
}

async function listMasterBrainCandidates(primaryHostUrl, dailyModel, currentMasterModel) {
  try {
    const docs = await ModelRegistry.find({
      isActive: { $ne: false },
      status: { $ne: 'retired' }
    })
      .select('modelName sourceHost parameterSize quantization family capabilities categories')
      .sort({ modelName: 1 })
      .lean();

    return docs
      .map((doc) => {
        const parameterB = parseParameterB(doc.modelName, doc.parameterSize);
        return {
          model: doc.modelName,
          host: doc.sourceHost || null,
          parameterB,
          quantization: doc.quantization || null,
          family: doc.family || null,
          currentMaster: modelsMatch(doc.modelName, currentMasterModel),
          dailyModel: modelsMatch(doc.modelName, dailyModel)
        };
      })
      .filter((candidate) => {
        if (candidate.dailyModel) return false;
        if (candidate.host && primaryHostUrl && candidate.host !== primaryHostUrl) return false;
        if (/qwen2\.5:72b-instruct-q3_k_m/i.test(candidate.model)) return false;
        if (/llama3\.3:70b-instruct-q4_k_m-(8k|16k)$/i.test(candidate.model)) return false;
        return candidate.currentMaster || (candidate.parameterB != null && candidate.parameterB >= 30);
      })
      .sort((left, right) => {
        if (left.currentMaster !== right.currentMaster) return left.currentMaster ? -1 : 1;
        return (right.parameterB || 0) - (left.parameterB || 0);
      })
      .slice(0, 12);
  } catch {
    return [];
  }
}

function diffField(path, current, expected) {
  return { path, current: current === undefined ? null : current, expected };
}

function compareHermesConfig(currentConfig, expectedHermes) {
  if (!currentConfig) return { status: 'not_checked', drift: [], missing: ['hermesConfig'] };
  const current = currentConfig.model || currentConfig;
  const expected = expectedHermes.defaultModelConfig;
  const checks = [
    ['model.default', current.default, expected.default],
    ['model.provider', current.provider, expected.provider],
    ['model.base_url', current.base_url, expected.base_url],
    ['model.context_length', positiveInteger(current.context_length), expected.context_length],
    ['model.ollama_num_ctx', positiveInteger(current.ollama_num_ctx), expected.ollama_num_ctx]
  ].filter(([, , wanted]) => wanted !== undefined && wanted !== null);

  const drift = checks
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([path, actual, wanted]) => diffField(path, actual, wanted));

  return { status: drift.length ? 'drift' : 'ok', drift };
}

function compareOpenClawConfig(currentConfig, expectedOpenClaw) {
  if (!currentConfig) return { status: 'not_checked', drift: [], missing: ['openclawConfig'] };
  const providers = currentConfig.models?.providers || {};
  const providerCandidates = openClawProviderCandidates(providers, expectedOpenClaw);
  if (!providerCandidates.length) {
    return {
      status: 'drift',
      drift: [diffField(`models.providers.${expectedOpenClaw.providerId}`, null, 'provider block or documented alias present')]
    };
  }

  const drift = [];
  const expectedUrl = expectedOpenClaw.provider.apiBase;
  for (const candidate of providerCandidates) {
    const currentUrl = providerUrl(candidate.provider);
    if (!providerBaseAligned(candidate, expectedUrl)) {
      drift.push(diffField(`models.providers.${candidate.id}.apiBase`, currentUrl, expectedUrl));
    }
  }

  for (const expectedModel of expectedOpenClaw.provider.models) {
    const match = providerCandidates
      .map((candidate) => ({
        candidate,
        model: asArray(candidate.provider.models).find((model) => modelsMatch(model?.id, expectedModel.id))
      }))
      .find((row) => row.model);
    const currentModel = match?.model || null;
    if (!currentModel) {
      drift.push(diffField(`models.providers.${expectedOpenClaw.providerId}.models[${expectedModel.id}]`, null, 'model entry present'));
      continue;
    }
    const currentContext = positiveInteger(currentModel.contextWindow);
    const currentNumCtx = positiveInteger(currentModel.params?.num_ctx);
    const contextOverride = findContextOverride(match.candidate.id, currentModel.id, currentContext, expectedOpenClaw);
    const numCtxOverride = findContextOverride(match.candidate.id, currentModel.id, currentNumCtx, expectedOpenClaw);
    const pathPrefix = `models.providers.${match.candidate.id}.models[${expectedModel.id}]`;
    if (currentContext !== expectedModel.contextWindow && !contextOverride) {
      drift.push(diffField(
        `${pathPrefix}.contextWindow`,
        currentContext,
        expectedModel.contextWindow
      ));
    }
    if (currentNumCtx !== expectedModel.params.num_ctx && !numCtxOverride) {
      drift.push(diffField(
        `${pathPrefix}.params.num_ctx`,
        currentNumCtx,
        expectedModel.params.num_ctx
      ));
    }
  }

  return { status: drift.length ? 'drift' : 'ok', drift };
}

async function buildAgentRuntimeConfigExport(options = {}) {
  const coreBaseUrl = cleanBaseUrl(options.coreBaseUrl || process.env.CORE_PUBLIC_URL);
  const [routerConfig, prefs] = await Promise.all([
    buildRouterConfigPayload(options.routerOptions || {}),
    hostPrefService.getAll()
  ]);

  const prefsByUrl = normalizeHostMap(prefs);
  const resolvedLanes = {
    daily: await resolveLane('daily_operator', 'daily', routerConfig, prefsByUrl),
    codingSpecialist: await resolveLane('code_generation', 'codingSpecialist', routerConfig, prefsByUrl),
    masterBrain: await resolveLane('master_brain', 'masterBrain', routerConfig, prefsByUrl)
  };
  const contractResolver = options.resolveInferenceContract
    || options.resolveCapabilityContract
    || resolveInferenceContract;
  const laneEntries = await Promise.all(Object.values(resolvedLanes).map(async (lane) => {
    try {
      const capabilityContract = await contractResolver({
        model: lane.model,
        host: lane.hostUrl,
        requestedMaxOutputTokens: lane.executionPolicy?.recommendedOutputTokens
      });
      const budgetedLane = applyContractContextBudget(lane, capabilityContract);
      return [lane.role, { ...budgetedLane, capabilityContract }];
    } catch (err) {
      lane.warnings.push(`Could not resolve capability contract for ${lane.model}: ${err.message}`);
      return [lane.role, lane];
    }
  }));
  const lanes = Object.fromEntries(laneEntries);

  const openclaw = buildOpenClawExport(lanes, coreBaseUrl);

  const exportData = {
    generatedAt: new Date().toISOString(),
    sourceOfTruth: {
      routing: '/api/nerve-center/routing/config',
      hostPreferences: '/api/nerve-center/host-preferences',
      agentRuntimeExport: '/api/nerve-center/agent-runtime-config/export'
    },
    coreBaseUrl,
    lanes,
    hermes: buildHermesExport(lanes, coreBaseUrl),
    openclaw,
    warnings: Object.values(lanes).flatMap((lane) => lane.warnings)
  };

  if (options.includeCandidates !== false) {
    exportData.masterBrainCandidates = await listMasterBrainCandidates(
      lanes.daily.hostUrl,
      lanes.daily.model,
      lanes.masterBrain.model
    );
  }

  return exportData;
}

function validateRuntimeConfigs(exportData, current = {}) {
  return {
    hermes: compareHermesConfig(current.hermesConfig, exportData.hermes),
    openclaw: compareOpenClawConfig(current.openclawConfig, exportData.openclaw)
  };
}

module.exports = {
  buildAgentRuntimeConfigExport,
  validateRuntimeConfigs,
  compareHermesConfig,
  compareOpenClawConfig,
  cleanBaseUrl,
  shortName,
  parseParameterB
};

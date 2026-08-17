'use strict';

const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { ESCALATION_TARGETS } = require('./nestorEscalationPolicyService');

const DEFAULT_CORE_BASE_URL = 'http://127.0.0.1:3080';
const DEFAULT_MCP_TOOLS = [
  'agentx__check_health',
  'agentx__get_escalation_recommendation',
  'agentx__create_todo',
  'agentx__ecosystem_snapshot',
  'agentx__rag_search',
  'agentx__save_memory'
];

function getRepoRoot(env = process.env) {
  return env.AGENTX_REPO_ROOT || path.resolve(__dirname, '../../..');
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function coreBaseUrl(env = process.env) {
  return stripTrailingSlash(env.CORE_PUBLIC_URL || DEFAULT_CORE_BASE_URL);
}

function endpoint(env, suffix) {
  return `${coreBaseUrl(env)}${suffix}`;
}

function boolEnv(env, key, fallback = false) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function intEnv(env, key, fallback) {
  const parsed = parseInt(env[key], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function modelSummary(model = {}) {
  const primary = model.primary || model.current_primary || model.daily_model || '';
  const fallbacks = asArray(model.fallbacks || model.current_fallbacks);
  return {
    primary,
    fallbacks,
    selectionPolicy: model.selection_policy || '',
    dailyModel: model.daily_model || '',
    deepReflectionModel: model.deepcoding_reflection_model || ''
  };
}

function summarizeAgent(id, agent = {}) {
  return {
    id,
    available: Boolean(agent && Object.keys(agent).length > 0),
    type: agent.type || 'unknown',
    runtime: agent.runtime || '',
    roleDocs: asArray(agent.role_docs),
    model: modelSummary(agent.model || {}),
    boundary: agent.boundary || ''
  };
}

async function readRegistry(repoRoot = getRepoRoot()) {
  const registryPath = path.join(repoRoot, 'config', 'agent-registry.yml');
  const raw = await fs.readFile(registryPath, 'utf8');
  return yaml.load(raw) || {};
}

async function loadRegistry(repoRoot) {
  try {
    return { registry: await readRegistry(repoRoot), warnings: [] };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        registry: {},
        warnings: [`Missing config/agent-registry.yml at ${repoRoot}`]
      };
    }
    throw err;
  }
}

function buildDispositions({ ragEnabled, mcpTokenConfigured }) {
  return [
    {
      key: 'answer_light',
      label: 'Answer Light',
      axis: 'Answer',
      weight: 'Light',
      route: 'Nestor local answer',
      mode: 'inline',
      state: ragEnabled ? 'good' : 'warn',
      status: ragEnabled ? 'RAG reflex on' : 'RAG reflex off',
      sideFeatures: ['RAG retrieval', 'memory context', 'local fallback']
    },
    {
      key: 'answer_heavy',
      label: 'Answer Heavy',
      axis: 'Answer',
      weight: 'Heavy',
      route: 'Budget gate -> cloud specialist',
      mode: 'delegated answer',
      state: 'neutral',
      status: 'budget gated',
      sideFeatures: ['cloudx', 'anthropicx', 'budget health']
    },
    {
      key: 'do_light',
      label: 'Do Light',
      axis: 'Do',
      weight: 'Light',
      route: 'MCP skill bus',
      mode: 'single tool call',
      state: mcpTokenConfigured ? 'good' : 'warn',
      status: mcpTokenConfigured ? 'MCP token set' : 'MCP token not set',
      sideFeatures: ['health check', 'ecosystem snapshot', 'RAG search', 'memory write']
    },
    {
      key: 'do_heavy',
      label: 'Do Heavy',
      axis: 'Do',
      weight: 'Heavy',
      route: 'Mongo pipeline API -> worker',
      mode: 'tracked worker task',
      state: 'good',
      status: 'Mongo pipeline writer available',
      sideFeatures: ['/api/pipeline', 'pipelinetasks (Mongo)', 'Overseer', 'Worker protocol']
    }
  ];
}

function buildConfigRows({ main, escalation, openclawRuntime, hermesRuntime, env, targetIds, ragEnabled, mcpTokenConfigured }) {
  const model = modelSummary(main.model || {});
  return [
    { group: 'Front Door', key: 'Persona', value: main.persona || 'Nestor', source: 'agents.main.persona' },
    { group: 'Front Door', key: 'Runtime', value: main.runtime || 'openclaw', source: 'agents.main.runtime' },
    { group: 'Front Door', key: 'Primary Model', value: model.primary || '--', source: 'agents.main.model.primary' },
    { group: 'Front Door', key: 'Fallbacks', value: model.fallbacks.join(' -> ') || '--', source: 'agents.main.model.fallbacks' },
    { group: 'Answer Heavy', key: 'Budget Gate', value: escalation.budget_gate || endpoint(env, '/api/budget/escalation-recommendation'), source: 'agents.main.answer_heavy_escalation.budget_gate' },
    { group: 'Answer Heavy', key: 'Targets', value: targetIds.join(', ') || '--', source: 'agents.main.answer_heavy_escalation.targets' },
    { group: 'Answer Heavy', key: 'Live Apply', value: escalation.live_apply || 'Human-gated runtime change only', source: 'agents.main.answer_heavy_escalation.live_apply' },
    { group: 'Answer Light', key: 'RAG Reflex', value: ragEnabled ? 'enabled' : 'disabled', source: 'PROXY_RAG_REFLEX' },
    { group: 'Answer Light', key: 'RAG Top K', value: String(intEnv(env, 'PROXY_RAG_REFLEX_TOPK', 4)), source: 'PROXY_RAG_REFLEX_TOPK' },
    { group: 'Do Light', key: 'MCP Auth', value: mcpTokenConfigured ? 'token configured' : 'token not configured', source: 'AGENTX_MCP_TOKEN' },
    { group: 'Do Light', key: 'MCP Endpoint', value: endpoint(env, '/mcp'), source: 'runtimes.openclaw.mcp_skill_bus.url' },
    { group: 'Do Heavy', key: 'Pipeline Endpoint', value: endpoint(env, '/api/pipeline/tasks'), source: 'core route' },
    { group: 'Runtime', key: 'OpenClaw Base URL', value: openclawRuntime.base_url || endpoint(env, '/api/openclaw-ollama'), source: 'runtimes.openclaw.base_url' },
    { group: 'Runtime', key: 'Hermes Base URL', value: hermesRuntime.base_url || endpoint(env, '/api/hermes-openai/v1'), source: 'runtimes.hermes.base_url' },
    { group: 'Runtime', key: 'Hermes Authority', value: hermesRuntime.authority_policy?.policy || 'agentx_proxy', source: 'runtimes.hermes.authority_policy.policy' }
  ];
}

async function buildNestorFastlaneConfig(options = {}) {
  const env = options.env || process.env;
  const repoRoot = options.repoRoot || getRepoRoot(env);
  const loaded = options.registry
    ? { registry: options.registry, warnings: [] }
    : await loadRegistry(repoRoot);

  const registry = loaded.registry || {};
  const agents = registry.agents || {};
  const runtimes = registry.runtimes || {};
  const main = agents.main || {};
  const escalation = main.answer_heavy_escalation || {};
  const openclawRuntime = runtimes.openclaw || {};
  const hermesRuntime = runtimes.hermes || {};
  const targetIds = asArray(escalation.targets).length ? asArray(escalation.targets) : ESCALATION_TARGETS;
  const ragEnabled = boolEnv(env, 'PROXY_RAG_REFLEX');
  const mcpTokenConfigured = Boolean(env.AGENTX_MCP_TOKEN);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      registry: 'config/agent-registry.yml',
      roleDocs: asArray(main.role_docs),
      repoRoot
    },
    uiPolicy: {
      mode: 'read_only',
      liveApplyFromUi: false,
      reason: 'Provider auth, secret state, and .66 OpenClaw runtime changes remain human-gated.'
    },
    frontDoor: {
      id: 'main',
      persona: main.persona || 'Nestor',
      runtime: main.runtime || 'openclaw',
      type: main.type || 'openclaw_front_door',
      canonicalPersonaDoc: main.canonical_persona_doc || './roles/Nestor.md',
      roleDocs: asArray(main.role_docs),
      model: modelSummary(main.model || {}),
      boundary: main.boundary || ''
    },
    routingModel: {
      axes: ['answer_vs_do', 'light_vs_heavy'],
      dispositions: buildDispositions({ ragEnabled, mcpTokenConfigured })
    },
    controls: {
      budgetGate: {
        recommendationEndpoint: escalation.budget_gate || endpoint(env, '/api/budget/escalation-recommendation'),
        statusEndpoint: escalation.status_source || endpoint(env, '/api/budget/status'),
        policy: escalation.policy || { green: 'allow', yellow: 'limited', red: 'deny', unknown: 'deny' },
        targets: targetIds,
        liveApply: escalation.live_apply || 'Human-gated runtime change only'
      },
      ragReflex: {
        enabled: ragEnabled,
        envFlag: 'PROXY_RAG_REFLEX',
        topK: intEnv(env, 'PROXY_RAG_REFLEX_TOPK', 4),
        timeoutMs: intEnv(env, 'PROXY_RAG_REFLEX_TIMEOUT_MS', 2500),
        surfaces: ['Hermes OpenAI proxy', 'OpenClaw Ollama proxy'],
        behavior: 'Injects retrieved knowledge into Answer-Light and local fallback paths when enabled.'
      },
      mcpSkillBus: {
        endpoint: openclawRuntime.mcp_skill_bus?.url || endpoint(env, '/mcp'),
        tokenConfigured: mcpTokenConfigured,
        auth: openclawRuntime.mcp_skill_bus?.auth || 'Authorization header via AGENTX_MCP_TOKEN',
        serverName: openclawRuntime.mcp_skill_bus?.server_name || 'agentx',
        tools: asArray(openclawRuntime.mcp_skill_bus?.tools).length
          ? asArray(openclawRuntime.mcp_skill_bus.tools)
          : DEFAULT_MCP_TOOLS
      },
      memory: {
        writeEndpoint: endpoint(env, '/api/nestor/memory'),
        summaryEndpoint: endpoint(env, '/api/nestor/memory/summary'),
        ragTimeoutMs: intEnv(env, 'NESTOR_MEMORY_RAG_TIMEOUT_MS', 5000),
        source: 'nestor-memory'
      },
      todoMembrane: {
        endpoint: endpoint(env, '/api/pipeline/tasks'),
        sourceOfTruth: 'mongodb:pipelinetasks',
        humanBoard: 'Leantime AgentX Pipeline',
        collection: 'pipelinetasks',
        board: 'Leantime "AgentX Pipeline"',
        policy: 'Do-Heavy writes tracked work to the Mongo pipeline instead of executing uncontrolled multi-step ops inline.'
      },
      openclawRuntime: {
        host: openclawRuntime.host || 'host-delta',
        gatewayPort: openclawRuntime.gateway_port || 18789,
        provider: openclawRuntime.current_provider || 'agentx_openclaw_ollama_proxy',
        baseUrl: openclawRuntime.base_url || endpoint(env, '/api/openclaw-ollama'),
        context: openclawRuntime.context || null,
        localFallbackModel: openclawRuntime.local_fallback_model || '',
        providerAliases: asArray(openclawRuntime.provider_aliases || openclawRuntime.providerAliases),
        contextOverrides: asArray(openclawRuntime.context_overrides || openclawRuntime.contextOverrides),
        memoryPolicies: asArray(openclawRuntime.memory_policies || openclawRuntime.memoryPolicies)
      },
      hermesRuntime: {
        host: hermesRuntime.host || 'host-delta',
        provider: hermesRuntime.current_provider || 'agentx_hermes_openai_proxy',
        baseUrl: hermesRuntime.base_url || endpoint(env, '/api/hermes-openai/v1'),
        primaryModel: hermesRuntime.primary_model || '',
        context: hermesRuntime.context || null,
        authorityPolicy: hermesRuntime.authority_policy || null,
        cloudRouting: hermesRuntime.cloud_routing || null
      }
    },
    specialists: targetIds.map((id) => summarizeAgent(id, agents[id])),
    configRows: buildConfigRows({
      main,
      escalation,
      openclawRuntime,
      hermesRuntime,
      env,
      targetIds,
      ragEnabled,
      mcpTokenConfigured
    }),
    warnings: loaded.warnings
  };
}

module.exports = {
  buildNestorFastlaneConfig,
  readRegistry,
  getRepoRoot
};

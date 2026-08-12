'use strict';

const {
  buildOpenClawAgentInventory,
  remoteCliEnvPrefix,
  runOpenClawJson,
  runSshJson,
} = require('./openclawAgentInventoryService');

const CACHE_TTL_MS = Number(process.env.OPENCLAW_RUNTIME_EVIDENCE_CACHE_MS || 15_000);
const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.OPENCLAW_RUNTIME_COMMAND_TIMEOUT_MS || 25_000);
let cache = null;
let cacheExpiresAt = 0;
let inFlight = null;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function modelProvider(model) {
  const value = String(model || '');
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : 'ollama';
}

function summarizeCron(raw) {
  const jobs = asArray(raw?.jobs || raw?.data || raw).map((job) => ({
    id: job.id || null,
    name: job.name || job.id || 'Unnamed automation',
    description: job.description || '',
    enabled: job.enabled !== false,
    agentId: job.agentId || null,
    schedule: job.schedule || null,
    lastRunStatus: job.state?.lastRunStatus ?? job.lastRunStatus ?? null,
    lastStatus: job.state?.lastStatus ?? job.lastStatus ?? null,
    consecutiveErrors: Number(job.state?.consecutiveErrors ?? job.consecutiveErrors ?? 0),
    lastError: job.state?.lastError ?? job.lastError ?? null,
    lastDiagnosticSummary: job.state?.lastDiagnosticSummary ?? job.lastDiagnosticSummary ?? null,
    lastRunAtMs: job.state?.lastRunAtMs ?? job.lastRunAtMs ?? null,
    lastDurationMs: job.state?.lastDurationMs ?? job.lastDurationMs ?? null,
    nextRunAtMs: job.state?.nextRunAtMs ?? job.nextRunAtMs ?? null,
  }));
  return { available: Boolean(raw), count: jobs.length, jobs };
}

function summarizeSessions(raw) {
  const sessions = raw?.sessions || {};
  const recent = asArray(sessions.recent).slice(0, 100).map((session) => ({
    agentId: session.agentId || null,
    kind: session.kind || null,
    updatedAt: session.updatedAt || null,
    age: session.age || null,
    thinkingLevel: session.thinkingLevel || null,
    abortedLastRun: session.abortedLastRun === true,
    inputTokens: Number(session.inputTokens || 0),
    outputTokens: Number(session.outputTokens || 0),
    cacheRead: Number(session.cacheRead || 0),
    cacheWrite: Number(session.cacheWrite || 0),
    totalTokens: Number(session.totalTokens || 0),
    remainingTokens: session.remainingTokens ?? null,
    percentUsed: session.percentUsed ?? null,
    model: session.model || null,
    configuredModel: session.configuredModel || null,
    runtime: session.runtime || null,
    contextTokens: session.contextTokens ?? null,
    flags: asArray(session.flags),
  }));
  return { count: Number(sessions.count || recent.length), recent };
}

function summarizeStatus(raw, agentCount) {
  const gateway = raw?.gateway || {};
  const service = raw?.gatewayService || {};
  return {
    online: gateway.reachable === true || service.running === true || service.active === true,
    runtimeVersion: raw?.runtimeVersion || null,
    gateway: {
      url: gateway.url || process.env.OPENCLAW_GATEWAY_URL || null,
      reachable: gateway.reachable ?? null,
      latencyMs: gateway.connectLatencyMs ?? null,
      error: gateway.error || null,
    },
    gatewayService: {
      running: service.running ?? service.active ?? null,
      state: service.state || service.status || null,
    },
    agents: agentCount,
    sessions: summarizeSessions(raw),
  };
}

function summarizeModels(inventory) {
  const agents = asArray(inventory?.agents).map((agent) => ({
    id: agent.id,
    name: agent.name || agent.id,
    primary: agent.model?.primary || null,
    fallbacks: asArray(agent.model?.fallbacks),
  }));
  const defaults = inventory?.defaults?.model || {};
  const allModels = [
    defaults.primary,
    ...asArray(defaults.fallbacks),
    ...agents.flatMap((agent) => [agent.primary, ...agent.fallbacks]),
  ].filter(Boolean);
  return {
    default: defaults.primary || null,
    fallbacks: asArray(defaults.fallbacks),
    providers: [...new Set(allModels.map(modelProvider))].sort(),
    agents,
    liveModels: Object.fromEntries(agents.map((agent) => [agent.id, {
      provider: modelProvider(agent.primary),
      model: agent.primary,
      fullModel: agent.primary,
    }])),
  };
}

function summarizeMemory(raw) {
  const memory = raw?.memory || {};
  return {
    agentId: memory.agentId || null,
    backend: memory.backend || null,
    files: Number(memory.files || 0),
    chunks: Number(memory.chunks || 0),
    dirty: memory.dirty ?? null,
    provider: memory.provider || null,
    model: memory.model || null,
    sources: asArray(memory.sources),
    cache: { enabled: memory.cache?.enabled ?? null, entries: Number(memory.cache?.entries || 0) },
    fts: { enabled: memory.fts?.enabled ?? null, available: memory.fts?.available ?? null },
    vector: {
      enabled: memory.vector?.enabled ?? null,
      storeAvailable: memory.vector?.storeAvailable ?? null,
      dimensions: memory.vector?.dims ?? null,
    },
    indexStatus: memory.custom?.indexIdentity?.status || null,
  };
}

async function nativeJson(args, options) {
  const target = options.sshTarget || process.env.OPENCLAW_INVENTORY_SSH_TARGET;
  if (!target) return runOpenClawJson(args, options);
  const prefix = remoteCliEnvPrefix(options);
  return runSshJson(target, `${prefix}openclaw ${args.join(' ')} --json`, options);
}

async function collectOpenClawRuntimeEvidence(options = {}) {
  const runtimeOptions = {
    ...options,
    commandTimeoutMs: options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
  };
  const settled = await Promise.allSettled([
    buildOpenClawAgentInventory({
      ...runtimeOptions,
      includeAgentBindings: false,
      includeContent: false,
      includeMemoryStatus: false,
      includeRuntimeStatus: false,
      includePromptFiles: options.includePromptFiles === true,
    }),
    nativeJson(['status', '--all'], runtimeOptions),
    nativeJson(['cron', 'list'], runtimeOptions),
  ]);
  const issues = settled.filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || String(result.reason));
  const inventory = settled[0].status === 'fulfilled'
    ? settled[0].value
    : { agents: [], defaults: {}, source: { degraded: true, issues: [issues[0]] } };
  const statusRaw = settled[1].status === 'fulfilled' ? settled[1].value : null;
  const cronRaw = settled[2].status === 'fulfilled' ? settled[2].value : null;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    authority: 'official-openclaw-cli',
    source: {
      inventory: inventory.source || null,
      status: statusRaw ? 'openclaw status --json --all' : 'unavailable',
      cron: cronRaw ? 'openclaw cron list --json' : 'unavailable',
      degraded: issues.length > 0 || inventory.source?.degraded === true,
      issues: [...asArray(inventory.source?.issues), ...issues],
    },
    status: summarizeStatus(statusRaw, asArray(inventory.agents).length),
    defaults: inventory.defaults || {},
    memoryStrategy: inventory.memory_strategy || null,
    memory: summarizeMemory(statusRaw),
    agents: asArray(inventory.agents),
    inactiveWorkspaces: asArray(inventory.inactiveWorkspaces),
    knownGaps: asArray(inventory.known_gaps),
    cron: summarizeCron(cronRaw),
    models: summarizeModels(inventory),
  };
}

async function getOpenClawRuntimeEvidence(options = {}) {
  if (!options.refresh && cache && Date.now() < cacheExpiresAt) return cache;
  if (!options.refresh && inFlight) return inFlight;
  inFlight = collectOpenClawRuntimeEvidence(options)
    .then((result) => {
      cache = result;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return result;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function clearOpenClawRuntimeEvidenceCache() {
  cache = null;
  cacheExpiresAt = 0;
}

module.exports = {
  collectOpenClawRuntimeEvidence,
  getOpenClawRuntimeEvidence,
  clearOpenClawRuntimeEvidenceCache,
  summarizeCron,
  summarizeMemory,
  summarizeModels,
  summarizeSessions,
  summarizeStatus,
};

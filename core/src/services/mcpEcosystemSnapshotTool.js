'use strict';

const FULL_SNAPSHOT_CAPS = {
  prompts: 25,
  pipelineActive: 40,
  alertsActive: 40,
  providerModels: 50,
  hostTopModels: 8,
};

class McpSnapshotToolError extends Error {
  constructor(message, { code = 'MCP_TOOL_ERROR', status = 400 } = {}) {
    super(message);
    this.name = 'McpSnapshotToolError';
    this.code = code;
    this.status = status;
  }
}

function ensurePlainObject(value, field = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpSnapshotToolError(`${field} must be an object`, { code: 'INVALID_ARGUMENTS' });
  }
  return value;
}

function clampInteger(value, { min, max, fallback }) {
  const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
  return Math.max(min, Math.min(max, n));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function getEcosystemSnapshotService() {
  return require('./ecosystemSnapshotService');
}

async function defaultEcosystemSnapshot() {
  return getEcosystemSnapshotService().buildEcosystemSnapshot();
}

function redactForMcp(value) {
  return getEcosystemSnapshotService().redactSecrets(value);
}

function normalizeSnapshotMode(value, hasAgentId) {
  if (!value && hasAgentId) return 'agent';
  if (!value) return 'compact';
  const key = String(value).trim().toLowerCase().replace(/[-_\s]/g, '');
  if (key === 'compact') return 'compact';
  if (key === 'driftonly') return 'driftOnly';
  if (key === 'full') return 'full';
  if (key === 'agent') return 'agent';
  throw new McpSnapshotToolError(`unsupported ecosystem snapshot mode: ${value}`, { code: 'INVALID_ARGUMENTS' });
}

function countBy(items, keyFn) {
  return asArray(items).reduce((acc, item) => {
    const key = keyFn(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function capArray(items, max) {
  return asArray(items).slice(0, max);
}

function summarizeSources(sources = {}) {
  const entries = Object.entries(sources).map(([name, source]) => ({
    name,
    status: source?.status || 'unknown',
    durationMs: source?.durationMs ?? null,
    issues: asArray(source?.issues),
    error: source?.error || null,
  }));
  return {
    total: entries.length,
    ok: entries.filter((source) => source.status === 'ok').length,
    degraded: entries.filter((source) => source.status !== 'ok').length,
    entries,
  };
}

function summarizeDriftRecords(records, limit = 100) {
  return capArray(records, limit).map((record) => ({
    id: record.id,
    severity: record.severity || 'medium',
    owner: record.owner || null,
    title: record.title || '',
    current: record.current ?? null,
    expected: record.expected ?? null,
    details: record.details || undefined,
  }));
}

function summarizeDrift(records, limit = 20) {
  const drift = asArray(records);
  return {
    count: drift.length,
    bySeverity: countBy(drift, (record) => record.severity || 'medium'),
    byOwner: countBy(drift, (record) => record.owner || 'unowned'),
    records: summarizeDriftRecords(drift, limit),
  };
}

function primaryModel(agent = {}) {
  const model = agent.model || {};
  return model.primary || model.current_primary || model.daily_model || agent.modelPrimary || null;
}

function fallbackModels(agent = {}) {
  const model = agent.model || {};
  return asArray(model.fallbacks || model.current_fallbacks || agent.modelFallbacks);
}

function compactAgent(agent, liveModels = {}) {
  if (!agent) return null;
  const id = agent.id || agent.name || 'unknown';
  const memory = agent.memory || null;
  return {
    id,
    name: agent.name || agent.persona || id,
    type: agent.type || (agent.runtime ? 'registry_agent' : 'openclaw_agent'),
    runtime: agent.runtime || null,
    active: agent.active !== false,
    default: Boolean(agent.default),
    primaryModel: primaryModel(agent),
    fallbackCount: fallbackModels(agent).length,
    liveModel: liveModels[id]?.fullModel || liveModels[id]?.model || null,
    memory: memory ? {
      classification: memory.classification || null,
      indexStatus: memory.indexStatus || null,
      dirty: memory.dirty ?? null,
      files: memory.files ?? null,
      chunks: memory.chunks ?? null,
      policyStatus: memory.policy?.status || null,
    } : null,
  };
}

function summarizeAgentRole(agent = {}) {
  const id = agent.id || agent.name || 'unknown';
  const kind = agent.type || (agent.runtime ? 'registry_agent' : 'openclaw_agent');
  return {
    id,
    name: agent.name || agent.persona || id,
    kind,
    persona: agent.persona || null,
    description: agent.description || agent.purpose || null,
    boundary: agent.boundary || null,
    roleDocs: asArray(agent.roleDocs || agent.role_docs),
  };
}

function summarizeHosts(hosts = {}) {
  return {
    summary: hosts.summary || {},
    preferences: capArray(hosts.preferences, 20).map((host) => ({
      displayName: host.displayName || host.hostId || host.hostUrl || null,
      hostKey: host.hostKey || null,
      persistedHostKey: host.persistedHostKey || null,
      status: host.status || null,
      hostUrl: host.hostUrl || null,
    })),
    capacity: capArray(hosts.capacity, 20).map((host) => ({
      configId: host.configId || null,
      hostId: host.hostId || null,
      hostname: host.hostname || null,
      status: host.status || null,
      ollamaReachable: host.ollamaReachable ?? null,
      verdict: host.verdict || null,
    })),
  };
}

function summarizeRuntimes(snapshot = {}) {
  const runtimes = snapshot.runtimes || {};
  const hermes = runtimes.hermes || {};
  const openclaw = runtimes.openclaw || {};
  return {
    core: {
      baseUrl: runtimes.core?.baseUrl || null,
    },
    hermes: {
      policy: hermes.expected?.authority?.policy || hermes.registryPolicy?.authorityPolicy?.policy || hermes.registryPolicy?.authority_policy?.policy || null,
      authorityStatus: hermes.authority?.status || null,
      expectedModel: hermes.expected?.model || null,
      registryModel: hermes.registryPolicy?.primaryModel || null,
      expectedContext: hermes.expected?.contextLength || null,
      registryContext: hermes.registryPolicy?.context || null,
      liveConfig: hermes.authority?.live?.configValidation || hermes.liveStatus?.liveConfig?.status || null,
    },
    openclaw: {
      expectedProvider: openclaw.expected?.providerId || null,
      registryProvider: openclaw.registryPolicy?.provider || null,
      apiBase: openclaw.expected?.apiBase || openclaw.registryPolicy?.baseUrl || null,
      context: openclaw.registryPolicy?.context || null,
      aliasCount: asArray(openclaw.expected?.providerAliases || openclaw.registryPolicy?.providerAliases).length,
      contextOverrideCount: asArray(openclaw.expected?.contextOverrides || openclaw.registryPolicy?.contextOverrides).length,
      memoryPolicyCount: asArray(openclaw.registryPolicy?.memoryPolicies || openclaw.registryPolicy?.memory_policies).length,
    },
    lanes: Object.fromEntries(Object.entries(runtimes.lanes || {}).map(([lane, config]) => [lane, {
      model: config?.model || null,
      hostKey: config?.hostKey || null,
      contextSize: config?.contextSize || config?.context || null,
    }])),
  };
}

function summarizeAgents(snapshot = {}) {
  const agents = snapshot.agents || {};
  const liveModels = snapshot.models?.liveModels || {};
  const openclaw = asArray(agents.openclaw).map((agent) => compactAgent(agent, liveModels));
  const specialists = asArray(agents.specialists).map((agent) => compactAgent(agent, liveModels));
  return {
    counts: {
      openclaw: openclaw.length,
      specialists: specialists.length,
      activeOpenclaw: openclaw.filter((agent) => agent.active !== false).length,
    },
    frontDoor: compactAgent(agents.frontDoor, liveModels),
    specialists,
    openclaw,
  };
}

function summarizeSchedules(schedules = {}) {
  const clusterEntries = asArray(schedules.cluster?.entries);
  const cronJobs = asArray(schedules.openclawCron?.jobs);
  return {
    cluster: {
      count: schedules.cluster?.count ?? clusterEntries.length,
      enabled: clusterEntries.filter((entry) => entry.enabled !== false).length,
      entries: capArray(clusterEntries, 20).map((entry) => ({
        source: entry.source || null,
        sourceId: entry.sourceId || entry.id || null,
        name: entry.name || null,
        taskType: entry.taskType || null,
        enabled: entry.enabled !== false,
      })),
    },
    openclawCron: {
      available: schedules.openclawCron?.available ?? true,
      count: schedules.openclawCron?.count ?? cronJobs.length,
      failing: cronJobs.filter((job) => {
        const status = job.lastRunStatus || job.lastStatus || job.state?.lastRunStatus || job.state?.lastStatus;
        return job.enabled !== false && (Number(job.consecutiveErrors || job.state?.consecutiveErrors || 0) > 0 || (status && status !== 'ok'));
      }).length,
      jobs: capArray(cronJobs, 20).map((job) => ({
        id: job.id || null,
        name: job.name || null,
        enabled: job.enabled !== false,
        lastRunStatus: job.lastRunStatus || job.lastStatus || job.state?.lastRunStatus || job.state?.lastStatus || null,
        consecutiveErrors: Number(job.consecutiveErrors || job.state?.consecutiveErrors || 0),
      })),
    },
  };
}

function buildCompactSnapshot(snapshot = {}) {
  return {
    mode: 'compact',
    schemaVersion: snapshot.schemaVersion || 1,
    status: snapshot.status || 'unknown',
    generatedAt: snapshot.generatedAt || null,
    sources: summarizeSources(snapshot.sources),
    runtimes: summarizeRuntimes(snapshot),
    hosts: summarizeHosts(snapshot.hosts),
    agents: summarizeAgents(snapshot),
    models: {
      lanes: snapshot.models?.lanes || {},
      openclawDefaults: snapshot.models?.openclawDefaults || {},
      liveModelCount: Object.keys(snapshot.models?.liveModels || {}).length,
    },
    rag: {
      healthy: snapshot.rag?.healthy ?? null,
      status: snapshot.rag?.status || null,
    },
    prompts: {
      count: snapshot.prompts?.count ?? 0,
      activeCount: snapshot.prompts?.activeCount ?? 0,
    },
    memory: {
      classifications: snapshot.memory?.classifications || {},
      byAgent: Object.fromEntries(Object.entries(snapshot.memory?.byAgent || {}).map(([agentId, memory]) => [agentId, {
        classification: memory?.classification || null,
        indexStatus: memory?.indexStatus || null,
        dirty: memory?.dirty ?? null,
        files: memory?.files ?? null,
        chunks: memory?.chunks ?? null,
        policyStatus: memory?.policy?.status || null,
      }])),
      knownGapCount: asArray(snapshot.memory?.knownGaps).length,
    },
    schedules: summarizeSchedules(snapshot.schedules),
    pipeline: {
      sourceOfTruth: snapshot.pipeline?.sourceOfTruth || 'mongodb:pipelinetasks',
      counts: snapshot.pipeline?.counts || {},
      activeCount: asArray(snapshot.pipeline?.active).length,
    },
    alerts: {
      activeCount: snapshot.alerts?.activeCount ?? asArray(snapshot.alerts?.active).length,
      countsBySeverity: snapshot.alerts?.countsBySeverity || {},
    },
    drift: summarizeDrift(snapshot.drift),
    recommendations: asArray(snapshot.recommendations),
  };
}

function buildDriftOnlySnapshot(snapshot = {}) {
  return {
    mode: 'driftOnly',
    schemaVersion: snapshot.schemaVersion || 1,
    status: snapshot.status || 'unknown',
    generatedAt: snapshot.generatedAt || null,
    sources: summarizeSources(snapshot.sources),
    drift: summarizeDrift(snapshot.drift, 100),
    recommendations: asArray(snapshot.recommendations),
  };
}

function agentNeedles(agent = {}) {
  return [
    agent.id,
    agent.name,
    agent.persona,
    primaryModel(agent),
    ...fallbackModels(agent),
  ].filter(Boolean).map((value) => String(value).toLowerCase());
}

function textMatchesNeedle(value, needles) {
  const text = JSON.stringify(value || {}).toLowerCase();
  return needles.some((needle) => needle && text.includes(needle));
}

function findSnapshotAgent(snapshot = {}, agentId) {
  const wanted = String(agentId || '').trim().toLowerCase();
  if (!wanted) return null;
  const candidates = [
    snapshot.agents?.frontDoor,
    ...asArray(snapshot.agents?.specialists),
    ...asArray(snapshot.agents?.openclaw),
  ].filter(Boolean);
  return candidates.find((agent) => {
    const ids = [agent.id, agent.name, agent.persona].filter(Boolean).map((value) => String(value).toLowerCase());
    return ids.includes(wanted);
  }) || null;
}

function filterAgentSchedules(snapshot = {}, agent) {
  const needles = agentNeedles(agent);
  const schedules = snapshot.schedules || {};
  return {
    cluster: asArray(schedules.cluster?.entries).filter((entry) => textMatchesNeedle(entry, needles)),
    openclawCron: asArray(schedules.openclawCron?.jobs).filter((job) => textMatchesNeedle(job, needles)),
  };
}

function buildAgentSnapshot(snapshot = {}, agentId) {
  const agent = findSnapshotAgent(snapshot, agentId);
  if (!agent) {
    throw new McpSnapshotToolError(`agent not found in ecosystem snapshot: ${agentId}`, { code: 'NOT_FOUND', status: 404 });
  }
  const liveModels = snapshot.models?.liveModels || {};
  const compact = compactAgent(agent, liveModels);
  const needles = agentNeedles(agent);
  const drift = asArray(snapshot.drift).filter((record) => textMatchesNeedle(record, needles));
  const owners = new Set(drift.map((record) => record.owner).filter(Boolean));
  return {
    mode: 'agent',
    schemaVersion: snapshot.schemaVersion || 1,
    status: snapshot.status || 'unknown',
    generatedAt: snapshot.generatedAt || null,
    sources: summarizeSources(snapshot.sources),
    agent: {
      ...compact,
      role: summarizeAgentRole(agent),
      roleDocs: asArray(agent.roleDocs || agent.role_docs),
      boundary: agent.boundary || null,
      workspace: agent.workspace || null,
    },
    modelChain: {
      primary: primaryModel(agent),
      fallbacks: fallbackModels(agent),
      liveModel: compact?.liveModel || null,
    },
    memory: agent.memory || snapshot.memory?.byAgent?.[agent.id] || null,
    schedules: filterAgentSchedules(snapshot, agent),
    drift: summarizeDrift(drift, 50),
    recommendations: asArray(snapshot.recommendations).filter((record) => owners.has(record.owner)),
  };
}

function capFullSnapshot(snapshot = {}) {
  const capped = jsonClone(snapshot) || {};
  if (capped.prompts) capped.prompts.configs = capArray(capped.prompts.configs, FULL_SNAPSHOT_CAPS.prompts);
  if (capped.pipeline) capped.pipeline.active = capArray(capped.pipeline.active, FULL_SNAPSHOT_CAPS.pipelineActive);
  if (capped.alerts) capped.alerts.active = capArray(capped.alerts.active, FULL_SNAPSHOT_CAPS.alertsActive);
  if (capped.models) {
    capped.models.openclawExpected = capArray(capped.models.openclawExpected, FULL_SNAPSHOT_CAPS.providerModels);
    capped.models.openclawProviders = capArray(
      capped.models.openclawProviders,
      FULL_SNAPSHOT_CAPS.providerModels
    );
  }
  if (capped.hosts) {
    capped.hosts.capacity = asArray(capped.hosts.capacity).map((host) => ({
      ...host,
      topModels: capArray(host.topModels, FULL_SNAPSHOT_CAPS.hostTopModels),
    }));
  }
  return capped;
}

function buildFullSnapshot(snapshot = {}) {
  return {
    mode: 'full',
    schemaVersion: snapshot.schemaVersion || 1,
    status: snapshot.status || 'unknown',
    generatedAt: snapshot.generatedAt || null,
    snapshot: capFullSnapshot(snapshot),
    _mcp: {
      caps: FULL_SNAPSHOT_CAPS,
      note: 'Large arrays are capped for MCP transport; call the HTTP snapshot API for uncapped operator inspection.',
    },
  };
}

function fitSnapshotPayload(payload, snapshot, maxChars) {
  const sanitized = redactForMcp(payload);
  const rendered = JSON.stringify(sanitized);
  if (rendered.length <= maxChars) return sanitized;
  return redactForMcp({
    mode: payload.mode || 'compact',
    schemaVersion: snapshot.schemaVersion || 1,
    status: snapshot.status || 'unknown',
    generatedAt: snapshot.generatedAt || null,
    truncated: true,
    maxChars,
    originalChars: rendered.length,
    compact: buildCompactSnapshot(snapshot),
    drift: summarizeDrift(snapshot.drift, 50),
    recommendations: asArray(snapshot.recommendations),
  });
}

async function ecosystemSnapshotTool(args, deps = {}) {
  const input = ensurePlainObject(args || {});
  const mode = normalizeSnapshotMode(input.mode, Boolean(input.agentId));
  if (mode === 'agent' && !input.agentId) {
    throw new McpSnapshotToolError('agentId is required when mode is agent', { code: 'INVALID_ARGUMENTS' });
  }
  const maxChars = clampInteger(input.maxChars, { min: 5000, max: 60000, fallback: 45000 });
  const provider = deps.ecosystemSnapshotProvider || defaultEcosystemSnapshot;
  const snapshot = redactForMcp(await provider());
  let payload;
  if (mode === 'driftOnly') payload = buildDriftOnlySnapshot(snapshot);
  else if (mode === 'full') payload = buildFullSnapshot(snapshot);
  else if (mode === 'agent') payload = buildAgentSnapshot(snapshot, input.agentId);
  else payload = buildCompactSnapshot(snapshot);
  return fitSnapshotPayload(payload, snapshot, maxChars);
}

module.exports = {
  ecosystemSnapshotTool,
  FULL_SNAPSHOT_CAPS,
};

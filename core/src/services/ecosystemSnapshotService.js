'use strict';

const { detectDrift, buildRecommendations } = require('./ecosystemSnapshotDrift');
const { classifyHermesAuthority, summarizeHermesConfig } = require('./ecosystemSnapshotAuthority');
const { buildModels, buildSchedules } = require('./ecosystemSnapshotProjections');

const DEFAULT_SOURCE_TIMEOUT_MS = 6000;
const OPENCLAW_TIMEOUT_MS = Number(process.env.ECOSYSTEM_OPENCLAW_TIMEOUT_MS || 25000);
const OPENCLAW_COMMAND_TIMEOUT_MS = Number(process.env.ECOSYSTEM_OPENCLAW_COMMAND_TIMEOUT_MS || 15000);
const FETCH_TIMEOUT_MS = Number(process.env.ECOSYSTEM_FETCH_TIMEOUT_MS || 4000);
const SENSITIVE_KEY = /(api[-_]?key|apikey|token|secret|password|authorization|credential|cookie)/i;
const PIPELINE_STATUSES = ['queued', 'in_progress', 'review', 'blocked', 'done'];

function nowIso(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : (options.now || new Date());
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function cleanBaseUrl(value, fallback = '') {
  return String(value || fallback || '').replace(/\/+$/, '');
}

function sanitizeUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function redactSecrets(value, key = '') {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeUrl(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, key));

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactSecrets(childValue, childKey);
  }
  return out;
}

function stripCollectorMeta(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const { _degraded, _issues, ...rest } = data;
  return rest;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function collectSource(name, collector, fallback, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_SOURCE_TIMEOUT_MS;
  const start = Date.now();
  try {
    const raw = await withTimeout(Promise.resolve().then(collector), timeoutMs, name);
    const degraded = Boolean(raw?._degraded);
    const issues = asArray(raw?._issues);
    return {
      name,
      status: degraded ? 'degraded' : 'ok',
      durationMs: Date.now() - start,
      issues,
      data: redactSecrets(stripCollectorMeta(raw))
    };
  } catch (err) {
    return {
      name,
      status: 'degraded',
      durationMs: Date.now() - start,
      error: err.message,
      issues: [err.message],
      data: redactSecrets(fallback)
    };
  }
}

function getFetchImpl(options = {}) {
  if (options.fetchImpl) return options.fetchImpl;
  if (typeof fetch === 'function') return fetch;
  return require('node-fetch');
}

async function fetchJson(url, options = {}) {
  const fetchImpl = getFetchImpl(options);
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  const fetchImpl = getFetchImpl(options);
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html', ...(options.headers || {}) },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function extractHermesSessionToken(html) {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*("([^"\\]|\\.)*")/);
  if (!match) return '';
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return '';
  }
}

async function fetchHermesDashboardToken(baseUrl, options = {}) {
  const html = await fetchText(`${baseUrl}/`, options);
  const token = extractHermesSessionToken(html);
  if (!token) {
    const err = new Error('Hermes dashboard session token not found');
    err.status = 401;
    throw err;
  }
  return token;
}

async function fetchHermesProtectedJson(baseUrl, path, options = {}) {
  const token = await fetchHermesDashboardToken(baseUrl, options);
  return fetchJson(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), 'X-Hermes-Session-Token': token }
  });
}

async function collectRuntimeConfig(options, deps) {
  const coreBaseUrl = cleanBaseUrl(options.coreBaseUrl || process.env.CORE_PUBLIC_URL, 'http://localhost:3080');
  return deps.agentRuntimeConfigService.buildAgentRuntimeConfigExport({
    coreBaseUrl,
    includeCandidates: false
  });
}

async function collectHostPreferences(_options, deps) {
  const rawPreferences = asArray(await deps.hostPrefService.getAll());
  const normalize = typeof deps.hostPrefService.normalizeHostPreferenceIdentity === 'function'
    ? deps.hostPrefService.normalizeHostPreferenceIdentity
    : (pref) => pref;

  const preferences = rawPreferences.map((pref) => normalize(pref));
  const identityDrift = typeof deps.hostPrefService.detectHostPreferenceIdentityDrift === 'function'
    ? deps.hostPrefService.detectHostPreferenceIdentityDrift(rawPreferences)
    : null;

  return {
    preferences: preferences.map(summarizeHostPreference),
    identityDrift
  };
}

async function collectHostCapacity(options, deps) {
  const configuredHosts = deps.getConfiguredHosts();
  const reports = await Promise.all(configuredHosts.map(async (host) => {
    try {
      return await deps.computeHostCapacity(host.id, options.capacityHours || 24, { timeoutMs: 3000 });
    } catch (err) {
      return { configId: host.id, input: host.id, error: 'compute_failed', message: err.message };
    }
  }));

  return {
    reports: reports.map(summarizeCapacityReport),
    _degraded: reports.some((report) => report.error),
    _issues: reports.filter((report) => report.error).map((report) => `${report.input || report.configId}: ${report.message}`)
  };
}

async function collectOpenClawInventory(options, deps) {
  const sourceTimeoutMs = positiveInteger(options.openclawTimeoutMs) || OPENCLAW_TIMEOUT_MS;
  const requestedCommandTimeoutMs = positiveInteger(options.openclawCommandTimeoutMs) || OPENCLAW_COMMAND_TIMEOUT_MS;
  const commandTimeoutMs = Math.min(requestedCommandTimeoutMs, Math.max(500, sourceTimeoutMs - 500));
  const evidence = await deps.openclawRuntimeEvidenceService.getOpenClawRuntimeEvidence({
    commandTimeoutMs
  });
  const inventory = {
    source: evidence.source?.inventory || null,
    defaults: evidence.defaults || {},
    memory_strategy: evidence.memoryStrategy || null,
    runtime: evidence.status || null,
    agents: evidence.agents || [],
    inactiveWorkspaces: evidence.inactiveWorkspaces || [],
    known_gaps: evidence.knownGaps || [],
    cron: evidence.cron || { available: false, count: 0, jobs: [] },
    models: evidence.models || {},
  };
  return {
    ...inventory,
    _degraded: Boolean(evidence?.source?.degraded),
    _issues: asArray(evidence?.source?.issues)
  };
}

async function collectFastlaneConfig(_options, deps) {
  return deps.nestorFastlaneConfigService.buildNestorFastlaneConfig();
}

async function collectPrompts(_options, deps) {
  const prompts = await deps.PromptConfig.find({})
    .select('name version isActive description stats uiConfig createdAt updatedAt')
    .sort({ name: 1, version: -1 })
    .limit(75)
    .lean();
  const configs = asArray(prompts).map((prompt) => ({
    id: prompt._id ? String(prompt._id) : null,
    name: prompt.name,
    version: prompt.version,
    isActive: Boolean(prompt.isActive),
    description: prompt.description || '',
    stats: prompt.stats || {},
    uiType: prompt.uiConfig?.type || null,
    route: prompt.uiConfig?.route || null,
    updatedAt: prompt.updatedAt || null
  }));
  return {
    count: configs.length,
    activeCount: configs.filter((prompt) => prompt.isActive).length,
    configs
  };
}

async function collectPipeline(_options, deps) {
  const counts = {};
  await Promise.all(PIPELINE_STATUSES.map(async (status) => {
    counts[status] = await deps.PipelineTask.countDocuments({ status });
  }));
  const active = await deps.PipelineTask.find({ status: { $in: ['queued', 'in_progress', 'review', 'blocked'] } })
    .select('pipelineId title service status assignee heartbeatAt epic updatedAt')
    .sort({ pipelineId: 1 })
    .limit(40)
    .lean();
  return {
    sourceOfTruth: 'mongodb:pipelinetasks',
    counts,
    active: asArray(active).map((task) => ({
      pipelineId: task.pipelineId,
      title: task.title,
      service: task.service || '',
      status: task.status,
      assignee: task.assignee || null,
      heartbeatAt: task.heartbeatAt || null,
      epic: task.epic || '',
      updatedAt: task.updatedAt || null
    }))
  };
}

async function collectSchedules(_options, deps) {
  const entries = await deps.clusterScheduleService.getAllEntries({});
  return {
    count: asArray(entries).length,
    entries: asArray(entries).slice(0, 75).map((entry) => ({
      id: entry._id ? String(entry._id) : null,
      source: entry.source,
      sourceId: entry.sourceId,
      name: entry.name,
      taskType: entry.taskType,
      host: entry.host || null,
      model: entry.model || null,
      agent: entry.agent || null,
      enabled: entry.enabled !== false,
      schedule: entry.schedule || null,
      lastRun: entry.lastRun || null
    }))
  };
}

async function collectAlerts(_options, deps) {
  const active = await deps.Alert.find({ status: 'active' })
    .select('ruleId ruleName severity title message status source context createdAt lastOccurrence')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  const countsBySeverity = {};
  for (const alert of asArray(active)) {
    const severity = alert.severity || 'info';
    countsBySeverity[severity] = (countsBySeverity[severity] || 0) + 1;
  }
  return {
    activeCount: asArray(active).length,
    countsBySeverity,
    active: asArray(active).slice(0, 20).map((alert) => ({
      id: alert._id ? String(alert._id) : null,
      ruleId: alert.ruleId || null,
      ruleName: alert.ruleName || null,
      severity: alert.severity || 'info',
      title: alert.title || alert.message || 'Alert',
      status: alert.status || 'active',
      source: alert.source || alert.context?.source || null,
      component: alert.context?.component || alert.context?.host || null,
      metric: alert.context?.metric || null,
      createdAt: alert.createdAt || null,
      lastOccurrence: alert.lastOccurrence || null
    }))
  };
}

async function collectRag(options) {
  const baseUrl = cleanBaseUrl(options.ragBaseUrl || process.env.RAG_SERVICE_URL || process.env.RAG_PUBLIC_URL, 'http://localhost:3082');
  const body = await fetchJson(`${baseUrl}/api/rag/status`, options);
  return {
    baseUrl,
    status: body?.status || body?.data?.status || null,
    healthy: body?.data?.healthy ?? body?.healthy ?? null,
    documents: body?.data?.documents ?? body?.data?.documentCount ?? body?.documents ?? null,
    dependencies: body?.data?.dependencies || body?.dependencies || {}
  };
}

async function collectHermes(options) {
  const baseUrl = cleanBaseUrl(options.hermesBaseUrl || process.env.HERMES_DASHBOARD_URL || process.env.HERMES_PUBLIC_URL);
  if (!baseUrl) {
    return { configured: false, _degraded: true, _issues: ['Hermes dashboard URL is not configured'] };
  }
  const status = await fetchJson(`${baseUrl}/api/status`, options);
  const liveConfig = await fetchHermesProtectedJson(baseUrl, '/api/config/raw', options)
    .catch((err) => {
      if (err.status === 401 || err.status === 403) throw err;
      return fetchHermesProtectedJson(baseUrl, '/api/config', options);
    })
    .then((body) => summarizeHermesConfig(body))
    .catch((err) => ({
      available: false,
      status: err.status === 401 || err.status === 403 ? 'protected' : 'unavailable',
      error: err.status ? `HTTP ${err.status}` : err.message
    }));
  return {
    configured: true,
    dashboardUrl: baseUrl,
    hermes: {
      version: status.version || null,
      releaseDate: status.release_date || null,
      activeSessions: Number(status.active_sessions || 0)
    },
    gateway: {
      running: Boolean(status.gateway_running),
      state: status.gateway_state || null,
      updatedAt: status.gateway_updated_at || null,
      platforms: status.gateway_platforms || {}
    },
    liveConfig
  };
}

function summarizeHostPreference(pref) {
  return {
    hostUrl: pref.hostUrl || null,
    hostKey: pref.hostKey || null,
    persistedHostKey: pref.persistedHostKey || null,
    configuredHostKey: pref.configuredHostKey || null,
    displayName: pref.displayName || null,
    status: pref.status || null,
    loadedModel: pref.loadedModel || null,
    loadedModels: asArray(pref.loadedModels),
    pinnedModels: asArray(pref.pinnedModels).map((pin) => ({
      model: pin.model || null,
      contextSize: pin.contextSize ?? null,
      keepAlive: pin.keepAlive ?? null,
      autoRestore: pin.autoRestore ?? null
    })),
    hostIdentityDrift: pref.hostIdentityDrift || pref.hostKeyDrift || null,
    duplicateActiveHostKeys: asArray(pref.duplicateActiveHostKeys),
    duplicatePersistedHostKeys: asArray(pref.duplicatePersistedHostKeys)
  };
}

function summarizeCapacityReport(report) {
  if (!report || report.error) {
    return {
      configId: report?.configId || report?.input || null,
      error: report?.error || 'unavailable',
      message: report?.message || null
    };
  }
  const host = report.host && typeof report.host === 'object' ? report.host : {};
  const online = host.online ?? report.online ?? null;
  const ollamaReachable = host.ollamaReachable ?? report.ollamaReachable ?? null;
  const status = report.status || host.status || (online === true ? 'online' : (online === false ? 'offline' : null));
  return {
    configId: report.configId || host.configId || host.hostKey || report.id || host.id || null,
    hostId: host.hostId || report.hostId || null,
    hostname: host.hostname || report.hostname || report.name || null,
    ollamaUrl: host.ollamaUrl || report.ollamaUrl || null,
    status,
    online,
    hostStatus: host.hostStatus || report.hostStatus || null,
    serviceStatus: host.serviceStatus || report.serviceStatus || null,
    telemetryStale: host.telemetryStale ?? report.telemetryStale ?? null,
    ollamaReachable,
    verdict: report.verdict || null,
    reasons: asArray(report.verdictReasons || report.reasons),
    vram: {
      totalMiB: report.vram?.totalMiB ?? null,
      usedMiB: report.vram?.usedMiB ?? null,
      p95Recent15mPct: report.vram?.p95Recent15mPct ?? null
    },
    inference: {
      callSharePct: report.inference?.callSharePct ?? null,
      errorRatePct: report.inference?.errorRatePct ?? report.inference?.errorRate ?? null,
      topModels: asArray(report.inference?.topModels).slice(0, 5)
    },
    loadedModels: asArray(report.loadedModels).map((model) => ({
      name: model.name || model.model || null,
      sizeVramMiB: model.sizeVramMiB ?? null,
      contextLength: model.contextLength ?? null
    })),
    hostIdentityDrift: host.hostIdentityDrift || report.hostIdentityDrift || null
  };
}

function buildRuntimes(results) {
  const runtime = results.runtime.data || {};
  const fastlane = results.fastlane.data || {};
  const hermes = results.hermes.data || {};
  const hermesExpected = runtime.hermes ? {
    proxyBaseUrl: runtime.hermes.proxyBaseUrl,
    model: runtime.hermes.defaultModelConfig?.default || null,
    provider: runtime.hermes.defaultModelConfig?.provider || null,
    contextLength: runtime.hermes.defaultModelConfig?.context_length || null,
    apiKey: runtime.hermes.defaultModelConfig?.api_key || null,
    localFallback: runtime.hermes.localFallbackModelConfig ? {
      model: runtime.hermes.localFallbackModelConfig.default || null,
      contextLength: runtime.hermes.localFallbackModelConfig.context_length || null
    } : null,
    authority: runtime.hermes.authority || null
  } : null;
  const hermesRegistryPolicy = fastlane.controls?.hermesRuntime || null;
  return {
    core: {
      baseUrl: runtime.coreBaseUrl || null,
      sourceOfTruth: runtime.sourceOfTruth || {}
    },
    hermes: {
      expected: hermesExpected,
      registryPolicy: hermesRegistryPolicy,
      liveStatus: hermes,
      authority: classifyHermesAuthority(runtime.hermes, hermesRegistryPolicy, hermes)
    },
    openclaw: {
      expected: runtime.openclaw ? {
        providerId: runtime.openclaw.providerId,
        apiBase: runtime.openclaw.provider?.apiBase || null,
        defaults: runtime.openclaw.defaults || {},
        providerAliases: asArray(runtime.openclaw.providerAliases),
        contextOverrides: asArray(runtime.openclaw.contextOverrides),
        models: asArray(runtime.openclaw.provider?.models).map((model) => ({
          id: model.id,
          contextWindow: model.contextWindow,
          numCtx: model.params?.num_ctx || null
        }))
      } : null,
      registryPolicy: fastlane.controls?.openclawRuntime || null
    },
    lanes: runtime.lanes || {},
    frontDoor: fastlane.frontDoor || null
  };
}

function buildHosts(results) {
  const preferences = results.hostPreferences.data?.preferences || [];
  const capacity = results.hostCapacity.data?.reports || [];
  return {
    preferences,
    capacity,
    summary: {
      configured: capacity.length,
      online: capacity.filter((host) => host.ollamaReachable === true || host.online === true || host.status === 'online').length,
      degraded: capacity.filter((host) =>
        host.error || (host.ollamaReachable === false && host.online !== true)
      ).length
    }
  };
}

function buildAgents(results) {
  const inventory = results.openclaw.data || {};
  const fastlane = results.fastlane.data || {};
  return {
    frontDoor: fastlane.frontDoor || null,
    specialists: fastlane.specialists || [],
    openclaw: asArray(inventory.agents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      active: agent.active !== false,
      default: Boolean(agent.default),
      model: agent.model || {},
      workspace: agent.workspace || null,
      memory: classifyMemory(agent.memory)
    }))
  };
}

function classifyMemory(memory, policy = null) {
  if (policy?.classification === 'stateless' || policy?.classification === 'intentionally-stateless') {
    return {
      classification: 'intentionally-stateless',
      indexStatus: memory?.indexStatus || null,
      dirty: memory?.dirty === true,
      files: memory?.files || 0,
      chunks: memory?.chunks || 0,
      provider: memory?.provider || null,
      model: memory?.model || null,
      issues: asArray(memory?.issues),
      policy
    };
  }
  if (!memory) return { classification: 'missing', indexStatus: null, dirty: null, files: 0, chunks: 0, issues: [], policy };
  const indexStatus = memory.indexStatus || null;
  const dirty = memory.dirty === true;
  let classification = 'unknown';
  if (indexStatus === 'valid' && !dirty && ((memory.files || 0) > 0 || (memory.chunks || 0) > 0)) classification = 'healthy';
  else if (indexStatus === 'valid' && !dirty) classification = 'empty-valid';
  else if (indexStatus === 'missing') classification = 'missing';
  else if (dirty) classification = 'dirty';
  else if (indexStatus) classification = indexStatus;
  return {
    classification,
    indexStatus,
    dirty,
    files: memory.files || 0,
    chunks: memory.chunks || 0,
    provider: memory.provider || null,
    model: memory.model || null,
    issues: asArray(memory.issues),
    policy
  };
}

function memoryGapAgentId(gap, agents = []) {
  if (gap?.agentId || gap?.agent) return gap.agentId || gap.agent;
  const id = String(gap?.id || '');
  return asArray(agents)
    .map((agent) => agent?.id)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((agentId) => id === agentId || id.startsWith(`${agentId}-`)) || null;
}

function buildMemory(results) {
  const inventory = results.openclaw.data || {};
  const fastlane = results.fastlane.data || {};
  const policyByAgent = new Map(
    asArray(fastlane.controls?.openclawRuntime?.memoryPolicies)
      .concat(asArray(fastlane.controls?.openclawRuntime?.memory_policies))
      .map((policy) => [policy.agentId || policy.agent || policy.id, policy])
  );
  const byAgent = {};
  for (const agent of asArray(inventory.agents)) {
    byAgent[agent.id] = classifyMemory(agent.memory, policyByAgent.get(agent.id) || null);
  }
  const classifications = {};
  for (const memory of Object.values(byAgent)) {
    classifications[memory.classification] = (classifications[memory.classification] || 0) + 1;
  }
  return {
    source: inventory.source || null,
    strategy: inventory.memory_strategy || null,
    classifications,
    byAgent,
    knownGaps: asArray(inventory.known_gaps)
      .filter((gap) => /memory|index/i.test(`${gap.id} ${gap.detail || ''}`))
      .map((gap) => ({
        ...gap,
        policy: policyByAgent.get(memoryGapAgentId(gap, inventory.agents)) || null
      }))
  };
}

function buildDeps(options = {}) {
  const overrides = options.deps || {};
  return {
    PromptConfig: overrides.PromptConfig || require('../../models/PromptConfig'),
    PipelineTask: overrides.PipelineTask || require('../../models/PipelineTask'),
    Alert: overrides.Alert || require('../../models/Alert'),
    hostPrefService: overrides.hostPrefService || require('./hostPreferenceService'),
    computeHostCapacity: overrides.computeHostCapacity || require('./hostCapacityService').computeHostCapacity,
    clusterScheduleService: overrides.clusterScheduleService || require('./clusterScheduleService'),
    agentRuntimeConfigService: overrides.agentRuntimeConfigService || require('./agentRuntimeConfigService'),
    openclawRuntimeEvidenceService: overrides.openclawRuntimeEvidenceService || require('./openclawRuntimeEvidenceService'),
    nestorFastlaneConfigService: overrides.nestorFastlaneConfigService || require('./nestorFastlaneConfigService'),
    getConfiguredHosts: overrides.getConfiguredHosts || require('../helpers/ollamaHostConfig').getConfiguredHosts
  };
}

async function buildEcosystemSnapshot(options = {}) {
  const deps = buildDeps(options);
  const openclawTimeoutMs = positiveInteger(options.openclawTimeoutMs) || OPENCLAW_TIMEOUT_MS;
  const sourceOptions = { ...options, fetchImpl: getFetchImpl(options), openclawTimeoutMs };
  const resultsList = await Promise.all([
    collectSource('runtime', () => collectRuntimeConfig(sourceOptions, deps), {}, { timeoutMs: options.runtimeTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('hostPreferences', () => collectHostPreferences(sourceOptions, deps), { preferences: [] }, { timeoutMs: options.hostPreferencesTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('hostCapacity', () => collectHostCapacity(sourceOptions, deps), { reports: [] }, { timeoutMs: options.hostCapacityTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('openclaw', () => collectOpenClawInventory(sourceOptions, deps), { agents: [], known_gaps: [] }, { timeoutMs: openclawTimeoutMs }),
    collectSource('fastlane', () => collectFastlaneConfig(sourceOptions, deps), {}, { timeoutMs: options.fastlaneTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('prompts', () => collectPrompts(sourceOptions, deps), { count: 0, activeCount: 0, configs: [] }, { timeoutMs: options.promptsTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('pipeline', () => collectPipeline(sourceOptions, deps), { sourceOfTruth: 'mongodb:pipelinetasks', counts: {}, active: [] }, { timeoutMs: options.pipelineTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('schedules', () => collectSchedules(sourceOptions, deps), { count: 0, entries: [] }, { timeoutMs: options.schedulesTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('alerts', () => collectAlerts(sourceOptions, deps), { activeCount: 0, countsBySeverity: {}, active: [] }, { timeoutMs: options.alertsTimeoutMs || DEFAULT_SOURCE_TIMEOUT_MS }),
    collectSource('rag', () => collectRag(sourceOptions), { status: 'unavailable' }, { timeoutMs: options.ragTimeoutMs || FETCH_TIMEOUT_MS + 500 }),
    collectSource('hermes', () => collectHermes(sourceOptions), { configured: false }, { timeoutMs: options.hermesTimeoutMs || FETCH_TIMEOUT_MS + 500 })
  ]);

  const results = Object.fromEntries(resultsList.map((result) => [result.name, result]));
  const sources = Object.fromEntries(resultsList.map((result) => [result.name, {
    status: result.status,
    durationMs: result.durationMs,
    issues: result.issues || [],
    error: result.error || null
  }]));
  const drift = detectDrift(results);
  const status = resultsList.some((result) => result.status !== 'ok') ? 'degraded' : 'ok';

  return redactSecrets({
    schemaVersion: 1,
    status,
    generatedAt: nowIso(options),
    sources,
    runtimes: buildRuntimes(results),
    hosts: buildHosts(results),
    agents: buildAgents(results),
    models: buildModels(results),
    rag: results.rag.data,
    prompts: results.prompts.data,
    memory: buildMemory(results),
    schedules: buildSchedules(results),
    pipeline: results.pipeline.data,
    alerts: results.alerts.data,
    drift,
    recommendations: buildRecommendations(drift)
  });
}

module.exports = {
  buildEcosystemSnapshot,
  redactSecrets,
  detectDrift,
  classifyMemory
};

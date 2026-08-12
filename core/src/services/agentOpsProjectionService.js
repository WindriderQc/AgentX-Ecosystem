const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { buildEcosystemSnapshot } = require('./ecosystemSnapshotService');
const { buildResponsibilityMap, buildActivity } = require('./agentOpsRelationshipService');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ACTIVE_PIPELINE_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];

const TYPE_RESPONSIBILITIES = {
  coding_agent: 'Implements and reviews code, documentation, tests, and local operations.',
  pipeline_manager: 'Owns pipeline review, assignment, verification, and completion governance.',
  pipeline_worker: 'Executes one bounded, claimed pipeline task and reports evidence.',
  operations_role: 'Owns runtime, deployment, and host-maintenance operations.',
  inspection_role: 'Inspects the codebase and emits evidence-backed findings without editing.',
  triage_role: 'Turns verified findings into bounded cleanup work under governance guardrails.',
  red_team_role: 'Runs human-gated governance and resilience challenges.',
  superseded_role: 'Retained for historical context; no active runtime identity.'
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeAgentId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleize(value) {
  const title = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    Agentx: 'AgentX',
    Openclaw: 'OpenClaw',
    Leadx: 'LeadX',
    Clawdx: 'ClawdX'
  }[title] || title;
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitMarkdownRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => stripMarkdown(cell));
}

function extractRuntimeIds(value) {
  const text = String(value || '');
  const matches = text.match(/\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12})\b/gi);
  return [...new Set(matches || [])];
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-').slice(0, 80) || 'scheduled-work';
}

function parseScheduledWork(markdown) {
  const text = String(markdown || '');
  const activeStart = text.indexOf('## Active');
  const retiredStart = text.indexOf('## Retired');
  if (activeStart < 0) return [];

  const active = text.slice(activeStart, retiredStart > activeStart ? retiredStart : undefined);
  const rows = active.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (rows.length < 3) return [];

  return rows.slice(2).map((line, index) => {
    const cells = splitMarkdownRow(line);
    if (cells.length !== 6 || !cells[0]) return null;
    const [name, cadence, owner, trigger, purpose, source] = cells;
    return {
      id: `documented-${slugify(name)}-${index + 1}`,
      name,
      cadence,
      owner,
      trigger,
      purpose,
      source,
      runtimeIds: extractRuntimeIds(`${trigger} ${source}`)
    };
  }).filter(Boolean);
}

function parseLeadHolder(markdown) {
  const match = String(markdown || '').match(/^held_by:\s*([^\r\n]+)$/m);
  const value = match ? match[1].trim() : 'none';
  return value === 'none' ? null : normalizeAgentId(value);
}

function readCatalogInputs(options = {}) {
  const repoRoot = options.repoRoot
    || process.env.AGENTX_REPO_ROOT
    || process.env.DOCS_STEWARD_REPO_ROOT
    || DEFAULT_REPO_ROOT;
  const readText = options.readText || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const registry = options.registry || yaml.load(readText(path.join(repoRoot, 'config', 'agent-registry.yml')));
  const scheduledMarkdown = options.scheduledMarkdown ?? readText(path.join(repoRoot, 'SCHEDULED.md'));
  const leadMarkdown = options.leadMarkdown ?? readText(path.join(repoRoot, 'LEAD.md'));
  return { repoRoot, registry, scheduledMarkdown, leadMarkdown };
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value % 86_400_000 === 0) return `every ${value / 86_400_000}d`;
  if (value % 3_600_000 === 0) return `every ${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `every ${value / 60_000}m`;
  return `every ${Math.round(value / 1000)}s`;
}

function formatSchedule(schedule) {
  const value = asObject(schedule);
  if (value.kind === 'cron' || value.type === 'cron') {
    const expr = value.expr || value.cron || '';
    const timezone = value.tz || value.timezone || '';
    return `${expr}${timezone ? ` · ${timezone}` : ''}`.trim();
  }
  const intervalMs = value.everyMs || value.intervalMs;
  if (intervalMs) return formatDuration(intervalMs);
  if (value.kind === 'at' || value.type === 'at') return value.at || value.date || 'one time';
  return '';
}

function isoFromMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function automationHealth(job) {
  if (job.enabled === false) return 'paused';
  const raw = String(job.lastRunStatus || job.lastStatus || '').toLowerCase();
  if (['ok', 'success', 'healthy', 'completed'].includes(raw)) return 'healthy';
  if (['error', 'failed', 'failure', 'critical'].includes(raw) || Number(job.consecutiveErrors || 0) > 0) return 'error';
  return 'observed';
}

function findDocumentedAutomation(job, documented) {
  const id = String(job.id || '');
  const idMatch = documented.find((entry) => entry.runtimeIds.includes(id));
  if (idMatch) return idMatch;

  const jobName = normalizeText(job.name);
  if (jobName.length < 5) return null;
  return documented.find((entry) => {
    const documentedName = normalizeText(entry.name);
    return documentedName === jobName
      || documentedName.includes(jobName)
      || jobName.includes(documentedName);
  }) || null;
}

function inferOwnerId(owner, knownIds) {
  const normalizedOwner = normalizeText(owner).replace(/\s+/g, '-');
  return knownIds
    .sort((a, b) => b.length - a.length)
    .find((id) => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|-)${escaped}(?:-|$)`).test(normalizedOwner);
    }) || null;
}

function mergeAutomations(snapshot, documented, knownAgentIds) {
  const cronJobs = asArray(snapshot.schedules?.openclawCron?.jobs);
  const clusterEntries = asArray(snapshot.schedules?.cluster?.entries);
  const matchedDocumentIds = new Set();

  const observed = cronJobs.map((job) => {
    const documentation = findDocumentedAutomation(job, documented);
    if (documentation) matchedDocumentIds.add(documentation.id);
    return {
      id: job.id || `cron-${slugify(job.name)}`,
      name: job.name || 'Unnamed automation',
      ownerId: normalizeAgentId(job.agentId) || inferOwnerId(documentation?.owner, knownAgentIds),
      owner: documentation?.owner || job.agentId || 'Unassigned',
      cadence: formatSchedule(job.schedule) || documentation?.cadence || 'Unknown schedule',
      schedule: job.schedule || null,
      enabled: job.enabled !== false,
      health: automationHealth(job),
      confidence: 'live',
      documented: Boolean(documentation),
      nextRunAt: isoFromMs(job.nextRunAtMs),
      lastRun: isoFromMs(job.lastRunAtMs),
      durationMs: Number(job.lastDurationMs || 0) || null,
      lastStatus: job.lastRunStatus || job.lastStatus || null,
      consecutiveErrors: Number(job.consecutiveErrors || 0),
      diagnostic: job.lastDiagnosticSummary || job.lastError || '',
      purpose: documentation?.purpose || '',
      trigger: documentation?.trigger || 'OpenClaw cron',
      source: documentation?.source || 'OpenClaw native cron'
    };
  });

  for (const entry of clusterEntries) {
    const clusterName = normalizeText(entry.name);
    const sourceName = normalizeText(String(entry.sourceId || '').replace(/^oc-/, ''));
    const existing = observed.find((item) => {
      const observedName = normalizeText(item.name);
      return observedName === clusterName || observedName === sourceName;
    });
    if (existing) {
      existing.lastRun = entry.lastRun || existing.lastRun;
      existing.host = entry.host || null;
      existing.model = entry.model || null;
      existing.taskType = entry.taskType || null;
      continue;
    }

    const documentation = findDocumentedAutomation(entry, documented);
    if (documentation) matchedDocumentIds.add(documentation.id);
    observed.push({
      id: entry.sourceId || entry.id || `schedule-${slugify(entry.name)}`,
      name: entry.name || 'Unnamed schedule',
      ownerId: normalizeAgentId(entry.agent) || inferOwnerId(documentation?.owner, knownAgentIds),
      owner: documentation?.owner || entry.agent || 'Unassigned',
      cadence: formatSchedule(entry.schedule) || documentation?.cadence || 'Unknown schedule',
      schedule: entry.schedule || null,
      enabled: entry.enabled !== false,
      health: entry.enabled === false ? 'paused' : 'observed',
      confidence: 'observed',
      documented: Boolean(documentation),
      nextRunAt: null,
      lastRun: entry.lastRun || null,
      durationMs: null,
      lastStatus: null,
      consecutiveErrors: 0,
      diagnostic: '',
      purpose: documentation?.purpose || '',
      trigger: documentation?.trigger || `${entry.source || 'Cluster'} schedule`,
      source: documentation?.source || 'Mongo clusterscheduleentries',
      host: entry.host || null,
      model: entry.model || null,
      taskType: entry.taskType || null
    });
  }

  for (const entry of documented) {
    if (matchedDocumentIds.has(entry.id)) continue;
    observed.push({
      id: entry.id,
      name: entry.name,
      ownerId: inferOwnerId(entry.owner, knownAgentIds),
      owner: entry.owner || 'Unassigned',
      cadence: entry.cadence || 'Unknown schedule',
      schedule: null,
      enabled: true,
      health: 'documented',
      confidence: 'documented',
      documented: true,
      nextRunAt: null,
      lastRun: null,
      durationMs: null,
      lastStatus: null,
      consecutiveErrors: 0,
      diagnostic: '',
      purpose: entry.purpose || '',
      trigger: entry.trigger || '',
      source: entry.source || 'SCHEDULED.md'
    });
  }

  return {
    items: observed.sort((a, b) => {
      const rank = { error: 0, paused: 1, documented: 2, observed: 3, healthy: 4 };
      return (rank[a.health] ?? 9) - (rank[b.health] ?? 9) || a.name.localeCompare(b.name);
    }),
    coverage: {
      documented: documented.length,
      observed: observed.filter((item) => item.confidence !== 'documented').length,
      matchedDocumented: matchedDocumentIds.size,
      documentedOnly: observed.filter((item) => item.confidence === 'documented').length,
      observedOnly: observed.filter((item) => item.confidence !== 'documented' && !item.documented).length
    }
  };
}

function declaredModel(agent) {
  const model = asObject(agent.model);
  return model.primary || model.current_primary || model.daily_model || null;
}

function acceptanceGate(agent) {
  return agent.model?.execution_policy?.acceptance_gate || null;
}

function responsibilityFor(agent) {
  if (agent.boundary) return agent.boundary;
  if (asArray(agent.owns).length) return `Owns ${agent.owns.join(', ')}.`;
  if (asArray(agent.default_scope).length) return `Default scope: ${agent.default_scope.join(', ')}.`;
  return TYPE_RESPONSIBILITIES[agent.type] || 'Registered ecosystem role.';
}

function collectObservedAgents(snapshot) {
  const observed = new Map();
  const add = (agent, source, confidence) => {
    if (!agent?.id) return;
    const key = normalizeAgentId(agent.id);
    const current = observed.get(key) || { id: agent.id, sources: [] };
    observed.set(key, {
      ...current,
      ...agent,
      primary: agent.model?.primary || agent.primary || current.primary || null,
      fallbacks: asArray(agent.model?.fallbacks || agent.fallbacks || current.fallbacks),
      confidence: current.confidence === 'live' ? 'live' : confidence,
      sources: [...new Set([...current.sources, source])]
    });
  };

  asArray(snapshot.agents?.openclaw).forEach((agent) => add(agent, 'openclaw-inventory', 'live'));
  return observed;
}

function buildAgents(registry, snapshot, automations, leadHolder) {
  const observed = collectObservedAgents(snapshot);
  const tasks = asArray(snapshot.pipeline?.active);

  return Object.entries(asObject(registry.agents)).map(([registryId, agent]) => {
    const key = normalizeAgentId(registryId);
    const live = observed.get(key);
    const superseded = agent.type === 'superseded_role';
    const isLead = key === leadHolder;
    const runtimeExpected = Boolean(agent.runtime);
    let status = 'registered';
    if (superseded) status = 'superseded';
    else if (isLead) status = 'lead';
    else if (live?.confidence === 'live') status = 'live';
    else if (live) status = 'observed';
    else if (runtimeExpected) status = 'unobserved';

    const ownedAutomations = automations.filter((item) => item.ownerId === key);
    const ownedWork = tasks.filter((task) => normalizeAgentId(task.assignee) === key);
    return {
      id: live?.id || key,
      registryId,
      name: agent.persona || live?.name || titleize(registryId),
      type: agent.type || 'registered_role',
      runtime: agent.runtime || null,
      responsibility: responsibilityFor(agent),
      status,
      confidence: isLead ? 'live' : (live?.confidence || 'configured'),
      isLead,
      model: {
        primary: live?.primary || declaredModel(agent),
        fallbacks: live?.fallbacks || asArray(agent.model?.fallbacks || agent.model?.current_fallbacks),
        source: live?.primary ? 'runtime' : (declaredModel(agent) ? 'registry' : null)
      },
      acceptanceGate: acceptanceGate(agent),
      roleDocs: asArray(agent.role_docs),
      owns: asArray(agent.owns),
      automationCount: ownedAutomations.length,
      workCount: ownedWork.length,
      blockedWorkCount: ownedWork.filter((task) => task.status === 'blocked').length,
      observedFrom: live?.sources || []
    };
  }).sort((a, b) => {
    const rank = { lead: 0, live: 1, observed: 2, unobserved: 3, registered: 4, superseded: 5 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name);
  });
}

function buildCapabilities(registry) {
  return Object.entries(asObject(registry.capabilities)).map(([id, capability]) => ({
    id,
    name: titleize(id),
    type: capability.type || 'capability',
    shape: capability.shape || null,
    service: capability.provided_by?.service || null,
    ui: capability.provided_by?.ui || null,
    activation: capability.activation || null,
    responsibility: capability.boundary || 'AgentX-owned capability.',
    contractDocs: asArray(capability.contract_docs),
    notAnAgent: capability.not_an_agent === true
  }));
}

function buildRuntimeLayers(registry, snapshot) {
  return Object.entries(asObject(registry.runtimes)).map(([id, runtime]) => {
    let status = 'configured';
    if (id === 'hermes') {
      const gateway = snapshot.runtimes?.hermes?.liveStatus?.gateway;
      status = gateway?.running ? 'live' : (snapshot.sources?.hermes?.status || 'configured');
    } else if (id === 'openclaw') {
      status = snapshot.sources?.openclaw?.status === 'ok'
        ? 'live'
        : (snapshot.sources?.openclaw?.status || 'configured');
    }
    return {
      id,
      name: titleize(id),
      type: runtime.type || 'runtime',
      host: runtime.host || null,
      status,
      model: runtime.primary_model || null,
      boundary: runtime.boundary || '',
      dashboard: runtime.dashboard || null
    };
  });
}

function buildRuntimeHandoffs(controlUi) {
  const control = asObject(controlUi);
  const agentx = asObject(control.agentx);
  return {
    openclaw: {
      authority: control.authority || 'official-openclaw-control-ui',
      mode: control.mode || 'unconfigured',
      launchBaseUrl: control.launchBaseUrl || '',
      directBaseUrl: control.directBaseUrl || '',
      requiresSecureContext: control.requiresSecureContext !== false,
      requiresTunnel: control.requiresTunnel === true,
      tunnelCommand: control.tunnelCommand || '',
      capabilities: asArray(control.nativeCapabilities)
    },
    agentx: {
      authority: agentx.authority || 'cross-platform-complements',
      complements: asArray(agentx.complements)
    }
  };
}

function buildWarnings(snapshot, agents, automationCoverage, automations, work, responsibilities) {
  const warnings = [];
  const degradedSources = Object.entries(asObject(snapshot.sources))
    .filter(([, source]) => source?.status !== 'ok')
    .map(([name]) => name);
  if (degradedSources.length) warnings.push({
    id: 'sources-degraded',
    type: 'source',
    severity: 'warning',
    title: `${degradedSources.length} source${degradedSources.length === 1 ? '' : 's'} degraded`,
    detail: degradedSources.join(', '),
    impact: 'Runtime evidence may be incomplete until these probes recover.',
    source: 'live source probes',
    action: { kind: 'trace-sources' }
  });

  const unobserved = agents.filter((agent) => agent.runtime && agent.status === 'unobserved');
  if (unobserved.length) warnings.push({
    id: 'runtime-agents-unobserved',
    type: 'agents',
    severity: 'warning',
    title: `${unobserved.length} runtime agent${unobserved.length === 1 ? '' : 's'} not observed`,
    detail: unobserved.map((agent) => agent.id).join(', '),
    impact: 'Configured responsibilities have no current runtime inventory receipt.',
    source: 'registry × runtime inventory',
    action: { kind: 'open-preset', tab: 'agents', preset: 'unobserved-agents' }
  });

  if (automationCoverage.documentedOnly) warnings.push({
    id: 'documented-automations-only',
    type: 'automations',
    severity: 'info',
    title: `${automationCoverage.documentedOnly} recurring item${automationCoverage.documentedOnly === 1 ? '' : 's'} documented only`,
    detail: 'Present in SCHEDULED.md but not currently projected by a live runtime source.',
    impact: 'Cadence is documented but execution cannot be proven here.',
    source: 'SCHEDULED.md × live schedulers',
    action: { kind: 'open-preset', tab: 'automations', preset: 'documented-automations' }
  });

  automations.filter((item) => item.health === 'error').forEach((item) => warnings.push({
    id: `automation-error:${item.id}`,
    type: 'automation-error',
    severity: 'critical',
    title: `${item.name} is failing`,
    detail: item.diagnostic || `${item.consecutiveErrors || 1} consecutive execution error(s).`,
    impact: 'The recurring obligation may not be delivering its expected output.',
    ownerId: item.ownerId || null,
    source: item.source,
    action: { kind: 'inspect-automation', targetId: item.id }
  }));

  work.filter((task) => task.status === 'blocked').forEach((task) => warnings.push({
    id: `blocked-work:${task.pipelineId}`,
    type: 'blocked-work',
    severity: 'critical',
    title: `#${task.pipelineId} is blocked`,
    detail: task.title,
    impact: 'Delivery cannot progress until the blocker is resolved.',
    ownerId: task.assignee || null,
    source: 'mongodb:pipelinetasks',
    action: { kind: 'open-preset', tab: 'work', preset: 'work:blocked' }
  }));

  if (responsibilities.summary.unassignedSignals) warnings.push({
    id: 'unassigned-responsibility-signals',
    type: 'responsibility',
    severity: 'warning',
    title: `${responsibilities.summary.unassignedSignals} operating signal${responsibilities.summary.unassignedSignals === 1 ? '' : 's'} without a mapped registry owner`,
    detail: responsibilities.unassigned.slice(0, 4).map((item) => item.name).join(', '),
    impact: 'Work or cadence exists without an accountable identity in the registry.',
    source: 'ownership relationship map',
    action: { kind: 'open-tab', tab: 'responsibilities' }
  });
  return warnings;
}

async function buildAgentOpsProjection(options = {}) {
  const { registry, scheduledMarkdown, leadMarkdown } = readCatalogInputs(options);
  const snapshot = options.snapshot || await (options.snapshotProvider || buildEcosystemSnapshot)(options.snapshotOptions || {});
  const documented = parseScheduledWork(scheduledMarkdown);
  const knownAgentIds = Object.keys(asObject(registry.agents)).map(normalizeAgentId);
  const automationProjection = mergeAutomations(snapshot, documented, knownAgentIds);
  const leadHolder = parseLeadHolder(leadMarkdown);
  const agents = buildAgents(registry, snapshot, automationProjection.items, leadHolder);
  const capabilities = buildCapabilities(registry);
  const pipelineCounts = asObject(snapshot.pipeline?.counts);
  const activeWork = asArray(snapshot.pipeline?.active);
  const openWork = ACTIVE_PIPELINE_STATUSES.reduce((total, status) => total + Number(pipelineCounts[status] || 0), 0);
  const responsibilities = buildResponsibilityMap(agents, automationProjection.items, activeWork, capabilities);
  const warnings = buildWarnings(
    snapshot,
    agents,
    automationProjection.coverage,
    automationProjection.items,
    activeWork,
    responsibilities
  );
  const activity = buildActivity(
    snapshot,
    automationProjection.items,
    options.recentTasks || activeWork,
    options.auditEntries || []
  );
  const handoffs = buildRuntimeHandoffs(options.openclawControl);

  return {
    schemaVersion: 4,
    status: warnings.some((warning) => warning.severity === 'warning') ? 'attention' : 'ok',
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    lead: leadHolder,
    summary: {
      registeredAgents: agents.length,
      activeAgents: agents.filter((agent) => agent.status !== 'superseded').length,
      observedAgents: agents.filter((agent) => ['lead', 'live', 'observed'].includes(agent.status)).length,
      runtimeAgents: agents.filter((agent) => agent.runtime).length,
      automations: automationProjection.items.length,
      observedAutomations: automationProjection.coverage.observed,
      healthyAutomations: automationProjection.items.filter((item) => item.health === 'healthy').length,
      automationErrors: automationProjection.items.filter((item) => item.health === 'error').length,
      openWork,
      blockedWork: Number(pipelineCounts.blocked || 0)
    },
    coverage: {
      agents: {
        registered: agents.length,
        observed: agents.filter((agent) => ['lead', 'live', 'observed'].includes(agent.status)).length,
        runtimeExpected: agents.filter((agent) => agent.runtime).length,
        runtimeUnobserved: agents.filter((agent) => agent.runtime && agent.status === 'unobserved').length
      },
      automations: automationProjection.coverage
    },
    runtimeLayers: buildRuntimeLayers(registry, snapshot),
    agents,
    capabilities,
    automations: automationProjection.items,
    work: {
      sourceOfTruth: snapshot.pipeline?.sourceOfTruth || 'mongodb:pipelinetasks',
      counts: pipelineCounts,
      active: activeWork
    },
    responsibilities,
    activity,
    warnings,
    sources: snapshot.sources || {},
    handoffs,
    links: {
      nerveCenter: '/nerve-center',
      schedule: '/cluster-schedule',
      pipeline: '/pipeline',
      openclawControl: handoffs.openclaw.launchBaseUrl,
      agentxComplements: '/agent-ops'
    }
  };
}

module.exports = {
  buildAgentOpsProjection,
  parseScheduledWork,
  parseLeadHolder,
  mergeAutomations,
  buildRuntimeHandoffs,
  buildResponsibilityMap,
  buildActivity,
  normalizeAgentId,
  formatSchedule
};

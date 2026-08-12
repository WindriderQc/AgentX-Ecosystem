'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function titleize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildResponsibilityMap(agents, automations, work, capabilities) {
  const activeAgents = agents.filter((agent) => agent.status !== 'superseded');
  const lanes = activeAgents.map((agent) => ({
    agentId: agent.registryId || agent.id,
    name: agent.name,
    status: agent.status,
    responsibility: agent.responsibility,
    scopes: asArray(agent.owns),
    automations: [],
    work: [],
    signalCount: 0,
    blockedCount: 0,
    load: 'light'
  }));
  const laneById = new Map(lanes.map((lane) => [normalizeId(lane.agentId), lane]));
  const unassigned = [];

  automations.forEach((automation) => {
    const lane = laneById.get(normalizeId(automation.ownerId));
    if (lane) lane.automations.push({
      id: automation.id,
      name: automation.name,
      status: automation.health,
      confidence: automation.confidence
    });
    else unassigned.push({
      id: automation.id,
      kind: 'automation',
      name: automation.name,
      owner: automation.owner || automation.ownerId || 'Unassigned',
      status: automation.health
    });
  });

  work.forEach((task) => {
    const lane = laneById.get(normalizeId(task.assignee));
    if (lane) lane.work.push({
      id: task.pipelineId,
      name: task.title,
      status: task.status,
      service: task.service || task.epic || ''
    });
    else unassigned.push({
      id: task.pipelineId,
      kind: 'work',
      name: task.title,
      owner: task.assignee || 'Unassigned',
      status: task.status
    });
  });

  lanes.forEach((lane) => {
    lane.signalCount = lane.automations.length + lane.work.length;
    lane.blockedCount = lane.work.filter((task) => task.status === 'blocked').length;
    lane.load = lane.signalCount >= 6 ? 'high' : lane.signalCount >= 2 ? 'balanced' : 'light';
  });

  const scopeOwners = new Map();
  activeAgents.forEach((agent) => asArray(agent.owns).forEach((scope) => {
    const key = normalizeText(scope);
    if (!key) return;
    const entry = scopeOwners.get(key) || { scope, agentIds: [] };
    entry.agentIds.push(agent.registryId || agent.id);
    scopeOwners.set(key, entry);
  }));
  const duplicateScopes = [...scopeOwners.values()].filter((entry) => entry.agentIds.length > 1);
  const totalSignals = automations.length + work.length;
  const attributedSignals = Math.max(0, totalSignals - unassigned.length);

  return {
    summary: {
      totalSignals,
      attributedSignals,
      coveragePct: totalSignals ? Math.round((attributedSignals / totalSignals) * 100) : 100,
      unassignedSignals: unassigned.length,
      duplicateScopes: duplicateScopes.length,
      agentsWithoutSignals: lanes.filter((lane) => lane.signalCount === 0).length
    },
    lanes,
    unassigned,
    duplicateScopes,
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      service: capability.service,
      responsibility: capability.responsibility
    }))
  };
}

function buildActivity(snapshot, automations, recentTasks, auditEntries) {
  const items = [];
  automations.filter((item) => item.lastRun).forEach((item) => items.push({
    id: `automation:${item.id}:${item.lastRun}`,
    kind: 'automation',
    timestamp: item.lastRun,
    title: `${item.name} executed`,
    detail: item.durationMs ? `${Math.round(item.durationMs / 1000)}s · ${item.source}` : item.source,
    status: item.lastStatus || item.health,
    ownerId: item.ownerId || null,
    targetId: item.id,
    evidence: item.confidence
  }));

  asArray(recentTasks).forEach((task) => {
    const timestamp = task.updatedAt || task.createdAt;
    if (!timestamp) return;
    items.push({
      id: `work:${task.pipelineId}:${new Date(timestamp).toISOString()}`,
      kind: 'work',
      timestamp,
      title: `#${task.pipelineId} · ${task.title}`,
      detail: `${titleize(task.status)}${task.assignee ? ` · ${task.assignee}` : ' · unassigned'}`,
      status: task.status,
      ownerId: task.assignee || null,
      targetId: task.pipelineId,
      evidence: 'mongodb:pipelinetasks'
    });
  });

  asArray(auditEntries).forEach((entry) => {
    const details = asObject(entry.details);
    items.push({
      id: `operator:${entry._id || entry.timestamp}`,
      kind: 'operator',
      timestamp: entry.timestamp,
      title: details.label || `${titleize(details.action || entry.action)} requested`,
      detail: details.message || entry.target || 'Agent Ops operator action',
      status: entry.status || 'success',
      ownerId: details.assignee || entry.username || 'operator',
      targetId: details.target || entry.target || null,
      evidence: 'agent-ops audit'
    });
  });

  Object.entries(asObject(snapshot.sources)).forEach(([sourceId, source]) => {
    if (source?.status === 'ok') return;
    items.push({
      id: `source:${sourceId}:${snapshot.generatedAt || 'current'}`,
      kind: 'source',
      timestamp: snapshot.generatedAt || new Date().toISOString(),
      title: `${titleize(sourceId)} source degraded`,
      detail: asArray(source.issues)[0] || 'The current projection could not fully read this source.',
      status: source?.status || 'degraded',
      ownerId: null,
      targetId: sourceId,
      evidence: 'live source probe'
    });
  });

  items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const bounded = items.slice(0, 40);
  return {
    items: bounded,
    summary: {
      total: bounded.length,
      automations: bounded.filter((item) => item.kind === 'automation').length,
      work: bounded.filter((item) => item.kind === 'work').length,
      operator: bounded.filter((item) => item.kind === 'operator').length,
      failures: bounded.filter((item) => ['error', 'failed', 'blocked', 'degraded'].includes(String(item.status).toLowerCase())).length
    }
  };
}

module.exports = { buildResponsibilityMap, buildActivity };

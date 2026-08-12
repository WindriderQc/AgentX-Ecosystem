'use strict';

const REMOVED_PERSONAS = new Set([
  'visual_llm'
]);

const ARCHIVED_PERSONAS = new Set([
  'specialx_console',
  'sbqc_ops',
  'sbqc_workflow_architect'
]);

const OPENCLAW_CANDIDATES = {
  datalake_janitor: {
    target: 'openclaw-assignment',
    owner: 'leadx',
    note: 'Data service owns file operations; OpenClaw may analyze and recommend only.'
  },
  repo_watcher: {
    target: 'openclaw-assignment',
    owner: 'overseer',
    note: 'AgentX should expose scan/report state; OpenClaw should reason over findings.'
  }
};

const TOOL_SURFACES = {
  repo_watcher: {
    route: '/repo-watch',
    launchable: false,
    routeStatus: 'missing',
    note: 'Dashboard route is not implemented in Core yet.'
  }
};

function classifyPersona(prompt) {
  const name = prompt && prompt.name;
  const uiType = prompt && prompt.uiConfig && prompt.uiConfig.type
    ? prompt.uiConfig.type
    : 'chat';

  if (REMOVED_PERSONAS.has(name)) {
    return {
      kind: 'removed',
      selectable: false,
      launchable: false,
      archiveReason: 'Removed from runtime; historical docs may still mention it.',
      promotionTarget: null,
      routeStatus: 'removed'
    };
  }

  if (ARCHIVED_PERSONAS.has(name)) {
    return {
      kind: 'archived_pattern',
      selectable: false,
      launchable: false,
      archiveReason: 'Historical prompt content retained as source material only.',
      promotionTarget: null,
      routeStatus: 'archived'
    };
  }

  if (OPENCLAW_CANDIDATES[name]) {
    const candidate = OPENCLAW_CANDIDATES[name];
    const surface = TOOL_SURFACES[name] || {};
    return {
      kind: uiType === 'chat' ? 'prompt_asset' : 'tool_surface',
      selectable: uiType === 'chat',
      launchable: surface.launchable === true,
      archiveReason: null,
      promotionTarget: candidate.target,
      recommendedOwner: candidate.owner,
      routeStatus: surface.routeStatus || (uiType === 'chat' ? 'not_applicable' : 'unknown'),
      note: surface.note || candidate.note
    };
  }

  if (uiType !== 'chat') {
    return {
      kind: 'tool_surface',
      selectable: false,
      launchable: false,
      archiveReason: null,
      promotionTarget: 'agentx-artifact',
      routeStatus: 'unknown',
      note: 'Non-chat persona rows must point at a working AgentX tool surface before launch.'
    };
  }

  return {
    kind: 'prompt_asset',
    selectable: true,
    launchable: false,
    archiveReason: null,
    promotionTarget: null,
    routeStatus: 'not_applicable'
  };
}

function isRemovedPersona(name) {
  return REMOVED_PERSONAS.has(name);
}

module.exports = {
  classifyPersona,
  isRemovedPersona
};

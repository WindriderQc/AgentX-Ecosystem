'use strict';

const REMOVED_PERSONAS = new Set([
  'visual_llm'
]);

const ARCHIVED_PERSONAS = new Set([
  'specialx_console',
  'sbqc_ops',
  'sbqc_workflow_architect',
  'datalake_janitor',
  'repo_watcher'
]);

// Persisted test fixtures remain available on the Prompts management surface,
// but must never become a selectable production chat persona.
const TEST_FIXTURE_PERSONAS = new Set([
  'testin'
]);

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
  const normalizedName = String(name || '').trim().toLowerCase();
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

  if (TEST_FIXTURE_PERSONAS.has(normalizedName)) {
    return {
      kind: 'test_fixture',
      selectable: false,
      launchable: false,
      archiveReason: 'Retained test fixture; excluded from user-facing persona selectors.',
      promotionTarget: null,
      routeStatus: 'test_only'
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

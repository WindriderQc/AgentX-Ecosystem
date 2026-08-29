'use strict';

const { create, normalizeContract } = require('../../public/js/agent-ops-availability');

function element(initial = {}) {
  const attributes = new Map();
  return {
    textContent: '',
    hidden: false,
    disabled: false,
    ...initial,
    setAttribute: jest.fn((name, value) => attributes.set(name, value)),
    removeAttribute: jest.fn((name) => attributes.delete(name)),
    getAttribute: (name) => attributes.get(name)
  };
}

function fixture() {
  const values = [
    'agentOpsMetricAgents', 'agentOpsMetricObserved', 'agentOpsMetricAutomations',
    'agentOpsMetricWork', 'agentOpsMetricAttention', 'agentOpsTabInboxCount',
    'agentOpsTabResponsibilityCount', 'agentOpsTabActivityCount',
    'agentOpsTabAgentCount', 'agentOpsTabAutomationCount', 'agentOpsTabWorkCount'
  ];
  const details = [
    'agentOpsMetricAgentsDetail', 'agentOpsMetricObservedDetail',
    'agentOpsMetricAutomationsDetail', 'agentOpsMetricWorkDetail',
    'agentOpsMetricAttentionDetail'
  ];
  const ids = Object.fromEntries([
    ...values,
    ...details,
    'agentOpsToolbar', 'agentOpsUnavailable', 'agentOpsUnavailableReason',
    'agentOpsUnavailableAuthority', 'agentOpsUnavailableGuidance',
    'agentOpsUnavailableDocsPath', 'agentOpsOrbitStatus'
  ].map((id) => [id, element({ textContent: 'loading' })]));
  ids.agentOpsUnavailable.hidden = true;

  const projectionControls = [element(), element()];
  const openTabControls = [element()];
  const nativeControls = [element(), element()];
  const panes = [element(), element()];
  const classes = new Set();
  const root = {
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    querySelectorAll: jest.fn((selector) => ({
      '[data-agent-ops-tab], [data-metric-tab]': projectionControls,
      '[data-open-agent-ops-tab]': openTabControls,
      '[data-openclaw-native], [data-agent-ops-native-control], a[href^="/api/openclaw/"]': nativeControls,
      '[data-agent-ops-pane]': panes
    }[selector] || []))
  };

  return {
    root,
    ids,
    values,
    details,
    projectionControls,
    openTabControls,
    nativeControls,
    panes
  };
}

describe('Agent Ops unavailable UI', () => {
  test('normalizes a bounded unavailable contract without inventing evidence', () => {
    expect(normalizeContract({ available: false })).toEqual(expect.objectContaining({
      available: false,
      authority: 'agentx.trusted-extension',
      readOnly: true,
      documentationPath: 'docs/TRUSTED_EXTENSIONS.md'
    }));
  });

  test('keeps unknown counts as em dashes and hides native controls', () => {
    const ui = fixture();
    const setStatus = jest.fn();
    const controller = create({ root: ui.root, byId: (id) => ui.ids[id], setStatus });

    controller.show({
      available: false,
      authority: { id: 'agentx.trusted-extension', readOnly: true },
      reason: { message: 'No extension handled this projection.' },
      generatedAt: '2026-08-28T15:00:00.000Z',
      setup: {
        guidance: 'Install the separately owned extension.',
        documentation: { path: 'docs/TRUSTED_EXTENSIONS.md' }
      }
    });

    expect(ui.root.dataset.availability).toBe('unavailable');
    expect(ui.root.classList.contains('agent-ops-is-unavailable')).toBe(true);
    ui.values.forEach((id) => expect(ui.ids[id].textContent).toBe('—'));
    ui.details.forEach((id) => expect(ui.ids[id].textContent).toBe('Extension evidence unavailable'));
    ui.projectionControls.forEach((control) => expect(control.disabled).toBe(true));
    ui.openTabControls.forEach((control) => expect(control.disabled).toBe(true));
    ui.nativeControls.forEach((control) => {
      expect(control.hidden).toBe(true);
      expect(control.getAttribute('tabindex')).toBe('-1');
    });
    ui.panes.forEach((pane) => expect(pane.hidden).toBe(true));
    expect(ui.ids.agentOpsUnavailable.hidden).toBe(false);
    expect(ui.ids.agentOpsUnavailableReason.textContent).toBe('No extension handled this projection.');
    expect(setStatus).toHaveBeenCalledWith(
      'attention',
      'Agent Ops extension is not installed',
      expect.stringContaining('no counts were inferred'),
      '2026-08-28T15:00:00.000Z'
    );
  });

  test('restores projection controls after a later successful retry', () => {
    const ui = fixture();
    const controller = create({ root: ui.root, byId: (id) => ui.ids[id], setStatus: jest.fn() });
    controller.show({ available: false });
    controller.clear();

    expect(ui.root.dataset.availability).toBe('available');
    expect(ui.ids.agentOpsUnavailable.hidden).toBe(true);
    ui.projectionControls.forEach((control) => expect(control.disabled).toBe(false));
    ui.nativeControls.forEach((control) => {
      expect(control.hidden).toBe(false);
      expect(control.getAttribute('tabindex')).toBeUndefined();
    });
    expect(ui.ids.agentOpsOrbitStatus.textContent).toBe('Live projection');
  });
});

(function (global, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AgentOpsAvailability = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VALUE_IDS = [
    'agentOpsMetricAgents',
    'agentOpsMetricObserved',
    'agentOpsMetricAutomations',
    'agentOpsMetricWork',
    'agentOpsMetricAttention',
    'agentOpsTabInboxCount',
    'agentOpsTabResponsibilityCount',
    'agentOpsTabActivityCount',
    'agentOpsTabAgentCount',
    'agentOpsTabAutomationCount',
    'agentOpsTabWorkCount'
  ];

  const DETAIL_IDS = [
    'agentOpsMetricAgentsDetail',
    'agentOpsMetricObservedDetail',
    'agentOpsMetricAutomationsDetail',
    'agentOpsMetricWorkDetail',
    'agentOpsMetricAttentionDetail'
  ];

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeContract(body) {
    const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const reason = value.reason && typeof value.reason === 'object'
      ? text(value.reason.message)
      : text(value.reason);
    const authority = value.authority && typeof value.authority === 'object'
      ? text(value.authority.id || value.authority.kind)
      : text(value.authority);
    const setup = value.setup && typeof value.setup === 'object' ? value.setup : {};
    const documentation = setup.documentation && typeof setup.documentation === 'object'
      ? setup.documentation
      : {};

    return {
      available: value.available !== false,
      reason: reason || 'No installed trusted extension handled the Agent Ops projection.',
      authority: authority || 'agentx.trusted-extension',
      readOnly: value.authority?.readOnly !== false,
      generatedAt: text(value.generatedAt),
      guidance: text(setup.guidance) || 'Install and pin a separately owned Agent Ops extension, enable the full profile, then restart Core.',
      documentationPath: text(documentation.path) || 'docs/TRUSTED_EXTENSIONS.md'
    };
  }

  function create({ root, byId, setStatus }) {
    function setProjectionControls(enabled) {
      root.querySelectorAll('[data-agent-ops-tab], [data-metric-tab]').forEach((control) => {
        control.disabled = !enabled;
        control.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      });
      root.querySelectorAll('[data-open-agent-ops-tab]').forEach((control) => {
        control.disabled = !enabled;
      });
    }

    function setNativeControlsVisible(visible) {
      root.querySelectorAll('[data-openclaw-native], [data-agent-ops-native-control], a[href^="/api/openclaw/"]')
        .forEach((control) => {
          control.hidden = !visible;
          control.setAttribute('aria-hidden', visible ? 'false' : 'true');
          if (!visible) control.setAttribute('tabindex', '-1');
          else control.removeAttribute('tabindex');
        });
    }

    function show(body) {
      const contract = normalizeContract(body);
      root.dataset.availability = 'unavailable';
      root.classList.add('agent-ops-is-unavailable');

      VALUE_IDS.forEach((id) => {
        const element = byId(id);
        if (element) element.textContent = '—';
      });
      DETAIL_IDS.forEach((id) => {
        const element = byId(id);
        if (element) element.textContent = 'Extension evidence unavailable';
      });

      setProjectionControls(false);
      setNativeControlsVisible(false);
      root.querySelectorAll('[data-agent-ops-pane]').forEach((pane) => { pane.hidden = true; });
      const toolbar = byId('agentOpsToolbar');
      if (toolbar) toolbar.hidden = true;

      const panel = byId('agentOpsUnavailable');
      if (panel) panel.hidden = false;
      const reason = byId('agentOpsUnavailableReason');
      if (reason) reason.textContent = contract.reason;
      const authority = byId('agentOpsUnavailableAuthority');
      if (authority) authority.textContent = `${contract.authority} · ${contract.readOnly ? 'read-only' : 'availability only'}`;
      const guidance = byId('agentOpsUnavailableGuidance');
      if (guidance) guidance.textContent = contract.guidance;
      const docsPath = byId('agentOpsUnavailableDocsPath');
      if (docsPath) docsPath.textContent = contract.documentationPath;
      const orbitStatus = byId('agentOpsOrbitStatus');
      if (orbitStatus) orbitStatus.textContent = 'Extension not installed';

      setStatus(
        'attention',
        'Agent Ops extension is not installed',
        `${contract.reason} The product shell remains read-only and no counts were inferred.`,
        contract.generatedAt
      );
      return contract;
    }

    function clear() {
      root.dataset.availability = 'available';
      root.classList.remove('agent-ops-is-unavailable');
      const panel = byId('agentOpsUnavailable');
      if (panel) panel.hidden = true;
      setProjectionControls(true);
      setNativeControlsVisible(true);
      const orbitStatus = byId('agentOpsOrbitStatus');
      if (orbitStatus) orbitStatus.textContent = 'Live projection';
    }

    return { show, clear };
  }

  return { normalizeContract, create };
});

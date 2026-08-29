/* global window, document, fetch, AbortController, MutationObserver, CustomEvent */

(() => {
  'use strict';

  const root = document.getElementById('playgroundCockpit');
  if (!root) return;

  const COLLAPSE_KEY = 'agentx.playground.cockpit.collapsed.v1';
  const COMPACT_DISCLOSURE_QUERY = '(max-width: 720px), (max-height: 640px)';
  const MODE_META = {
    quick: { label: 'Quick chat', task: 'Fast route', tone: 'router' },
    standard: { label: 'Standard chat', task: 'Core router', tone: 'router' },
    deep: { label: 'Deep reasoning', task: 'Deep router', tone: 'router' },
    manual: { label: 'Manual route', task: 'Explicit choice', tone: 'manual' },
  };
  const elements = {
    toggle: document.getElementById('pgToggleCockpit'),
    focus: document.getElementById('pgFocusComposer'),
    config: document.getElementById('pgOpenConfiguration'),
    refresh: document.getElementById('pgRefreshCockpit'),
    hosts: document.getElementById('pgHostDeck'),
    serviceSummary: document.getElementById('pgServiceSummary'),
    fleetSummary: document.getElementById('pgFleetSummary'),
    updated: document.getElementById('pgCockpitUpdated'),
    routeState: document.getElementById('pgRouteState'),
    routeIntent: document.getElementById('pgRouteIntent'),
    routeDecision: document.getElementById('pgRouteDecision'),
    routeHost: document.getElementById('pgRouteHost'),
    routeModel: document.getElementById('pgRouteModel'),
    routingMode: document.getElementById('routingModeSelect'),
    hostInput: document.getElementById('hostInput'),
    modelSelect: document.getElementById('modelSelect'),
    messageInput: document.getElementById('messageInput'),
    toggleConfig: document.getElementById('toggleConfigBtn'),
  };

  let hostInventory = [];
  let refreshTimer = null;

  function normalize(value) {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  function setText(element, value) {
    if (element) element.textContent = value;
  }

  function selectedText(select, fallback) {
    return select?.selectedOptions?.[0]?.textContent?.trim() || fallback;
  }

  function currentMode() {
    const value = String(elements.routingMode?.value || 'standard').toLowerCase();
    return MODE_META[value] ? value : 'standard';
  }

  function statusField(name) {
    return document.querySelector(`[data-ci-field="${name}"]`)?.textContent?.trim() || '';
  }

  function currentModelLabel(mode) {
    if (mode === 'manual') return selectedText(elements.modelSelect, 'Choose a model');
    const badge = document.getElementById('headerModelBadge')?.textContent?.trim();
    if (badge && badge !== '---') return badge;
    return 'On first reply';
  }

  function syncHostCards() {
    const selected = normalize(elements.hostInput?.value);
    root.querySelectorAll('.pg-host-card').forEach((card) => {
      const active = currentMode() === 'manual' && normalize(card.dataset.hostUrl) === selected;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function syncRoute() {
    const mode = currentMode();
    const meta = MODE_META[mode];
    const manual = mode === 'manual';
    const headerHost = statusField('host');
    const selectedHostEvidence = hostInventory.find((host) => normalize(host.url) === normalize(elements.hostInput?.value));
    const selectedHost = selectedHostEvidence ? hostLabel(selectedHostEvidence) : selectedText(elements.hostInput, 'Choose a host');
    const routeReason = statusField('route');

    root.querySelectorAll('[data-playground-mode]').forEach((button) => {
      const active = button.dataset.playgroundMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    setText(elements.routeIntent, meta.label);
    setText(elements.routeDecision, manual ? 'Explicit choice' : (routeReason && routeReason !== '---' ? routeReason.replace(/_/g, ' ') : meta.task));
    setText(elements.routeHost, manual ? selectedHost : (headerHost && headerHost !== '---' ? headerHost : 'Server-routed'));
    setText(elements.routeModel, currentModelLabel(mode));
    setText(elements.routeState, manual ? 'Manual' : 'Routed');
    if (elements.routeState) elements.routeState.dataset.tone = meta.tone;
    syncHostCards();
  }

  function setCollapsed(collapsed, persist = true) {
    root.classList.toggle('is-collapsed', collapsed);
    if (elements.toggle) {
      elements.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      elements.toggle.title = collapsed ? 'Expand cockpit' : 'Collapse cockpit';
      const icon = elements.toggle.querySelector('i');
      if (icon) icon.className = `fas ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}`;
      const label = elements.toggle.querySelector('.sr-only');
      if (label) label.textContent = collapsed ? 'Expand cockpit' : 'Collapse cockpit';
    }
    if (persist) {
      try { window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* storage is optional */ }
    }
  }

  async function getJson(route, timeoutMs = 8_000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(route, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      return body;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function hostLabel(host) {
    return host.name || host.displayName || host.id || 'Ollama host';
  }

  function selectHost(host) {
    if (!host?.available || !elements.hostInput || !elements.routingMode) return;
    elements.routingMode.value = 'manual';
    elements.routingMode.dispatchEvent(new Event('change', { bubbles: true }));

    const apply = () => {
      const option = [...elements.hostInput.options].find((item) => normalize(item.value) === normalize(host.url));
      if (!option) return false;
      elements.hostInput.value = option.value;
      elements.hostInput.dispatchEvent(new Event('change', { bubbles: true }));
      syncRoute();
      return true;
    };

    if (!apply()) window.setTimeout(apply, 250);
  }

  function makeHostCard(host) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pg-host-card';
    card.dataset.hostUrl = host.url || '';
    card.disabled = !host.available;
    card.setAttribute('aria-pressed', 'false');
    card.title = host.available ? `Use ${hostLabel(host)} in Manual mode` : (host.error || `${hostLabel(host)} is unavailable`);

    const head = document.createElement('span');
    head.className = 'pg-host-card-head';
    const name = document.createElement('strong');
    name.textContent = hostLabel(host);
    const state = document.createElement('span');
    state.className = `pg-host-state${host.available ? ' ok' : ''}`;
    state.title = host.available ? 'online' : 'offline';
    head.append(name, state);

    const detail = document.createElement('small');
    const models = Array.isArray(host.models) ? host.models.length : 0;
    detail.textContent = host.available
      ? `${models} chat model${models === 1 ? '' : 's'}${host.ollamaVersion ? ` · Ollama ${host.ollamaVersion}` : ''}`
      : 'Inventory unavailable';

    card.append(head, detail);
    card.addEventListener('click', () => selectHost(host));
    return card;
  }

  function renderHosts(hosts) {
    hostInventory = hosts;
    if (!elements.hosts) return;
    elements.hosts.replaceChildren();
    if (!hosts.length) {
      const empty = document.createElement('div');
      empty.className = 'pg-empty';
      empty.textContent = 'No Ollama hosts are configured.';
      elements.hosts.appendChild(empty);
      return;
    }
    hosts.forEach((host) => elements.hosts.appendChild(makeHostCard(host)));
    syncHostCards();
  }

  async function refreshEvidence() {
    root.dataset.state = 'loading';
    if (elements.refresh) elements.refresh.disabled = true;
    const demoProfile = document.body.dataset.agentxProfile === 'demo';

    const [portalResult, ecosystemResult, hostsResult] = await Promise.allSettled([
      demoProfile ? getJson('/api/portal/health') : Promise.resolve(null),
      demoProfile ? Promise.resolve(null) : getJson('/api/nerve-center/ecosystem'),
      getJson('/api/ollama-hosts', 12_000),
    ]);

    const portal = portalResult.status === 'fulfilled' ? portalResult.value : null;
    const ecosystemEnvelope = ecosystemResult.status === 'fulfilled' ? ecosystemResult.value : null;
    const ecosystem = ecosystemEnvelope?.status === 'success' ? ecosystemEnvelope.data : null;
    const hostEnvelope = hostsResult.status === 'fulfilled' ? hostsResult.value : null;
    const hosts = Array.isArray(hostEnvelope?.data?.hosts) ? hostEnvelope.data.hosts : [];
    const services = Array.isArray(ecosystem?.services)
      ? ecosystem.services
      : (Array.isArray(portal?.services) ? portal.services : []);

    renderHosts(hosts);

    const serviceHealth = ecosystem?.serviceHealth || portal?.summary || null;
    const total = Number(serviceHealth?.total || services.length || 0);
    const healthy = Number(serviceHealth?.healthy || services.filter((service) => service.status === 'ok').length || 0);
    const portalStatus = serviceHealth?.status || (portal || ecosystem ? 'degraded' : 'error');
    const identityConsistency = ecosystem?.identityConsistency || portal?.consistency || null;
    const onlineHosts = Number(ecosystem?.health?.onlineHosts ?? hosts.filter((host) => host.available).length);
    const configuredHosts = Number(ecosystem?.health?.configuredHosts ?? hosts.length);
    const observedModels = Number(ecosystem?.health?.observedModels ?? new Set(hosts.flatMap((host) => host.installedModels || host.models || [])).size);

    const identitySuffix = identityConsistency?.status === 'degraded'
      ? ' · deployment mismatch'
      : (identityConsistency?.status === 'unverified' ? ' · build unverified' : '');
    setText(elements.serviceSummary, total
      ? `${healthy}/${total} product services ready${identitySuffix}`
      : 'Product health unavailable');
    setText(elements.fleetSummary, `${onlineHosts}/${configuredHosts} hosts online · ${observedModels} observed models`);
    setText(elements.updated, `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);

    if (!portal && !ecosystem && !hosts.length) root.dataset.state = 'error';
    else if (portalStatus !== 'ok' || identityConsistency?.status === 'degraded' || ecosystem?.health?.status === 'degraded' || hosts.some((host) => !host.available)) root.dataset.state = 'degraded';
    else root.dataset.state = 'ok';

    if (elements.refresh) elements.refresh.disabled = false;
    syncRoute();
  }

  function setMode(mode) {
    if (!MODE_META[mode] || !elements.routingMode) return;
    elements.routingMode.value = mode;
    elements.routingMode.dispatchEvent(new Event('change', { bubbles: true }));
    syncRoute();
  }

  function focusComposer() {
    setCollapsed(true);
    elements.messageInput?.focus();
  }

  function observeRouteState() {
    const targets = [
      elements.routingMode,
      elements.hostInput,
      elements.modelSelect,
      document.getElementById('headerModelBadge'),
      document.querySelector('[data-ci-field="host"]'),
      document.querySelector('[data-ci-field="route"]'),
    ].filter(Boolean);
    const observer = new MutationObserver(syncRoute);
    targets.forEach((target) => observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true }));
    document.addEventListener('change', (event) => {
      if (['routingModeSelect', 'hostInput', 'modelSelect'].includes(event.target?.id)) syncRoute();
    });
  }

  function init() {
    const routingLab = root.closest('.chat-routing-lab');
    if (routingLab && window.matchMedia(COMPACT_DISCLOSURE_QUERY).matches) {
      routingLab.removeAttribute('open');
    }

    let collapsed = false;
    try { collapsed = window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { /* storage is optional */ }
    setCollapsed(collapsed, false);

    elements.toggle?.addEventListener('click', () => setCollapsed(!root.classList.contains('is-collapsed')));
    elements.focus?.addEventListener('click', focusComposer);
    elements.config?.addEventListener('click', () => elements.toggleConfig?.click());
    elements.refresh?.addEventListener('click', refreshEvidence);
    root.querySelectorAll('[data-playground-mode]').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.playgroundMode));
    });

    observeRouteState();
    syncRoute();
    refreshEvidence();
    refreshTimer = window.setInterval(refreshEvidence, 30_000);
    window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer), { once: true });
    window.dispatchEvent(new CustomEvent('agentx:playground-cockpit-ready'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

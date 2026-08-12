/**
 * Chat agents - launcher, OpenClaw handoff, and tool cards.
 */

const agentSystemLog = {
  info: (...args) => console.info('[AgentSystem]', ...args),
  debug: (...args) => console.debug('[AgentSystem]', ...args),
  warn: (...args) => console.warn('[AgentSystem]', ...args),
  error: (...args) => console.error('[AgentSystem]', ...args)
};

const escapeHtml = (value) => {
  if (window.AgentXUtils?.escapeHtml) return window.AgentXUtils.escapeHtml(value);
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
};

export async function initAgentSystem(elements, state) {
  const agentElements = {
    selector: document.getElementById('agentSelector'),
    selectorBar: document.getElementById('agentSelectorBar'),
    selectorLabel: document.getElementById('selectorLabel'),
    selectorCount: document.getElementById('selectorCount'),
    activePanel: document.getElementById('agentActivePanel'),
    defaultSummary: document.getElementById('defaultConfigSummary'),
    agentSummary: document.getElementById('agentConfigSummary'),
    changeBtn: document.getElementById('changeAgentBtn')
  };

  state._agentElements = agentElements;

  agentSystemLog.info('Initializing.');
  if (!agentElements.selector) {
    agentSystemLog.error('Agent selector missing.');
    return;
  }

  agentElements.selectorBar?.addEventListener('click', () => {
    agentElements.selector.classList.toggle('expanded');
  });
  agentElements.changeBtn?.addEventListener('click', () => expandSelector(agentElements));

  document.getElementById('headerChangeBtn')?.addEventListener('click', () => expandSelector(agentElements));
  document.getElementById('startChatCard')?.addEventListener('click', () => {
    agentElements.selectorLabel.textContent = 'Quick Chat';
    markQuickChatSelected();
    collapseSelector(agentElements);
    updateHeaderBar(null, state);
    elements.messageInput?.focus();
  });

  if (document.body.dataset.agentxProfile === 'demo') {
    document.getElementById('launcherOpenClaw')?.setAttribute('hidden', '');
    document.getElementById('launcherTools')?.setAttribute('hidden', '');
    updateLauncherCount(agentElements);
    collapseSelector(agentElements);
    return;
  }

  try {
    const [openclawAgents, dedicatedPersonas] = await Promise.all([
      loadOpenClawAgents(),
      loadDedicatedPersonas()
    ]);

    renderOpenClawAgents(openclawAgents);
    renderTools(dedicatedPersonas);
    updateLauncherCount(agentElements);

    const urlAgent = new URLSearchParams(window.location.search).get('agent');
    if (urlAgent && openclawAgents.some((agent) => agent.id === urlAgent)) {
      agentSystemLog.info('OpenClaw agent URL parameter detected; use the OpenClaw card to launch the official Control UI.', { agent: urlAgent });
    }

    window.dispatchEvent(new CustomEvent('agentx:agents-loaded', {
      detail: { openclawCount: openclawAgents.length, toolCount: dedicatedPersonas.length }
    }));
  } catch (error) {
    agentSystemLog.error('Failed to initialize launcher cards:', error);
  }

  collapseSelector(agentElements);
}

async function loadOpenClawAgents() {
  try {
    const res = await fetch('/api/openclaw/agents', { credentials: 'include' });
    if (!res.ok) return [];
    const result = await res.json();
    return Array.isArray(result.data) ? result.data : [];
  } catch {
    return [];
  }
}

async function loadDedicatedPersonas() {
  try {
    const res = await fetch('/api/prompts', { credentials: 'include' });
    if (!res.ok) return [];
    const result = await res.json();
    const grouped = result.data || {};
    const dedicated = [];

    for (const versions of Object.values(grouped)) {
      if (!versions || !versions.length) continue;
      const active = versions.find((item) => item.isActive) || versions[0];
      const uiType = active.uiConfig?.type || 'chat';
      const disposition = active.disposition || {};
      if (uiType !== 'chat' && disposition.launchable === true) {
        dedicated.push(active);
      }
    }

    return dedicated;
  } catch {
    return [];
  }
}

function renderOpenClawAgents(agents) {
  const grid = document.getElementById('openclawAgentGrid');
  const section = document.getElementById('launcherOpenClaw');
  if (!grid || !section) return;

  if (!agents.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  grid.innerHTML = agents.map((agent) => {
    const name = escapeHtml(agent.identity?.name || agent.name || agent.id);
    const emoji = escapeHtml(agent.identity?.emoji || agent.emoji || '');
    const iconHtml = emoji
      ? `<span style="font-size:1.3em">${emoji}</span>`
      : '<i class="fas fa-robot"></i>';
    const model = escapeHtml(agent.model?.primary || agent.model || 'unknown');
    return `
      <div class="agentx-card openclaw-card" tabindex="0" data-agent-id="${escapeHtml(agent.id)}">
        <div class="agentx-card-avatar" style="--avatar-color: #22c55e">
          ${iconHtml}
        </div>
        <div class="agentx-card-content">
          <div class="agentx-card-header">
            <h4 class="agentx-card-name">${name}</h4>
          </div>
          <p class="agentx-card-description">${model}</p>
        </div>
        <div class="agentx-card-actions">
          <button class="agentx-select-btn">Chat</button>
        </div>
      </div>`;
  }).join('');

  bindCardActivation(grid, '.openclaw-card', (card) => {
    const agent = agents.find((item) => item.id === card.dataset.agentId);
    if (agent) handleOpenClawAgentSelection(agent);
  });
}

function renderTools(dedicatedPersonas = []) {
  const grid = document.getElementById('toolsLauncherGrid');
  if (!grid) return;

  const personaIcons = {
    repo_watcher: 'fa-shield-alt'
  };

  const pageTools = [
    { id: 'janitor', label: 'Janitor', icon: 'fa-broom', href: '/janitor.html' },
    { id: 'files', label: 'Files', icon: 'fa-folder-open', href: '/files.html' },
    { id: 'network', label: 'Network', icon: 'fa-network-wired', href: '/network.html' },
    { id: 'storage', label: 'Storage', icon: 'fa-hdd', href: '/storage.html' },
    { id: 'databases', label: 'Databases', icon: 'fa-database', href: '/databases.html' },
    { id: 'live-data', label: 'Live Data', icon: 'fa-satellite-dish', href: '/live-data-dashboard.html' }
  ];

  const personaCards = dedicatedPersonas.map((persona) => {
    const route = persona.uiConfig?.route || '#';
    const icon = personaIcons[persona.name] || 'fa-robot';
    const label = formatLabel(persona.name);
    const desc = (persona.description || '').slice(0, 60);
    return `
      <div class="agentx-card tool-card" data-tool-href="${escapeHtml(route)}?persona=${escapeHtml(persona.name)}" tabindex="0">
        <div class="agentx-card-avatar" style="--avatar-color: #34d399">
          <i class="fas ${escapeHtml(icon)}"></i>
        </div>
        <div class="agentx-card-content">
          <div class="agentx-card-header">
            <h4 class="agentx-card-name">${escapeHtml(label)}</h4>
          </div>
          ${desc ? `<p class="agentx-card-description">${escapeHtml(desc)}</p>` : ''}
        </div>
        <div class="agentx-card-actions">
          <button class="agentx-select-btn"><i class="fas fa-external-link-alt"></i> Open</button>
        </div>
      </div>`;
  }).join('');

  const pageCards = pageTools.map((tool) => `
      <div class="agentx-card tool-card" data-tool-href="${escapeHtml(tool.href)}" tabindex="0">
        <div class="agentx-card-avatar" style="--avatar-color: #34d399">
          <i class="fas ${escapeHtml(tool.icon)}"></i>
        </div>
        <div class="agentx-card-content">
          <div class="agentx-card-header">
            <h4 class="agentx-card-name">${escapeHtml(tool.label)}</h4>
          </div>
        </div>
        <div class="agentx-card-actions">
          <button class="agentx-select-btn"><i class="fas fa-external-link-alt"></i> Open</button>
        </div>
      </div>
    `).join('');

  grid.innerHTML = personaCards + pageCards;
  bindCardActivation(grid, '.tool-card', (card) => {
    window.location.href = card.dataset.toolHref;
  });
}

function bindCardActivation(container, selector, activate) {
  container.querySelectorAll(selector).forEach((card) => {
    card.addEventListener('click', () => activate(card));
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate(card);
    });
  });
}

function handleOpenClawAgentSelection(agent) {
  const agentParam = agent?.id ? `?agent=${encodeURIComponent(agent.id)}` : '';
  window.open(`/api/openclaw/control-launch/chat${agentParam}`, '_blank', 'noopener');
}

function markQuickChatSelected() {
  document.querySelectorAll('.agent-selector-panel .agentx-card').forEach((card) => {
    card.classList.toggle('selected', card.id === 'startChatCard');
    const button = card.querySelector('.agentx-select-btn');
    if (button && card.id === 'startChatCard') {
      button.classList.add('selected');
      button.innerHTML = '<i class="fas fa-check"></i>';
    } else if (button?.classList.contains('selected')) {
      button.classList.remove('selected');
      button.textContent = button.closest('.openclaw-card') ? 'Chat' : 'Open';
    }
  });
}

function updateLauncherCount(agentElements) {
  const totalCards = document.querySelectorAll('.agent-selector-panel .agentx-card').length;
  if (agentElements.selectorCount) {
    agentElements.selectorCount.textContent = totalCards ? `${totalCards} available` : '';
  }
}

export function updateHeaderBar(agent, state) {
  const agentNameEl = document.getElementById('headerAgentName');
  const agentAvatarEl = document.getElementById('headerAgentAvatar');
  const modelBadgeEl = document.getElementById('headerModelBadge');

  if (!agentNameEl) return;

  agentNameEl.textContent = agent?.displayName || 'AgentX';
  if (agentAvatarEl) agentAvatarEl.innerHTML = '<i class="fas fa-robot"></i>';
  if (modelBadgeEl) {
    const mode = state.settings?.routingMode || 'standard';
    if (mode === 'manual') {
      // Manual mode answers with the explicitly selected model.
      modelBadgeEl.textContent = state.settings?.model || '';
    } else {
      // Server-routed modes: never assert the saved manual model — it is NOT
      // what answers. Show the last model that actually replied if we have
      // one, otherwise a neutral mode label until the first reply lands.
      const label = { quick: 'Quick', standard: 'Standard', deep: 'Deep' }[mode] || 'Standard';
      modelBadgeEl.textContent = state.lastRoutedModel || `${label} mode`;
    }
  }
}

function expandSelector(agentElements) {
  agentElements.selector?.classList.add('expanded');
}

function collapseSelector(agentElements) {
  agentElements.selector?.classList.remove('expanded');
}

function formatLabel(name) {
  return String(name || '')
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function reapplyAgentModel() {
  // Agent-specific model overrides belonged to the removed core AgentX store.
}

/**
 * Chat agents - product launcher and tool cards.
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
    document.getElementById('launcherTools')?.setAttribute('hidden', '');
    updateLauncherCount(agentElements);
    collapseSelector(agentElements);
    return;
  }

  try {
    const dedicatedPersonas = await loadDedicatedPersonas();
    renderTools(dedicatedPersonas);
    updateLauncherCount(agentElements);

    window.dispatchEvent(new CustomEvent('agentx:agents-loaded', {
      detail: { toolCount: dedicatedPersonas.length }
    }));
  } catch (error) {
    agentSystemLog.error('Failed to initialize launcher cards:', error);
  }

  collapseSelector(agentElements);
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

function renderTools(dedicatedPersonas = []) {
  const grid = document.getElementById('toolsLauncherGrid');
  if (!grid) return;

  const personaIcons = {
    repo_watcher: 'fa-shield-alt'
  };

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

  grid.innerHTML = personaCards;
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

function markQuickChatSelected() {
  document.querySelectorAll('.agent-selector-panel .agentx-card').forEach((card) => {
    card.classList.toggle('selected', card.id === 'startChatCard');
    const button = card.querySelector('.agentx-select-btn');
    if (button && card.id === 'startChatCard') {
      button.classList.add('selected');
      button.innerHTML = '<i class="fas fa-check"></i>';
    } else if (button?.classList.contains('selected')) {
      button.classList.remove('selected');
      button.textContent = 'Open';
    }
  });
}

function updateLauncherCount(agentElements) {
  const totalCards = document.querySelectorAll('.agent-selector-panel .agentx-card').length;
  agentElements.selector?.classList.toggle('single-option', totalCards <= 1);
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

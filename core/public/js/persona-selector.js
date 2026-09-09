/**
 * Persona Selector
 * Populates the header bar persona dropdown with chat-type personas.
 * Dashboard/gallery personas are handled by the Tools section in the chat launcher.
 */

(function() {
  'use strict';

  let personas = [];
  let currentPersona = null;
  let personasReady = false;

  const personaLog = {
    info: (...args) => console.info('[PersonaSelector]', ...args),
    debug: (...args) => console.debug('[PersonaSelector]', ...args),
    warn: (...args) => console.warn('[PersonaSelector]', ...args),
    error: (...args) => console.error('[PersonaSelector]', ...args)
  };

  /**
   * Load personas from API
   */
  async function loadPersonas() {
    try {
      const response = await fetch('/api/prompts/catalog', {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load personas');
      }

      const result = await response.json();
      personas = (Array.isArray(result.data) ? result.data : [])
        .filter(persona => persona.disposition?.selectable !== false);

      personaLog.info(`Loaded ${personas.length} personas.`);
      return personas;
    } catch (error) {
      personaLog.error('Error loading personas:', error);
      personas = [];
      return [];
    }
  }

  /**
   * Populate the header bar persona dropdown.
   * Only chat-type personas go here. Dashboard/gallery types are handled
   * by the tools section in the chat launcher.
   */
  function populatePersonaDropdown() {
    const dropdown = document.getElementById('headerPersonaSelect');
    if (!dropdown) return;

    const chatPersonas = personas.filter(p => {
      const uiType = p.uiConfig?.type || 'chat';
      return uiType === 'chat';
    });

    dropdown.innerHTML = chatPersonas.map(p => {
      const label = formatPersonaName(p.name);
      const selected = currentPersona && currentPersona.name === p.name ? 'selected' : '';
      return `<option value="${p.name}" ${selected}>${label}</option>`;
    }).join('');

    // Wire change event (use onchange to avoid listener accumulation on re-calls)
    dropdown.onchange = () => {
      selectPersona(dropdown.value);
    };

    // If no current persona, select the first (default)
    if (!currentPersona && chatPersonas.length > 0) {
      selectPersona(chatPersonas[0].name);
    }

    personaLog.info(`Populated persona dropdown with ${chatPersonas.length} entries.`);
  }

  /**
   * Select persona for chat
   */
  function selectPersona(personaName) {
    const persona = personas.find(p => p.name === personaName);
    if (!persona) {
      personaLog.error('Persona not found:', personaName);
      return;
    }

    currentPersona = persona;
    localStorage.setItem('agentx_current_persona', JSON.stringify(persona));

    // Update the prompt selector in the config drawer
    const promptSelect = document.getElementById('promptSelect');
    if (promptSelect) {
      promptSelect.value = personaName;
      promptSelect.dispatchEvent(new Event('change'));
    }

    // Update header persona dropdown
    const headerSelect = document.getElementById('headerPersonaSelect');
    if (headerSelect) headerSelect.value = personaName;

    if (window.showToast) {
      window.showToast(`Persona: ${formatPersonaName(personaName)}`, 'success');
    }
  }

  /**
   * Open persona's dedicated UI
   */
  function openPersonaUI(personaName, route) {
    if (route && route !== '/index.html') {
      // Navigate to dedicated UI
      window.location.href = route + `?persona=${personaName}`;
    } else {
      // Fall back to chat selection
      selectPersona(personaName);
    }
  }

  /**
   * Format persona name for display
   */
  function formatPersonaName(name) {
    const label = personas.find(p => p.name === name)?.uiConfig?.layoutConfig?.label;
    if (label) return label;
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Initialize
   */
  async function init() {
    personaLog.info('Initializing...');

    await loadPersonas();
    personasReady = true;

    // A shareable demo link may select a known chat persona. Unknown names are
    // ignored so a stale or hand-edited URL cannot create a client-only persona.
    const requestedName = new URLSearchParams(window.location.search).get('persona');
    if (requestedName) {
      currentPersona = personas.find(persona => persona.name === requestedName) || null;
      if (!currentPersona) personaLog.warn(`Ignoring unknown requested persona: ${requestedName}`);
    }

    // Fall back to the last known selection, but rebind it to the current API
    // result so removed or inactive personas do not survive in localStorage.
    if (!currentPersona) {
      const savedPersona = localStorage.getItem('agentx_current_persona');
      if (savedPersona) {
        try {
          const savedName = JSON.parse(savedPersona)?.name;
          currentPersona = personas.find(persona => persona.name === savedName) || null;
        } catch { /* ignore */ }
      }
    }

    populatePersonaDropdown();
    personaLog.info('Initialized.');
  }

  /**
   * Export public API
   */
  window.PersonaSelector = {
    init,
    loadPersonas,
    selectPersona,
    openPersonaUI,
    populatePersonaDropdown,
    formatPersonaName,
  };

  // Auto-initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

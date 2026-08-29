/**
 * Chat profile — Profile modal, save/load profile, prompts
 */
import { showModal } from './chat-messaging.js';
import { fetchWithDeadline } from './chat-network.js';

function escapePromptText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function openProfileModal(elements) {
  const modal = elements && elements.profileModal;
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.inert = false;
  modal.removeAttribute('aria-hidden');
  if (elements.profileBtn) elements.profileBtn.setAttribute('aria-expanded', 'true');

  const modalAccessibility = window.AgentXModalAccessibility;
  if (modalAccessibility) {
    modalAccessibility.activate(modal, {
      opener: elements.profileBtn,
      initialFocus: elements.userAbout,
      onRequestClose: () => closeProfileModal(elements)
    });
  } else if (elements.userAbout && typeof elements.userAbout.focus === 'function') {
    elements.userAbout.focus();
  }
}

export function closeProfileModal(elements) {
  const modal = elements && elements.profileModal;
  if (!modal) return;
  modal.classList.add('hidden');
  modal.inert = true;
  modal.setAttribute('aria-hidden', 'true');
  if (elements.profileBtn) elements.profileBtn.setAttribute('aria-expanded', 'false');

  const modalAccessibility = window.AgentXModalAccessibility;
  if (modalAccessibility) modalAccessibility.deactivate(modal);
  else if (elements.profileBtn && typeof elements.profileBtn.focus === 'function') elements.profileBtn.focus();
}

export async function loadProfile(elements) {
  if (document.body.dataset.agentxProfile === 'demo') return;
  try {
    const res = await fetchWithDeadline('/api/profile');
    if (!res.ok) {
      if (res.status !== 404) {
        console.warn('Profile endpoint unavailable:', res.status);
      }
      return;
    }
    const responseData = await res.json();
    const data = responseData.data || responseData;
    if (!data) return;
    elements.userAbout.value = data.about || '';
    elements.userInstructions.value = data.preferences?.customInstructions || '';
  } catch (err) {
    console.warn('Failed to load profile', err);
  }
}

export async function saveProfile(elements, setFeedback) {
  if (document.body.dataset.agentxProfile === 'demo') return;
  try {
    await fetchWithDeadline('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        about: elements.userAbout.value,
        preferences: { customInstructions: elements.userInstructions.value }
      }),
      credentials: 'include'
    });
    closeProfileModal(elements);
    setFeedback('Profile saved.', 'success');
    if (window.checkProfileSetup) window.checkProfileSetup();
    if (window.checkSetupProgress) window.checkSetupProgress();
  } catch (err) {
    console.warn('Failed to save profile', err);
    setFeedback('Failed to save profile.', 'error');
  }
}

export async function loadActivePrompt(personaName = null) {
  const promptSelect = document.getElementById('promptSelect');
  const selectedName = personaName
    || promptSelect?.value
    || new URLSearchParams(window.location.search).get('persona')
    || 'default_chat';
  const exactVersion = Number(promptSelect?.dataset.promptVersion || 0) || null;
  try {
    const res = await fetchWithDeadline(`/api/prompts/${encodeURIComponent(selectedName)}`, { credentials: 'include' });
    if (res.ok) {
      const result = await res.json();
      const activePromptNameEl = document.getElementById('activePromptName');
      if (result.status === 'success' && result.data.length > 0) {
        const selectedPrompt = exactVersion
          ? result.data.find(prompt => Number(prompt.version) === exactVersion)
          : result.data.find(prompt => prompt.isActive);
        if (selectedPrompt) {
          const promptName = `${selectedPrompt.name} v${selectedPrompt.version}${exactVersion ? ' · exact' : ''}`;
          if (activePromptNameEl) {
            activePromptNameEl.textContent = promptName;
            activePromptNameEl.setAttribute('data-tooltip', `Selected prompt: ${promptName}`);
          }
          return;
        }
      }
      if (activePromptNameEl) {
        activePromptNameEl.textContent = exactVersion
          ? `${selectedName} v${exactVersion} unavailable`
          : selectedName;
      }
    }
  } catch (err) {
    console.error('Failed to load active prompt:', err);
    const el = document.getElementById('activePromptName');
    if (el) el.textContent = selectedName;
  }
}

export async function loadPromptSelector() {
  try {
    const res = await fetchWithDeadline('/api/prompts', { credentials: 'include' });
    if (!res.ok) return;
    const result = await res.json();
    if (result.status !== 'success') return;

    const promptSelect = document.getElementById('promptSelect');
    if (!promptSelect) return;
    promptSelect.innerHTML = '';

    const promptNames = Object.keys(result.data).sort();
    if (promptNames.length === 0) {
      promptSelect.innerHTML = '<option value="default_chat">default_chat (auto)</option>';
      return;
    }

    const query = new URLSearchParams(window.location.search);
    const requestedName = query.get('persona');
    const requestedVersion = Number(query.get('promptVersion')) || null;
    let requestedEntry = null;

    promptNames.forEach(name => {
      const versions = result.data[name];
      // Prompts management retains archived/test evidence. Playground only
      // offers versions the API explicitly marks as selectable.
      const activeVersions = versions.filter(v => (
        v.isActive && v.disposition?.selectable !== false
      ));
      const exactRequested = name === requestedName && requestedVersion
        ? versions.find(v => Number(v.version) === requestedVersion && v.disposition?.selectable !== false)
        : null;
      if (exactRequested) requestedEntry = exactRequested;
      if (activeVersions.length > 0 || exactRequested) {
        const displayedVersion = exactRequested || activeVersions[0];
        const option = document.createElement('option');
        option.value = name;
        option.textContent = `${name} v${displayedVersion.version}${exactRequested ? ' (exact)' : ''}`;
        if (name === 'default_chat') option.selected = true;
        promptSelect.appendChild(option);
      }
    });

    if (!promptSelect.querySelector('option[value="default_chat"]')) {
      const fallback = document.createElement('option');
      fallback.value = 'default_chat';
      fallback.textContent = 'default_chat (auto)';
      fallback.selected = true;
      promptSelect.insertBefore(fallback, promptSelect.firstChild);
    }

    let savedName = null;
    try {
      savedName = JSON.parse(localStorage.getItem('agentx_current_persona'))?.name || null;
    } catch { /* ignore stale browser state */ }

    const preferredName = [requestedName, savedName, 'default_chat']
      .find(name => name && Array.from(promptSelect.options).some(option => option.value === name));
    if (preferredName) promptSelect.value = preferredName;
    if (preferredName === requestedName && requestedEntry) {
      promptSelect.dataset.promptVersion = String(requestedEntry.version);
    } else {
      delete promptSelect.dataset.promptVersion;
    }

    if (promptSelect.dataset.promptBadgeBound !== 'true') {
      promptSelect.addEventListener('change', () => {
        delete promptSelect.dataset.promptVersion;
        loadActivePrompt(promptSelect.value);
      });
      promptSelect.dataset.promptBadgeBound = 'true';
    }
    await loadActivePrompt(promptSelect.value);
  } catch (err) {
    console.error('Failed to load prompt selector:', err);
  }
}

export async function showPromptInfo() {
  const promptSelect = document.getElementById('promptSelect');
  if (!promptSelect) return;
  const selectedPrompt = promptSelect.value;

  try {
    const res = await fetchWithDeadline(`/api/prompts/${encodeURIComponent(selectedPrompt)}`, { credentials: 'include' });
    if (!res.ok) {
      if (typeof Toast !== 'undefined') Toast.error('Failed to load prompt details.');
      return;
    }
    const result = await res.json();
    if (result.status !== 'success' || result.data.length === 0) {
      if (typeof Toast !== 'undefined') Toast.warning('No prompt data found');
      return;
    }

    const exactVersion = Number(promptSelect.dataset.promptVersion || 0) || null;
    const activeVersion = (exactVersion
      ? result.data.find(prompt => Number(prompt.version) === exactVersion)
      : result.data.find(prompt => prompt.isActive)) || result.data[0];
    const description = escapePromptText(activeVersion.description || 'No description');
    const systemPrompt = escapePromptText(activeVersion.systemPrompt || '');
    const bodyHTML = `
      <p><strong>Description:</strong> ${description}</p>
      <p><strong>System Prompt:</strong></p>
      <pre style="background: #000; padding: 10px; border-radius: 4px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word;">${systemPrompt}</pre>
      <p><strong>Stats:</strong></p>
      <ul>
        <li>Impressions: ${activeVersion.stats?.impressions || 0}</li>
        <li>Positive: ${activeVersion.stats?.positiveCount || 0}</li>
        <li>Negative: ${activeVersion.stats?.negativeCount || 0}</li>
      </ul>
    `;
    showModal(`${activeVersion.name} v${activeVersion.version}`, bodyHTML);
  } catch (err) {
    console.error('Failed to show prompt info:', err);
    if (typeof Toast !== 'undefined') Toast.error('Error loading prompt details');
  }
}

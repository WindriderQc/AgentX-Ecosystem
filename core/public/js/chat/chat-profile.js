/**
 * Chat profile — Profile modal, save/load profile, prompts
 */
import { sanitizeHTML, showModal } from './chat-messaging.js';

export async function loadProfile(elements) {
  if (document.body.dataset.agentxProfile === 'demo') return;
  try {
    const res = await fetch('/api/profile');
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
    await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        about: elements.userAbout.value,
        preferences: { customInstructions: elements.userInstructions.value }
      }),
      credentials: 'include'
    });
    elements.profileModal.classList.add('hidden');
    setFeedback('Profile saved.', 'success');
    if (window.checkProfileSetup) window.checkProfileSetup();
    if (window.checkSetupProgress) window.checkSetupProgress();
  } catch (err) {
    console.warn('Failed to save profile', err);
    setFeedback('Failed to save profile.', 'error');
  }
}

export async function loadActivePrompt(personaName = null) {
  const selectedName = personaName
    || document.getElementById('promptSelect')?.value
    || new URLSearchParams(window.location.search).get('persona')
    || 'default_chat';
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(selectedName)}`, { credentials: 'include' });
    if (res.ok) {
      const result = await res.json();
      const activePromptNameEl = document.getElementById('activePromptName');
      if (result.status === 'success' && result.data.length > 0) {
        const activePrompts = result.data.filter(p => p.isActive);
        if (activePrompts.length > 0) {
          const promptName = `${activePrompts[0].name} v${activePrompts[0].version}`;
          if (activePromptNameEl) {
            activePromptNameEl.textContent = promptName;
            activePromptNameEl.setAttribute('data-tooltip', `Selected prompt: ${promptName}`);
          }
          return;
        }
      }
      if (activePromptNameEl) activePromptNameEl.textContent = selectedName;
    }
  } catch (err) {
    console.error('Failed to load active prompt:', err);
    const el = document.getElementById('activePromptName');
    if (el) el.textContent = selectedName;
  }
}

export async function loadPromptSelector() {
  try {
    const res = await fetch('/api/prompts', { credentials: 'include' });
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

    promptNames.forEach(name => {
      const versions = result.data[name];
      const activeVersions = versions.filter(v => v.isActive);
      if (activeVersions.length > 0) {
        const latestActive = activeVersions[0];
        const option = document.createElement('option');
        option.value = name;
        option.textContent = `${name} v${latestActive.version}`;
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

    const requestedName = new URLSearchParams(window.location.search).get('persona');
    let savedName = null;
    try {
      savedName = JSON.parse(localStorage.getItem('agentx_current_persona'))?.name || null;
    } catch { /* ignore stale browser state */ }

    const preferredName = [requestedName, savedName, 'default_chat']
      .find(name => name && Array.from(promptSelect.options).some(option => option.value === name));
    if (preferredName) promptSelect.value = preferredName;

    if (promptSelect.dataset.promptBadgeBound !== 'true') {
      promptSelect.addEventListener('change', () => loadActivePrompt(promptSelect.value));
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
    const res = await fetch(`/api/prompts/${selectedPrompt}`, { credentials: 'include' });
    if (!res.ok) {
      if (typeof Toast !== 'undefined') Toast.error('Failed to load prompt details.');
      return;
    }
    const result = await res.json();
    if (result.status !== 'success' || result.data.length === 0) {
      if (typeof Toast !== 'undefined') Toast.warning('No prompt data found');
      return;
    }

    const activeVersion = result.data.find(p => p.isActive) || result.data[0];
    const bodyHTML = `
      <p><strong>Description:</strong> ${activeVersion.description || 'No description'}</p>
      <p><strong>System Prompt:</strong></p>
      <pre style="background: #000; padding: 10px; border-radius: 4px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word;">${activeVersion.systemPrompt}</pre>
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

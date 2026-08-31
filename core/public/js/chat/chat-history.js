/**
 * Chat history — loadHistoryList, loadConversation, search/filters
 */
import { sanitizeHTML } from './chat-messaging.js';

function renderHistoryState(elements, state, title, detail = '') {
  const container = elements?.historyList;
  if (!container) return;
  container.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'history-list-state';
  panel.dataset.state = state;
  panel.setAttribute('role', state === 'error' ? 'alert' : 'status');

  const heading = document.createElement('strong');
  heading.textContent = title;
  panel.appendChild(heading);

  if (detail) {
    const description = document.createElement('span');
    description.textContent = detail;
    panel.appendChild(description);
  }

  container.appendChild(panel);
}

export async function loadHistoryList(elements, state) {
  renderHistoryState(elements, 'loading', 'Loading conversation history…');
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error(`History request failed: ${res.status}`);
    const { data } = await res.json();
    elements.historyList.innerHTML = '';
    if (!Array.isArray(data)) throw new Error('History response was invalid');
    if (data.length === 0) {
      renderHistoryState(
        elements,
        'empty',
        'No conversations yet',
        'Start a chat and it will appear here.'
      );
      return [];
    }

    data.forEach(item => {
      const div = document.createElement('div');
      div.className = 'history-item';
      if (state.conversationId === item.id) div.classList.add('active');

      let scoreBadge = '';
      if (item.qualityScore != null) {
        const color = item.qualityScore >= 80 ? '#22c55e' : item.qualityScore >= 60 ? '#eab308' : item.qualityScore >= 40 ? '#f59e0b' : '#ef4444';
        scoreBadge = `<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${item.qualityScore}/100">${item.qualityScore}</span>`;
      }

      div.innerHTML = `
        <div class="history-item-header">
          <div class="title">${sanitizeHTML(item.title)}${scoreBadge}</div>
          <div class="history-item-actions">
            <button class="history-menu-btn ghost" title="More actions" data-id="${item.id}" style="padding:2px 6px;font-size:0.7rem;flex-shrink:0;">
              <i class="fas fa-ellipsis-v"></i>
            </button>
          </div>
        </div>
        <div class="date">${new Date(item.date).toLocaleString()}</div>
      `;

      // Click to load conversation
      div.querySelector('.title').parentElement.addEventListener('click', (e) => {
        if (!e.target.closest('.history-menu-btn')) {
          state._helpers.loadConversation(item.id);
        }
      });

      // Context menu button
      div.querySelector('.history-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showHistoryContextMenu(e.currentTarget, item, state, elements);
      });

      elements.historyList.appendChild(div);
    });
    return data;
  } catch (err) {
    console.error('Failed to load history', err);
    renderHistoryState(
      elements,
      'error',
      'Conversation history unavailable',
      'Your current chat still works. Try reopening History in a moment.'
    );
    return [];
  }
}

function showHistoryContextMenu(btn, item, state, elements) {
  // Remove any existing context menu
  const existing = document.querySelector('.history-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'history-context-menu';
  menu.innerHTML = `
    <button class="ctx-menu-item" data-action="rename"><i class="fas fa-pen"></i> Rename</button>
    <button class="ctx-menu-item" data-action="export"><i class="fas fa-download"></i> Export</button>
    <button class="ctx-menu-item ctx-menu-danger" data-action="delete"><i class="fas fa-trash"></i> Delete</button>
  `;

  // Position near the button
  const rect = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 100}px`;
  menu.style.zIndex = '9999';

  document.body.appendChild(menu);

  // Close on outside click
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);

  // Actions
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    menu.remove();

    if (action === 'rename') {
      const newTitle = prompt('Rename conversation:', item.title);
      if (newTitle && newTitle.trim()) {
        try {
          await fetch(`/api/history/${item.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle.trim() }),
            credentials: 'include'
          });
          state._helpers.loadHistoryList();
          if (typeof Toast !== 'undefined') Toast.success('Conversation renamed');
        } catch (err) {
          console.error('Rename failed:', err);
        }
      }
    } else if (action === 'export') {
      try {
        const res = await fetch(`/api/history/${item.id}`);
        const responseData = await res.json();
        const conv = responseData.data || responseData;
        if (conv && conv.messages) {
          let md = `# ${conv.title || 'Conversation'}\n\n`;
          md += `Model: ${conv.model || 'unknown'}\nDate: ${new Date(conv.createdAt).toLocaleString()}\n\n---\n\n`;
          conv.messages.forEach(m => {
            md += `**${m.role === 'user' ? 'You' : 'AgentX'}:**\n${m.content}\n\n`;
          });
          const blob = new Blob([md], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${(conv.title || 'conversation').replace(/[^a-z0-9]/gi, '_')}.md`;
          a.click();
          URL.revokeObjectURL(a.href);
          if (typeof Toast !== 'undefined') Toast.success('Conversation exported');
        }
      } catch (err) {
        console.error('Export failed:', err);
      }
    } else if (action === 'delete') {
      if (confirm('Delete this conversation? This cannot be undone.')) {
        try {
          await fetch(`/api/history/${item.id}`, { method: 'DELETE', credentials: 'include' });
          if (state.conversationId === item.id) {
            state.conversationId = null;
            state._helpers.clearChat();
          }
          state._helpers.loadHistoryList();
          if (typeof Toast !== 'undefined') Toast.success('Conversation deleted');
        } catch (err) {
          console.error('Delete failed:', err);
        }
      }
    }
  });
}

export async function loadConversation(id, state, elements, helpers, preserveModelSelection = false) {
  try {
    const res = await fetch(`/api/history/${id}`);
    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`Conversation ${id} not found.`);
        state.conversationId = null;
        return false;
      }
      throw new Error(`Failed to load conversation: ${res.status}`);
    }
    const responseData = await res.json();
    const data = responseData.data || responseData;
    if (!data || !data._id) throw new Error('Invalid conversation data received');

    state.conversationId = data._id;
    state.history = [];
    elements.chatWindow.innerHTML = '';
    state.stats.messages = 0;
    state.stats.replies = 0;

    helpers.updateConversationStats(data);

    // Highlight active history item
    document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
    const activeItem = document.querySelector(`.history-item [data-id="${id}"]`)?.closest('.history-item');
    if (activeItem) activeItem.classList.add('active');

    if (!Array.isArray(data.messages)) return false;
    data.messages.forEach(msg => {
      helpers.appendMessage({
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt,
        id: msg._id,
        feedback: msg.feedback,
        stats: msg.stats,
        cost: msg.cost,
        metadata: msg.metadata || null,
        retryUserMessageId: msg.metadata?.retryable === true ? msg.metadata?.sourceUserMessageId || null : null,
        sourceUserMessageId: msg.metadata?.sourceUserMessageId || null,
        routingInfo: msg.metadata?.routingInfo || msg.stats?.meta?.routingInfo || null,
        ragSources: msg.ragSources,
        webSearchResults: msg.metadata?.webSearchResults || null
      }, { persist: true, count: true });
    });

    if (!preserveModelSelection && data.model) {
      const modelExists = Array.from(elements.modelSelect.options).some(opt => opt.value === data.model && !opt.disabled);
      if (modelExists) elements.modelSelect.value = data.model;
    }

    return true;
  } catch (err) {
    console.error('Failed to load conversation', err);
    return false;
  }
}

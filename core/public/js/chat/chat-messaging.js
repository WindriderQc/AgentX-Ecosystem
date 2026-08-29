/**
 * Chat messaging — sendMessage, streaming, appendMessage, renderMessage
 */
import {
  describePendingRuntimeChange, getHostChatState, getHostPinnedModels, getHostRunningModels, getRagOptions,
  isRouterMode, modelsEquivalent, readOptions, selectedHostPreference, sessionTaskType, targetHost,
  readProfileInputs, updateConfigSummary
} from './chat-config.js';
import { fetchWithDeadline } from './chat-network.js';

function sanitizeHTML(dirty) {
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify not loaded - rendering escaped text.');
    return String(dirty ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 'code', 'pre',
      'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2',
      'h3', 'h4', 'h5', 'h6', 'span', 'div', 'table',
      'thead', 'tbody', 'tr', 'th', 'td', 'img'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id'],
    ALLOW_DATA_ATTR: false
  });
}

// Exported for use by other modules (quality assessment, history)
export { sanitizeHTML };

function messageIdOf(message) {
  const value = message?.id ?? message?._id ?? null;
  return value === null || value === undefined ? null : String(value);
}

/**
 * Resolve the user turn paired with one rendered assistant response.
 *
 * New responses carry an explicit source id. Historical responses fall back
 * to their exact assistant id and the closest preceding user turn. Content is
 * deliberately never used as identity because repeated prompts are valid.
 */
export function userTurnForAssistant(history, assistantMessage) {
  const turns = Array.isArray(history) ? history : [];
  const explicitUserId = assistantMessage?.retryUserMessageId
    || assistantMessage?.sourceUserMessageId
    || null;

  if (explicitUserId) {
    const normalizedUserId = String(explicitUserId);
    return turns.find((turn) => (
      turn?.role === 'user' && messageIdOf(turn) === normalizedUserId
    )) || null;
  }

  const assistantId = messageIdOf(assistantMessage);
  let assistantIndex = turns.indexOf(assistantMessage);
  if (assistantIndex < 0 && assistantId) {
    assistantIndex = turns.findIndex((turn) => (
      turn?.role === 'assistant' && messageIdOf(turn) === assistantId
    ));
  }
  if (assistantIndex < 0) return null;

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === 'user') return turns[index];
  }
  return null;
}

export function turnActionForRequest(turnAction) {
  if (!turnAction) return null;
  const kind = turnAction.kind || turnAction.action;
  const sourceUserMessageId = turnAction.sourceUserMessageId == null
    ? null
    : String(turnAction.sourceUserMessageId);
  const sourceAssistantMessageId = turnAction.sourceAssistantMessageId == null
    ? null
    : String(turnAction.sourceAssistantMessageId);

  if ((kind !== 'ask-again' && kind !== 'retry') || !sourceUserMessageId) return null;
  if (kind === 'ask-again' && !sourceAssistantMessageId) return null;
  if (kind === 'retry' && sourceAssistantMessageId !== null) return null;

  return { kind, sourceUserMessageId, sourceAssistantMessageId };
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function modelFromStats(message) {
  return message?.stats?.meta?.model
    || message?.stats?.meta?.routingInfo?.routedModel
    || message?.stats?.meta?.routingInfo?.model
    || null;
}

function buildMessageRuntimeInfo(message) {
  if (!message || message.role !== 'assistant') return null;
  const routingInfo = message.routingInfo
    || message.metadata?.routingInfo
    || message.meta?.routingInfo
    || message.stats?.meta?.routingInfo
    || null;
  const model = routingInfo?.model
    || routingInfo?.routedModel
    || message.metadata?.model
    || modelFromStats(message);
  if (!model) return null;

  const host = routingInfo?.hostName || routingInfo?.routedHost || routingInfo?.host || routingInfo?.routedHostUrl || '';
  const route = routingInfo?.taskType || (routingInfo?.autoRouted ? 'auto' : routingInfo ? 'direct' : '');
  return { model, host, route };
}

export function setStatus(elements, text, tone = 'muted') {
  elements.statusChip.textContent = text;
  elements.statusChip.dataset.tone = tone;
  const container = elements.statusChip.closest('.chat-command-status');
  if (container) container.dataset.tone = tone;
  const icon = container?.querySelector('.chat-command-status__icon i');
  if (icon) {
    const working = /loading|sending|thinking|routing|waiting/i.test(text);
    icon.className = tone === 'success'
      ? 'fas fa-circle-check'
      : tone === 'error'
        ? 'fas fa-circle-xmark'
        : tone === 'warning'
          ? 'fas fa-triangle-exclamation'
          : working
            ? 'fas fa-circle-notch fa-spin'
            : 'fas fa-circle-info';
  }
}

export function setFeedback(elements, text, tone = 'muted') {
  elements.feedback.textContent = text;
  elements.feedback.style.color = tone === 'success' ? '#9ff6ff' : tone === 'error' ? '#ffb3b8' : tone === 'warning' ? '#ffd166' : 'var(--muted)';
}

/**
 * Show a modal dialog (replaces browser confirm/alert for structured content)
 */
export function showModal(title, bodyHTML) {
  let overlay = document.getElementById('genericModal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'genericModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-content" style="max-width:600px;max-height:80vh;overflow-y:auto;">
        <div class="modal-header">
          <h2 id="genericModalTitle"></h2>
          <button class="close-btn" id="genericModalClose">&times;</button>
        </div>
        <div class="modal-body" id="genericModalBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
    overlay.querySelector('#genericModalClose').addEventListener('click', () => overlay.classList.add('hidden'));
  }
  overlay.querySelector('#genericModalTitle').textContent = title;
  overlay.querySelector('#genericModalBody').innerHTML = sanitizeHTML(bodyHTML);
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
}

function buildRagSourceViewer(source, idx, setFeedbackFn) {
  const viewSource = () => {
    const title = source.metadata?.filename || 'Unknown Source';
    const score = source.score ? `${(source.score * 100).toFixed(0)}% match` : '';
    const content = source.content || source.excerpt || 'No content available';
    const bodyHTML = `
      <p><strong>Source:</strong> ${title} ${score ? `<span style="color:var(--accent)">(${score})</span>` : ''}</p>
      ${source.metadata?.filepath ? `<p style="font-size:0.8rem;color:var(--muted);">Path: ${source.metadata.filepath}</p>` : ''}
      <pre style="background:#000;padding:12px;border-radius:6px;max-height:400px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word;font-size:0.85rem;">${content}</pre>
    `;
    showModal(`Source [${idx + 1}]: ${title}`, bodyHTML);
  };
  return viewSource;
}

export function renderMessage(message, state, elements) {
  const role = message.role;
  const content = message.content;
  const messageId = message.id || message._id || null;
  const createdAt = message.createdAt || new Date().toISOString();
  const isSystemMessage = messageId && messageId.startsWith('a-');

  const bubble = document.createElement('div');
  bubble.className = `bubble ${role === 'user' ? 'user' : isSystemMessage ? 'system' : 'assistant'}`;
  if (messageId) bubble.dataset.id = messageId;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span>${role === 'user' ? 'You' : role === 'system' ? 'System' : 'AgentX'}</span>`;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(createdAt);
  meta.appendChild(document.createTextNode(' \u2022 '));
  meta.appendChild(time);

  const runtimeInfo = buildMessageRuntimeInfo(message);
  if (runtimeInfo) {
    const modelBadge = document.createElement('span');
    modelBadge.className = 'message-model-badge';
    modelBadge.textContent = runtimeInfo.model;
    modelBadge.title = [
      `model: ${runtimeInfo.model}`,
      runtimeInfo.host ? `host: ${runtimeInfo.host}` : '',
      runtimeInfo.route ? `route: ${runtimeInfo.route}` : ''
    ].filter(Boolean).join('\n');
    meta.appendChild(document.createTextNode(' \u2022 '));
    meta.appendChild(modelBadge);
  }

  const body = document.createElement('div');
  body.className = 'message-body';
  if (typeof marked !== 'undefined') {
    try {
      body.innerHTML = sanitizeHTML(marked.parse(content));
    } catch (err) {
      console.error('Markdown rendering failed:', err);
      body.textContent = content;
    }
  } else {
    body.textContent = content;
  }

  bubble.appendChild(meta);
  bubble.appendChild(body);

  // Message action bar (hover actions)
  if (role !== 'system' && !isSystemMessage) {
    const actionBar = document.createElement('div');
    actionBar.className = 'message-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
      }).catch(() => {
        copyBtn.innerHTML = '<i class="fas fa-times"></i>';
        setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
      });
    });
    actionBar.appendChild(copyBtn);

    if (role === 'user') {
      // Edit button (repopulates composer)
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.title = 'Edit';
      editBtn.innerHTML = '<i class="fas fa-pen"></i>';
      editBtn.addEventListener('click', () => {
        elements.messageInput.value = content;
        elements.messageInput.focus();
      });
      actionBar.appendChild(editBtn);
    }

    if (role === 'assistant' && (messageId || message.retryUserMessageId)) {
      const isRetry = Boolean(message.retryUserMessageId);
      // A completed persisted reply is not replaced by the current API. Call
      // that operation "Ask again" and persist an honest new user turn. Retry
      // is reserved for an attempt that never reached a durable completion.
      const actionLabel = isRetry ? 'Retry' : 'Ask again';
      const turnActionBtn = document.createElement('button');
      turnActionBtn.type = 'button';
      turnActionBtn.className = 'msg-action-btn';
      turnActionBtn.title = actionLabel;
      turnActionBtn.dataset.turnAction = isRetry ? 'retry' : 'ask-again';
      turnActionBtn.setAttribute('aria-label', `${actionLabel} this turn`);
      turnActionBtn.innerHTML = '<i class="fas fa-redo" aria-hidden="true"></i>';
      turnActionBtn.addEventListener('click', async () => {
        const userTurn = userTurnForAssistant(state.history, message);
        const userMessageId = messageIdOf(userTurn);
        if (!userTurn || !userMessageId || typeof state._helpers?.sendMessage !== 'function') {
          state._helpers?.setFeedback?.('This turn no longer has stable message evidence. Reload the conversation and try again.', 'error');
          return;
        }

        turnActionBtn.disabled = true;
        try {
          await state._helpers.sendMessage({
            action: isRetry ? 'retry' : 'ask-again',
            sourceUserMessageId: userMessageId,
            sourceAssistantMessageId: messageId
          });
        } finally {
          if (turnActionBtn.isConnected) turnActionBtn.disabled = false;
        }
      });
      actionBar.appendChild(turnActionBtn);
    }

    bubble.appendChild(actionBar);
  }

  // Code block copy buttons
  const codeBlocks = body.querySelectorAll('pre code, pre');
  codeBlocks.forEach((block) => {
    if (block.parentElement.tagName === 'PRE' && block.tagName === 'CODE') {
      // It's a <pre><code> — work with the <pre>
      const pre = block.parentElement;
      if (pre.querySelector('.code-block-header')) return; // already processed

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const header = document.createElement('div');
      header.className = 'code-block-header';

      // Detect language from class
      const langClass = Array.from(block.classList).find(c => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : '';
      const langLabel = document.createElement('span');
      langLabel.className = 'code-lang-label';
      langLabel.textContent = lang;
      header.appendChild(langLabel);

      const copyCodeBtn = document.createElement('button');
      copyCodeBtn.className = 'code-copy-btn';
      copyCodeBtn.innerHTML = '<i class="fas fa-copy"></i> Copy';
      copyCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(block.textContent).then(() => {
          copyCodeBtn.innerHTML = '<i class="fas fa-check"></i> Copied';
          setTimeout(() => { copyCodeBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        }).catch(() => {
          copyCodeBtn.innerHTML = '<i class="fas fa-times"></i> Failed';
          setTimeout(() => { copyCodeBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        });
      });
      header.appendChild(copyCodeBtn);

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    }
  });

  // RAG Citation Display
  if (role === 'assistant' && message.ragSources && Array.isArray(message.ragSources) && message.ragSources.length > 0) {
    const citationsDiv = document.createElement('details');
    citationsDiv.className = 'message-citations';

    const citationsTitle = document.createElement('summary');
    citationsTitle.className = 'citations-title';
    citationsTitle.style.cursor = 'pointer';
    citationsTitle.style.listStyle = 'none';
    citationsTitle.innerHTML = '<i class="fas fa-chevron-right" style="font-size: 0.8em; margin-right: 6px; transition: transform 0.2s;"></i><i class="fas fa-book"></i><span>Sources</span>';
    citationsDiv.appendChild(citationsTitle);

    citationsDiv.addEventListener('toggle', () => {
      const icon = citationsTitle.querySelector('.fa-chevron-right');
      icon.style.transform = citationsDiv.open ? 'rotate(90deg)' : 'rotate(0deg)';
    });

    message.ragSources.forEach((source, idx) => {
      const sourceItem = document.createElement('div');
      sourceItem.className = 'citation-item';
      sourceItem.setAttribute('role', 'button');
      sourceItem.setAttribute('tabindex', '0');
      sourceItem.setAttribute('aria-label', `View source ${idx + 1}: ${source.metadata?.filename || 'Unknown Source'}`);

      const sourceHeader = document.createElement('div');

      const sourceNum = document.createElement('span');
      sourceNum.className = 'citation-number';
      sourceNum.textContent = `[${idx + 1}]`;

      const sourceTitle = document.createElement('span');
      sourceTitle.className = 'citation-title';
      sourceTitle.textContent = source.metadata?.filename || 'Unknown Source';

      const sourceScore = document.createElement('span');
      sourceScore.className = 'citation-score';
      if (source.score) {
        sourceScore.textContent = `${(source.score * 100).toFixed(0)}% match`;
      }

      sourceHeader.appendChild(sourceNum);
      sourceHeader.appendChild(sourceTitle);
      if (source.score) sourceHeader.appendChild(sourceScore);

      if (source.wasCompressed) {
        const compressBadge = document.createElement('span');
        compressBadge.className = 'compression-badge';
        const compressionRatio = Number.isFinite(Number(source.compressionRatio))
          ? Math.max(0, Math.min(100, Number(source.compressionRatio)))
          : 0;
        const compressIcon = document.createElement('i');
        compressIcon.className = 'fas fa-compress-arrows-alt';
        compressBadge.appendChild(compressIcon);
        compressBadge.appendChild(document.createTextNode(` ${compressionRatio}%`));
        compressBadge.title = `Context compressed by ${compressionRatio}%`;
        sourceHeader.appendChild(compressBadge);
      }

      sourceItem.appendChild(sourceHeader);

      if (source.excerpt) {
        const sourceExcerpt = document.createElement('div');
        sourceExcerpt.className = 'citation-excerpt';
        sourceExcerpt.textContent = `"${source.excerpt}${source.excerpt.length >= 200 ? '...' : ''}"`;
        sourceItem.appendChild(sourceExcerpt);
      }

      const viewSource = buildRagSourceViewer(source, idx, (msg, tone) => setFeedback(elements, msg, tone));
      sourceItem.addEventListener('click', viewSource);
      sourceItem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewSource(); }
      });

      citationsDiv.appendChild(sourceItem);
    });

    bubble.appendChild(citationsDiv);
  }

  // Web Search Sources Display
  const webResults = (role === 'assistant') && (message.webSearchResults || message.metadata?.webSearchResults);
  if (webResults && Array.isArray(webResults) && webResults.length > 0) {
    const webSourcesDiv = document.createElement('details');
    webSourcesDiv.className = 'message-web-sources';

    const webTitle = document.createElement('summary');
    webTitle.className = 'web-sources-title';
    webTitle.style.cursor = 'pointer';
    webTitle.style.listStyle = 'none';
    webTitle.innerHTML = `<i class="fas fa-chevron-right" style="font-size: 0.8em; margin-right: 6px; transition: transform 0.2s;"></i><i class="fas fa-globe"></i><span>Web Sources (${webResults.length})</span>`;
    webSourcesDiv.appendChild(webTitle);

    webSourcesDiv.addEventListener('toggle', () => {
      const icon = webTitle.querySelector('.fa-chevron-right');
      if (icon) icon.style.transform = webSourcesDiv.open ? 'rotate(90deg)' : 'rotate(0deg)';
    });

    webResults.forEach((result, idx) => {
      const item = document.createElement('div');
      item.className = 'web-source-item';

      const link = document.createElement('a');
      link.href = safeExternalUrl(result.url);
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'web-source-link';
      link.textContent = result.title || `Source ${idx + 1}`;

      item.appendChild(link);

      if (result.snippet) {
        const snippet = document.createElement('div');
        snippet.className = 'web-source-snippet';
        snippet.textContent = result.snippet;
        item.appendChild(snippet);
      }

      webSourcesDiv.appendChild(item);
    });

    bubble.appendChild(webSourcesDiv);
  }

  // Stats Footer + Cost Display
  if (state.showStats && role === 'assistant' && (message.stats || message.cost)) {
    const statsDiv = document.createElement('div');
    statsDiv.className = 'message-stats';
    const parts = [];
    if (message.stats) {
      const { usage, performance } = message.stats;
      if (usage) parts.push(`${usage.totalTokens} tokens`);
      if (performance) {
        const duration = (performance.totalDuration / 1e9).toFixed(2);
        const tps = performance.tokensPerSecond ? `(${performance.tokensPerSecond} t/s)` : '';
        parts.push(`${duration}s ${tps}`);
      }
    }
    if (message.cost && message.cost.totalCost > 0) {
      const cost = message.cost.totalCost;
      parts.push(cost < 0.01 ? `$${cost.toFixed(6)}` : `$${cost.toFixed(4)}`);
    }
    if (parts.length > 0) {
      statsDiv.textContent = parts.join(' \u2022 ');
      bubble.appendChild(statsDiv);
    }
  }

  // Feedback controls for actual AI responses
  if (role === 'assistant' && messageId && !messageId.startsWith('a-')) {
    bubble.appendChild(buildFeedbackRow(messageId, state, elements));
  }

  // Per-message routing badge (Chat Intelligence layer)
  if (message.role === 'assistant' && typeof ChatIntelligence !== 'undefined') {
    const routingInfo = message.routingInfo || message.meta?.routingInfo;
    if (routingInfo) {
      const badge = ChatIntelligence.createRoutingBadge(routingInfo);
      if (badge) bubble.appendChild(badge);
    }
  }

  elements.chatWindow.appendChild(bubble);
  elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
}

function buildFeedbackRow(messageId, state, elements) {
  const row = document.createElement('div');
  row.className = 'feedback-row';

  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = 'Was this helpful?';
  row.appendChild(label);

  const controls = document.createElement('div');
  controls.className = 'feedback-controls';

  const comment = document.createElement('input');
  comment.type = 'text';
  comment.className = 'feedback-comment';
  comment.placeholder = 'Add an optional note, then click thumbs.';
  comment.autocomplete = 'off';

  const noteToggle = document.createElement('button');
  noteToggle.className = 'ghost small feedback-note-toggle';
  noteToggle.type = 'button';
  noteToggle.textContent = 'Add note';
  noteToggle.setAttribute('aria-expanded', 'false');

  const cancelNote = document.createElement('button');
  cancelNote.className = 'ghost small feedback-note-toggle';
  cancelNote.type = 'button';
  cancelNote.textContent = 'Hide note';
  cancelNote.style.display = 'none';

  const status = document.createElement('span');
  status.className = 'muted';

  const setNoteVisibility = (visible) => {
    comment.classList.toggle('visible', visible);
    noteToggle.style.display = visible ? 'none' : '';
    cancelNote.style.display = visible ? '' : 'none';
    noteToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible) comment.focus();
    else comment.value = '';
  };

  const send = async (rating) => {
    try {
      up.disabled = true;
      down.disabled = true;
      noteToggle.disabled = true;
      cancelNote.disabled = true;
      comment.disabled = true;
      await sendFeedback(state, messageId, rating, comment.value);
      up.style.display = 'none';
      down.style.display = 'none';
      noteToggle.style.display = 'none';
      cancelNote.style.display = 'none';
      comment.style.display = 'none';
      controls.style.display = 'none';
      label.style.display = 'none';
      status.textContent = rating > 0 ? 'Thanks! Marked helpful.' : 'Noted. Feedback saved.';
    } catch (err) {
      status.textContent = err.message;
      up.disabled = false;
      down.disabled = false;
      noteToggle.disabled = false;
      cancelNote.disabled = false;
      comment.disabled = false;
    }
  };

  const up = document.createElement('button');
  up.className = 'ghost';
  up.textContent = '\ud83d\udc4d';
  up.title = 'Good answer';
  up.addEventListener('click', () => send(1));

  const down = document.createElement('button');
  down.className = 'ghost';
  down.textContent = '\ud83d\udc4e';
  down.title = 'Needs work';
  down.addEventListener('click', () => send(-1));

  noteToggle.addEventListener('click', () => setNoteVisibility(true));
  cancelNote.addEventListener('click', () => setNoteVisibility(false));
  comment.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setNoteVisibility(false);
    }
  });

  controls.appendChild(up);
  controls.appendChild(down);
  controls.appendChild(noteToggle);
  controls.appendChild(cancelNote);
  row.appendChild(controls);
  row.appendChild(comment);
  row.appendChild(status);
  return row;
}

async function sendFeedback(state, messageId, rating, comment) {
  const payload = { conversationId: state.conversationId, messageId, rating, comment };
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'include'
  });
  const data = await res.json();
  if (!res.ok || data.status !== 'success') {
    throw new Error(data.message || 'Feedback failed');
  }
}

export function appendMessage(messageOrRole, contentOrOptions, state, elements) {
  const options = typeof messageOrRole === 'string' ? {} : (contentOrOptions || {});
  const persist = options.persist !== false;
  const count = options.count !== false;

  const message = typeof messageOrRole === 'string'
    ? {
        role: messageOrRole,
        content: contentOrOptions || '',
        createdAt: new Date().toISOString(),
        id: `m-${Date.now()}`,
      }
    : {
        ...messageOrRole,
        createdAt: messageOrRole.createdAt || new Date().toISOString(),
      };

  renderMessage(message, state, elements);

  if (persist) state.history.push(message);
  if (count) {
    if (message.role === 'user') state.stats.messages += 1;
    if (message.role === 'assistant') state.stats.replies += 1;
  }
  elements.statMessages.textContent = state.stats.replies;

  if (options.announcement && elements.chatAnnouncements) {
    elements.chatAnnouncements.textContent = '';
    window.setTimeout(() => {
      elements.chatAnnouncements.textContent = options.announcement;
    }, 0);
  }
}

/**
 * Build a routingInfo object from server response data.
 * Used for both status-bar updates and per-message routing badges.
 */
export function buildRoutingInfo(serverData) {
  if (!serverData) return null;
  const routing = serverData.routing || {};
  const model = routing.routedModel || serverData.model || null;
  const host = routing.routedHostUrl || serverData.target || null;
  const stats = serverData.stats || {};
  const usage = stats.usage || {};
  const perf = stats.performance || {};

  // Derive a short host name from the explicitly configured URL.
  let hostName = null;
  if (host) {
    try { hostName = new URL(host).hostname; } catch { hostName = host; }
  }

  const durationMs = perf.totalDuration ? Math.round(perf.totalDuration / 1e6) : 0;
  const durationStr = durationMs > 0 ? (durationMs / 1000).toFixed(2) + 's' : null;

  return {
    model: routing.routedModel || model,
    host: routing.routedHostUrl || host,
    hostName,
    hostHealth: host ? 'online' : '',
    taskType: routing.taskType || null,
    routedHost: routing.routedHost || null,
    autoRouted: routing.autoRouted === true,
    prompt: serverData.prompt || null,
    numCtx: serverData.numCtx || null,
    tokensIn: usage.promptTokens || 0,
    tokensOut: usage.completionTokens || 0,
    durationMs,
    duration: durationStr,
    cost: serverData.cost || null,
    fallbackUsed: routing.routed || false,
    fallbackReason: routing.taskType || null,
    status: 'success'
  };
}

export function historyBeforeCurrentTurn(history, currentUserMessageId) {
  const turns = Array.isArray(history) ? history : [];
  if (!currentUserMessageId || turns.length === 0) return turns;
  const normalizedId = String(currentUserMessageId);
  const currentTurnIndex = turns.findIndex((turn) => (
    turn?.role === 'user' && messageIdOf(turn) === normalizedId
  ));
  return currentTurnIndex >= 0 ? turns.slice(0, currentTurnIndex) : turns;
}

function buildPayload(
  elements,
  state,
  defaults,
  message,
  currentUserMessageId = null,
  turnAction = null
) {
  const ragOpts = getRagOptions(elements);
  const routerMode = isRouterMode(elements, state);
  const forceThinking = elements.thinkingToggle?.checked === true;
  // Server-routed session modes send a FIXED task type for the whole
  // conversation (deterministic routing, autoRouted: false) instead of
  // per-message auto-classification. Manual mode sends the explicit model+host.
  const taskType = routerMode ? sessionTaskType(elements, state) : null;
  const rawOptions = {
    ...readOptions(elements),
    persona: elements.promptSelect?.value || 'default_chat',
    ragExpand: ragOpts.ragExpand,
    ragHybrid: ragOpts.ragHybrid,
    ragRerank: ragOpts.ragRerank,
    ragCompress: ragOpts.ragCompress
  };
  const options = Object.fromEntries(
    Object.entries(rawOptions).filter(([, value]) => value !== '' && value !== undefined && value !== null)
  );
  return {
    target: routerMode ? undefined : targetHost(elements, defaults),
    model: routerMode ? 'auto' : elements.modelSelect.value,
    autoRoute: false,
    taskType: taskType || undefined,
    system: elements.systemPrompt.value.trim(),
    promptVersion: elements.promptSelect?.dataset.promptVersion
      ? Number(elements.promptSelect.dataset.promptVersion)
      : undefined,
    options,
    useRag: ragOpts.useRag,
    ragTopK: ragOpts.ragTopK,
    enableWebSearch: elements.webSearchToggle?.checked || false,
    thinkingMode: forceThinking ? 'on' : 'auto',
    ...(forceThinking ? { think: true } : {}),
    threadId: state.threadId,
    message,
    profile: readProfileInputs(elements),
    // The visible user turn is persisted before dispatch. The service appends
    // `message` to the inference envelope, so exclude that exact turn by id
    // while preserving intentional earlier prompts with identical text.
    messages: historyBeforeCurrentTurn(state.history, currentUserMessageId),
    conversationId: state.conversationId,
    ...(turnAction ? { turnAction } : {})
  };
}

function markSelectedManualModelLoaded(elements, state, defaults, model) {
  if (!model || isRouterMode(elements, state)) return;
  state.sessionLoadedModel = {
    host: targetHost(elements, defaults, { includeRouter: true }),
    model
  };
  const pref = selectedHostPreference(elements, state, defaults);
  if (!pref) return;
  pref.loadedModel = model;
  pref.loadedModels = [model];
  pref.live = {
    ...(pref.live || {}),
    online: pref.live?.online !== false,
    runningModels: [{ name: model }]
  };
}

export async function sendMessageStreamFetch(
  ctx,
  msgInput,
  modelInput,
  currentUserMessageId = null,
  turnAction = null
) {
  const { elements, state, defaults, helpers } = ctx;
  const message = msgInput || elements.messageInput.value.trim();

  const payload = buildPayload(
    elements,
    state,
    defaults,
    message,
    currentUserMessageId,
    turnAction
  );

  const assistantMessageDiv = document.createElement('div');
  assistantMessageDiv.className = 'message assistant';
  assistantMessageDiv.dataset.messageId = `a-${Date.now()}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  assistantMessageDiv.appendChild(contentDiv);

  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'thinking-content';
  thinkingDiv.style.display = 'none';
  thinkingDiv.innerHTML = '<strong>Thinking:</strong><br>';
  assistantMessageDiv.appendChild(thinkingDiv);

  elements.chatWindow.appendChild(assistantMessageDiv);
  elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;

  elements.sendBtn.textContent = 'Stop';
  elements.sendBtn.onclick = () => {
    const activeController = state.streamAbortController;
    if (!activeController) return;
    activeController.abort();
    // The active attempt owns `state.sending` and the controller until its
    // finally block settles. This prevents a late old attempt from clearing a
    // newer request that the user launched during an abort race.
    elements.sendBtn.disabled = true;
    elements.sendBtn.textContent = 'Stopping\u2026';
    helpers.setFeedback('Stopping stream\u2026', 'warning');
  };

  let fullContent = '';
  let thinkingContent = '';
  let doneReceived = false;
  let requestAbortController = null;

  const safeParseJson = (text, fallback) => {
    try { return JSON.parse(text); } catch { return fallback; }
  };

  const dispatchEvent = (eventName, rawData) => {
    if (eventName === 'token') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      fullContent += data.content || '';
      try {
        contentDiv.innerHTML = sanitizeHTML(marked.parse(fullContent));
      } catch (e) {
        contentDiv.textContent = fullContent;
      }
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'thinking') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      thinkingContent += data.content || '';
      thinkingDiv.innerHTML = sanitizeHTML(`<strong>Thinking:</strong><br>${marked.parse(thinkingContent)}`);
      thinkingDiv.style.display = 'block';
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'web-search-start') {
      contentDiv.innerHTML = '<span style="color:var(--accent);font-size:0.9em;"><i class="fas fa-globe" style="margin-right:4px"></i> Searching web\u2026</span>';
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'web-search-done') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      const count = Number.isInteger(data.resultCount) && data.resultCount >= 0 ? data.resultCount : 0;
      contentDiv.innerHTML = `<span style="color:var(--accent);font-size:0.9em;"><i class="fas fa-globe" style="margin-right:4px"></i> Found ${count} result${count !== 1 ? 's' : ''}. Thinking\u2026</span>`;
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'done') {
      const finalData = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      state.conversationId = finalData.conversationId || state.conversationId;
      const routingInfo = buildRoutingInfo(finalData);
      if (routingInfo?.model) state.lastRoutedModel = routingInfo.model;
      const assistantMessage = {
        role: 'assistant', content: fullContent,
        createdAt: new Date().toISOString(),
        id: finalData.messageId || null,
        sourceUserMessageId: currentUserMessageId,
        stats: finalData.stats || null,
        thinking: thinkingContent || null,
        webSearchResults: finalData.webSearchResults || null,
        routingInfo
      };
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      helpers.appendMessage(assistantMessage, { announcement: 'Assistant response complete.' });
      helpers.speakText(fullContent);
      helpers.setFeedback('Response received.', 'success');
      helpers.loadHistoryList();
      if (state.conversationId) helpers.loadConversation(state.conversationId, true);
      if (window.checkSetupProgress) setTimeout(() => window.checkSetupProgress(), 500);
      doneReceived = true;

      // Update Chat Intelligence status bar
      if (routingInfo && typeof ChatIntelligence !== 'undefined') {
        ChatIntelligence.updateStatusBar({
          model: routingInfo.model,
          host: routingInfo.hostName,
          hostHealth: routingInfo.hostHealth,
          routeReason: routingInfo.taskType || 'direct',
          contextSize: routingInfo.numCtx
        });
      }
      markSelectedManualModelLoaded(elements, state, defaults, routingInfo?.model || payload.model);
      state.pendingRuntimeNoticeKey = null;
      helpers.applyChatAvailability?.();
      helpers.setStatus('Ready to chat', 'success');
      return;
    }
    if (eventName === 'error') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      throw new Error(data.message || 'Streaming failed.');
    }
  };

  const parseAndDispatchSse = (chunk, bufferState) => {
    bufferState.buffer += chunk;
    bufferState.buffer = bufferState.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let sepIndex;
    while ((sepIndex = bufferState.buffer.indexOf('\n\n')) !== -1) {
      const frame = bufferState.buffer.slice(0, sepIndex);
      bufferState.buffer = bufferState.buffer.slice(sepIndex + 2);
      if (!frame.trim()) continue;
      const lines = frame.split('\n');
      let eventName = 'message';
      const dataLines = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) { eventName = line.slice('event:'.length).trim() || 'message'; continue; }
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      }
      const data = dataLines.join('\n');
      if (eventName !== 'message') dispatchEvent(eventName, data);
    }
  };

  try {
    const abortController = new AbortController();
    requestAbortController = abortController;
    state.streamAbortController = abortController;
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
      signal: abortController.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Streaming failed (${res.status})`);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('Streaming not supported by this browser/proxy (no readable stream).');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const bufferState = { buffer: '' };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parseAndDispatchSse(decoder.decode(value, { stream: true }), bufferState);
      if (doneReceived) {
        // `done` is the successful terminal receipt. Stop reading without
        // reusing the user-cancellation AbortError path, which can otherwise
        // append the completed assistant turn a second time.
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!doneReceived) {
      throw new Error('The response stream ended before completion.');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      if (!doneReceived) {
        helpers.appendMessage(
          {
            role: 'assistant',
            content: fullContent || '(stopped)',
            createdAt: new Date().toISOString(),
            thinking: thinkingContent || null,
            retryUserMessageId: currentUserMessageId
          },
          { persist: false, announcement: 'Response stopped.' }
        );
      }
      if (!doneReceived) helpers.setFeedback('Streaming stopped.', 'warning');
      return;
    }
    console.error('Fetch streaming error:', err);
    if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
    helpers.appendMessage(
      {
        role: 'assistant',
        content: `\u26a0\ufe0f ${err.message || 'Streaming failed.'}`,
        createdAt: new Date().toISOString(),
        retryUserMessageId: currentUserMessageId
      },
      { persist: false, announcement: 'Response failed. Review the status message.' }
    );
    const routeSetupError = /model unavailable|model .*not found/i.test(err.message || '');
    helpers.setStatus(routeSetupError ? 'Model route needs attention' : 'Response blocked', routeSetupError ? 'warning' : 'error');
    const statusHelp = document.getElementById('chatStatusHelp');
    if (statusHelp) {
      statusHelp.textContent = routeSetupError
        ? 'Take the controls to choose one of the installed models.'
        : 'Review the error below, then try again.';
    }
    helpers.setFeedback(err.message, 'error');
  } finally {
    if (state.streamAbortController === requestAbortController) {
      state.streamAbortController = null;
      state.sending = false;
      elements.sendBtn.disabled = false;
      elements.sendBtn.textContent = 'Send';
      elements.sendBtn.onclick = () => helpers.sendMessage();
      helpers.applyChatAvailability?.();
    }
  }
}

export async function sendMessage(ctx, turnAction = null) {
  const { elements, state, defaults, helpers } = ctx;
  if (state.sending) return;
  if (state.warming) {
    helpers.setFeedback('Model is still loading, please wait…', 'muted');
    return;
  }

  const actionKind = turnAction?.action || null;
  const isRetry = actionKind === 'retry';
  const isAskAgain = actionKind === 'ask-again';
  if (turnAction && (!actionKind || (!isRetry && !isAskAgain))) {
    helpers.setFeedback('Unknown turn action. Reload the conversation and try again.', 'error');
    return;
  }
  const sourceUserMessageId = turnAction?.sourceUserMessageId == null
    ? null
    : String(turnAction.sourceUserMessageId);
  const sourceUserMessage = sourceUserMessageId
    ? state.history.find((turn) => (
        turn?.role === 'user' && messageIdOf(turn) === sourceUserMessageId
      ))
    : null;
  if (actionKind && !sourceUserMessage) {
    helpers.setFeedback('The selected user turn is no longer available. Reload the conversation and try again.', 'error');
    return;
  }
  const requestTurnAction = actionKind ? turnActionForRequest({
    kind: actionKind,
    sourceUserMessageId,
    sourceAssistantMessageId: turnAction?.sourceAssistantMessageId ?? null
  }) : null;
  if (actionKind && !requestTurnAction) {
    helpers.setFeedback('The selected turn action has incomplete message evidence. Reload the conversation and try again.', 'error');
    return;
  }

  const message = actionKind
    ? String(sourceUserMessage.content || '').trim()
    : elements.messageInput.value.trim();
  const model = elements.modelSelect.value;
  const routerMode = isRouterMode(elements, state);
  if (!message) return;
  const hostState = getHostChatState(elements, state, defaults);
  if (!hostState.available) {
    helpers.setFeedback(hostState.reason || 'Chat is unavailable for the selected route.', 'error');
    helpers.setStatus('Chat unavailable', 'error');
    return;
  }
  if (!routerMode && !model) {
    helpers.setFeedback('Select a model first.', 'error');
    return;
  }
  const runtimeChange = describePendingRuntimeChange(elements, state, defaults);
  if (runtimeChange.pending && state.pendingRuntimeNoticeKey !== runtimeChange.key) {
    state.pendingRuntimeNoticeKey = runtimeChange.key;
    helpers.setStatus('Runtime change pending', 'warning');
    const confirmationLabel = isRetry ? 'Retry' : isAskAgain ? 'Ask again' : 'Send';
    helpers.setFeedback(`${runtimeChange.message} Click ${confirmationLabel} again to run.`, 'warning');
    elements.sendBtn.textContent = 'Send and load';
    if (!actionKind) elements.messageInput.focus();
    return;
  }

  // Retry reuses the visible, unpersisted user turn. Ask again intentionally
  // creates a new user turn because the current API does not replace a
  // completed response; this keeps the UI aligned with durable history.
  const userMessage = isRetry
    ? sourceUserMessage
    : { role: 'user', content: message, id: `u-${Date.now()}`, createdAt: new Date().toISOString() };
  const currentUserMessageId = messageIdOf(userMessage);
  if (!currentUserMessageId) {
    helpers.setFeedback('The selected turn has no stable message identity. Reload the conversation and try again.', 'error');
    return;
  }
  if (!isRetry) helpers.appendMessage(userMessage);
  if (!actionKind) {
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto'; // Reset auto-resize
  }
  state.sending = true;
  elements.sendBtn.textContent = 'Sending\u2026';

  if (elements.streamToggle && elements.streamToggle.checked) {
    await sendMessageStreamFetch(ctx, message, model, currentUserMessageId, requestTurnAction);
    return;
  }

  try {
    const payload = {
      ...buildPayload(
        elements,
        state,
        defaults,
        message,
        currentUserMessageId,
        requestTurnAction
      ),
      stream: false
    };
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Chat failed');

    state.profile = data.data?.profile || state.profile;
    state.conversationId = data.data?.conversationId || state.conversationId;

    const responseText = data.data?.message?.content || data.data?.response || data.data?.output || 'No response from Ollama.';
    const routingInfo = buildRoutingInfo(data.data);
    if (routingInfo?.model) state.lastRoutedModel = routingInfo.model;
    const assistantMessage = {
      role: 'assistant', content: responseText,
      createdAt: new Date().toISOString(),
      id: data.data?.messageId || null,
      sourceUserMessageId: currentUserMessageId,
      stats: data.data?.stats || null,
      webSearchResults: data.data?.webSearchResults || null,
      routingInfo
    };
    helpers.appendMessage(assistantMessage, { announcement: 'Assistant response complete.' });
    helpers.speakText(responseText);

    // Update Chat Intelligence status bar
    if (routingInfo && typeof ChatIntelligence !== 'undefined') {
      ChatIntelligence.updateStatusBar({
        model: routingInfo.model,
        host: routingInfo.hostName,
        hostHealth: routingInfo.hostHealth,
        routeReason: routingInfo.taskType || 'direct',
        contextSize: routingInfo.numCtx
      });
    }
    markSelectedManualModelLoaded(elements, state, defaults, routingInfo?.model || payload.model);
    state.pendingRuntimeNoticeKey = null;
    helpers.applyChatAvailability?.();
    helpers.setStatus('Ready to chat', 'success');

    if (data.warning) {
      helpers.setFeedback(`\u26a0\ufe0f ${data.warning}`, 'warning');
      setTimeout(() => helpers.setFeedback('Response received.', 'success'), 3000);
    } else {
      helpers.setFeedback('Response received.', 'success');
    }
    helpers.loadHistoryList();
    if (state.conversationId) helpers.refreshStats(state.conversationId);
    if (state.conversationId) helpers.loadConversation(state.conversationId, true);
    if (window.checkSetupProgress) setTimeout(() => window.checkSetupProgress(), 500);
  } catch (err) {
    console.error(err);
    helpers.appendMessage(
      {
        role: 'assistant',
        content: `\u26a0\ufe0f ${err.message || 'Request failed.'}`,
        createdAt: new Date().toISOString(),
        retryUserMessageId: currentUserMessageId
      },
      { persist: false, announcement: 'Response failed. Review the status message.' }
    );
    helpers.setFeedback(err.message, 'error');
    helpers.setStatus('Check host/model.', 'error');
  } finally {
    state.sending = false;
    elements.sendBtn.textContent = 'Send';
  }
}

export async function fetchModels(ctx, showStatus = true) {
  const { elements, state, defaults, helpers } = ctx;
  if (showStatus) helpers.setStatus('Connecting\u2026');
  try {
    const routerMode = isRouterMode(elements, state);
    const host = targetHost(elements, defaults, { includeRouter: true });
    const hostState = getHostChatState(elements, state, defaults);
    const readinessUi = window.ChatModelReadiness;
    if (!routerMode && !hostState.available) {
      const reason = hostState.reason || 'Chat unavailable for selected host.';
      elements.modelSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = reason;
      elements.modelSelect.appendChild(opt);
      helpers.setStatus(`Unavailable: ${hostState.unavailableKind || hostState.status || 'host'}`, 'error');
      helpers.setFeedback(hostState.reason || 'Selected host is unavailable for chat.', 'error');
      updateConfigSummary(elements);
      return;
    }
    const res = await fetchWithDeadline(`/api/models/all?host=${encodeURIComponent(host)}&status=available&scope=runtime`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    const requireProfiledModels = res.headers.get('x-require-profiled-models') === 'true';
    const modelEvidence = res.headers.get('x-model-evidence') || 'available';
    elements.modelSelect.dataset.requireProfiledModels = requireProfiledModels ? 'true' : 'false';
    elements.modelSelect.dataset.modelEvidence = modelEvidence;
    const models = Array.isArray(data)
      ? data
      : (data.data && data.data.models) || data.data || data.models || [];
    elements.modelSelect.innerHTML = '';
    if (!Array.isArray(models) || models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models found';
      elements.modelSelect.appendChild(opt);
    } else {
      const orderedModels = readinessUi
        ? [...models].sort((left, right) => readinessUi.compareForDropdown(left, right))
        : [...models];
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = routerMode ? 'Model chosen by mode' : 'Select a model\u2026';
      elements.modelSelect.appendChild(placeholder);
      orderedModels.forEach((model) => {
        const opt = document.createElement('option');
        opt.value = model.name;
        if (readinessUi) {
          readinessUi.applyOptionState(opt, model, requireProfiledModels);
        } else {
          opt.textContent = model.name;
        }
        const pref = selectedHostPreference(elements, state, defaults);
        const runningModels = getHostRunningModels(pref);
        const pinnedModels = getHostPinnedModels(pref);
        const isLoaded = runningModels.some((running) => modelsEquivalent(running, model.name));
        const isPinned = pinnedModels.some((pinned) => modelsEquivalent(pinned, model.name));
        if (isLoaded || isPinned) {
          opt.dataset.chatPriority = isLoaded ? 'loaded' : 'pinned';
          const label = isLoaded ? 'loaded' : 'pinned';
          if (!String(opt.textContent || '').includes(label)) {
            opt.textContent = `${opt.textContent || model.name} (${label})`;
          }
        }
        elements.modelSelect.appendChild(opt);
      });
      const requestedModel = !routerMode ? state.requestedRuntime?.model : null;
      const selectableOptions = Array.from(elements.modelSelect.options)
        .filter((option) => option.value && !option.disabled);
      if (requestedModel) {
        const requestedOption = selectableOptions
          .find((option) => modelsEquivalent(option.value, requestedModel));
        if (requestedOption) {
          elements.modelSelect.value = requestedOption.value;
          state.requestedRuntime.error = null;
        } else {
          elements.modelSelect.value = '';
          const requestedHost = state.requestedRuntime.host || host;
          state.requestedRuntime.error = `Requested model ${requestedModel} is unavailable on ${requestedHost}. Choose another model or host to continue.`;
          helpers.setStatus('Requested route unavailable', 'error');
          helpers.setFeedback(state.requestedRuntime.error, 'error');
          updateConfigSummary(elements);
          return;
        }
      } else if (!routerMode && hostState.available) {
        const pref = selectedHostPreference(elements, state, defaults);
        const priorityModels = [
          ...getHostRunningModels(pref),
          ...getHostPinnedModels(pref),
          state.settings.model
        ].filter(Boolean);
        const picked = priorityModels
          .map((candidate) => selectableOptions.find((option) => modelsEquivalent(option.value, candidate)))
          .find(Boolean);
        if (picked) elements.modelSelect.value = picked.value;
      }

      if (!requestedModel && !routerMode && hostState.available && !elements.modelSelect.value) {
        const firstAllowedOption = selectableOptions[0];
        if (firstAllowedOption) elements.modelSelect.value = firstAllowedOption.value;
      }
    }
    helpers.setStatus('Ready', 'success');
    helpers.setFeedback(
      modelEvidence === 'deferred'
        ? 'Live host inventory is ready. Profiler evidence stays on the Models and Benchmark surfaces so chat startup remains responsive.'
        : requireProfiledModels
        ? 'Models refreshed with profiler gate active.'
        : routerMode
          ? 'Session mode active. Manual model list refreshed but not selected.'
          : hostState.available
            ? (hostState.reason || 'Models refreshed with host runtime data.')
            : (hostState.reason || 'Selected host is unavailable for chat.'),
      hostState.available ? 'success' : 'error'
    );
    updateConfigSummary(elements);
  } catch (err) {
    console.warn('Failed to fetch models:', err.message);
    helpers.setStatus('Connection failed', 'error');
    let userMessage = 'Unable to connect to Ollama.';
    if (err.message.includes('EHOSTUNREACH') || err.message.includes('ECONNREFUSED')) {
      userMessage = `Cannot reach ${targetHost(elements, defaults)}. Check if Ollama is running.`;
    } else if (err.message.includes('ETIMEDOUT')) {
      userMessage = `Connection timed out.`;
    } else if (err.message.includes('500')) {
      userMessage = err.message;
    }
    helpers.setFeedback(userMessage, 'error');
    elements.modelSelect.innerHTML = '<option value="">\u26a0\ufe0f Connection failed</option>';
  }
}

/**
 * Check if a model is already loaded on the target host, and if not,
 * freeze the input and fire a warmup request so the first real message
 * doesn't time out waiting for model load.
 */
let _warmupAbort = null;

export function cancelModelWarmup(ctx = {}) {
  if (_warmupAbort) {
    _warmupAbort.abort();
    _warmupAbort = null;
  }
  if (ctx.state) ctx.state.warming = false;
  if (ctx.elements) {
    ctx.elements.messageInput.disabled = false;
    ctx.elements.sendBtn.disabled = false;
  }
}

export async function warmupModelIfNeeded(ctx) {
  const { elements, state, defaults, helpers } = ctx;
  if (isRouterMode(elements, state)) return;
  const model = elements.modelSelect.value;
  if (!model) return;

  const host = targetHost(elements, defaults);
  if (!host) return;

  // Abort any in-flight warmup (user switched model/host again)
  if (_warmupAbort) _warmupAbort.abort();

  // Check if model is already loaded via cluster live state
  try {
    const liveRes = await fetch('/api/cluster/schedule/live');
    if (liveRes.ok) {
      const live = await liveRes.json();
      const hostEntry = (live.data?.hosts || []).find(h =>
        h.url && host.includes(new URL(h.url).hostname)
      );
      if (hostEntry?.models?.some(m => m.name === model || m.model === model)) {
        return; // Already loaded, no warmup needed
      }
    }
  } catch { /* fall through to warmup */ }

  // Freeze input while model loads
  const abort = _warmupAbort = new AbortController();
  state.warming = true;
  elements.messageInput.disabled = true;
  elements.messageInput.placeholder = 'Loading model…';
  elements.sendBtn.disabled = true;
  helpers.setStatus('Loading model…', 'muted');
  helpers.setFeedback(`Warming up ${model} — this may take a moment.`, 'muted');

  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        message: 'hi',
        messages: [],
        stream: false,
        host: host
      }),
      signal: abort.signal
    });

    helpers.setStatus('Ready', 'success');
    helpers.setFeedback(`${model} loaded and ready.`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') return; // Superseded by newer warmup
    helpers.setStatus('Model load failed', 'error');
    helpers.setFeedback(`Warmup failed: ${err.message}`, 'error');
  } finally {
    if (_warmupAbort === abort) {
      // Only unfreeze if this is still the active warmup
      state.warming = false;
      elements.messageInput.disabled = false;
      elements.messageInput.placeholder = '';
      elements.sendBtn.disabled = false;
      elements.messageInput.focus();
      if (typeof helpers.applyChatAvailability === 'function') {
        helpers.applyChatAvailability();
      }
      _warmupAbort = null;
    }
  }
}

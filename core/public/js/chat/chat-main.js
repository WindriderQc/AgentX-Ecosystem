/**
 * Chat main — Init, state, event wiring, DOMContentLoaded
 * Entry point for the chat page module system.
 */
import { DEFAULTS } from './chat-constants.js';
import {
  loadSettings, hydrateForm, persistSettings as _persistSettings,
  updateRangeDisplays, updateConfigSummary, toggleRagOptions,
  checkRagAvailability, loadServerConfig, loadOllamaHosts, targetHost,
  initDevModeToggle, isRouterMode, updateRoutingModeUi,
  loadHostPreferences, loadRoutingStatus, getHostChatState, describePendingRuntimeChange,
  routingMode, routingModeLabel, sessionTaskType
} from './chat-config.js';
import {
  renderMessage, appendMessage as _appendMessage,
  sendMessage as _sendMessage, sendMessageStreamFetch, fetchModels as _fetchModels,
  setStatus as _setStatus, setFeedback as _setFeedback, sanitizeHTML,
  cancelModelWarmup
} from './chat-messaging.js';
import {
  loadHistoryList as _loadHistoryList, loadConversation as _loadConversation
} from './chat-history.js';
import { initAgentSystem, reapplyAgentModel, updateHeaderBar } from './chat-agents.js';
import {
  loadProfile as _loadProfile, saveProfile as _saveProfile,
  loadPromptSelector, showPromptInfo
} from './chat-profile.js';

document.addEventListener('DOMContentLoaded', () => {
  const defaultMessagePlaceholder = 'Ask Agent X anything…';

  const elements = {
    chatWindow: document.getElementById('chatWindow'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    clearBtn: document.getElementById('clearBtn'),
    hostInput: document.getElementById('hostInput'),
    routingModeSelect: document.getElementById('routingModeSelect'),
    modelSelect: document.getElementById('modelSelect'),
    systemPrompt: document.getElementById('systemPrompt'),
    temperature: document.getElementById('temperature'),
    topP: document.getElementById('topP'),
    topK: document.getElementById('topK'),
    numCtx: document.getElementById('numCtx'),
    repeatPenalty: document.getElementById('repeatPenalty'),
    presencePenalty: document.getElementById('presencePenalty'),
    frequencyPenalty: document.getElementById('frequencyPenalty'),
    numPredict: document.getElementById('numPredict'),
    seed: document.getElementById('seed'),
    stopSequences: document.getElementById('stopSequences'),
    keepAlive: document.getElementById('keepAlive'),
    statusChip: document.getElementById('statusChip'),
    statMessages: document.getElementById('statMessages'),
    refreshModels: document.getElementById('refreshModels'),
    saveDefaults: document.getElementById('saveDefaults'),
    feedback: document.getElementById('feedback'),
    quickActionSelect: document.getElementById('quickActionSelect'),
    streamToggle: document.getElementById('streamToggle'),
    ragToggle: document.getElementById('ragToggle'),
    webSearchToggle: document.getElementById('webSearchToggle'),
    thinkingToggle: document.getElementById('thinkingToggle'),
    headerThinkingBtn: document.getElementById('headerThinkingBtn'),
    headerWebSearchBtn: document.getElementById('headerWebSearchBtn'),
    ragOptionsPanel: document.getElementById('ragOptionsPanel'),
    ragOptionsContent: document.getElementById('ragOptionsContent'),
    ragPanelHeader: document.getElementById('ragPanelHeader'),
    ragChevron: document.getElementById('ragChevron'),
    ragExpandQuery: document.getElementById('ragExpandQuery'),
    ragHybridSearch: document.getElementById('ragHybridSearch'),
    ragRerankResults: document.getElementById('ragRerankResults'),
    ragCompress: document.getElementById('ragCompress'),
    ragTopK: document.getElementById('ragTopK'),
    ragTopKValue: document.getElementById('ragTopKValue'),
    statsToggle: document.getElementById('statsToggle'),
    // logWindow removed — session log panel deleted
    threadId: document.getElementById('threadId'),
    memoryLanguage: document.getElementById('memoryLanguage'),
    memoryRole: document.getElementById('memoryRole'),
    memoryStyle: document.getElementById('memoryStyle'),
    toggleHistoryBtn: document.getElementById('toggleHistoryBtn'),
    closeHistoryBtn: document.getElementById('closeHistoryBtn'),
    page: document.querySelector('.page'),
    historyList: document.getElementById('historyList'),
    resetProfileBtn: document.getElementById('resetProfileBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    profileBtn: document.getElementById('profileBtn'),
    profileModal: document.getElementById('profileModal'),
    closeProfileBtn: document.getElementById('closeProfileBtn'),
    saveProfileBtn: document.getElementById('saveProfileBtn'),
    userAbout: document.getElementById('userAbout'),
    userInstructions: document.getElementById('userInstructions'),
    promptSelect: document.getElementById('promptSelect'),
    promptInfoBtn: document.getElementById('promptInfoBtn'),
    // Config drawer
    configDrawer: document.getElementById('configDrawer'),
    configDrawerBackdrop: document.getElementById('configDrawerBackdrop'),
    configDrawerClose: document.getElementById('configDrawerClose'),
    toggleConfigBtn: document.getElementById('toggleConfigBtn'),
  };
  const welcomeMarkup = elements.chatWindow?.innerHTML || '';
  let configDrawerOpener = null;

  // Copy defaults so server config can mutate them
  const defaults = { ...DEFAULTS, options: { ...DEFAULTS.options } };

  const state = {
    history: [],
    sending: false,
    stats: { messages: 0, replies: 0 },
    settings: { ...DEFAULTS, options: { ...DEFAULTS.options } },
    threadId: `t-${Date.now().toString(36)}`,
    profile: { language: '', role: '', style: '' },
    conversationId: null,
    showStats: true,
    eventSource: null,
    streamAbortController: null,
    config: null,
    ollamaHosts: [],
    ollamaHostsLoaded: false,
    routingStatus: null,
    routingStatusLoaded: false,
    sessionLoadedModel: null,
    hostPreferences: [],
    hostPreferencesByUrl: new Map(),
    pendingRuntimeNoticeKey: null,
    _helpers: null,
  };

  // Helper functions that close over elements/state for modules
  const helpers = {
    setStatus: (text, tone) => _setStatus(elements, text, tone),
    setFeedback: (text, tone) => _setFeedback(elements, text, tone),
    appendMessage: (msgOrRole, opts) => {
      _appendMessage(msgOrRole, opts, state, elements);
    },
    sendMessage: () => _sendMessage({ elements, state, defaults, helpers }),
    loadHistoryList: () => _loadHistoryList(elements, state),
    loadConversation: (id, preserve) => _loadConversation(id, state, elements, helpers, preserve),
    speakText: () => {},
    refreshStats: (id) => refreshStats(id),
    updateConversationStats: (conv) => updateConversationStats(conv),
    clearChat: (options) => clearChat(options),
    applyChatAvailability: (options) => applyChatAvailability(options),
    persistSettings: () => _persistSettings(elements, state, defaults, refreshMessages, (msg, tone) => _setFeedback(elements, msg, tone)),
  };

  // Store helpers reference so history module can call back
  state._helpers = helpers;

  function refreshMessages() {
    elements.chatWindow.innerHTML = state.history.length === 0 ? welcomeMarkup : '';
    state.stats = { messages: 0, replies: 0 };
    state.history.forEach((msg) => helpers.appendMessage(msg, { persist: false }));
  }

  function readOptionalContextOverride() {
    const raw = elements.numCtx?.value == null ? '' : String(elements.numCtx.value).trim();
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function clearChat({ showToast = true } = {}) {
    state.history = [];
    state.conversationId = null;
    state.stats = { messages: 0, replies: 0 };
    // New conversation → the previous reply's routed model no longer applies.
    state.lastRoutedModel = null;
    elements.chatWindow.innerHTML = welcomeMarkup;
    state.threadId = `t-${Date.now().toString(36)}`;
    elements.threadId.textContent = state.threadId;
    if (showToast && typeof Toast !== 'undefined') Toast.success('New conversation started');
  }

  // Stats
  function updateConversationStats(conversation) {
    if (conversation && conversation.usage) {
      const tokensEl = document.getElementById('conversationTokens');
      const costEl = document.getElementById('conversationCost');
      if (tokensEl) {
        tokensEl.style.display = 'inline-flex';
        const tokenCount = document.getElementById('tokenCount');
        const tokenLimit = document.getElementById('tokenLimit');
        const contextPercentage = document.getElementById('contextPercentage');
        const contextProgressFill = document.getElementById('contextProgressFill');
        const currentTokens = conversation.usage.totalTokens || 0;
        // Authoritative limit comes from the Modelfile (via chat-context-indicator).
        // Fall back to local config only if the indicator hasn't loaded yet.
        const maxTokens = window.__chatContextLimit
          || readOptionalContextOverride()
          || state.config?.options?.num_ctx
          || null;
        const percentage = maxTokens
          ? Math.min(100, Math.round((currentTokens / maxTokens) * 100))
          : null;
        if (tokenCount) tokenCount.textContent = currentTokens.toLocaleString();
        if (tokenLimit) tokenLimit.textContent = maxTokens ? maxTokens.toLocaleString() : '—';
        if (contextPercentage) contextPercentage.textContent = percentage == null ? 'unresolved' : `${percentage}%`;
        if (contextProgressFill) {
          contextProgressFill.style.width = percentage == null ? '0%' : `${percentage}%`;
          contextProgressFill.classList.remove('warning', 'danger');
          if (percentage != null && percentage >= 90) contextProgressFill.classList.add('danger');
          else if (percentage != null && percentage >= 70) contextProgressFill.classList.add('warning');
        }
      }
      if (costEl) {
        costEl.style.display = 'inline-flex';
        const costAmount = document.getElementById('costAmount');
        if (costAmount) costAmount.textContent = '$' + (conversation.usage.estimatedCost || 0).toFixed(4);
      }
    } else {
      const tokensEl = document.getElementById('conversationTokens');
      const costEl = document.getElementById('conversationCost');
      if (tokensEl) tokensEl.style.display = 'none';
      if (costEl) costEl.style.display = 'none';
    }
  }

  async function refreshStats(conversationId) {
    if (!conversationId) return;
    try {
      const res = await fetch(`/api/history/${conversationId}`);
      if (!res.ok) return;
      const responseData = await res.json();
      const data = responseData.data || responseData;
      if (data) updateConversationStats(data);
    } catch (e) {
      console.error('Failed to refresh stats', e);
    }
  }

  // Panel toggles
  function toggleHistoryPanel() {
    if (!elements.page) return;
    elements.page.classList.toggle('history-hidden');
    setHistoryToggleLabels();
  }

  function setHistoryToggleLabels() {
    if (!elements.page) return;
    const isHidden = elements.page.classList.contains('history-hidden');
    if (elements.toggleHistoryBtn) {
      elements.toggleHistoryBtn.title = isHidden ? 'Show history' : 'Hide history';
      elements.toggleHistoryBtn.setAttribute('aria-label', isHidden ? 'Show conversation history' : 'Hide conversation history');
      elements.toggleHistoryBtn.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
    }
  }

  function setConfigDrawerState(isOpen, { restoreFocus = false } = {}) {
    if (!elements.configDrawer) return;
    elements.configDrawer.classList.toggle('open', isOpen);
    elements.configDrawer.inert = !isOpen;
    elements.configDrawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    elements.toggleConfigBtn?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    elements.configDrawerBackdrop?.classList.toggle('visible', isOpen);
    elements.configDrawerBackdrop?.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    document.body.classList.toggle('chat-controls-open', isOpen);
    const expertStrip = document.getElementById('chatExpertStrip');
    expertStrip?.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (expertStrip) expertStrip.inert = !isOpen;

    if (isOpen) {
      configDrawerOpener = document.activeElement;
      elements.configDrawer.focus({ preventScroll: true });
    } else if (restoreFocus && configDrawerOpener instanceof HTMLElement) {
      configDrawerOpener.focus({ preventScroll: true });
    }
  }

  // Context-preserving expert controls
  function toggleConfigDrawer() {
    if (!elements.configDrawer) return;
    setConfigDrawerState(!elements.configDrawer.classList.contains('open'), { restoreFocus: true });
  }

  function closeConfigDrawer() {
    setConfigDrawerState(false, { restoreFocus: true });
  }

  // Auto-resize textarea
  function autoResizeTextarea() {
    const textarea = elements.messageInput;
    textarea.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(textarea).lineHeight) * 6 || 144;
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
  }

  function currentHostLabel() {
    const selected = elements.hostInput?.selectedOptions?.[0]?.textContent?.trim();
    return selected || targetHost(elements, defaults) || '---';
  }

  function updateExperienceSummary(hostState) {
    const mode = routingMode(elements, state);
    const labels = {
      quick: 'Fast',
      standard: 'Balanced',
      deep: 'Deep reasoning',
      manual: 'Manual control',
    };
    const modeLabel = labels[mode] || 'Balanced';
    const modeEl = document.getElementById('simpleModeLabel');
    const automationEl = document.getElementById('simpleModeAutomation');
    const helpEl = document.getElementById('chatStatusHelp');
    const modelBadge = document.getElementById('headerModelBadge');
    const healthDot = document.querySelector('.chat-expert-strip .ci-health-dot');
    const hostField = document.querySelector('.chat-expert-strip [data-ci-field="host"]');
    const routeField = document.querySelector('.chat-expert-strip [data-ci-field="route"]');

    if (modeEl) modeEl.textContent = modeLabel;
    if (automationEl) automationEl.textContent = hostState.mode === 'router' ? 'Automatic' : 'Pinned';
    const ready = hostState.available && !hostState.requiresModel;
    if (helpEl) {
      helpEl.textContent = ready
        ? hostState.mode === 'router'
          ? 'Agent X will handle the setup when you send.'
          : 'Your selected host and model will be used for this conversation.'
        : hostState.reason || 'This chat route needs attention.';
    }
    if (modelBadge) {
      modelBadge.textContent = hostState.mode === 'router'
        ? `${modeLabel} · automatic`
        : (elements.modelSelect?.value || hostState.primaryPin || 'Model not selected');
    }
    if (hostField) hostField.textContent = hostState.mode === 'router' ? 'Server-routed' : currentHostLabel();
    if (routeField) routeField.textContent = hostState.mode === 'router' ? modeLabel : 'Manual';
    if (healthDot) {
      healthDot.classList.toggle('healthy', ready);
      healthDot.classList.toggle('offline', !ready);
    }
  }

  function applyChatAvailability({ announce = false } = {}) {
    updateRoutingModeUi(elements, state, defaults);
    const hostState = getHostChatState(elements, state, defaults);
    const blocked = !hostState.available || hostState.requiresModel;
    if (blocked || hostState.mode === 'router') {
      cancelModelWarmup({ elements, state });
    }
    updateExperienceSummary(hostState);

    if (elements.messageInput && !state.warming) {
      elements.messageInput.disabled = blocked;
      elements.messageInput.placeholder = blocked
        ? (hostState.reason || 'Chat unavailable for the selected host/config.')
        : defaultMessagePlaceholder;
    }
    if (elements.sendBtn && !state.sending) {
      elements.sendBtn.disabled = blocked || Boolean(state.warming);
      elements.sendBtn.title = blocked
        ? (hostState.reason || 'Chat unavailable for the selected host/config.')
        : '';
    }
    document.querySelectorAll('[data-chat-starter]').forEach((button) => {
      button.disabled = blocked;
      button.title = blocked ? (hostState.reason || 'Chat setup is required first.') : '';
    });

    if (typeof ChatIntelligence !== 'undefined') {
      const routerActive = hostState.mode === 'router';
      const modeLabel = routingModeLabel(routingMode(elements, state));
      ChatIntelligence.updateStatusBar({
        model: routerActive ? (state.lastRoutedModel || `${modeLabel} mode`) : (elements.modelSelect.value || hostState.primaryPin || '---'),
        host: routerActive ? 'server-routed' : currentHostLabel(),
        hostHealth: blocked ? 'unavailable' : 'healthy',
        routeReason: routerActive ? (sessionTaskType(elements, state) || 'session') : (hostState.selectedBasis || 'direct'),
      });
    }

    if (blocked) {
      const recoverable = hostState.recoverable || hostState.requiresModel;
      const recoverableLabel = hostState.unavailableKind === 'route setup'
        ? 'Chat route needs attention'
        : 'Model setup needed';
      helpers.setStatus(
        recoverable ? recoverableLabel : `Unavailable: ${hostState.unavailableKind || hostState.status || 'host'}`,
        recoverable ? 'warning' : 'error'
      );
      helpers.setFeedback(
        hostState.reason || 'Selected chat route is unavailable.',
        recoverable ? 'warning' : 'error'
      );
    } else if (announce && !state.sending && !state.warming) {
      helpers.setStatus('Ready to chat', 'success');
      helpers.setFeedback(hostState.reason || 'Chat route ready.', 'success');
    }

    return hostState;
  }

  function announcePendingRuntimeChange() {
    const change = describePendingRuntimeChange(elements, state, defaults);
    if (change.pending) {
      state.pendingRuntimeNoticeKey = null;
      helpers.setStatus('Runtime change pending', 'muted');
      helpers.setFeedback(`${change.message} Click Send once to acknowledge, then Send again to run.`, 'warning');
      if (elements.sendBtn && !state.sending && !state.warming) elements.sendBtn.textContent = 'Review load';
    } else if (!state.sending && !state.warming && elements.sendBtn) {
      elements.sendBtn.textContent = 'Send';
    }
    return change;
  }

  // Character count
  function updateCharCount() {
    const countEl = document.getElementById('charCount');
    if (countEl) {
      const len = elements.messageInput.value.length;
      countEl.textContent = len > 0 ? len.toLocaleString() : '';
    }
  }

  // Sync header toggle button visual state
  function syncHeaderToggleBtn(btn, active) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('active', active);
  }

  // Event wiring
  function attachEvents() {
    const roundtableBtn = document.getElementById('roundtableBtn');
    if (roundtableBtn) {
      roundtableBtn.addEventListener('click', () => {
        const text = (elements.messageInput?.value || '').trim();
        if (!text) {
          elements.messageInput?.focus();
          elements.messageInput?.setAttribute('placeholder', 'Type a question first, then click Council...');
          setTimeout(() => elements.messageInput?.setAttribute('placeholder', defaultMessagePlaceholder), 2500);
          return;
        }
        window.open('/council?question=' + encodeURIComponent(text), '_blank');
      });
    }
    elements.sendBtn.addEventListener('click', () => helpers.sendMessage());
    elements.clearBtn.addEventListener('click', clearChat);
    elements.refreshModels.addEventListener('click', async () => {
      await loadHostPreferences(state);
      await _fetchModels({ elements, state, defaults, helpers }, true);
      applyChatAvailability({ announce: true });
    });
    elements.saveDefaults.addEventListener('click', () => helpers.persistSettings());

    if (elements.ragPanelHeader) elements.ragPanelHeader.addEventListener('click', () => toggleRagOptions(elements));
    if (elements.ragTopK) {
      elements.ragTopK.addEventListener('input', () => { if (elements.ragTopKValue) elements.ragTopKValue.textContent = elements.ragTopK.value; });
    }

    if (elements.promptInfoBtn) elements.promptInfoBtn.addEventListener('click', showPromptInfo);

    const tuningHeader = document.getElementById('tuningHeader');
    const tuningContent = document.getElementById('tuningContent');
    if (tuningHeader && tuningContent) {
      tuningHeader.addEventListener('click', () => { tuningContent.classList.toggle('hidden'); tuningHeader.classList.toggle('expanded'); });
    }

    // Config drawer
    if (elements.toggleConfigBtn) elements.toggleConfigBtn.addEventListener('click', toggleConfigDrawer);
    if (elements.configDrawerClose) elements.configDrawerClose.addEventListener('click', closeConfigDrawer);
    if (elements.configDrawerBackdrop) elements.configDrawerBackdrop.addEventListener('click', closeConfigDrawer);

    elements.chatWindow?.addEventListener('click', (event) => {
      const starter = event.target.closest('[data-chat-starter]');
      if (!starter) return;
      elements.messageInput.value = starter.dataset.chatStarter || '';
      autoResizeTextarea();
      updateCharCount();
      elements.messageInput.focus();
    });

    // Info bar quick toggles
    if (elements.headerThinkingBtn) {
      elements.headerThinkingBtn.addEventListener('click', () => {
        if (elements.thinkingToggle) {
          elements.thinkingToggle.checked = !elements.thinkingToggle.checked;
          elements.thinkingToggle.dispatchEvent(new Event('change'));
        }
      });
    }
    if (elements.headerWebSearchBtn) {
      elements.headerWebSearchBtn.addEventListener('click', () => {
        if (elements.webSearchToggle) {
          elements.webSearchToggle.checked = !elements.webSearchToggle.checked;
          elements.webSearchToggle.dispatchEvent(new Event('change'));
        }
      });
    }

    // Keyboard: Enter to send, Shift+Enter for newline
    elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        helpers.sendMessage();
      }
    });

    // Global keyboard shortcuts (chat page)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && elements.configDrawer?.classList.contains('open')) {
        e.preventDefault();
        closeConfigDrawer();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (e.key === 'n' && !isInput) {
        e.preventDefault();
        clearChat();
      }
      if (e.key === 'h' && !isInput) {
        e.preventDefault();
        toggleHistoryPanel();
      }
    });

    // Auto-resize textarea
    elements.messageInput.addEventListener('input', () => {
      autoResizeTextarea();
      updateCharCount();
    });

    ['temperature', 'topP'].forEach((key) => {
      elements[key].addEventListener('input', updateRangeDisplays.bind(null, elements));
    });

    elements.modelSelect.addEventListener('change', () => {
      state.settings.model = elements.modelSelect.value;
      helpers.persistSettings();
      updateConfigSummary(elements);
      if (typeof ChatIntelligence !== 'undefined') {
        ChatIntelligence.updateStatusBar({ model: elements.modelSelect.value || '---' });
      }
      // Refresh the Modelfile-derived context indicator (badge + limit pill)
      if (typeof ChatContextIndicator !== 'undefined') {
        if (!isRouterMode(elements, state) && elements.modelSelect.value) {
          ChatContextIndicator.refresh({
            model: elements.modelSelect.value,
            host: targetHost(elements, defaults, { includeRouter: true }) || state.settings?.host
          });
        } else {
          ChatContextIndicator.reset();
        }
      }
      announcePendingRuntimeChange();
    });

    if (elements.routingModeSelect) {
      elements.routingModeSelect.addEventListener('change', async () => {
        helpers.persistSettings();
        // Switching modes invalidates the previously-routed model — clear it so
        // the header reflects the new mode until the next reply lands.
        state.lastRoutedModel = null;
        await loadHostPreferences(state);
        let hostState = applyChatAvailability({ announce: true });
        if (hostState.mode !== 'router') {
          await _fetchModels({ elements, state, defaults, helpers }, false);
          hostState = applyChatAvailability({ announce: true });
        }
        updateConfigSummary(elements);
        updateHeaderBar(null, state);
        if (typeof ChatContextIndicator !== 'undefined') {
          if (hostState.mode === 'router') {
            ChatContextIndicator.reset();
          } else if (elements.modelSelect.value) {
            ChatContextIndicator.refresh({
              model: elements.modelSelect.value,
              host: targetHost(elements, defaults, { includeRouter: true }) || state.settings?.host
            });
          }
        }
        if (typeof ChatIntelligence !== 'undefined') {
          const modeLabel = routingModeLabel(routingMode(elements, state));
          ChatIntelligence.updateStatusBar({
            model: hostState.mode === 'router' ? `${modeLabel} mode` : (elements.modelSelect.value || hostState.primaryPin || '---'),
            host: hostState.mode === 'router' ? 'server-routed' : currentHostLabel(),
            routeReason: hostState.mode === 'router' ? (sessionTaskType(elements, state) || 'session') : (hostState.selectedBasis || 'direct'),
          });
        }
        announcePendingRuntimeChange();
      });
    }

    elements.streamToggle.addEventListener('change', () => { helpers.persistSettings(); updateConfigSummary(elements); });
    elements.ragToggle.addEventListener('change', () => {
      helpers.persistSettings();
      updateConfigSummary(elements);
      if (window.checkSetupProgress && elements.ragToggle.checked) setTimeout(() => window.checkSetupProgress(), 500);
    });
    if (elements.webSearchToggle) elements.webSearchToggle.addEventListener('change', () => { helpers.persistSettings(); updateConfigSummary(elements); syncHeaderToggleBtn(elements.headerWebSearchBtn, elements.webSearchToggle.checked); });
    if (elements.thinkingToggle) elements.thinkingToggle.addEventListener('change', () => { helpers.persistSettings(); updateConfigSummary(elements); syncHeaderToggleBtn(elements.headerThinkingBtn, elements.thinkingToggle.checked); });
    if (elements.statsToggle) elements.statsToggle.addEventListener('change', () => helpers.persistSettings());

    if (elements.ragExpandQuery) elements.ragExpandQuery.addEventListener('change', () => helpers.persistSettings());
    if (elements.ragHybridSearch) elements.ragHybridSearch.addEventListener('change', () => helpers.persistSettings());
    if (elements.ragRerankResults) elements.ragRerankResults.addEventListener('change', () => helpers.persistSettings());
    if (elements.ragCompress) elements.ragCompress.addEventListener('change', () => helpers.persistSettings());

    elements.hostInput.addEventListener('change', async () => {
      helpers.persistSettings();
      await loadHostPreferences(state);
      applyChatAvailability();
      await _fetchModels({ elements, state, defaults, helpers }, false);
      applyChatAvailability({ announce: true });
      announcePendingRuntimeChange();
    });

    if (elements.quickActionSelect) {
      elements.quickActionSelect.addEventListener('change', () => {
        const val = elements.quickActionSelect.value;
        if (val) {
          elements.messageInput.value = val;
          elements.messageInput.focus();
          autoResizeTextarea();
          updateCharCount();
          elements.quickActionSelect.selectedIndex = 0; // reset to "Quick..."
        }
      });
    }

    elements.newChatBtn.addEventListener('click', clearChat);
    elements.profileBtn.addEventListener('click', () => { _loadProfile(elements); elements.profileModal.classList.remove('hidden'); });
    elements.closeProfileBtn.addEventListener('click', () => elements.profileModal.classList.add('hidden'));
    elements.saveProfileBtn.addEventListener('click', () => _saveProfile(elements, (msg, tone) => _setFeedback(elements, msg, tone)));
    elements.resetProfileBtn.addEventListener('click', () => _loadProfile(elements));

    if (elements.toggleHistoryBtn) elements.toggleHistoryBtn.addEventListener('click', toggleHistoryPanel);
    if (elements.closeHistoryBtn) elements.closeHistoryBtn.addEventListener('click', toggleHistoryPanel);
  }

  // Init
  async function init() {
    state.settings = loadSettings(defaults);

    const urlParams = new URLSearchParams(window.location.search);
    const modelParam = urlParams.get('model');
    const hostParam = urlParams.get('host');
    if (modelParam) {
      state.settings.model = decodeURIComponent(modelParam);
      state.settings.routingMode = 'manual';
    }
    if (hostParam) {
      state.settings.hostUrl = decodeURIComponent(hostParam);
      state.settings.routingMode = 'manual';
    }

    elements.threadId.textContent = state.threadId;
    hydrateForm(elements, state, defaults);
    updateRoutingModeUi(elements, state, defaults);
    syncHeaderToggleBtn(elements.headerThinkingBtn, state.settings.think || false);
    syncHeaderToggleBtn(elements.headerWebSearchBtn, state.settings.webSearch || false);
    initDevModeToggle();
    attachEvents();

    // Configure shortcuts modal with chat-specific shortcuts
    if (typeof ShortcutsHelpModal !== 'undefined') {
      ShortcutsHelpModal.setShortcuts([
        { category: 'Chat', items: [
          { keys: 'Enter', description: 'Send message' },
          { keys: 'Shift+Enter', description: 'New line' },
          { keys: 'Ctrl+N', description: 'New conversation' },
          { keys: 'Ctrl+H', description: 'Toggle history sidebar' }
        ]},
        { category: 'General', items: [
          { keys: 'Ctrl+/', description: 'Show keyboard shortcuts' },
          { keys: 'Escape', description: 'Close dialogs and modals' },
          { keys: 'Ctrl+Shift+B', description: 'Toggle Buddy panel' }
        ]}
      ]);
    }

    clearChat({ showToast: false });
    _loadProfile(elements);
    await loadPromptSelector();
    await loadOllamaHosts(elements, state);
    await loadRoutingStatus(state);
    await loadHostPreferences(state);
    applyChatAvailability();
    await _fetchModels({ elements, state, defaults, helpers });
    applyChatAvailability({ announce: true });
    announcePendingRuntimeChange();

    // Populate info bar with initial model/host
    if (typeof ChatIntelligence !== 'undefined') {
      const hostState = getHostChatState(elements, state, defaults);
      const routerActive = hostState.mode === 'router';
      const modeLabel = routingModeLabel(routingMode(elements, state));
      ChatIntelligence.updateStatusBar({
        model: routerActive ? (state.lastRoutedModel || `${modeLabel} mode`) : (elements.modelSelect.value || hostState.primaryPin || '---'),
        host: routerActive ? 'server-routed' : currentHostLabel(),
        hostHealth: hostState.available && !hostState.requiresModel ? 'healthy' : 'unavailable',
        routeReason: routerActive ? (sessionTaskType(elements, state) || 'session') : (hostState.selectedBasis || 'direct'),
      });
    }

    checkRagAvailability(elements);

    reapplyAgentModel(elements, state);

    setHistoryToggleLabels();

    document.addEventListener('input', (e) => {
      if (e.target.type === 'range' || e.target.id === 'temperature') updateConfigSummary(elements);
      if (e.target.id === 'numCtx') {
        const tokenLimit = document.getElementById('tokenLimit');
        if (tokenLimit) {
          const override = readOptionalContextOverride();
          tokenLimit.textContent = override
            ? override.toLocaleString()
            : (window.__chatContextLimit ? window.__chatContextLimit.toLocaleString() : 'Auto');
        }
        if (state.conversationId) refreshStats(state.conversationId);
      }
      if (['numCtx', 'keepAlive'].includes(e.target.id)) announcePendingRuntimeChange();
    });

    updateConfigSummary(elements);

    const tokenLimit = document.getElementById('tokenLimit');
    if (tokenLimit) tokenLimit.textContent = readOptionalContextOverride()
      ? readOptionalContextOverride().toLocaleString()
      : 'Auto';

    // Kick off the Modelfile-derived context indicator on load — it may
    // override the hardcoded limit above with the real ctx for the selected
    // model/host combo (silent on failure; pill falls back to config value).
    // Only meaningful in manual mode: in server-routed session modes the
    // selected-model dropdown is not what answers, so resolving its context
    // would show a misleading badge — clear it instead.
    if (typeof ChatContextIndicator !== 'undefined') {
      if (!isRouterMode(elements, state) && elements.modelSelect?.value) {
        ChatContextIndicator.refresh({
          model: elements.modelSelect.value,
          host: targetHost(elements, defaults, { includeRouter: true }) || state.settings?.host
        });
      } else {
        ChatContextIndicator.reset();
      }
    }

    const history = await _loadHistoryList(elements, state);
    if (history && history.length > 0) {
      let loaded = false;
      const candidates = history.slice(0, 5);
      for (const item of candidates) {
        loaded = await _loadConversation(item.id, state, elements, helpers);
        if (loaded) break;
      }
      if (!loaded) {
        applyChatAvailability({ announce: true });
      }
    } else {
      applyChatAvailability({ announce: true });
    }
  }

  loadServerConfig(defaults).then((config) => {
    state.config = config;
    init();
  }).catch(err => {
    console.warn('Server config load failed, using defaults:', err);
    init();
  });

  // Chat Intelligence layers (status bar + side panel)
  if (typeof ChatIntelligence !== 'undefined') {
    const composerEl = document.querySelector('.composer');
    if (composerEl) ChatIntelligence.init(composerEl);
  }

  // Agent system init (parallel, non-blocking)
  initAgentSystem(elements, state, helpers);
});

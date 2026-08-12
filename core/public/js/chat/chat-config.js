/**
 * Chat config — Settings persistence, form hydration, config summary, RAG options
 */
import { STORAGE_KEYS, DEFAULTS } from './chat-constants.js';

function readOptionalNumberInput(value) {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? '' : parsed;
}

function normalizeNumPredictForInput(value) {
  if (value == null) return '';
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return '';
  return parsed;
}

// Session chat modes. The first three are server-routed by a FIXED task type
// (one model for the whole conversation — no per-message classification);
// 'manual' uses the explicitly selected host + model. The legacy per-message
// 'router' (auto-classify) mode was retired in settings v8 and migrates to
// 'standard'.
export const ROUTING_MODES = ['quick', 'standard', 'deep', 'manual'];

// Mode → router task type. 'manual' has no task type (explicit model+host).
export const SESSION_MODE_TASK = {
  quick: 'quick_chat',
  standard: 'general_chat',
  deep: 'deep_reasoning',
};

const ROUTING_MODE_LABELS = { quick: 'Quick', standard: 'Standard', deep: 'Deep', manual: 'Manual' };

export function routingModeLabel(mode) {
  return ROUTING_MODE_LABELS[mode] || 'Standard';
}

export function routingMode(elements, state) {
  const raw = elements?.routingModeSelect?.value || state?.settings?.routingMode || DEFAULTS.routingMode || 'standard';
  return ROUTING_MODES.includes(raw) ? raw : 'standard';
}

// "Router mode" now means any server-routed session mode (i.e. not manual).
// The host/model inputs are disabled and the server picks the model from the
// mode's fixed task type. Kept under the historical name so existing callers
// (input disabling, availability, payload shape) keep working unchanged.
export function isRouterMode(elements, state) {
  return routingMode(elements, state) !== 'manual';
}

// The fixed task type sent for the whole session in server-routed modes;
// null in manual mode. Drives deterministic routing (autoRouted: false).
export function sessionTaskType(elements, state) {
  return SESSION_MODE_TASK[routingMode(elements, state)] || null;
}

function normalizeModelName(name) {
  return String(name || '')
    .trim()
    .replace(/^ax\//, '')
    .replace(/:latest$/, '');
}

export function modelsEquivalent(left, right) {
  const a = normalizeModelName(left);
  const b = normalizeModelName(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

function normalizeHostUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

export function selectedHostPreference(elements, state, defaults) {
  const host = targetHost(elements, defaults, { includeRouter: true });
  if (!host) return null;
  return state.hostPreferencesByUrl?.get(normalizeHostUrl(host)) || null;
}

export function getHostRunningModels(pref) {
  const liveModels = Array.isArray(pref?.live?.runningModels)
    ? pref.live.runningModels.map((model) => model.name || model.model).filter(Boolean)
    : [];
  if (liveModels.length) return liveModels;
  if (Array.isArray(pref?.loadedModels) && pref.loadedModels.length) return pref.loadedModels.filter(Boolean);
  return pref?.loadedModel ? [pref.loadedModel] : [];
}

export function getHostPinnedModels(pref) {
  return Array.isArray(pref?.pinnedModels)
    ? pref.pinnedModels.map((entry) => entry.model || entry).filter(Boolean)
    : [];
}

export function getHostChatState(elements, state, defaults) {
  if (isRouterMode(elements, state)) {
    return {
      available: true,
      mode: 'router',
      reason: `${routingModeLabel(routingMode(elements, state))} mode uses one server-selected model for the whole session.`
    };
  }

  const host = targetHost(elements, defaults, { includeRouter: true });
  if (!host) {
    return { available: false, mode: 'manual', reason: 'No Ollama host selected.' };
  }

  const pref = selectedHostPreference(elements, state, defaults);
  const status = pref?.status || 'unknown';
  const batchId = pref?.benchmarkClaim?.batchId || null;
  const liveOnline = pref?.live?.online;

  if (batchId || status === 'benchmarking') {
    return {
      available: false,
      mode: 'manual',
      status,
      unavailableKind: 'benchmark/judge',
      reason: `Chat unavailable: ${pref?.displayName || host} is reserved for benchmark/judge work${batchId ? ` (${batchId})` : ''}.`
    };
  }

  if (status === 'restoring' || status === 'swapping') {
    return {
      available: false,
      mode: 'manual',
      status,
      unavailableKind: status,
      reason: `Chat unavailable: ${pref?.displayName || host} is ${status} a model.`
    };
  }

  if (status === 'offline' || liveOnline === false) {
    return {
      available: false,
      mode: 'manual',
      status,
      unavailableKind: 'offline',
      reason: `Chat unavailable: ${pref?.displayName || host} is offline.`
    };
  }

  const runningModels = getHostRunningModels(pref);
  const pinnedModels = getHostPinnedModels(pref);
  const primaryPin = pinnedModels[0] || null;
  const runningLabel = runningModels[0] || null;
  const pinLoaded = primaryPin && runningModels.some((model) => modelsEquivalent(model, primaryPin));

  return {
    available: true,
    mode: 'manual',
    status,
    host,
    pref,
    runningModels,
    pinnedModels,
    primaryPin,
    selectedBasis: runningLabel ? 'loaded' : primaryPin ? 'pinned' : 'manual',
    reason: runningLabel
      ? `${pref?.displayName || host} is using loaded model ${runningLabel}${primaryPin && !pinLoaded ? `; pinned model ${primaryPin} is displaced.` : ''}`
      : primaryPin
        ? `${pref?.displayName || host} will use pinned model ${primaryPin}.`
        : `${pref?.displayName || host} has no pinned or loaded model; choose one manually.`
  };
}

export function describePendingRuntimeChange(elements, state, defaults) {
  if (isRouterMode(elements, state)) {
    return {
      pending: false,
      key: `router:${routingMode(elements, state)}`,
      message: `${routingModeLabel(routingMode(elements, state))} mode uses a fixed model for the whole session.`
    };
  }

  const hostState = getHostChatState(elements, state, defaults);
  if (!hostState.available) {
    return { pending: false, key: 'unavailable', message: hostState.reason || '' };
  }

  const selectedModel = elements?.modelSelect?.value || '';
  const runningModel = hostState.runningModels?.[0] || '';
  const willLoadModel = selectedModel && !hostState.runningModels?.some((model) => modelsEquivalent(model, selectedModel));
  const runtimeOverrides = [];
  const numCtx = String(elements?.numCtx?.value || '').trim();
  const keepAlive = String(elements?.keepAlive?.value || '').trim();

  if (numCtx) runtimeOverrides.push(`context ${numCtx}`);
  if (keepAlive) runtimeOverrides.push(`keep_alive ${keepAlive}`);

  const parts = [];
  if (willLoadModel) {
    parts.push(runningModel
      ? `will load ${selectedModel} on ${hostState.pref?.displayName || hostState.host}, replacing loaded ${runningModel}`
      : `will load ${selectedModel} on ${hostState.pref?.displayName || hostState.host}`);
  }
  if (runtimeOverrides.length) {
    parts.push(`will apply runtime override${runtimeOverrides.length > 1 ? 's' : ''}: ${runtimeOverrides.join(', ')}`);
  }

  return {
    pending: parts.length > 0,
    key: [
      targetHost(elements, defaults, { includeRouter: true }),
      selectedModel,
      numCtx,
      keepAlive
    ].join('|'),
    message: parts.length ? `Next send ${parts.join(' and ')}.` : hostState.reason
  };
}

function migrateLegacySettings(parsed, defaults) {
  const migrated = { ...parsed };
  migrated.options = { ...(parsed.options || {}) };

  const savedVersion = Number.isFinite(Number(migrated.settingsVersion))
    ? Number(migrated.settingsVersion)
    : 0;

  if (savedVersion < 2) {
    const savedNumPredict = migrated.options.num_predict;
    if (savedNumPredict == null || Number(savedNumPredict) === 256) {
      migrated.options.num_predict = defaults.options.num_predict;
    }
  }

  if (savedVersion < 3) {
    const savedNumPredict = migrated.options.num_predict;
    if (
      savedNumPredict == null ||
      String(savedNumPredict).trim() === '' ||
      Number(savedNumPredict) === 256 ||
      Number(savedNumPredict) === 1024
    ) {
      migrated.options.num_predict = '';
    }
  }

  if (savedVersion < 4) {
    if (!migrated.sttProvider) {
      migrated.sttProvider = defaults.sttProvider || DEFAULTS.sttProvider || 'browser';
    }
  }

  if (savedVersion < 5) {
    migrated.tts = Boolean(defaults.tts);
    if (!['browser', 'voix'].includes(migrated.sttProvider)) {
      migrated.sttProvider = defaults.sttProvider || DEFAULTS.sttProvider || 'browser';
    }
    migrated.ttsProvider = defaults.ttsProvider || DEFAULTS.ttsProvider || 'browser';
    migrated.ttsVoice = defaults.ttsVoice || DEFAULTS.ttsVoice || '';
  }

  if (savedVersion < 6) {
    migrated.routingMode = defaults.routingMode || DEFAULTS.routingMode || 'standard';
    if (migrated.options.num_ctx == null || Number(migrated.options.num_ctx) === 4096) {
      migrated.options.num_ctx = '';
    }
  }

  if (savedVersion < 7) {
    migrated.routingMode = defaults.routingMode || DEFAULTS.routingMode || 'standard';
  }

  if (savedVersion < 8) {
    // Per-message Core Router (auto-classify per turn) retired in favor of
    // session-fixed modes. Map the old 'router' choice to the closest stable
    // lane (Standard → general_chat → default chat model). 'manual' is kept.
    if (migrated.routingMode === 'router') migrated.routingMode = 'standard';
  }

  if (!['quick', 'standard', 'deep', 'manual'].includes(migrated.routingMode)) {
    migrated.routingMode = defaults.routingMode || DEFAULTS.routingMode || 'standard';
  }

  migrated.settingsVersion = defaults.settingsVersion || DEFAULTS.settingsVersion;
  return migrated;
}

export function applyVoiceDefaults(defaults, voiceConfig) {
  const features = voiceConfig?.features || {};
  const stt = features.stt || {};
  const tts = features.tts || {};
  const convoMode = features.convoMode || {};

  defaults.sttProvider = stt.provider || defaults.sttProvider || DEFAULTS.sttProvider;
  defaults.sttLanguage = stt.language || defaults.sttLanguage || DEFAULTS.sttLanguage;
  defaults.whisperModel = stt.model || defaults.whisperModel || DEFAULTS.whisperModel;
  defaults.tts = Boolean(tts.enabled);
  defaults.ttsProvider = tts.provider || defaults.ttsProvider || DEFAULTS.ttsProvider;
  defaults.ttsVoice = tts.voice || defaults.ttsVoice || DEFAULTS.ttsVoice;
  defaults.voiceAutoSend = Boolean(convoMode.enabled);
  defaults.convoModeEnabled = Boolean(convoMode.enabled);
  defaults.convoModeAutoSpeak = convoMode.autoSpeak !== false;
  defaults.convoModeKeepSession = convoMode.keepSession !== false;
}

export function loadSettings(defaults) {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return { ...defaults };
    const parsed = migrateLegacySettings(JSON.parse(raw), defaults);
    // Migrate legacy host+port settings to hostUrl
    if (parsed.host && !parsed.hostUrl) {
      const port = parsed.port || defaults.port || '11434';
      const h = parsed.host;
      if (/^https?:\/\//i.test(h)) {
        parsed.hostUrl = h;
      } else {
        parsed.hostUrl = `http://${h}:${port}`;
      }
    }
    return {
      ...defaults,
      ...parsed,
      options: { ...defaults.options, ...(parsed.options || {}) },
    };
  } catch (e) {
    console.warn('Failed to read saved settings', e);
    return { ...defaults };
  }
}

export function readOptions(elements) {
  return {
    temperature: Number(elements.temperature.value),
    top_p: Number(elements.topP.value),
    top_k: Number(elements.topK.value),
    num_ctx: readOptionalNumberInput(elements.numCtx.value),
    repeat_penalty: Number(elements.repeatPenalty.value),
    presence_penalty: Number(elements.presencePenalty.value),
    frequency_penalty: Number(elements.frequencyPenalty.value),
    num_predict: readOptionalNumberInput(elements.numPredict.value),
    seed: elements.seed.value || '',
    stop: elements.stopSequences.value,
    keep_alive: elements.keepAlive.value,
  };
}

export function persistSettings(elements, state, defaults, refreshMessages, setFeedback) {
  const payload = {
    settingsVersion: defaults.settingsVersion || DEFAULTS.settingsVersion,
    routingMode: routingMode(elements, state),
    hostUrl: elements.hostInput.value || '',
    model: elements.modelSelect.value,
    stream: elements.streamToggle.checked,
    tts: elements.ttsToggle?.checked || false,
    ttsProvider: document.getElementById('ttsProviderSelect')?.value || defaults.ttsProvider || DEFAULTS.ttsProvider || 'browser',
    ttsVoice: elements.ttsVoiceSelect?.value || 'alloy',
    sttProvider: elements.sttProviderSelect?.value || defaults.sttProvider || DEFAULTS.sttProvider || 'browser',
    sttLanguage: elements.sttLanguageSelect?.value || defaults.sttLanguage || 'en',
    whisperModel: elements.whisperModelSelect?.value || '',
    voiceAutoSend: elements.voiceAutoSend?.checked || false,
    useRag: elements.ragToggle.checked,
    webSearch: elements.webSearchToggle?.checked || false,
    think: elements.thinkingToggle?.checked || false,
    showStats: elements.statsToggle.checked,
    ragExpand: elements.ragExpandQuery?.checked || false,
    ragHybrid: elements.ragHybridSearch?.checked || false,
    ragRerank: elements.ragRerankResults?.checked || false,
    ragCompress: elements.ragCompress?.checked || false,
    ragTopK: parseInt(elements.ragTopK?.value || '5', 10),
    system: elements.systemPrompt.value.trim() || defaults.system,
    options: readOptions(elements),
  };
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(payload));
  state.settings = payload;
  state.showStats = payload.showStats;
  refreshMessages();
  setFeedback('Defaults saved locally.', 'success');
}

export function hydrateForm(elements, state, defaults) {
  const cfg = state.settings;
  state.showStats = cfg.showStats !== undefined ? cfg.showStats : true;

  // Host URL is restored after loadOllamaHosts populates the dropdown
  // (see loadOllamaHosts which reads state.settings.hostUrl)
  if (elements.routingModeSelect) elements.routingModeSelect.value = cfg.routingMode || defaults.routingMode || DEFAULTS.routingMode || 'standard';
  elements.modelSelect.value = cfg.model;
  elements.systemPrompt.value = cfg.system;
  elements.streamToggle.checked = cfg.stream;
  elements.ttsToggle.checked = cfg.tts !== undefined ? cfg.tts : Boolean(defaults.tts);
  elements.ttsToggle.disabled = false;

  const ttsProviderSelect = document.getElementById('ttsProviderSelect');
  const ttsProviderField = document.getElementById('ttsProviderField');
  if (ttsProviderSelect) {
    ttsProviderSelect.value = cfg.ttsProvider || defaults.ttsProvider || DEFAULTS.ttsProvider || 'browser';
    ttsProviderSelect.disabled = false;
  }
  if (ttsProviderField) ttsProviderField.style.display = 'none';

  if (elements.sttProviderSelect) {
    elements.sttProviderSelect.value = cfg.sttProvider || defaults.sttProvider || DEFAULTS.sttProvider || 'browser';
  }
  if (elements.sttLanguageSelect) elements.sttLanguageSelect.value = cfg.sttLanguage || defaults.sttLanguage || 'en';
  if (elements.whisperModelSelect) elements.whisperModelSelect.value = cfg.whisperModel || '';
  if (elements.voiceAutoSend) elements.voiceAutoSend.checked = cfg.voiceAutoSend || false;
  if (elements.ttsVoiceSelect) elements.ttsVoiceSelect.value = cfg.ttsVoice || 'alloy';

  elements.ragToggle.checked = cfg.useRag !== undefined ? cfg.useRag : true;
  if (elements.webSearchToggle) elements.webSearchToggle.checked = cfg.webSearch || false;
  if (elements.thinkingToggle) elements.thinkingToggle.checked = cfg.think || false;
  elements.statsToggle.checked = state.showStats;

  if (elements.ragExpandQuery) elements.ragExpandQuery.checked = cfg.ragExpand || false;
  if (elements.ragHybridSearch) elements.ragHybridSearch.checked = cfg.ragHybrid || false;
  if (elements.ragRerankResults) elements.ragRerankResults.checked = cfg.ragRerank || false;
  if (elements.ragCompress) elements.ragCompress.checked = cfg.ragCompress || false;
  if (elements.ragTopK) elements.ragTopK.value = cfg.ragTopK || 5;
  if (elements.ragTopKValue) elements.ragTopKValue.textContent = cfg.ragTopK || 5;

  elements.temperature.value = cfg.options.temperature;
  elements.topP.value = cfg.options.top_p;
  elements.topK.value = cfg.options.top_k;
  elements.numCtx.value = cfg.options.num_ctx ?? '';
  elements.repeatPenalty.value = cfg.options.repeat_penalty;
  elements.presencePenalty.value = cfg.options.presence_penalty;
  elements.frequencyPenalty.value = cfg.options.frequency_penalty;
  elements.numPredict.value = normalizeNumPredictForInput(cfg.options.num_predict);
  elements.seed.value = cfg.options.seed || '';
  elements.stopSequences.value = cfg.options.stop || '';
  elements.keepAlive.value = cfg.options.keep_alive || '';

  updateRangeDisplays(elements);
}

export function updateRangeDisplays(elements) {
  document.querySelectorAll('.value[data-for="temperature"]').forEach((el) => {
    el.textContent = elements.temperature.value;
  });
  document.querySelectorAll('.value[data-for="topP"]').forEach((el) => {
    el.textContent = elements.topP.value;
  });
}

export function getRagOptions(elements) {
  const useRag = elements.ragToggle?.checked;
  if (!useRag) return { useRag: false };
  return {
    useRag: true,
    ragExpand: elements.ragExpandQuery?.checked || false,
    ragHybrid: elements.ragHybridSearch?.checked || false,
    ragRerank: elements.ragRerankResults?.checked || false,
    ragCompress: elements.ragCompress?.checked || false,
    ragTopK: parseInt(elements.ragTopK?.value || '5', 10)
  };
}

export function toggleRagOptions(elements) {
  const content = elements.ragOptionsContent;
  const chevron = elements.ragChevron;
  if (!content || !chevron) return;
  const isOpen = content.style.display === 'block';
  content.style.display = isOpen ? 'none' : 'block';
  chevron.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
}

export async function checkRagAvailability(elements) {
  try {
    const response = await fetch('/api/rag/status', { credentials: 'include' });
    if (response.status === 404) {
      if (elements.ragToggle) {
        elements.ragToggle.checked = false;
        elements.ragToggle.disabled = true;
      }
      if (elements.ragOptionsPanel) elements.ragOptionsPanel.style.display = 'none';
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload?.data || payload;
    const storeHealthy = data?.vectorStore?.healthy === true;
    const available = payload?.status === 'success' && storeHealthy;

    if (elements.ragToggle) {
      elements.ragToggle.disabled = !available;
      if (!available) elements.ragToggle.checked = false;
    }
    if (elements.ragOptionsPanel) elements.ragOptionsPanel.style.display = available ? 'block' : 'none';

    const hint = elements.ragToggle?.closest('.field')?.querySelector('.hint');
    if (hint) {
      if (available) {
        hint.textContent = `${data.documentCount ?? 0} docs / ${data.chunkCount ?? 0} chunks in vector store.`;
        hint.style.color = '';
      } else {
        hint.textContent = `RAG unavailable — vector store ${data?.vectorStore?.type || 'unknown'} is not healthy.`;
        hint.style.color = 'var(--warning, #f0ad4e)';
      }
    }
  } catch (error) {
    console.warn('RAG availability check failed:', error);
    if (elements.ragToggle) {
      elements.ragToggle.checked = false;
      elements.ragToggle.disabled = true;
    }
    if (elements.ragOptionsPanel) elements.ragOptionsPanel.style.display = 'none';

    const hint = elements.ragToggle?.closest('.field')?.querySelector('.hint');
    if (hint) {
      hint.textContent = 'RAG service unreachable — is agentx-rag running on port 3082?';
      hint.style.color = 'var(--warning, #f0ad4e)';
    }
  }
}

export function updateConfigSummary(elements) {
  const routerMode = isRouterMode(elements);
  const modeLabel = `${routingModeLabel(routingMode(elements))} mode`;
  const modelName = routerMode ? modeLabel : (elements.modelSelect.value || 'Manual');
  const shortModel = modelName.length > 15 ? modelName.substring(0, 12) + '...' : modelName;

  const summaryModelEl = document.getElementById('summaryModel');
  if (summaryModelEl) summaryModelEl.textContent = shortModel;

  const summaryRagEl = document.getElementById('summaryRag');
  if (summaryRagEl) summaryRagEl.textContent = elements.ragToggle.checked ? 'On' : 'Off';

  const summaryStreamEl = document.getElementById('summaryStream');
  if (summaryStreamEl) summaryStreamEl.textContent = elements.streamToggle.checked ? 'On' : 'Off';

  const summaryWebEl = document.getElementById('summaryWeb');
  if (summaryWebEl) summaryWebEl.textContent = elements.webSearchToggle?.checked ? 'On' : 'Off';

  const summaryThinkEl = document.getElementById('summaryThink');
  if (summaryThinkEl) summaryThinkEl.textContent = elements.thinkingToggle?.checked ? 'Forced' : 'Auto';

  const summaryTempEl = document.getElementById('summaryTemp');
  if (summaryTempEl) summaryTempEl.textContent = elements.temperature.value;

  const chatConfigEl = document.getElementById('chatConfigSummary');
  if (chatConfigEl) {
    const ragStatus = elements.ragToggle.checked ? '+RAG' : '';
    const webStatus = elements.webSearchToggle?.checked ? '+Web' : '';
    const thinkStatus = elements.thinkingToggle?.checked ? '+Think forced' : '';
    const streamStatus = elements.streamToggle.checked ? '' : 'No-Stream';
    const extras = [ragStatus, webStatus, thinkStatus, streamStatus].filter(s => s).join(', ');
    const routeLabel = routerMode ? modeLabel : shortModel;
    const summary = extras ? `${routeLabel} (${extras})` : routeLabel;
    chatConfigEl.textContent = summary;
  }
}

export async function loadServerConfig(defaults) {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const config = await res.json();
      return config;
    }
  } catch (err) {
    console.warn('Could not load server config:', err);
  }
  return null;
}

/**
 * Load Ollama hosts from /api/ollama-hosts (same pattern as benchmark, compare-insights)
 */
export async function loadOllamaHosts(elements, state) {
  const hostSelect = elements.hostInput;
  try {
    const res = await fetch('/api/ollama-hosts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = json.data || json;
    const hosts = data.hosts || [];

    // Store hosts in state for reference
    state.ollamaHosts = hosts;

    hostSelect.innerHTML = '';
    if (hosts.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No hosts configured';
      hostSelect.appendChild(opt);
      return;
    }

    hosts.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.url;
      const status = h.available ? '\u2713' : '\u2717';
      const modelCount = h.models ? ` [${h.models.length} models]` : '';
      opt.textContent = `${status} ${h.name} (${h.url})${modelCount}`;
      if (!h.available) opt.style.color = 'var(--muted, #888)';
      hostSelect.appendChild(opt);
    });

    // Select saved host URL, or first available host
    const savedUrl = state.settings?.hostUrl;
    const savedExists = savedUrl && Array.from(hostSelect.options).some(o => o.value === savedUrl);
    if (savedExists) {
      hostSelect.value = savedUrl;
    } else {
      const firstAvailable = hosts.find(h => h.available);
      if (firstAvailable) hostSelect.value = firstAvailable.url;
    }
  } catch (err) {
    console.warn('Failed to load Ollama hosts:', err);
    hostSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '\u26a0\ufe0f Failed to load hosts';
    hostSelect.appendChild(opt);
  }
}

export function targetHost(elements, defaults, options = {}) {
  if (!options.includeRouter && isRouterMode(elements)) return '';
  const hostUrl = elements.hostInput?.value;
  if (hostUrl) return hostUrl.replace(/\/+$/, '');
  // Fallback to defaults
  return defaults?.host || '';
}

export async function loadHostPreferences(state) {
  if (document.body.dataset.agentxProfile === 'demo') {
    state.hostPreferences = [];
    state.hostPreferencesByUrl = new Map();
    return [];
  }
  try {
    const res = await fetch('/api/nerve-center/host-preferences', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const prefs = Array.isArray(json.data) ? json.data : [];
    state.hostPreferences = prefs;
    state.hostPreferencesByUrl = new Map(prefs.map((pref) => [normalizeHostUrl(pref.hostUrl), pref]));
    return prefs;
  } catch (err) {
    console.warn('Failed to load host preferences:', err);
    state.hostPreferences = [];
    state.hostPreferencesByUrl = new Map();
    return [];
  }
}

export function updateRoutingModeUi(elements, state, defaults) {
  const routerMode = isRouterMode(elements, state);
  const hostState = getHostChatState(elements, state, defaults);
  const blocked = !routerMode && !hostState.available;
  if (elements.hostInput) elements.hostInput.disabled = routerMode;
  if (elements.modelSelect) elements.modelSelect.disabled = routerMode || blocked;
  if (elements.refreshModels) elements.refreshModels.disabled = routerMode || blocked;

  const modeLabel = routingModeLabel(routingMode(elements, state));

  const routingHint = document.getElementById('routingModeHint');
  if (routingHint) {
    routingHint.textContent = routerMode
      ? `${modeLabel} mode uses one server-selected model for the whole session — no per-message switching.`
      : hostState.reason || 'Use the configured host and its pinned or loaded model.';
  }

  const hostHint = document.getElementById('hostInputHint');
  if (hostHint) {
    hostHint.textContent = routerMode
      ? `Ignored in ${modeLabel} mode. Switch to Manual to pin a host.`
      : blocked
        ? hostState.reason
        : 'This host is sent with each chat request.';
  }

  const modelHint = document.getElementById('modelSelectHint');
  if (modelHint) {
    modelHint.textContent = routerMode
      ? `Ignored in ${modeLabel} mode. The server picks the model for this mode's task.`
      : blocked
        ? hostState.reason || 'Model selection is disabled until the host is available for chat.'
        : 'Model selection prefers the currently loaded model, then the primary pinned model.';
  }
}

export function readProfileInputs(elements) {
  return {
    language: elements.memoryLanguage.value.trim(),
    role: elements.memoryRole.value.trim(),
    style: elements.memoryStyle.value.trim(),
  };
}

/**
 * Initialize dev mode toggle.
 * Standard mode: hides host/model/system prompt/tuning sections.
 * Dev mode: shows everything.
 * Persists in localStorage.
 */
export function initDevModeToggle() {
  const devToggleBtn = document.getElementById('headerDevToggle');
  if (!devToggleBtn) return;

  const isDevMode = localStorage.getItem('agentx_dev_mode') === 'true';
  if (isDevMode) devToggleBtn.classList.add('active');
  applyDevMode(isDevMode);

  devToggleBtn.addEventListener('click', () => {
    const active = devToggleBtn.classList.toggle('active');
    localStorage.setItem('agentx_dev_mode', String(active));
    applyDevMode(active);
  });
}

function applyDevMode(enabled) {
  const devOnlyFields = [
    document.getElementById('hostInput')?.closest('.field'),
    document.getElementById('modelSelect')?.closest('.field'),
    document.getElementById('systemPrompt')?.closest('.field'),
    document.getElementById('tuningHeader')?.closest('.collapsible-section'),
  ].filter(Boolean);

  devOnlyFields.forEach(el => {
    el.style.display = enabled ? '' : 'none';
  });
}

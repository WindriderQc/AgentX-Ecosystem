/**
 * Chat voice — STT/TTS functions, recording, voice health
 */
import {
  fetchVoixHealth, fetchVoixDevices, fetchVoixSettings, runVoixTtsSmoke, runVoixFullSmoke,
  createVoixSession, sendVoixTextTurn, extractVoixSessionId,
  extractVoixReplyText, extractVoixTranscript, formatVoixTimings,
  stringifyVoixResult, summarizeVoixDevices, summarizeVoixHealth,
  transcribeVoixAudio, synthesizeVoixAudio
} from './chat-voix.js';

let recognition = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimer = null;

export function updateVoiceFieldVisibility(elements) {
  const sttProv = elements.sttProviderSelect?.value || 'browser';
  const ttsProv = document.getElementById('ttsProviderSelect')?.value || 'browser';
  const convoOn = elements.voiceAutoSend?.checked;
  if (elements.whisperModelField) {
    elements.whisperModelField.style.display = 'none';
  }
  const voixVisible = sttProv === 'voix' || ttsProv === 'voix' || convoOn;
  if (elements.voixStatusField) elements.voixStatusField.style.display = voixVisible ? '' : 'none';
  if (elements.voixActionRow) elements.voixActionRow.style.display = voixVisible ? 'flex' : 'none';
  if (elements.voixResultField) elements.voixResultField.style.display = voixVisible ? '' : 'none';
  const ttsProviderField = document.getElementById('ttsProviderField');
  if (ttsProviderField) ttsProviderField.style.display = 'none';
  if (elements.ttsVoiceField) {
    elements.ttsVoiceField.style.display = 'none';
  }
}

function renderVoiceDefaultsSummary(elements, state) {
  if (!elements.voiceDefaultsSummary) return;
  const stt = `${state.settings?.sttProvider || 'browser'}${state.settings?.sttLanguage ? ` / ${state.settings.sttLanguage}` : ''}`;
  const tts = state.settings?.tts
    ? `${state.settings?.ttsProvider || 'browser'}${state.settings?.ttsVoice ? ` / ${state.settings.ttsVoice}` : ''}`
    : 'off';
  const convo = state.settings?.convoModeEnabled ? 'available' : 'off';
  elements.voiceDefaultsSummary.textContent = `STT: ${stt} | TTS: ${tts} | ConvoMode: ${convo}`;
}

function setConvoModeSummary(elements, state, text) {
  if (!elements.convoModeSummary) return;
  const session = state.voixSessionId ? ` | Session: ${state.voixSessionId}` : '';
  elements.convoModeSummary.textContent = text || `ConvoMode: ${state.convoModeActive ? 'active' : 'inactive'}${session}`;
}

function setHealthDot(el, status) {
  if (!el) return;
  el.className = 'voice-health-dot ' + status;
}

function setPanelText(el, text) {
  if (el) el.textContent = text;
}

function setSelectValue(select, value) {
  if (!select) return;
  const normalized = value == null ? '' : String(value);
  if (!Array.from(select.options).some((option) => option.value === normalized)) {
    const option = document.createElement('option');
    option.value = normalized;
    option.textContent = normalized || 'Server default';
    select.appendChild(option);
  }
  select.value = normalized;
}

function setVoixButtonsDisabled(elements, disabled) {
  [
    elements.voixSmokeBtn,
    elements.voixFullSmokeBtn,
    elements.voixSessionBtn,
    elements.voixTextTurnBtn,
    elements.convoModeBtn
  ].forEach((button) => {
    if (!button) return;
    button.disabled = !!disabled;
  });
}

export function resetVoixPanelState(elements, state, options = {}) {
  const {
    healthText = 'VoiX optional. Browser voice input active.',
    devicesText = 'Devices: not needed for browser mode',
    disableActions = true,
    preserveSession = true
  } = options;

  updateVoiceProvider(elements, state, false);
  state.voiceProvider = 'browser';
  setHealthDot(elements.sttHealthDot, 'partial');
  setHealthDot(elements.sttHealthDotInner, 'partial');
  setHealthDot(elements.ttsHealthDot, 'partial');
  setPanelText(elements.voixHealthSummary, healthText);
  setPanelText(elements.voixDevicesSummary, devicesText);
  setPanelText(
    elements.voixSessionSummary,
    preserveSession && state.voixSessionId ? `Session: ${state.voixSessionId}` : 'Session: none'
  );
  renderVoiceDefaultsSummary(elements, state);
  setConvoModeSummary(elements, state);
  setVoixButtonsDisabled(elements, disableActions);
}

function renderVoixResult(elements, title, payload) {
  if (!elements.voixResultOutput) return;

  const sessionId = extractVoixSessionId(payload);
  const timings = formatVoixTimings(payload);
  const header = [
    title,
    sessionId ? `Session: ${sessionId}` : 'Session: pending',
    `Timings: ${timings}`
  ].join('\n');

  elements.voixResultOutput.textContent = `${header}\n\n${stringifyVoixResult(payload)}`;
}

function updateVoiceProvider(elements, state, voixAvailable) {
  const sttPref = elements.sttProviderSelect?.value || state.settings?.sttProvider || 'browser';

  if (sttPref === 'browser') {
    state.voiceProvider = 'browser';
    return;
  }

  if ((sttPref === 'voix' || sttPref === 'auto') && voixAvailable) {
    state.voiceProvider = 'voix';
    return;
  }

  state.voiceProvider = 'browser';
}

export async function refreshVoixPanel(elements, state, helpers, options = {}) {
  try {
    const healthData = await fetchVoixHealth();
    const devicesData = await fetchVoixDevices().catch(() => null);

    updateVoiceProvider(elements, state, true);
    setHealthDot(elements.sttHealthDot, 'healthy');
    setHealthDot(elements.sttHealthDotInner, 'healthy');
    setHealthDot(elements.ttsHealthDot, 'healthy');
    setPanelText(elements.voixHealthSummary, `Health: ${summarizeVoixHealth(healthData)}`);
    setPanelText(elements.voixDevicesSummary, `Devices: ${summarizeVoixDevices(devicesData)}`);
    setPanelText(elements.voixSessionSummary, state.voixSessionId ? `Session: ${state.voixSessionId}` : 'Session: none');
    renderVoiceDefaultsSummary(elements, state);
    setConvoModeSummary(elements, state);
    setVoixButtonsDisabled(elements, false);
    updateVoiceFieldVisibility(elements);
    if (options.announce) {
      helpers?.setFeedback?.('VoiX status refreshed.', 'success');
    }
  } catch (err) {
    resetVoixPanelState(elements, state, {
      healthText: 'Health: offline (optional service not running)',
      devicesText: 'Devices: unavailable while VoiX is offline',
      disableActions: true,
      preserveSession: true
    });
    if (options.announce) {
      helpers?.setFeedback?.('VoiX is offline. Browser voice input is still available.', 'warning');
    }
  }
}

export async function checkVoiceHealth(elements, state) {
  return refreshVoixPanel(elements, state);
}

function showVoiceStatus(text) {
  const el = document.getElementById('voiceStatus');
  if (el) { el.textContent = text; el.style.display = text ? 'inline' : 'none'; }
}

function updateRecordingTimer() {
  if (!recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  showVoiceStatus(`Recording... ${elapsed}s`);
}

function cleanupVoiceInput(elements) {
  recognition = null;
  mediaRecorder = null;
  audioChunks = [];
  isRecording = false;
  recordingStartTime = null;
  clearInterval(recordingTimer);
  recordingTimer = null;
  elements.micBtn.classList.remove('recording');
  elements.micBtn.setAttribute('aria-pressed', 'false');
  showVoiceStatus('');
}

function startBrowserVoiceInput(elements, state, helpers) {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    helpers.setFeedback('Speech recognition not supported in this browser.', 'error');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  const langCode = elements.sttLanguageSelect?.value || state.settings?.sttLanguage || 'en';
  recognition.lang = langCode.length === 2 ? `${langCode}-${langCode.toUpperCase()}` : langCode;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isRecording = true;
    elements.micBtn.classList.add('recording');
    elements.micBtn.setAttribute('aria-pressed', 'true');
    showVoiceStatus('Listening...');
    helpers.setStatus('Listening...', 'success');
  };
  recognition.onresult = (event) => {
    elements.messageInput.value = event.results[0][0].transcript;
    if (state.settings?.voiceAutoSend) helpers.sendMessage();
  };
  recognition.onerror = (event) => {
    console.error('Speech recognition error', event.error);
    helpers.setFeedback(`Voice error: ${event.error}`, 'error');
    cleanupVoiceInput(elements);
  };
  recognition.onend = () => cleanupVoiceInput(elements);

  window.speechSynthesis.cancel();
  recognition.start();
}

function stopBrowserVoiceInput(elements) {
  if (recognition) recognition.stop();
  else cleanupVoiceInput(elements);
}

async function startVoixVoiceInput(elements, state, helpers) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    });

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordingTimer);
      showVoiceStatus('Transcribing via VoiX...');
      helpers.setStatus('Transcribing via VoiX...', 'success');

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });

      try {
        const lang = elements.sttLanguageSelect?.value || 'fr';
        const model = elements.whisperModelSelect?.value || '';
        const result = await transcribeVoixAudio(blob, { language: lang, model });
        const transcript = result?.text || result?.transcript || '';

        if (transcript) {
          elements.messageInput.value = transcript;
          helpers.setFeedback(`VoiX transcribed: "${transcript.substring(0, 60)}${transcript.length > 60 ? '...' : ''}"`, 'success');
          if (state.settings?.voiceAutoSend) helpers.sendMessage();
        } else {
          helpers.setFeedback('VoiX: no speech detected. Try again.', 'error');
        }
      } catch (err) {
        console.error('VoiX transcription error:', err);
        helpers.setFeedback(`VoiX STT error: ${err.message}`, 'error');
      }
      cleanupVoiceInput(elements);
    };

    mediaRecorder.start();
    isRecording = true;
    recordingStartTime = Date.now();
    recordingTimer = setInterval(updateRecordingTimer, 1000);
    elements.micBtn.classList.add('recording');
    elements.micBtn.setAttribute('aria-pressed', 'true');
    showVoiceStatus('Recording (VoiX)... 0s');
    helpers.setStatus('Recording for VoiX...', 'success');
    window.speechSynthesis.cancel();
  } catch (err) {
    console.error('Microphone access error:', err);
    helpers.setFeedback(`Mic error: ${err.message}. Falling back to browser.`, 'error');
    startBrowserVoiceInput(elements, state, helpers);
  }
}

function stopVoixVoiceInput(elements) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanupVoiceInput(elements);
  }
}

async function startConvoModeVoiceTurn(elements, state, helpers) {
  if (!state.settings?.convoModeEnabled) {
    helpers.setFeedback('ConvoMode is disabled. Open Voice config to enable it.', 'error');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
    });
    state.currentVoiceMode = 'convo';

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordingTimer);
      showVoiceStatus('ConvoMode: thinking...');
      helpers.setStatus('ConvoMode turn...', 'success');

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      try {
        const lang = elements.sttLanguageSelect?.value || state.settings?.sttLanguage || 'en';
        const model = elements.whisperModelSelect?.value || state.settings?.whisperModel || '';
        const transcription = await transcribeVoixAudio(blob, { language: lang, model });
        const transcript = extractVoixTranscript(transcription) || transcription?.text || '';

        if (!transcript) {
          helpers.setFeedback('ConvoMode heard no speech. Try again.', 'error');
          return;
        }

        const sessionId = await ensureVoixSession(elements, state, {
          forceNew: state.settings?.convoModeKeepSession === false
        });
        const turnResult = await sendVoixTextTurn(sessionId ? { text: transcript, session_id: sessionId } : { text: transcript });
        const resolvedSessionId = extractVoixSessionId(turnResult) || sessionId;
        const replyText = extractVoixReplyText(turnResult) || '(no reply text)';

        if (resolvedSessionId) {
          state.voixSessionId = resolvedSessionId;
          setPanelText(elements.voixSessionSummary, `Session: ${resolvedSessionId}`);
        }

        helpers.appendMessage({
          role: 'user',
          content: transcript,
          createdAt: new Date().toISOString()
        }, { persist: false });

        helpers.appendMessage({
          role: 'assistant',
          content: replyText,
          createdAt: new Date().toISOString()
        }, { persist: false });

        renderVoixResult(elements, 'ConvoMode voice turn complete', turnResult);

        if (state.settings?.convoModeAutoSpeak !== false) {
          const previousTts = state.settings.tts;
          state.settings.tts = true;
          try {
            await helpers.speakText(replyText);
          } finally {
            state.settings.tts = previousTts;
          }
        }

        helpers.setFeedback(`ConvoMode replied. ${formatVoixTimings(turnResult)}`, 'success');
      } catch (err) {
        console.error('ConvoMode turn error:', err);
        helpers.setFeedback(`ConvoMode error: ${err.message}`, 'error');
      } finally {
        state.currentVoiceMode = null;
        cleanupVoiceInput(elements);
        setConvoModeSummary(elements, state);
        helpers.setStatus('Idle');
      }
    };

    mediaRecorder.start();
    isRecording = true;
    recordingStartTime = Date.now();
    recordingTimer = setInterval(updateRecordingTimer, 1000);
    elements.micBtn.classList.add('recording');
    elements.micBtn.setAttribute('aria-pressed', 'true');
    showVoiceStatus('ConvoMode recording... 0s');
    helpers.setStatus('ConvoMode listening...', 'success');
    window.speechSynthesis.cancel();
  } catch (err) {
    console.error('ConvoMode microphone access error:', err);
    helpers.setFeedback(`Mic error: ${err.message}`, 'error');
  }
}

function stopConvoModeVoiceTurn(elements) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanupVoiceInput(elements);
  }
}

export function toggleVoiceInput(elements, state, helpers) {
  if (isRecording) {
    if (state.currentVoiceMode === 'convo') {
      stopConvoModeVoiceTurn(elements);
      return;
    }
    if (state.voiceProvider === 'voix') stopVoixVoiceInput(elements);
    else stopBrowserVoiceInput(elements);
  } else {
    if (state.convoModeActive) {
      startConvoModeVoiceTurn(elements, state, helpers);
      return;
    }
    if (state.voiceProvider === 'voix') startVoixVoiceInput(elements, state, helpers);
    else startBrowserVoiceInput(elements, state, helpers);
  }
}

export async function speakText(state, text) {
  if (!state.settings.tts) return;
  const provider = state.settings.ttsProvider || 'browser';

  if (provider === 'voix') {
    try {
      const voice = state.settings?.ttsVoice || '';
      const blob = await synthesizeVoixAudio(text, { voice, responseFormat: state.settings?.ttsResponseFormat });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
      return;
    } catch (err) {
      console.warn('VoiX TTS failed, falling back to browser:', err.message);
    }
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const setVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Google US English')) ||
                      voices.find(v => v.lang === 'en-US') ||
                      voices[0];
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
  };
  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.addEventListener('voiceschanged', setVoice, { once: true });
  } else {
    setVoice();
  }
}

async function ensureVoixSession(elements, state, options = {}) {
  if (state.voixSessionId && !options.forceNew) {
    return state.voixSessionId;
  }

  const sessionPayload = await createVoixSession({});
  const sessionId = extractVoixSessionId(sessionPayload);

  if (sessionId) {
    state.voixSessionId = sessionId;
    setPanelText(elements.voixSessionSummary, `Session: ${sessionId}`);
  }

  return sessionId;
}

export async function createVoixSessionFlow(elements, state, helpers) {
  try {
    helpers.setStatus('Creating VoiX session...', 'success');
    const sessionId = await ensureVoixSession(elements, state);
    renderVoixResult(elements, 'VoiX session ready', { session_id: sessionId || 'pending' });
    helpers.setFeedback(sessionId ? `VoiX session ready: ${sessionId}` : 'VoiX session created.', 'success');
  } catch (err) {
    helpers.setFeedback(`VoiX session error: ${err.message}`, 'error');
  } finally {
    helpers.setStatus('Idle');
  }
}

export async function runVoixSmokeFlow(elements, state, helpers) {
  try {
    helpers.setStatus('Running VoiX TTS smoke...', 'success');
    const payload = await runVoixTtsSmoke({});
    const transcript = extractVoixTranscript(payload);
    renderVoixResult(elements, transcript ? `VoiX TTS smoke transcript: ${transcript}` : 'VoiX TTS smoke complete', payload);
    helpers.setFeedback(`VoiX TTS smoke complete. ${formatVoixTimings(payload)}`, 'success');
  } catch (err) {
    helpers.setFeedback(`VoiX TTS smoke error: ${err.message}`, 'error');
  } finally {
    helpers.setStatus('Idle');
  }
}

export async function runVoixFullSmokeFlow(elements, state, helpers) {
  try {
    helpers.setStatus('Running VoiX full smoke...', 'success');
    const payload = await runVoixFullSmoke({});
    const transcript = extractVoixTranscript(payload);
    renderVoixResult(elements, transcript ? `VoiX full smoke transcript: ${transcript}` : 'VoiX full smoke complete', payload);
    helpers.setFeedback(`VoiX full smoke complete. Whisper CPU fallback may take 20-60s. ${formatVoixTimings(payload)}`, 'success');
  } catch (err) {
    helpers.setFeedback(`VoiX full smoke error: ${err.message}`, 'error');
  } finally {
    helpers.setStatus('Idle');
  }
}

export async function refreshVoiceDefaults(elements, state, helpers, options = {}) {
  if (document.body.dataset.agentxProfile === 'demo') return;
  try {
    const settings = await fetchVoixSettings();
    const features = settings?.features || {};
    const stt = features.stt || {};
    const tts = features.tts || {};
    const convoMode = features.convoMode || {};

    state.settings.sttProvider = stt.provider || state.settings.sttProvider || 'browser';
    state.settings.sttLanguage = stt.language || state.settings.sttLanguage || 'en';
    state.settings.whisperModel = stt.model || state.settings.whisperModel || '';
    state.settings.tts = Boolean(tts.enabled);
    state.settings.ttsProvider = tts.provider || state.settings.ttsProvider || 'browser';
    state.settings.ttsVoice = tts.voice || state.settings.ttsVoice || '';
    state.settings.ttsResponseFormat = tts.responseFormat || state.settings.ttsResponseFormat || 'mp3';
    state.settings.convoModeEnabled = Boolean(convoMode.enabled);
    state.settings.convoModeAutoSpeak = convoMode.autoSpeak !== false;
    state.settings.convoModeKeepSession = convoMode.keepSession !== false;

    setSelectValue(elements.sttProviderSelect, state.settings.sttProvider);
    setSelectValue(elements.sttLanguageSelect, state.settings.sttLanguage);
    setSelectValue(elements.whisperModelSelect, state.settings.whisperModel || '');
    if (elements.ttsToggle) elements.ttsToggle.checked = state.settings.tts;
    const ttsProviderSelect = document.getElementById('ttsProviderSelect');
    setSelectValue(ttsProviderSelect, state.settings.ttsProvider);
    setSelectValue(elements.ttsVoiceSelect, state.settings.ttsVoice || '');
    if (elements.voiceAutoSend) elements.voiceAutoSend.checked = state.settings.convoModeEnabled;

    renderVoiceDefaultsSummary(elements, state);
    setConvoModeSummary(elements, state);
    updateVoiceFieldVisibility(elements);

    if (options.announce) helpers?.setFeedback?.('Voice defaults refreshed from /voice config.', 'success');
  } catch (err) {
    console.warn('Failed to refresh voice defaults:', err);
    if (options.announce) helpers?.setFeedback?.(`Voice defaults refresh failed: ${err.message}`, 'error');
  }
}

export async function toggleConvoModeFlow(elements, state, helpers) {
  if (state.convoModeActive) {
    state.convoModeActive = false;
    if (elements.convoModeBtn) elements.convoModeBtn.textContent = 'Start ConvoMode';
    if (state.settings?.convoModeKeepSession === false) {
      state.voixSessionId = null;
      setPanelText(elements.voixSessionSummary, 'Session: none');
    }
    setConvoModeSummary(elements, state);
    helpers.setFeedback('ConvoMode stopped.', 'success');
    return;
  }

  if (!state.settings?.convoModeEnabled) {
    helpers.setFeedback('ConvoMode is disabled. Open Voice config to enable it.', 'error');
    return;
  }

  try {
    helpers.setStatus('Starting ConvoMode...', 'success');
    await refreshVoixPanel(elements, state, helpers);
    const sessionId = await ensureVoixSession(elements, state);
    state.convoModeActive = true;
    if (elements.convoModeBtn) elements.convoModeBtn.textContent = 'Stop ConvoMode';
    setConvoModeSummary(elements, state, `ConvoMode: active${sessionId ? ` | Session: ${sessionId}` : ''}`);
    renderVoixResult(elements, 'ConvoMode ready', { session_id: sessionId || 'pending' });
    helpers.setFeedback('ConvoMode active. Use the mic button for each voice turn.', 'success');
  } catch (err) {
    helpers.setFeedback(`ConvoMode start error: ${err.message}`, 'error');
  } finally {
    helpers.setStatus('Idle');
  }
}

export async function sendVoixTextTurnFlow(elements, state, helpers) {
  const text = elements.messageInput?.value?.trim();

  if (!text) {
    helpers.setFeedback('Type a message in the main composer before sending a VoiX text turn.', 'error');
    return;
  }

  try {
    helpers.setStatus('Sending VoiX text turn...', 'success');
    const sessionId = await ensureVoixSession(elements, state);
    const payload = sessionId ? { text, session_id: sessionId } : { text };
    const turnResult = await sendVoixTextTurn(payload);
    const resolvedSessionId = extractVoixSessionId(turnResult) || sessionId;
    const replyText = extractVoixReplyText(turnResult) || '(no reply text)';

    if (resolvedSessionId) {
      state.voixSessionId = resolvedSessionId;
      setPanelText(elements.voixSessionSummary, `Session: ${resolvedSessionId}`);
    }

    helpers.appendMessage({
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }, { persist: false });

    helpers.appendMessage({
      role: 'assistant',
      content: `[VoiX]\n\n${replyText}\n\n${formatVoixTimings(turnResult)}`,
      createdAt: new Date().toISOString()
    }, { persist: false });

    renderVoixResult(elements, 'VoiX text turn complete', turnResult);
    elements.messageInput.value = '';
    helpers.setFeedback(`VoiX replied. ${formatVoixTimings(turnResult)}`, 'success');
  } catch (err) {
    helpers.setFeedback(`VoiX text-turn error: ${err.message}`, 'error');
  } finally {
    helpers.setStatus('Idle');
  }
}

(function () {
  'use strict';

  // Kid-facing reading aid. Core owns the session/persona policy and browser
  // surface; VoiX remains the preferred local STT/TTS runtime. Browser speech
  // APIs are bounded fallbacks and text always remains available.
  var PERSONA = { packId: 'kidx_reader', modeId: 'reader', scopeId: 'family' };
  var UI_STATES = {
    ready: { label: 'prêt', busy: false },
    listening: { label: "j'écoute…", busy: true },
    transcribing: { label: 'je déchiffre…', busy: true },
    thinking: { label: 'je réfléchis…', busy: true },
    speaking: { label: 'je te réponds…', busy: true },
    complete: { label: 'bravo !', busy: false },
    retryable_error: { label: 'on réessaie ?', busy: false },
    mic_unavailable: { label: 'écris-moi', busy: false }
  };

  var state = {
    session: null,
    history: [],
    recorder: null,
    stream: null,
    chunks: [],
    recording: false,
    lastReply: '',
    lastRequest: null,
    retryAction: null,
    speak: true,
    sttEngine: 'voix',
    browserSttSupported: false,
    recognition: null,
    wakeLock: null,
    micUnavailable: false,
    ttsController: null,
    currentAudio: null,
    currentAudioUrl: '',
    speechUtterance: null,
    speechRequestId: 0
  };

  function $(id) { return document.getElementById(id); }

  async function apiJson(url, options) {
    var res = await fetch(url, Object.assign({ credentials: 'include' }, options));
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || body.status === 'error') {
      throw new Error(body.message || ('HTTP ' + res.status));
    }
    return body.data || body;
  }

  function setState(name, label) {
    var root = $('lectureRoot');
    var config = UI_STATES[name] || UI_STATES.ready;
    root.dataset.state = UI_STATES[name] ? name : 'ready';
    root.setAttribute('aria-busy', config.busy ? 'true' : 'false');
    $('lecturePill').textContent = label || config.label;
    setControls();
  }

  function setHint(text, tone) {
    var hint = $('lectureHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.hidden = !text;
    if (text) hint.dataset.tone = tone || 'info';
    else hint.removeAttribute('data-tone');
  }

  function setRetry(action) {
    state.retryAction = typeof action === 'function' ? action : null;
    setControls();
  }

  function clearRetry() {
    state.retryAction = null;
    setControls();
  }

  function setControls() {
    var root = $('lectureRoot');
    var mode = root ? root.dataset.state : 'ready';
    var hardBusy = mode === 'transcribing' || mode === 'thinking';
    var speaking = mode === 'speaking';
    var textBusy = hardBusy || state.recording;
    var micBtn = $('micBtn');
    var replayBtn = $('replayBtn');
    var retryBtn = $('retryBtn');
    var input = $('textInput');
    var submit = $('textSubmitBtn');

    if (micBtn) {
      micBtn.disabled = hardBusy || speaking || state.micUnavailable;
      micBtn.setAttribute('aria-pressed', state.recording ? 'true' : 'false');
      micBtn.setAttribute('aria-label', state.recording ? 'Arrêter le micro' : 'Parle-moi');
      var micLabel = micBtn.querySelector('span');
      if (micLabel) micLabel.textContent = state.recording ? 'arrête' : 'parle-moi';
    }
    if (replayBtn) {
      replayBtn.disabled = !state.lastReply || hardBusy || state.recording;
      replayBtn.setAttribute('aria-pressed', speaking ? 'true' : 'false');
      replayBtn.setAttribute('aria-label', speaking ? 'Arrêter la lecture' : 'Réécoute la réponse');
      var replayIcon = replayBtn.querySelector('i');
      var replayLabel = replayBtn.querySelector('span');
      if (replayIcon) replayIcon.className = speaking ? 'fa-solid fa-stop' : 'fa-solid fa-volume-high';
      if (replayLabel) replayLabel.textContent = speaking ? 'arrête' : 'réécoute';
    }
    if (retryBtn) {
      var showRetry = mode === 'retryable_error' && state.retryAction;
      retryBtn.hidden = !showRetry;
      retryBtn.setAttribute('aria-hidden', showRetry ? 'false' : 'true');
      retryBtn.disabled = !state.retryAction;
    }
    if (input) input.disabled = textBusy;
    if (submit) submit.disabled = textBusy;
  }

  function focusTextInput() {
    var input = $('textInput');
    if (input && !input.disabled) input.focus();
  }

  async function requestScreenWakeLock() {
    if (!navigator.wakeLock || state.wakeLock || document.visibilityState !== 'visible') return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', function () { state.wakeLock = null; }, { once: true });
    } catch (err) {
      if (window.console) console.info('[lecture] screen wake lock unavailable', err && err.message);
    }
  }

  async function releaseScreenWakeLock() {
    if (!state.wakeLock) return;
    try {
      await state.wakeLock.release();
    } catch (_e) {
      state.wakeLock = null;
    }
  }

  function showWord(word) {
    var el = $('lectureWord');
    el.textContent = word || '';
    el.style.display = word ? 'inline-block' : 'none';
  }

  function showReply(text) { $('lectureReply').textContent = text || ''; }

  async function ensureSession() {
    if (state.session && state.session.sessionId) return state.session;
    var data = await apiJson('/api/voice-personas/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PERSONA)
    });
    state.session = data.session;
    return state.session;
  }

  function remember(role, content) {
    state.history.push({ role: role, content: content });
    if (state.history.length > 6) state.history = state.history.slice(-6);
  }

  function clearNativeAudio() {
    if (state.currentAudio) {
      try { state.currentAudio.pause(); } catch (_e) { /* no-op */ }
      state.currentAudio.removeAttribute('src');
      state.currentAudio = null;
    }
    if (state.currentAudioUrl) {
      URL.revokeObjectURL(state.currentAudioUrl);
      state.currentAudioUrl = '';
    }
  }

  function cancelSpeech(markComplete) {
    state.speechRequestId += 1;
    if (state.ttsController) state.ttsController.abort();
    state.ttsController = null;
    clearNativeAudio();
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_e) { /* no-op */ }
    state.speechUtterance = null;
    if (markComplete && state.lastReply) setState('complete');
    else setControls();
  }

  function finishSpeech(requestId) {
    if (requestId !== state.speechRequestId) return;
    state.ttsController = null;
    state.speechUtterance = null;
    clearNativeAudio();
    setState('complete');
  }

  function browserSpeak(text, requestId) {
    if (requestId !== state.speechRequestId) return;
    try {
      if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
        finishSpeech(requestId);
        return;
      }
      var utterance = new SpeechSynthesisUtterance(text);
      state.speechUtterance = utterance;
      utterance.lang = 'fr-CA';
      utterance.onend = function () { finishSpeech(requestId); };
      utterance.onerror = function () { finishSpeech(requestId); };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch (_e) {
      finishSpeech(requestId);
    }
  }

  async function speak(text) {
    var content = String(text || '').trim();
    if (!content) return;
    cancelSpeech(false);
    var requestId = ++state.speechRequestId;
    var controller = new AbortController();
    state.ttsController = controller;
    setState('speaking');
    try {
      var res = await fetch('/api/voix/synthesize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error('tts');
      var blob = await res.blob();
      if (requestId !== state.speechRequestId) return;
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      state.currentAudioUrl = url;
      state.currentAudio = audio;
      audio.addEventListener('ended', function () { finishSpeech(requestId); }, { once: true });
      audio.addEventListener('error', function () {
        if (requestId !== state.speechRequestId) return;
        clearNativeAudio();
        browserSpeak(content, requestId);
      }, { once: true });
      await audio.play();
    } catch (err) {
      if (requestId !== state.speechRequestId || (err && err.name === 'AbortError')) return;
      clearNativeAudio();
      browserSpeak(content, requestId);
    }
  }

  async function ask(text, channel) {
    var content = String(text || '').trim();
    if (!content) return;
    cancelSpeech(false);
    clearRetry();
    setHint('');
    state.lastRequest = { text: content, channel: channel || 'text' };
    showWord(content);
    showReply('');
    setState('thinking');
    remember('user', content);
    try {
      var session = await ensureSession();
      var data = await apiJson(
        '/api/voice-personas/sessions/' + encodeURIComponent(session.sessionId) + '/turns/text',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: content, channel: channel || 'text', history: state.history.slice(0, -1) })
        }
      );
      var reply = (data.reply && data.reply.text) || '';
      state.session = data.session || state.session;
      state.lastReply = reply;
      remember('assistant', reply);
      showReply(reply || 'Je ne trouve pas les mots. On réessaie ?');
      if (state.speak && reply) speak(reply);
      else setState('complete');
    } catch (err) {
      showReply("Oups, Nestor a perdu le fil. Tu peux réessayer.");
      setHint('Ton mot est resté ici; rien à retaper.', 'error');
      setRetry(function () { ask(content, channel || 'text'); });
      setState('retryable_error');
      focusTextInput();
      if (window.console) console.error('[lecture] ask failed', err);
    }
  }

  async function voixHealthy() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    try {
      var res = await fetch('/api/voix/health', { credentials: 'include', signal: ctrl.signal });
      return res.ok;
    } catch (_e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chooseSttEngine() {
    state.browserSttSupported = ('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window);
    if (state.micUnavailable) return;
    var voixOk = await voixHealthy();
    if (!voixOk && state.browserSttSupported) {
      state.sttEngine = 'browser';
      if (window.console) console.info('[lecture] VoiX unreachable -> using browser speech recognition');
    } else {
      state.sttEngine = 'voix';
    }
  }

  function markMicUnavailable(message, focusFallback) {
    state.micUnavailable = true;
    state.recording = false;
    setHint(message || 'Le micro est indisponible. Tu peux toujours écrire ton mot.', 'warning');
    setState('mic_unavailable');
    if (focusFallback !== false) focusTextInput();
  }

  function startListening() {
    if (state.micUnavailable) {
      focusTextInput();
      return;
    }
    if (window.isSecureContext === false) {
      markMicUnavailable('Le micro a besoin d’une connexion sécurisée. Écris ton mot ici pour continuer.', false);
      return;
    }
    cancelSpeech(false);
    clearRetry();
    setHint('');
    requestScreenWakeLock();
    if (state.sttEngine === 'browser') startBrowserRecognition();
    else startRecording();
  }

  function stopListening() {
    if (state.sttEngine === 'browser') stopBrowserRecognition();
    else stopRecording();
  }

  function startBrowserRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      markMicUnavailable('Le micro vocal n’est pas disponible ici. Écris ton mot pour continuer.');
      return;
    }
    try {
      state.recognition = new SR();
    } catch (_e) {
      markMicUnavailable('Le micro vocal n’est pas disponible ici. Écris ton mot pour continuer.');
      return;
    }
    state.recognition.lang = 'fr-CA';
    state.recognition.interimResults = false;
    state.recognition.maxAlternatives = 1;

    state.recognition.onresult = function (event) {
      var transcript = '';
      try { transcript = event.results[0][0].transcript || ''; } catch (_e) { transcript = ''; }
      setState('transcribing');
      if (transcript) {
        ask(transcript, 'voice');
      } else {
        showReply("Je n'ai rien entendu. On réessaie ?");
        setRetry(startListening);
        setState('retryable_error');
      }
    };
    state.recognition.onerror = function (event) {
      var err = event && event.error;
      if (window.console) console.error('[lecture] browser STT error', err);
      state.recording = false;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        markMicUnavailable("J'ai besoin de la permission du micro. Demande à un adulte, ou écris ton mot.");
      } else {
        showReply(err === 'no-speech' ? "Je n'ai rien entendu. On réessaie ?" : 'La voix dort un peu. On réessaie ?');
        setRetry(startListening);
        setState('retryable_error');
      }
    };
    state.recognition.onend = function () {
      state.recording = false;
      releaseScreenWakeLock();
      if ($('lectureRoot').dataset.state === 'listening') setState('ready');
      else setControls();
    };

    state.recording = true;
    setState('listening');
    try {
      window.speechSynthesis && window.speechSynthesis.cancel();
      state.recognition.start();
    } catch (_e) {
      state.recording = false;
      showReply('Le micro est déjà occupé. On réessaie ?');
      setRetry(startListening);
      setState('retryable_error');
    }
  }

  function stopBrowserRecognition() {
    if (state.recognition) {
      try { state.recognition.stop(); } catch (_e) { /* no-op */ }
    }
    state.recording = false;
    releaseScreenWakeLock();
    setControls();
  }

  function stopMediaStream() {
    if (!state.stream) return;
    state.stream.getTracks().forEach(function (track) { track.stop(); });
    state.stream = null;
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') {
      setState('transcribing');
      state.recorder.stop();
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      if (state.browserSttSupported) {
        state.sttEngine = 'browser';
        startBrowserRecognition();
        return;
      }
      markMicUnavailable('Le micro vocal n’est pas disponible ici. Écris ton mot pour continuer.');
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_e) {
      markMicUnavailable("J'ai besoin de la permission du micro. Demande à un adulte, ou écris ton mot.");
      return;
    }
    state.chunks = [];
    var opts = MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : undefined;
    state.recorder = new MediaRecorder(state.stream, opts);
    state.recorder.ondataavailable = function (event) {
      if (event.data && event.data.size) state.chunks.push(event.data);
    };
    state.recorder.onstop = onRecordingStopped;
    state.recorder.start();
    state.recording = true;
    setState('listening');
  }

  async function onRecordingStopped() {
    state.recording = false;
    releaseScreenWakeLock();
    stopMediaStream();
    var blob = new Blob(state.chunks, { type: (state.recorder && state.recorder.mimeType) || 'audio/webm' });
    state.chunks = [];
    if (!blob.size) {
      showReply("Je n'ai rien entendu. On réessaie ?");
      setRetry(startListening);
      setState('retryable_error');
      return;
    }
    setState('transcribing');
    var form = new FormData();
    form.append('audio', blob, 'lecture.webm');
    form.append('language', 'fr');
    try {
      var res = await fetch('/api/voix/transcribe', { method: 'POST', credentials: 'include', body: form });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok || body.status === 'error') throw new Error(body.message || 'stt');
      var payload = body.data || body;
      var transcript = payload.text || payload.transcript || '';
      if (!transcript) {
        showReply("Je n'ai rien entendu. On réessaie ?");
        setRetry(startListening);
        setState('retryable_error');
        return;
      }
      await ask(transcript, 'voice');
    } catch (err) {
      if (state.browserSttSupported && state.sttEngine === 'voix') {
        state.sttEngine = 'browser';
        showReply('La voix locale dort. Appuie sur réessaie et je vais écouter autrement.');
      } else {
        showReply('La voix dort un peu. Tu peux réessayer ou écrire ton mot.');
      }
      setHint('Ton texte reste toujours disponible en bas.', 'error');
      setRetry(startListening);
      setState('retryable_error');
      if (window.console) console.error('[lecture] stt failed', err);
    }
  }

  function bind() {
    $('micBtn').addEventListener('click', function () {
      if (state.recording) stopListening();
      else startListening();
    });
    $('replayBtn').addEventListener('click', function () {
      if ($('lectureRoot').dataset.state === 'speaking') cancelSpeech(true);
      else if (state.lastReply) speak(state.lastReply);
    });
    $('retryBtn').addEventListener('click', function () {
      var action = state.retryAction;
      clearRetry();
      if (action) action();
    });
    var form = $('textForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var input = $('textInput');
        var value = input.value;
        input.value = '';
        ask(value, 'text').finally(focusTextInput);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    if (window.isSecureContext === false) {
      markMicUnavailable('Le micro a besoin d’une connexion sécurisée. Écris ton mot ici pour continuer.');
    } else {
      setState('ready');
      chooseSttEngine();
    }
    requestScreenWakeLock();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') requestScreenWakeLock();
      else {
        cancelSpeech(true);
        releaseScreenWakeLock();
      }
    });
    window.addEventListener('beforeunload', function () {
      cancelSpeech(false);
      stopMediaStream();
      releaseScreenWakeLock();
    });
  });
})();

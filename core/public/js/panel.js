(function () {
  'use strict';

  const DEVICE_ID = 'surface-pro-3-main-house';
  const STT_LANGUAGE = 'fr';
  const state = {
    status: null,
    conversationId: null,
    recorder: null,
    stream: null,
    chunks: [],
    recording: false,
    discardRecording: false,
    turnActive: false,
    turnController: null,
    audioQueue: null,
    voixReady: false,
    nestorReady: false,
    captureSupported: false,
    micPermission: 'unknown',
    micEnabled: true,
    speakReplies: true
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function apiJson(url, options) {
    const response = await fetch(url, {
      credentials: 'include',
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status === 'error') {
      throw new Error(body.message || `HTTP ${response.status}`);
    }
    return body.data || body;
  }

  function updateClock() {
    const now = new Date();
    $('panelTime').textContent = now.toLocaleTimeString('fr-CA', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    $('panelDate').textContent = now.toLocaleDateString('fr-CA', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  }

  function setDot(el, status) {
    if (!el) return;
    el.className = 'panel-dot ' + (
      status === 'ok' ? 'panel-dot-ok' :
      status === 'live' ? 'panel-dot-live' :
      status === 'degraded' || status === 'warn' ? 'panel-dot-warn' :
      status === 'down' ? 'panel-dot-down' :
      'panel-dot-muted'
    );
  }

  function statusLabel(status) {
    if (status === 'ok' || status === 'available') return 'prêt';
    if (status === 'degraded') return 'dégradé';
    if (status === 'down' || status === 'unavailable') return 'hors ligne';
    if (status === 'disabled') return 'désactivé';
    return status || 'inconnu';
  }

  function micStatusLabel() {
    if (!state.micEnabled) return 'coupé';
    if (!window.isSecureContext) return 'HTTPS requis';
    if (!state.captureSupported) return 'non pris en charge';
    if (state.micPermission === 'denied') return 'bloqué';
    if (state.micPermission === 'granted') return 'prêt';
    if (state.micPermission === 'prompt') return 'autorisation requise';
    return 'à vérifier';
  }

  function renderVoiceReadiness() {
    const dot = $('panelMicDot');
    const label = $('panelMicStatus');
    let status = 'muted';
    let message = 'Micro : vérification…';

    if (state.recording) {
      status = 'live';
      message = 'Micro : écoute active — toucher Terminer quand tu as fini.';
    } else if (!state.micEnabled) {
      status = 'muted';
      message = 'Micro coupé. Réactive-le avant de parler.';
    } else if (!window.isSecureContext) {
      status = 'down';
      message = 'Micro indisponible : ouvre le Panel en HTTPS.';
    } else if (!state.captureSupported) {
      status = 'down';
      message = 'Micro indisponible dans ce navigateur.';
    } else if (state.micPermission === 'denied') {
      status = 'down';
      message = 'Micro bloqué : autorise-le dans les réglages du site.';
    } else if (!state.voixReady) {
      status = 'down';
      message = 'Voix indisponible : VoiX est hors ligne.';
    } else if (!state.nestorReady) {
      status = 'down';
      message = 'Nestor vocal est indisponible.';
    } else if (state.micPermission === 'granted') {
      status = 'ok';
      message = 'Micro : prêt. Il ne s’ouvre que lorsque tu touches Parler.';
    } else {
      status = 'warn';
      message = 'Micro : autorisation demandée au premier appui.';
    }

    setDot(dot, status);
    label.textContent = message;
    const canTalk = state.captureSupported
      && state.micEnabled
      && state.micPermission !== 'denied'
      && state.voixReady
      && state.nestorReady;
    $('panelTalkBtn').disabled = !canTalk;
    $('panelMicToggle').disabled = !state.captureSupported;
    $('panelMicToggle').setAttribute('aria-pressed', state.micEnabled ? 'true' : 'false');
    $('panelMicToggleLabel').textContent = state.captureSupported
      ? (state.micEnabled ? 'Micro actif' : 'Micro coupé')
      : 'Micro indisponible';
    $('panelSpeakToggle').setAttribute('aria-pressed', state.speakReplies ? 'true' : 'false');
    $('panelSpeakLabel').textContent = state.speakReplies ? 'Son actif' : 'Son coupé';
  }

  function renderServices(portal) {
    const root = $('panelServices');
    const services = Array.isArray(portal?.services) ? portal.services : [];
    if (!services.length) {
      root.innerHTML = '<div class="panel-home-disabled">Aucun état de service disponible.</div>';
      return;
    }
    root.innerHTML = services.map((service) => `
      <div class="panel-service-card">
        <span class="panel-dot ${service.status === 'ok' ? 'panel-dot-ok' : service.status === 'degraded' ? 'panel-dot-warn' : 'panel-dot-down'}"></span>
        <div>
          <div class="panel-card-title">${escapeHtml(service.label || service.id)}</div>
          <div class="panel-card-meta">${escapeHtml(statusLabel(service.status))}${Number.isFinite(service.latency_ms) ? ` · ${service.latency_ms} ms` : ''}</div>
        </div>
      </div>
    `).join('');
  }

  function renderHome(home) {
    const root = $('panelHomeEntities');
    const status = $('panelHomeStatus');
    if (!home || home.enabled === false) {
      status.textContent = 'désactivé';
      root.innerHTML = '<div class="panel-home-disabled">Home Assistant n’est pas encore configuré.</div>';
      return;
    }
    status.textContent = statusLabel(home.status);
    const entities = Array.isArray(home.entities) ? home.entities : [];
    if (!entities.length) {
      root.innerHTML = '<div class="panel-home-disabled">Aucune entité autorisée n’est disponible.</div>';
      return;
    }
    root.innerHTML = entities.map((entity) => {
      const value = `${entity.state || 'inconnu'}${entity.unit ? ` ${entity.unit}` : ''}`;
      return `
        <div class="panel-home-card">
          <strong>${escapeHtml(entity.name || entity.entity_id)}</strong>
          <div class="panel-card-meta">${escapeHtml(entity.entity_id || '')}</div>
          <div class="panel-home-value">${escapeHtml(value)}</div>
        </div>
      `;
    }).join('');
  }

  function renderDetails(data) {
    const rows = [
      ['Nestor', state.nestorReady ? 'prêt · routage Auto' : 'indisponible'],
      ['VoiX', statusLabel(data.voix?.status)],
      ['Micro', micStatusLabel()],
      ['Connexion', window.isSecureContext ? 'HTTPS sécurisé' : 'non sécurisée'],
      ['Lecture', statusLabel(data.reader?.status)],
      ['Maison', statusLabel(data.home?.status)],
      ['Panel', data.heartbeats?.length ? 'signal actif' : 'signal local']
    ];
    $('panelDetailList').innerHTML = rows.map(([label, value]) => `
      <div class="panel-detail-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join('');
    $('panelDeviceStatus').textContent = data.heartbeats?.length ? 'en ligne' : 'local';
  }

  function renderAlerts(data) {
    const alerts = [];
    const services = Array.isArray(data.portal?.services) ? data.portal.services : [];
    const ecosystem = data.portal?.summary?.ecosystem || {};
    const ecosystemIssues = Array.isArray(ecosystem.issues) ? ecosystem.issues : [];

    services
      .filter((service) => service.status !== 'ok')
      .forEach((service) => alerts.push({
        severity: service.status === 'down' ? 'down' : 'warn',
        title: service.label || service.id || 'Service',
        detail: statusLabel(service.status),
        href: '/nerve-center',
        action: 'Diagnostiquer'
      }));
    ecosystemIssues.forEach((issue) => alerts.push({
      severity: ecosystem.status === 'down' ? 'down' : 'warn',
      title: 'Écosystème',
      detail: issue,
      href: '/nerve-center',
      action: 'Diagnostiquer'
    }));
    if (data.voix?.status !== 'ok') {
      alerts.push({
        severity: 'down',
        title: 'VoiX',
        detail: data.voix?.error || 'Service vocal hors ligne',
        href: '/voice',
        action: 'Vérifier Voix'
      });
    }
    if (data.reader?.status !== 'ok') {
      alerts.push({
        severity: 'down',
        title: 'Lecture',
        detail: data.reader?.error || 'Lecteur indisponible',
        href: '/lecture',
        action: 'Ouvrir Lecture'
      });
    }
    if (data.home?.enabled && data.home.status !== 'ok') {
      alerts.push({ severity: data.home.status === 'down' ? 'down' : 'warn', title: 'Maison', detail: statusLabel(data.home.status) });
    }

    const uniqueAlerts = alerts.filter((alert, index, list) => (
      list.findIndex((candidate) => candidate.title === alert.title && candidate.detail === alert.detail) === index
    )).slice(0, 5);
    const root = $('panelAlerts');
    if (!uniqueAlerts.length) {
      root.innerHTML = `
        <div class="panel-alert panel-alert-ok">
          <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
          <div><strong>Tout va bien</strong><span>Aucune action familiale requise.</span></div>
        </div>
      `;
      return;
    }
    root.innerHTML = uniqueAlerts.map((alert) => `
      <div class="panel-alert panel-alert-${alert.severity}">
        <i class="fa-solid ${alert.severity === 'down' ? 'fa-circle-xmark' : 'fa-triangle-exclamation'}" aria-hidden="true"></i>
        <div>
          <strong>${escapeHtml(alert.title)}</strong><span>${escapeHtml(alert.detail)}</span>
          ${alert.href ? `<a href="${escapeHtml(alert.href)}">${escapeHtml(alert.action)}</a>` : ''}
        </div>
      </div>
    `).join('');
  }

  function personalStatusLabel(status) {
    if (status === 'queued') return 'à faire';
    if (status === 'in_progress') return 'en cours';
    if (status === 'review') return 'à confirmer';
    if (status === 'blocked') return 'bloqué';
    return statusLabel(status);
  }

  function formatPersonalDue(task) {
    if (!task.dueAt) return personalStatusLabel(task.status);
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) return personalStatusLabel(task.status);
    const date = due.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric' });
    if (task.overdue) return `en retard · ${date}`;
    if (task.dueToday) return `aujourd’hui · ${date}`;
    return `pour le ${date}`;
  }

  function renderPersonalTasks(data) {
    const root = $('panelPersonalTasks');
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    $('panelPersonalCount').textContent = `${tasks.length} ouverte${tasks.length === 1 ? '' : 's'}`;
    if (!tasks.length) {
      root.innerHTML = '<div class="panel-personal-empty">La liste est vide.</div>';
      return;
    }
    root.innerHTML = tasks.map((task) => {
      const note = String(task.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return `
        <article class="panel-personal-task">
          <div class="panel-personal-copy">
            <div class="panel-personal-title">${escapeHtml(task.title)}</div>
            <div class="panel-personal-meta${task.overdue ? ' is-overdue' : ''}">${escapeHtml(formatPersonalDue(task))}</div>
            ${note ? `<div class="panel-personal-note">${escapeHtml(note)}</div>` : ''}
          </div>
          <button class="panel-personal-complete" type="button"
            data-complete-personal="${escapeHtml(task.id)}"
            aria-label="Terminer ${escapeHtml(task.title)}">Fait</button>
        </article>
      `;
    }).join('');
  }

  async function refreshPersonalTasks() {
    try {
      renderPersonalTasks(await apiJson('/api/secretary/tasks?limit=6', { cache: 'no-store' }));
    } catch (err) {
      $('panelPersonalCount').textContent = 'indisponible';
      $('panelPersonalTasks').innerHTML = `<div class="panel-personal-empty">Liste indisponible : ${escapeHtml(err.message)}</div>`;
    }
  }

  function resetPersonalConfirmation(button) {
    if (!button?.isConnected || button.disabled) return;
    delete button.dataset.confirming;
    button.textContent = 'Fait';
  }

  async function completePersonalTaskFromPanel(button) {
    const ref = button.dataset.completePersonal;
    if (!ref) return;
    if (button.dataset.confirming !== 'true') {
      $('panelPersonalTasks').querySelectorAll('[data-confirming="true"]').forEach(resetPersonalConfirmation);
      button.dataset.confirming = 'true';
      button.textContent = 'Confirmer';
      window.setTimeout(() => resetPersonalConfirmation(button), 5000);
      return;
    }
    button.disabled = true;
    button.textContent = '…';
    try {
      const result = await apiJson('/api/secretary/tasks/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, by: 'surface-panel', note: 'Completed from the Surface Panel.' })
      });
      appendMessage('system', `Tâche terminée : ${result.task?.title || ref}.`);
      await refreshPersonalTasks();
    } catch (err) {
      appendMessage('error', `Liste personnelle : ${err.message}`);
      button.disabled = false;
      resetPersonalConfirmation(button);
    }
  }

  function renderStatus(data) {
    state.status = data;
    const summary = data.portal?.summary || {};
    const global = summary.status || (summary.down > 0 ? 'down' : summary.degraded > 0 ? 'degraded' : 'ok');
    setDot($('panelSystemDot'), global);
    const ecosystem = summary.ecosystem || {};
    const ecosystemIssues = Array.isArray(ecosystem.issues) ? ecosystem.issues : [];
    $('panelSystemSummary').textContent = `${summary.healthy || 0}/${summary.total || 0} services prêts`
      + (summary.degraded ? ` · ${summary.degraded} dégradé(s)` : '')
      + (summary.down ? ` · ${summary.down} hors ligne` : '')
      + (ecosystem.status === 'degraded' ? ' · écosystème dégradé' : '')
      + (ecosystem.status === 'down' ? ' · écosystème hors ligne' : '')
      + (ecosystemIssues.length ? ` · ${ecosystemIssues[0]}` : '');
    $('panelUpdated').textContent = new Date(data.generatedAt || Date.now()).toLocaleTimeString('fr-CA');
    state.voixReady = data.voix?.status === 'ok';
    if (!state.recording && !state.turnActive && !$('panelVoiceLine').dataset.touched) {
      $('panelVoiceLine').textContent = state.voixReady ? 'Prêt.' : 'VoiX est hors ligne.';
    }
    renderServices(data.portal);
    renderHome(data.home);
    renderDetails(data);
    renderAlerts(data);
    renderVoiceReadiness();
  }

  async function refreshStatus() {
    try {
      renderStatus(await apiJson('/api/panel/status', { cache: 'no-store' }));
    } catch (err) {
      state.voixReady = false;
      setDot($('panelSystemDot'), 'down');
      $('panelSystemSummary').textContent = `État du Panel indisponible : ${err.message}`;
      renderVoiceReadiness();
    }
  }

  async function sendHeartbeat() {
    try {
      await apiJson('/api/panel/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          label: 'Surface Pro 3 · Maison',
          userAgent: navigator.userAgent,
          secureContext: window.isSecureContext,
          micPermission: state.micPermission,
          micEnabled: state.micEnabled,
          voiceEnabled: state.speakReplies
        })
      });
    } catch (_err) {
      // Best effort. The visible status retries independently.
    }
  }

  function appendMessage(role, text) {
    const root = $('panelTranscript');
    const node = document.createElement('div');
    node.className = `panel-message panel-message-${role}`;
    node.textContent = text;
    root.appendChild(node);
    while (root.children.length > 12) root.removeChild(root.firstElementChild);
    root.scrollTop = root.scrollHeight;
    return node;
  }

  function setTalkLabel(label) {
    $('panelTalkLabel').textContent = label;
  }

  function stopAudioOutput(reason) {
    state.audioQueue?.cancel(reason || 'cancelled');
    state.audioQueue = null;
    const audio = $('panelAudio');
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  function cancelActiveOutput(reason) {
    state.turnController?.abort(reason || 'cancelled');
    state.turnController = null;
    stopAudioOutput(reason);
  }

  function createTraceId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `surface-panel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function firstText() {
    return [...arguments].find((value) => typeof value === 'string' && value.trim()) || null;
  }

  function voiceRuntimeDetails(sttModel) {
    const health = state.status?.voix?.health || {};
    return {
      stt: {
        provider: 'voix',
        model: firstText(sttModel, health.stt?.model, health.models?.stt, health.config?.stt_model)
      },
      tts: {
        provider: 'voix',
        model: firstText(health.tts?.model, health.models?.tts, health.config?.tts_model),
        voice: firstText(health.tts?.voice, health.config?.tts_voice)
      }
    };
  }

  async function publishVoiceTrace(payload) {
    try {
      await fetch('/api/analytics/voice/trace', {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (_error) {
      // Telemetry is best-effort and must never break or visually pollute a turn.
    }
  }

  function publishTurnTraceAfterAudio(payload, queue, audioEvents, startedAt) {
    void (async () => {
      if (queue) await queue.waitForIdle();
      const audio = window.NestorVoiceStream.summarizeAudioEvents(audioEvents);
      const audioFailure = audioEvents.find((event) => event.type === 'error' || event.type === 'overflow');
      const audioCancelled = audioEvents.some((event) => event.type === 'cancelled');
      const status = audioFailure
        ? 'error'
        : (audioCancelled && payload.status === 'success' ? 'cancelled' : payload.status);
      await publishVoiceTrace({
        ...payload,
        status,
        errorCode: payload.errorCode || audioFailure?.code || (audioFailure ? 'VOICE_AUDIO_ERROR' : undefined),
        sentenceCount: audio.sentenceCount,
        timings: {
          ...payload.timings,
          firstAudioMs: audio.firstAudioMs,
          ttsSynthesisMs: audio.ttsSynthesisMs,
          ttsPlaybackMs: audio.ttsPlaybackMs,
          ttsRtf: audio.ttsRtf,
          interSentenceGapMs: audio.interSentenceGapMs,
          totalTurnMs: performance.now() - startedAt
        }
      });
    })();
  }

  function createAudioQueue(startedAt, audioEvents) {
    let queue;
    queue = new window.NestorVoiceStream.SentenceAudioQueue({
      audio: $('panelAudio'),
      startedAt,
      maxPendingSentences: 8,
      maxQueuedChars: 1600,
      synthesize: async (sentence, { signal } = {}) => {
        const response = await fetch('/api/voix/synthesize', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence }),
          signal
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || `TTS HTTP ${response.status}`);
        }
        return response.blob();
      },
      onError: (error) => appendMessage('error', `Lecture audio : ${error.message}`),
      onIdle: () => {
        if (state.audioQueue === queue) state.audioQueue = null;
      },
      onEvent: (event) => audioEvents.push(event)
    });
    return queue;
  }

  async function runNestorTurn(text, voiceContext = {}) {
    const content = String(text || '').trim();
    if (!content) return;
    cancelActiveOutput('new-turn');
    $('panelVoiceLine').dataset.touched = 'true';
    $('panelVoiceLine').textContent = 'Nestor réfléchit…';
    appendMessage('user', content);
    const assistantNode = appendMessage('assistant', '…');
    const startedAt = Number.isFinite(voiceContext.startedAt) ? voiceContext.startedAt : performance.now();
    const traceId = voiceContext.traceId || createTraceId();
    const controller = new AbortController();
    state.turnController = controller;
    state.turnActive = true;
    setTalkLabel('Interrompre');
    let streamedReply = '';
    let turnMeta = null;
    const audioEvents = [];
    const queue = state.speakReplies ? createAudioQueue(startedAt, audioEvents) : null;
    state.audioQueue = queue;

    try {
      const completed = await window.NestorVoiceStream.streamNestorTurn({
        text: content,
        surface: 'surface-panel',
        lane: 'auto',
        traceId,
        conversationId: state.conversationId || undefined
      }, {
        meta: (data) => {
          turnMeta = data;
          state.conversationId = data?.conversationId || state.conversationId;
        },
        delta: (data) => {
          streamedReply += data?.delta || '';
          assistantNode.textContent = streamedReply || '…';
          $('panelVoiceLine').textContent = streamedReply || 'Nestor réfléchit…';
        },
        sentence: (data) => {
          if (state.speakReplies) queue?.enqueue(data?.text);
        }
      }, { signal: controller.signal });
      state.conversationId = completed.conversationId || state.conversationId;
      const reply = completed.reply || streamedReply || '(réponse vide)';
      assistantNode.textContent = reply;
      $('panelVoiceLine').textContent = reply;
      publishTurnTraceAfterAudio({
        traceId,
        status: 'success',
        inputMode: 'voice',
        surface: 'surface-panel',
        requestedLane: 'auto',
        lane: completed.lane || turnMeta?.lane,
        brain: completed.brain,
        model: completed.model,
        host: completed.host,
        fallbackUsed: Boolean(completed.fallback),
        fallbackReason: completed.fallback?.reason,
        ...voiceRuntimeDetails(voiceContext.sttModel),
        timings: {
          sttMs: voiceContext.sttMs,
          firstTokenMs: completed.timings?.firstTokenMs,
          firstPhraseMs: completed.timings?.firstSentenceMs,
          brainMs: completed.timings?.brainMs
        }
      }, queue, audioEvents, startedAt);
    } catch (err) {
      const cancelled = controller.signal.aborted;
      if (cancelled) {
        assistantNode.className = 'panel-message panel-message-system';
        assistantNode.textContent = streamedReply || 'Réponse interrompue.';
        $('panelVoiceLine').textContent = 'Prêt.';
      } else {
        assistantNode.className = 'panel-message panel-message-error';
        assistantNode.textContent = err.message;
        $('panelVoiceLine').textContent = `Erreur Nestor : ${err.message}`;
        queue?.cancel('turn-error');
      }
      publishTurnTraceAfterAudio({
        traceId,
        status: cancelled ? 'cancelled' : 'error',
        inputMode: 'voice',
        surface: 'surface-panel',
        requestedLane: 'auto',
        lane: turnMeta?.lane,
        fallbackUsed: false,
        errorCode: err.code || (cancelled ? 'VOICE_TURN_CANCELLED' : 'VOICE_TURN_ERROR'),
        ...voiceRuntimeDetails(voiceContext.sttModel),
        timings: { sttMs: voiceContext.sttMs }
      }, queue, audioEvents, startedAt);
    } finally {
      if (state.turnController === controller) state.turnController = null;
      state.turnActive = false;
      if (!state.recording) setTalkLabel('Parler');
      renderVoiceReadiness();
    }
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  }

  function describeCaptureError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      state.micPermission = 'denied';
      return 'Micro bloqué. Autorise le micro pour ce site dans le navigateur.';
    }
    if (error?.name === 'NotFoundError') return 'Aucun micro n’est détecté.';
    return error?.message || 'Impossible d’ouvrir le micro.';
  }

  async function startRecording() {
    cancelActiveOutput('barge-in');
    if (!state.micEnabled) {
      appendMessage('system', 'Le micro est coupé. Réactive-le avant de parler.');
      return;
    }
    if (!state.voixReady) {
      appendMessage('system', 'VoiX est hors ligne.');
      return;
    }
    if (!state.captureSupported) {
      appendMessage('error', window.isSecureContext
        ? 'L’enregistrement n’est pas pris en charge dans ce navigateur.'
        : 'Le micro exige une connexion HTTPS.');
      return;
    }

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.micPermission = 'granted';
    } catch (error) {
      const message = describeCaptureError(error);
      appendMessage('error', message);
      $('panelVoiceLine').textContent = message;
      renderVoiceReadiness();
      if (state.status) renderDetails(state.status);
      return;
    }

    if (!state.micEnabled) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
      renderVoiceReadiness();
      return;
    }

    state.chunks = [];
    state.discardRecording = false;
    const recorderOptions = MediaRecorder.isTypeSupported('audio/webm')
      ? { mimeType: 'audio/webm' }
      : undefined;
    state.recorder = new MediaRecorder(state.stream, recorderOptions);
    state.recorder.ondataavailable = (event) => {
      if (event.data?.size) state.chunks.push(event.data);
    };
    state.recorder.onstop = onRecordingStopped;
    state.recorder.start();
    state.recording = true;
    $('housePanelRoot').classList.add('is-recording');
    $('panelTalkBtn').setAttribute('aria-pressed', 'true');
    setTalkLabel('Terminer');
    $('panelVoiceLine').dataset.touched = 'true';
    $('panelVoiceLine').textContent = 'Je t’écoute…';
    renderVoiceReadiness();
    if (state.status) renderDetails(state.status);
  }

  async function onRecordingStopped() {
    const mimeType = state.recorder?.mimeType || 'audio/webm';
    const discardRecording = state.discardRecording;
    state.discardRecording = false;
    state.recording = false;
    $('housePanelRoot').classList.remove('is-recording');
    $('panelTalkBtn').setAttribute('aria-pressed', 'false');
    setTalkLabel('Parler');
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    const blob = new Blob(state.chunks, { type: mimeType });
    state.chunks = [];
    state.recorder = null;
    renderVoiceReadiness();
    if (discardRecording) {
      appendMessage('system', 'Micro coupé. L’enregistrement a été effacé.');
      $('panelVoiceLine').textContent = 'Prêt.';
      return;
    }
    if (!blob.size) {
      appendMessage('system', 'Aucun son capturé.');
      $('panelVoiceLine').textContent = 'Prêt.';
      return;
    }
    const form = new FormData();
    form.append('audio', blob, 'surface-panel.webm');
    form.append('language', STT_LANGUAGE);
    const traceId = createTraceId();
    const sttStartedAt = performance.now();
    try {
      $('panelVoiceLine').textContent = 'Transcription…';
      const response = await fetch('/api/voix/transcribe', {
        method: 'POST',
        credentials: 'include',
        body: form
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === 'error') throw new Error(body.message || `STT HTTP ${response.status}`);
      const payload = body.data || body;
      const transcript = payload.text || payload.transcript || '';
      const sttMs = performance.now() - sttStartedAt;
      if (!transcript) {
        appendMessage('system', 'Je n’ai rien compris. Réessaie en parlant près du micro.');
        $('panelVoiceLine').textContent = 'Prêt.';
        await publishVoiceTrace({
          traceId,
          status: 'error',
          inputMode: 'voice',
          surface: 'surface-panel',
          errorCode: 'STT_EMPTY',
          ...voiceRuntimeDetails(payload.model),
          timings: { sttMs, totalTurnMs: sttMs }
        });
        return;
      }
      await runNestorTurn(transcript, {
        traceId,
        startedAt: sttStartedAt,
        sttMs,
        sttModel: payload.model
      });
    } catch (err) {
      appendMessage('error', err.message);
      $('panelVoiceLine').textContent = `Erreur voix : ${err.message}`;
      const sttMs = performance.now() - sttStartedAt;
      await publishVoiceTrace({
        traceId,
        status: 'error',
        inputMode: 'voice',
        surface: 'surface-panel',
        errorCode: err.code || 'STT_ERROR',
        ...voiceRuntimeDetails(),
        timings: { sttMs, totalTurnMs: sttMs }
      });
    }
  }

  async function refreshMicrophonePermission() {
    state.captureSupported = Boolean(
      window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder
    );
    if (!state.captureSupported) {
      renderVoiceReadiness();
      return;
    }
    try {
      const permission = await navigator.permissions?.query({ name: 'microphone' });
      if (permission?.state) state.micPermission = permission.state;
      permission?.addEventListener?.('change', () => {
        state.micPermission = permission.state;
        renderVoiceReadiness();
        if (state.status) {
          renderDetails(state.status);
          renderAlerts(state.status);
        }
        sendHeartbeat();
      });
    } catch (_err) {
      state.micPermission = 'prompt';
    }
    renderVoiceReadiness();
  }

  function bindEvents() {
    $('panelRefreshBtn').addEventListener('click', () => {
      Promise.all([sendHeartbeat(), refreshStatus(), refreshPersonalTasks(), refreshMicrophonePermission()]);
    });
    $('panelPersonalTasks').addEventListener('click', (event) => {
      const button = event.target.closest('[data-complete-personal]');
      if (button) completePersonalTaskFromPanel(button);
    });
    $('panelTalkBtn').addEventListener('click', () => {
      if (state.recording) {
        stopRecording();
        return;
      }
      startRecording().catch((err) => {
        appendMessage('error', err.message);
        $('panelVoiceLine').textContent = err.message;
      });
    });
    $('panelMicToggle').addEventListener('click', () => {
      state.micEnabled = !state.micEnabled;
      if (!state.micEnabled && state.recording) {
        state.discardRecording = true;
        stopRecording();
      }
      renderVoiceReadiness();
      if (state.status) renderDetails(state.status);
      sendHeartbeat();
    });
    $('panelSpeakToggle').addEventListener('click', () => {
      state.speakReplies = !state.speakReplies;
      if (!state.speakReplies) stopAudioOutput('voice-muted');
      renderVoiceReadiness();
      sendHeartbeat();
    });
    window.addEventListener('online', () => Promise.all([sendHeartbeat(), refreshStatus(), refreshPersonalTasks()]));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) Promise.all([
        sendHeartbeat(),
        refreshStatus(),
        refreshPersonalTasks(),
        refreshMicrophonePermission()
      ]);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    state.nestorReady = Boolean(window.NestorVoiceStream);
    bindEvents();
    updateClock();
    refreshMicrophonePermission();
    sendHeartbeat();
    refreshStatus();
    refreshPersonalTasks();
    setInterval(updateClock, 1000);
    setInterval(sendHeartbeat, 30000);
    setInterval(refreshStatus, 15000);
    setInterval(refreshPersonalTasks, 30000);
  });
}());

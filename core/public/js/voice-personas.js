(function () {
  'use strict';

  const state = {
    packs: [],
    packDetails: null,
    session: null,
    history: [],
    mediaRecorder: null,
    mediaStream: null,
    chunks: [],
    recording: false,
    speakReplies: false,
    voixAvailable: false
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

  function textValue(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    return text || fallback || '';
  }

  function setPill(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('vp-pill-muted', 'vp-pill-warn', 'vp-pill-danger');
    if (kind === 'muted') el.classList.add('vp-pill-muted');
    if (kind === 'warn') el.classList.add('vp-pill-warn');
    if (kind === 'danger') el.classList.add('vp-pill-danger');
  }

  async function apiJson(url, options) {
    const resp = await fetch(url, options);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || body.status === 'error') {
      throw new Error(body.message || body.error || `HTTP ${resp.status}`);
    }
    return body.data || body;
  }

  function selectedPackId() {
    return $('vpPackSelect').value || 'personal_operator';
  }

  function selectedModeId() {
    return $('vpModeSelect').value || '';
  }

  function selectedScopeId() {
    return textValue($('vpScopeInput').value, 'default');
  }

  function selectedPackSummary() {
    return state.packs.find((pack) => pack.id === selectedPackId()) || state.packs[0] || null;
  }

  function currentMode() {
    const pack = selectedPackSummary();
    return (pack && pack.modes || []).find((mode) => mode.id === selectedModeId()) || null;
  }

  function renderModes(pack) {
    const select = $('vpModeSelect');
    select.innerHTML = '';
    const modes = pack && Array.isArray(pack.modes) ? pack.modes : [];
    for (const mode of modes) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label || mode.id;
      select.appendChild(option);
    }
    select.value = pack && pack.defaultMode ? pack.defaultMode : (modes[0] && modes[0].id) || '';
  }

  function renderPackDetails(details) {
    const el = $('vpPackDetails');
    const pack = details && details.pack ? details.pack : selectedPackSummary();
    if (!pack) {
      el.innerHTML = '';
      return;
    }
    const mode = currentMode();
    const rows = [
      ['Pack', pack.name || pack.id],
      ['Mode', mode ? (mode.label || mode.id) : pack.defaultMode],
      ['Scope', selectedScopeId()],
      ['Task', pack.inference && pack.inference.taskType ? pack.inference.taskType : 'voice_persona_chat'],
      ['Memory', pack.memory && pack.memory.enabled === false ? 'off' : 'on'],
      ['Safety', pack.safety && pack.safety.mode ? pack.safety.mode : 'standard'],
      ['Prompt', pack.prompt && pack.prompt.source ? pack.prompt.source : pack.promptConfigName || 'manifest']
    ];
    el.innerHTML = rows
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '-')}</dd>`)
      .join('');
  }

  function clearTranscript() {
    state.history = [];
    $('vpTranscript').innerHTML = '<div class="vp-empty">Session ready.</div>';
  }

  function resetSessionState(message) {
    state.session = null;
    state.history = [];
    renderTrace(null);
    $('vpTranscript').innerHTML = `<div class="vp-empty">${escapeHtml(message || 'Send a turn or start a session.')}</div>`;
    setPill('vpSessionStatus', 'No session', 'muted');
  }

  function appendMessage(role, text, meta) {
    const transcript = $('vpTranscript');
    const empty = transcript.querySelector('.vp-empty');
    if (empty) empty.remove();
    const node = document.createElement('div');
    node.className = `vp-message vp-message-${role}`;
    node.innerHTML = [
      `<div class="vp-message-meta">${escapeHtml(meta || role)}</div>`,
      `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
    ].join('');
    transcript.appendChild(node);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function rememberTurn(role, text) {
    if (role !== 'user' && role !== 'assistant') return;
    state.history.push({ role, content: text });
    if (state.history.length > 8) state.history = state.history.slice(-8);
  }

  function renderTrace(turn) {
    const trace = $('vpTraceBox');
    if (!turn) {
      trace.innerHTML = '<div class="vp-trace-row"><span>Status</span><strong>-</strong></div>';
      return;
    }
    const rows = [
      ['Trace', turn.traceId || '-'],
      ['Model', turn.model && turn.model.model ? turn.model.model : 'router-selected'],
      ['Host', turn.model && (turn.model.hostKey || turn.model.host) ? (turn.model.hostKey || turn.model.host) : '-'],
      ['Lane', turn.routing && turn.routing.lane ? turn.routing.lane : '-'],
      ['Task', turn.routing && turn.routing.taskType ? turn.routing.taskType : '-'],
      ['Total', turn.timings && turn.timings.totalMs ? `${turn.timings.totalMs} ms` : '-']
    ];
    trace.innerHTML = rows.map(([label, value]) => (
      `<div class="vp-trace-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    )).join('');
  }

  function memoryText(item) {
    if (!item || typeof item !== 'object') return '';
    return item.text || item.content || (item.chunk && item.chunk.text) || (item.payload && item.payload.text) || '';
  }

  function renderMemoryFromTurn(turn) {
    const el = $('vpMemoryStatus');
    if (!turn || !turn.memory) {
      el.textContent = '';
      return;
    }
    if (turn.memory.warning) {
      el.textContent = `Memory unavailable: ${turn.memory.warning}`;
      renderMemoryFacts([], 'Memory unavailable for the last turn.');
      return;
    }
    const chunks = Array.isArray(turn.memory.results) ? turn.memory.results : [];
    if (!chunks.length) {
      el.textContent = 'No scoped memory matched the last turn.';
      renderMemoryFacts([], 'No memory matched the last turn.');
      return;
    }
    el.textContent = `Matched ${chunks.length} scoped memory chunk${chunks.length === 1 ? '' : 's'}.`;
    renderMemoryFacts(chunks, 'No memory matched the last turn.');
  }

  function renderMemoryFacts(results, emptyText) {
    const root = $('vpMemoryFacts');
    if (!root) return;
    const rows = Array.isArray(results) ? results : [];
    if (!rows.length) {
      root.innerHTML = `<div class="vp-mini-status">${escapeHtml(emptyText || 'Search scoped memory facts.')}</div>`;
      return;
    }
    root.innerHTML = rows.slice(0, 6).map((item) => {
      const text = memoryText(item) || item.documentId || 'Memory fact';
      const score = Number.isFinite(Number(item.score)) ? ` · ${(Number(item.score) * 100).toFixed(0)}%` : '';
      return `<div class="vp-audit-item">${escapeHtml(String(text).slice(0, 320))}<div class="vp-audit-meta">${escapeHtml(item.documentId || item.source || 'memory')}${score}</div></div>`;
    }).join('');
  }

  async function searchMemoryFacts(query) {
    const q = textValue(query, '');
    if (!q) {
      $('vpMemoryStatus').textContent = 'Enter a memory search.';
      renderMemoryFacts([], 'Search scoped memory facts.');
      return;
    }
    try {
      const data = await apiJson('/api/voice-personas/memory/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packId: selectedPackId(),
          scopeId: selectedScopeId(),
          query: q,
          topK: 6
        })
      });
      const results = data.memory && Array.isArray(data.memory.results) ? data.memory.results : [];
      const warning = data.memory && data.memory.warning ? data.memory.warning : '';
      renderMemoryFacts(results, 'No scoped memory facts found.');
      $('vpMemoryStatus').textContent = warning || (results.length ? `Found ${results.length} scoped memory result${results.length === 1 ? '' : 's'}.` : 'No scoped memory facts found.');
    } catch (err) {
      $('vpMemoryStatus').textContent = err.message;
      renderMemoryFacts([], 'Memory search failed.');
    }
  }

  async function refreshAudit() {
    const query = new URLSearchParams({
      packId: selectedPackId(),
      scopeId: selectedScopeId(),
      limit: '5'
    });
    try {
      const data = await apiJson(`/api/voice-personas/audit/recent?${query.toString()}`);
      const rows = data.audit || [];
      $('vpAuditList').innerHTML = rows.length ? rows.map((row) => `
        <div class="vp-audit-item">
          <strong>${escapeHtml((row.safety && row.safety.flags || []).join(', ') || 'clear')}</strong>
          <div class="vp-audit-meta">${escapeHtml(row.traceId || '-')} &middot; ${escapeHtml(row.channel || 'text')} &middot; ${escapeHtml(row.model && row.model.model || 'router')}</div>
          <div class="vp-audit-meta">${escapeHtml(row.input && row.input.preview || '')}</div>
        </div>
      `).join('') : '<div class="vp-mini-status">No audit records yet.</div>';
    } catch (err) {
      $('vpAuditList').innerHTML = `<div class="vp-mini-status">${escapeHtml(err.message)}</div>`;
    }
  }

  async function refreshAlerts() {
    const query = new URLSearchParams({
      packId: selectedPackId(),
      scopeId: selectedScopeId(),
      modeId: selectedModeId(),
      limit: '25'
    });
    try {
      const data = await apiJson(`/api/voice-personas/alerts?${query.toString()}`);
      const payload = data.alerts || {};
      const alerts = payload.alerts || [];
      if (payload.status === 'attention') setPill('vpSessionStatus', 'Safety attention', 'danger');
      else if (payload.status === 'review') setPill('vpSessionStatus', 'Safety review', 'warn');
      else if (state.session) setPill('vpSessionStatus', `Session ${state.session.sessionId.slice(0, 8)}`, '');
      $('vpAlertList').innerHTML = alerts.length ? alerts.map((alert) => `
        <div class="vp-alert-item" data-severity="${escapeHtml(alert.severity || 'low')}">
          <strong>${escapeHtml(alert.title || alert.flagId || 'Alert')}</strong>
          <div class="vp-audit-meta">${escapeHtml(alert.message || '')}</div>
        </div>
      `).join('') : '<div class="vp-mini-status">No recent safety alerts.</div>';
    } catch (err) {
      $('vpAlertList').innerHTML = `<div class="vp-mini-status">${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadPackDetails() {
    const data = await apiJson(`/api/voice-personas/packs/${encodeURIComponent(selectedPackId())}`);
    state.packDetails = data;
    renderPackDetails(data);
  }

  async function createSession() {
    const data = await apiJson('/api/voice-personas/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packId: selectedPackId(),
        modeId: selectedModeId(),
        scopeId: selectedScopeId()
      })
    });
    state.session = data.session;
    setPill('vpSessionStatus', `Session ${state.session.sessionId.slice(0, 8)}`, '');
    clearTranscript();
    renderTrace(null);
    await Promise.all([refreshAudit(), refreshAlerts()]);
  }

  async function loadPacks() {
    const data = await apiJson('/api/voice-personas/packs');
    state.packs = data.packs || [];
    const select = $('vpPackSelect');
    select.innerHTML = '';
    for (const pack of state.packs) {
      const option = document.createElement('option');
      option.value = pack.id;
      option.textContent = pack.name || pack.id;
      select.appendChild(option);
    }
    select.value = data.defaultPackId || 'personal_operator';
    const pack = selectedPackSummary();
    renderModes(pack);
    $('vpScopeInput').value = pack && pack.defaultScopeId ? pack.defaultScopeId : 'personal';
    setPill('vpPackStatus', `${state.packs.length} packs`, '');
    await loadPackDetails();
    resetSessionState('Ready. Send a turn or start a session.');
    renderMemoryFacts([], 'Search scoped memory facts.');
    await Promise.all([refreshAudit(), refreshAlerts()]);
  }

  async function sendTurn(text, channel) {
    const content = String(text || '').trim();
    if (!content) return;
    if (!state.session) await createSession();
    appendMessage('user', content, channel === 'voice' ? 'voice' : 'you');
    rememberTurn('user', content);
    $('vpTextInput').value = '';
    setPill('vpSessionStatus', 'Thinking', 'warn');
    try {
      const data = await apiJson(`/api/voice-personas/sessions/${encodeURIComponent(state.session.sessionId)}/turns/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: content,
          channel: channel || 'text',
          history: state.history.slice(0, -1)
        })
      });
      const reply = data.reply && data.reply.text ? data.reply.text : '';
      appendMessage('assistant', reply || '(empty reply)', data.pack && data.pack.name ? data.pack.name : 'assistant');
      rememberTurn('assistant', reply);
      state.session = data.session || state.session;
      renderTrace(data);
      renderMemoryFromTurn(data);
      setPill('vpSessionStatus', `Session ${state.session.sessionId.slice(0, 8)}`, '');
      await Promise.all([refreshAudit(), refreshAlerts()]);
      if (state.speakReplies && reply) {
        synthesize(reply).catch((err) => setPill('vpVoixStatus', `TTS failed: ${err.message}`, 'warn'));
      }
    } catch (err) {
      appendMessage('system', err.message, 'error');
      setPill('vpSessionStatus', 'Turn failed', 'danger');
    }
  }

  async function synthesize(text) {
    if (!state.voixAvailable) throw new Error('VoiX unavailable');
    const resp = await fetch('/api/voix/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    await audio.play();
  }

  function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
  }

  async function startRecording() {
    if (!state.voixAvailable) {
      appendMessage('system', 'VoiX is unavailable. Text turns are still available.', 'voice');
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      appendMessage('system', 'Browser recording is not available in this session.', 'voice');
      return;
    }
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.mediaRecorder = new MediaRecorder(state.mediaStream);
    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) state.chunks.push(event.data);
    };
    state.mediaRecorder.onstop = onRecordingStopped;
    state.mediaRecorder.start();
    state.recording = true;
    $('vpRecordBtn').classList.add('is-recording');
    $('vpRecordBtn').setAttribute('title', 'Stop recording');
  }

  async function onRecordingStopped() {
    state.recording = false;
    $('vpRecordBtn').classList.remove('is-recording');
    $('vpRecordBtn').setAttribute('title', 'Push to talk');
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
      state.mediaStream = null;
    }
    const blob = new Blob(state.chunks, { type: state.mediaRecorder && state.mediaRecorder.mimeType || 'audio/webm' });
    state.chunks = [];
    if (!blob.size) {
      appendMessage('system', 'No audio captured.', 'voice');
      return;
    }
    const form = new FormData();
    form.append('audio', blob, 'voice-persona.webm');
    try {
      setPill('vpVoixStatus', 'Transcribing', 'warn');
      const resp = await fetch('/api/voix/transcribe', { method: 'POST', body: form });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || body.status === 'error') throw new Error(body.message || `HTTP ${resp.status}`);
      const data = body.data || body || {};
      const text = data.text || (data.data && data.data.text) || '';
      setPill('vpVoixStatus', 'VoiX ready', '');
      if (text) await sendTurn(text, 'voice');
      else appendMessage('system', 'No transcript returned.', 'voice');
    } catch (err) {
      setPill('vpVoixStatus', `STT failed: ${err.message}`, 'warn');
      appendMessage('system', `Transcription failed: ${err.message}`, 'voice');
    }
  }

  async function checkVoix() {
    try {
      await apiJson('/api/voix/health');
      state.voixAvailable = true;
      setPill('vpVoixStatus', 'VoiX ready', '');
      $('vpRecordBtn').disabled = false;
    } catch (_err) {
      state.voixAvailable = false;
      setPill('vpVoixStatus', 'VoiX unavailable', 'warn');
      $('vpRecordBtn').disabled = true;
    }
  }

  function bindEvents() {
    $('vpPackSelect').addEventListener('change', async () => {
      const pack = selectedPackSummary();
      renderModes(pack);
      $('vpScopeInput').value = pack && pack.defaultScopeId ? pack.defaultScopeId : selectedScopeId();
      resetSessionState('Persona changed. Send a turn or start a session.');
      renderMemoryFacts([], 'Search scoped memory facts.');
      try {
        await loadPackDetails();
        await Promise.all([refreshAudit(), refreshAlerts()]);
      } catch (err) {
        appendMessage('system', err.message, 'error');
      }
    });

    $('vpModeSelect').addEventListener('change', async () => {
      renderPackDetails(state.packDetails);
      resetSessionState('Mode changed. Send a turn or start a session.');
      try {
        await Promise.all([refreshAudit(), refreshAlerts()]);
      } catch (err) {
        appendMessage('system', err.message, 'error');
      }
    });

    $('vpNewSessionBtn').addEventListener('click', () => {
      createSession().catch((err) => appendMessage('system', err.message, 'error'));
    });

    $('vpScopeInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        resetSessionState('Scope changed. Send a turn or start a session.');
        renderPackDetails(state.packDetails);
        Promise.all([refreshAudit(), refreshAlerts()]).catch((err) => appendMessage('system', err.message, 'error'));
      }
    });

    $('vpTextForm').addEventListener('submit', (event) => {
      event.preventDefault();
      sendTurn($('vpTextInput').value, 'text');
    });

    $('vpRecordBtn').addEventListener('click', () => {
      if (state.recording) stopRecording();
      else startRecording().catch((err) => appendMessage('system', err.message, 'voice'));
    });

    $('vpSpeakToggle').addEventListener('click', () => {
      state.speakReplies = !state.speakReplies;
      $('vpSpeakToggle').setAttribute('aria-pressed', state.speakReplies ? 'true' : 'false');
    });

    $('vpMemoryForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = $('vpMemoryInput').value.trim();
      if (!text) return;
      try {
        const data = await apiJson('/api/voice-personas/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packId: selectedPackId(),
            modeId: selectedModeId(),
            scopeId: selectedScopeId(),
            topic: $('vpMemoryTopic').value || 'general',
            text
          })
        });
        $('vpMemoryInput').value = '';
        $('vpMemoryStatus').textContent = `Saved ${data.memory && data.memory.documentId ? data.memory.documentId : 'memory'}.`;
        $('vpMemorySearchInput').value = text.slice(0, 120);
        searchMemoryFacts(text).catch(() => {});
      } catch (err) {
        $('vpMemoryStatus').textContent = err.message;
      }
    });

    $('vpMemorySearchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      searchMemoryFacts($('vpMemorySearchInput').value);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    renderTrace(null);
    Promise.all([loadPacks(), checkVoix()]).catch((err) => {
      setPill('vpPackStatus', 'Pack load failed', 'danger');
      appendMessage('system', err.message, 'error');
    });
  });
})();

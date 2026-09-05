(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- Utilities ----------
  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showToast(msg, type = 'info') {
    const toast = $('toast');
    toast.textContent = msg;
    toast.style.background = type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 4500);
  }
  async function jsonFetch(url, opts = {}) {
    const resp = await fetch(url, opts);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || body.status === 'error') throw new Error(body.message || `HTTP ${resp.status}`);
    return body;
  }
  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }
  function fmtDuration(ms) {
    if (!ms) return '—';
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }
  function fmtNum(n, digits = 1) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toFixed(digits);
  }

  // ---------- Form: panel editor ----------
  let currentPanel = [];
  let currentSynth = { model: '', systemPrompt: '' };
  let currentModelReadiness = null;

  function renderAgentCard(agent, index) {
    const runtime = agent.runtime || 'model';
    const runtimeOptions = ['model', 'codex']
      .map((value) => `<option value="${value}" ${runtime === value ? 'selected' : ''}>${value}</option>`)
      .join('');
    return `
      <div class="rt-agent-edit-card" data-index="${index}">
        <button type="button" class="rt-remove" data-remove="${index}" title="Remove">×</button>
        <div class="rt-agent-edit-row">
          <div><label class="rt-label">Role</label><input type="text" class="rt-input" data-field="role" value="${escape(agent.role || '')}"></div>
          <div><label class="rt-label">Agent ID</label><input type="text" class="rt-input" data-field="agentId" value="${escape(agent.agentId || '')}"></div>
        </div>
        <div class="rt-agent-edit-row">
          <div><label class="rt-label">Runtime</label><select class="rt-input" data-field="runtime">${runtimeOptions}</select></div>
          <div><label class="rt-label">Model</label><input type="text" class="rt-input" data-field="model" list="councilModelOptions" autocomplete="off" value="${escape(agent.model || '')}" placeholder="required for model runtime"></div>
        </div>
        <div class="rt-agent-edit-row">
          <div><label class="rt-label">Session key / ID</label><input type="text" class="rt-input" data-runtime-field="sessionKey" value="${escape(agent.runtimeConfig?.sessionKey || agent.runtimeConfig?.sessionId || '')}" placeholder="optional dedicated runtime session"></div>
          <div style="display:flex; align-items:flex-end; padding-bottom:6px;">
            <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#94a3b8; cursor:pointer;">
              <input type="checkbox" data-field="enableWebSearch" ${agent.enableWebSearch ? 'checked' : ''}>
              <i class="fas fa-globe"></i> Web search
            </label>
          </div>
        </div>
        <label class="rt-label">System prompt</label>
        <textarea class="rt-input" data-field="systemPrompt" rows="4">${escape(agent.systemPrompt || '')}</textarea>
      </div>
    `;
  }

  function renderPanel() {
    $('formAgents').innerHTML = currentPanel.map((a, i) => renderAgentCard(a, i)).join('');
    $('formSynthModel').value = currentSynth.model || '';
    $('formSynthPrompt').value = currentSynth.systemPrompt || '';
    updateStartReadiness();
  }

  function readPanelFromDOM() {
    const panel = [];
    document.querySelectorAll('#formAgents .rt-agent-edit-card').forEach((card) => {
      const agent = {};
      card.querySelectorAll('[data-field]').forEach((el) => {
        const f = el.getAttribute('data-field');
        agent[f] = el.type === 'checkbox' ? el.checked : el.value.trim();
      });
      const session = card.querySelector('[data-runtime-field="sessionKey"]')?.value.trim();
      if (session) {
        agent.runtimeConfig = { sessionKey: session };
      }
      if (agent.agentId && (agent.runtime !== 'model' || agent.model)) panel.push(agent);
    });
    return panel;
  }

  function renderModelReadiness(readiness, { formReady = false, manualSelection = false } = {}) {
    const host = $('formModelReadiness');
    if (!host) return;
    host.classList.toggle('is-ready', formReady);
    host.classList.toggle('is-blocked', !formReady);
    let message = readiness?.message || 'No configured or runtime-discovered chat model is available.';
    if (manualSelection) {
      message = 'Using operator-selected model names; availability is checked when Council runs.';
    } else if (!formReady && readiness?.canStart === true) {
      message = `${message} Complete the participant and synthesizer selections.`;
    }
    host.innerHTML = `
      <i class="fas ${formReady ? 'fa-circle-check' : 'fa-triangle-exclamation'}" aria-hidden="true"></i>
      <span>${escape(message)} Council never downloads a model implicitly. <a href="/models">Review Models</a>.</span>`;
  }

  function updateStartReadiness() {
    const btn = $('formStartBtn');
    if (!btn) return;
    const panel = readPanelFromDOM();
    const synthModel = $('formSynthModel')?.value.trim() || '';
    const ready = panel.length > 0 && Boolean(synthModel);
    const selectedModels = [
      ...panel
        .filter((participant) => participant.runtime === 'model')
        .map((participant) => participant.model),
      synthModel
    ].filter(Boolean);
    const presetModel = currentModelReadiness?.selectedModel || '';
    const manualSelection = ready && selectedModels.some((model) => model !== presetModel);
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Select a model participant and synthesizer before convening Council.';
    if (currentModelReadiness) {
      renderModelReadiness(currentModelReadiness, { formReady: ready, manualSelection });
    }
  }

  async function loadDefaults(reset = false) {
    try {
      const { data } = await jsonFetch('/api/roundtable/defaults');
      currentModelReadiness = data.readiness || { canStart: false };
      $('councilModelOptions').innerHTML = (data.models || [])
        .map((model) => `<option value="${escape(model)}"></option>`)
        .join('');
      if (reset || !currentPanel.length) {
        currentPanel = data.panel.map((a) => ({ runtime: 'model', ...a }));
        currentSynth = { ...data.synthesizer };
        renderPanel();
      }
      updateStartReadiness();
    } catch (err) {
      currentModelReadiness = {
        canStart: false,
        message: `Model discovery failed: ${err.message}`
      };
      renderModelReadiness(currentModelReadiness);
      updateStartReadiness();
      showToast(`Failed to load defaults: ${err.message}`, 'error');
    }
  }

  // ---------- Live rendering ----------
  let liveDoc = null;
  let liveEventSource = null;
  const agentRefs = {}; // agentId -> { card, body, stats, status }

  function clearLive() {
    if (liveEventSource) { try { liveEventSource.close(); } catch {} liveEventSource = null; }
    $('liveSection').classList.add('rt-hidden');
    $('liveSynthesis').classList.add('rt-hidden');
    $('liveQuality').classList.add('rt-hidden');
    Object.keys(agentRefs).forEach((k) => delete agentRefs[k]);
    liveDoc = null;
  }

  function renderGovernance(doc) {
    const status = doc?.governance?.decisionStatus || 'deliberating';
    $('liveDecisionStatus').textContent = status.replace(/_/g, ' ');
    const awaiting = status === 'awaiting_approval';
    $('liveApproveBtn').classList.toggle('rt-hidden', !awaiting);
    $('liveRejectBtn').classList.toggle('rt-hidden', !awaiting);
    const active = ['pending', 'running'].includes(doc?.status);
    $('liveInterjection').disabled = !active;
    $('liveInterjectBtn').disabled = !active;
    const pending = (doc?.interjections || []).filter((item) => item.status === 'pending').length;
    $('liveChairHint').textContent = `${pending} pending interjection${pending === 1 ? '' : 's'}. No verdict executes actions.`;
  }

  async function refreshLiveGovernance() {
    if (!liveDoc?._id) return;
    try {
      const { data } = await jsonFetch(`/api/roundtable/${liveDoc._id}`);
      liveDoc = data;
      renderGovernance(data);
    } catch {}
  }

  async function submitInterjection() {
    if (!liveDoc?._id) return;
    const text = $('liveInterjection').value.trim();
    if (!text) { showToast('Enter chair guidance first', 'error'); return; }
    const token = $('liveChairToken').value;
    if (!token) { showToast('Chair token is required for interjections', 'error'); return; }
    try {
      await jsonFetch(`/api/roundtable/${liveDoc._id}/interjections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-roundtable-chair-token': token
        },
        body: JSON.stringify({ text, author: 'Example User', source: 'web-ui' })
      });
      $('liveInterjection').value = '';
      showToast('Interjection queued for the next phase', 'success');
      await refreshLiveGovernance();
    } catch (err) {
      showToast(`Interjection failed: ${err.message}`, 'error');
    }
  }

  async function submitDecision(decision) {
    if (!liveDoc?._id) return;
    const token = $('liveChairToken').value;
    if (!token) { showToast('Chair token is required for web decisions', 'error'); return; }
    try {
      await jsonFetch(`/api/roundtable/${liveDoc._id}/decision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-roundtable-chair-token': token
        },
        body: JSON.stringify({
          decision,
          actor: 'Example User',
          note: $('liveDecisionNote').value.trim()
        })
      });
      $('liveChairToken').value = '';
      showToast(`Verdict ${decision}`, 'success');
      await refreshLiveGovernance();
    } catch (err) {
      showToast(`Decision failed: ${err.message}`, 'error');
    }
  }

  function renderAgentSlot(agent, round) {
    const existing = agentRefs[agent.agentId];
    if (existing) return existing;

    const card = document.createElement('div');
    card.className = 'rt-agent-card';
    card.innerHTML = `
      <div class="rt-agent-head">
        <div class="rt-agent-role">${escape(agent.role || agent.agentId)}</div>
        <div class="rt-agent-status" data-status>pending</div>
      </div>
      <div class="rt-agent-badges">
        <span class="rt-badge" data-runtime>${escape(agent.runtime || 'model')}</span>
        <span class="rt-badge model" data-model>${escape(agent.model || '—')}</span>
        <span class="rt-badge host" data-host>host —</span>
        <span class="rt-badge round" data-round>round ${round || 1}</span>
      </div>
      <div class="rt-agent-body" data-body></div>
      <div class="rt-agent-stats" data-stats>
        <span>tokens: <strong data-tokens>—</strong></span>
        <span>t/s: <strong data-tps>—</strong></span>
        <span>latency: <strong data-latency>—</strong></span>
        <span>turns: <strong data-turns>0</strong></span>
      </div>
    `;
    $('liveAgentGrid').appendChild(card);
    const refs = {
      card,
      status: card.querySelector('[data-status]'),
      model: card.querySelector('[data-model]'),
      host: card.querySelector('[data-host]'),
      round: card.querySelector('[data-round]'),
      body: card.querySelector('[data-body]'),
      tokens: card.querySelector('[data-tokens]'),
      tps: card.querySelector('[data-tps]'),
      latency: card.querySelector('[data-latency]'),
      turns: card.querySelector('[data-turns]'),
      turnsCount: 0,
      currentRound: round || 1
    };
    agentRefs[agent.agentId] = refs;
    return refs;
  }

  function setPhase(phase) {
    document.querySelectorAll('#livePhases .rt-phase').forEach((p) => {
      const id = p.getAttribute('data-phase');
      p.classList.remove('active', 'done', 'error');
      if (id === phase) p.classList.add('active');
    });
    // Mark prior phases done
    const order = ['round-1', 'round-2', 'round-3', 'synthesis', 'done'];
    const idx = order.indexOf(phase);
    for (let i = 0; i < idx; i += 1) {
      document.querySelector(`#livePhases .rt-phase[data-phase="${order[i]}"]`)?.classList.add('done');
    }
  }

  function handleEvent(type, data) {
    if (type === 'started') return;

    if (type === 'round-start') {
      setPhase(`round-${data.round}`);
      // Pre-mark all known agents as pending for this round
      Object.values(agentRefs).forEach((r) => {
        r.currentRound = data.round;
        r.round.textContent = `round ${data.round}`;
        r.status.textContent = 'pending';
        r.status.className = 'rt-agent-status';
        r.body.textContent = ''; // Clear for the new round's content
      });
      return;
    }

    if (type === 'turn-start') {
      const agent = liveDoc.panelConfig.find((a) => a.agentId === data.agentId) || { role: data.role, model: data.model, agentId: data.agentId };
      const refs = renderAgentSlot(agent, data.round);
      refs.card.classList.add('active');
      refs.card.classList.remove('done', 'error');
      refs.status.textContent = 'running';
      refs.status.className = 'rt-agent-status running';
      refs.round.textContent = `round ${data.round}`;
      refs.body.textContent = '';
      return;
    }

    if (type === 'turn-chunk') {
      const refs = agentRefs[data.agentId];
      if (refs) refs.body.textContent += data.content || '';
      return;
    }

    if (type === 'turn-done') {
      const refs = agentRefs[data.agentId];
      if (!refs) return;
      refs.card.classList.remove('active');
      if (data.error) {
        refs.card.classList.add('error');
        refs.status.textContent = 'error';
        refs.status.className = 'rt-agent-status error';
        refs.body.textContent = `Error: ${data.error}`;
      } else {
        refs.card.classList.add('done');
        refs.status.textContent = 'done';
        refs.status.className = 'rt-agent-status done';
      }
      if (data.stats) {
        refs.tokens.textContent = data.stats.completionTokens ?? '—';
        refs.tps.textContent = fmtNum(data.stats.tokensPerSecond);
        refs.latency.textContent = data.stats.latencyMs ? fmtDuration(data.stats.latencyMs) : '—';
      }
      refs.turnsCount += 1;
      refs.turns.textContent = refs.turnsCount;
      return;
    }

    if (type === 'web-search-done') {
      const refs = agentRefs[data.agentId];
      if (refs) refs.body.textContent = `[web search: ${data.resultCount} results]\n\n${refs.body.textContent}`;
      return;
    }

    if (type === 'interjection-added') {
      showToast(`Interjection queued by ${data.author || 'chair'}`, 'info');
      refreshLiveGovernance();
      return;
    }

    if (type === 'interjections-applied') {
      showToast(`${data.count} interjection${data.count === 1 ? '' : 's'} applied to this phase`, 'success');
      refreshLiveGovernance();
      return;
    }

    if (type === 'round-done') return; // no-op, round-start handles state

    if (type === 'synthesis-start') {
      setPhase('synthesis');
      $('liveSynthesis').classList.remove('rt-hidden');
      $('liveSynthMeta').textContent = `model: ${data.model}`;
      $('liveSynthBody').textContent = '';
      return;
    }

    if (type === 'synthesis-chunk') {
      $('liveSynthBody').textContent += data.content || '';
      return;
    }

    if (type === 'synthesis-done') {
      if (data.error) {
        $('liveSynthBody').textContent = `Error: ${data.error}`;
      } else if (data.stats) {
        const s = data.stats;
        $('liveSynthMeta').textContent = `tokens: ${s.completionTokens ?? '—'} · ${fmtNum(s.tokensPerSecond)} t/s · ${fmtDuration(s.latencyMs)}`;
      }
      return;
    }

    if (type === 'done') {
      setPhase('done');
      if (liveDoc) liveDoc.status = data.status || liveDoc.status;
      $('liveStatus').textContent = `#${liveDoc?._id?.substring(liveDoc._id.length - 8) || 'council'} — ${String(data.status || 'finished').toUpperCase()}`;
      if (liveEventSource) {
        try { liveEventSource.close(); } catch {}
        liveEventSource = null;
      }
      if (data.status === 'failed' || data.status === 'timeout') {
        showToast(`Council ${data.status}: ${data.error || 'unknown error'}`, 'error');
      } else {
        showToast(`Council completed in ${fmtDuration(data.totalDurationMs)}${liveDoc?.qualityScores ? '' : ' — advisory answer ready'}`, 'success');
      }
      // Poll for quality scores
      if (liveDoc && liveDoc._id) pollQualityScores(liveDoc._id, 5);
      refreshLiveGovernance();
      loadHistory();
    }
  }

  async function pollQualityScores(id, attempts) {
    if (attempts <= 0) return;
    await new Promise((r) => setTimeout(r, 6000));
    try {
      const { data } = await jsonFetch(`/api/roundtable/${id}`);
      if (data?.qualityScores) {
        renderQualityScores(data);
        return;
      }
    } catch {}
    pollQualityScores(id, attempts - 1);
  }

  function renderQualityScores(doc) {
    const q = doc.qualityScores;
    if (!q) return;
    $('liveQuality').classList.remove('rt-hidden');

    if (typeof q.agreementIndex === 'number') {
      $('liveAgreement').innerHTML = `Agreement index: <strong>${(q.agreementIndex * 100).toFixed(0)}%</strong>`;
    } else {
      $('liveAgreement').textContent = '';
    }

    const cards = [];
    const dims = [
      { key: 'clarity', label: 'Clarity' },
      { key: 'evidence_quality', label: 'Evidence' },
      { key: 'logical_coherence', label: 'Coherence' }
    ];
    Object.entries(q.agents || {}).forEach(([agentId, scores]) => {
      const role = scores.role || agentId;
      const rows = dims.map((d) => scoreRow(d.label, scores[d.key])).join('');
      cards.push(`
        <div class="rt-quality-card">
          <div class="rt-quality-card-head"><strong>${escape(role)}</strong><span class="rt-quality-overall">${fmtNum(scores.overall, 1)}/10</span></div>
          ${rows}
        </div>
      `);
    });
    if (q.synthesis) {
      const sdims = [
        { key: 'coverage', label: 'Coverage' },
        { key: 'fairness', label: 'Fairness' },
        { key: 'actionability', label: 'Actionable' }
      ];
      const rows = sdims.map((d) => scoreRow(d.label, q.synthesis[d.key])).join('');
      cards.push(`
        <div class="rt-quality-card" style="border-color:rgba(124,240,255,0.3);">
          <div class="rt-quality-card-head"><strong>Synthesizer</strong><span class="rt-quality-overall">${fmtNum(q.synthesis.overall, 1)}/10</span></div>
          ${rows}
        </div>
      `);
    }
    $('liveQualityGrid').innerHTML = cards.join('');
  }

  function scoreRow(label, value) {
    const v = typeof value === 'number' ? value : 0;
    const pct = Math.max(0, Math.min(100, v * 10));
    const color = pct >= 70 ? '#4db33d' : pct >= 40 ? '#f59e0b' : '#dc3545';
    return `
      <div class="rt-dim-row">
        <span style="color:#94a3b8;">${escape(label)}</span>
        <div class="rt-dim-bar"><div class="rt-dim-fill" style="width:${pct}%; background:${color};"></div></div>
        <span style="color:#cbd5e1;">${v.toFixed(1)}</span>
      </div>
    `;
  }

  async function attachLive(id) {
    try {
      const { data } = await jsonFetch(`/api/roundtable/${id}`);
      liveDoc = data;
      $('liveSection').classList.remove('rt-hidden');
      $('liveStatus').textContent = `#${id.substring(id.length - 8)} — ${data.status.toUpperCase()}`;
      $('liveQuestion').textContent = data.question;
      renderGovernance(data);

      // Pre-populate agent cards from panelConfig
      $('liveAgentGrid').innerHTML = '';
      Object.keys(agentRefs).forEach((k) => delete agentRefs[k]);
      (data.panelConfig || []).forEach((a) => renderAgentSlot(a, 1));

      // Fill in already-completed turns
      (data.turns || []).forEach((t) => {
        const refs = agentRefs[t.agentId];
        if (!refs) return;
        if (t.round > refs.currentRound) {
          refs.currentRound = t.round;
          refs.round.textContent = `round ${t.round}`;
          refs.body.textContent = t.response || (t.error ? `Error: ${t.error}` : '');
        } else if (t.round === refs.currentRound) {
          refs.body.textContent = t.response || (t.error ? `Error: ${t.error}` : '');
        }
        refs.host.textContent = `host ${t.hostName || '—'}`;
        if (t.stats) {
          refs.tokens.textContent = t.stats.completionTokens ?? '—';
          refs.tps.textContent = fmtNum(t.stats.tokensPerSecond);
          refs.latency.textContent = t.stats.latencyMs ? fmtDuration(t.stats.latencyMs) : '—';
        }
        refs.turnsCount = (data.turns || []).filter((x) => x.agentId === t.agentId).length;
        refs.turns.textContent = refs.turnsCount;
        refs.card.classList.add(t.error ? 'error' : 'done');
        refs.status.textContent = t.error ? 'error' : 'done';
        refs.status.className = 'rt-agent-status ' + (t.error ? 'error' : 'done');
      });

      // Synthesis if already present
      if (data.synthesis?.response || data.synthesis?.error) {
        $('liveSynthesis').classList.remove('rt-hidden');
        $('liveSynthBody').textContent = data.synthesis.response || `Error: ${data.synthesis.error}`;
        if (data.synthesis.stats) {
          const s = data.synthesis.stats;
          $('liveSynthMeta').textContent = `model: ${data.synthesis.model} · tokens: ${s.completionTokens ?? '—'} · ${fmtNum(s.tokensPerSecond)} t/s · ${fmtDuration(s.latencyMs)}`;
        }
      }

      // Phase state
      if (data.status === 'completed') setPhase('done');
      else if (data.status === 'failed' || data.status === 'timeout') setPhase('done');
      else if (data.synthesis?.response) setPhase('synthesis');
      else if ((data.turns || []).length) {
        const maxRound = Math.max(...data.turns.map((t) => t.round), 1);
        setPhase(`round-${maxRound}`);
      } else setPhase('round-1');

      if (data.qualityScores) renderQualityScores(data);

      // Subscribe if still running
      if (['pending', 'running'].includes(data.status)) {
        liveEventSource = new EventSource(`/api/roundtable/${id}/stream`);
        ['started', 'round-start', 'round-done', 'turn-start', 'turn-chunk', 'turn-done', 'web-search-start', 'web-search-done', 'interjection-added', 'interjections-applied', 'synthesis-start', 'synthesis-chunk', 'synthesis-done', 'done'].forEach((ev) => {
          liveEventSource.addEventListener(ev, (e) => {
            try { handleEvent(ev, JSON.parse(e.data)); } catch {}
          });
        });
        liveEventSource.onerror = () => { try { liveEventSource.close(); } catch {} };
      }
    } catch (err) {
      showToast(`Failed to load Council: ${err.message}`, 'error');
    }
  }

  // ---------- Start form submission ----------
  async function startDiscussion() {
    const question = $('formQuestion').value.trim();
    if (!question) { showToast('Enter a question', 'error'); return; }

    const panel = readPanelFromDOM();
    if (!panel.length) { showToast('Panel must have at least one agent', 'error'); return; }
    if (!$('formSynthModel').value.trim()) { showToast('Select a synthesizer model', 'error'); return; }

    const body = {
      question,
      rounds: Number($('formRounds').value),
      panel,
      synthesizer: {
        model: $('formSynthModel').value.trim(),
        systemPrompt: $('formSynthPrompt').value.trim()
      },
      enableScoring: $('formScoring').value === 'true',
      governance: { requireApproval: $('formApproval').value === 'true' },
      source: 'web-ui'
    };

    const btn = $('formStartBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting…';
    try {
      const { data } = await jsonFetch('/api/roundtable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...($('formChairToken').value ? { 'x-roundtable-chair-token': $('formChairToken').value } : {})
        },
        body: JSON.stringify(body)
      });
      clearLive();
      await attachLive(data._id);
      $('liveChairToken').value = $('formChairToken').value;
      showToast('Council convened — streaming live', 'success');
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      btn.innerHTML = '<i class="fas fa-rocket"></i> Convene Council';
      updateStartReadiness();
    }
  }

  // ---------- History ----------
  async function loadHistory() {
    try {
      const { data = [] } = await jsonFetch('/api/roundtable?limit=25');
      const host = $('historyList');
      if (!data.length) { host.innerHTML = '<div style="color:#888; padding:12px;">No discussions yet.</div>'; return; }
      host.innerHTML = data.map((d) => {
        const short = (d.question || '').substring(0, 120);
        const turns = (d.turns || []).length;
        const quality = d.qualityScores?.synthesis?.overall;
        const qualityStr = typeof quality === 'number' ? ` · 🏅 ${quality.toFixed(1)}/10` : '';
        return `
          <div class="rt-history-item" data-id="${d._id}">
            <div class="rt-history-row">
              <div class="rt-history-q">${escape(short)}${d.question.length > 120 ? '…' : ''}</div>
              <div class="rt-history-meta">
                <span class="rt-history-status ${d.status}">${d.status}</span>
                <span>${fmtDate(d.createdAt)}</span>
                <span>${fmtDuration(d.totalDurationMs)}</span>
                <span>${turns} turns${qualityStr}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      $('historyList').innerHTML = `<div style="color:#dc3545;">Failed: ${escape(err.message)}</div>`;
    }
  }

  // ---------- Event wiring ----------
  document.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const i = Number(remove.getAttribute('data-remove'));
      currentPanel = readPanelFromDOM();
      currentPanel.splice(i, 1);
      renderPanel();
      return;
    }
    const item = e.target.closest('.rt-history-item');
    if (item) {
      clearLive();
      attachLive(item.getAttribute('data-id'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  document.addEventListener('DOMContentLoaded', async () => {
    $('formStartBtn').addEventListener('click', startDiscussion);
    $('formAgents').addEventListener('input', updateStartReadiness);
    $('formSynthModel').addEventListener('input', updateStartReadiness);
    $('formResetBtn').addEventListener('click', () => loadDefaults(true));
    $('formAddAgent').addEventListener('click', () => {
      currentPanel = readPanelFromDOM();
      currentPanel.push({
        agentId: `agent-${currentPanel.length + 1}`,
        role: 'Agent', runtime: 'model', model: '', systemPrompt: '', enableWebSearch: false
      });
      renderPanel();
    });
    $('liveInterjectBtn').addEventListener('click', submitInterjection);
    $('liveInterjection').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submitInterjection(); }
    });
    $('liveApproveBtn').addEventListener('click', () => submitDecision('approved'));
    $('liveRejectBtn').addEventListener('click', () => submitDecision('rejected'));
    $('historyRefreshBtn').addEventListener('click', loadHistory);
    $('liveDeleteBtn').addEventListener('click', async () => {
      if (!liveDoc) return;
      const headers = await window.AgentXTypedConfirmation.confirm({
        action: 'DELETE COUNCIL RECORD',
        resource: liveDoc._id,
        title: 'Delete Council record',
        description: 'Delete this Council discussion, transcript, verdict, and score record? This cannot be recovered.'
      });
      if (!headers) return;
      try {
        await jsonFetch(`/api/roundtable/${liveDoc._id}`, { method: 'DELETE', headers });
        clearLive();
        loadHistory();
        showToast('Deleted', 'success');
      } catch (err) { showToast(`Delete failed: ${err.message}`, 'error'); }
    });
    $('liveTranscriptBtn').addEventListener('click', () => {
      if (!liveDoc) return;
      window.open(`/api/roundtable/${liveDoc._id}/transcript`, '_blank');
    });

    await loadDefaults();
    loadHistory();

    // Pre-fill question from URL ?question=... (Playground "Ask Council")
    try {
      const params = new URLSearchParams(window.location.search);
      const qParam = params.get('question');
      if (qParam) {
        $('formQuestion').value = qParam;
        $('formQuestion').focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        showToast('Question loaded from Playground — review panel, then Start', 'info');
      }
    } catch {}

    // Auto-attach an active roundtable if one is running
    try {
      const { data } = await jsonFetch('/api/roundtable/active');
      if (data && data._id) attachLive(data._id.toString());
    } catch {}
  });
})();

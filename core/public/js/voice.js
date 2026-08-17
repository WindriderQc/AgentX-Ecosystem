(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

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
    if (!resp.ok || body.status === 'error') {
      throw new Error(body.message || body.error || `HTTP ${resp.status}`);
    }
    return body;
  }

  function renderDl(container, pairs) {
    container.innerHTML = pairs.length
      ? pairs.map(([k, v]) => `<dt style="color:#888;">${escape(k)}</dt><dd style="margin:0; color:#cbd5e1;"><code style="color:inherit;">${escape(v)}</code></dd>`).join('')
      : '<dt style="color:#888;">(no data)</dt><dd></dd>';
  }

  function flattenPairs(value, prefix = '', rows = []) {
    if (value == null || typeof value !== 'object') {
      rows.push([prefix || 'value', value == null || value === '' ? '—' : String(value)]);
      return rows;
    }
    if (Array.isArray(value)) {
      if (!value.length) rows.push([prefix || 'items', '—']);
      else if (value.every((item) => item == null || typeof item !== 'object')) {
        rows.push([prefix || 'items', value.join(', ')]);
      } else {
        value.forEach((item, index) => flattenPairs(item, `${prefix || 'items'} ${index + 1}`, rows));
      }
      return rows;
    }
    Object.entries(value).forEach(([key, child]) => {
      const label = prefix ? `${prefix} · ${key}` : key;
      flattenPairs(child, label, rows);
    });
    return rows;
  }

  function setValue(id, value) {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value == null ? '' : value;
  }

  function setSource(id, sources, path) {
    const el = $(id);
    if (!el) return;
    el.textContent = `from ${sources?.[path] || 'default'}`;
  }

  const VOIX_CONSOLE_LINK_IDS = ['voixConsoleLink', 'voixMicConsoleLink'];

  function updateVoixConsoleLinks(baseUrl) {
    let href = '';
    try {
      const url = new URL(String(baseUrl || ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
    } catch {
      href = '';
    }

    VOIX_CONSOLE_LINK_IDS.forEach((id) => {
      const link = $(id);
      if (!link) return;
      if (href) {
        link.href = href;
        link.removeAttribute('aria-disabled');
        link.title = `Open ${href}`;
      } else {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
        link.title = 'No valid VoiX console URL is configured';
      }
    });
  }

  function updateBrowserMicNotice() {
    const notice = $('browserMicSecurityNotice');
    if (!notice) return;
    const browserMicAvailable = window.isSecureContext
      && Boolean(navigator.mediaDevices?.getUserMedia);
    notice.style.display = browserMicAvailable ? 'none' : 'block';
  }

  function renderEnvContract(data) {
    const panel = $('voiceEnvPanel');
    if (!panel) return;
    const rows = data.env || [];
    panel.innerHTML = rows.map((row) => `
      <code style="color:#cbd5e1;">${escape(row.key)}</code>
      <code style="color:#7cf0ff;">${escape(row.path)}</code>
      <span>${escape(row.description || '')} <span style="color:#64748b;">default: ${escape(String(row.defaultValue))}</span></span>
    `).join('');
  }

  const VOICE_MODE_PRESETS = {
    browser: {
      sttEnabled: true,
      sttProvider: 'browser',
      ttsEnabled: true,
      ttsProvider: 'browser',
      convoEnabled: false,
      convoAutoSpeak: false,
      convoKeepSession: true
    },
    hybrid: {
      sttEnabled: true,
      sttProvider: 'voix',
      ttsEnabled: true,
      ttsProvider: 'voix',
      convoEnabled: false,
      convoAutoSpeak: false,
      convoKeepSession: true
    },
    native: {
      sttEnabled: true,
      sttProvider: 'voix',
      ttsEnabled: true,
      ttsProvider: 'voix',
      convoEnabled: true,
      convoAutoSpeak: true,
      convoKeepSession: true
    }
  };

  const VOICE_MODE_COPY = {
    browser: 'Browser STT and browser TTS. ConvoMode stays off.',
    hybrid: 'Browser capture/playback with VoiX STT and VoiX TTS through Core. ConvoMode stays off.',
    native: 'VoiX STT, VoiX TTS, and VoiX ConvoMode/session defaults.'
  };

  function applyVoiceModePresetToForm(mode) {
    const preset = VOICE_MODE_PRESETS[mode] || VOICE_MODE_PRESETS.browser;
    setValue('voiceSttEnabled', preset.sttEnabled);
    setValue('voiceSttProvider', preset.sttProvider);
    setValue('voiceTtsEnabled', preset.ttsEnabled);
    setValue('voiceTtsProvider', preset.ttsProvider);
    setValue('voiceConvoEnabled', preset.convoEnabled);
    setValue('voiceConvoAutoSpeak', preset.convoAutoSpeak);
    setValue('voiceConvoKeepSession', preset.convoKeepSession);
  }

  function voiceModeMismatchLabels(mode, features = {}) {
    const preset = VOICE_MODE_PRESETS[mode] || VOICE_MODE_PRESETS.browser;
    const checks = [
      ['STT enabled', features.stt?.enabled, preset.sttEnabled],
      ['STT provider', features.stt?.provider, preset.sttProvider],
      ['TTS enabled', features.tts?.enabled, preset.ttsEnabled],
      ['TTS provider', features.tts?.provider, preset.ttsProvider],
      ['ConvoMode enabled', features.convoMode?.enabled, preset.convoEnabled],
      ['ConvoMode speak replies', features.convoMode?.autoSpeak, preset.convoAutoSpeak],
      ['ConvoMode keep session', features.convoMode?.keepSession, preset.convoKeepSession]
    ];
    return checks
      .filter(([, actual, expected]) => actual !== undefined && actual !== expected)
      .map(([label]) => label);
  }

  function renderVoiceModeMeta(mode, data = {}) {
    const meta = $('voiceModeMeta');
    if (!meta) return;
    const modeInfo = (data.voiceModes || []).find((item) => item.id === mode);
    const preset = VOICE_MODE_PRESETS[mode] || VOICE_MODE_PRESETS.browser;
    const description = modeInfo?.description || VOICE_MODE_COPY[mode] || VOICE_MODE_COPY.browser;
    const mismatches = data.features ? voiceModeMismatchLabels(mode, data.features) : [];
    meta.innerHTML = `
      ${escape(description)}
      <div style="margin-top:6px;">
        STT <code style="color:#cbd5e1;">${preset.sttProvider}</code>,
        TTS <code style="color:#cbd5e1;">${preset.ttsProvider}</code>,
        ConvoMode <code style="color:#cbd5e1;">${preset.convoEnabled ? 'on' : 'off'}</code>
      </div>
      ${mismatches.length ? `
        <div style="margin-top:8px; color:#f59e0b;">
          Current low-level overrides differ: ${mismatches.map(escape).join(', ')}. Apply mode to rewrite these defaults.
        </div>
      ` : ''}
    `;
  }

  // ---------- Status + settings ----------
  async function loadSettings() {
    try {
      const { data } = await jsonFetch('/api/voix/settings');
      setValue('voiceMode', data.voiceMode || 'browser');
      $('voiceModeSrc').textContent = `from ${data.voiceModeSource || data.sources?.voiceMode || 'default'}`;
      renderVoiceModeMeta(data.voiceMode || 'browser', data);
      $('cfgBaseUrl').value = data.baseUrl;
      updateVoixConsoleLinks(data.baseUrl);
      $('cfgBaseUrlSrc').textContent = `from ${data.baseUrlSource}`;
      $('cfgTimeoutMs').value = data.timeoutMs;
      $('cfgTimeoutSrc').textContent = `from ${data.timeoutSource}`;
      $('cfgLongTimeoutMs').value = data.longTimeoutMs;
      $('cfgLongTimeoutSrc').textContent = `from ${data.longTimeoutSource}`;
      $('voiceConfigFile').textContent = data.runtimeFile;
      const features = data.features || {};
      const sources = data.sources || {};
      setValue('voiceSttEnabled', features.stt?.enabled);
      setValue('voiceSttProvider', features.stt?.provider || 'browser');
      setValue('voiceSttLanguage', features.stt?.language || 'en');
      setValue('voiceSttModel', features.stt?.model || '');
      setSource('voiceSttEnabledSrc', sources, 'features.stt.enabled');
      setSource('voiceSttProviderSrc', sources, 'features.stt.provider');
      setSource('voiceSttLanguageSrc', sources, 'features.stt.language');
      setSource('voiceSttModelSrc', sources, 'features.stt.model');

      setValue('voiceTtsEnabled', features.tts?.enabled);
      setValue('voiceTtsProvider', features.tts?.provider || 'browser');
      setValue('voiceTtsVoice', features.tts?.voice || '');
      setValue('voiceTtsFormat', features.tts?.responseFormat || 'mp3');
      setSource('voiceTtsEnabledSrc', sources, 'features.tts.enabled');
      setSource('voiceTtsProviderSrc', sources, 'features.tts.provider');
      setSource('voiceTtsVoiceSrc', sources, 'features.tts.voice');
      setSource('voiceTtsFormatSrc', sources, 'features.tts.responseFormat');

      setValue('voiceConvoEnabled', features.convoMode?.enabled);
      setValue('voiceConvoAutoSpeak', features.convoMode?.autoSpeak);
      setValue('voiceConvoKeepSession', features.convoMode?.keepSession);
      setSource('voiceConvoEnabledSrc', sources, 'features.convoMode.enabled');
      setSource('voiceConvoAutoSpeakSrc', sources, 'features.convoMode.autoSpeak');
      setSource('voiceConvoKeepSessionSrc', sources, 'features.convoMode.keepSession');
      renderEnvContract(data);
    } catch (err) {
      showToast(`Failed to load settings: ${err.message}`, 'error');
    }
  }

  async function applyVoiceMode() {
    const btn = $('voiceModeApplyBtn');
    const mode = $('voiceMode').value;
    btn.disabled = true;
    btn.textContent = 'Applying...';
    applyVoiceModePresetToForm(mode);
    renderVoiceModeMeta(mode);
    try {
      await jsonFetch('/api/voix/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceMode: mode })
      });
      showToast('Voice mode applied', 'success');
      await loadAll();
    } catch (err) {
      showToast(`Mode apply failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Apply mode';
    }
  }

  async function saveSettings() {
    const btn = $('cfgSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const body = {
        voiceMode: $('voiceMode').value,
        baseUrl: $('cfgBaseUrl').value.trim() || null,
        timeoutMs: Number($('cfgTimeoutMs').value) || null,
        longTimeoutMs: Number($('cfgLongTimeoutMs').value) || null,
        features: {
          stt: {
            enabled: $('voiceSttEnabled').checked,
            provider: $('voiceSttProvider').value,
            language: $('voiceSttLanguage').value.trim() || null,
            model: $('voiceSttModel').value.trim() || null
          },
          tts: {
            enabled: $('voiceTtsEnabled').checked,
            provider: $('voiceTtsProvider').value,
            voice: $('voiceTtsVoice').value.trim() || null,
            responseFormat: $('voiceTtsFormat').value
          },
          convoMode: {
            enabled: $('voiceConvoEnabled').checked,
            autoSpeak: $('voiceConvoAutoSpeak').checked,
            keepSession: $('voiceConvoKeepSession').checked
          }
        }
      };
      await jsonFetch('/api/voix/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      showToast('Settings saved — running health check…', 'success');
      await loadAll();
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save settings';
    }
  }

  async function clearOverrides() {
    if (!confirm('Clear all runtime overrides?\nSettings will revert to env/defaults.')) return;
    try {
      await jsonFetch('/api/voix/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: null,
          voiceMode: null,
          timeoutMs: null,
          longTimeoutMs: null,
          features: {
            stt: { enabled: null, provider: null, language: null, model: null },
            tts: { enabled: null, provider: null, voice: null, responseFormat: null },
            convoMode: { enabled: null, autoSpeak: null, keepSession: null }
          }
        })
      });
      showToast('Overrides cleared', 'success');
      await loadAll();
    } catch (err) {
      showToast(`Clear failed: ${err.message}`, 'error');
    }
  }

  // ---------- Health + panels ----------
  async function loadHealth() {
    const dot = $('voiceStatusDot');
    const txt = $('voiceStatusText');
    const meta = $('voiceStatusMeta');
    txt.textContent = 'Probing Voix…';
    meta.textContent = '—';
    dot.style.background = '#6c757d';
    try {
      const { data } = await jsonFetch('/api/voix/health');
      const h = data?.data || data || {};
      const ok = h.status === 'ok';
      dot.style.background = ok ? '#28a745' : '#f59e0b';
      txt.textContent = ok ? 'Voix reachable' : `Voix responded (${h.status || 'unknown'})`;
      const bits = [];
      if (h.mode) bits.push(`mode: ${h.mode}`);
      if (h.version) bits.push(`v${h.version}`);
      if (h.ollama?.baseUrl) bits.push(`ollama: ${h.ollama.baseUrl} (${h.ollama.model || '?'})`);
      if (typeof h.sessions === 'number') bits.push(`sessions: ${h.sessions}`);
      meta.textContent = bits.join(' · ') || 'no details';
    } catch (err) {
      dot.style.background = '#dc3545';
      txt.textContent = 'Voix unreachable';
      meta.textContent = err.message;
    }
  }

  // Grouped view of key Voix-side knobs.
  const VOIX_CFG_GROUPS = [
    { title: 'STT (Whisper)', keys: ['whisper_model', 'whisper_device', 'whisper_compute_type', 'voix_language'] },
    { title: 'TTS',  keys: ['tts_provider', 'kokoro_voice', 'kokoro_language', 'windows_sapi_voice', 'tts_output_rate', 'tts_min_chars'] },
    { title: 'Brain routing', keys: ['brain', 'agentx_task_type', 'agentx_caller_detail', 'ollama_model', 'ollama_base_url'] },
    { title: 'Capture', keys: ['input_device', 'output_device', 'voix_input_device', 'voix_output_device', 'sample_rate', 'voix_sample_rate'] }
  ];

  function renderConfigGroups(cfg) {
    const panel = $('voixConfigPanel');
    const used = new Set();
    const blocks = VOIX_CFG_GROUPS.map((g) => {
      const rows = g.keys
        .filter((k) => k in cfg)
        .map((k) => { used.add(k); return [k, cfg[k]]; });
      if (!rows.length) return '';
      return `
        <div style="margin-bottom:14px;">
          <div style="font-size:11px; color:#7cf0ff; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px;">${escape(g.title)}</div>
          <div style="display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:13px;">
            ${rows.map(([k, v]) => `
              <div style="color:#888;">${escape(k)}</div>
              <div style="color:#cbd5e1;"><code style="color:inherit;">${escape(typeof v === 'object' ? JSON.stringify(v) : String(v))}</code></div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    const extras = Object.entries(cfg).filter(([k]) => !used.has(k));
    const extrasBlock = extras.length ? `
      <details style="margin-top:8px;">
        <summary style="cursor:pointer; font-size:12px; color:#888;">Other (${extras.length})</summary>
        <div style="display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12px; margin-top:8px;">
          ${extras.map(([k, v]) => `
            <div style="color:#888;">${escape(k)}</div>
            <div style="color:#94a3b8;"><code style="color:inherit;">${escape(typeof v === 'object' ? JSON.stringify(v) : String(v))}</code></div>
          `).join('')}
        </div>
      </details>
    ` : '';

    panel.innerHTML = blocks + extrasBlock + `
      <div style="margin-top:8px; padding:8px 10px; background:rgba(124,240,255,0.05); border-left:3px solid #7cf0ff; font-size:11px; color:#94a3b8;">
        Voice names and model/device settings live on the Voix server. The TTS engine selector above is runtime-editable.
      </div>
    `;
  }

  function setVoixTtsProviderControl(cfg, payload = {}) {
    const select = $('voixTtsProvider');
    const meta = $('voixTtsProviderMeta');
    if (!select || !meta) return;
    const provider = cfg.tts_provider || payload.static?.tts_provider_default || 'kokoro';
    select.value = provider;
    const changed = payload.running ? 'applies to the active runtime' : 'applies immediately';
    const voice = provider === 'windows_sapi'
      ? (cfg.windows_sapi_voice || 'system-default')
      : (cfg.kokoro_voice || 'default');
    meta.innerHTML = `active: <code style="color:#cbd5e1;">${escape(provider)}</code> · voice: <code style="color:#cbd5e1;">${escape(voice)}</code> · ${escape(changed)}`;
  }

  async function loadConfig() {
    try {
      const { data } = await jsonFetch('/api/voix/config');
      const payload = data?.data || data || {};
      const cfg = {
        ...(payload.static || {}),
        ...(payload.config || {}),
        ...(payload.config || payload.static ? {} : payload)
      };
      setVoixTtsProviderControl(cfg, payload);
      renderConfigGroups(cfg);
    } catch (err) {
      $('voixConfigPanel').innerHTML = `<dt style="color:#dc3545;">Error</dt><dd style="color:#dc3545;">${escape(err.message)}</dd>`;
      if ($('voixTtsProviderMeta')) $('voixTtsProviderMeta').innerHTML = `<span style="color:#dc3545;">${escape(err.message)}</span>`;
    }
  }

  async function saveVoixTtsProvider() {
    const btn = $('voixTtsProviderSave');
    const select = $('voixTtsProvider');
    if (!btn || !select) return;
    btn.disabled = true;
    btn.textContent = 'Applying...';
    try {
      await jsonFetch('/api/voix/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts_provider: select.value })
      });
      showToast('VoiX TTS engine updated', 'success');
      await Promise.all([loadConfig(), loadMetrics()]);
    } catch (err) {
      showToast(`TTS engine update failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  }

  async function loadMetrics() {
    try {
      const { data } = await jsonFetch('/api/voix/metrics');
      const m = data?.data || data || {};
      renderDl($('voixMetricsPanel'), flattenPairs(m));
    } catch (err) {
      $('voixMetricsPanel').innerHTML = `<dt style="color:#dc3545;">Error</dt><dd style="color:#dc3545;">${escape(err.message)}</dd>`;
    }
  }

  async function loadDevices() {
    const panel = $('voixDevicesPanel');
    try {
      const { data } = await jsonFetch('/api/voix/devices');
      const d = data?.data || data || {};
      const devices = d.devices || [];
      if (!devices.length) {
        panel.innerHTML = '<span style="color:#888;">No devices reported.</span>';
        return;
      }
      const defIn = d.default_input_index;
      const defOut = d.default_output_index;
      const defaultInput = devices.find((dev) => dev.index === defIn);
      const defaultOutput = devices.find((dev) => dev.index === defOut);
      panel.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin-bottom:12px;">
          <div style="padding:12px; background:#0f1629; border:1px solid #2a3145; border-radius:6px;">
            <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.08em;">Default input</div>
            <div style="margin-top:5px; color:#e2e8f0;">${escape(defaultInput?.name || 'Not configured')}</div>
          </div>
          <div style="padding:12px; background:#0f1629; border:1px solid #2a3145; border-radius:6px;">
            <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.08em;">Default output</div>
            <div style="margin-top:5px; color:#e2e8f0;">${escape(defaultOutput?.name || 'Not configured')}</div>
          </div>
        </div>
        <details>
          <summary style="cursor:pointer; color:#94a3b8;">Show all ${devices.length} raw device entries</summary>
        <table style="width:100%; border-collapse:collapse; font-size:13px; margin-top:10px;">
          <thead>
            <tr style="text-align:left; border-bottom:1px solid var(--border, #2a3145); color:#888;">
              <th style="padding:6px 4px;">#</th>
              <th style="padding:6px 4px;">Name</th>
              <th style="padding:6px 4px; text-align:right;">In ch.</th>
              <th style="padding:6px 4px; text-align:right;">Out ch.</th>
              <th style="padding:6px 4px;">Default</th>
            </tr>
          </thead>
          <tbody>
            ${devices.map((dev) => `
              <tr style="border-bottom:1px solid rgba(42,49,69,0.5);">
                <td style="padding:6px 4px; color:#888;">${dev.index}</td>
                <td style="padding:6px 4px;">${escape(dev.name)}</td>
                <td style="padding:6px 4px; text-align:right;">${dev.max_input_channels || 0}</td>
                <td style="padding:6px 4px; text-align:right;">${dev.max_output_channels || 0}</td>
                <td style="padding:6px 4px;">${dev.index === defIn ? '<span style="color:#4db33d;">input</span>' : ''}${dev.index === defOut ? ' <span style="color:#f59e0b;">output</span>' : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </details>
      `;
    } catch (err) {
      panel.innerHTML = `<span style="color:#dc3545;">Error: ${escape(err.message)}</span>`;
    }
  }

  async function loadModels() {
    const panel = $('voixModelsPanel');
    try {
      const { data } = await jsonFetch('/api/voix/models');
      const models = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.models)
            ? data.models
            : [];
      if (!models.length) {
        panel.innerHTML = '<span style="color:#888;">No models reported.</span>';
        return;
      }
      panel.innerHTML = models.map((model) => {
        if (typeof model === 'string') return model;
        return [model.id || model.name, model.device, model.compute_type, model.language]
          .filter(Boolean)
          .join(' · ');
      }).map((label) => `<code style="display:inline-block; margin:2px 4px; padding:2px 8px; background:#0f1629; border:1px solid #2a3145; border-radius:4px; color:#cbd5e1;">${escape(label)}</code>`).join('');
    } catch (err) {
      panel.innerHTML = `<span style="color:#dc3545;">Error: ${escape(err.message)}</span>`;
    }
  }

  // ---------- Try transcription — interactive STT ----------
  let recState = { recorder: null, stream: null, chunks: [], startedAt: 0, mime: '', timer: null };

  function updateRecTimer() {
    const el = $('tryRecordTimer');
    if (!el) return;
    const sec = ((performance.now() - recState.startedAt) / 1000).toFixed(1);
    el.textContent = `${sec}s`;
  }

  async function startRecording() {
    const btn = $('tryRecordBtn');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Mic not available — requires HTTPS or localhost', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg'
        : '';
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recState = { recorder, stream, chunks: [], startedAt: performance.now(), mime: mime || 'audio/webm', timer: null };

      recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size > 0) recState.chunks.push(e.data); });
      recorder.addEventListener('stop', onRecordingStop);

      recorder.start();
      recState.timer = setInterval(updateRecTimer, 100);

      btn.classList.add('btn-danger');
      btn.innerHTML = '<i class="fas fa-stop"></i> Stop';
      btn.dataset.recording = '1';
    } catch (err) {
      showToast(`Mic access failed: ${err.message}`, 'error');
    }
  }

  function stopRecording() {
    if (!recState.recorder || recState.recorder.state === 'inactive') return;
    recState.recorder.stop();
    if (recState.stream) recState.stream.getTracks().forEach((t) => t.stop());
    if (recState.timer) clearInterval(recState.timer);
    const btn = $('tryRecordBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Transcribing…';
  }

  async function onRecordingStop() {
    const btn = $('tryRecordBtn');
    const resultBox = $('tryRecResult');
    const audio = $('tryRecAudio');
    const transcriptEl = $('tryRecTranscript');
    const meta = $('tryRecMeta');
    const recordingMs = performance.now() - recState.startedAt;

    const blob = new Blob(recState.chunks, { type: recState.mime });
    if (!blob.size) {
      showToast('No audio captured', 'error');
      resetRecordButton();
      return;
    }

    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(blob);
    resultBox.style.display = 'block';
    transcriptEl.innerHTML = '<span style="color:#888;"><i class="fas fa-spinner fa-spin"></i> Transcribing…</span>';
    meta.textContent = '—';

    const lang = $('tryRecLang').value.trim();
    const form = new FormData();
    form.append('audio', blob, 'recording.webm');
    if (lang) form.append('language', lang);

    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const resp = await fetch('/api/voix/transcribe', { method: 'POST', body: form, signal: controller.signal });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload?.message || `HTTP ${resp.status}`);
      const data = payload?.data || payload || {};
      const text = data.text || data.data?.text || '(no transcript returned)';
      const elapsed = performance.now() - t0;
      transcriptEl.textContent = text;
      const kb = (blob.size / 1024).toFixed(1);
      meta.innerHTML = `recording ${(recordingMs / 1000).toFixed(1)}s &bull; ${kb} KB ${escape(recState.mime)} &bull; transcribe ${elapsed.toFixed(0)} ms${lang ? ` &bull; lang: <code>${escape(lang)}</code>` : ''}`;
      showToast('Transcription complete', 'success');
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Timed out after 120s' : err.message;
      transcriptEl.innerHTML = `<span style="color:#ff7a7a;">Error: ${escape(msg)}</span>`;
      showToast(`Transcription failed: ${msg}`, 'error');
    } finally {
      clearTimeout(timer);
      resetRecordButton();
    }
  }

  function resetRecordButton() {
    const btn = $('tryRecordBtn');
    btn.classList.remove('btn-danger');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-circle"></i> Start recording';
    btn.dataset.recording = '';
    $('tryRecordTimer').textContent = '—';
    recState = { recorder: null, stream: null, chunks: [], startedAt: 0, mime: '', timer: null };
  }

  function toggleRecording() {
    const btn = $('tryRecordBtn');
    if (btn.dataset.recording === '1') stopRecording();
    else startRecording();
  }

  // ---------- Diagnostics ----------
  // Word-level diff: mark whether each target word appears in the source (case-insensitive, punctuation-tolerant).
  function diffWords(source, target) {
    const normalize = (s) => String(s || '').toLowerCase().replace(/[.,!?;:«»"']/g, '').split(/\s+/).filter(Boolean);
    const srcSet = new Set(normalize(source));
    const tgtWords = String(target || '').split(/(\s+)/);
    return tgtWords.map((tok) => {
      if (/^\s+$/.test(tok) || !tok) return escape(tok);
      const norm = tok.toLowerCase().replace(/[.,!?;:«»"']/g, '');
      const matched = srcSet.has(norm);
      return `<span style="${matched ? '' : 'background:#4a2d2d; color:#ffa8a8; padding:1px 3px; border-radius:2px;'}">${escape(tok)}</span>`;
    }).join('');
  }

  function timingBar(label, ms, maxMs) {
    const pct = Math.max(3, Math.min(100, (ms / maxMs) * 100));
    const color = ms < 2000 ? '#4db33d' : ms < 10000 ? '#f59e0b' : '#dc3545';
    return `
      <div style="margin:6px 0;">
        <div style="display:flex; justify-content:space-between; font-size:12px; color:#cbd5e1; margin-bottom:2px;">
          <span>${escape(label)}</span>
          <span><code style="color:inherit;">${ms.toFixed(0)} ms</code></span>
        </div>
        <div style="height:6px; background:#0f1629; border-radius:3px; overflow:hidden;">
          <div style="height:100%; width:${pct}%; background:${color};"></div>
        </div>
      </div>`;
  }

  function renderSmokeResult(data, kind) {
    const pass = data && data.ok === true;
    const hasSTT = Boolean(data?.transcript);
    const timings = data?.timings || {};
    const maxMs = Math.max(timings.tts || 0, timings.stt || 0, 1000);

    const badge = pass
      ? '<span style="display:inline-block; padding:4px 10px; background:#1d3b1d; color:#4db33d; border-radius:4px; font-weight:600; font-size:12px;"><i class="fas fa-check-circle"></i> PASS</span>'
      : '<span style="display:inline-block; padding:4px 10px; background:#3b1d1d; color:#ff7a7a; border-radius:4px; font-weight:600; font-size:12px;"><i class="fas fa-times-circle"></i> FAIL</span>';

    const textBlock = hasSTT ? `
      <div style="margin-top:12px;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px;">Spoken → Heard (word-level diff)</div>
        <div style="padding:10px 12px; background:#0f1629; border:1px solid #2a3145; border-radius:4px; font-size:13px; line-height:1.5;">
          <div style="color:#888; margin-bottom:6px;"><i class="fas fa-volume-high" style="color:#7cf0ff;"></i> ${escape(data.text || '—')}</div>
          <div><i class="fas fa-microphone" style="color:#f59e0b;"></i> ${diffWords(data.text, data.transcript)}</div>
        </div>
        <div style="font-size:11px; color:#888; margin-top:4px;">Red = word in transcript not in original; unmarked = matched.</div>
      </div>
    ` : `
      <div style="margin-top:12px;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px;">Synthesized</div>
        <div style="padding:10px 12px; background:#0f1629; border:1px solid #2a3145; border-radius:4px; font-size:13px;">
          <i class="fas fa-volume-high" style="color:#7cf0ff;"></i> ${escape(data?.text || '—')}
        </div>
      </div>
    `;

    const timingBlock = `
      <div style="margin-top:12px;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:4px;">Timings</div>
        ${typeof timings.tts === 'number' ? timingBar('TTS (synthesis)', timings.tts, maxMs) : ''}
        ${typeof timings.stt === 'number' ? timingBar('STT (transcription)', timings.stt, maxMs) : ''}
      </div>
    `;

    const audioPath = data?.audioPath ? `<div style="margin-top:8px; font-size:11px; color:#666;">Audio saved on Voix server: <code style="color:inherit;">${escape(data.audioPath)}</code></div>` : '';

    return `
      <div style="padding:16px; background:#0a0f1d; border:1px solid #2a3145; border-radius:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:14px; font-weight:600; color:#cbd5e1;">${escape(kind)} — ${new Date().toLocaleTimeString()}</div>
          ${badge}
        </div>
        ${textBlock}
        ${timingBlock}
        ${audioPath}
      </div>
    `;
  }

  async function runDiag(url, label) {
    const host = $('smokeResult');
    const raw = $('diagRaw');
    host.style.display = 'block';
    host.innerHTML = `<div style="padding:12px; color:#888;"><i class="fas fa-spinner fa-spin"></i> Running ${escape(label)}…</div>`;
    raw.textContent = '';
    try {
      const { data } = await jsonFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      host.innerHTML = renderSmokeResult(data, label);
      raw.textContent = JSON.stringify(data, null, 2);
      showToast(`${label}: ${data?.ok ? 'passed' : 'did not pass — see result'}`, data?.ok ? 'success' : 'error');
    } catch (err) {
      host.innerHTML = `<div style="padding:16px; background:#3b1d1d; color:#ff7a7a; border-radius:6px;"><strong>${escape(label)} failed:</strong> ${escape(err.message)}</div>`;
      raw.textContent = err.stack || err.message;
      showToast(`${label} failed: ${err.message}`, 'error');
    }
  }

  // ---------- Quick bake-off ----------
  function bakeoffCard(row) {
    const palette = row.status === 'pass'
      ? { bg: '#0f2a18', fg: '#4db33d', label: 'PASS' }
      : row.status === 'warn'
        ? { bg: '#2f260e', fg: '#f59e0b', label: 'CHECK' }
        : { bg: '#3b1d1d', fg: '#ff7a7a', label: 'FAIL' };

    return `
      <div style="padding:14px; background:#0f1629; border:1px solid #2a3145; border-radius:6px; min-height:150px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px;">
          <div style="font-weight:600; color:#cbd5e1;">${escape(row.title)}</div>
          <span style="padding:3px 8px; border-radius:4px; background:${palette.bg}; color:${palette.fg}; font-size:11px; font-weight:700;">${palette.label}</span>
        </div>
        <div style="font-size:12px; color:#94a3b8; line-height:1.5;">${row.lines.map((line) => `<div>${escape(line)}</div>`).join('')}</div>
      </div>
    `;
  }

  function renderBakeoff(rows) {
    const host = $('voiceBakeoffResult');
    if (!host) return;
    host.innerHTML = rows.map(bakeoffCard).join('');
  }

  async function timedJsonFetch(url, opts = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const payload = await jsonFetch(url, { ...opts, signal: controller.signal });
      return { payload, ms: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }

  function payloadData(payload) {
    return payload?.data || payload || {};
  }

  function browserBakeoffRow() {
    const hasMic = Boolean(navigator.mediaDevices?.getUserMedia);
    const hasRecorder = typeof MediaRecorder !== 'undefined';
    const hasSpeechRecognition = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasTts = Boolean(window.speechSynthesis);
    const ok = hasMic && hasRecorder && hasSpeechRecognition && hasTts;
    return {
      title: 'Browser',
      status: ok ? 'pass' : 'warn',
      lines: [
        `mic capture: ${hasMic && hasRecorder ? 'available' : 'missing'}`,
        `browser STT: ${hasSpeechRecognition ? 'available' : 'missing'}`,
        `browser TTS: ${hasTts ? 'available' : 'missing'}`,
        ok ? 'ready for browser-only chat voice' : 'browser-only mode may need VoiX fallback'
      ]
    };
  }

  async function hybridBakeoffRow() {
    const health = await timedJsonFetch('/api/voix/health', {}, 10000);
    const healthData = payloadData(health.payload);
    const smoke = await timedJsonFetch('/api/voix/diagnostics/tts-smoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'OK.' })
    }, 45000);
    const smokeData = payloadData(smoke.payload);
    const provider = smokeData.provider || 'unknown';
    const ttsMs = smokeData.timings?.tts_ms ?? smokeData.timings?.tts;
    return {
      title: 'Hybrid',
      status: healthData.status === 'ok' && smokeData.ok ? 'pass' : 'fail',
      lines: [
        `Core -> VoiX health: ${healthData.status || 'unknown'} (${health.ms} ms)`,
        `TTS provider: ${provider}`,
        `TTS smoke: ${typeof ttsMs === 'number' ? `${ttsMs} ms` : `${smoke.ms} ms round-trip`}`,
        'browser mic/playback with VoiX STT/TTS'
      ]
    };
  }

  async function nativeBakeoffRow() {
    let startedByBakeoff = false;
    const before = await timedJsonFetch('/api/voix/sessions/status', {}, 10000);
    const beforeData = payloadData(before.payload);
    let statusData = beforeData;
    let startMs = before.ms;

    if (!beforeData.running) {
      const started = await timedJsonFetch('/api/voix/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }, 25000);
      startedByBakeoff = true;
      startMs = started.ms;
      statusData = payloadData(started.payload);
    }

    if (startedByBakeoff) {
      try {
        await timedJsonFetch('/api/voix/sessions/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        }, 15000);
      } catch (err) {
        console.warn('Failed to stop bake-off native VoiX session:', err);
      }
    }

    return {
      title: 'Native VoiX',
      status: statusData.running || beforeData.running || startedByBakeoff ? 'pass' : 'warn',
      lines: [
        beforeData.running ? 'session was already running' : `session start probe: ${startMs} ms`,
        `state: ${statusData.state || 'unknown'}`,
        `brain: ${statusData.brain || 'unknown'}`,
        startedByBakeoff ? 'session stopped after probe' : 'existing session left untouched'
      ]
    };
  }

  async function runVoiceBakeoff() {
    const btn = $('voiceBakeoffBtn');
    const meta = $('voiceBakeoffMeta');
    const rows = [browserBakeoffRow()];
    renderBakeoff(rows);
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running...';
    meta.textContent = 'Running hybrid and native checks...';

    try {
      try {
        rows.push(await hybridBakeoffRow());
      } catch (err) {
        rows.push({
          title: 'Hybrid',
          status: 'fail',
          lines: [`Core -> VoiX failed: ${err.message}`, 'Check /api/voix/health and VoiX process.']
        });
      }
      renderBakeoff(rows);

      try {
        rows.push(await nativeBakeoffRow());
      } catch (err) {
        rows.push({
          title: 'Native VoiX',
          status: 'fail',
          lines: [`Native session probe failed: ${err.message}`, 'Check audio device config and VoiX logs.']
        });
      }
      renderBakeoff(rows);
      meta.textContent = `Last run ${new Date().toLocaleTimeString()}`;
      showToast('Voice bake-off complete', 'success');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-play"></i> Run quick bake-off';
    }
  }

  // ---------- Try synthesis — interactive TTS ----------
  const TRY_SYNTH_TIMEOUT_MS = 60000;

  async function trySynth() {
    const btn = $('trySynthBtn');
    const resultBox = $('trySynthResult');
    const audio = $('trySynthAudio');
    const meta = $('trySynthMeta');
    const text = $('trySynthText').value.trim();
    const voice = $('trySynthVoice').value.trim();
    if (!text) { showToast('Enter some text to synthesize', 'error'); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Synthesizing…';
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRY_SYNTH_TIMEOUT_MS);
    try {
      const resp = await fetch('/api/voix/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voice || undefined }),
        signal: controller.signal
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const elapsed = performance.now() - t0;
      if (audio.src) URL.revokeObjectURL(audio.src);
      audio.src = URL.createObjectURL(blob);
      resultBox.style.display = 'block';
      const kb = (blob.size / 1024).toFixed(1);
      meta.innerHTML = `<code>${escape(blob.type || 'audio')}</code> &bull; ${kb} KB &bull; round-trip ${elapsed.toFixed(0)} ms${voice ? ` &bull; voice: <code>${escape(voice)}</code>` : ''}`;
      try { await audio.play(); } catch (playErr) {
        meta.innerHTML += ` <span style="color:#f59e0b;">(auto-play blocked — click ▶ to play)</span>`;
      }
      showToast('Synthesis ready', 'success');
    } catch (err) {
      resultBox.style.display = 'block';
      const msg = err.name === 'AbortError'
        ? `Timed out after ${TRY_SYNTH_TIMEOUT_MS / 1000}s`
        : err.message;
      meta.innerHTML = `<span style="color:#ff7a7a;">Error: ${escape(msg)}</span>`;
      audio.removeAttribute('src');
      showToast(`Synthesis failed: ${msg}`, 'error');
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-volume-high"></i> Speak';
    }
  }

  // ---------- Bootstrap ----------
  async function loadAll() {
    await Promise.all([
      loadSettings(),
      loadHealth(),
      loadConfig(),
      loadMetrics(),
      loadDevices(),
      loadModels()
    ]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateBrowserMicNotice();
    $('voiceRefreshBtn').addEventListener('click', loadAll);
    $('voiceMode').addEventListener('change', (event) => {
      applyVoiceModePresetToForm(event.target.value);
      renderVoiceModeMeta(event.target.value);
      $('voiceModeSrc').textContent = 'preset pending apply';
    });
    $('voiceModeApplyBtn').addEventListener('click', applyVoiceMode);
    $('cfgSaveBtn').addEventListener('click', saveSettings);
    $('cfgClearBtn').addEventListener('click', clearOverrides);
    $('voixTtsProviderSave').addEventListener('click', saveVoixTtsProvider);
    $('voiceBakeoffBtn').addEventListener('click', runVoiceBakeoff);
    $('smokeBtn').addEventListener('click', () => runDiag('/api/voix/diagnostics/smoke', 'Full smoke test'));
    $('ttsSmokeBtn').addEventListener('click', () => runDiag('/api/voix/diagnostics/tts-smoke', 'TTS smoke test'));
    $('trySynthBtn').addEventListener('click', trySynth);
    $('trySynthText').addEventListener('keydown', (e) => { if (e.key === 'Enter') trySynth(); });
    $('tryRecordBtn').addEventListener('click', toggleRecording);
    loadAll();
  });
})();

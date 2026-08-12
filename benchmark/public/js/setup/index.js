// Setup wizard — first-run configuration for AgentX Benchmark
// Single-page flow: enter Ollama IP → test → see models → auto-pick judge → save

import { showToast } from '../components/toast.js';

const $ = (sel) => document.querySelector(sel);

let discoveredModels = [];
let resolvedUrl = '';

// ── Init: check if already configured ──────────────────────────────────────

(async function init() {
  try {
    const res = await fetch('/api/setup/status');
    const data = await res.json();
    if (data.configured) {
      $('#already-configured').style.display = '';
    }
  } catch { /* ignore — show wizard anyway */ }
})();


// ── Step 1: Test Connection ────────────────────────────────────────────────

$('#btn-connect').addEventListener('click', testConnection);
$('#ollama-ip').addEventListener('keydown', e => {
  if (e.key === 'Enter') testConnection();
});

async function testConnection() {
  const raw = $('#ollama-ip').value.trim();
  if (!raw) return showStatus('connect-status', 'Enter an IP or hostname.', 'error');

  // Build URL: if user types full URL with port, use as-is; otherwise add default port
  let url;
  if (/:\d+/.test(raw)) {
    // User included a port
    url = raw;
  } else {
    url = raw + ':11434';
  }
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;

  const btn = $('#btn-connect');
  btn.disabled = true;
  btn.textContent = 'Testing\u2026';
  showStatus('connect-status', `Connecting to ${url}\u2026`, 'loading');

  try {
    const res = await fetch('/api/setup/test-host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Connection failed');

    resolvedUrl = data.url || url;
    discoveredModels = data.models || [];
    const n = discoveredModels.length;

    showStatus('connect-status',
      `\u2713 Connected! Found ${n} model${n !== 1 ? 's' : ''}.`,
      'success');

    renderModels();
    renderJudge();
  } catch (err) {
    showStatus('connect-status', `\u2717 ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}


// ── Step 2: Show discovered models ─────────────────────────────────────────

function renderModels() {
  const step = $('#step-models');
  step.style.display = '';

  const n = discoveredModels.length;
  $('#models-subtitle').textContent =
    `${n} model${n !== 1 ? 's' : ''} available on your Ollama instance:`;

  const grid = $('#model-grid');

  // Sort by parameter size ascending, then name
  const sorted = [...discoveredModels].sort((a, b) => {
    const sa = parseParamSize(a.parameterSize);
    const sb = parseParamSize(b.parameterSize);
    if (sa !== sb) return sa - sb;
    return (a.name || '').localeCompare(b.name || '');
  });

  grid.innerHTML = sorted.map(m => {
    const sizeClass = sizeTag(m.parameterSize);
    const disk = formatBytes(m.size);
    return `
      <div class="model-card-mini">
        <span class="mc-name">${esc(m.name)}</span>
        <div class="mc-meta">
          ${m.parameterSize ? `<span class="mc-badge ${sizeClass}">${esc(m.parameterSize)}</span>` : ''}
          ${m.quantization ? `<span class="mc-badge">${esc(m.quantization)}</span>` : ''}
          ${disk ? `<span class="mc-badge">${disk}</span>` : ''}
          ${m.family ? `<span class="mc-badge">${esc(m.family)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  step.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}


// ── Step 3: Judge auto-selection ───────────────────────────────────────────

function renderJudge() {
  const step = $('#step-judge');
  step.style.display = '';

  const select = $('#judge-model');
  const best = autoSelectJudge(discoveredModels);

  select.innerHTML = discoveredModels
    .map(m => {
      const sel = m.name === best ? 'selected' : '';
      const info = [m.parameterSize, m.quantization].filter(Boolean).join(' \u00b7 ');
      return `<option value="${esc(m.name)}" ${sel}>${esc(m.name)}${info ? ' (' + esc(info) + ')' : ''}</option>`;
    })
    .join('');
}

/** Pick the best available judge model. Prefers known-good small models. */
function autoSelectJudge(models) {
  const names = models.map(m => norm(m.name));

  // Known good judges (priority order) — small models good at evaluation
  const PREFERRED = [
    'llama3.1:8b', 'qwen2.5:7b', 'gemma2:9b', 'mistral:7b',
    'llama3.2:3b', 'phi3:3.8b', 'phi4-mini',
    'llama3.1', 'qwen2.5', 'gemma2', 'mistral', 'llama3.2', 'phi3'
  ];

  // Exact match
  for (const j of PREFERRED) {
    const match = models.find(m => norm(m.name) === j);
    if (match) return match.name;
  }

  // Prefix match
  for (const j of PREFERRED) {
    const match = models.find(m => norm(m.name).startsWith(j));
    if (match) return match.name;
  }

  // Fallback: smallest model between 1B and 10B
  const small = models
    .filter(m => { const p = parseParamSize(m.parameterSize); return p >= 1 && p <= 10; })
    .sort((a, b) => parseParamSize(a.parameterSize) - parseParamSize(b.parameterSize));
  if (small.length) return small[0].name;

  // Last resort: first model
  return models[0]?.name || '';
}


// ── Save config ────────────────────────────────────────────────────────────

$('#btn-save').addEventListener('click', saveConfig);

async function saveConfig() {
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';

  try {
    const config = {
      hosts: [{ name: 'Ollama', url: resolvedUrl }],
      judge: {
        model: $('#judge-model').value,
        host: resolvedUrl
      }
    };

    const res = await fetch('/api/setup/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Save failed');
    }

    window.location.href = '/';
  } catch (err) {
    showToast('Error saving configuration: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Save & Start Benchmarking \u2192';
  }
}


// ── Helpers ────────────────────────────────────────────────────────────────

function norm(s)  { return String(s || '').trim().replace(/:latest$/i, ''); }

function parseParamSize(s) {
  if (!s) return 0;
  const m = String(s).match(/([\d.]+)\s*[bB]/);
  return m ? parseFloat(m[1]) : 0;
}

function sizeTag(paramSize) {
  const n = parseParamSize(paramSize);
  if (n <= 0) return '';
  if (n <= 4) return 'size-s';
  if (n <= 10) return 'size-m';
  if (n <= 20) return 'size-l';
  return 'size-xl';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-msg ' + (type || '');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

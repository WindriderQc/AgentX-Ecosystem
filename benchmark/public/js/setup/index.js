// Setup wizard — first-run configuration for AgentX Benchmark
// Single-page flow: connect to Ollama → inspect installed models → explicitly pick judge → save

import { showToast } from '../components/toast.js';

const $ = (sel) => document.querySelector(sel);

let discoveredModels = [];
let resolvedUrl = '';
let configuredHosts = [];
let configuredJudge = null;
let probeRevision = 0;
let activeProbeController = null;

const setupParams = new URLSearchParams(window.location.search);
const judgeFocused = setupParams.get('focus') === 'judge';
const returnPath = safeReturnPath(
  setupParams.get('return'),
  judgeFocused ? '/courthouse' : '/'
);

configureReturnLink();

// ── Init: hydrate the configured host before asking for duplicate input ────

(async function init() {
  const initRevision = probeRevision;
  try {
    const res = await fetch('/api/setup/status');
    const data = await res.json();
    configuredHosts = Array.isArray(data.hosts) ? data.hosts : [];
    configuredJudge = data.judge || null;

    if (data.configured) $('#already-configured').style.display = '';

    const initialHost = renderConfiguredHosts(configuredHosts, configuredJudge);
    if (initRevision !== probeRevision) return;
    if (initialHost) $('#ollama-ip').value = initialHost.url;

    if (judgeFocused && initialHost) {
      await probeConnection(initialHost.url, {
        preferredJudge: sameEndpoint(configuredJudge?.host, initialHost.url)
          ? configuredJudge?.model
          : '',
        focusJudge: true
      });
    } else if (judgeFocused) {
      $('#ollama-ip').focus();
    }
  } catch {
    // Setup status is advisory. Keep the manual connection flow usable.
    if (judgeFocused && initRevision === probeRevision) $('#ollama-ip').focus();
  }
})();


// ── Step 1: Test Connection ────────────────────────────────────────────────

$('#btn-connect').addEventListener('click', testConnection);
$('#ollama-ip').addEventListener('keydown', event => {
  if (event.key === 'Enter') testConnection();
});
$('#ollama-ip').addEventListener('input', () => {
  const hadResolvedState = !!(resolvedUrl || activeProbeController);
  invalidateProbeState();
  if (hadResolvedState) {
    showStatus('connect-status', 'Endpoint changed. Test the connection again.', '');
  }
});

async function testConnection() {
  const raw = $('#ollama-ip').value.trim();
  if (!raw) return showStatus('connect-status', 'Enter an IP, hostname, or URL.', 'error');

  await probeConnection(raw, {
    preferredJudge: sameEndpoint(configuredJudge?.host, raw)
      ? configuredJudge?.model
      : ''
  });
}

async function probeConnection(raw, { preferredJudge = '', focusJudge = false } = {}) {
  const url = buildHostUrl(raw);
  const revision = invalidateProbeState();
  const controller = new AbortController();
  activeProbeController = controller;
  const btn = $('#btn-connect');
  btn.disabled = true;
  btn.textContent = 'Testing\u2026';
  showStatus('connect-status', `Connecting to ${url}\u2026`, 'loading');

  try {
    const res = await fetch('/api/setup/test-host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal
    });
    const data = await res.json();
    if (revision !== probeRevision) return false;

    if (!res.ok || !data.success) {
      throw setupRequestError(data, 'Connection failed');
    }

    resolvedUrl = data.url || url;
    discoveredModels = Array.isArray(data.models) ? data.models : [];
    const count = discoveredModels.length;

    $('#ollama-ip').value = resolvedUrl;
    showStatus(
      'connect-status',
      `\u2713 Connected. Found ${count} installed model${count === 1 ? '' : 's'}.`,
      'success'
    );

    renderModels();
    renderJudge(preferredJudge);

    const configuredSelect = $('#configured-host');
    const matchingHost = configuredHosts.find(host => sameEndpoint(host.url, resolvedUrl));
    if (configuredSelect && matchingHost) configuredSelect.value = matchingHost.url;

    if (focusJudge) focusJudgeChooser();
    return true;
  } catch (err) {
    if (revision !== probeRevision || controller.signal.aborted) return false;
    showStatus('connect-status', `\u2717 ${err.message}`, 'error');
    if (focusJudge) revealUnavailableJudge(err.message);
    return false;
  } finally {
    if (revision !== probeRevision || activeProbeController !== controller) return;
    activeProbeController = null;
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}


// ── Step 2: Show discovered models ─────────────────────────────────────────

function renderModels() {
  const step = $('#step-models');
  step.style.display = '';

  const count = discoveredModels.length;
  $('#models-subtitle').textContent =
    `${count} model${count === 1 ? '' : 's'} installed on this Ollama endpoint:`;

  const sorted = [...discoveredModels].sort((left, right) => {
    const leftSize = parseParamSize(left.parameterSize);
    const rightSize = parseParamSize(right.parameterSize);
    if (leftSize !== rightSize) return leftSize - rightSize;
    return (left.name || '').localeCompare(right.name || '');
  });

  $('#model-grid').innerHTML = sorted.map(model => {
    const disk = formatBytes(model.size);
    return `
      <div class="model-card-mini">
        <span class="mc-name">${esc(model.name)}</span>
        <div class="mc-meta">
          ${model.parameterSize ? `<span class="mc-badge ${sizeTag(model.parameterSize)}">${esc(model.parameterSize)}</span>` : ''}
          ${model.quantization ? `<span class="mc-badge">${esc(model.quantization)}</span>` : ''}
          ${disk ? `<span class="mc-badge">${disk}</span>` : ''}
          ${model.family ? `<span class="mc-badge">${esc(model.family)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  step.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'nearest'
  });
}


// ── Step 3: Explicit judge selection ───────────────────────────────────────

function renderJudge(preferredModel = '') {
  const step = $('#step-judge');
  const select = $('#judge-model');
  step.style.display = '';

  const emptyLabel = discoveredModels.length
    ? 'Choose an installed judge model…'
    : 'No installed models found on this host';
  select.innerHTML = `<option value="">${emptyLabel}</option>` + discoveredModels
    .map(model => {
      const info = [model.parameterSize, model.quantization].filter(Boolean).join(' \u00b7 ');
      return `<option value="${esc(model.name)}">${esc(model.name)}${info ? ' (' + esc(info) + ')' : ''}</option>`;
    })
    .join('');

  const restored = discoveredModels.find(model =>
    normalizeModelName(model.name) === normalizeModelName(preferredModel)
  );
  select.value = restored?.name || '';
  select.disabled = discoveredModels.length === 0;
  $('#btn-save').disabled = !hasVerifiedJudgeSelection();
  showStatus(
    'judge-status',
    restored
      ? `Restored the explicitly configured judge ${restored.name}.`
      : 'Choose one installed model explicitly; no default will be inferred.',
    restored ? 'success' : ''
  );

  select.onchange = () => {
    $('#btn-save').disabled = !hasVerifiedJudgeSelection();
    showStatus(
      'judge-status',
      select.value ? `Judge selected: ${select.value}` : 'Choose one installed model explicitly.',
      select.value ? 'success' : ''
    );
  };
}


// ── Save config ────────────────────────────────────────────────────────────

$('#btn-save').addEventListener('click', saveConfig);

async function saveConfig() {
  const selectedJudge = $('#judge-model').value;
  if (!hasVerifiedJudgeSelection()) {
    showToast('Test the current endpoint and choose an installed judge model before saving.', 'error');
    return;
  }

  const saveRevision = probeRevision;
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';

  try {
    const config = {
      hosts: hostsForSave(),
      judge: {
        model: selectedJudge,
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
      throw setupRequestError(data, 'Save failed');
    }

    window.location.href = returnPath;
  } catch (err) {
    showToast('Error saving configuration: ' + err.message, 'error');
    if (saveRevision === probeRevision) {
      btn.disabled = !hasVerifiedJudgeSelection();
      btn.textContent = saveButtonLabel();
    }
  }
}


// ── Existing configuration and return-path helpers ────────────────────────

function renderConfiguredHosts(hosts, judge) {
  if (!hosts.length) return null;

  const field = $('#configured-host-field');
  const select = $('#configured-host');
  field.hidden = false;
  select.innerHTML = hosts.map(host =>
    `<option value="${esc(host.url)}">${esc(host.name || host.url)} \u00b7 ${esc(host.url)}</option>`
  ).join('');

  const initialHost = hosts.find(host => sameEndpoint(host.url, judge?.host)) || hosts[0];
  select.value = initialHost.url;
  select.addEventListener('change', async () => {
    const host = hosts.find(entry => entry.url === select.value);
    if (!host) return;
    $('#ollama-ip').value = host.url;
    await probeConnection(host.url, {
      preferredJudge: sameEndpoint(judge?.host, host.url) ? judge?.model : '',
      focusJudge: judgeFocused
    });
  });
  return initialHost;
}

function hostsForSave() {
  const currentIndex = configuredHosts.findIndex(host => sameEndpoint(host.url, resolvedUrl));
  if (currentIndex < 0) return [{ name: 'Ollama', url: resolvedUrl }];

  return configuredHosts.map((host, index) => ({
    name: host.name || `Host ${index + 1}`,
    url: host.url,
    vramMb: host.vramMb || 0
  }));
}

function safeReturnPath(raw, fallback) {
  const candidate = String(raw || fallback || '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  try {
    const parsed = new URL(candidate, window.location.origin);
    if (parsed.origin !== window.location.origin) return fallback;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}

function returnLabel() {
  if (returnPath.startsWith('/courthouse')) return 'Courthouse';
  if (returnPath.startsWith('/profiler')) return 'Profiler';
  return 'Benchmark';
}

function saveButtonLabel() {
  return returnPath === '/'
    ? 'Save & Start Benchmarking \u2192'
    : `Save & Return to ${returnLabel()} \u2192`;
}

function configureReturnLink() {
  const link = $('#setup-return-link');
  if (!link) return;
  link.href = returnPath;
  link.textContent = `\u2190 Back to ${returnLabel()}`;
  link.hidden = false;
  $('#btn-save').textContent = saveButtonLabel();
}


// ── Small helpers ──────────────────────────────────────────────────────────

function buildHostUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!/:\d+(?:\/|$)/.test(url)) url += ':11434';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url;
}

function sameEndpoint(left, right) {
  if (!left || !right) return false;
  return buildHostUrl(left).toLowerCase() === buildHostUrl(right).toLowerCase();
}

function normalizeModelName(name) {
  return String(name || '').trim().replace(/:latest$/i, '');
}

function hasVerifiedJudgeSelection() {
  const selected = normalizeModelName($('#judge-model').value);
  return !!resolvedUrl && !!selected && discoveredModels.some(model =>
    normalizeModelName(model.name) === selected
  );
}

function invalidateProbeState() {
  const revision = ++probeRevision;
  activeProbeController?.abort();
  activeProbeController = null;
  resolvedUrl = '';
  discoveredModels = [];

  $('#step-models').style.display = 'none';
  $('#models-subtitle').textContent = '';
  $('#model-grid').innerHTML = '';

  $('#step-judge').style.display = 'none';
  const select = $('#judge-model');
  select.innerHTML = '';
  select.value = '';
  select.disabled = true;
  select.onchange = null;
  showStatus('judge-status', '', '');

  const save = $('#btn-save');
  save.disabled = true;
  save.textContent = saveButtonLabel();

  const connect = $('#btn-connect');
  connect.disabled = false;
  connect.textContent = 'Test Connection';
  return revision;
}

function setupRequestError(payload, fallback) {
  const error = new Error(payload?.error || fallback);
  error.code = payload?.code || 'SETUP_REQUEST_FAILED';
  return error;
}

function focusJudgeChooser() {
  const step = $('#step-judge');
  const select = $('#judge-model');
  requestAnimationFrame(() => {
    step.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center'
    });
    if (select.disabled) $('#judge-status').focus({ preventScroll: true });
    else select.focus({ preventScroll: true });
  });
}

function revealUnavailableJudge(message) {
  const step = $('#step-judge');
  const select = $('#judge-model');
  step.style.display = '';
  select.innerHTML = '<option value="">Reconnect to load installed models</option>';
  select.disabled = true;
  $('#btn-save').disabled = true;
  showStatus('judge-status', `Judge choices unavailable: ${message}`, 'error');
  const status = $('#judge-status');
  status.tabIndex = -1;
  status.focus();
}

function parseParamSize(value) {
  if (!value) return 0;
  const match = String(value).match(/([\d.]+)\s*[bB]/);
  return match ? parseFloat(match[1]) : 0;
}

function sizeTag(parameterSize) {
  const size = parseParamSize(parameterSize);
  if (size <= 0) return '';
  if (size <= 4) return 'size-s';
  if (size <= 10) return 'size-m';
  if (size <= 20) return 'size-l';
  return 'size-xl';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function showStatus(id, message, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = 'status-msg ' + (type || '');
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

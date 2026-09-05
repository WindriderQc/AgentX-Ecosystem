function normalizeModelName(name) {
  return String(name || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function hasModel(models, target) {
  const normalizedTarget = normalizeModelName(target);
  return (models || []).some(model => normalizeModelName(model) === normalizedTarget);
}

function ensurePanel(card) {
  let panel = card.querySelector('.mp-test-panel');
  if (panel) return panel;

  panel = document.createElement('div');
  panel.className = 'mp-test-panel';
  const note = card.querySelector('.mp-host-note');
  if (note) note.after(panel);
  else card.appendChild(panel);
  return panel;
}

function renderStages(panel, stages, activeKey, extra = '') {
  const activeIndex = stages.findIndex(stage => stage.key === activeKey);
  panel.innerHTML = `<div class="mp-test-stages">
    ${stages.map((stage, index) => {
      const done = index < activeIndex;
      const active = stage.key === activeKey;
      const icon = done ? '\u2713' : active ? '\u25B6' : '\u25CB';
      const className = done ? 'mp-ts-done' : active ? 'mp-ts-active' : 'mp-ts-pending';
      return `<div class="mp-ts ${className}">${icon} ${stage.label}</div>`;
    }).join('')}
  </div>${extra}`;
}

export async function runBaselineProbe({ button, card, baselineModel, api, escapeHtml, onComplete }) {
  const hostId = button.dataset.hostId;
  const hostName = card.querySelector('.mp-host-name')?.textContent?.trim() || hostId;
  const panel = ensurePanel(card);
  const stages = [
    { key: 'connect', label: 'Checking host connectivity and model inventory' },
    { key: 'prepare', label: `Ensuring ${baselineModel} is installed` },
    { key: 'probe', label: `Loading ${baselineModel} and running the baseline probe` },
    { key: 'sync', label: 'Syncing model registry' }
  ];
  let pulled = false;

  button.disabled = true;
  try {
    renderStages(panel, stages, 'connect');
    button.textContent = 'Checking host...';
    const live = await api.getHostStatus(hostId);
    if (live?.status !== 'online') throw new Error(live?.error || `${hostName} is offline`);

    const missing = !hasModel(live.models, baselineModel);
    stages[1].label = missing
      ? `Pulling ${baselineModel} to ${hostName}`
      : `${baselineModel} already installed on ${hostName}`;
    renderStages(
      panel,
      stages,
      'prepare',
      missing
        ? `<div class="mp-test-auto-pull">Model missing — downloading it automatically before the test. The probe will continue when the pull completes.</div>`
        : ''
    );
    button.textContent = missing ? `Pulling ${baselineModel}...` : 'Preparing baseline...';

    const preparation = await api.ensureHostBaseline(hostId);
    pulled = preparation?.pulled === true;

    renderStages(panel, stages, 'probe');
    button.textContent = 'Running baseline probe...';
    const snap = await api.runSingleHostTest(baselineModel, hostId);
    pulled = pulled || snap?.preparation?.pulled === true;

    renderStages(panel, stages, 'sync');
    try { await api.syncHostModels(hostId); } catch (_) {}

    if (snap?.status !== 'pass') throw new Error(snap?.error || snap?.status || 'Unknown test failure');

    panel.innerHTML = `<div class="mp-test-result mp-test-result--pass">
      <strong>\u2713 Test Passed</strong>
      ${pulled ? `<div class="mp-test-auto-pull mp-test-auto-pull--done">\u2713 Pulled ${escapeHtml(baselineModel)} to ${escapeHtml(hostName)} automatically.</div>` : ''}
      <div class="mp-test-metrics">
        <span><strong>${Number(snap.tokensPerSec).toFixed(1)}</strong> tok/s</span>
        <span><strong>${Math.round(snap.latencyMs)}</strong> ms latency</span>
        ${snap.ttftMeasurement === 'streamed_wall_clock' && snap.timeToFirstTokenMs ? `<span><strong>${Math.round(snap.timeToFirstTokenMs)}</strong> ms TTFT</span>` : ''}
        ${snap.promptEvalTokensPerSec ? `<span><strong>${Number(snap.promptEvalTokensPerSec).toFixed(1)}</strong> prompt tok/s</span>` : ''}
        ${snap.vramUsedMiB ? `<span><strong>${(snap.vramUsedMiB / 1024).toFixed(1)}</strong> GB VRAM</span>` : ''}
        <span>ctx: <strong>${snap.numCtx || '?'}</strong></span>
      </div>
    </div>`;
    button.textContent = `${Number(snap.tokensPerSec).toFixed(1)} tok/s \u2713`;
    onComplete?.({ snap, preparation, pulled });
  } catch (err) {
    panel.innerHTML = `<div class="mp-test-result mp-test-result--fail">
      <strong>\u2717 Baseline Test Failed</strong>
      <div>${escapeHtml(err.message || 'Unknown error')}</div>
    </div>`;
    button.textContent = 'Test Failed';
    console.error('[hosts] baseline test error:', err);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = `Retest Baseline (${baselineModel})`;
    }, 3000);
  }
}

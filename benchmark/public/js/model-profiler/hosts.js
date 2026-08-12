/**
 * Model Profiler — Hosts Renderer
 * Renders the Hosts section and drives the host-test workflow.
 */

import { openProfileHostDialog } from './components/profile-host-dialog.js';
import { runBaselineProbe } from './components/baseline-probe.js';

const HOST_TEST_POLL_MS = 1500;
const FLEET_POLL_MS = 2000;
let _baselineModel = 'qwen2.5:3b'; // overridden from /api/profiler/hosts/test/config

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function vramMibToGb(mib) {
  if (!mib) return '—';
  return (mib / 1024).toFixed(1) + ' GB';
}

function normalizeGpuName(name) {
  return String(name || '')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .trim();
}

function getHostIdentityName(host, probeState) {
  const configuredName = host.displayName || host.hostId || 'host';
  const agentName = probeState?.agent?.hostname;

  // Some configured names include hardware to disambiguate same-hostname boxes.
  // Once the live agent reports the real hostname, show hardware separately.
  if (agentName && configuredName.toLowerCase().startsWith(`${agentName.toLowerCase()}-`)) {
    return agentName;
  }

  return configuredName;
}

function summarizeGpuNames(gpus, fallbackName) {
  const names = (Array.isArray(gpus) ? gpus : [])
    .map(gpu => normalizeGpuName(gpu.name || gpu.gpuName))
    .filter(Boolean);
  if (!names.length && fallbackName) names.push(normalizeGpuName(fallbackName));
  if (!names.length) return '';

  const counts = new Map();
  names.forEach(name => counts.set(name, (counts.get(name) || 0) + 1));
  return Array.from(counts.entries())
    .map(([name, count]) => count > 1 ? `${count} x ${name}` : name)
    .join(' + ');
}

function getHostHardwareSummary(host, probeState) {
  const telemetry = probeState?.telemetry || {};
  const gpus = Array.isArray(telemetry.gpus) && telemetry.gpus.length
    ? telemetry.gpus
    : (Array.isArray(host.gpus) ? host.gpus : []);
  const gpuLabel = summarizeGpuNames(gpus, telemetry.gpuName);
  const liveTotal = Number(telemetry.vramTotalMiB || 0);
  const staticTotal = Number(host.gpu?.vramTotalMiB || host.baseline?.vramTotalMiB || 0);
  const total = liveTotal || staticTotal;

  if (gpuLabel && total) return `${gpuLabel} · ${vramMibToGb(total)}${liveTotal ? ' live' : ''}`;
  if (gpuLabel) return gpuLabel;
  if (total) return `${vramMibToGb(total)} VRAM`;
  return '';
}

function isHostOnline(host, probeState) {
  if (probeState && !probeState.loading && !probeState.error) {
    if (probeState.status === 'ready') return true;
    if (probeState.ollama?.ok) return true;
    if (probeState.status === 'offline') return false;
  }
  return host.status === 'online';
}

function fmtToks(n) {
  if (n == null) return '—';
  return Number(n).toFixed(1) + ' tok/s';
}

function relTime(ts) {
  if (!ts) return 'just now';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'recently';
  const diff = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Fit Report rendering ─────────────────────────────────────────────────
function fmtCtx(n) {
  if (!n) return '—';
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function fitToneClass(tone) {
  return tone === 'crit' ? 'mp-fit-badge--crit' : tone === 'warn' ? 'mp-fit-badge--warn' : 'mp-fit-badge--ok';
}

function estVerdictBadge(v) {
  const map = {
    'fits':      ['mp-fit-badge--ok',   'fits'],
    'tight':     ['mp-fit-badge--warn', 'tight'],
    'too-large': ['mp-fit-badge--crit', 'too large'],
    'unknown':   ['mp-fit-badge--muted','unknown']
  };
  const [cls, label] = map[v] || map.unknown;
  return `<span class="mp-fit-badge ${cls}">${esc(label)}</span>`;
}

const FIT_USE_CASES = ['general', 'coding', 'reasoning', 'chat', 'long-context'];

function fitComposite(dims, weights) {
  if (!dims || !weights) return null;
  let sum = 0, wsum = 0;
  for (const k of ['quality', 'speed', 'fit', 'context']) {
    if (dims[k] != null && weights[k] != null) { sum += weights[k] * dims[k]; wsum += weights[k]; }
  }
  return wsum > 0 ? Math.round(sum / wsum) : null;
}

function fitCompChip(score) {
  if (score == null) return '';
  const tone = score >= 75 ? 'mp-fit-comp--hi' : score >= 50 ? 'mp-fit-comp--mid' : 'mp-fit-comp--lo';
  return `<span class="mp-fit-comp ${tone}" title="composite fit score for the selected use-case (quality · speed · fit · context)">⬡${score}</span>`;
}

function fitMoeChip(m) {
  if (!m.moeActiveB) return '';
  return `<span class="mp-fit-moe" title="Mixture-of-Experts: ${m.moeActiveB}B active of ${m.paramB || '?'}B total — speed estimated from active params">MoE ${m.moeActiveB}B</span>`;
}

function renderFitReport(report, useCase) {
  if (!report || !report.host) return '<div class="mp-fit-empty">No report data.</div>';
  useCase = FIT_USE_CASES.includes(useCase) ? useCase : 'general';
  const h = report.host;
  const cap = report.capacity || {};
  const vram = report.vram || {};
  const rec = report.recommended;
  const recB = report.recommendedBenchmarked;
  const tm = report.throughputModel || {};
  const weights = (report.useCaseWeights || {})[useCase] || (report.useCaseWeights || {}).general || null;
  const vramStr = vram.totalMiB ? `${(vram.totalMiB / 1024).toFixed(1)} GB` : 'unknown';

  const pcie = (h.pcieGen && h.pcieWidth) ? `PCIe Gen${h.pcieGen} ×${h.pcieWidth}` : null;
  const baseStr = h.baseline
    ? `${h.baseline.tokensPerSec} tok/s · ${esc(h.baseline.referenceModel || 'baseline')}`
    : 'not tested';
  const headChips = [
    h.gpuName ? `<span class="mp-fit-chip"><b>${esc(h.gpuName)}</b></span>` : '',
    `<span class="mp-fit-chip">VRAM <b>${vramStr}</b> <span class="mp-fit-dim">${esc(vram.source || '')}</span></span>`,
    pcie ? `<span class="mp-fit-chip">${esc(pcie)}</span>` : '',
    h.cpuCores ? `<span class="mp-fit-chip">${h.cpuCores} cores</span>` : '',
    `<span class="mp-fit-chip">baseline <b>${esc(baseStr)}</b></span>`
  ].filter(Boolean).join('');

  const ucSelect = `<label class="mp-fit-uc"><span>optimize for</span><select class="mp-fit-usecase">${
    FIT_USE_CASES.map(u => `<option value="${u}"${u === useCase ? ' selected' : ''}>${u}</option>`).join('')
  }</select></label>`;

  const capBits = [
    `<b>${cap.installedCount || 0}</b> installed`,
    `<b>${cap.measuredCount || 0}</b> measured`,
    `<b>${cap.fitClean || 0}</b> clean`,
    cap.spills ? `<span class="mp-fit-warn"><b>${cap.spills}</b> spill</span>` : '',
    cap.largestRunnableParamsB ? `largest runnable <b>~${cap.largestRunnableParamsB}B</b> @Q4/8k` : ''
  ].filter(Boolean).join(' · ');

  // Composite per row, then sort copies by composite desc (nulls last).
  const withComp = list => (list || [])
    .map(m => ({ ...m, _comp: fitComposite(m.dims, weights) }))
    .sort((a, b) => (b._comp ?? -1) - (a._comp ?? -1) || (b.paramB || 0) - (a.paramB || 0));
  const measuredM = withComp(report.measured);
  const estimatedM = withComp(report.estimated);
  const bestFor = measuredM.find(m => m._comp != null) || null;

  let recHtml;
  if (rec) {
    const benchLine = (recB && recB.modelName !== rec.modelName)
      ? `<div class="mp-fit-rec__alt"><span class="mp-fit-rec__alt-star">✦</span> best benchmarked: <b>${esc(recB.modelName)}</b> <span class="mp-fit-dim">— ${esc(recB.reason)}</span></div>`
      : '';
    const ucLine = bestFor
      ? `<div class="mp-fit-rec__alt"><span class="mp-fit-rec__alt-star mp-fit-rec__alt-star--uc">⬡</span> best for <b>${esc(useCase)}</b>: <b>${esc(bestFor.modelName)}</b> <span class="mp-fit-dim">— score ${bestFor._comp}</span></div>`
      : '';
    recHtml = `<div class="mp-fit-rec"><span class="mp-fit-rec__star">★</span><div>
        <div class="mp-fit-rec__name">${esc(rec.modelName)}</div>
        <div class="mp-fit-rec__why">${esc(rec.reason)}</div>
        ${ucLine}${benchLine}</div></div>`;
  } else {
    recHtml = `<div class="mp-fit-rec mp-fit-rec--none">No measured model yet — profile a model on this host to get a recommendation.</div>`;
  }

  const measuredRows = measuredM.map(m => {
    const deployed = m.deploymentStatus === 'deployed' ? '<span class="mp-fit-dot" title="adapted variant deployed">●</span>' : '';
    const rel = m.reliability ? `<span class="mp-fit-sub">${esc(m.reliability)}</span>` : '';
    const loadTip = [
      m.spillDetected ? `spills at ${m.spillNumCtx || '?'} (safe ${m.safeCtx || '?'})` : 'no spill',
      m.coldLoadMs != null ? `cold load ${m.coldLoadMs}ms` : '',
      m.hotLoadMs != null ? `hot load ${m.hotLoadMs}ms` : '',
      m.modelVramMiB != null ? `${(m.modelVramMiB / 1024).toFixed(1)}GB on GPU` : ''
    ].filter(Boolean).join(' · ');
    let vramCell = '—';
    if (m.vramPct != null) {
      const pct = Math.min(100, m.vramPct);
      const barTone = m.vramPct > 90 ? 'mp-fit-bar__fill--crit' : m.vramPct > 75 ? 'mp-fit-bar__fill--warn' : 'mp-fit-bar__fill--ok';
      vramCell = `<div class="mp-fit-bar" title="${m.vramPct}% of ${vramStr} VRAM"><div class="mp-fit-bar__fill ${barTone}" style="width:${pct}%"></div></div><span class="mp-fit-bar__label">${m.vramPct}%</span>`;
    }
    return `<tr>
      <td class="mp-fit-name">${fitCompChip(m._comp)}${esc(m.modelName)} ${deployed}${fitMoeChip(m)}</td>
      <td>${m.tokensPerSec != null ? m.tokensPerSec : '—'} ${rel}</td>
      <td class="mp-fit-vramcell">${vramCell}</td>
      <td title="safe to ${fmtCtx(m.safeCtx)}">${fmtCtx(m.optimalNumCtx)}</td>
      <td><span class="mp-fit-badge ${fitToneClass(m.fit.tone)}" title="${esc(loadTip)}">${esc(m.fit.label)}</span></td>
    </tr>`;
  }).join('');
  const measuredTable = measuredRows
    ? `<table class="mp-fit-table"><thead><tr><th>Profiled model</th><th>tok/s</th><th>VRAM</th><th>ctx</th><th>fit</th></tr></thead><tbody>${measuredRows}</tbody></table>`
    : '<div class="mp-fit-empty">No models profiled on this host yet.</div>';

  let calib;
  if (tm.source === 'profiles') {
    calib = `calibrated from ${tm.nPoints} profile${tm.nPoints === 1 ? '' : 's'} · ${esc(tm.confidence)} confidence${tm.calibrationErrorPct != null ? ` · ±${tm.calibrationErrorPct}%` : ''}`;
  } else if (tm.source === 'baseline') {
    calib = `from host baseline — profile models to calibrate`;
  } else {
    calib = `generic estimate — no profiles on this host yet`;
  }

  const estRows = estimatedM.map(e => `
    <tr>
      <td class="mp-fit-name">${fitCompChip(e._comp)}${esc(e.modelName)} ${fitMoeChip(e)}</td>
      <td>${e.estTokensPerSec != null ? '~' + e.estTokensPerSec : '—'}</td>
      <td>${estVerdictBadge(e.verdict)}</td>
      <td>${fmtCtx(e.estMaxCtx)}</td>
      <td>${e.recommendedQuant ? `<span class="mp-fit-dim">try </span>${esc(e.recommendedQuant)}` : '—'}</td>
    </tr>`).join('');
  const estTable = estRows
    ? `<table class="mp-fit-table mp-fit-table--est"><thead><tr><th>Unprofiled model</th><th>~tok/s</th><th>fit</th><th>max ctx</th><th>rec. quant</th></tr></thead><tbody>${estRows}</tbody></table>`
    : '';

  return `<div class="mp-fit-report">
    <div class="mp-fit-toolbar"><div class="mp-fit-head">${headChips}</div>${ucSelect}</div>
    <div class="mp-fit-cap">${capBits}</div>
    ${recHtml}
    <div class="mp-fit-section-label">Measured fit <span class="mp-fit-dim">— real profiles · ⬡ = "${esc(useCase)}" score</span></div>
    ${measuredTable}
    ${estTable ? `<div class="mp-fit-section-label">Estimated fit <span class="mp-fit-dim">— ${calib}</span></div>${estTable}` : ''}
    <div class="mp-fit-foot">Generated ${esc(relTime(report.generatedAt))} · ⬡ composite = quality · speed · fit · context, weighted for "${esc(useCase)}" · MoE speed from active params</div>
  </div>`;
}

function getRunState(state, hostId) {
  state.hostTestRuns = state.hostTestRuns || {};
  return state.hostTestRuns[hostId] || null;
}

function setRunState(state, hostId, data) {
  state.hostTestRuns = state.hostTestRuns || {};
  state.hostTestRuns[hostId] = {
    ...(state.hostTestRuns[hostId] || {}),
    ...data
  };
}

function clearRunTimer(state, hostId) {
  state._hostRunTimers = state._hostRunTimers || {};
  if (state._hostRunTimers[hostId]) {
    clearTimeout(state._hostRunTimers[hostId]);
    delete state._hostRunTimers[hostId];
  }
}

function schedulePoll(container, state, api, hostId) {
  state._hostRunTimers = state._hostRunTimers || {};
  clearRunTimer(state, hostId);
  state._hostRunTimers[hostId] = setTimeout(() => pollHostTest(container, state, api, hostId), HOST_TEST_POLL_MS);
}

function dispatchProfilerUpdates() {
  window.dispatchEvent(new CustomEvent('mp:hosts-updated'));
  window.dispatchEvent(new CustomEvent('mp:models-updated'));
}

function getActiveHostProfileQueue(state, hostId) {
  const queue = state._hostQueue;
  if (!queue || queue.hostId !== hostId) return null;
  return queue.status === 'running' ? queue : null;
}

function setHostProfileQueueState(state, hostId, hostName, depth, data) {
  state._modelsHostId = hostId;
  state._hostQueue = {
    queueId: data.queueId,
    hostId,
    hostName: data.hostName || hostName || hostId,
    depth: data.depth || depth || 'standard',
    status: 'running',
    total: data.total || 0,
    models: (data.models || []).map(name => ({ name, status: 'pending' })),
    skippedRecent: data.skippedRecent || [],
    currentIndex: 0,
    cancelled: false,
    error: null
  };
}

function ensureHostProfilePanel(card) {
  let panel = card?.querySelector('.mp-profile-panel');
  if (!panel && card) {
    panel = document.createElement('div');
    panel.className = 'mp-profile-panel';
    const probeSlot = card.querySelector('.mp-probe-slot');
    if (probeSlot) probeSlot.after(panel);
    else card.appendChild(panel);
  }
  return panel;
}

function renderHostProfilePanel(card, { tone = 'info', title, detail, hostId } = {}) {
  const panel = ensureHostProfilePanel(card);
  if (!panel) return;
  panel.className = `mp-profile-panel mp-profile-panel--${tone}`;
  panel.innerHTML = `
    <strong>${esc(title || 'Profile queue')}</strong>
    ${detail ? `<div>${esc(detail)}</div>` : ''}
    ${hostId ? `<button class="mp-action mp-profile-panel-open" data-host-id="${esc(hostId)}">Open progress</button>` : ''}
  `;
}


function buildActionCopy(host, runState) {
  if (runState?.status === 'queued') {
    return {
      className: 'mp-host-note mp-host-note--running',
      html: '<strong>Queued</strong> waiting for fleet sweep…'
    };
  }

  if (runState?.status === 'running') {
    const total = runState.total || 0;
    const completed = runState.completed || 0;
    const currentModel = runState.currentModel ? ` • ${esc(runState.currentModel)}` : '';
    return {
      className: 'mp-host-note mp-host-note--running',
      html: `<strong>Host test running</strong> ${completed}/${total}${currentModel}`
    };
  }

  if (runState?.status === 'failed') {
    return {
      className: 'mp-host-note mp-host-note--error',
      html: `<strong>Host test failed.</strong> ${esc(runState.error || 'Unknown error')}`
    };
  }

  if (host.baseline?.testedAt) {
    return {
      className: 'mp-host-note mp-host-note--ready',
      html: `<strong>Baseline ready \u2713</strong> Refreshed ${esc(relTime(host.baseline.testedAt))}. Use Profile Models for quick, standard, or full model profiling.`
    };
  }

  return {
    className: 'mp-host-note',
    html: '<strong>Next step:</strong> Test the baseline hardware, then profile models at the depth you need.'
  };
}

function getProbeState(state, hostId) {
  state.liveProbeStatus = state.liveProbeStatus || {};
  return state.liveProbeStatus[hostId] || null;
}

function setProbeState(state, hostId, data) {
  state.liveProbeStatus = state.liveProbeStatus || {};
  state.liveProbeStatus[hostId] = data;
}

function fmtMiB(mib) {
  if (mib == null) return '—';
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MiB`;
}

function getHostVramDisplay(host, probeState) {
  const baselineUsed = host.gpu?.vramUsedMiB || host.baseline?.vramUsedMiB || 0;
  const telemetry = probeState?.telemetry || {};
  const agentLive = !!probeState?.agent?.ok;
  const source = String(telemetry.source || '');
  const liveTotal = Number(telemetry.vramTotalMiB || 0);
  const liveUsed = Number(telemetry.vramUsedMiB || 0);
  const used = liveUsed || baselineUsed;

  if (agentLive && liveTotal > 0) {
    return {
      total: liveTotal,
      used,
      stat: fmtMiB(liveTotal),
      totalLabel: `${fmtMiB(liveTotal)} live`,
      usedLabel: `${fmtMiB(used)} used`,
      title: `${fmtMiB(used)} / ${fmtMiB(liveTotal)} live (${source || 'host-agent'})`
    };
  }

  if (liveUsed > 0) {
    return {
      total: 0,
      used: liveUsed,
      stat: 'N/D',
      totalLabel: 'N/D total',
      usedLabel: `${fmtMiB(liveUsed)} loaded`,
      title: 'Ollama reports loaded VRAM, but host runner is needed for total VRAM.'
    };
  }

  return {
    total: 0,
    used: 0,
    stat: 'runner needed',
    totalLabel: 'runner needed',
    usedLabel: '— live used',
    title: 'Host runner is needed for live VRAM telemetry.'
  };
}

function formatProbeVram(telemetry, agent) {
  const used = telemetry.vramUsedMiB != null ? fmtMiB(telemetry.vramUsedMiB) : null;
  const total = telemetry.vramTotalMiB != null && agent?.ok ? fmtMiB(telemetry.vramTotalMiB) : null;
  if (used && total) return `${used} / ${total}`;
  if (used) return `${used} loaded / N/D total`;
  return 'N/D';
}

function probePill(label, ok, detail) {
  const cls = ok ? 'mp-probe-pill mp-probe-pill--ok' : 'mp-probe-pill mp-probe-pill--warn';
  return `<span class="${cls}"><strong>${esc(label)}</strong>${detail ? ` ${esc(detail)}` : ''}</span>`;
}

function uniqueProbeMessages(messages) {
  const seen = new Set();
  return messages
    .map(msg => String(msg || '').trim())
    .filter((msg) => {
      if (!msg || seen.has(msg)) return false;
      seen.add(msg);
      return true;
    });
}

function buildProbeAlerts({ agent, telemetry }) {
  const diagnostics = telemetry?.diagnostics || {};
  const notes = Array.isArray(diagnostics.notes) ? diagnostics.notes : [];
  const alerts = [];

  if (!agent?.ok) {
    alerts.push({
      tone: 'critical',
      title: 'Host runner is not reporting',
      detail: 'Profiler can still use Ollama, but GPU name, PCIe link, utilization, power, temperature, topology, and true per-GPU VRAM are unavailable.'
    });
  }

  if (telemetry?.actionRequired && telemetry?.error) {
    alerts.push({
      tone: 'critical',
      title: 'Telemetry action required',
      detail: telemetry.error
    });
  }

  const fallbackSource = String(telemetry?.source || '');
  if (fallbackSource === 'core-db-override' || fallbackSource === 'static-profile' || fallbackSource === 'ollama-ps') {
    alerts.push({
      tone: 'warn',
      title: 'Using fallback telemetry',
      detail: `Source is ${fallbackSource}; total VRAM is hidden until host-agent confirms live hardware telemetry.`
    });
  }

  for (const note of uniqueProbeMessages(notes)) {
    if (note === telemetry?.error) continue;
    alerts.push({
      tone: /ssh|runner|host-agent|reported vram|pressure/i.test(note) ? 'warn' : 'info',
      title: 'Hardware note',
      detail: note
    });
  }

  return alerts;
}

function renderProbeAlerts(alerts) {
  if (!alerts.length) return '';
  return `<div class="mp-probe-alerts">
    ${alerts.map(alert => `<div class="mp-probe-alert mp-probe-alert--${esc(alert.tone)}">
      <strong>${esc(alert.title)}</strong>
      <span>${esc(alert.detail)}</span>
    </div>`).join('')}
  </div>`;
}

function renderProbePanel(result, { showPlan = false } = {}) {
  if (!result) {
    return `<div class="mp-probe-panel"><div class="mp-probe-title">Live probes <span>Checking runner...</span></div></div>`;
  }
  if (result.loading) {
    return `<div class="mp-probe-panel"><div class="mp-probe-title">Live probes <span>Checking runner...</span></div></div>`;
  }
  if (result.error) {
    return `<div class="mp-probe-panel mp-probe-panel--error">
      <div class="mp-probe-title">Live probes <span>Error</span></div>
      <div class="mp-probe-error">${esc(result.error)}</div>
    </div>`;
  }

  const telemetry = result.telemetry || {};
  const agent = result.agent || {};
  const ollama = result.ollama || {};
  const statusLabel = result.status === 'ready' ? 'Ready' : result.status === 'offline' ? 'Offline' : 'Partial';
  const plan = result.install || {};
  const vram = formatProbeVram(telemetry, agent);
  const running = Array.isArray(telemetry.runningModels) && telemetry.runningModels.length
    ? telemetry.runningModels.map(m => m.name).slice(0, 3).join(', ')
    : 'none';
  const alerts = buildProbeAlerts({ agent, telemetry });
  const panelClass = alerts.some(alert => alert.tone === 'critical')
    ? 'mp-probe-panel mp-probe-panel--critical'
    : alerts.length ? 'mp-probe-panel mp-probe-panel--warn'
    : 'mp-probe-panel';

  return `<div class="${panelClass}">
    <div class="mp-probe-title">Live probes <span>${esc(statusLabel)}</span></div>
    <div class="mp-probe-pills">
      ${probePill('Ollama', !!ollama.ok, ollama.ok ? `${ollama.modelCount || 0} models` : (ollama.error || 'unreachable'))}
      ${probePill('Agent', !!agent.ok, agent.ok ? `${agent.hostname || agent.hostId || 'live'} ${agent.ageSeconds ?? '?'}s` : (agent.reason || 'missing'))}
      ${probePill('GPU', !!telemetry.ok, telemetry.ok ? `${telemetry.source || 'live'} ${vram}` : 'no telemetry')}
    </div>
    ${renderProbeAlerts(alerts)}
    <div class="mp-probe-grid">
      <div><span>Core</span><strong>${esc(result.core?.url || '—')}</strong></div>
      <div><span>GPU</span><strong>${esc(telemetry.gpuName || telemetry.source || '—')}</strong></div>
      <div><span>Util</span><strong>${telemetry.utilization == null ? '—' : `${telemetry.utilization}%`}</strong></div>
      <div><span>Running</span><strong>${esc(running)}</strong></div>
    </div>
    ${showPlan ? `<div class="mp-probe-plan">
      <div class="mp-probe-plan-title">Linux</div>
      <pre>${esc((plan.linux || []).join('\n'))}</pre>
      ${Array.isArray(plan.linuxSystemd) && plan.linuxSystemd.length ? `
      <div class="mp-probe-plan-title">Linux systemd (reboot-resistant)</div>
      <pre>${esc(plan.linuxSystemd.join('\n'))}</pre>` : ''}
      <div class="mp-probe-plan-title">Windows PowerShell</div>
      <pre>${esc((plan.windows || []).join('\n'))}</pre>
      <div class="mp-probe-foot">${esc(plan.reason || '')}</div>
    </div>` : ''}
  </div>`;
}

function buildHostCard(host, state) {
  const runState = getRunState(state, host.hostId);
  const probeState = getProbeState(state, host.hostId);
  const online = isHostOnline(host, probeState);
  const tested = !!host.baseline?.testedAt;
  const offlineClass = online ? '' : ' mp-host-card--offline';
  const dotClass = online ? 'mp-dot--online' : 'mp-dot--offline';
  const badgeLabel = online ? 'Online' : 'Offline';
  const badgeColor = online ? '#66bb6a' : '#ef5350';

  const vramInfo = getHostVramDisplay(host, probeState);
  const baselineTok = fmtToks(host.baseline?.tokensPerSec);
  const latency = host.baseline?.latencyMs != null ? `${Math.round(host.baseline.latencyMs)} ms` : '—';
  const ttft = host.baseline?.ttftMs != null ? `${Math.round(host.baseline.ttftMs)} ms` : '—';
  const testedAt = host.baseline?.testedAt ? relTime(host.baseline.testedAt) : 'Not tested';
  const modelCount = host.modelCount ?? host.models?.length ?? null;
  const note = buildActionCopy(host, runState);
  const profileQueueRunning = !!getActiveHostProfileQueue(state, host.hostId);
  const runnerNeedsFix = probeState?.agent && !probeState.agent.ok || probeState?.telemetry?.actionRequired;
  const installButtonLabel = runnerNeedsFix ? 'Fix Runner' : 'Install Plan';
  const identityName = getHostIdentityName(host, probeState);
  const hardwareSummary = getHostHardwareSummary(host, probeState);

  // VRAM bar
  const vramTotal = vramInfo.total || 0;
  const vramUsed = vramInfo.used || 0;
  const vramPct = vramTotal > 0 ? Math.min(100, Math.round((vramUsed / vramTotal) * 100)) : 0;
  const vramBarCls = vramPct > 90 ? 'mp-host-vram-fill--critical' : (vramPct > 75 ? 'mp-host-vram-fill--warn' : '');
  const vramBarHtml = vramTotal > 0 ? `
    <div class="mp-host-vram-bar" title="${esc(vramInfo.title)}">
      <div class="mp-host-vram-fill ${vramBarCls}" style="width:${vramPct}%"></div>
    </div>
    <div style="display:flex; justify-content:space-between; font-size:0.55rem; color:var(--r-text-dim,#555); margin-bottom:0.5rem;">
      <span class="mp-host-vram-used-label">${esc(vramInfo.usedLabel)}</span>
      <span class="mp-host-vram-total-label">${esc(vramInfo.totalLabel)}</span>
    </div>` : '';

  return `
    <div class="mp-host-card${offlineClass}" data-host-id="${esc(host.hostId)}" data-host-url="${esc(host.hostUrl)}">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.55rem;">
        <div style="display:flex; align-items:center; gap:0.45rem;">
          <span class="mp-dot ${dotClass}"></span>
          <span class="mp-host-title-stack">
            <span class="mp-host-name">${esc(identityName)}</span>
            ${hardwareSummary ? `<span class="mp-host-hardware">${esc(hardwareSummary)}</span>` : ''}
          </span>
        </div>
        ${modelCount != null ? `<span style="
          font-size:0.58rem; font-weight:600; padding:2px 6px;
          border-radius:4px; border:1px solid rgba(78,205,196,0.25);
          background:rgba(78,205,196,0.08); color:#4ecdc4;
          margin-right:0.3rem;
        ">${modelCount} models</span>` : ''}
        <span style="
          font-size:0.6rem; font-weight:700; padding:2px 7px;
          border-radius:4px; border:1px solid ${badgeColor}33;
          background:${badgeColor}18; color:${badgeColor};
        ">${badgeLabel}</span>
      </div>

      <div style="font-size:0.65rem; color:var(--r-text-muted,#888); margin-bottom:0.5rem; word-break:break-all;">
        ${esc(host.hostUrl)}
      </div>

      ${vramBarHtml}

      <div style="
        display:grid; grid-template-columns:1fr 1fr;
        gap:0.45rem; margin-bottom:0.85rem;
      ">
        ${statBox('VRAM', esc(vramInfo.stat), 'mp-host-vram-stat')}
        ${statBox('Baseline', baselineTok)}
        ${statBox('Latency', latency)}
        ${statBox('TTFT', ttft)}
        ${statBox('Tested', testedAt)}
      </div>

      <div class="${note.className}">${note.html}</div>

      <div class="mp-probe-slot">${renderProbePanel(probeState)}</div>

      <div class="mp-host-actions">
        <button
          class="mp-action mp-action--teal mp-host-run-test"
          data-host-id="${esc(host.hostId)}"
          data-host-url="${esc(host.hostUrl)}"
          title="Run one reference model for a hardware baseline. Use Profile Models to choose Quick, Standard, or Full profiling."
          ${online && runState?.status !== 'running' && runState?.status !== 'queued' ? '' : 'disabled'}
        >
          ${tested ? 'Retest Baseline' : `Baseline Probe (${_baselineModel})`}
        </button>
        <button
          class="mp-action mp-action--primary mp-host-profile-models"
          data-host-id="${esc(host.hostId)}"
          data-host-name="${esc(identityName)}"
          data-model-count="${modelCount != null ? esc(modelCount) : ''}"
          title="Queue model profiling on this host with Quick, Standard, or Full depth"
          ${online ? '' : 'disabled'}
        >
          ${profileQueueRunning ? 'Profile Running' : 'Profile Models'}
        </button>
        <button
          class="mp-action mp-host-validate-probes"
          data-host-id="${esc(host.hostId)}"
        >
          Validate Probes
        </button>
        <button
          class="mp-action mp-host-install-plan"
          data-host-id="${esc(host.hostId)}"
        >
          ${installButtonLabel}
        </button>
        <button
          class="mp-action mp-host-fit-report"
          data-host-id="${esc(host.hostId)}"
          title="Measured + estimated model fit for this host"
        >
          Fit Report
        </button>
      </div>
      <div class="mp-fit-slot" data-host-id="${esc(host.hostId)}" data-open="0"></div>
    </div>`;
}

function statBox(label, value, className = '') {
  return `
    <div class="${esc(className)}" style="
      background:rgba(255,255,255,0.03);
      border:1px solid var(--r-border,#1a1a2e);
      border-radius:6px; padding:0.4rem 0.55rem;
    ">
      <div style="font-size:0.58rem; color:var(--r-text-dim,#555); text-transform:uppercase;
                  letter-spacing:0.05em; margin-bottom:0.2rem;">${esc(label)}</div>
      <div data-stat-value style="font-size:0.72rem; font-weight:600; color:var(--r-text-primary,#e0e0e0);
                  word-break:break-all;">${value}</div>
    </div>`;
}

async function pollHostTest(container, state, api, hostId) {
  const runState = getRunState(state, hostId);
  if (!runState?.testId) return;

  try {
    const progress = await api.getHostTestProgress(runState.testId);
    const data = progress?.data || {};

    setRunState(state, hostId, {
      status: data.testStatus || 'running',
      total: data.total || runState.total || 0,
      completed: data.completed || 0,
      failed: data.failed || 0,
      currentModel: data.currentModel || null,
      summary: data.summary || null,
      error: data.error || null
    });

    if (data.testStatus === 'completed' || data.testStatus === 'failed') {
      clearRunTimer(state, hostId);
      await renderHosts(container, state, api);
      if (data.testStatus === 'completed') dispatchProfilerUpdates();
      return;
    }

    // Incremental update — only patch the running card, don't rebuild all
    _patchRunningCard(container, hostId, getRunState(state, hostId));
    schedulePoll(container, state, api, hostId);
  } catch (err) {
    setRunState(state, hostId, { status: 'failed', error: err.message });
    clearRunTimer(state, hostId);
    await renderHosts(container, state, api);
  }
}

/** Patch just the note and button text on a running card — no full re-render */
function _patchRunningCard(container, hostId, runState) {
  const card = container.querySelector(`.mp-host-card[data-host-id="${CSS.escape(hostId)}"]`);
  if (!card) return;

  const noteEl = card.querySelector('.mp-host-note');
  if (noteEl && runState) {
    const total = runState.total || 0;
    const completed = runState.completed || 0;
    const currentModel = runState.currentModel ? ` \u2022 ${runState.currentModel}` : '';
    noteEl.className = 'mp-host-note mp-host-note--running';
    noteEl.innerHTML = `<strong>Host test running</strong> ${completed}/${total}${currentModel}`;
  }

  const btn = card.querySelector('.mp-host-run-test');
  if (btn && runState) {
    btn.textContent = `Testing ${runState.completed || 0}/${runState.total || 0}`;
    btn.disabled = true;
  }
}

// ── Fleet queue (sequential test-all across hosts) ────────────────────────
function getFleetState(state) { return state._fleet || null; }
function setFleetState(state, data) { state._fleet = { ...(state._fleet || {}), ...data }; }
function clearFleetTimer(state) {
  if (state._fleetTimer) { clearTimeout(state._fleetTimer); state._fleetTimer = null; }
}
function scheduleFleetPoll(container, state, api) {
  clearFleetTimer(state);
  state._fleetTimer = setTimeout(() => pollFleet(container, state, api), FLEET_POLL_MS);
}

async function pollFleet(container, state, api) {
  const fleet = getFleetState(state);
  if (!fleet?.queueId) return;
  try {
    const progress = await api.getFleetTestProgress(fleet.queueId);
    const data = progress?.data || progress || {};
    setFleetState(state, {
      status: data.queueStatus || 'running',
      currentIndex: data.currentIndex ?? 0,
      totalHosts: data.totalHosts ?? 0,
      cancelled: !!data.cancelled,
      hosts: data.hosts || [],
      summary: data.summary || null,
      error: data.error || null
    });
    // Mirror per-host progress into hostTestRuns so existing card UI lights up.
    // Patch in-place only for hosts mid-run; queued/completed/failed get caught
    // on the next full re-render at queue end.
    (data.hosts || []).forEach(h => {
      const mapped = h.status === 'pending' ? 'queued' : h.status;
      setRunState(state, h.hostId, {
        status: mapped,
        total: h.total || 0,
        completed: h.completed || 0,
        failed: h.failed || 0,
        currentModel: h.currentModel || null,
        summary: h.summary || null,
        error: h.error || null
      });
      if (mapped === 'running') {
        _patchRunningCard(container, h.hostId, getRunState(state, h.hostId));
      }
    });
    renderFleetBanner(container, state, api);

    if (data.queueStatus === 'completed' || data.queueStatus === 'failed' || data.queueStatus === 'cancelled') {
      clearFleetTimer(state);
      // Re-render hosts to refresh baselines/tested-at after the sweep
      await renderHosts(container, state, api);
      dispatchProfilerUpdates();
      return;
    }
    scheduleFleetPoll(container, state, api);
  } catch (err) {
    setFleetState(state, { status: 'failed', error: err.message });
    clearFleetTimer(state);
    renderFleetBanner(container, state, api);
  }
}

function renderFleetBanner(container, state, api) {
  const fleet = getFleetState(state);
  let banner = container.querySelector('.mp-fleet-banner');
  if (!fleet || fleet.status === 'idle') {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'mp-fleet-banner';
    const grid = container.querySelector('.mp-fleet');
    if (grid) grid.before(banner); else container.appendChild(banner);
  }

  const total = fleet.totalHosts || (fleet.hosts?.length || 0);
  const hosts = fleet.hosts || [];
  const completedHosts = hosts.filter(h => h.status === 'completed').length;
  const failedHosts = hosts.filter(h => h.status === 'failed').length;
  const skippedHosts = hosts.filter(h => h.status === 'offline').length;
  const current = hosts.find(h => h.status === 'running');
  const isDone = fleet.status === 'completed' || fleet.status === 'failed' || fleet.status === 'cancelled';

  const statusColor = isDone
    ? (fleet.status === 'completed' ? '#2ecc71' : fleet.status === 'cancelled' ? '#f39c12' : '#ef5350')
    : '#58a6ff';
  const statusLabel = ({
    running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'
  })[fleet.status] || fleet.status;

  const progressPct = total > 0 ? Math.round(((completedHosts + failedHosts + skippedHosts) / total) * 100) : 0;

  const hostPills = hosts.map(h => {
    const color = h.status === 'completed' ? '#2ecc71'
                : h.status === 'failed'    ? '#ef5350'
                : h.status === 'running'   ? '#58a6ff'
                : h.status === 'offline'   ? '#888'
                : '#666';
    const detail = h.status === 'running' && h.total
      ? ` ${h.completed}/${h.total}`
      : h.status === 'completed' && h.summary
      ? ` ${h.summary.passed}/${h.summary.total} pass`
      : h.status === 'offline' ? ' offline'
      : '';
    return `<span class="mp-fleet-pill" style="border-color:${color}55;color:${color};background:${color}14;">
      ${esc(h.displayName || h.hostId)}${detail}
    </span>`;
  }).join('');

  const summary = fleet.summary
    ? `<span style="color:var(--r-text-muted,#888);font-size:0.62rem;">
        ${fleet.summary.modelsTested} models tested · ${fleet.summary.passed} pass · ${fleet.summary.failed} fail
      </span>`
    : '';

  const currentLine = current
    ? `<span style="color:var(--r-text-muted,#888);font-size:0.65rem;">
        Now: <strong style="color:var(--r-text-primary,#e0e0e0);">${esc(current.displayName || current.hostId)}</strong>
        ${current.currentModel ? ` &middot; ${esc(current.currentModel)}` : ''}
        ${current.total ? ` (${current.completed}/${current.total})` : ''}
      </span>`
    : (isDone ? summary : '');

  banner.innerHTML = `
    <div class="mp-fleet-banner-row">
      <span class="mp-fleet-status" style="color:${statusColor};border-color:${statusColor}55;background:${statusColor}14;">
        Fleet test &middot; ${statusLabel}
      </span>
      <span style="color:var(--r-text-primary,#e0e0e0);font-size:0.7rem;">
        ${completedHosts + failedHosts + skippedHosts}/${total} hosts &middot; ${progressPct}%
      </span>
      ${currentLine}
      <span style="flex:1;"></span>
      ${!isDone ? `<button class="mp-action mp-fleet-cancel" style="font-size:0.65rem;">${fleet.cancelled ? 'Cancelling…' : 'Cancel queue'}</button>` : ''}
      ${isDone ? `<button class="mp-action mp-fleet-dismiss" style="font-size:0.65rem;">Dismiss</button>` : ''}
    </div>
    <div class="mp-fleet-bar"><div class="mp-fleet-bar-fill" style="width:${progressPct}%;background:${statusColor};"></div></div>
    <div class="mp-fleet-pills">${hostPills}</div>
    ${fleet.error ? `<div style="color:#ef5350;font-size:0.65rem;margin-top:0.4rem;">${esc(fleet.error)}</div>` : ''}
  `;
}

async function startFleet(container, state, api, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Queueing…'; }
  try {
    const result = await api.startFleetTest({});
    const data = result?.data || result;
    if (!data?.queueId) throw new Error('No queueId returned');
    setFleetState(state, {
      queueId: data.queueId,
      status: 'running',
      totalHosts: data.totalHosts,
      hosts: (data.hosts || []).map(h => ({ ...h, completed: 0, failed: 0, currentModel: null })),
      currentIndex: 0,
      cancelled: false,
      summary: null,
      error: null
    });
    renderFleetBanner(container, state, api);
    scheduleFleetPoll(container, state, api);
  } catch (err) {
    console.error('[hosts] fleet start failed:', err);
    if (btn) { btn.disabled = false; btn.textContent = 'Queue All Hosts'; }
    alert('Fleet test failed to start: ' + err.message);
  }
}

function patchProbeSlot(container, state, hostId, options = {}) {
  const card = container.querySelector(`.mp-host-card[data-host-id="${CSS.escape(hostId)}"]`);
  const slot = card?.querySelector('.mp-probe-slot');
  if (!slot) return;
  slot.innerHTML = renderProbePanel(getProbeState(state, hostId), options);
  const installBtn = card.querySelector('.mp-host-install-plan');
  const probeState = getProbeState(state, hostId);
  if (installBtn && probeState && !probeState.loading) {
    installBtn.textContent = (probeState.agent && !probeState.agent.ok) || probeState.telemetry?.actionRequired
      ? 'Fix Runner'
      : 'Install Plan';
  }
}

function patchHostVramDisplay(container, state, host) {
  const card = container.querySelector(`.mp-host-card[data-host-id="${CSS.escape(host.hostId)}"]`);
  if (!card) return;
  const probeState = getProbeState(state, host.hostId);
  const info = getHostVramDisplay(host, probeState);
  const bar = card.querySelector('.mp-host-vram-bar');
  const fill = card.querySelector('.mp-host-vram-fill');
  const usedLabel = card.querySelector('.mp-host-vram-used-label');
  const totalLabel = card.querySelector('.mp-host-vram-total-label');
  const statValue = card.querySelector('.mp-host-vram-stat [data-stat-value]');
  const hostName = card.querySelector('.mp-host-name');
  const hardware = card.querySelector('.mp-host-hardware');
  const pct = info.total > 0 ? Math.min(100, Math.round(((info.used || 0) / info.total) * 100)) : 0;
  if (bar) bar.setAttribute('title', info.title);
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.classList.toggle('mp-host-vram-fill--critical', pct > 90);
    fill.classList.toggle('mp-host-vram-fill--warn', pct > 75 && pct <= 90);
  }
  if (usedLabel) usedLabel.textContent = info.usedLabel;
  if (totalLabel) totalLabel.textContent = info.totalLabel;
  if (statValue) statValue.textContent = info.stat;
  if (hostName) {
    const identityName = getHostIdentityName(host, probeState);
    hostName.textContent = identityName;
    card.dataset.hostName = identityName;
  }
  if (hardware) hardware.textContent = getHostHardwareSummary(host, probeState);
}

async function refreshLiveProbeSummaries(container, state, api, hosts) {
  await Promise.all((hosts || []).map(async (host) => {
    if (!host?.hostId) return;
    setProbeState(state, host.hostId, { loading: true });
    patchProbeSlot(container, state, host.hostId);
    try {
      const status = await api.getLiveProbeStatus(host.hostId);
      setProbeState(state, host.hostId, status?.data || status);
    } catch (err) {
      setProbeState(state, host.hostId, { error: err.message || 'Probe validation failed' });
    }
    patchProbeSlot(container, state, host.hostId);
    patchHostVramDisplay(container, state, host);
  }));
}

async function loadLiveProbeSummaries(state, api, hosts) {
  await Promise.all((hosts || []).map(async (host) => {
    if (!host?.hostId) return;
    try {
      const status = await api.getLiveProbeStatus(host.hostId);
      const probeState = status?.data || status;
      setProbeState(state, host.hostId, probeState);
      host.status = isHostOnline(host, probeState) ? 'online' : 'offline';
    } catch (err) {
      setProbeState(state, host.hostId, { error: err.message || 'Probe validation failed' });
    }
  }));
}

function wireActions(container, state, api) {
  if (container.dataset.hostActionsBound === 'true') return;
  container.dataset.hostActionsBound = 'true';

  container.addEventListener('click', async (e) => {
    // Click on card (not on a button) → select host for Models section
    const card = e.target.closest('.mp-host-card');
    if (card && !e.target.closest('button') && !e.target.closest('a')) {
      const hostId = card.dataset.hostId;
      // Visual feedback
      container.querySelectorAll('.mp-host-card').forEach(c => c.style.outline = '');
      card.style.outline = '2px solid var(--r-active, #58a6ff)';
      // Dispatch event for models section
      window.dispatchEvent(new CustomEvent('mp:host-selected', { detail: { hostId } }));
    }

    const openProfileProgressBtn = e.target.closest('.mp-profile-panel-open');
    if (openProfileProgressBtn) {
      const hostId = openProfileProgressBtn.dataset.hostId;
      if (hostId) window.dispatchEvent(new CustomEvent('mp:host-selected', { detail: { hostId } }));
      return;
    }

    const detectBtn = e.target.closest('.mp-host-detect-btn');
    if (detectBtn) {
      const input = container.querySelector('.mp-host-detect-input');
      const nameInput = container.querySelector('.mp-host-detect-name');
      const statusEl = container.querySelector('.mp-host-detect-status');
      const hostUrl = input?.value?.trim();
      if (!hostUrl) {
        if (input) input.style.borderColor = '#f85149';
        return;
      }
      detectBtn.disabled = true;
      detectBtn.textContent = 'Detecting...';
      if (statusEl) statusEl.textContent = '';
      try {
        const result = await api.detectOllamaHost({ hostUrl, displayName: nameInput?.value?.trim() || undefined });
        const host = result?.host || result?.data?.host;
        if (host?.hostId) {
          setProbeState(state, host.hostId, { loading: true });
        }
        if (statusEl) statusEl.textContent = `Detected ${host?.displayName || hostUrl}`;
        await renderHosts(container, state, api);
        if (host?.hostId) {
          const status = await api.getLiveProbeStatus(host.hostId);
          setProbeState(state, host.hostId, status?.data || status);
          patchProbeSlot(container, state, host.hostId);
        }
        dispatchProfilerUpdates();
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message || 'Detection failed';
        console.error('[hosts] detect host failed:', err);
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = 'Detect Host';
      }
      return;
    }

    const validateProbeBtn = e.target.closest('.mp-host-validate-probes, .mp-host-install-plan');
    if (validateProbeBtn) {
      const hostId = validateProbeBtn.dataset.hostId;
      const showPlan = validateProbeBtn.classList.contains('mp-host-install-plan');
      validateProbeBtn.disabled = true;
      const originalText = validateProbeBtn.textContent;
      validateProbeBtn.textContent = showPlan ? 'Loading Plan...' : 'Validating...';
      setProbeState(state, hostId, { loading: true });
      patchProbeSlot(container, state, hostId);
      try {
        const status = await api.getLiveProbeStatus(hostId);
        setProbeState(state, hostId, status?.data || status);
        patchProbeSlot(container, state, hostId, { showPlan });
      } catch (err) {
        setProbeState(state, hostId, { error: err.message || 'Probe validation failed' });
        patchProbeSlot(container, state, hostId);
      } finally {
        validateProbeBtn.disabled = false;
        validateProbeBtn.textContent = originalText;
      }
      return;
    }

    const profileBtn = e.target.closest('.mp-host-profile-models');
    if (profileBtn) {
      const hostId = profileBtn.dataset.hostId;
      const hostName = profileBtn.dataset.hostName || hostId;
      const modelCount = Number(profileBtn.dataset.modelCount || 0);
      const card = profileBtn.closest('.mp-host-card');
      const activeQueue = getActiveHostProfileQueue(state, hostId);

      if (activeQueue) {
        renderHostProfilePanel(card, {
          tone: 'info',
          title: `Profile queue running - ${activeQueue.depth || 'standard'}`,
          detail: `${activeQueue.total || 0} models queued. Progress is available in Models.`,
          hostId
        });
        window.dispatchEvent(new CustomEvent('mp:host-selected', { detail: { hostId } }));
        return;
      }

      const options = await openProfileHostDialog({
        hostName,
        showSkipRecent: true,
        modelCount,
        defaultDepth: 'standard'
      });
      if (!options) return;

      profileBtn.disabled = true;
      profileBtn.textContent = 'Queueing...';
      renderHostProfilePanel(card, {
        tone: 'info',
        title: `Queueing ${options.depth} profiles`,
        detail: 'Checking live host inventory before starting the profile queue.'
      });

      try {
        const result = await api.startHostProfileQueue({
          hostId,
          depth: options.depth,
          skipRecentDays: options.skipRecentDays
        });
        const data = result?.data || result;
        if (!data?.queueId) throw new Error('No queueId returned');

        setHostProfileQueueState(state, hostId, hostName, options.depth, data);
        const total = data.total || 0;
        const skipped = data.skippedRecent?.length ? ` ${data.skippedRecent.length} recently profiled model(s) skipped.` : '';
        renderHostProfilePanel(card, {
          tone: 'success',
          title: `Profile queue started - ${data.depth || options.depth}`,
          detail: `${total} model${total === 1 ? '' : 's'} queued.${skipped}`,
          hostId
        });
        window.dispatchEvent(new CustomEvent('mp:host-selected', { detail: { hostId } }));
      } catch (err) {
        const message = err.message || 'Profile queue failed to start';
        renderHostProfilePanel(card, {
          tone: 'error',
          title: 'Profile queue failed',
          detail: message,
          hostId
        });
        if (/active profile queue|active profile job/i.test(message)) {
          state._modelsHostId = hostId;
          window.dispatchEvent(new CustomEvent('mp:host-selected', { detail: { hostId } }));
        }
        console.error('[hosts] profile queue error:', err);
      } finally {
        const stillActive = getActiveHostProfileQueue(state, hostId);
        profileBtn.disabled = false;
        profileBtn.textContent = stillActive ? 'Profile Running' : 'Profile Models';
      }
      return;
    }

    const fitBtn = e.target.closest('.mp-host-fit-report');
    if (fitBtn) {
      const hostId = fitBtn.dataset.hostId;
      const card = fitBtn.closest('.mp-host-card');
      const slot = card?.querySelector('.mp-fit-slot');
      if (!slot) return;
      // Toggle closed if already open
      if (slot.dataset.open === '1') {
        slot.innerHTML = '';
        slot.dataset.open = '0';
        fitBtn.textContent = 'Fit Report';
        return;
      }
      fitBtn.disabled = true;
      fitBtn.textContent = 'Loading…';
      slot.dataset.open = '1';
      slot.innerHTML = '<div class="mp-fit-loading">Building fit report…</div>';
      try {
        const report = await api.getHostFitReport(hostId);
        slot._fitReport = report;
        slot._fitUseCase = 'general';
        slot.innerHTML = renderFitReport(report, 'general');
        fitBtn.textContent = 'Hide Report';
      } catch (err) {
        slot.innerHTML = `<div class="mp-fit-empty mp-fit-empty--err">Fit report failed: ${esc(err.message)}</div>`;
        fitBtn.textContent = 'Fit Report';
        console.error('[hosts] fit-report error:', err);
      } finally {
        fitBtn.disabled = false;
      }
      return;
    }

    const runBtn = e.target.closest('.mp-host-run-test');
    if (runBtn) {
      const card = runBtn.closest('.mp-host-card');
      await runBaselineProbe({
        button: runBtn,
        card,
        baselineModel: _baselineModel,
        api,
        escapeHtml: esc,
        onComplete: dispatchProfilerUpdates
      });
      return;
    }

    const saveBaselineBtn = e.target.closest('.mp-baseline-save');
    if (saveBaselineBtn) {
      const input = container.querySelector('.mp-baseline-input');
      const val = input?.value?.trim();
      if (!val) { if (input) input.style.borderColor = '#f85149'; return; }
      saveBaselineBtn.disabled = true;
      saveBaselineBtn.textContent = 'Saving…';
      try {
        await api.saveHostTestConfig({ baselineModel: val });
        _baselineModel = val;
        saveBaselineBtn.textContent = 'Saved ✓';
        // Update button labels on all cards
        container.querySelectorAll('.mp-host-run-test').forEach(btn => {
          if (!btn.disabled) btn.textContent = `Baseline Probe (${_baselineModel})`;
        });
        setTimeout(() => { saveBaselineBtn.disabled = false; saveBaselineBtn.textContent = 'Save'; }, 2000);
      } catch (err) {
        saveBaselineBtn.textContent = 'Error';
        setTimeout(() => { saveBaselineBtn.disabled = false; saveBaselineBtn.textContent = 'Save'; }, 2000);
      }
      return;
    }

    const fleetBtn = e.target.closest('.mp-hosts-queue-fleet');
    if (fleetBtn) {
      const fleet = getFleetState(state);
      if (fleet?.status === 'running') {
        // Already running: scroll banner into view
        const banner = container.querySelector('.mp-fleet-banner');
        if (banner) banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (!confirm('Queue host-test sweep across all online hosts? This runs every model on every host sequentially and may take a while.')) return;
      await startFleet(container, state, api, fleetBtn);
      return;
    }

    const cancelBtn = e.target.closest('.mp-fleet-cancel');
    if (cancelBtn) {
      const fleet = getFleetState(state);
      if (!fleet?.queueId) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      try {
        await api.cancelFleetTest(fleet.queueId);
        setFleetState(state, { cancelled: true });
        renderFleetBanner(container, state, api);
      } catch (err) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel queue';
        alert('Cancel failed: ' + err.message);
      }
      return;
    }

    const dismissBtn = e.target.closest('.mp-fleet-dismiss');
    if (dismissBtn) {
      clearFleetTimer(state);
      state._fleet = null;
      const banner = container.querySelector('.mp-fleet-banner');
      if (banner) banner.remove();
      return;
    }

    const refreshBtn = e.target.closest('.mp-hosts-refresh-baselines');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      try {
        await api.discoverHosts().catch(err => console.warn('[hosts] discover refresh skipped:', err));
        await renderHosts(container, state, api);
        dispatchProfilerUpdates();
      } catch (err) {
        console.error('[hosts] refresh baselines error:', err);
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh Hosts';
      }
    }
  });

  // Use-case dropdown in a Fit Report panel — re-render that panel in place.
  container.addEventListener('change', (e) => {
    const sel = e.target.closest('.mp-fit-usecase');
    if (!sel) return;
    const slot = sel.closest('.mp-fit-slot');
    if (!slot || !slot._fitReport) return;
    slot._fitUseCase = sel.value;
    slot.innerHTML = renderFitReport(slot._fitReport, sel.value);
  });
}

export async function renderHosts(container, state, api) {
  container.innerHTML = '<div style="padding:24px; color:#8892b0;">Loading hosts…</div>';

  // Fetch baseline model from config (DB > env default)
  try {
    const cfg = await api.getHostTestConfig();
    if (cfg?.baselineModel) _baselineModel = cfg.baselineModel;
  } catch (_) {}

  let hosts;
  try {
    hosts = await api.getHosts();
  } catch (err) {
    container.innerHTML = `
      <div class="mp-alert mp-alert--error" style="margin-top:1rem;">
        Failed to load hosts: ${esc(err.message)}
      </div>`;
    return;
  }

  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div style="padding:24px; color:#8892b0;">Discovering configured Ollama hosts…</div>';
    try {
      hosts = await api.discoverHosts();
    } catch (err) {
      container.innerHTML = `
        <div class="mp-alert mp-alert--error" style="margin-top:1rem;">
          Failed to discover hosts: ${esc(err.message)}
        </div>`;
      return;
    }

    if (!hosts || hosts.length === 0) {
      container.innerHTML = `
        <div style="padding:2rem 0; text-align:center; color:var(--r-text-muted,#888); font-size:0.8rem;">
          No hosts configured yet.
        </div>`;
      return;
    }
  }

  await loadLiveProbeSummaries(state, api, hosts);

  const testedCount = hosts.filter(host => host.baseline?.testedAt).length;
  const cards = hosts.map(host => buildHostCard(host, state)).join('');

  container.innerHTML = `
    <div class="mp-hosts-topbar">
      <div>
        <h2 style="font-size:0.9rem; font-weight:700; color:var(--r-text-primary,#e0e0e0); margin:0;">
          Host Comparison
        </h2>
        <div class="mp-hosts-subtitle">${testedCount}/${hosts.length} hosts baseline-tested and ready for Benchmark selection.</div>
      </div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <label style="font-size:0.65rem; color:var(--r-text-muted,#888); white-space:nowrap;">Baseline model:</label>
        <input type="text" class="mp-baseline-input" value="${esc(_baselineModel)}"
          style="font-size:0.75rem; padding:4px 8px; border-radius:4px; border:1px solid var(--r-border,#30363d);
          background:var(--r-bg-inset,#21262d); color:var(--r-text,#e6edf3); width:160px;">
        <button class="mp-action mp-baseline-save" style="font-size:0.65rem; padding:4px 10px;">Save</button>
        <button class="mp-action mp-hosts-queue-fleet" title="Sequentially run-all on every online host">
          Queue All Hosts
        </button>
        <button class="mp-action mp-action--teal mp-hosts-refresh-baselines">
          Refresh Hosts
        </button>
      </div>
    </div>
    <div class="mp-host-discovery">
      <input type="text" class="mp-host-detect-input" placeholder="http://192.0.2.x:11434">
      <input type="text" class="mp-host-detect-name" placeholder="Host name">
      <button class="mp-action mp-action--teal mp-host-detect-btn">Detect Host</button>
      <span class="mp-host-detect-status"></span>
    </div>
    <div class="mp-fleet">${cards}</div>`;

  wireActions(container, state, api);
  renderFleetBanner(container, state, api);
}

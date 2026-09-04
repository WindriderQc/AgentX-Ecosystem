// public/js/model-profiler/models-profiling.js
/**
 * Models profiling UI — the live per-model profiling panel (progress ribbon,
 * hero/stat cards, activity log, depth-aware step driver) plus the shared
 * feedback-slot renderer. Extracted from models.js (task 0229).
 *
 * `_runProfiling` and `_showFeedback` are imported by models.js (event wiring)
 * and by the per-host queue reattach path.
 */

import { escAttr } from './models-helpers.js';

// ─── Feedback slot renderer ───────────────────────────────────────────────────

export function _showFeedback(container, modelName, html) {
  // For profiling panels, render full-width ABOVE the grid (focal point)
  if (html.includes('mp-prof-panel')) {
    let panelWrap = container.querySelector('#mp-prof-panel-wrap');
    if (!panelWrap) {
      panelWrap = document.createElement('div');
      panelWrap.id = 'mp-prof-panel-wrap';
      panelWrap.style.cssText = 'margin:0 0 0.9rem;';
      // Prefer placing above the model grid; fall back to model controls / top of container
      const grid = container.querySelector('#mp-model-grid-wrap');
      const controls = container.querySelector('.mp-model-controls');
      if (grid) grid.before(panelWrap);
      else if (controls) controls.after(panelWrap);
      else container.prepend(panelWrap);
    }
    panelWrap.innerHTML = html;
    // Wire close button (present on terminal/done/err states)
    const closeBtn = panelWrap.querySelector('.mp-prof-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => { panelWrap.remove(); });
    }
    return;
  }
  // Simple feedback inside the card
  const el = container.querySelector(`.mp-model-feedback[data-model="${CSS.escape(modelName)}"]`);
  if (el) el.innerHTML = html;
}

// ─── Depth-aware step definitions ────────────────────────────────────────────
// IMPORTANT: order must match the backend's actual execution sequence
// (see benchmark/routes/profiler/pipeline.js → STEPS_BY_DEPTH and
// benchmark/src/services/profiler/profilerOrchestrator.js notify() order).
// The backend reports stepsCompleted as an index into ITS list, so swapping
// these lights up the wrong pill and makes the live timer meaningless.

const STEPS_BY_DEPTH = {
  quick:    ['Warmup', 'Throughput', 'Spill detection', 'Thinking behavior', 'Save'],
  standard: ['Warmup', 'Throughput', 'Spill detection', 'Thinking behavior', 'Context probe', 'Save'],
  full:     ['Warmup', 'Throughput', 'Spill detection', 'Thinking behavior', 'Context probe', 'Throughput curve', 'Generation stability', 'Prefill / decode matrix', 'Load timing', 'Save'],
};

// Nominal wall-clock estimate per depth (seconds) — matches UI hint text
const DEPTH_NOMINAL_SEC = { quick: 60, standard: 300, full: 1200 };

// Per-step descriptors: a short tagline shown under the active pill so users
// know *why* the profiler is in this phase. Keep concise (≤ 32 chars).
const STEP_DESCRIPTIONS = {
  'Warmup':                'Loading weights into VRAM',
  'Throughput':            'Measuring base tok/s',
  'Context probe':         'Resolving usable context window',
  'Spill detection':       'Finding GPU spill threshold',
  'Thinking behavior':     'Checking visible answer safety',
  'Throughput curve':      'Mapping tok/s across contexts',
  'Generation stability':  'Stress-testing long generations',
  'Prefill / decode matrix':'Validating every workload cell',
  'Load timing':           'Cold vs hot reload timing',
  'Save':                  'Persisting profile to database',
};

function _fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// Unified progress ribbon — a single block that shows overall percent, step
// pills (with embedded durations), and the current/up-next/eta meta line.
function _progressRibbon(steps, activeIdx, statuses, stepTimes, activeElapsedSec, elapsedSec, nominalSec) {
  const isTerminal = !!statuses;
  const overallPct = Math.min(100, Math.round((elapsedSec / nominalSec) * 100));
  const overrun = elapsedSec > nominalSec;
  const fillCls = isTerminal ? ' mp-prof-fill--done' : (overrun ? ' mp-prof-fill--over' : '');

  const pills = steps.map((s, i) => {
    const st = statuses?.[i] || (i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending');
    const t = stepTimes?.[i];
    let timeLbl = '';
    if (st === 'done' && t != null) timeLbl = `<span class="mp-prof-pill-t">${t}s</span>`;
    else if (st === 'active' && activeElapsedSec != null) timeLbl = `<span class="mp-prof-pill-t mp-prof-pill-t--live">${activeElapsedSec}s</span>`;
    const glyph = st === 'done' ? '✓' : st === 'error' ? '×' : st === 'active' ? '<span class="mp-prof-pill-spinner"></span>' : `<span class="mp-prof-pill-num">${i + 1}</span>`;
    return `<div class="mp-prof-pill mp-prof-pill--${st}">
      <span class="mp-prof-pill-icon">${glyph}</span>
      <span class="mp-prof-pill-label">${s}</span>
      ${timeLbl}
    </div>`;
  }).join('<span class="mp-prof-pill-sep"></span>');

  // Meta line: current step + tagline · elapsed/nominal · ETA
  let metaLeft = '';
  let metaRight = '';
  if (isTerminal) {
    const allDone = statuses.every(s => s === 'done');
    metaLeft = allDone
      ? `<span class="mp-prof-meta-now">All ${steps.length} steps complete</span>`
      : `<span class="mp-prof-meta-now mp-prof-meta-now--err">Stopped at <strong>${steps[activeIdx] || '?'}</strong></span>`;
    metaRight = `<span class="mp-prof-meta-eta">total ${_fmtDuration(elapsedSec)}</span>`;
  } else {
    const cur = steps[activeIdx] || '';
    const desc = STEP_DESCRIPTIONS[cur] || '';
    metaLeft = `<span class="mp-prof-meta-now"><span class="mp-prof-meta-step">step ${activeIdx + 1}/${steps.length}</span> <strong>${cur}</strong>${desc ? ` <span class="mp-prof-meta-desc">— ${desc}</span>` : ''}</span>`;
    const remaining = Math.max(0, nominalSec - elapsedSec);
    const remLbl = overrun
      ? `<span class="mp-prof-meta-over">+${_fmtDuration(elapsedSec - nominalSec)} over</span>`
      : `~${_fmtDuration(remaining)} left`;
    metaRight = `<span class="mp-prof-meta-eta">${_fmtDuration(elapsedSec)} / ~${_fmtDuration(nominalSec)} · ${remLbl}</span>`;
  }

  return `<div class="mp-prof-ribbon">
    <div class="mp-prof-ribbon-track">
      <div class="mp-prof-ribbon-fill${fillCls}" style="width:${overrun && !isTerminal ? 100 : overallPct}%"></div>
    </div>
    <div class="mp-prof-pills">${pills}</div>
    <div class="mp-prof-meta">
      ${metaLeft}
      ${metaRight}
    </div>
  </div>`;
}

// Tick time-only nodes in place (avoids full innerHTML flash between updates).
function _tickPanel(container, activeElapsedSec, showProgress, nominalSec, elapsedSec) {
  const panel = container.querySelector('#mp-prof-panel-wrap .mp-prof-panel');
  if (!panel) return;
  const elapsedEl = panel.querySelector('.mp-prof-elapsed');
  if (elapsedEl) elapsedEl.textContent = _fmtDuration(elapsedSec);
  const liveStep = panel.querySelector('.mp-prof-pill-t--live');
  if (liveStep && activeElapsedSec != null) liveStep.textContent = `${activeElapsedSec}s`;
  if (showProgress) {
    const fill = panel.querySelector('.mp-prof-ribbon-fill');
    const eta = panel.querySelector('.mp-prof-meta-eta');
    const overrun = elapsedSec > nominalSec;
    if (fill) {
      const pct = overrun ? 100 : Math.min(100, Math.round((elapsedSec / nominalSec) * 100));
      fill.style.width = pct + '%';
      fill.classList.toggle('mp-prof-fill--over', overrun);
    }
    if (eta) {
      const remaining = Math.max(0, nominalSec - elapsedSec);
      const remLbl = overrun
        ? `<span class="mp-prof-meta-over">+${_fmtDuration(elapsedSec - nominalSec)} over</span>`
        : `~${_fmtDuration(remaining)} left`;
      eta.innerHTML = `${_fmtDuration(elapsedSec)} / ~${_fmtDuration(nominalSec)} · ${remLbl}`;
    }
  }
}

function _activityLog(entries) {
  if (!entries?.length) return '';
  const rows = entries.slice(-8).map(e => {
    const icon = e.kind === 'good' ? '✓' : e.kind === 'warn' ? '⚠' : e.kind === 'info' ? '↻' : '·';
    const cls = e.kind ? ` mp-prof-log-row--${e.kind}` : '';
    return `<div class="mp-prof-log-row${cls}"><span class="mp-prof-log-t">${_fmtDuration(e.t)}</span><span class="mp-prof-log-ico">${icon}</span><span class="mp-prof-log-msg">${escAttr(e.msg)}</span></div>`;
  }).join('');
  return `<div class="mp-prof-log">
    <div class="mp-prof-log-hd">Activity <span class="mp-prof-log-count">${entries.length}</span></div>
    ${rows}
  </div>`;
}

function _classifyMessage(msg) {
  const m = (msg || '').toLowerCase();
  if (/reattached|resuming|starting/.test(m)) return 'info';
  if (/no spill|fully loaded|max verified|deployed|baseline:|completed|✓/.test(m)) return 'good';
  if (/spill detected|degradation|fail|timeout|drop|error|✗/.test(m)) return 'warn';
  return null;
}

// Compact stat card (supporting metrics around the hero stat).
function _statCard(val, label, accent, sub) {
  return `<div class="mp-prof-stat">
    <div class="mp-prof-stat-val"${accent ? ` style="color:${accent}"` : ''}>${val}</div>
    <div class="mp-prof-stat-label">${label}</div>
    ${sub ? `<div class="mp-prof-stat-sub">${sub}</div>` : ''}
  </div>`;
}

// Hero stat (live tok/s, large, with optional baseline/delta indicator).
function _heroStat(tokPerSec, baseline) {
  if (tokPerSec == null) return '';
  const v = Number(tokPerSec).toFixed(1);
  let delta = '';
  if (baseline != null && Number(baseline) > 0) {
    const pct = ((tokPerSec - baseline) / baseline) * 100;
    const sign = pct >= 0 ? '▲' : '▼';
    const cls = pct >= -2 ? 'mp-prof-hero-delta--up' : pct >= -10 ? 'mp-prof-hero-delta--flat' : 'mp-prof-hero-delta--down';
    delta = `<div class="mp-prof-hero-delta ${cls}">${sign} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% <span class="mp-prof-hero-baseline">vs ${Number(baseline).toFixed(1)} baseline</span></div>`;
  }
  return `<div class="mp-prof-hero">
    <div class="mp-prof-hero-val">${v}<span class="mp-prof-hero-unit">tok/s</span></div>
    ${delta || '<div class="mp-prof-hero-delta mp-prof-hero-delta--idle">measuring…</div>'}
  </div>`;
}

function _renderSpillBadge(profile) {
  if (!profile?.spill) return '';
  if (profile.spill.verified !== true) {
    return '<span class="mp-spill-warn">GPU residency unknown — no-spill unverified</span>';
  }
  if (profile.spill.spillDetected) {
    return `<span class="mp-spill-warn">Spills at ${profile.spill.spillNumCtx || '?'}</span>`;
  }
  return '<span class="mp-spill-ok">No spill</span>';
}

function _formatRepeatedEvidence(statistics) {
  if (!statistics || !Number(statistics.sampleCount)) return 'unverified';
  const cv = Number.isFinite(Number(statistics.coefficientOfVariation))
    ? `${(Number(statistics.coefficientOfVariation) * 100).toFixed(1)}% CV`
    : 'CV unknown';
  const ci = statistics.confidenceInterval95;
  const ciText = Number.isFinite(Number(ci?.low)) && Number.isFinite(Number(ci?.high))
    ? `95% CI ${Number(ci.low).toFixed(1)}–${Number(ci.high).toFixed(1)}`
    : '95% CI unknown';
  return `n=${statistics.sampleCount} · p50 ${Number(statistics.p50).toFixed(1)} · p95 ${Number(statistics.p95).toFixed(1)} · ${cv} · ${ciText}`;
}

function _renderFullDepthExtras(profile) {
  let html = '';

  // Throughput curve table
  const curve = profile?.throughputCurve || [];
  if (curve.length) {
    html += `<table class="mp-extras-table">
      <caption>Throughput Curve</caption>
      <thead><tr><th>Context Fill %</th><th>tok/s</th><th>Evidence</th><th>VRAM (MiB)</th><th>Offloaded</th></tr></thead>
      <tbody>${curve.map(r => `<tr>
        <td>${r.contextFillPct ?? '?'}%</td>
        <td>${(r.tokensPerSec ?? r.tokPerSec) != null ? Number(r.tokensPerSec ?? r.tokPerSec).toFixed(1) : '?'}</td>
        <td>${_formatRepeatedEvidence(r.throughputStatistics)}</td>
        <td>${r.vramUsedMiB != null ? (r.vramUsedMiB / 1024).toFixed(1) + ' GB' : (r.vramMiB ?? '?')}</td>
        <td>${(r.gpuOffloaded ?? r.offloaded) == null ? 'Unknown' : ((r.gpuOffloaded ?? r.offloaded) ? 'Yes' : 'No')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  const matrix = profile?.prefillDecodeMatrix;
  if (Array.isArray(matrix?.cells) && matrix.cells.length) {
    html += `<table class="mp-extras-table">
      <caption>Prefill / Decode Matrix</caption>
      <thead><tr><th>Prompt</th><th>Decode</th><th>Prefill tok/s</th><th>Decode tok/s</th><th>Evidence</th><th>Status</th></tr></thead>
      <tbody>${matrix.cells.map(cell => `<tr>
        <td>${cell.prefillTokens ?? '?'}</td><td>${cell.decodeTokens ?? '?'}</td>
        <td>${cell.prefillTokensPerSec ?? '—'}</td><td>${cell.decodeTokensPerSec ?? '—'}</td>
        <td>prefill ${_formatRepeatedEvidence(cell.prefillStatistics)}<br>decode ${_formatRepeatedEvidence(cell.decodeStatistics)}</td>
        <td>${cell.status || 'unknown'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // Generation stability table
  const stability = profile?.generationStability || [];
  if (stability.length) {
    html += `<table class="mp-extras-table">
      <caption>Generation Stability</caption>
      <thead><tr><th>Num Predict</th><th>tok/s</th><th>Latency (ms)</th><th>Evidence</th></tr></thead>
      <tbody>${stability.map(r => `<tr>
        <td>${r.numPredict ?? '?'}</td>
        <td>${(r.tokensPerSec ?? r.tokPerSec) != null ? Number(r.tokensPerSec ?? r.tokPerSec).toFixed(1) : '?'}</td>
        <td>${(r.totalLatencyMs ?? r.latencyMs) != null ? Math.round(r.totalLatencyMs ?? r.latencyMs) : '?'}</td>
        <td>throughput ${_formatRepeatedEvidence(r.throughputStatistics)}<br>latency ${_formatRepeatedEvidence(r.latencyStatistics)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // Load timing
  const loadTiming = profile?.loadTiming;
  if (loadTiming) {
    html += `<div class="mp-load-timing">
      ${(loadTiming.coldLoadMs ?? loadTiming.coldMs) != null ? `<span class="mp-load-timing-item">Cold: <strong>${((loadTiming.coldLoadMs ?? loadTiming.coldMs) / 1000).toFixed(1)}s</strong></span>` : ''}
      ${(loadTiming.hotLoadMs ?? loadTiming.hotMs) != null ? `<span class="mp-load-timing-item">Hot: <strong>${((loadTiming.hotLoadMs ?? loadTiming.hotMs) / 1000).toFixed(1)}s</strong></span>` : ''}
      <span class="mp-load-timing-item">Cold evidence: ${_formatRepeatedEvidence(loadTiming.coldStatistics)}</span>
      <span class="mp-load-timing-item">Hot evidence: ${_formatRepeatedEvidence(loadTiming.hotStatistics)}</span>
    </div>`;
  }

  return html;
}

// Module-level dedup set keyed by profileId. Prevents `_reattachActiveProfile`
// from spawning a second `_runProfiling` for a profile that's already being
// driven by an existing heartbeat — which used to cause two concurrent
// heartbeats to fight over the same panel (host name flickering, progress
// bar oscillating, never reaching the end).
const _activeProfileRuns = new Set();

export async function _runProfiling(container, btn, modelName, hostId, depth, api, opts = {}) {
  const { existingProfileId = null, startedAtMs = null } = opts;
  // Bail early if reattaching to a profile that's already being driven by an
  // existing heartbeat. New profiles (no existingProfileId) get registered
  // below once profileId is known.
  if (existingProfileId && _activeProfileRuns.has(existingProfileId)) return;
  // Resolve hostName from the actual hostId (not the dropdown's currently-
  // selected option) so the title stays anchored to the host the profile is
  // running on, even if the operator is currently viewing a different host.
  const hostSelect = container.querySelector('#mp-models-host-select');
  const hostName = (hostSelect
    ? Array.from(hostSelect.options).find(o => o.value === hostId)?.textContent?.trim()
    : null) || hostId;
  if (btn) btn.disabled = true;
  const startTime = startedAtMs || Date.now();
  const elSec = () => Math.round((Date.now() - startTime) / 1000);
  const el = () => `${elSec()}s`;

  const steps = STEPS_BY_DEPTH[depth] || STEPS_BY_DEPTH.standard;
  const nominalSec = DEPTH_NOMINAL_SEC[depth] || DEPTH_NOMINAL_SEC.standard;

  // Persistent state across polls
  const stepTimes = new Array(steps.length).fill(null);
  let stepStartSec = 0;
  let lastStepIdx = 0;
  const activity = [];
  let lastMsg = '';
  const seenMetrics = {};  // accumulate numeric metrics

  function pushActivity(msg) {
    if (!msg || msg === lastMsg) return;
    // Suppress noisy placeholders (e.g. "Baseline: null tok/s …" from preview events)
    if (/\bnull\b/i.test(msg)) return;
    lastMsg = msg;
    activity.push({ t: elSec(), msg, kind: _classifyMessage(msg) });
  }

  // Hero (live tok/s vs baseline) + supporting stat cards. The hero card is
  // the single source of truth for tok/s — no more separate "Baseline:" line.
  function renderMetricsRow() {
    const hero = _heroStat(seenMetrics.tokensPerSec, seenMetrics.baselineTokensPerSec);
    const stats = [];
    if (seenMetrics.ttftMeasurement === 'streamed_wall_clock' && seenMetrics.ttftP50Ms != null) {
      stats.push(_statCard(Math.round(seenMetrics.ttftP50Ms) + ' ms', 'TTFT p50', '#9d8cff'));
    }
    if (seenMetrics.maxVerifiedContext != null) {
      const v = seenMetrics.maxVerifiedContext;
      const lbl = v >= 1024 ? (v / 1024).toFixed(v % 1024 === 0 ? 0 : 1) + 'k' : v.toString();
      stats.push(_statCard(lbl, 'max verified', '#58a6ff'));
    }
    if (seenMetrics.recommendedInteractiveContext != null) {
      const v = seenMetrics.recommendedInteractiveContext;
      const lbl = v >= 1024 ? (v / 1024).toFixed(v % 1024 === 0 ? 0 : 1) + 'k' : v.toString();
      stats.push(_statCard(lbl, 'interactive', '#4ecdc4'));
    }
    if (seenMetrics.degradationPct != null) {
      const accent = seenMetrics.degradationPct > 30 ? '#f85149' : seenMetrics.degradationPct > 10 ? '#d29922' : '#3fb950';
      stats.push(_statCard(seenMetrics.degradationPct + '%', 'degradation', accent));
    }
    if (seenMetrics.vramUsedMiB != null) {
      stats.push(_statCard((seenMetrics.vramUsedMiB / 1024).toFixed(1) + ' GB', 'VRAM', '#f39c12'));
    }
    const hw = seenMetrics.hardwareTelemetry?.latest;
    if (hw?.utilization != null) {
      stats.push(_statCard(Math.round(hw.utilization) + '%', 'GPU load', '#4ecdc4'));
    }
    if (hw?.pcieGen != null && hw?.pcieWidth != null) {
      const warn = seenMetrics.hardwareTelemetry?.diagnostics?.pcieWarning;
      stats.push(_statCard(`Gen${hw.pcieGen} x${hw.pcieWidth}`, 'PCIe link', warn ? '#d29922' : '#58a6ff'));
    }
    if (hw?.temperature != null) {
      const accent = hw.temperature >= 85 ? '#f85149' : hw.temperature >= 78 ? '#d29922' : '#3fb950';
      stats.push(_statCard(Math.round(hw.temperature) + ' C', 'GPU temp', accent));
    }
    if (seenMetrics.measurementQuality?.reliability) {
      const mq = seenMetrics.measurementQuality;
      const cv = mq.coefficientOfVariation != null ? `CV ${(mq.coefficientOfVariation * 100).toFixed(1)}%` : `${mq.sampleCount || 1} sample(s)`;
      const accent = mq.reliability === 'high' ? '#3fb950' : mq.reliability === 'medium' ? '#d29922' : '#f85149';
      stats.push(_statCard(mq.reliability, 'confidence', accent, cv));
    }
    if (seenMetrics.spillState) {
      const ok = /none|no spill/i.test(seenMetrics.spillState);
      stats.push(_statCard(seenMetrics.spillState, 'GPU spill', ok ? '#3fb950' : '#f85149'));
    }
    if (!hero && !stats.length) return '';
    return `<div class="mp-prof-stats">
      ${hero}
      ${stats.length ? `<div class="mp-prof-stats-side">${stats.join('')}</div>` : ''}
    </div>`;
  }

  let lastSignature = '';
  function showPanel(activeIdx, status, extra) {
    const cls = extra?.panelCls || '';
    const statuses = extra?.statuses;
    const isTerminal = !!statuses;
    const titleHtml = extra?.title || `<span class="mp-prof-title-pulse"></span><span class="mp-prof-title-text">Profiling <strong>${modelName}</strong> <span class="mp-prof-title-on">on</span> <span class="mp-prof-title-host">${hostName}</span></span><span class="mp-prof-depth-chip">${depth}</span>`;
    const metricsHtml = extra?.metrics ?? renderMetricsRow();
    const activeElapsed = !isTerminal ? Math.max(0, elSec() - stepStartSec) : null;
    const closeBtn = isTerminal ? `<button class="mp-prof-close" type="button" aria-label="Dismiss">×</button>` : '';

    // The activity log already shows the latest status verbatim, so we drop
    // the standalone italic status line. We also drop the separate "Up next"
    // hint — the next step is visually highlighted in the pill chain.
    void status;

    const sig = JSON.stringify({
      cls, titleHtml, activeIdx, statuses, metricsHtml,
      chart: extra?.chart || '',
      activity: activity.length, lastMsg,
      stepTimes, isTerminal
    });

    if (sig === lastSignature) {
      _tickPanel(container, activeElapsed, !isTerminal, nominalSec, elSec());
      return;
    }
    lastSignature = sig;

    _showFeedback(container, modelName, `<div class="mp-prof-panel${cls}">
      <div class="mp-prof-header">
        <span class="mp-prof-title">${titleHtml}</span>
        <span class="mp-prof-header-right">
          <span class="mp-prof-elapsed">${_fmtDuration(elSec())}</span>
          ${closeBtn}
        </span>
      </div>
      ${_progressRibbon(steps, activeIdx, statuses, stepTimes, activeElapsed, elSec(), nominalSec)}
      ${metricsHtml}${extra?.chart || ''}
      ${_activityLog(activity)}
    </div>`);
  }

  // Start profiling — or attach to an existing in-flight profile after a page reload.
  const reattaching = !!existingProfileId;
  pushActivity(reattaching ? 'Reattached to running profile' : 'Starting profile');
  showPanel(0, reattaching ? 'Reattached—resuming live updates…' : 'Starting profile…');
  if (btn) btn.textContent = reattaching ? 'Resuming…' : 'Starting…';

  // Heartbeat: refresh panel every 1s so elapsed/ETA/active-step counter tick
  // smoothly between the 1.5s backend polls.
  let currentStatusMsg = reattaching ? 'Resuming…' : 'Starting profile…';
  let currentStepIdx = 0;
  let heartbeatDone = false;
  const heartbeat = setInterval(() => {
    if (heartbeatDone) return;
    showPanel(currentStepIdx, currentStatusMsg);
  }, 1000);

  let profileId = existingProfileId;
  if (existingProfileId) _activeProfileRuns.add(existingProfileId);

  try {
    if (!profileId) {
      const started = await api.profileModel(modelName, hostId, depth);
      profileId = started?.profileId;
    }
    if (!profileId) throw new Error('No profileId returned — backend may not support progress tracking');
    // Register fresh profiles too so a re-render-driven reattach can dedup.
    _activeProfileRuns.add(profileId);

    // Poll for real progress
    const result = await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const progress = await api.getProfileProgress(profileId);
          const stepIdx = progress.stepsCompleted || 0;
          const msg = progress.statusMessage || 'Working…';

          // Track step transitions → record duration of the step that just finished
          if (stepIdx > lastStepIdx) {
            for (let i = lastStepIdx; i < stepIdx && i < steps.length; i++) {
              stepTimes[i] = elSec() - stepStartSec;
              stepStartSec = elSec();
            }
            lastStepIdx = stepIdx;
          }

          // Accumulate known numeric metrics from backend tracker
          if (progress.metrics) {
            const m = progress.metrics;
            if (m.tokensPerSec != null) seenMetrics.tokensPerSec = m.tokensPerSec;
            const ttftP50Ms = m.ttftP50Ms ?? m.measurementQuality?.ttftP50Ms;
            if (m.ttftMeasurement === 'streamed_wall_clock' && ttftP50Ms != null) {
              seenMetrics.ttftP50Ms = ttftP50Ms;
              seenMetrics.ttftMeasurement = m.ttftMeasurement;
            }
            if (m.maxVerifiedContext != null) seenMetrics.maxVerifiedContext = m.maxVerifiedContext;
            if (m.recommendedInteractiveContext != null) seenMetrics.recommendedInteractiveContext = m.recommendedInteractiveContext;
            if (m.degradationPct != null) seenMetrics.degradationPct = m.degradationPct;
            if (m.vramUsedMiB != null) seenMetrics.vramUsedMiB = m.vramUsedMiB;
            if (m.measurementQuality) seenMetrics.measurementQuality = m.measurementQuality;
            if (m.hardwareTelemetry) seenMetrics.hardwareTelemetry = m.hardwareTelemetry;
          }
          // Parse baseline from probe messages: "Baseline: 103.04 tok/s at 2k ctx"
          const baselineMatch = msg.match(/Baseline:\s*([\d.]+)\s*tok\/s/i);
          if (baselineMatch) seenMetrics.baselineTokensPerSec = parseFloat(baselineMatch[1]);
          // Derive spill state from status messages
          if (/no spill/i.test(msg)) seenMetrics.spillState = 'None';
          else if (/spill detected/i.test(msg)) {
            const pct = msg.match(/(\d+)%/);
            seenMetrics.spillState = pct ? `${pct[1]}% GPU` : 'Detected';
          }

          pushActivity(msg);
          currentStatusMsg = msg;
          currentStepIdx = stepIdx;
          showPanel(stepIdx, msg);
          if (btn) btn.textContent = msg.length > 28 ? msg.slice(0, 28) + '…' : msg.replace('…', '');

          if (progress.profileStatus === 'completed') {
            clearInterval(poll);
            resolve(progress.result);
          } else if (progress.profileStatus === 'failed') {
            clearInterval(poll);
            reject(new Error(progress.error || 'Profile failed'));
          }
        } catch (pollErr) {
          // Tolerate transient poll errors
        }
      }, 1500);
    });

    const p = result?.profile || result;
    // Sync final values into seenMetrics so renderMetricsRow paints the
    // completed-state hero/stats consistently.
    if (p?.tokensPerSec != null) seenMetrics.tokensPerSec = p.tokensPerSec;
    if (p?.ttftMeasurement === 'streamed_wall_clock' && p?.ttftP50Ms != null) {
      seenMetrics.ttftP50Ms = p.ttftP50Ms;
      seenMetrics.ttftMeasurement = p.ttftMeasurement;
    }
    if (p?.maxVerifiedContext != null) seenMetrics.maxVerifiedContext = p.maxVerifiedContext;
    if (p?.recommendedInteractiveContext != null) seenMetrics.recommendedInteractiveContext = p.recommendedInteractiveContext;
    if (p?.degradationPct != null) seenMetrics.degradationPct = p.degradationPct;
    if (p?.vramUsedMiB != null) seenMetrics.vramUsedMiB = p.vramUsedMiB;
    if (p?.measurementQuality) seenMetrics.measurementQuality = p.measurementQuality;
    if (p?.hardwareTelemetry) seenMetrics.hardwareTelemetry = p.hardwareTelemetry;
    if (p?.spill) {
      const sp = p.spill.spillNumCtx;
      const spLbl = sp >= 1024 ? Math.round(sp / 1024) + 'k' : (sp || '?');
      seenMetrics.spillState = p.spill.verified === false
        ? 'Unknown'
        : p.spill.spillDetected
        ? `Spills @ ${spLbl}`
        : 'None';
    }
    const probeSteps = p?.probeSteps || [];

    // Close out final step timing
    for (let i = lastStepIdx; i < steps.length; i++) {
      if (stepTimes[i] == null) {
        stepTimes[i] = elSec() - stepStartSec;
        stepStartSec = elSec();
      }
    }

    const maxT = Math.max(...probeSteps.map(s => s.tokPerSec || 0), 1);
    const chart = probeSteps.length ? `<div class="mp-prof-ctx-chart">
      ${probeSteps.map(s => {
        const t = s.tokPerSec || 0;
        const pct = Math.round((t / maxT) * 100);
        const c = s.numCtx || 0;
        return `<div class="mp-prof-ctx-bar-wrap" title="${c} ctx → ${Number(t).toFixed(1)} tok/s">
          <div class="mp-prof-ctx-bar" style="height:${pct}%"></div>
          <div class="mp-prof-ctx-label">${c >= 1024 ? Math.round(c/1024)+'k' : c}</div>
        </div>`;
      }).join('')}</div>` : '';

    const spillBadge = _renderSpillBadge(p);
    const fullExtras = depth === 'full' ? _renderFullDepthExtras(p) : '';
    const benchmarkQualified = p?.benchmarkQualified === true;
    const unqualifiedFull = depth === 'full' && !benchmarkQualified;
    const qualification = benchmarkQualified
      ? '<div class="mp-prof-qualification mp-prof-qualification--ok">Benchmark qualified</div>'
      : `<div class="mp-prof-qualification mp-prof-qualification--warn">Not benchmark qualified${p?.qualificationFailures?.length ? `: ${p.qualificationFailures.join(', ')}` : ''}</div>`;
    const finalMetrics = qualification + renderMetricsRow()
      + (spillBadge ? `<div class="mp-prof-spill-row">${spillBadge}</div>` : '')
      + fullExtras;

    pushActivity(`${unqualifiedFull ? 'Full profile incomplete and not qualified' : 'Completed'} in ${_fmtDuration(elSec())}`);
    heartbeatDone = true;
    clearInterval(heartbeat);
    const doneStatuses = steps.map(() => 'done');
    showPanel(steps.length, null, {
      statuses: doneStatuses,
      panelCls: unqualifiedFull ? ' mp-prof-panel--incomplete' : ' mp-prof-panel--done',
      title: unqualifiedFull
        ? `<span class="mp-prof-title-text"><strong>${modelName}</strong> <span class="mp-prof-title-on">Full profile incomplete — not qualified on</span> <span class="mp-prof-title-host">${hostName}</span></span><span class="mp-prof-depth-chip">${depth}</span><span class="mp-prof-title-runtime">in ${_fmtDuration(elSec())}</span>`
        : `<span class="mp-prof-title-check">✓</span><span class="mp-prof-title-text"><strong>${modelName}</strong> <span class="mp-prof-title-on">profiled on</span> <span class="mp-prof-title-host">${hostName}</span></span><span class="mp-prof-depth-chip">${depth}</span><span class="mp-prof-title-runtime">in ${_fmtDuration(elSec())}</span>`,
      metrics: finalMetrics,
      chart
    });
    if (btn) btn.textContent = unqualifiedFull ? 'Not qualified' : 'Profiled ✓';
    window.dispatchEvent(new CustomEvent('mp:models-updated'));
  } catch (err) {
    heartbeatDone = true;
    clearInterval(heartbeat);
    // A 409 means the host is reserved (benchmark batch or another profile) —
    // a scheduling conflict, not a profiling failure. Render it amber with a
    // "try again later" hint instead of the red failure panel.
    const isBusy = err.status === 409 || err.conflict === 'host_claimed';
    if (isBusy) {
      pushActivity(`Host busy: ${err.message}`);
      showPanel(0, null, {
        statuses: steps.map(() => 'pending'),
        panelCls: ' mp-prof-panel--busy',
        title: `<span class="mp-prof-title-text"><strong>${modelName}</strong> <span class="mp-prof-title-on">waiting —</span> <span class="mp-prof-title-host">${hostName}</span> <span class="mp-prof-title-on">is reserved</span></span>`,
        metrics: `<div class="mp-prof-busy-hint">${err.message} The host frees up automatically when the current job finishes — check the Benchmark page for a running batch, then retry.</div>`
      });
    } else {
      pushActivity(`Failed: ${err.message}`);
      showPanel(lastStepIdx, null, {
        statuses: steps.map((_, i) => i < lastStepIdx ? 'done' : i === lastStepIdx ? 'error' : 'pending'),
        panelCls: ' mp-prof-panel--err',
        title: 'Profile Failed',
        metrics: renderMetricsRow() + `<div class="mp-prof-err">${err.message}</div>`
      });
    }
    if (btn) { btn.textContent = 'Profile'; btn.disabled = false; }
  } finally {
    if (profileId) _activeProfileRuns.delete(profileId);
  }
}

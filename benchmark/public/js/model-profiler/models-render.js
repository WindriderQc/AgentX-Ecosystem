// public/js/model-profiler/models-render.js
/**
 * Models renderer — HTML builders for the Model Profiler Models sub-tab
 * (cards, list rows, top bar, controls, grid, settings panel, states).
 * Extracted from models.js (task 0229). Pure string builders; event wiring
 * stays in models.js.
 */

import { renderBadge, renderHostDot } from './components/badges.js';
import {
  STAGE_ORDER,
  FILTER_DEFS,
  getHighestStage,
  getHostStages,
  countAtStage,
  totalHosts,
  buildMeta,
  _fmtCtx,
  _formatProfileDate,
  _formatGiB,
  _formatHardwareTitle,
  _getStalenessInfo,
  escAttr,
} from './models-helpers.js';

export function renderHardwareTelemetry(p) {
  if (p?._showHardwareDiagnostics === false) return '';
  const hw = p?.hardwareTelemetry;
  const latest = hw?.latest;
  if (!latest?.ok) return '';

  const diag = hw.diagnostics || latest.diagnostics || {};
  const bits = [];
  if (latest.utilization != null) bits.push(`<span><strong>${Math.round(latest.utilization)}%</strong> GPU</span>`);
  if (latest.vramUsedMiB != null && latest.vramTotalMiB != null) {
    bits.push(`<span><strong>${_formatGiB(latest.vramUsedMiB)}</strong>/<span>${_formatGiB(latest.vramTotalMiB, 0)}</span> VRAM</span>`);
  }
  if (latest.pcieGen != null && latest.pcieWidth != null) {
    bits.push(`<span><strong>Gen${latest.pcieGen} x${latest.pcieWidth}</strong> PCIe</span>`);
  }
  if (latest.powerDrawW != null) bits.push(`<span><strong>${Math.round(latest.powerDrawW)}W</strong></span>`);
  if (latest.temperature != null) bits.push(`<span><strong>${Math.round(latest.temperature)}C</strong></span>`);
  if (!bits.length) return '';

  const tone = diag.pcieWarning || diag.thermalWarning || (diag.vramPressurePct != null && diag.vramPressurePct >= 90)
    ? 'warn'
    : 'ok';
  const title = _formatHardwareTitle(hw) || 'Hardware telemetry captured during profiling';
  return `<div class="mp-hw-strip mp-hw-strip--${tone}" title="${escAttr(title)}">
    <span class="mp-hw-strip__label">hardware</span>
    ${bits.join('<span class="mp-strip-sep">·</span>')}
  </div>`;
}

/**
 * Render quick metrics row if the model has profile data.
 * Falls back to a "Not profiled" prompt with a Scout action.
 */
export function renderMetrics(model, api) {
  const p = model.profile || model.metrics;

  if (!p) {
    return `<div class="mp-card-empty-state">
      <div class="mp-card-empty-kicker">No profile yet</div>
      <div class="mp-card-empty-copy">Run a profile to capture speed, safe context, and spill behavior.</div>
    </div>`;
  }

  const comparisonPromptTokens = p.comparisonPromptTokens ?? null;
  const comparisonPromptTargetTokens = p.comparisonPromptTargetTokens ?? comparisonPromptTokens;
  const comparisonWorkloadMode = p.comparisonWorkloadMode || 'fixed';

  // ── Hero throughput ──────────────────────────────────────────────────
  let heroHtml = '';
  if (p.tokensPerSec != null) {
    const tps = Number(p.tokensPerSec).toFixed(1);
    const promptCtx = comparisonPromptTokens ? _fmtCtx(comparisonPromptTokens) : null;
    const heroTitle = comparisonPromptTargetTokens
      ? comparisonWorkloadMode === 'fixed_fallback_to_ctx'
        ? `Fixed speed run targeted ${_fmtCtx(comparisonPromptTargetTokens)} prompt tokens but clipped to ${_fmtCtx(comparisonPromptTokens || comparisonPromptTargetTokens)} by active context.`
        : `Fixed speed run using ~${_fmtCtx(comparisonPromptTargetTokens)} prompt tokens.`
      : 'Throughput from the profiler speed run.';
    const ttft = p.ttftMs != null
      ? `<span class="mp-hero-aux"><span class="mp-hero-aux__val">${Math.round(p.ttftMs)}</span><span class="mp-hero-aux__unit">ms TTFT</span></span>`
      : '';
    heroHtml = `<div class="mp-card-hero" title="${escAttr(heroTitle)}">
      <div class="mp-hero-main">
        <span class="mp-hero-val">${tps}</span>
        <span class="mp-hero-unit">tok/s</span>
        ${promptCtx ? `<span class="mp-hero-tag">@ ${promptCtx} prompt</span>` : ''}
      </div>
      ${ttft}
    </div>`;
  }

  // ── One-line capacity strip (ctx · VRAM · spill) ────────────────────
  const spill = p.spill;
  const spillDetected = !!spill?.spillDetected;
  const safeCtx = spill?.lastSafeNumCtx;
  const spillCtx = spill?.spillNumCtx;
  let capacityHtml = '';
  if (p.optimalNumCtx != null || spill || p.vramUsedMiB != null) {
    const bits = [];
    if (p.optimalNumCtx != null) {
      bits.push(`<span class="mp-strip-num">${_fmtCtx(p.optimalNumCtx)}</span><span class="mp-strip-unit">ctx</span>`);
    }
    if (p.vramUsedMiB != null) {
      bits.push(`<span class="mp-strip-num">${(p.vramUsedMiB / 1024).toFixed(1)}</span><span class="mp-strip-unit">GB</span>`);
    }
    if (spillDetected) {
      const at = spillCtx ? ` at ${_fmtCtx(spillCtx)}` : '';
      const safe = safeCtx ? ` (safe ${_fmtCtx(safeCtx)})` : '';
      bits.push(`<span class="mp-strip-spill mp-strip-spill--warn" title="GPU spill detected${at}${safe}">⚠ spills${at}</span>`);
    } else if (spill) {
      const safe = safeCtx ? `safe to ${_fmtCtx(safeCtx)}` : 'no spill';
      bits.push(`<span class="mp-strip-spill mp-strip-spill--ok" title="No GPU spill during profiling. Higher context or different load can still spill.">✓ ${safe}</span>`);
    }
    capacityHtml = `<div class="mp-cap-strip">${bits.join('<span class="mp-strip-sep">·</span>')}</div>`;
  }

  // ── Context insight chip (only when notable) ─────────────────────────
  let insightHtml = '';
  const ci = p.contextInsight;
  if (ci?.upgradeAvailable) {
    insightHtml = `<span class="mp-insight-chip mp-insight-chip--up" title="Profiler discovered headroom for a larger context window (${_fmtCtx(ci.previousNumCtx)} → ${_fmtCtx(ci.discoveredNumCtx)})">▲ ${ci.upgradeFactor}× ctx headroom</span>`;
  } else if (ci && ci.upgradeFactor < 0.75) {
    insightHtml = `<span class="mp-insight-chip mp-insight-chip--down" title="Declared context exceeded what this host can run safely (${_fmtCtx(ci.previousNumCtx)} → ${_fmtCtx(ci.discoveredNumCtx)})">▼ declared ctx too high</span>`;
  }

  // ── Footer (depth · profiled · stale · insight) ─────────────────────
  const stalenessInfo = _getStalenessInfo(model);
  const profiledStr = _formatProfileDate(p.profiledAt);
  const footerBits = [];
  if (p.profileDepth) {
    footerBits.push(`<span class="mp-foot-depth" title="Profiler depth preset">${escAttr(p.profileDepth)}</span>`);
  }
  if (p.contextProbeFillPct != null) {
    footerBits.push(`<span class="mp-foot-depth" title="Prompt fill used by the context probe">${Number(p.contextProbeFillPct)}% ctx fill</span>`);
  }
  if (profiledStr) {
    footerBits.push(`<span class="mp-foot-when" title="When this profile was captured">${profiledStr}</span>`);
  }
  if (stalenessInfo.stale) {
    const why = stalenessInfo.reasons.length ? `: ${stalenessInfo.reasons.join(', ')}` : '';
    footerBits.push(`<span class="mp-stale-badge" title="Profile may no longer reflect runtime${why}">stale</span>`);
  }
  const mq = p.measurementQuality;
  if (mq?.reliability) {
    const rel = mq.reliability;
    const cv = mq.coefficientOfVariation != null ? ` · CV ${(mq.coefficientOfVariation * 100).toFixed(1)}%` : '';
    footerBits.push(`<span class="mp-foot-depth" title="${mq.sampleCount || 1} throughput sample(s)${cv}">${rel} confidence</span>`);
  }
  const footerHtml = (footerBits.length || insightHtml)
    ? `<div class="mp-card-foot">
        ${footerBits.join('<span class="mp-foot-sep">·</span>')}
        ${insightHtml ? `<span class="mp-foot-spacer"></span>${insightHtml}` : ''}
      </div>`
    : '';

  if (!heroHtml && !capacityHtml) {
    return `<div class="mp-card-empty-state" style="margin-top:0.6rem;">Profile data empty</div>`;
  }

  return `<div class="mp-card-metrics">
    ${heroHtml}
    ${capacityHtml}
    ${renderHardwareTelemetry(p)}
    ${footerHtml}
  </div>`;
}

export function renderDeploymentBranch(model) {
  const adaptation = model._adaptation;
  if (!adaptation?.adaptedName) return '';

  const status = String(adaptation.deployment?.status || 'pending').toLowerCase();
  const isDeployed = status === 'deployed';
  const tone = isDeployed ? 'ok' : status === 'failed' ? 'err' : 'pending';
  const label = isDeployed ? 'deployed' : status === 'failed' ? 'failed' : 'pending';

  // Happy path: just the adapted name (the orange frame + "Adapted" badge
  // already convey "deployed"). Only show the status pill when something
  // needs attention (pending / failed).
  const statusPill = isDeployed
    ? ''
    : `<span class="mp-deploy-row__status">${label}</span>`;

  return `<div class="mp-deploy-row mp-deploy-row--${tone}" title="Adapted variant: ${escAttr(adaptation.adaptedName)} (${label})">
    <span class="mp-deploy-row__label">variant</span>
    <span class="mp-deploy-row__name">${escAttr(adaptation.adaptedName)}</span>
    ${statusPill}
  </div>`;
}

// ─── Card renderer ────────────────────────────────────────────────────────────

export function renderModelCard(model, api) {
  const highestStage = getHighestStage(model);
  const hostStages   = getHostStages(model);
  const hostCount    = countAtStage(model, highestStage);
  const total        = totalHosts(model);
  const meta         = escAttr(buildMeta(model));
  const isEmbedding  = /embed|nomic|bert|bge|diagnostic/i.test(model.name);

  const hostDots = Object.entries(hostStages)
    .map(([hostId, stage]) =>
      `<span title="${escAttr(hostId)}: ${stage}">${renderHostDot(stage)}</span>`
    ).join('');

  if (isEmbedding) {
    return `<div class="mp-model-card mp-model-card--embedding" data-model="${escAttr(model.name)}" data-stage="embedding">
      <div class="mp-card-header">
        <span class="mp-card-title" style="color:#6e7681;">${escAttr(model.name)}</span>
        <span style="font-size:0.55rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(139,148,158,0.3); background:rgba(139,148,158,0.1); color:#8b949e;">EMBEDDING</span>
      </div>
      <div class="mp-card-subhead">${meta}</div>
      <div class="mp-card-empty-state" style="margin-top:0.4rem;">Not benchmarkable - embedding model</div>
    </div>`;
  }

  return `<div class="mp-model-card" data-model="${escAttr(model.name)}" data-stage="${highestStage}">
    <div class="mp-card-header">
      <label class="mp-card-select" title="Select for queue">
        <input type="checkbox" class="mp-card-checkbox" data-model="${escAttr(model.name)}">
      </label>
      <span class="mp-card-title">${escAttr(model.name)}</span>
      ${renderBadge(highestStage, total > 0 ? hostCount : null, total > 0 ? total : null)}
    </div>

    <div class="mp-card-subhead">${meta}</div>

    ${hostDots ? `<div class="mp-card-hostdots">
      ${hostDots}
    </div>` : ''}

    <div class="mp-card-body">
      ${renderMetrics(model, api)}
      ${renderDeploymentBranch(model)}
    </div>
    <div class="mp-card-actions">
      ${!isEmbedding ? `
        <button class="mp-action mp-action--teal mp-btn-profile mp-card-cta" data-model="${escAttr(model.name)}">
          ${highestStage === 'available' ? 'Profile' : 'Reprofile'}
        </button>` : ''}
      ${highestStage === 'profiled' ? `
        <button class="mp-action mp-action--orange mp-btn-adapt mp-card-cta" data-model="${escAttr(model.name)}">
          Adapt
        </button>` : ''}

      ${highestStage === 'benchmarked' ? `
        <a href="/" class="mp-bench-link">View Benchmarks →</a>` : ''}
    </div>
    <div class="mp-model-feedback" data-model="${escAttr(model.name)}"></div>
  </div>`;
}

// ─── Top bar ──────────────────────────────────────────────────────────────────

export function renderTopBar(models, activeFilter) {
  const counts = {
    all:          models.length,
    profiled:     models.filter(m => STAGE_ORDER.indexOf(getHighestStage(m)) <= STAGE_ORDER.indexOf('profiled') && getHighestStage(m) !== 'available').length,
    adapted:      models.filter(m => getHighestStage(m) === 'adapted' || getHighestStage(m) === 'benchmarked').length,
    benchmarked:  models.filter(m => getHighestStage(m) === 'benchmarked').length
  };

  // "Profiled" count = profiled OR above
  counts.profiled = models.filter(m => {
    const stage = getHighestStage(m);
    return stage === 'profiled' || stage === 'adapted' || stage === 'benchmarked';
  }).length;

  const pills = FILTER_DEFS.map(f => {
    const active = f.key === activeFilter;
    return `<button
      class="mp-action${active ? ' mp-action--primary' : ''} mp-filter-pill"
      data-filter="${f.key}"
      style="font-size:0.65rem; padding:0.2rem 0.6rem;"
    >${f.label} <span style="opacity:0.65;">${counts[f.key]}</span></button>`;
  }).join('');

  return `<div style="
    display:flex;
    align-items:center;
    gap:0.6rem;
    flex-wrap:wrap;
    margin-bottom:1rem;
  ">
    <input
      id="mp-model-search"
      type="search"
      placeholder="Search models…"
      value=""
      style="
        flex:1;
        min-width:180px;
        max-width:320px;
        padding:0.3rem 0.65rem;
        background:#0a0a14;
        border:1px solid #1a1a2e;
        border-radius:6px;
        color:#e0e0e0;
        font-size:0.72rem;
        outline:none;
      "
    >
    <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
      ${pills}
    </div>
    <div style="margin-left:auto; display:flex; gap:0.5rem; align-items:center;">
      <div class="mp-view-toggle" role="group" aria-label="View mode">
        <button class="mp-view-btn mp-view-btn--list" data-view="list" title="List view">☰ List</button>
        <button class="mp-view-btn mp-view-btn--grid" data-view="grid" title="Card grid">▦ Cards</button>
      </div>
      <button class="mp-action mp-btn-select-all" style="font-size:0.62rem; padding:0.18rem 0.55rem;" title="Select all visible models">
        Select all
      </button>
      <button class="mp-action mp-btn-select-clear" style="font-size:0.62rem; padding:0.18rem 0.55rem;" title="Clear selection" disabled>
        Clear
      </button>
      <button class="mp-action mp-btn-profile-host" title="Profile selected models, or all if none selected">
        Profile All on Host
      </button>
      <button class="mp-action mp-action--primary" id="mp-btn-register">
        ⊕ Register Model
      </button>
    </div>
  </div>`;
}

export function renderModelControls(hosts, selectedHostId, selectedHost, models) {
  const hostOpts = hosts.map(h => {
    const name = h.displayName || h.hostId || '?';
    const tested = h.baseline?.testedAt ? '✓' : '';
    const sel = h.hostId === selectedHostId ? 'selected' : '';
    return `<option value="${escAttr(h.hostId)}" ${sel}>${name} ${tested}</option>`;
  }).join('');

  if (!hosts.length) {
    return `<div class="mp-model-controls">
      <div style="font-size:0.72rem; color:var(--r-warn,#d29922);">
        No hosts available — <a href="#mp-hosts-section" style="color:var(--r-active,#58a6ff);">test a host first</a>
      </div>
    </div>`;
  }

  return `<div class="mp-model-controls">
    <div class="mp-model-controls__left">
      <label class="mp-model-controls__label">Host</label>
      <select id="mp-models-host-select" class="mp-model-controls__select">
        ${hostOpts}
      </select>
      <span class="mp-model-controls__meta">${models.length} models on ${selectedHost?.displayName || selectedHostId || 'host'}</span>
    </div>
    <button class="mp-action mp-action--primary mp-model-controls__register" id="mp-btn-register">
      ⊕ Register Model
    </button>
  </div>`;
}

// ─── Grid renderer ────────────────────────────────────────────────────────────

export function renderGrid(models, api, view = 'list') {
  if (models.length === 0) {
    return `<div style="
      padding:3rem 1rem;
      text-align:center;
      color:#8892b0;
      font-size:0.78rem;
      line-height:1.7;
    ">No models match the current filter.<br>Start in <strong style="color:#e0e0e0;">Hosts</strong>: sync a host's models first, then they will appear here for profiling and benchmark launch.</div>`;
  }

  if (view === 'list') {
    return `<div class="mp-model-list">
      <div class="mp-list-head">
        <span class="mp-list-col mp-list-col--check"></span>
        <span class="mp-list-col mp-list-col--name">Model</span>
        <span class="mp-list-col mp-list-col--badge">Stage</span>
        <span class="mp-list-col mp-list-col--tps">tok/s</span>
        <span class="mp-list-col mp-list-col--ttft">TTFT</span>
        <span class="mp-list-col mp-list-col--ctx">Context</span>
        <span class="mp-list-col mp-list-col--vram">VRAM</span>
        <span class="mp-list-col mp-list-col--spill">Spill</span>
        <span class="mp-list-col mp-list-col--variant">Variant</span>
        <span class="mp-list-col mp-list-col--meta">Profiled</span>
        <span class="mp-list-col mp-list-col--actions"></span>
      </div>
      ${models.map(m => renderModelRow(m, api)).join('')}
    </div>`;
  }

  return `<div class="mp-model-grid">
    ${models.map(m => renderModelCard(m, api)).join('')}
  </div>`;
}

// ─── List row renderer ────────────────────────────────────────────────────────

export function renderModelRow(model, api) {
  const highestStage = getHighestStage(model);
  const hostStages   = getHostStages(model);
  const hostCount    = countAtStage(model, highestStage);
  const total        = totalHosts(model);
  const meta         = escAttr(buildMeta(model));
  const isEmbedding  = /embed|nomic|bert|bge|diagnostic/i.test(model.name);
  const p            = model.profile || model.metrics;
  const adaptation   = model._adaptation;
  const stalenessInfo = _getStalenessInfo(model);

  // Stage badge (compact)
  const badge = renderBadge(highestStage, total > 0 ? hostCount : null, total > 0 ? total : null);

  // Cell helpers
  const dash = `<span class="mp-list-dash">—</span>`;

  // tok/s cell — number + tiny prompt size
  let tpsCell = dash;
  if (p?.tokensPerSec != null) {
    const tps = Number(p.tokensPerSec).toFixed(1);
    const promptCtx = p.comparisonPromptTokens ? `<span class="mp-list-sub">@ ${_fmtCtx(p.comparisonPromptTokens)}</span>` : '';
    const mq = p.measurementQuality;
    const confidence = mq?.reliability ? `<span class="mp-list-sub" title="${mq.sampleCount || 1} sample(s), CV ${mq.coefficientOfVariation != null ? (mq.coefficientOfVariation * 100).toFixed(1) + '%' : 'n/a'}">${escAttr(mq.reliability)}</span>` : '';
    tpsCell = `<span class="mp-list-num mp-list-num--accent">${tps}</span>${promptCtx}${confidence}`;
  }

  // TTFT
  let ttftCell = dash;
  if (p?.ttftMs != null) {
    ttftCell = `<span class="mp-list-num">${Math.round(p.ttftMs)}</span><span class="mp-list-sub">ms</span>`;
  }

  // ctx
  let ctxCell = dash;
  if (p?.optimalNumCtx != null) {
    ctxCell = `<span class="mp-list-context" title="Profiled safe context window">
      <span class="mp-list-context__value">${_fmtCtx(p.optimalNumCtx)}</span>
      <span class="mp-list-context__label">context</span>
    </span>`;
  }

  // VRAM
  let vramCell = dash;
  if (p?.vramUsedMiB != null) {
    vramCell = `<span class="mp-list-num">${(p.vramUsedMiB / 1024).toFixed(1)}</span><span class="mp-list-sub">GB</span>`;
  }

  // Spill
  let spillCell = dash;
  const spill = p?.spill;
  if (spill?.spillDetected) {
    const at = spill.spillNumCtx ? ` at ${_fmtCtx(spill.spillNumCtx)}` : '';
    const safe = spill.lastSafeNumCtx ? ` (safe ${_fmtCtx(spill.lastSafeNumCtx)})` : '';
    spillCell = `<span class="mp-list-pill mp-list-pill--warn" title="GPU spill detected${at}${safe}">⚠ spills${at}</span>`;
  } else if (spill) {
    const safe = spill.lastSafeNumCtx ? `safe ${_fmtCtx(spill.lastSafeNumCtx)}` : 'no spill';
    spillCell = `<span class="mp-list-pill mp-list-pill--ok" title="No GPU spill during profiling">✓ ${safe}</span>`;
  }

  // Variant
  let variantCell = dash;
  if (adaptation?.adaptedName) {
    const status = String(adaptation.deployment?.status || 'pending').toLowerCase();
    const isDeployed = status === 'deployed';
    const variantTone = isDeployed ? 'ok' : status === 'failed' ? 'err' : 'pending';
    const statusLabel = isDeployed ? '' : `<span class="mp-list-variant__status mp-list-variant__status--${variantTone}">${status}</span>`;
    variantCell = `<span class="mp-list-variant" title="Adapted variant: ${escAttr(adaptation.adaptedName)} (${status})">
      <span class="mp-list-variant__name">${escAttr(adaptation.adaptedName)}</span>
      ${statusLabel}
    </span>`;
  }

  // Meta cell — depth + when + insight + stale all crammed but readable
  const metaBits = [];
  if (p?.profileDepth) metaBits.push(`<span class="mp-list-depth">${escAttr(p.profileDepth)}</span>`);
  const profiledStr = p?.profiledAt ? _formatProfileDate(p.profiledAt) : null;
  if (profiledStr) metaBits.push(`<span class="mp-list-when">${profiledStr}</span>`);
  if (stalenessInfo.stale) metaBits.push(`<span class="mp-stale-badge">stale</span>`);
  const ci = p?.contextInsight;
  if (ci?.upgradeAvailable) {
    metaBits.push(`<span class="mp-insight-chip mp-insight-chip--up" title="${ci.upgradeFactor}× ctx headroom (${_fmtCtx(ci.previousNumCtx)} → ${_fmtCtx(ci.discoveredNumCtx)})">▲ ${ci.upgradeFactor}×</span>`);
  } else if (ci && ci.upgradeFactor < 0.75) {
    metaBits.push(`<span class="mp-insight-chip mp-insight-chip--down" title="Declared ctx too high (${_fmtCtx(ci.previousNumCtx)} → ${_fmtCtx(ci.discoveredNumCtx)})">▼ ctx high</span>`);
  }
  const metaCell = metaBits.length ? metaBits.join('<span class="mp-foot-sep">·</span>') : dash;

  // Actions
  const actions = isEmbedding
    ? `<span class="mp-list-pill mp-list-pill--muted">embedding</span>`
    : `${highestStage === 'available'
        ? `<button class="mp-action mp-action--teal mp-btn-profile mp-card-cta" data-model="${escAttr(model.name)}">Profile</button>`
        : `<button class="mp-action mp-action--teal mp-btn-profile mp-card-cta" data-model="${escAttr(model.name)}">Reprofile</button>`}
      ${highestStage === 'profiled'
        ? `<button class="mp-action mp-action--orange mp-btn-adapt mp-card-cta" data-model="${escAttr(model.name)}">Adapt</button>` : ''}
      ${highestStage === 'benchmarked'
        ? `<a href="/" class="mp-bench-link">Bench →</a>` : ''}`;

  // Host dots removed — the stage badge + left-edge stripe already convey readiness
  const hostDots = '';

  return `<div class="mp-model-row" data-model="${escAttr(model.name)}" data-stage="${highestStage}"${isEmbedding ? ' data-embedding="1"' : ''}>
    <span class="mp-list-col mp-list-col--check">
      ${isEmbedding ? '' : `<input type="checkbox" class="mp-card-checkbox" data-model="${escAttr(model.name)}">`}
    </span>
    <span class="mp-list-col mp-list-col--name">
      <span class="mp-list-name">${escAttr(model.name)}</span>
      <span class="mp-list-meta">${meta}${hostDots ? `<span class="mp-list-hostdots">${hostDots}</span>` : ''}</span>
    </span>
    <span class="mp-list-col mp-list-col--badge">${badge}</span>
    <span class="mp-list-col mp-list-col--tps">${tpsCell}</span>
    <span class="mp-list-col mp-list-col--ttft">${ttftCell}</span>
    <span class="mp-list-col mp-list-col--ctx">${ctxCell}</span>
    <span class="mp-list-col mp-list-col--vram">${vramCell}</span>
    <span class="mp-list-col mp-list-col--spill">${spillCell}</span>
    <span class="mp-list-col mp-list-col--variant">${variantCell}</span>
    <span class="mp-list-col mp-list-col--meta">${metaCell}</span>
    <span class="mp-list-col mp-list-col--actions">${actions}</span>
    <span class="mp-model-feedback" data-model="${escAttr(model.name)}"></span>
  </div>`;
}

// ─── Settings panel ──────────────────────────────────────────────────────────

export function renderSettingsPanel(settings) {
  const s = settings || {};
  const degradation = s.degradationThreshold ?? 30;
  const contextProbeFill = s.contextProbeFillPct ?? 80;
  const contextFill = s.contextFillPct ?? 25;
  const maxPromptTokens = s.maxPromptTokens ?? 2048;
  const predTokens = s.numPredict ?? 64;
  const warmup = s.warmup !== false;
  const timeout = s.testTimeoutSec ?? 60;
  const throughputSamples = s.throughputSamples ?? 3;
  const collectHardwareTelemetry = s.collectHardwareTelemetry !== false;
  const showHardwareDiagnostics = s.showHardwareDiagnostics !== false;

  return `<details class="mp-settings-panel">
    <summary class="mp-settings-toggle">Advanced Settings</summary>
    <div class="mp-settings-body">
      <div class="mp-settings-field">
        <label class="mp-settings-label">Degradation Highlight</label>
        <div class="mp-settings-range-wrap">
          <input type="range" min="10" max="80" value="${degradation}" id="mp-set-degradation" class="mp-settings-input">
          <span class="mp-settings-range-val" id="mp-set-degradation-val">${degradation}%</span>
        </div>
        <div style="font-size:0.62rem; color:#8892b0; margin-top:0.25rem;">
          Visual alert only. Throughput changes never reduce the verified context window.
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Context Fill %</label>
        <div class="mp-settings-range-wrap">
          <input type="range" min="10" max="100" value="${contextFill}" id="mp-set-ctxfill" class="mp-settings-input">
          <span class="mp-settings-range-val" id="mp-set-ctxfill-val">${contextFill}%</span>
        </div>
        <div style="font-size:0.62rem; color:#8892b0; margin-top:0.25rem;">
          Used for the full-profile throughput curve, not the main comparable speed chip.
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Context Probe Fill %</label>
        <div class="mp-settings-range-wrap">
          <input type="range" min="10" max="90" step="5" value="${contextProbeFill}" id="mp-set-probefill" class="mp-settings-input">
          <span class="mp-settings-range-val" id="mp-set-probefill-val">${contextProbeFill}%</span>
        </div>
        <div style="font-size:0.62rem; color:#8892b0; margin-top:0.25rem;">
          Higher values stress long-document prompts. Lower values profile interactive chat where large dense models can use more context.
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Fixed Comparison Prompt</label>
        <input type="number" min="256" max="16384" step="256" value="${maxPromptTokens}" id="mp-set-maxprompt" class="mp-settings-input">
        <div style="font-size:0.62rem; color:#8892b0; margin-top:0.25rem;">
          Main <code>tok/s</code> cards use this fixed prompt size for apples-to-apples speed comparisons. If active ctx is smaller, the profiler clips the workload and marks it.
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Prediction Tokens</label>
        <select id="mp-set-predtokens" class="mp-settings-input">
          ${[64,128,256,512].map(v => `<option value="${v}"${v === predTokens ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Throughput Samples</label>
        <select id="mp-set-samples" class="mp-settings-input">
          ${[1,2,3,4,5].map(v => `<option value="${v}"${v === throughputSamples ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
        <div style="font-size:0.62rem; color:#8892b0; margin-top:0.25rem;">
          Repeat speed runs improve confidence. With 3+ samples the first run is discarded as warm-up settle, so CV reflects steady state.
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Warmup</label>
        <div class="mp-settings-checkbox-wrap">
          <input type="checkbox" id="mp-set-warmup" ${warmup ? 'checked' : ''}>
          <span>Enable warmup before profiling</span>
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Hardware Telemetry</label>
        <div class="mp-settings-checkbox-wrap">
          <input type="checkbox" id="mp-set-hw-collect" ${collectHardwareTelemetry ? 'checked' : ''}>
          <span>Capture GPU/VRAM/PCIe snapshots during profiling</span>
        </div>
        <div style="font-size:0.62rem; color:#8892b0; margin-top:0.25rem;">
          Uses Ollama <code>/api/ps</code> plus explicitly configured host metadata.
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Diagnostics Display</label>
        <div class="mp-settings-checkbox-wrap">
          <input type="checkbox" id="mp-set-hw-show" ${showHardwareDiagnostics ? 'checked' : ''}>
          <span>Show hardware strips on profiled model cards</span>
        </div>
      </div>
      <div class="mp-settings-field">
        <label class="mp-settings-label">Test Timeout (seconds)</label>
        <input type="number" min="30" max="300" value="${timeout}" id="mp-set-timeout" class="mp-settings-input">
      </div>
      <div class="mp-settings-save-row">
        <button class="mp-action mp-action--teal" id="mp-settings-save">Save Settings</button>
        <span class="mp-settings-error" style="color:#f85149; font-size:0.7rem; margin-left:0.5rem;"></span>
      </div>
    </div>
  </details>`;
}

// ─── Error / empty states ─────────────────────────────────────────────────────

export function renderError(msg) {
  return `<div class="mp-alert mp-alert--error" style="margin:1rem 0;">
    <span>⚠</span>
    <span>${msg}</span>
  </div>`;
}

export function renderLoading() {
  return '<div style="padding:24px; color:#8892b0; font-size:0.8rem;">Loading models…</div>';
}

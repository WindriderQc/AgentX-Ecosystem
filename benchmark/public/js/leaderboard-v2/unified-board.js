// unified-board.js — Combined Quality + Performance model stat cards
// Compact, informative cards showing all categories + performance at a glance.

import { scoreColor } from '../components/score-color.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_META = {
  coding:      { label: 'Coding',      color: '#7c9fff', icon: 'fa-code' },
  reasoning:   { label: 'Reasoning',   color: '#a78bfa', icon: 'fa-brain' },
  math:        { label: 'Math',        color: '#fbbf24', icon: 'fa-calculator' },
  knowledge:   { label: 'Knowledge',   color: '#34d399', icon: 'fa-book' },
  instruction: { label: 'Instruction', color: '#06b6d4', icon: 'fa-list-check' },
  creative:    { label: 'Creative',    color: '#f87171', icon: 'fa-paint-brush' },
  translation: { label: 'Translation', color: '#f472b6', icon: 'fa-language' }
};

const ALL_CATEGORIES = Object.keys(CATEGORY_META);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreClass(score) {
  if (score > 8) return 'h';
  if (score > 6) return 'm';
  return 'l';
}

export function formatMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function shortHost(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

export function valColor(val, good, warn) {
  if (val <= good) return '#4fc3f7';
  if (val <= warn) return '#ffb74d';
  return '#ef5350';
}

// ---------------------------------------------------------------------------
// Speedometer SVG
// ---------------------------------------------------------------------------

/**
 * Render a half-arc speedometer gauge using stroke-dasharray on a single circle.
 * No overlapping paths — one background track, one colored fill, needle + text.
 */
export function speedometer(value, max, { unit = '', size = 90, zones } = {}) {
  const cx = size / 2;
  const cy = size * 0.58;
  const r = size * 0.36;
  const strokeW = size * 0.06;
  const clamped = Math.min(max, Math.max(0, value));
  const ratio = clamped / max;

  // Half-circle circumference (π * r)
  const halfCirc = Math.PI * r;

  // Active color based on zone thresholds
  const defaultZones = [
    { pct: 0.15, color: '#ef5350' },
    { pct: 0.40, color: '#ffb74d' },
    { pct: 1.0,  color: '#4dd0e1' }
  ];
  const zn = zones || defaultZones;
  let activeColor = zn[zn.length - 1].color;
  for (const z of zn) {
    if (ratio <= z.pct) { activeColor = z.color; break; }
  }

  const fillLen = halfCirc * ratio;
  const gapLen = halfCirc - fillLen;

  // Needle
  const needleAngle = Math.PI - ratio * Math.PI;
  const needleLen = r - strokeW * 0.8;
  const nx = cx + needleLen * Math.cos(needleAngle);
  const ny = cy - needleLen * Math.sin(needleAngle);

  const valFontSize = size * 0.18;
  const unitFontSize = size * 0.09;

  return `<svg width="${size}" height="${size * 0.75}" viewBox="0 0 ${size} ${size * 0.75}" class="ub-speedo">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="rgba(255,255,255,0.06)" stroke-width="${strokeW}"
      stroke-dasharray="${halfCirc} ${halfCirc}"
      stroke-dashoffset="0"
      transform="rotate(180 ${cx} ${cy})"
      stroke-linecap="butt"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${activeColor}" stroke-width="${strokeW}"
      stroke-dasharray="${fillLen} ${halfCirc + gapLen}"
      stroke-dashoffset="0"
      transform="rotate(180 ${cx} ${cy})"
      stroke-linecap="round" opacity="0.8"/>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#e0e0e0" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="2" fill="#1a1a2e"/>
    <circle cx="${cx}" cy="${cy}" r="1.2" fill="#e0e0e0"/>
    <text x="${cx}" y="${cy - valFontSize * 0.4}" text-anchor="middle" fill="#fff" font-size="${valFontSize}px" font-weight="800">${Math.round(value)}</text>
    <text x="${cx}" y="${cy + unitFontSize * 1.1}" text-anchor="middle" fill="#777" font-size="${unitFontSize}px">${unit}</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Card sub-sections
// ---------------------------------------------------------------------------

/** Build a map of category name → yesRate from dimensions array */
function buildDimMap(dims) {
  const map = {};
  for (const d of dims) {
    map[d.name] = d.yesRate ?? 0;
  }
  return map;
}

/** Render ALL 7 category rows with score-based coloring (matches generalist board) */
export function categoryRows(dims) {
  const dimMap = buildDimMap(dims);

  return ALL_CATEGORIES.map(cat => {
    const meta = CATEGORY_META[cat];
    const rate = dimMap[cat] ?? null;
    const pct = rate != null ? Math.round(rate * 100) : null;
    const clamped = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
    // Score on 0-10 scale for scoreColor (rate is 0-1)
    const score10 = rate != null ? rate * 10 : 0;
    const barColor = pct != null ? scoreColor(score10) : 'var(--r-border)';
    const dotColor = pct != null ? scoreColor(score10) : '#444';
    const valText = pct != null ? `${clamped}%` : '—';
    const dimClass = pct == null ? ' ub-dim-na' : '';

    return `<div class="ub-dim${dimClass}">
      <span class="ub-dim-dot" style="background:${dotColor}"></span>
      <span class="ub-dim-l">${meta.label}</span>
      <div class="ub-dim-track"><div class="ub-dim-fill" style="width:${clamped}%;background:${barColor}"></div></div>
      <span class="ub-dim-v">${valText}</span>
    </div>`;
  }).join('');
}

/** Render performance section: speedometer + latency values */
export function perfGrid(entry) {
  const hasPerfData = entry.tokPerSec != null || entry.successRate != null || entry.avgLatency != null;
  if (!hasPerfData) return '';

  const tokPerSec  = entry.tokPerSec ?? 0;
  const avgLat     = entry.avgLatency;
  const p95Lat     = entry.p95Latency;
  const ttft       = entry.benchmarkTtft;

  const speedGauge = speedometer(tokPerSec, 100, {
    unit: 'tok/s',
    size: 100,
    zones: [
      { pct: 0.15, color: '#ef5350' },
      { pct: 0.40, color: '#ffb74d' },
      { pct: 1.0,  color: '#4dd0e1' }
    ]
  });

  return `<div class="ub-perf">
    <div class="ub-speedo-wrap">${speedGauge}</div>
    <div class="ub-perf-vals">
      <div class="ub-perf-item">
        <span class="ub-perf-label">avg lat</span>
        <span class="ub-perf-val" style="color:${avgLat != null ? valColor(avgLat, 2000, 5000) : '#666'}">${formatMs(avgLat)}</span>
      </div>
      <div class="ub-perf-item">
        <span class="ub-perf-label">p95 lat</span>
        <span class="ub-perf-val" style="color:${p95Lat != null ? valColor(p95Lat, 4000, 8000) : '#666'}">${formatMs(p95Lat)}</span>
      </div>
      <div class="ub-perf-item">
        <span class="ub-perf-label">Bench TTFT</span>
        <span class="ub-perf-val" style="color:${ttft != null ? valColor(ttft, 500, 2000) : '#666'}">${formatMs(ttft)}</span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Unified card renderer
// ---------------------------------------------------------------------------

function renderCard(entry, isLeader) {
  const model = entry.model || '—';
  const hostName = entry.hostName || shortHost(entry.host) || '';
  const host = entry.hostTtft != null
    ? `${hostName}${hostName ? ' | ' : ''}host TTFT ${formatMs(entry.hostTtft)}`
    : hostName;
  const scoreVal = entry.score ?? 0;
  const scoreCls = scoreClass(scoreVal);
  const leaderCls = isLeader ? ' ub-leader' : '';

  // --- All 7 category bars ---
  const dims = entry.dimensions || [];
  const dimBars = dims.length > 0
    ? categoryRows(dims)
    : `<div class="ub-no-data">No quality data</div>`;

  // --- Performance metrics grid ---
  const perfHtml = perfGrid(entry);

  // --- Stats footer ---
  const confidence = entry.confidence != null ? entry.confidence.toFixed(2) : '—';
  const testCount = entry.testCount ?? '—';
  const confClass = entry.confidence != null && entry.confidence >= 0.8 ? 'good' : '';
  const successRate = entry.successRate ?? null;
  const succColor = successRate != null
    ? (successRate >= 90 ? '#81c784' : successRate >= 70 ? '#ffb74d' : '#ef5350')
    : '#666';
  const succText = successRate != null ? `${successRate}%` : '—';
  const coeff = entry.perfCoeff ?? null;
  const coefColor = coeff != null
    ? (coeff >= 0.9 ? '#4fc3f7' : coeff >= 0.7 ? '#ffb74d' : '#ef5350')
    : '#666';

  return `<div class="ub-card${leaderCls}">
    <div class="ub-head">
      <div class="ub-identity">
        <div class="ub-model" title="${model}">${model}</div>
        <div class="ub-host">${host}</div>
      </div>
      <div class="ub-score-block">
        <div class="ub-score ${scoreCls}">${scoreVal.toFixed(2)}</div>
        <div class="ub-score-label">UGRank</div>
      </div>
    </div>

    <div class="ub-dims">${dimBars}</div>

    ${perfHtml}

    <div class="ub-footer">
      <span class="ub-stat"><span class="ub-stat-l">Conf</span><span class="ub-stat-v ${confClass}">${confidence}</span></span>
      <span class="ub-stat"><span class="ub-stat-l">Tests</span><span class="ub-stat-v">${testCount}</span></span>
      <span class="ub-stat"><span class="ub-stat-l">Success</span><span class="ub-stat-v" style="color:${succColor}">${succText}</span></span>
      <span class="ub-stat"><span class="ub-stat-l">Coeff</span><span class="ub-stat-v" style="color:${coefColor}">${coeff != null ? coeff.toFixed(2) : '—'}</span></span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Grid builder + export
// ---------------------------------------------------------------------------

function buildGrid(rankings) {
  if (!rankings || rankings.length === 0) {
    return '<div class="r-empty">No model data yet — run a benchmark to populate the board.</div>';
  }

  let leaderIdx = 0;
  let hi = -Infinity;
  rankings.forEach((e, i) => {
    const s = e.score ?? 0;
    if (s > hi) { hi = s; leaderIdx = i; }
  });

  return `<div class="ub-grid">${rankings.map((e, i) => renderCard(e, i === leaderIdx)).join('')}</div>`;
}

export function renderUnifiedBoard(container, rankings) {
  container.innerHTML = `
    <div class="r-sec-head">
      <span class="r-sec-icon">📊</span>
      <span class="r-sec-title r-t-cyan">Model Stats</span>
      <span class="r-sec-toggle">▼</span>
    </div>
    <div class="r-sec-body">${buildGrid(rankings)}</div>`;
}

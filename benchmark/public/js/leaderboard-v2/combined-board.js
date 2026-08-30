// combined-board.js — Single Model Leaderboard (Quality Ranking + Model Stats merged)
//
// Each card uses a 3-line layout:
//   Line 1 — rank + model name + host (with judge icon)        | UGRank score (right)
//   Line 2 — columns: Badges | Category bars | Timing | Speedo (right)
//   Line 3 — Test compilation stats (Tests, Conf, Cal, Reviewed, Success, Coeff)

import { getReadinessMap, getBadgeHtml } from '../model-profiler/components/readiness-cache.js';
import { speedometer, formatMs, valColor, shortHost } from './unified-board.js';
import { scoreColor } from '../components/score-color.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEDAL = ['🥇', '🥈', '🥉'];
const RANK_CLASS = ['r1', 'r2', 'r3'];

const CATEGORY_META = {
  coding:      { icon: '💻', label: 'Coding' },
  reasoning:   { icon: '🧠', label: 'Reasoning' },
  math:        { icon: '🔢', label: 'Math' },
  knowledge:   { icon: '📚', label: 'Knowledge' },
  instruction: { icon: '📋', label: 'Instruction' },
  creative:    { icon: '🎨', label: 'Creative' },
  translation: { icon: '🌐', label: 'Translation' }
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreClass(score) {
  if (score > 8) return 'h';
  if (score > 6) return 'm';
  return 'l';
}

function entryKey(entry) {
  return `${entry.model || ''}::${entry.host || ''}`;
}

function categoryScore(entry, category) {
  const raw = entry.categoryScores?.[category];
  return raw !== null && raw !== undefined && Number.isFinite(Number(raw))
    ? Number(raw)
    : null;
}

function buildDimMap(dims) {
  const map = {};
  for (const d of (dims || [])) {
    if (d.yesRate !== null && d.yesRate !== undefined && Number.isFinite(Number(d.yesRate))) {
      map[d.name] = Number(d.yesRate);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Champions
// ---------------------------------------------------------------------------

function buildChampionMap(rankings) {
  const champions = new Map();
  for (const category of CATEGORY_ORDER) {
    let winner = null;
    let winnerScore = -Infinity;
    for (const entry of rankings) {
      const score = categoryScore(entry, category);
      if (score === null) continue;
      if (score > winnerScore) { winner = entry; winnerScore = score; }
    }
    if (!winner) continue;
    const key = entryKey(winner);
    const list = champions.get(key) || [];
    list.push({ ...CATEGORY_META[category], score: winnerScore });
    champions.set(key, list);
  }
  return champions;
}

function renderChampionBadges(entry, championMap) {
  const champs = championMap.get(entryKey(entry)) || [];
  if (champs.length === 0) return '<span class="cb-no-badge">—</span>';
  return champs.map(({ icon, label, score }) => `
    <span class="cb-champ" title="Best in ${label} (${score.toFixed(1)} / 10)">
      <span>${icon}</span><span>${label}</span>
    </span>`).join('');
}

// ---------------------------------------------------------------------------
// Best / Watch lane pills
// ---------------------------------------------------------------------------

function categoryExtremes(entry) {
  const scores = CATEGORY_ORDER
    .map(category => ({
      category,
      meta: CATEGORY_META[category],
      score: categoryScore(entry, category)
    }))
    .filter(item => item.score !== null);
  if (scores.length === 0) return { best: null, watch: null };
  const sorted = scores.sort((a, b) => b.score - a.score);
  return { best: sorted[0], watch: sorted[sorted.length - 1] };
}

function renderLanePill(item, tone, label) {
  if (!item) return '';
  return `<span class="cb-lane cb-lane-${tone}" title="${item.meta.label}: ${item.score.toFixed(1)} / 10">
    <span class="cb-lane-tag">${label}</span>
    <span>${item.meta.icon}</span>
    <strong>${item.score.toFixed(1)}</strong>
  </span>`;
}

// ---------------------------------------------------------------------------
// Trend / cal
// ---------------------------------------------------------------------------

function renderTrend(trend) {
  if (!trend) return '';
  const { direction, delta } = trend;
  if (direction === 'new') return `<span class="cb-trend new">NEW</span>`;
  if (direction === 'up') {
    const d = delta != null ? `+${Number(delta).toFixed(1)}` : '';
    return `<span class="cb-trend up">▲ ${d}</span>`;
  }
  if (direction === 'dn' || direction === 'down') {
    const d = delta != null ? `-${Math.abs(Number(delta)).toFixed(1)}` : '';
    return `<span class="cb-trend dn">▼ ${d}</span>`;
  }
  return '';
}

function renderCalBadge(entry) {
  const count = entry.testCount || 0;
  const calibrated = entry.judgeCalibrated || false;
  if (count === 0) return '<span title="Insufficient data" style="color:var(--r-text-dim)">—</span>';
  if (calibrated && count >= 10) return '<span title="Calibrated judge, 10+ results" style="color:var(--r-good)">✓</span>';
  return '<span title="Uncalibrated judge or few results" style="color:var(--r-anomaly)">⚠</span>';
}

function confidenceClass(c) {
  if (c == null) return '';
  if (c <= 0.8) return 'good';
  if (c <= 1.4) return 'watch';
  return 'bad';
}

function compactCounts(counts, prefix = '') {
  const entries = Object.entries(counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]) || b[1] - a[1]);
  if (entries.length === 0) return '—';
  return entries.slice(0, 3)
    .map(([value, count]) => `${prefix}${value}:${count}`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Category bars (no dots — leaner version)
// ---------------------------------------------------------------------------

function categoryBars(dims, categoryEvidence = {}) {
  const dimMap = buildDimMap(dims);
  return CATEGORY_ORDER.map(cat => {
    const meta = CATEGORY_META[cat];
    const rate = dimMap[cat] ?? null;
    const pct = rate != null ? Math.round(rate * 100) : null;
    const clamped = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
    const score10 = rate != null ? rate * 10 : 0;
    const barColor = pct != null ? scoreColor(score10) : 'var(--r-border)';
    const valText = pct != null ? `${clamped}` : '—';
    const naCls = pct == null ? ' cb-bar-na' : '';
    const unavailableReason = categoryEvidence[cat] === 'attempted_unscored'
      ? 'attempted; score unavailable'
      : 'not tested';
    const title = pct != null ? `${meta.label}: ${valText}%` : `${meta.label}: ${unavailableReason}`;
    return `<div class="cb-bar${naCls}" title="${title}">
      <span class="cb-bar-l">${meta.label}</span>
      <div class="cb-bar-track"><div class="cb-bar-fill" style="width:${clamped}%;background:${barColor}"></div></div>
      <span class="cb-bar-v">${valText}</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Timing column + speedometer
// ---------------------------------------------------------------------------

function timingColumn(entry) {
  const { avgLatency: avgLat, p95Latency: p95Lat, benchmarkTtft: ttft, hostTtft } = entry;
  const hasAny = avgLat != null || p95Lat != null || ttft != null || hostTtft != null;
  if (!hasAny) return '<div class="cb-no-data cb-timing-empty">No timing data</div>';

  const item = (label, val, good, warn) => `<div class="cb-time-item">
    <span class="cb-time-l">${label}</span>
    <span class="cb-time-v" style="color:${val != null ? valColor(val, good, warn) : 'var(--r-text-dim)'}">${formatMs(val)}</span>
  </div>`;

  return `<div class="cb-timing">
    ${item('avg lat',    avgLat,   2000, 5000)}
    ${item('p95 lat',    p95Lat,   4000, 8000)}
    ${item('bench TTFT', ttft,      500, 2000)}
    ${item('host TTFT',  hostTtft,  500, 2000)}
  </div>`;
}

function speedoColumn(entry) {
  const tokPerSec = entry.tokPerSec;
  if (tokPerSec == null) return '<div class="cb-no-data cb-speedo-empty">No speed data</div>';
  return `<div class="cb-speedo">${speedometer(tokPerSec, 100, {
    unit: 'tok/s',
    size: 110,
    zones: [
      { pct: 0.15, color: '#ef5350' },
      { pct: 0.40, color: '#ffb74d' },
      { pct: 1.0,  color: '#4dd0e1' }
    ]
  })}</div>`;
}

// ---------------------------------------------------------------------------
// Row card (3-line layout)
// ---------------------------------------------------------------------------

function renderRow(entry, index, championMap, readinessMap, { provisional = false } = {}) {
  const model = entry.model || '—';
  const readinessBadge = readinessMap ? getBadgeHtml(model, readinessMap) : '';
  const hostName = entry.hostName || shortHost(entry.host) || '—';
  const judgeModel = entry.judgeModel || null;
  const judgeIcon = judgeModel
    ? `<span class="cb-judge" title="Judge: ${judgeModel}"><i class="fas fa-gavel"></i></span>`
    : '';
  const hostTtftLabel = entry.hostTtft != null ? ` · host TTFT ${formatMs(entry.hostTtft)}` : '';

  const canMedal = !provisional && entry.fullScopeEligible === true && index < 3;
  const rank = canMedal
    ? `<span class="cb-medal ${RANK_CLASS[index]}">${MEDAL[index]}</span>`
    : `<span class="cb-rank-num">${provisional ? 'P' : '#'}${index + 1}</span>`;

  const score = entry.score ?? 0;
  const scoreCls = scoreClass(score);
  const leaderCls = index === 0 && canMedal ? ' cb-leader' : '';

  const { best, watch } = categoryExtremes(entry);
  const watchTone = watch && watch.score < 6 ? 'bad' : 'watch';

  // --- Line 2 columns ---
  const badgesCol = `<div class="cb-col cb-col-badges">
    <div class="cb-col-head">Badges</div>
    <div class="cb-badges">${renderChampionBadges(entry, championMap)}</div>
    <div class="cb-lanes">
      ${renderLanePill(best, 'best', 'Best')}
      ${renderLanePill(watch, watchTone, 'Watch')}
    </div>
  </div>`;

  const dims = entry.dimensions || [];
  const axisLabel = {
    composite: 'Composite',
    deterministic: 'Deterministic',
    subjective: 'Judge'
  }[entry.scoreAxis] || 'Score';
  const barsCol = `<div class="cb-col cb-col-bars">
    <div class="cb-col-head">${axisLabel} (per category)</div>
    ${dims.length > 0 ? categoryBars(dims, entry.categoryEvidence) : '<div class="cb-no-data">No scored categories yet</div>'}
  </div>`;

  const timingCol = `<div class="cb-col cb-col-timing">
    <div class="cb-col-head">Timing</div>
    ${timingColumn(entry)}
  </div>`;

  const speedoCol = `<div class="cb-col cb-col-speedo">
    <div class="cb-col-head">Throughput</div>
    ${speedoColumn(entry)}
  </div>`;

  // --- Line 3 stats ---
  const confidence = entry.confidence != null ? `±${entry.confidence.toFixed(2)}` : '—';
  const confCls = confidenceClass(entry.confidence);
  const tests = entry.testCount ?? '—';
  const levels = compactCounts(entry.promptLevelCounts, 'L');
  const contexts = compactCounts(entry.contextCounts);
  const difficultyPenalty = Number(entry.difficultyPenalty || 0);
  const evidencePenalty = Number(entry.evidenceConfidencePenalty || 0);
  const evidenceConfidence = entry.evidenceConfidence != null
    ? `${Math.round(Number(entry.evidenceConfidence) * 100)}%`
    : '—';
  const difficultyCoverage = entry.difficultyCoverage != null ? `${entry.difficultyCoverage}%` : '—';
  const requiredLevels = (entry.requiredPromptLevels || []).map(l => `L${l}`).join(', ');
  const difficultyTitle = entry.fullScopeMinLevel
    ? `Required hard-level coverage: ${requiredLevels || `L${entry.fullScopeMinLevel}+`}`
    : 'Hard-level coverage';
  const evidenceBadge = entry.fullScopeEligible === false
    ? '<span class="cb-stat" title="Partial benchmark evidence: run the missing levels/categories before treating this as a full-scope leader"><span class="cb-stat-l">Scope</span><span class="cb-stat-v watch">PARTIAL</span></span>'
    : '';
  const unavailableBadge = entry.host_available === false
    ? '<span class="cb-unavailable-badge" title="This model is in the benchmark archive but is not currently present on its recorded Ollama host">Deleted</span>'
    : '';
  const reviewNeeded = entry.needsReviewCount ?? entry.reviewCount ?? 0;
  const lowConfidence = entry.lowConfidenceCount ?? 0;
  const successRate = entry.successRate != null ? `${entry.successRate}%` : '—';
  const succColor = entry.successRate != null
    ? (entry.successRate >= 90 ? '#81c784' : entry.successRate >= 70 ? '#ffb74d' : '#ef5350')
    : 'var(--r-text-dim)';
  const coeff = entry.perfCoeff != null ? entry.perfCoeff.toFixed(2) : '—';
  const coeffColor = entry.perfCoeff != null
    ? (entry.perfCoeff >= 0.9 ? '#4fc3f7' : entry.perfCoeff >= 0.7 ? '#ffb74d' : '#ef5350')
    : 'var(--r-text-dim)';

  return `<div class="cb-row${leaderCls}">

    <div class="cb-line cb-line-head">
      <div class="cb-rank">${rank}</div>
      <div class="cb-id">
        <div class="cb-model">
          <span class="cb-model-name">${model}</span>${readinessBadge}${unavailableBadge}
          <a href="/courthouse?model=${encodeURIComponent(model)}" class="cb-link" title="Review in Courthouse"><i class="fas fa-gavel"></i></a>
          <a href="/efficiency-map" class="cb-link" title="Efficiency Map"><i class="fas fa-chart-line"></i></a>
        </div>
        <div class="cb-host">
          <i class="fas fa-server cb-host-ico"></i><span class="cb-host-name">${hostName}</span>${judgeIcon}<span class="cb-host-meta">${hostTtftLabel}</span>
        </div>
      </div>
      <div class="cb-score-block">
        ${renderTrend(entry.trend)}
        <div class="cb-score ${scoreCls}">${score.toFixed(2)}</div>
        <div class="cb-score-label">UGRank</div>
      </div>
    </div>

    <div class="cb-line cb-line-body">
      ${badgesCol}
      ${barsCol}
      ${timingCol}
      ${speedoCol}
    </div>

    <div class="cb-line cb-line-stats">
      <span class="cb-stat"><span class="cb-stat-l">Tests</span><span class="cb-stat-v">${tests}</span></span>
      <span class="cb-stat" title="Prompt level mix"><span class="cb-stat-l">Levels</span><span class="cb-stat-v">${levels}</span></span>
      <span class="cb-stat" title="Context sizes used"><span class="cb-stat-l">Ctx</span><span class="cb-stat-v">${contexts}</span></span>
      <span class="cb-stat" title="${difficultyTitle}"><span class="cb-stat-l">Hard</span><span class="cb-stat-v ${difficultyPenalty > 0 ? 'bad' : 'good'}">${difficultyCoverage}${difficultyPenalty > 0 ? ` / -${difficultyPenalty.toFixed(1)}` : ''}</span></span>
      <span class="cb-stat" title="Average judge evidence confidence${entry.evidenceConfidenceTarget != null ? `; target ${Math.round(Number(entry.evidenceConfidenceTarget) * 100)}%` : ''}"><span class="cb-stat-l">Evid</span><span class="cb-stat-v ${evidencePenalty > 0 ? 'watch' : 'good'}">${evidenceConfidence}${evidencePenalty > 0 ? ` / -${evidencePenalty.toFixed(1)}` : ''}</span></span>
      ${evidenceBadge}
      <span class="cb-stat" title="${entry.confidenceMethod === 'weighted_category_prompt_means_t95' ? `Weighted 95% interval from ${entry.confidenceSampleSize || 0} independent prompt means; ${entry.confidenceRepeatCount || entry.testCount || 0} total attempts` : 'Uncertainty is unknown until each scored category has at least two independent prompt fixtures'}"><span class="cb-stat-l">Conf</span><span class="cb-stat-v ${confCls}">${confidence}</span></span>
      <span class="cb-stat"><span class="cb-stat-l">Cal</span><span class="cb-stat-v">${renderCalBadge(entry)}</span></span>
      <span class="cb-stat" title="Rows flagged for manual review"><span class="cb-stat-l">Review</span><span class="cb-stat-v ${reviewNeeded > 0 ? 'watch' : 'good'}">${reviewNeeded}</span></span>
      <span class="cb-stat" title="Rows with judge confidence below 0.70"><span class="cb-stat-l">LowConf</span><span class="cb-stat-v ${lowConfidence > 0 ? 'watch' : 'good'}">${lowConfidence}</span></span>
      <span class="cb-stat"><span class="cb-stat-l">Success</span><span class="cb-stat-v" style="color:${succColor}">${successRate}</span></span>
      <span class="cb-stat"><span class="cb-stat-l">Coeff</span><span class="cb-stat-v" style="color:${coeffColor}">${coeff}</span></span>
    </div>

  </div>`;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

const TRIAGE_OPTIONS = [
  { key: 'generalist', label: 'Generalist', icon: '🏁' },
  ...CATEGORY_ORDER.map(cat => ({ key: cat, label: CATEGORY_META[cat].label, icon: CATEGORY_META[cat].icon }))
];

function renderTriageChips(active) {
  return `<div class="cb-triage" role="tablist" aria-label="Sort leaderboard by category">
    ${TRIAGE_OPTIONS.map(opt => `
      <button class="cb-triage-chip${opt.key === active ? ' active' : ''}"
              data-cat="${opt.key}" role="tab"
              aria-selected="${opt.key === active}">
        <span class="cb-triage-ico">${opt.icon}</span><span>${opt.label}</span>
      </button>`).join('')}
  </div>`;
}

function sortRankings(rankings, mode) {
  if (mode === 'generalist' || !mode) {
    return [...rankings].sort((a, b) => {
      if (a.fullScopeEligible !== b.fullScopeEligible) return a.fullScopeEligible ? -1 : 1;
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }
  // Category mode — sort by that category score; entries lacking the score sink to bottom.
  return [...rankings].sort((a, b) => {
    const av = categoryScore(a, mode);
    const bv = categoryScore(b, mode);
    const aOk = av !== null;
    const bOk = bv !== null;
    if (aOk && bOk) return bv - av;
    if (aOk) return -1;
    if (bOk) return 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}

function scopeKey(entry) {
  const lanes = CATEGORY_ORDER.filter(category => categoryScore(entry, category) !== null).sort();
  const levels = Object.entries(entry.promptLevelCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([level]) => Number(level))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return `${lanes.join(',')}@@${levels.join(',')}`;
}

function renderRows(rankings, championMap, readinessMap, options = {}) {
  return rankings.map((e, i) => renderRow(e, i, championMap, readinessMap, options)).join('');
}

export async function renderCombinedBoard(container, rankings) {
  const readinessMap = await getReadinessMap().catch(() => ({}));
  const comparableScopes = new Set((rankings || []).map(scopeKey)).size <= 1;
  const provisional = !(rankings || []).some(entry => entry.fullScopeEligible === true);
  const championMap = comparableScopes ? buildChampionMap(rankings) : new Map();

  // Persist active triage on the container so re-renders preserve user choice.
  const active = container.dataset.triageMode || 'generalist';

  const head = `<div class="r-sec-head">
    <span class="r-sec-icon">🏁</span>
    <span class="r-sec-title r-t-cyan">Model Leaderboard</span>
    <span class="r-sec-toggle">▼</span>
  </div>`;

  const empty = !rankings || rankings.length === 0;
  const sorted = empty ? [] : sortRankings(rankings, active);

  const body = empty
    ? `<div class="r-empty">No rankings yet — launch a benchmark to populate the leaderboard.</div>`
    : `${comparableScopes ? renderTriageChips(active) : '<div class="r-empty" role="note" style="text-align:left;">Scopes differ. Category champion badges and category re-ranking are disabled.</div>'}<div class="cb-list" id="cb-list">
        ${renderRows(sorted, championMap, readinessMap, { provisional })}
      </div>`;

  container.innerHTML = `${head}<div class="r-sec-body">${body}</div>`;

  if (empty) return;

  // Wire chip clicks — re-sort and re-render only the list, preserving section state.
  const triage = container.querySelector('.cb-triage');
  const list = container.querySelector('#cb-list');
  if (triage && list) {
    triage.addEventListener('click', (e) => {
      const chip = e.target.closest('.cb-triage-chip');
      if (!chip) return;
      const next = chip.dataset.cat;
      if (!next || next === container.dataset.triageMode) return;
      container.dataset.triageMode = next;
      // Update active state
      triage.querySelectorAll('.cb-triage-chip').forEach(c => {
        const on = c.dataset.cat === next;
        c.classList.toggle('active', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const reSorted = sortRankings(rankings, next);
      list.innerHTML = renderRows(reSorted, championMap, readinessMap, { provisional });
    });
  }

  // Initialise dataset on first render
  if (!container.dataset.triageMode) container.dataset.triageMode = active;
}

// combined-board.js — Compact model index + complete model evidence sheet.
//
// The index is intentionally scan-first: one graphic row per model. Every
// field that used to occupy the three-line card remains available in the
// dialog opened from that row. This is presentation-only; ranking, trust and
// routing contracts stay upstream and unchanged.

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

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function scoreClass(score) {
  if (score == null || !Number.isFinite(Number(score))) return '';
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

function playgroundUrl(entry) {
  if (entry?.executionTarget?.executionKind === 'harness' || entry?.host_available === false || !entry?.model) return null;
  const configuredCore = typeof document !== 'undefined' && typeof document.querySelector === 'function'
    ? document.querySelector('main[data-core-public-url]')?.dataset.corePublicUrl
    : null;
  if (!configuredCore) return null;
  try {
    const url = new URL('/playground', configuredCore);
    url.searchParams.set('model', entry.model);
    if (entry.host) url.searchParams.set('host', entry.host);
    return url.toString();
  } catch {
    return null;
  }
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
    const unavailableReason = categoryEvidence[cat] === 'review_pending'
      ? 'pending human review; provisional score withheld'
      : categoryEvidence[cat] === 'attempted_unscored'
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
// Compact row + complete model sheet
// ---------------------------------------------------------------------------

function detailKey(index) {
  return `model-detail-${index}`;
}

function evidenceState(entry) {
  return entry.evidenceTrustVerdict?.state || entry.evidenceTrustState || 'inconclusive';
}

function evidenceLabel(entry) {
  return ({
    trusted: 'Trusted evidence',
    exploratory: 'Exploratory evidence',
    stale: 'Stale evidence',
    inconclusive: 'Inconclusive evidence'
  })[evidenceState(entry)] || 'Inconclusive evidence';
}

function compactCategoryStrip(entry) {
  return CATEGORY_ORDER.map(category => {
    const meta = CATEGORY_META[category];
    const score = categoryScore(entry, category);
    const pct = score == null ? 0 : Math.min(100, Math.max(0, score * 10));
    const state = score == null ? 'empty' : scoreClass(score);
    const value = score == null ? 'not scored' : `${score.toFixed(1)} / 10`;
    return `<span class="cb-spark ${state}" style="--spark-fill:${pct}%" title="${meta.label}: ${value}">
      <span class="cb-spark-fill"></span><span class="cb-spark-label">${meta.icon}</span>
    </span>`;
  }).join('');
}

function rowState(entry) {
  const notes = [evidenceLabel(entry)];
  if (entry.fullScopeEligible === false) notes.push('partial scope');
  if (entry.rankable === false) notes.push('unranked');
  if (entry.host_available === false) notes.push('deleted');
  return notes.join(' · ');
}

function renderDetailStat(label, value, { className = '', title = '', style = '' } = {}) {
  return `<div class="cb-detail-stat"${title ? ` title="${esc(title)}"` : ''}>
    <span class="cb-detail-stat-label">${label}</span>
    <strong class="cb-detail-stat-value ${className}"${style ? ` style="${style}"` : ''}>${value}</strong>
  </div>`;
}

function renderRow(entry, index, championMap, readinessMap, { provisional = false } = {}) {
  const model = entry.model || '—';
  const readinessBadge = readinessMap ? getBadgeHtml(model, readinessMap) : '';
  const hostName = entry.hostName || shortHost(entry.host) || '—';
  const judgeModel = entry.judgeModel || null;
  const useModelUrl = playgroundUrl(entry);
  const isLocal = (entry.tier || 'local') === 'local';
  const evidenceLevel = evidenceState(entry);
  const evidenceProof = evidenceLabel(entry);

  const canMedal = entry.rankable !== false && !provisional && entry.fullScopeEligible === true && index < 3;
  const rank = canMedal
    ? `<span class="cb-medal ${RANK_CLASS[index]}">${MEDAL[index]}</span>`
    : `<span class="cb-rank-num">${entry.rankable === false ? '—' : `${provisional ? 'P' : '#'}${index + 1}`}</span>`;

  const score = entry.score;
  const scoreCls = scoreClass(score);
  const leaderCls = index === 0 && canMedal ? ' cb-leader' : '';
  const scorePct = Number.isFinite(score) ? Math.min(100, Math.max(0, score * 10)) : 0;

  const { best, watch } = categoryExtremes(entry);
  const watchTone = watch && watch.score < 6 ? 'bad' : 'watch';

  // --- Full-sheet graphic columns ---
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

  // --- Full-sheet evidence stats ---
  const confidence = entry.confidence != null ? `±${entry.confidence.toFixed(2)}` : '—';
  const confCls = confidenceClass(entry.confidence);
  const tests = entry.testCount ?? '—';
  const levels = compactCounts(entry.promptLevelCounts, 'L');
  const contexts = compactCounts(entry.contextCounts);
  const difficultyPenalty = Number(entry.difficultyPenalty || 0);
  const evidencePenalty = Number(entry.evidenceConfidencePenalty || 0);
  const difficultyKnown = entry.difficultyCoverage != null
    && Number.isFinite(Number(entry.difficultyCoverage));
  const evidenceKnown = entry.evidenceConfidence != null
    && Number.isFinite(Number(entry.evidenceConfidence));
  const evidenceConfidence = evidenceKnown
    ? `${Math.round(Number(entry.evidenceConfidence) * 100)}%`
    : '—';
  const evidenceClass = !evidenceKnown ? '' : evidencePenalty > 0 ? 'watch' : 'good';
  const evidenceTitle = evidenceKnown
    ? `Average judge evidence confidence${entry.evidenceConfidenceTarget != null ? `; target ${Math.round(Number(entry.evidenceConfidenceTarget) * 100)}%` : ''}`
    : 'Judge-score provenance confidence is unknown. Legacy rows may still contain an LLM judge score while lacking modern scorer, artifact, or runtime identity.';
  const difficultyCoverage = difficultyKnown ? `${entry.difficultyCoverage}%` : '—';
  const difficultyClass = !difficultyKnown ? '' : difficultyPenalty > 0 ? 'bad' : 'good';
  const requiredLevels = (entry.requiredPromptLevels || []).map(l => `L${l}`).join(', ');
  const difficultyTitle = entry.fullScopeMinLevel
    ? `Required hard-level coverage: ${requiredLevels || `L${entry.fullScopeMinLevel}+`}`
    : 'Hard-level coverage';
  const unavailableBadge = entry.host_available === false
    ? '<span class="cb-unavailable-badge" title="This model is in the benchmark archive but is not currently present on its recorded Ollama host">Deleted</span>'
    : '';
  const nonComparableBadge = entry.rankable === false
    ? `<span class="cb-unavailable-badge" title="Visible evidence only; excluded from rank${entry.filterReason ? `: ${esc(entry.filterReason)}` : ''}">UNRANKED</span>`
    : '';
  const harnessLabel = entry.harness?.name ? ` · ${entry.harness.name} ${entry.harness.version || ''}` : '';
  const tierLabel = entry.tier === 'paid_cloud' ? 'paid cloud' : entry.tier === 'free_cloud' ? 'free cloud' : 'local';
  const pricingLabel = entry.pricing?.kind && entry.pricing.kind !== 'free'
    ? ` · manual estimate · ${entry.pricing.source || 'declared price'}`
    : '';
  const providerCost = Number(entry.providerCostNanodollars || 0);
  const providerCostLabel = isLocal
    ? '—'
    : entry.pricing?.kind === 'free'
      ? 'US$0 (declared)'
      : `~US$${(providerCost / 1e9).toFixed(6)}`;
  const providerCostTitle = isLocal
    ? 'Local execution has no provider-price attribution'
    : entry.pricing?.kind === 'free'
      ? `Provider cost declared free by ${entry.pricing?.source || 'catalog'}`
      : `Manual estimated provider cost for these rows; source: ${entry.pricing?.source || 'catalog snapshot'}`;
  const reviewNeeded = entry.needsReviewCount ?? entry.reviewCount ?? 0;
  const lowConfidenceKnown = evidenceKnown
    || (entry.evidenceConfidenceCoverage != null && Number(entry.evidenceConfidenceCoverage) > 0);
  const lowConfidence = lowConfidenceKnown ? (entry.lowConfidenceCount ?? 0) : null;
  const lowConfidenceLabel = lowConfidence === null ? '—' : String(lowConfidence);
  const lowConfidenceClass = lowConfidence === null ? '' : lowConfidence > 0 ? 'watch' : 'good';
  const successRate = entry.successRate != null ? `${entry.successRate}%` : '—';
  const succColor = entry.successRate != null
    ? (entry.successRate >= 90 ? '#81c784' : entry.successRate >= 70 ? '#ffb74d' : '#ef5350')
    : 'var(--r-text-dim)';
  const coeff = entry.perfCoeff != null ? entry.perfCoeff.toFixed(2) : '—';
  const coeffColor = entry.perfCoeff != null
    ? (entry.perfCoeff >= 0.9 ? '#4fc3f7' : entry.perfCoeff >= 0.7 ? '#ffb74d' : '#ef5350')
    : 'var(--r-text-dim)';

  const key = detailKey(index);
  const speedValue = entry.tokPerSec != null ? `${entry.tokPerSec} tok/s` : '—';
  const ttftValue = entry.benchmarkTtft != null ? formatMs(entry.benchmarkTtft) : '—';
  const compactScope = difficultyKnown ? `${difficultyCoverage} hard` : `${tests} tests`;
  const summary = `<button type="button" class="cb-row-open" data-detail-key="${key}"
      aria-haspopup="dialog" aria-controls="cb-model-dialog" aria-label="Open full evidence sheet for ${esc(model)}">
    <span class="cb-rank">${rank}</span>
    <span class="cb-summary-id">
      <span class="cb-summary-model">${esc(model)}${readinessBadge}</span>
      <span class="cb-summary-source"><i class="fas fa-${isLocal ? 'server' : 'cloud'}" aria-hidden="true"></i> ${esc(entry.provider || 'ollama')} · ${esc(tierLabel)} · ${esc(hostName)}</span>
      <span class="cb-summary-state" data-evidence-level="${esc(evidenceLevel)}">${esc(rowState(entry))}</span>
    </span>
    <span class="cb-summary-score" style="--score-pct:${scorePct}%">
      <span class="cb-score ${scoreCls}">${Number.isFinite(score) ? score.toFixed(2) : '—'}</span>
      <span class="cb-score-label">${entry.rankable === false ? 'Unranked' : 'UGRank'}</span>
    </span>
    <span class="cb-summary-categories" aria-label="Category score profile">${compactCategoryStrip(entry)}</span>
    <span class="cb-summary-pace">
      <strong>${speedValue}</strong><small>${ttftValue} TTFT</small>
    </span>
    <span class="cb-summary-coverage">
      <strong>${compactScope}</strong><small>${confidence === '—' ? 'uncertainty unknown' : `${confidence} uncertainty`}</small>
    </span>
    <span class="cb-summary-open" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>
  </button>`;

  const detail = `<div class="cb-detail-sheet" data-detail-model="${esc(model)}">
    <header class="cb-detail-hero">
      <div class="cb-detail-rank">${rank}</div>
      <div class="cb-detail-identity">
        <p class="cb-detail-kicker">Complete model evidence</p>
        <h3 id="cb-model-dialog-title">${esc(model)}</h3>
        <div class="cb-detail-badges">${readinessBadge}${unavailableBadge}${nonComparableBadge}<span class="cb-use-model-proof" data-evidence-level="${esc(evidenceLevel)}">${esc(evidenceProof)}</span></div>
      </div>
      <div class="cb-detail-score" style="--score-pct:${scorePct}%">
        ${renderTrend(entry.trend)}
        <strong class="${scoreCls}">${Number.isFinite(score) ? score.toFixed(2) : '—'}</strong>
        <span>${entry.rankable === false ? 'Unranked' : 'UGRank'} / 10</span>
      </div>
    </header>

    <section class="cb-detail-provenance" aria-label="Execution provenance">
      <div><span>Host</span><strong>${esc(hostName)}</strong><small>${esc(entry.host || 'Host identity unavailable')}</small></div>
      <div><span>Source</span><strong>${esc(entry.provider || 'ollama')} · ${esc(tierLabel)}</strong><small>${esc(`${harnessLabel ? harnessLabel.replace(/^ · /, '') : 'direct model'}${pricingLabel}`)}</small></div>
      <div><span>Judge</span><strong>${esc(judgeModel || '—')}</strong><small>${judgeModel ? 'Observed judge target' : 'Judge identity unavailable'}</small></div>
      <div><span>Evidence</span><strong>${esc(evidenceProof)}</strong><small>${esc(entry.qualityCohortFingerprint || 'Cohort fingerprint unavailable')}</small></div>
    </section>

    <div class="cb-detail-grid">
      <section class="cb-detail-panel cb-detail-categories">
        <div class="cb-detail-panel-head"><div><span>Capability profile</span><h4>${axisLabel} by category</h4></div><span class="cb-detail-panel-icon">◫</span></div>
        <div class="cb-detail-highlight-row">${badgesCol}</div>
        <div class="cb-detail-bars">${dims.length > 0 ? categoryBars(dims, entry.categoryEvidence) : '<div class="cb-no-data">No scored categories yet</div>'}</div>
      </section>

      <section class="cb-detail-panel cb-detail-performance">
        <div class="cb-detail-panel-head"><div><span>Runtime profile</span><h4>Speed & latency</h4></div><span class="cb-detail-panel-icon">↗</span></div>
        <div class="cb-detail-performance-grid">
          <div><div class="cb-col-head">Timing</div>${timingColumn(entry)}</div>
          <div><div class="cb-col-head">Throughput</div>${speedoColumn(entry)}</div>
        </div>
      </section>

      <section class="cb-detail-panel cb-detail-evidence">
        <div class="cb-detail-panel-head"><div><span>Evidence ledger</span><h4>Coverage, confidence & cost</h4></div><span class="cb-detail-panel-icon">◎</span></div>
        <div class="cb-detail-stat-grid">
          ${renderDetailStat('Tests', tests)}
          ${renderDetailStat('Levels', levels, { title: 'Prompt level mix' })}
          ${renderDetailStat('Contexts', contexts, { title: 'Context sizes used' })}
          ${renderDetailStat('Hard coverage', `${difficultyCoverage}${difficultyPenalty > 0 ? ` / -${difficultyPenalty.toFixed(1)}` : ''}`, { className: difficultyClass, title: difficultyTitle })}
          ${renderDetailStat('Evidence confidence', `${evidenceConfidence}${evidencePenalty > 0 ? ` / -${evidencePenalty.toFixed(1)}` : ''}`, { className: evidenceClass, title: evidenceTitle })}
          ${entry.fullScopeEligible === false ? renderDetailStat('Scope', 'PARTIAL', { className: 'watch', title: 'Run missing levels/categories before treating this as full-scope evidence' }) : ''}
          ${renderDetailStat('Uncertainty', confidence, { className: confCls, title: entry.confidenceMethod === 'weighted_category_prompt_means_t95' ? `Weighted 95% interval from ${entry.confidenceSampleSize || 0} independent prompt means; ${entry.confidenceRepeatCount || entry.testCount || 0} total attempts` : 'Uncertainty is unknown until each scored category has at least two independent prompt fixtures' })}
          ${renderDetailStat('Calibration', renderCalBadge(entry))}
          ${renderDetailStat('Needs review', reviewNeeded, { className: reviewNeeded > 0 ? 'watch' : 'good', title: 'Rows flagged for manual review; this is not the human-reviewed count' })}
          ${renderDetailStat('Low confidence', lowConfidenceLabel, { className: lowConfidenceClass, title: 'Rows with an observed judge confidence below 0.70' })}
          ${renderDetailStat('Success', successRate, { style: `color:${succColor}` })}
          ${renderDetailStat('Provider cost', esc(providerCostLabel), { title: providerCostTitle })}
          ${renderDetailStat('Performance coeff.', coeff, { style: `color:${coeffColor}` })}
        </div>
      </section>
    </div>

    <footer class="cb-detail-actions">
      <p><strong>Manual choice only.</strong> Opening a model never changes routing automatically.</p>
      <div>
        <a href="/courthouse?model=${encodeURIComponent(model)}" class="cb-detail-action"><i class="fas fa-gavel" aria-hidden="true"></i> Review in Courthouse</a>
        <a href="/efficiency-map" class="cb-detail-action"><i class="fas fa-chart-line" aria-hidden="true"></i> Efficiency Map</a>
        ${useModelUrl ? `<a href="${useModelUrl}" class="cb-detail-action cb-use-model" title="Open this exact model and host in Manual Chat; routing will not change automatically"><i class="fas fa-comment-dots" aria-hidden="true"></i> Use in Chat</a>` : ''}
      </div>
    </footer>
  </div>`;

  return `<article class="cb-row${leaderCls}">${summary}<template data-cb-detail="${key}">${detail}</template></article>`;
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
      if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
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

function dialogMarkup() {
  return `<dialog id="cb-model-dialog" class="cb-dialog" aria-labelledby="cb-model-dialog-title">
    <div class="cb-dialog-frame">
      <button type="button" class="cb-dialog-close" data-cb-dialog-close aria-label="Close model details">
        <i class="fas fa-xmark" aria-hidden="true"></i>
      </button>
      <div class="cb-dialog-content"></div>
    </div>
  </dialog>`;
}

function wireModelDialog(container) {
  if (!container || typeof container.addEventListener !== 'function') return;
  if (container._cbDialogWired) return;
  container._cbDialogWired = true;
  container.addEventListener('click', (event) => {
    const dialog = container.querySelector('#cb-model-dialog');
    if (!dialog) return;

    const closeButton = event.target.closest('[data-cb-dialog-close]');
    if (closeButton || event.target === dialog) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      return;
    }

    const trigger = event.target.closest('.cb-row-open');
    if (!trigger || !container.contains(trigger)) return;
    const template = Array.from(container.querySelectorAll('template[data-cb-detail]'))
      .find(candidate => candidate.dataset.cbDetail === trigger.dataset.detailKey);
    const content = dialog.querySelector('.cb-dialog-content');
    if (!template || !content) return;

    content.innerHTML = template.innerHTML;
    container._cbLastTrigger = trigger;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    requestAnimationFrame(() => dialog.querySelector('[data-cb-dialog-close]')?.focus());
  });
}

export async function renderCombinedBoard(container, rankings) {
    const activeDetailKey = container.querySelector?.('#cb-model-dialog[open]')
      ? container._cbLastTrigger?.dataset?.detailKey
      : null;
    const readinessMap = await getReadinessMap().catch(() => ({}));
    const comparableScopes = new Set((rankings || []).map(scopeKey)).size <= 1;
    const trustVerdict = (rankings || []).find((entry) => entry.evidenceTrustVerdict)?.evidenceTrustVerdict || null;
    const provisional = true;
    const championMap = new Map();

  // Persist active triage on the container so re-renders preserve user choice.
  const active = container.dataset.triageMode || 'generalist';

  const evidenceTitle = trustVerdict?.state === 'exploratory'
    ? 'Exploratory observations — no qualified winner'
    : 'Evidence observations — no qualified winner';
  const head = `<div class="r-sec-head">
    <span class="r-sec-icon">🏁</span>
    <span class="r-sec-heading">
      <span class="r-sec-title r-t-cyan">Model leaderboard</span>
      <span class="cb-board-subtitle">${evidenceTitle} · Open any row for the complete evidence sheet.</span>
    </span>
    <span class="cb-board-count">${(rankings || []).length} model${(rankings || []).length === 1 ? '' : 's'}</span>
    <span class="r-sec-toggle">▼</span>
  </div>`;

  const empty = !rankings || rankings.length === 0;
  const sorted = empty ? [] : sortRankings(rankings, active);

  const body = empty
    ? `<div class="r-empty">No rankings yet — launch a benchmark to populate the leaderboard.</div>`
    : `${comparableScopes ? renderTriageChips(active) : '<div class="r-empty" role="note" style="text-align:left;">Scopes differ. Category comparison badges and category re-ranking are disabled.</div>'}<div class="cb-list" id="cb-list">
        ${renderRows(sorted, championMap, readinessMap, { provisional })}
      </div>${dialogMarkup()}`;

  container.innerHTML = `${head}<div class="r-sec-body">${body}</div>`;

  if (empty) return;
  wireModelDialog(container);
  const dialog = container.querySelector('#cb-model-dialog');
  if (dialog) {
    dialog.addEventListener('close', () => {
      const trigger = container._cbLastTrigger;
      container._cbLastTrigger = null;
      trigger?.focus();
    });
  }
  if (activeDetailKey) {
    requestAnimationFrame(() => {
      const trigger = Array.from(container.querySelectorAll('.cb-row-open'))
        .find(candidate => candidate.dataset.detailKey === activeDetailKey);
      trigger?.click();
    });
  }

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

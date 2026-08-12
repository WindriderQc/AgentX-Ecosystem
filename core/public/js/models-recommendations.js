/**
 * Models Page — Benchmark Recommendations Widget
 *
 * Renders a "Benchmark Recommends" banner at the top of the models page,
 * showing top-rated models per category from the benchmark recommend API.
 * Data flows: benchmark service -> core proxy -> this widget.
 */

/* globals escapeHtml */

(function () {
  'use strict';

  const PROXY_BASE = '/api/benchmark-proxy';
  const CATEGORIES = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
  const CAT_ICONS = {
    coding:      'fa-code',
    reasoning:   'fa-brain',
    math:        'fa-calculator',
    knowledge:   'fa-book',
    instruction: 'fa-list-check',
    creative:    'fa-palette',
    translation: 'fa-language'
  };
  const CAT_COLORS = {
    coding:      '#3b82f6',
    reasoning:   '#a855f7',
    math:        '#f59e0b',
    knowledge:   '#06b6d4',
    instruction: '#10b981',
    creative:    '#ec4899',
    translation: '#64748b'
  };
  const CONFIDENCE_MAP = {
    high:   { label: 'High',   cls: 'rec-conf-high',   symbol: '\u2713' },
    medium: { label: 'Medium', cls: 'rec-conf-medium', symbol: '\u26A0' },
    low:    { label: 'Low',    cls: 'rec-conf-low',    symbol: '\u2014' }
  };

  function scoreColor(score) {
    if (score >= 8) return '#22c55e';
    if (score >= 6) return '#3b82f6';
    if (score >= 4) return '#f59e0b';
    return '#ef4444';
  }

  function stripHost(url) {
    if (!url) return '';
    return String(url).replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  }

  function safe(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  async function fetchRecommendations(category) {
    const res = await fetch(`${PROXY_BASE}/recommend?category=${encodeURIComponent(category)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json?.data?.recommendations || [];
  }

  function buildChips(activeCategory, container) {
    container.innerHTML = CATEGORIES.map(cat => {
      const icon = CAT_ICONS[cat] || 'fa-tag';
      const active = cat === activeCategory ? ' rec-chip-active' : '';
      return `<button class="rec-chip${active}" data-cat="${cat}" style="--chip-color:${CAT_COLORS[cat]}">
        <i class="fas ${icon}"></i> ${cat.charAt(0).toUpperCase() + cat.slice(1)}
      </button>`;
    }).join('');
  }

  function buildRows(recs) {
    if (!recs || recs.length === 0) {
      return '<div class="rec-empty">No benchmark data for this category yet.</div>';
    }
    return recs.slice(0, 5).map((rec, i) => {
      const score = typeof rec.quality_score === 'number' ? rec.quality_score : null;
      const color = score != null ? scoreColor(score) : '#888';
      const displayScore = score != null ? score.toFixed(1) : '--';
      const conf = CONFIDENCE_MAP[rec.confidence] || CONFIDENCE_MAP.low;
      const host = stripHost(rec.host);
      const model = safe(rec.model || '--');
      const count = rec.result_count != null ? rec.result_count : 0;
      const barWidth = score != null ? Math.min(100, (score / 10) * 100) : 0;

      return `<div class="rec-row">
        <span class="rec-rank">#${i + 1}</span>
        <div class="rec-model-info">
          <span class="rec-model-name" title="${model}">${model}</span>
          ${host ? `<span class="rec-host">${safe(host)}</span>` : ''}
        </div>
        <div class="rec-score-bar-wrap">
          <div class="rec-score-bar" style="width:${barWidth}%; background:${color};"></div>
        </div>
        <span class="rec-score" style="color:${color}">${displayScore}</span>
        <span class="rec-conf ${conf.cls}" title="${conf.label} confidence">${conf.symbol}</span>
        <span class="rec-count">${count} run${count !== 1 ? 's' : ''}</span>
      </div>`;
    }).join('');
  }

  // Resolve the browser-reachable benchmark URL from /api/config publicUrls.
  // Falls back to localhost so single-host setups keep working. (0208)
  async function getBenchmarkUrl() {
    try {
      const res = await fetch('/api/config', { credentials: 'include' });
      const cfg = await res.json();
      return cfg?.publicUrls?.benchmark || 'http://localhost:3081';
    } catch {
      return 'http://localhost:3081';
    }
  }

  async function init() {
    const anchor = document.querySelector('.stats-row');
    if (!anchor) return;

    const benchmarkUrl = await getBenchmarkUrl();

    // Create the widget container
    const widget = document.createElement('div');
    widget.className = 'rec-widget glass-panel';
    widget.innerHTML = `
      <div class="rec-header">
        <div class="rec-title">
          <i class="fas fa-trophy" style="color:#f59e0b;"></i>
          Benchmark Recommends
        </div>
        <a href="${benchmarkUrl}/leaderboard-v2.html" target="_blank" class="rec-link">
          Full Leaderboard <i class="fas fa-external-link-alt"></i>
        </a>
      </div>
      <div class="rec-chips" id="recChips"></div>
      <div class="rec-body" id="recBody">
        <div class="rec-empty">Loading...</div>
      </div>`;

    // Insert after stats row
    anchor.after(widget);

    const chipsEl = widget.querySelector('#recChips');
    const bodyEl = widget.querySelector('#recBody');
    let activeCategory = 'coding';

    async function load(category) {
      activeCategory = category;
      buildChips(category, chipsEl);
      bindChips();
      bodyEl.innerHTML = '<div class="rec-empty">Loading...</div>';

      try {
        const recs = await fetchRecommendations(category);
        bodyEl.innerHTML = buildRows(recs);
      } catch (err) {
        console.warn('[models-recommendations] fetch failed:', err);
        bodyEl.innerHTML = '<div class="rec-empty" style="color:#f87171;">Benchmark service unavailable.</div>';
      }
    }

    function bindChips() {
      chipsEl.querySelectorAll('.rec-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const cat = chip.dataset.cat;
          if (cat && cat !== activeCategory) load(cat);
        });
      });
    }

    load(activeCategory);
  }

  // Boot after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

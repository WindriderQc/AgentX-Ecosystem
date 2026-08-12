/**
 * RAG Search Playground — execute semantic queries, display scored results.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────

  var els = {};

  function cacheElements() {
    els.query       = document.getElementById('search-query');
    els.topkSlider  = document.getElementById('topk-slider');
    els.topkValue   = document.getElementById('topk-value');
    els.minSlider   = document.getElementById('minscore-slider');
    els.minValue    = document.getElementById('minscore-value');
    els.source      = document.getElementById('search-source');
    els.tags        = document.getElementById('search-tags');
    els.optExpand   = document.getElementById('opt-expand');
    els.optHybrid   = document.getElementById('opt-hybrid');
    els.optRerank   = document.getElementById('opt-rerank');
    els.optCompress = document.getElementById('opt-compress');
    els.btnSearch   = document.getElementById('btn-search');
    els.meta        = document.getElementById('search-meta');
    els.results     = document.getElementById('search-results');
    els.empty       = document.getElementById('search-empty');
    els.error       = document.getElementById('search-error');
    els.status      = document.getElementById('search-status');
  }

  // ── Helpers ───────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncateText(text, max) {
    max = max || 200;
    if (!text || text.length <= max) return escapeHtml(text);
    return escapeHtml(text.substring(0, max)) + '&hellip;';
  }

  function setSearchStatus(state, title, detail) {
    if (!els.status) return;
    els.status.className = 'flow-status is-' + state;
    els.status.innerHTML =
      '<strong>' + escapeHtml(title) + '</strong>' +
      '<span class="flow-status-detail">' + escapeHtml(detail) + '</span>';
  }

  /**
   * Map a 0.0-1.0 score to a red-yellow-green color.
   */
  function scoreToColor(score) {
    // Clamp
    var s = Math.max(0, Math.min(1, score));
    var r, g;
    if (s < 0.5) {
      // Red to yellow
      r = 255;
      g = Math.round(s * 2 * 255);
    } else {
      // Yellow to green
      r = Math.round((1 - (s - 0.5) * 2) * 255);
      g = 255;
    }
    return 'rgb(' + r + ',' + g + ',60)';
  }

  // ── Slider wiring ────────────────────────────────────────

  function wireSliders() {
    els.topkSlider.addEventListener('input', function () {
      els.topkValue.textContent = this.value;
    });

    els.minSlider.addEventListener('input', function () {
      var val = (parseInt(this.value, 10) / 100).toFixed(2);
      els.minValue.textContent = val;
    });
  }

  // ── Execute search ────────────────────────────────────────

  var searching = false;

  async function executeSearch() {
    if (searching) return;

    var query = els.query.value.trim();
    if (!query) {
      setSearchStatus('warn', 'Query required', 'Enter a query before running retrieval.');
      els.query.focus();
      return;
    }

    var topK = parseInt(els.topkSlider.value, 10);
    var minScore = parseInt(els.minSlider.value, 10) / 100;
    var source = els.source.value.trim();
    var tags = els.tags.value.trim();

    var filters = {};
    if (source) filters.source = source;
    if (tags) filters.tags = tags.split(',').map(function (t) { return t.trim(); });

    // Advanced retrieval toggles (default off — preserves baseline behaviour)
    var options = {
      expand:   !!(els.optExpand && els.optExpand.checked),
      hybrid:   !!(els.optHybrid && els.optHybrid.checked),
      rerank:   !!(els.optRerank && els.optRerank.checked),
      compress: !!(els.optCompress && els.optCompress.checked)
    };
    var enhancements = [];
    if (options.expand) enhancements.push('expand');
    if (options.hybrid) enhancements.push('hybrid');
    if (options.rerank) enhancements.push('rerank');
    if (options.compress) enhancements.push('compress');

    // Reset display
    els.meta.style.display = 'none';
    els.results.innerHTML = '';
    els.empty.style.display = 'none';
    els.error.style.display = 'none';

    searching = true;
    els.btnSearch.disabled = true;
    els.btnSearch.textContent = 'Searching...';
    setSearchStatus(
      'loading',
      'Embedding query and retrieving',
      'Searching top ' + topK + ' chunks' + (minScore > 0 ? ' with minScore ' + minScore.toFixed(2) : '') + '.'
    );

    var startTime = performance.now();

    try {
      var hasFilters = Object.keys(filters).length > 0;
      var resp = await window.RAG.search(query, topK, minScore, hasFilters ? filters : undefined, options);
      var elapsed = Math.round(performance.now() - startTime);
      var results = resp.data.results || [];

      // Show meta (note which enhancements were applied, if any)
      els.meta.style.display = '';
      els.meta.textContent = 'Found ' + results.length + ' result' +
        (results.length !== 1 ? 's' : '') + ' in ' + elapsed + 'ms' +
        (enhancements.length ? ' · enhancements: ' + enhancements.join(', ') : '');

      if (results.length === 0) {
        els.empty.style.display = '';
        setSearchStatus('warn', 'No matches returned', 'Retrieval completed in ' + elapsed + 'ms, but no chunks passed the current filters.');
        return;
      }

      renderResults(results);
      setSearchStatus(
        'ok',
        'Results ready',
        'Found ' + results.length + ' result' + (results.length !== 1 ? 's' : '') + ' in ' + elapsed + 'ms.'
      );
    } catch (err) {
      els.error.style.display = '';
      els.error.textContent = 'Search failed: ' + (err.message || 'unknown error');
      setSearchStatus('error', 'Search failed', err.message || 'Unknown retrieval error.');
    } finally {
      searching = false;
      els.btnSearch.disabled = false;
      els.btnSearch.textContent = 'Search';
    }
  }

  // ── Render results ────────────────────────────────────────

  function renderResults(results) {
    els.results.innerHTML = '';
    results.forEach(function (result, i) {
      var rank = i + 1;
      var score = typeof result.score === 'number' ? result.score : 0;
      var color = scoreToColor(score);
      var pct = Math.round(score * 100);
      var meta = result.metadata || {};
      var docSource = meta.source || meta.documentId || '';
      var docId = meta.documentId || '';

      // Compression (0055): backend may return compressedText/wasCompressed/compressionRatio.
      var displayText = result.wasCompressed && result.compressedText
        ? result.compressedText
        : (result.text || '');

      // Deep-link to the Documents page, filtered to this result's source/document.
      var docLink = '';
      if (docSource || docId) {
        var params = [];
        if (docSource) params.push('source=' + encodeURIComponent(docSource));
        if (docId) params.push('docId=' + encodeURIComponent(docId));
        docLink = '<a class="result-source-link" href="/documents?' + params.join('&') + '">View source document</a>';
      }

      var card = document.createElement('div');
      card.className = 'result-card';

      card.innerHTML =
        '<div class="result-header">' +
          '<span class="result-rank">#' + rank + '</span>' +
          '<div class="score-display">' +
            '<div class="score-bar-bg">' +
              '<div class="score-bar" style="width:' + pct + '%;background:' + color + ';"></div>' +
            '</div>' +
            '<span class="score-value mono">' + score.toFixed(3) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="result-text" data-full="' + escapeHtml(displayText) + '" data-truncated="true">' +
          truncateText(displayText, 200) +
        '</div>' +
        '<div class="result-meta">' +
          (docSource ? '<span>Source: ' + escapeHtml(docSource) + '</span>' : '') +
          (docId ? '<span class="mono">ID: ' + escapeHtml(docId) + '</span>' : '') +
          (result.wasCompressed ? '<span title="Trimmed to query-relevant sentences">compressed' +
            (typeof result.compressionRatio === 'number'
              ? ' ' + Math.round(result.compressionRatio * 100) + '%' : '') + '</span>' : '') +
          (docLink ? docLink : '') +
        '</div>';

      // Click to expand/collapse text
      var textEl = card.querySelector('.result-text');
      textEl.addEventListener('click', function () {
        if (textEl.dataset.truncated === 'true') {
          textEl.innerHTML = escapeHtml(textEl.dataset.full);
          textEl.dataset.truncated = 'false';
        } else {
          textEl.innerHTML = truncateText(textEl.dataset.full, 200);
          textEl.dataset.truncated = 'true';
        }
      });

      els.results.appendChild(card);
    });
  }

  // ── Init ──────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();
    wireSliders();

    els.btnSearch.addEventListener('click', executeSearch);

    // Enter key in textarea (without shift) triggers search
    els.query.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        executeSearch();
      }
    });
    els.query.addEventListener('input', function () {
      setSearchStatus(
        els.query.value.trim() ? 'ok' : 'loading',
        els.query.value.trim() ? 'Query ready' : 'Waiting for query',
        els.query.value.trim()
          ? 'Press Search to embed the query and retrieve nearest indexed chunks.'
          : 'Enter a query to embed it and retrieve the nearest indexed chunks.'
      );
    });
  });
})();

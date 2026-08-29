/**
 * Agent X Knowledge search — readiness-gated retrieval with progressive controls.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  var documentContext = window.RAGDocumentContext;
  var els = {};
  var searching = false;
  var searchReady = false;

  function cacheElements() {
    els.query = document.getElementById('search-query');
    els.topkSlider = document.getElementById('topk-slider');
    els.topkValue = document.getElementById('topk-value');
    els.minSlider = document.getElementById('minscore-slider');
    els.minValue = document.getElementById('minscore-value');
    els.source = document.getElementById('search-source');
    els.tags = document.getElementById('search-tags');
    els.optExpand = document.getElementById('opt-expand');
    els.optHybrid = document.getElementById('opt-hybrid');
    els.optRerank = document.getElementById('opt-rerank');
    els.optCompress = document.getElementById('opt-compress');
    els.btnSearch = document.getElementById('btn-search');
    els.meta = document.getElementById('search-meta');
    els.results = document.getElementById('search-results');
    els.empty = document.getElementById('search-empty');
    els.error = document.getElementById('search-error');
    els.status = document.getElementById('search-status');
    els.readiness = document.getElementById('knowledge-search-readiness');
    els.readinessLabel = document.getElementById('knowledge-search-readiness-label');
    els.readinessDetail = document.getElementById('knowledge-search-readiness-detail');
    els.prerequisiteAction = document.getElementById('search-prerequisite-action');
    els.starters = document.querySelectorAll('.starter-prompt');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncateText(text, max) {
    max = max || 260;
    if (!text || text.length <= max) return escapeHtml(text);
    return escapeHtml(text.substring(0, max)) + '&hellip;';
  }

  function setSearchStatus(state, title, detail) {
    if (!els.status) return;
    var icons = { ok: 'fa-circle-check', warn: 'fa-circle-info', error: 'fa-circle-exclamation', loading: 'fa-circle-notch fa-spin' };
    els.status.className = 'flow-status is-' + state;
    els.status.innerHTML = '<i class="fa-solid ' + icons[state] + '" aria-hidden="true"></i>' +
      '<span><strong>' + escapeHtml(title) + '</strong><span class="flow-status-detail">' + escapeHtml(detail) + '</span></span>';
  }

  function setReadiness(state, label, detail, action) {
    searchReady = state === 'ok';
    els.readiness.className = 'knowledge-readiness is-' + state;
    var icon = els.readiness.querySelector('.knowledge-readiness-icon i');
    var icons = { ok: 'fa-circle-check', warn: 'fa-circle-info', error: 'fa-circle-exclamation', loading: 'fa-circle-notch fa-spin' };
    if (icon) icon.className = 'fa-solid ' + icons[state];
    els.readinessLabel.textContent = label;
    els.readinessDetail.textContent = detail;
    els.query.disabled = !searchReady;
    els.starters.forEach(function (starter) { starter.disabled = !searchReady; });
    els.btnSearch.disabled = searching || !searchReady || !els.query.value.trim();
    if (action) {
      els.prerequisiteAction.textContent = action.label;
      els.prerequisiteAction.href = action.href;
      els.prerequisiteAction.hidden = false;
    } else {
      els.prerequisiteAction.hidden = true;
    }
  }

  async function checkReadiness() {
    setReadiness('loading', 'Checking your knowledge…', 'Confirming that a source is ready to search');
    try {
      var response = await window.RAG.getStatus();
      var data = response && response.data ? response.data : {};
      var documents = Number(data.documentCount || 0);
      var dependencies = data.dependencies || {};
      var mongo = dependencies.mongodb;
      var vectorOk = !!(data.vectorStore && data.vectorStore.healthy);
      var mongoOk = !!(mongo && mongo.healthy);
      var embedding = dependencies.embedding;
      var embeddingOk = !!(embedding && embedding.healthy);
      var overallOk = data.healthy === true;
      if (!overallOk || !mongoOk || !vectorOk || !embeddingOk) {
        var dependencyDetail = !mongoOk
          ? 'The document database is unavailable.'
          : !vectorOk
            ? 'The vector store is unavailable.'
            : !embeddingOk
              ? 'The embedding route is unavailable.'
              : 'One or more required knowledge dependencies are unavailable.';
        setReadiness('error', 'Search needs attention', dependencyDetail, { label: 'View status', href: '/' });
        setSearchStatus('error', 'Search is unavailable', 'Open knowledge status for the affected dependency.');
      } else if (documents === 0) {
        setReadiness('warn', 'Add a source first', 'Search is healthy, but there is nothing to retrieve yet.', { label: 'Add knowledge', href: '/upload' });
        setSearchStatus('warn', 'Your knowledge is empty', 'Add one source, then return to ask a question.');
      } else {
        setReadiness('ok', 'Ready to find evidence', documents.toLocaleString() + ' source' + (documents === 1 ? '' : 's') + ' available');
        setSearchStatus('loading', 'Waiting for a question', 'Ask in plain language; Agent X will return matching passages.');
      }
    } catch (error) {
      setReadiness('error', 'Could not check knowledge', error.message || 'The knowledge service did not respond.', { label: 'View status', href: '/' });
      setSearchStatus('error', 'Search is unavailable', 'Try again from the knowledge status page.');
    }
  }

  function wireSliders() {
    els.topkSlider.addEventListener('input', function () { els.topkValue.textContent = this.value; });
    els.minSlider.addEventListener('input', function () { els.minValue.textContent = (parseInt(this.value, 10) / 100).toFixed(2); });
  }

  function matchSignal(score) {
    if (score >= 0.75) return { state: 'strong', icon: 'fa-circle-check', label: 'Strong match' };
    if (score >= 0.45) return { state: 'possible', icon: 'fa-circle-info', label: 'Possible match' };
    return { state: 'weak', icon: 'fa-circle-minus', label: 'Weak match' };
  }

  function renderResults(results) {
    els.results.innerHTML = '';
    results.forEach(function (result, index) {
      var judged = typeof result.llmScore === 'number';
      var score = judged ? result.llmScore : (typeof result.score === 'number' ? result.score : 0);
      var scoreKind = judged ? 'Judge relevance' : 'Retrieval match';
      var signal = matchSignal(score);
      var meta = result.metadata || {};
      var docSource = meta.source || '';
      var docId = meta.documentId || '';
      var displaySource = docSource || docId;
      var displayText = result.wasCompressed && result.compressedText ? result.compressedText : (result.text || '');
      var sourceHref = documentContext ? documentContext.documentsHref({ source: docSource, docId: docId }) : '';
      var hasBoundedSourceContext = sourceHref && sourceHref !== '/documents';

      var card = document.createElement('article');
      card.className = 'result-card';
      card.innerHTML =
        '<div class="result-header"><span class="result-rank">Evidence ' + (index + 1) + ' of ' + results.length + '</span>' +
          '<span class="match-signal is-' + signal.state + '"><i class="fa-solid ' + signal.icon + '" aria-hidden="true"></i> ' + signal.label + ' · ' + scoreKind + ' ' + Math.round(score * 100) + '%</span></div>' +
        '<button type="button" class="result-text" data-full="' + escapeHtml(displayText) + '" data-truncated="true" aria-expanded="false">' + truncateText(displayText, 260) + '</button>' +
        '<div class="result-meta">' +
          (displaySource ? '<span><i class="fa-regular fa-file-lines" aria-hidden="true"></i> ' + escapeHtml(displaySource) + '</span>' : '') +
          (docId ? '<span class="mono">ID: ' + escapeHtml(docId) + '</span>' : '') +
          (judged && typeof result.vectorScore === 'number' ? '<span>Vector match ' + Math.round(result.vectorScore * 100) + '%</span>' : '') +
          (result.wasCompressed ? '<span><i class="fa-solid fa-compress" aria-hidden="true"></i> Focused excerpt</span>' : '') +
          (hasBoundedSourceContext ? '<a class="result-source-link" href="' + escapeHtml(sourceHref) + '">Open exact source <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>' : '') +
        '</div>';

      var textButton = card.querySelector('.result-text');
      textButton.addEventListener('click', function () {
        var expand = textButton.dataset.truncated === 'true';
        textButton.innerHTML = expand ? escapeHtml(textButton.dataset.full) : truncateText(textButton.dataset.full, 260);
        textButton.dataset.truncated = expand ? 'false' : 'true';
        textButton.setAttribute('aria-expanded', expand ? 'true' : 'false');
      });
      els.results.appendChild(card);
    });
  }

  async function executeSearch() {
    if (searching || !searchReady) return;
    var query = els.query.value.trim();
    if (!query) {
      setSearchStatus('warn', 'Question required', 'Enter what you want to find.');
      els.query.focus();
      return;
    }

    var topK = parseInt(els.topkSlider.value, 10);
    var minScore = parseInt(els.minSlider.value, 10) / 100;
    var filters = {};
    if (els.source.value.trim()) filters.source = els.source.value.trim();
    if (els.tags.value.trim()) filters.tags = els.tags.value.trim().split(',').map(function (tag) { return tag.trim(); }).filter(Boolean);
    var options = { expand: els.optExpand.checked, hybrid: els.optHybrid.checked, rerank: els.optRerank.checked, compress: els.optCompress.checked };
    var enhancements = Object.keys(options).filter(function (key) { return options[key]; });

    els.meta.hidden = true;
    els.results.innerHTML = '';
    els.empty.hidden = true;
    els.error.hidden = true;
    searching = true;
    els.btnSearch.disabled = true;
    els.btnSearch.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Finding evidence…';
    setSearchStatus('loading', 'Finding evidence', 'Comparing your question with indexed passages.');
    var started = performance.now();

    try {
      var response = await window.RAG.search(query, topK, minScore, Object.keys(filters).length ? filters : undefined, options);
      var elapsed = Math.round(performance.now() - started);
      var results = response.data.results || [];
      els.meta.hidden = false;
      els.meta.textContent = results.length + ' passage' + (results.length === 1 ? '' : 's') + ' found in ' + elapsed + ' ms' + (enhancements.length ? ' · ' + enhancements.join(', ') : '');
      if (!results.length) {
        els.empty.hidden = false;
        setSearchStatus('warn', 'No evidence matched', 'Try simpler wording or loosen expert filters.');
      } else {
        renderResults(results);
        setSearchStatus('ok', 'Evidence ready', results.length + ' supporting passage' + (results.length === 1 ? '' : 's') + ' found.');
      }
    } catch (error) {
      els.error.hidden = false;
      els.error.textContent = 'Search failed: ' + (error.message || 'unknown error');
      setSearchStatus('error', 'Search failed', error.message || 'The retrieval request could not complete.');
    } finally {
      searching = false;
      els.btnSearch.innerHTML = '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Find evidence';
      els.btnSearch.disabled = !searchReady || !els.query.value.trim();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();
    wireSliders();
    var initialQuery = new URLSearchParams(window.location.search).get('query');
    if (initialQuery) els.query.value = initialQuery;
    els.btnSearch.addEventListener('click', executeSearch);
    els.query.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); executeSearch(); }
    });
    els.query.addEventListener('input', function () {
      els.btnSearch.disabled = !searchReady || !els.query.value.trim();
      if (searchReady) setSearchStatus(els.query.value.trim() ? 'ok' : 'loading', els.query.value.trim() ? 'Question ready' : 'Waiting for a question', els.query.value.trim() ? 'Select Find evidence or press Enter.' : 'Ask in plain language; Agent X will return matching passages.');
    });
    els.starters.forEach(function (starter) {
      starter.addEventListener('click', function () {
        els.query.value = starter.getAttribute('data-query');
        els.query.dispatchEvent(new Event('input'));
        els.query.focus();
      });
    });
    checkReadiness();
  });
})();

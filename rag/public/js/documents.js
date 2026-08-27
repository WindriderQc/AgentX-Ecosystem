/**
 * RAG Document Browser — lists, filters, expands, deletes documents.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────

  var els = {};

  function cacheElements() {
    els.docCount    = document.getElementById('doc-count');
    els.chunkCount  = document.getElementById('chunk-count');
    els.sourceFilter = document.getElementById('filter-source');
    els.tagsFilter  = document.getElementById('filter-tags');
    els.btnApply    = document.getElementById('btn-apply');
    els.btnClear    = document.getElementById('btn-clear');
    els.tbody       = document.getElementById('doc-tbody');
    els.emptyState  = document.getElementById('empty-state');
    els.loadingState = document.getElementById('loading-state');
    els.errorState  = document.getElementById('error-state');
    els.table       = document.getElementById('doc-table');
    els.emptyBanner = document.getElementById('empty-index-banner');
    els.emptyDetail = document.getElementById('empty-banner-detail');
    els.status      = document.getElementById('documents-status');
  }

  // ── Empty-index banner (shared pattern; see dashboard.js) ──

  function renderEmptyBanner(statusData) {
    if (!els.emptyBanner) return;
    var docs = Number(statusData && statusData.documentCount);
    if (!isFinite(docs) || docs > 0) {
      els.emptyBanner.hidden = true;
      return;
    }
    els.emptyBanner.hidden = false;
    if (els.emptyDetail) els.emptyDetail.textContent = 'Add one useful source, then ask Agent X to find evidence in it.';
  }

  function checkEmptyIndex() {
    if (!window.RAG || typeof window.RAG.getStatus !== 'function') return;
    window.RAG.getStatus()
      .then(function (resp) { renderEmptyBanner(resp && resp.data); })
      .catch(function () {
        if (els.emptyBanner) els.emptyBanner.hidden = true;
      });
  }

  // ── State ─────────────────────────────────────────────────

  var allDocuments = [];
  var expandedIds = {};

  // ── Helpers ───────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncateId(id, max) {
    max = max || 20;
    if (!id || id.length <= max) return escapeHtml(id);
    return '<span title="' + escapeHtml(id) + '">' +
      escapeHtml(id.substring(0, max)) + '&hellip;</span>';
  }

  function truncateText(text, max) {
    max = max || 200;
    if (!text || text.length <= max) return escapeHtml(text);
    return escapeHtml(text.substring(0, max)) + '&hellip;';
  }

  function setDocumentsStatus(state, title, detail) {
    if (!els.status) return;
    var icons = { ok: 'fa-circle-check', warn: 'fa-circle-info', error: 'fa-circle-exclamation', loading: 'fa-circle-notch fa-spin' };
    els.status.className = 'flow-status is-' + state;
    els.status.innerHTML =
      '<i class="fa-solid ' + icons[state] + '" aria-hidden="true"></i>' +
      '<span><strong>' + escapeHtml(title) + '</strong>' +
      '<span class="flow-status-detail">' + escapeHtml(detail) + '</span></span>';
  }

  // ── Populate source dropdown ──────────────────────────────

  function populateSourceFilter(documents) {
    var sources = {};
    documents.forEach(function (d) {
      if (d.source) sources[d.source] = true;
    });
    var sorted = Object.keys(sources).sort();
    var current = els.sourceFilter.value;

    // Keep "All sources" option
    els.sourceFilter.innerHTML = '<option value="">All sources</option>';
    sorted.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === current) opt.selected = true;
      els.sourceFilter.appendChild(opt);
    });
  }

  // ── Load documents ────────────────────────────────────────

  async function loadDocuments(filters) {
    els.loadingState.hidden = false;
    els.emptyState.hidden = true;
    els.errorState.hidden = true;
    els.table.hidden = true;
    setDocumentsStatus(
      'loading',
      filters && (filters.source || filters.tags) ? 'Filtering corpus' : 'Loading corpus',
      'Reading source metadata and indexed passage counts.'
    );

    try {
      var params = { limit: 200 };
      if (filters && filters.source) params.source = filters.source;
      if (filters && filters.tags) params.tags = filters.tags;

      var resp = await window.RAG.getDocuments(params);
      var data = resp.data;
      allDocuments = data.documents || [];
      expandedIds = {};

      els.loadingState.hidden = true;

      if (allDocuments.length === 0) {
        els.emptyState.hidden = false;
        els.docCount.textContent = '0';
        els.chunkCount.textContent = '0';
        setDocumentsStatus('warn', 'No sources found', filters ? 'Clear the filters or add another source.' : 'Add knowledge to make it searchable.');
        return;
      }

      els.table.hidden = false;
      populateSourceFilter(allDocuments);
      updateCounts(allDocuments);
      renderTable(allDocuments);
      setDocumentsStatus(
        'ok',
        'Sources ready',
        allDocuments.length.toLocaleString() + ' source' + (allDocuments.length === 1 ? '' : 's') + ' visible in this view.'
      );
    } catch (err) {
      els.loadingState.hidden = true;
      els.errorState.hidden = false;
      els.errorState.textContent = 'Failed to load sources: ' + (err.message || 'unknown error');
      setDocumentsStatus('error', 'Could not load sources', err.message || 'Unknown source browser error.');
    }
  }

  function updateCounts(docs) {
    var totalChunks = 0;
    docs.forEach(function (d) { totalChunks += d.chunkCount || 0; });
    els.docCount.textContent = docs.length.toLocaleString();
    els.chunkCount.textContent = totalChunks.toLocaleString();
  }

  // ── Render table ──────────────────────────────────────────

  function renderTable(docs) {
    els.tbody.innerHTML = '';
    docs.forEach(function (doc) {
      var tr = createDocRow(doc);
      els.tbody.appendChild(tr);
    });
  }

  function createDocRow(doc) {
    var tr = document.createElement('tr');
    tr.className = 'doc-row';
    tr.dataset.id = doc.documentId;

    var tagsStr = Array.isArray(doc.tags) ? doc.tags.join(', ') : '';

    tr.innerHTML =
      '<td class="mono"><button type="button" class="source-expand" aria-expanded="false" title="Show indexed passages"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i> ' + truncateId(doc.documentId, 24) + '</button></td>' +
      '<td>' + escapeHtml(doc.source) + '</td>' +
      '<td class="center">' + (doc.chunkCount || 0) + '</td>' +
      '<td>' + escapeHtml(tagsStr) + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-danger btn-sm btn-delete" type="button" title="Delete this source"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Delete</button>' +
      '</td>';

    // Click row to expand (but not on delete button)
    tr.addEventListener('click', function (e) {
      if (e.target.closest('.btn-delete')) return;
      toggleExpand(doc.documentId, tr);
    });

    // Delete handler
    tr.querySelector('.btn-delete').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmDelete(doc.documentId, tr);
    });

    return tr;
  }

  // ── Expand/collapse chunks ────────────────────────────────

  async function toggleExpand(docId, rowEl) {
    // If already expanded, collapse
    if (expandedIds[docId]) {
      var existing = els.tbody.querySelector('.expand-row[data-expand-id="' + docId + '"]');
      if (existing) existing.remove();
      delete expandedIds[docId];
      rowEl.classList.remove('expanded');
      rowEl.querySelector('.source-expand').setAttribute('aria-expanded', 'false');
      return;
    }

    expandedIds[docId] = true;
    rowEl.classList.add('expanded');
    rowEl.querySelector('.source-expand').setAttribute('aria-expanded', 'true');
    setDocumentsStatus('loading', 'Loading chunks', 'Fetching chunk preview rows for ' + docId + '.');

    // Insert loading row
    var loadingTr = document.createElement('tr');
    loadingTr.className = 'expand-row';
    loadingTr.dataset.expandId = docId;
    loadingTr.innerHTML = '<td colspan="5"><div class="expand-content loading">Loading chunks...</div></td>';
    rowEl.after(loadingTr);

    try {
      var resp = await window.RAG.getDocumentChunks(docId);
      var chunks = resp.data.chunks || [];

      var html = '<td colspan="5"><div class="expand-content">';
      if (chunks.length === 0) {
        html += '<div class="chunk-empty">No chunks found.</div>';
      } else {
        chunks.forEach(function (chunk) {
          html += '<div class="chunk-card">' +
            '<div class="chunk-header">' +
              '<span class="chunk-index">#' + chunk.chunkIndex + '</span>' +
            '</div>' +
            '<div class="chunk-text" data-full="' + escapeHtml(chunk.text) + '" data-truncated="true">' +
              truncateText(chunk.text, 200) +
            '</div>' +
          '</div>';
        });
      }
      html += '</div></td>';
      loadingTr.innerHTML = html;
      setDocumentsStatus('ok', 'Chunks loaded', chunks.length + ' chunk' + (chunks.length === 1 ? '' : 's') + ' available for ' + docId + '.');

      // Click to expand chunk text
      loadingTr.querySelectorAll('.chunk-text').forEach(function (el) {
        el.addEventListener('click', function () {
          if (el.dataset.truncated === 'true') {
            el.innerHTML = escapeHtml(el.dataset.full);
            el.dataset.truncated = 'false';
          } else {
            el.innerHTML = truncateText(el.dataset.full, 200);
            el.dataset.truncated = 'true';
          }
        });
      });
    } catch (err) {
      loadingTr.innerHTML = '<td colspan="5"><div class="expand-content error-state">' +
        'Failed to load chunks: ' + escapeHtml(err.message) + '</div></td>';
      setDocumentsStatus('error', 'Chunk load failed', err.message || 'Unknown chunk fetch error.');
    }
  }

  // ── Delete document ───────────────────────────────────────

  async function confirmDelete(docId, rowEl) {
    var ok = confirm('Delete document ' + docId + ' and all its chunks?');
    if (!ok) return;

    try {
      setDocumentsStatus('loading', 'Deleting document', 'Removing document ' + docId + ' and its chunks from the index.');
      await window.RAG.deleteDocument(docId);

      // Remove expand row if present
      var expandRow = els.tbody.querySelector('.expand-row[data-expand-id="' + docId + '"]');
      if (expandRow) expandRow.remove();
      delete expandedIds[docId];

      // Remove doc row
      rowEl.remove();

      // Update local state and counts
      allDocuments = allDocuments.filter(function (d) { return d.documentId !== docId; });
      updateCounts(allDocuments);
      populateSourceFilter(allDocuments);

      if (allDocuments.length === 0) {
        els.table.hidden = true;
        els.emptyState.hidden = false;
        checkEmptyIndex();
      }
      setDocumentsStatus('ok', 'Document deleted', 'Removed ' + docId + ' from the active index.');
    } catch (err) {
      setDocumentsStatus('error', 'Delete failed', err.message || 'Unknown delete error.');
      alert('Delete failed: ' + (err.message || 'unknown error'));
    }
  }

  // ── Filter handlers ───────────────────────────────────────

  function getFilters() {
    var filters = {};
    var source = els.sourceFilter.value;
    var tags = els.tagsFilter.value.trim();
    if (source) filters.source = source;
    if (tags) filters.tags = tags;
    return filters;
  }

  // ── Init ──────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();
    checkEmptyIndex();

    els.btnApply.addEventListener('click', function () {
      loadDocuments(getFilters());
    });

    els.btnClear.addEventListener('click', function () {
      els.sourceFilter.value = '';
      els.tagsFilter.value = '';
      loadDocuments();
    });

    loadDocuments();
  });
})();

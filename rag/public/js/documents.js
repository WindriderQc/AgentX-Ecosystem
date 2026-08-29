/**
 * RAG Document Browser — lists, filters, expands, deletes documents.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  var contextApi = window.RAGDocumentContext;

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
    els.contextNotFound = document.getElementById('context-not-found');
    els.contextNotFoundTitle = document.getElementById('context-not-found-title');
    els.contextNotFoundDetail = document.getElementById('context-not-found-detail');
    els.table       = document.getElementById('doc-table');
    els.emptyBanner = document.getElementById('empty-index-banner');
    els.emptyDetail = document.getElementById('empty-banner-detail');
    els.status      = document.getElementById('documents-status');
    els.deleteDialog = document.getElementById('delete-document-dialog');
    els.deleteForm = document.getElementById('delete-document-form');
    els.deleteDocumentId = document.getElementById('delete-document-id');
    els.deleteSource = document.getElementById('delete-document-source');
    els.deleteExpected = document.getElementById('delete-document-expected');
    els.deleteInput = document.getElementById('delete-document-input');
    els.deleteError = document.getElementById('delete-document-error');
    els.deleteCancel = document.getElementById('delete-document-cancel');
    els.deleteSubmit = document.getElementById('delete-document-submit');
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
  var pageContext = { docId: '', source: '', invalid: false, invalidFields: [] };
  var deleteConfirmationResolve = null;
  var deleteConfirmationOpener = null;

  // ── Helpers ───────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderDocumentId(id, max) {
    max = max || 20;
    var fullId = String(id || '');
    var visibleId = fullId.length <= max
      ? escapeHtml(fullId)
      : escapeHtml(fullId.substring(0, max)) + '&hellip;';
    return '<span aria-hidden="true" title="' + escapeHtml(fullId) + '">' + visibleId + '</span>' +
      '<span class="visually-hidden">' + escapeHtml(fullId) + '</span>';
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

  function hasFilters(filters) {
    return !!(filters && (filters.source || filters.tags));
  }

  function beginLoad(title, detail) {
    els.loadingState.hidden = false;
    els.emptyState.hidden = true;
    els.contextNotFound.hidden = true;
    els.errorState.hidden = true;
    els.table.hidden = true;
    setDocumentsStatus('loading', title, detail);
  }

  function showContextNotFound(title, detail) {
    allDocuments = [];
    expandedIds = {};
    els.loadingState.hidden = true;
    els.emptyState.hidden = true;
    els.errorState.hidden = true;
    els.table.hidden = true;
    els.docCount.textContent = '0';
    els.chunkCount.textContent = '0';
    els.contextNotFoundTitle.textContent = title;
    els.contextNotFoundDetail.textContent = detail;
    els.contextNotFound.hidden = false;
    setDocumentsStatus('warn', title, detail);
    els.contextNotFound.focus();
  }

  function showDeleteReceipt(documentData) {
    var source = documentData.source || 'Unknown provenance';
    pageContext = { docId: '', source: '', invalid: false, invalidFields: [] };
    replaceUrlContext(pageContext);
    els.loadingState.hidden = true;
    els.emptyState.hidden = true;
    els.errorState.hidden = true;
    els.table.hidden = true;
    els.contextNotFoundTitle.textContent = 'Document deleted';
    els.contextNotFoundDetail.textContent = 'Removed document "' + documentData.documentId + '" from source provenance "' + source + '". Other indexed documents may remain.';
    els.contextNotFound.hidden = false;
    els.contextNotFound.focus();
  }

  function ensureSourceOption(source) {
    if (!source) return;
    var exists = Array.prototype.some.call(els.sourceFilter.options, function (option) {
      return option.value === source;
    });
    if (!exists) {
      var option = document.createElement('option');
      option.value = source;
      option.textContent = source;
      els.sourceFilter.appendChild(option);
    }
    els.sourceFilter.value = source;
  }

  function replaceUrlContext(context) {
    if (!contextApi || !window.history || typeof window.history.replaceState !== 'function') return;
    window.history.replaceState(null, '', contextApi.documentsHref(context));
  }

  // ── Populate source dropdown ──────────────────────────────

  function populateSourceFilter(documents, preferredSource) {
    var sources = {};
    documents.forEach(function (d) {
      if (d.source) sources[d.source] = true;
    });
    var sorted = Object.keys(sources).sort();
    var current = preferredSource || els.sourceFilter.value;

    // Keep "All sources" option
    els.sourceFilter.innerHTML = '<option value="">All sources</option>';
    sorted.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === current) opt.selected = true;
      els.sourceFilter.appendChild(opt);
    });
    ensureSourceOption(current);
  }

  // ── Load documents ────────────────────────────────────────

  async function loadDocuments(filters, context) {
    beginLoad(
      hasFilters(filters) ? 'Filtering corpus' : 'Loading corpus',
      'Reading document identifiers, source provenance and indexed passage counts.'
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
        if (context && context.source) {
          showContextNotFound(
            'Source not found',
            'No indexed source exactly matches "' + context.source + '". It may have been renamed or removed.'
          );
          return;
        }
        els.emptyState.hidden = false;
        els.docCount.textContent = '0';
        els.chunkCount.textContent = '0';
        setDocumentsStatus('warn', 'No indexed documents found', hasFilters(filters) ? 'Clear the filters or add another document.' : 'Add knowledge to make it searchable.');
        return;
      }

      els.table.hidden = false;
      populateSourceFilter(allDocuments, filters && filters.source);
      updateCounts(allDocuments);
      renderTable(allDocuments);
      setDocumentsStatus(
        'ok',
        context && context.source ? 'Exact source filter active' : 'Documents ready',
        context && context.source
          ? allDocuments.length.toLocaleString() + ' document' + (allDocuments.length === 1 ? '' : 's') + ' from "' + context.source + '".'
          : allDocuments.length.toLocaleString() + ' indexed document' + (allDocuments.length === 1 ? '' : 's') + ' visible in this view.'
      );
    } catch (err) {
      els.loadingState.hidden = true;
      els.errorState.hidden = false;
      els.errorState.textContent = 'Failed to load indexed documents: ' + (err.message || 'unknown error');
      setDocumentsStatus('error', 'Could not load documents', err.message || 'Unknown document browser error.');
    }
  }

  function normalizeDetailDocument(data) {
    var metadata = data && data.metadata ? data.metadata : {};
    return {
      documentId: data && data.documentId,
      source: data && data.source,
      chunkCount: data && data.chunkCount,
      tags: Array.isArray(metadata.tags) ? metadata.tags : []
    };
  }

  async function loadExactDocument(context) {
    beginLoad('Opening exact source', 'Looking up document ' + context.docId + '.');

    try {
      var response = await window.RAG.getDocument(context.docId);
      var documentData = normalizeDetailDocument(response && response.data);
      if (!contextApi.matches(documentData, context)) {
        showContextNotFound(
          'Source context did not match',
          context.source
            ? 'Document "' + context.docId + '" is not indexed under source "' + context.source + '".'
            : 'Document "' + context.docId + '" is not in the active index.'
        );
        return;
      }

      allDocuments = [documentData];
      expandedIds = {};
      els.loadingState.hidden = true;
      els.table.hidden = false;
      populateSourceFilter(allDocuments, documentData.source);
      updateCounts(allDocuments);
      renderTable(allDocuments);
      setDocumentsStatus(
        'ok',
        'Exact source opened',
        'Document ' + context.docId + ' matched the requested provenance and is ready to inspect.'
      );
      await revealTargetDocument(context.docId);
    } catch (err) {
      if (err && err.status === 404) {
        showContextNotFound(
          'Document not found',
          'Document "' + context.docId + '" is not in the active index. It may have been removed or replaced.'
        );
        return;
      }
      els.loadingState.hidden = true;
      els.errorState.hidden = false;
      els.errorState.textContent = 'Failed to open source: ' + (err.message || 'unknown error');
      setDocumentsStatus('error', 'Could not open source', err.message || 'Unknown document lookup error.');
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
      '<td class="mono"><button type="button" class="source-expand" aria-expanded="false" title="Show indexed passages"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i> ' + renderDocumentId(doc.documentId, 24) + '</button></td>' +
      '<td>' + escapeHtml(doc.source || 'Unknown provenance') + '</td>' +
      '<td class="center">' + (doc.chunkCount || 0) + '</td>' +
      '<td>' + escapeHtml(tagsStr) + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-danger btn-sm btn-delete" type="button" title="Delete this indexed document"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Delete</button>' +
      '</td>';

    // Click row to expand (but not on delete button)
    tr.addEventListener('click', function (e) {
      if (e.target.closest('.btn-delete')) return;
      toggleExpand(doc.documentId, tr);
    });

    // Delete handler
    tr.querySelector('.btn-delete').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmDelete(doc, tr, e.currentTarget);
    });

    return tr;
  }

  function findExpandRow(docId) {
    return Array.prototype.find.call(els.tbody.querySelectorAll('.expand-row'), function (row) {
      return row.dataset.expandId === docId;
    });
  }

  async function revealTargetDocument(docId) {
    var row = Array.prototype.find.call(els.tbody.querySelectorAll('.doc-row'), function (candidate) {
      return candidate.dataset.id === docId;
    });
    if (!row) {
      showContextNotFound('Document not found', 'Document "' + docId + '" is not visible in the active index.');
      return;
    }

    row.classList.add('is-context-target');
    var trigger = row.querySelector('.source-expand');
    if (trigger) {
      trigger.focus({ preventScroll: true });
      trigger.scrollIntoView({ block: 'center' });
    }
    await toggleExpand(docId, row);
  }

  // ── Expand/collapse chunks ────────────────────────────────

  async function toggleExpand(docId, rowEl) {
    // If already expanded, collapse
    if (expandedIds[docId]) {
      var existing = findExpandRow(docId);
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
            '<button type="button" class="chunk-text" data-full="' + escapeHtml(chunk.text) + '" data-truncated="true" aria-expanded="false" title="Show full chunk text">' +
              truncateText(chunk.text, 200) +
            '</button>' +
          '</div>';
        });
      }
      html += '</div></td>';
      loadingTr.innerHTML = html;
      setDocumentsStatus('ok', 'Chunks loaded', chunks.length + ' chunk' + (chunks.length === 1 ? '' : 's') + ' available for ' + docId + '.');

      // Native buttons provide Enter/Space activation for chunk text.
      loadingTr.querySelectorAll('.chunk-text').forEach(function (el) {
        el.addEventListener('click', function () {
          var expand = el.dataset.truncated === 'true';
          if (expand) {
            el.innerHTML = escapeHtml(el.dataset.full);
            el.dataset.truncated = 'false';
          } else {
            el.innerHTML = truncateText(el.dataset.full, 200);
            el.dataset.truncated = 'true';
          }
          el.setAttribute('aria-expanded', expand ? 'true' : 'false');
          el.title = expand ? 'Collapse chunk text' : 'Show full chunk text';
        });
      });
    } catch (err) {
      loadingTr.innerHTML = '<td colspan="5"><div class="expand-content error-state">' +
        'Failed to load chunks: ' + escapeHtml(err.message) + '</div></td>';
      setDocumentsStatus('error', 'Chunk load failed', err.message || 'Unknown chunk fetch error.');
    }
  }

  // ── Delete document ───────────────────────────────────────

  function deleteConfirmationPhrase(documentId) {
    return 'DELETE ' + documentId;
  }

  function finishDeleteConfirmation(confirmed) {
    var resolve = deleteConfirmationResolve;
    var opener = deleteConfirmationOpener;
    deleteConfirmationResolve = null;
    deleteConfirmationOpener = null;
    if (els.deleteDialog && els.deleteDialog.open) els.deleteDialog.close();
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    if (resolve) resolve(confirmed);
  }

  function requestDeleteConfirmation(documentData, opener) {
    var expected = deleteConfirmationPhrase(documentData.documentId);
    if (!els.deleteDialog || typeof els.deleteDialog.showModal !== 'function') {
      return Promise.resolve(window.prompt(
        'Delete document ' + documentData.documentId + ' from source provenance ' + (documentData.source || 'Unknown provenance') + ' and all indexed passages?\n\nType ' + expected + ' exactly to confirm.'
      ) === expected);
    }

    if (deleteConfirmationResolve) finishDeleteConfirmation(false);
    deleteConfirmationOpener = opener;
    els.deleteDocumentId.textContent = documentData.documentId;
    els.deleteSource.textContent = documentData.source || 'Unknown provenance';
    els.deleteExpected.textContent = expected;
    els.deleteInput.value = '';
    els.deleteInput.setAttribute('aria-invalid', 'false');
    els.deleteError.textContent = '';
    els.deleteSubmit.disabled = true;
    els.deleteDialog.showModal();
    window.setTimeout(function () { els.deleteInput.focus(); }, 0);

    return new Promise(function (resolve) {
      deleteConfirmationResolve = resolve;
    });
  }

  function showDeleteFailure(error, opener) {
    var reason = error && error.message ? error.message : 'Unknown delete error.';
    if (error && error.detail) reason += ' — ' + error.detail;
    var recovery = 'Delete failed: ' + reason + ' The document remains indexed; use Delete to try again.';
    els.errorState.textContent = recovery;
    els.errorState.hidden = false;
    setDocumentsStatus('error', 'Delete failed', reason + ' The document remains indexed; use Delete to try again.');
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }

  async function confirmDelete(documentData, rowEl, opener) {
    var docId = documentData.documentId;
    var confirmation = deleteConfirmationPhrase(docId);
    var ok = await requestDeleteConfirmation(documentData, opener);
    if (!ok) return;

    try {
      els.errorState.hidden = true;
      els.errorState.textContent = '';
      setDocumentsStatus('loading', 'Deleting document', 'Removing document ' + docId + ' and its chunks from the index.');
      await window.RAG.deleteDocument(docId, confirmation);

      // Remove expand row if present
      var expandRow = findExpandRow(docId);
      if (expandRow) expandRow.remove();
      delete expandedIds[docId];

      // Remove doc row
      rowEl.remove();

      // Update local state and counts
      allDocuments = allDocuments.filter(function (d) { return d.documentId !== docId; });
      updateCounts(allDocuments);
      populateSourceFilter(allDocuments);

      if (pageContext.docId === docId) {
        showDeleteReceipt(documentData);
        checkEmptyIndex();
      } else if (allDocuments.length === 0) {
        els.table.hidden = true;
        els.emptyState.hidden = false;
        checkEmptyIndex();
      }
      setDocumentsStatus('ok', 'Document deleted', 'Removed ' + docId + ' from the active index.');
    } catch (err) {
      showDeleteFailure(err, opener);
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

    els.deleteInput.addEventListener('input', function () {
      var matches = els.deleteInput.value === els.deleteExpected.textContent;
      els.deleteSubmit.disabled = !matches;
      els.deleteInput.setAttribute('aria-invalid', els.deleteInput.value && !matches ? 'true' : 'false');
      els.deleteError.textContent = els.deleteInput.value && !matches ? 'Confirmation does not match.' : '';
    });

    els.deleteForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (els.deleteInput.value !== els.deleteExpected.textContent) {
        els.deleteInput.setAttribute('aria-invalid', 'true');
        els.deleteError.textContent = 'Type the full confirmation phrase exactly.';
        els.deleteInput.focus();
        return;
      }
      finishDeleteConfirmation(true);
    });

    els.deleteCancel.addEventListener('click', function () {
      finishDeleteConfirmation(false);
    });

    els.deleteDialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      finishDeleteConfirmation(false);
    });

    els.btnApply.addEventListener('click', function () {
      var filters = getFilters();
      pageContext = { docId: '', source: filters.source || '', invalid: false, invalidFields: [] };
      replaceUrlContext(pageContext);
      loadDocuments(filters, pageContext.source ? pageContext : null);
    });

    els.btnClear.addEventListener('click', function () {
      els.sourceFilter.value = '';
      els.tagsFilter.value = '';
      pageContext = { docId: '', source: '', invalid: false, invalidFields: [] };
      replaceUrlContext(pageContext);
      loadDocuments();
    });

    if (!contextApi) {
      showContextNotFound('Source link unavailable', 'The document context helper did not load. Browse all sources or reload the page.');
      return;
    }

    pageContext = contextApi.parse(window.location.search);
    if (pageContext.invalid) {
      showContextNotFound(
        'Source link is invalid',
        'The ' + pageContext.invalidFields.join(' and ') + ' value is empty, contains control characters, or exceeds ' + contextApi.MAX_CONTEXT_VALUE_LENGTH + ' characters.'
      );
    } else if (pageContext.docId) {
      loadExactDocument(pageContext);
    } else if (pageContext.source) {
      ensureSourceOption(pageContext.source);
      loadDocuments({ source: pageContext.source }, pageContext);
    } else {
      loadDocuments();
    }
  });
})();

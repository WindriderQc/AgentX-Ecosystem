/**
 * RAG Upload Page — paste text or upload file for ingestion.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  var documentContext = window.RAGDocumentContext;
  var HISTORY_KEY = 'rag-ingest-history';
  var HISTORY_MAX = 20;
  var MAX_TEXT_LENGTH = 2_000_000;
  var FILE_WARN_SIZE = 5 * 1024 * 1024;   // 5MB
  var FILE_MAX_SIZE = 50 * 1024 * 1024;    // 50MB
  var ALLOWED_EXTS = ['.txt', '.md', '.json', '.csv'];

  // State
  var fileText = null;
  var activeTab = 'paste';
  var isIngesting = false;

  // ── DOM refs ───────────────────────────────────────────

  var tabBtns = document.querySelectorAll('.tab-btn');
  var tabPaste = document.getElementById('tab-paste');
  var tabFile = document.getElementById('tab-file');
  var pasteArea = document.getElementById('paste-text');
  var charCount = document.getElementById('char-count');
  var dropZone = document.getElementById('drop-zone');
  var fileInput = document.getElementById('file-input');
  var fileInfo = document.getElementById('file-info');
  var fileName = document.getElementById('file-name');
  var fileSize = document.getElementById('file-size');
  var fileWarning = document.getElementById('file-warning');
  var metaSource = document.getElementById('meta-source');
  var metaTags = document.getElementById('meta-tags');
  var metaDocId = document.getElementById('meta-docid');
  var chunkSizeEl = document.getElementById('chunk-size');
  var chunkOverlapEl = document.getElementById('chunk-overlap');
  var btnIngest = document.getElementById('btn-ingest');
  var spinner = document.getElementById('spinner');
  var resultArea = document.getElementById('result-area');
  var ingestStatus = document.getElementById('ingest-status');
  var historyTbody = document.getElementById('history-tbody');
  var historyEmpty = document.getElementById('history-empty');
  var btnClearHistory = document.getElementById('btn-clear-history');

  // ── Tab switching ──────────────────────────────────────

  function setIngestStatus(state, title, detail) {
    if (!ingestStatus) return;
    var icons = { ok: 'fa-circle-check', warn: 'fa-circle-info', error: 'fa-circle-exclamation', loading: 'fa-circle-notch fa-spin' };
    ingestStatus.className = 'flow-status is-' + state;
    ingestStatus.innerHTML =
      '<i class="fa-solid ' + icons[state] + '" aria-hidden="true"></i>' +
      '<span><strong>' + escHtml(title) + '</strong>' +
      '<span class="flow-status-detail">' + escHtml(detail) + '</span></span>';
  }

  function hasDocumentText() {
    var text = activeTab === 'paste' ? pasteArea.value : fileText;
    return !!(text && text.trim()) && text.length <= MAX_TEXT_LENGTH;
  }

  function updateIngestAvailability() {
    btnIngest.disabled = isIngesting || !hasDocumentText();
  }

  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeTab = btn.getAttribute('data-tab');
      tabBtns.forEach(function (b) {
        var selected = b === btn;
        b.classList.toggle('active', selected);
        b.setAttribute('aria-selected', selected ? 'true' : 'false');
        b.setAttribute('tabindex', selected ? '0' : '-1');
      });
      btn.classList.add('active');
      tabPaste.hidden = activeTab !== 'paste';
      tabFile.hidden = activeTab !== 'file';
      updateIngestAvailability();
      setIngestStatus(
        hasDocumentText() ? 'ok' : 'loading',
        hasDocumentText() ? 'Source ready' : (activeTab === 'paste' ? 'Waiting for pasted text' : 'Waiting for a file'),
        activeTab === 'paste'
          ? 'Paste a document, then add it to Agent X.'
          : 'Choose a supported text file; it is read locally before indexing.'
      );
    });
    btn.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      var buttons = Array.prototype.slice.call(tabBtns);
      var direction = event.key === 'ArrowRight' ? 1 : -1;
      var next = buttons[(buttons.indexOf(btn) + direction + buttons.length) % buttons.length];
      next.click();
      next.focus();
    });
  });

  // ── Character count ────────────────────────────────────

  pasteArea.addEventListener('input', function () {
    charCount.textContent = pasteArea.value.length;
    updateIngestAvailability();
    var textTooLong = pasteArea.value.length > MAX_TEXT_LENGTH;
    setIngestStatus(
      textTooLong ? 'error' : (pasteArea.value.trim() ? 'ok' : 'loading'),
      textTooLong ? 'Document text is too long' : (pasteArea.value.trim() ? 'Document text ready' : 'Waiting for pasted text'),
      textTooLong
        ? 'Document text must be ' + MAX_TEXT_LENGTH.toLocaleString() + ' characters or fewer.'
        : (pasteArea.value.trim()
          ? pasteArea.value.length.toLocaleString() + ' characters ready to add.'
          : 'Paste a document to continue.')
    );
  });

  // ── File handling ──────────────────────────────────────

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getExtension(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
  }

  function handleFile(file) {
    fileWarning.hidden = true;
    fileWarning.textContent = '';

    if (file.size > FILE_MAX_SIZE) {
      fileWarning.textContent = 'File too large (max 50 MB). Please choose a smaller file.';
      fileWarning.hidden = false;
      fileText = null;
      fileInfo.hidden = true;
      updateIngestAvailability();
      setIngestStatus('error', 'File rejected', 'The selected file is larger than the 50 MB browser upload limit.');
      return;
    }

    var ext = getExtension(file.name);
    var warnings = [];
    if (ALLOWED_EXTS.indexOf(ext) === -1) {
      warnings.push('Unsupported file type \u2014 text extraction may not work correctly');
    }
    if (file.size > FILE_WARN_SIZE) {
      warnings.push('Large file \u2014 ingestion may take a while');
    }
    if (warnings.length) {
      fileWarning.textContent = warnings.join('. ');
      fileWarning.hidden = false;
    }

    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileInfo.hidden = false;
    if (!metaSource.value.trim()) metaSource.value = file.name;

    var reader = new FileReader();
    setIngestStatus('loading', 'Reading file', file.name + ' is being read locally before ingestion.');
    reader.onload = function (e) {
      var loadedText = typeof e.target.result === 'string' ? e.target.result : '';
      if (loadedText.length > MAX_TEXT_LENGTH) {
        fileWarning.textContent = 'File text is too long (max ' + MAX_TEXT_LENGTH.toLocaleString() + ' characters). Please choose a smaller file.';
        fileWarning.hidden = false;
        fileText = null;
        updateIngestAvailability();
        setIngestStatus('error', 'File text is too long', 'Choose a file with ' + MAX_TEXT_LENGTH.toLocaleString() + ' characters or fewer.');
        return;
      }
      fileText = loadedText;
      updateIngestAvailability();
      setIngestStatus(
        'ok',
        'File ready',
        file.name + ' is loaded and ready to add.'
      );
    };
    reader.onerror = function () {
      fileWarning.textContent = 'Failed to read file.';
      fileWarning.hidden = false;
      fileText = null;
      updateIngestAvailability();
      setIngestStatus('error', 'File read failed', 'Choose another file or paste the document text instead.');
    };
    reader.readAsText(file);
  }

  dropZone.addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  });

  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // ── Ingest ─────────────────────────────────────────────

  async function handleIngest() {
    // Gather text
    var text = activeTab === 'paste' ? pasteArea.value : fileText;
    if (!text || text.trim().length === 0) {
      setIngestStatus('warn', 'Nothing to ingest', 'Paste text or upload a file before starting ingestion.');
      showResult(false, 'No text to ingest. Paste text or upload a file first.');
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      var maxTextMessage = 'Document text must be ' + MAX_TEXT_LENGTH.toLocaleString() + ' characters or fewer.';
      setIngestStatus('error', 'Document text is too long', maxTextMessage);
      showResult(false, maxTextMessage);
      return;
    }

    setIngestStatus('loading', 'Validating ingest request', 'Checking metadata, chunk size, and chunk overlap before sending to RAG.');

    // Gather metadata
    var source = metaSource.value.trim() || undefined;
    var tagsRaw = metaTags.value.trim();
    var tags = tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : undefined;
    var documentId = metaDocId.value.trim() || undefined;
    var chunkSize = Number(chunkSizeEl.value);
    var chunkOverlap = Number(chunkOverlapEl.value);

    // Validate chunk params
    if (!Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 5000) {
      setIngestStatus('error', 'Chunk size invalid', 'Chunk size must be between 100 and 5000.');
      showResult(false, 'Chunk size must be between 100 and 5000.');
      return;
    }
    if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > 500) {
      setIngestStatus('error', 'Chunk overlap invalid', 'Chunk overlap must be between 0 and 500.');
      showResult(false, 'Chunk overlap must be between 0 and 500.');
      return;
    }
    if (chunkOverlap > Math.floor(chunkSize / 2)) {
      var overlapMessage = 'Chunk overlap must not exceed half the chunk size (' + Math.floor(chunkSize / 2) + ').';
      setIngestStatus('error', 'Chunk overlap invalid', overlapMessage);
      showResult(false, overlapMessage);
      return;
    }

    // Show spinner, disable button
    isIngesting = true;
    updateIngestAvailability();
    spinner.hidden = false;
    resultArea.hidden = true;
    setIngestStatus('loading', 'Adding knowledge', 'Agent X is preparing passages and making them searchable.');

    try {
      var params = { text: text };
      if (source) params.source = source;
      if (tags) params.tags = tags;
      if (documentId) params.documentId = documentId;
      params.chunkSize = chunkSize;
      params.chunkOverlap = chunkOverlap;

      var res = await RAG.ingestDocument(params);
      var d = res.data;
      var alreadyIndexed = d.unchanged === true;
      setIngestStatus('ok', alreadyIndexed ? 'Already indexed' : 'Knowledge added', alreadyIndexed
        ? 'This exact source and content was already searchable, so no duplicate was added.'
        : 'Your source is searchable in ' + d.chunkCount + ' passage' + (d.chunkCount === 1 ? '' : 's') + '.');
      showResult(true, null, d, source || 'api');
      addToHistory({
        timestamp: new Date().toISOString(),
        source: source || 'api',
        documentId: d.documentId,
        chunkCount: d.chunkCount,
        status: alreadyIndexed ? 'unchanged' : (d.status || 'ingested')
      });
    } catch (err) {
      var detail = err.detail ? ' \u2014 ' + err.detail : '';
      setIngestStatus('error', 'Ingestion failed', (err.message || 'Ingestion failed') + detail);
      showResult(false, (err.message || 'Ingestion failed') + detail);
      addToHistory({
        timestamp: new Date().toISOString(),
        source: source || 'api',
        documentId: documentId || '--',
        chunkCount: 0,
        status: 'failed'
      });
    } finally {
      isIngesting = false;
      updateIngestAvailability();
      spinner.hidden = true;
    }
  }

  btnIngest.addEventListener('click', handleIngest);

  // ── Result display ─────────────────────────────────────

  function showResult(success, message, data, source) {
    resultArea.hidden = false;
    if (success && data) {
      var alreadyIndexed = data.unchanged === true;
      var sourceHref = documentContext
        ? documentContext.documentsHref({ docId: data.documentId, source: source })
        : '/documents';
      resultArea.className = 'result-success';
      resultArea.innerHTML =
        '<div class="result-callout"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span><strong>' + (alreadyIndexed ? 'Already indexed' : 'Knowledge added') + '</strong>' +
        '<small><span class="mono">' + escHtml(data.documentId) + '</span> · ' + data.chunkCount + ' searchable passage' + (data.chunkCount === 1 ? '' : 's') + '</small></span></div>' +
        '<div class="result-actions"><a class="btn btn-primary" href="/search">Ask about it</a>' +
        '<a class="btn btn-secondary" href="' + escHtml(sourceHref) + '">View source</a></div>';
    } else {
      resultArea.className = 'result-error';
      resultArea.innerHTML = '<strong>Ingestion failed</strong><br>' + escHtml(message);
    }
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── History (localStorage) ─────────────────────────────

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(arr) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
  }

  function addToHistory(entry) {
    var history = getHistory();
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
    saveHistory(history);
    renderHistory();
  }

  function renderHistory() {
    var history = getHistory();
    if (history.length === 0) {
      historyTbody.innerHTML = '';
      historyEmpty.hidden = false;
      document.getElementById('history-table').hidden = true;
      return;
    }
    historyEmpty.hidden = true;
    document.getElementById('history-table').hidden = false;
    historyTbody.innerHTML = history.map(function (h) {
      var ts = h.timestamp ? new Date(h.timestamp).toLocaleString() : '--';
      var statusClass = h.status === 'failed' ? 'status-error' : 'status-ok';
      return '<tr>' +
        '<td>' + escHtml(ts) + '</td>' +
        '<td>' + escHtml(h.source) + '</td>' +
        '<td class="mono">' + escHtml(h.documentId) + '</td>' +
        '<td class="center">' + (h.chunkCount || 0) + '</td>' +
        '<td class="' + statusClass + '">' + escHtml(h.status) + '</td>' +
        '</tr>';
    }).join('');
  }

  btnClearHistory.addEventListener('click', function () {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  });

  // ── Init ───────────────────────────────────────────────

  updateIngestAvailability();
  renderHistory();
})();

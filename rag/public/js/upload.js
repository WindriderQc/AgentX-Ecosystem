/**
 * RAG Upload Page — paste text or upload file for ingestion.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  var HISTORY_KEY = 'rag-ingest-history';
  var HISTORY_MAX = 20;
  var FILE_WARN_SIZE = 5 * 1024 * 1024;   // 5MB
  var FILE_MAX_SIZE = 50 * 1024 * 1024;    // 50MB
  var ALLOWED_EXTS = ['.txt', '.md', '.json', '.csv'];

  // State
  var fileText = null;
  var activeTab = 'paste';

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
  var advToggle = document.getElementById('advanced-toggle');
  var advBody = document.getElementById('advanced-body');
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
    ingestStatus.className = 'flow-status is-' + state;
    ingestStatus.innerHTML =
      '<strong>' + escHtml(title) + '</strong>' +
      '<span class="flow-status-detail">' + escHtml(detail) + '</span>';
  }

  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeTab = btn.getAttribute('data-tab');
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      tabPaste.style.display = activeTab === 'paste' ? '' : 'none';
      tabFile.style.display = activeTab === 'file' ? '' : 'none';
      setIngestStatus(
        'loading',
        activeTab === 'paste' ? 'Waiting for pasted text' : 'Waiting for file',
        activeTab === 'paste'
          ? 'Paste a document, set source/tags if needed, then ingest.'
          : 'Choose a text-like file; RAG will read it in the browser before indexing.'
      );
    });
  });

  // ── Character count ────────────────────────────────────

  pasteArea.addEventListener('input', function () {
    charCount.textContent = pasteArea.value.length;
    setIngestStatus(
      pasteArea.value.trim() ? 'ok' : 'loading',
      pasteArea.value.trim() ? 'Document text ready' : 'Waiting for pasted text',
      pasteArea.value.trim()
        ? pasteArea.value.length.toLocaleString() + ' characters ready for chunking and embedding.'
        : 'Paste a document, set source/tags if needed, then ingest.'
    );
  });

  // ── Collapsible advanced ───────────────────────────────

  advToggle.addEventListener('click', function () {
    var open = advBody.style.display !== 'none';
    advBody.style.display = open ? 'none' : '';
    advToggle.classList.toggle('open', !open);
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
    fileWarning.style.display = 'none';
    fileWarning.textContent = '';

    if (file.size > FILE_MAX_SIZE) {
      fileWarning.textContent = 'File too large (max 50 MB). Please choose a smaller file.';
      fileWarning.style.display = '';
      fileText = null;
      fileInfo.style.display = 'none';
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
      fileWarning.style.display = '';
    }

    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileInfo.style.display = '';

    var reader = new FileReader();
    setIngestStatus('loading', 'Reading file', file.name + ' is being read locally before ingestion.');
    reader.onload = function (e) {
      fileText = e.target.result;
      setIngestStatus(
        'ok',
        'File ready',
        file.name + ' is loaded; ingestion will chunk, embed, and index it.'
      );
    };
    reader.onerror = function () {
      fileWarning.textContent = 'Failed to read file.';
      fileWarning.style.display = '';
      fileText = null;
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

    setIngestStatus('loading', 'Validating ingest request', 'Checking metadata, chunk size, and chunk overlap before sending to RAG.');

    // Gather metadata
    var source = metaSource.value.trim() || undefined;
    var tagsRaw = metaTags.value.trim();
    var tags = tagsRaw ? tagsRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : undefined;
    var documentId = metaDocId.value.trim() || undefined;
    var chunkSize = parseInt(chunkSizeEl.value, 10);
    var chunkOverlap = parseInt(chunkOverlapEl.value, 10);

    // Validate chunk params
    if (isNaN(chunkSize) || chunkSize < 100 || chunkSize > 5000) {
      setIngestStatus('error', 'Chunk size invalid', 'Chunk size must be between 100 and 5000.');
      showResult(false, 'Chunk size must be between 100 and 5000.');
      return;
    }
    if (isNaN(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > 500) {
      setIngestStatus('error', 'Chunk overlap invalid', 'Chunk overlap must be between 0 and 500.');
      showResult(false, 'Chunk overlap must be between 0 and 500.');
      return;
    }

    // Show spinner, disable button
    btnIngest.disabled = true;
    spinner.style.display = '';
    resultArea.style.display = 'none';
    setIngestStatus('loading', 'Embedding and indexing', 'RAG is chunking the document, generating embeddings, and writing vectors.');

    try {
      var params = { text: text };
      if (source) params.source = source;
      if (tags) params.tags = tags;
      if (documentId) params.documentId = documentId;
      params.chunkSize = chunkSize;
      params.chunkOverlap = chunkOverlap;

      var res = await RAG.ingestDocument(params);
      var d = res.data;
      setIngestStatus(
        'ok',
        'Document indexed',
        'Document ' + d.documentId + ' produced ' + d.chunkCount + ' chunk' + (d.chunkCount === 1 ? '' : 's') + '.'
      );
      showResult(true, null, d);
      addToHistory({
        timestamp: new Date().toISOString(),
        source: source || 'api',
        documentId: d.documentId,
        chunkCount: d.chunkCount,
        status: d.status || 'ingested'
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
      btnIngest.disabled = false;
      spinner.style.display = 'none';
    }
  }

  btnIngest.addEventListener('click', handleIngest);

  // ── Result display ─────────────────────────────────────

  function showResult(success, message, data) {
    resultArea.style.display = '';
    if (success && data) {
      resultArea.className = 'result-success';
      resultArea.innerHTML =
        '<strong>Ingestion successful</strong><br>' +
        'Document ID: <span class="mono">' + escHtml(data.documentId) + '</span><br>' +
        'Chunks created: <strong>' + data.chunkCount + '</strong><br>' +
        'Status: ' + escHtml(data.status || 'ingested');
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
      historyEmpty.style.display = '';
      return;
    }
    historyEmpty.style.display = 'none';
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

  renderHistory();
})();

/**
 * Database Browser — Frontend
 *
 * Browse and query MongoDB collections across the AgentX ecosystem.
 * Communicates through the core proxy at /api/data/databases.
 */
const DatabaseBrowser = (() => {
  // ─── Owner mapping ──────────────────────────────────────
  const OWNERS = {
    benchmarkbatches: 'benchmark', benchmarkresults: 'benchmark',
    benchmarkprompts: 'benchmark', judgegroundtruths: 'benchmark',
    ragmanifests: 'rag', embeddingcachestats: 'rag',
    nas_files: 'data', nas_scans: 'data', nas_directories: 'data',
    nas_pending_deletions: 'data', network_devices: 'data',
    appevents: 'data', livedataconfigs: 'data', isses: 'data',
    quakes: 'data', pressures: 'data', weatherLocations: 'data',
    integration_events: 'data'
  };
  const OWNER_COLORS = {
    core: '#7cf0ff', benchmark: '#a78bfa', rag: '#22c55e', data: '#f59e0b'
  };

  // ─── State ──────────────────────────────────────────────
  const state = {
    collections: [],
    selected: null,
    docs: [],
    total: 0,
    skip: 0,
    limit: 20,
    filter: '{}',
    sort: 'desc',
    modalDoc: null
  };

  // ─── Helpers ────────────────────────────────────────────

  function getOwner(name) {
    return OWNERS[name] || 'core';
  }

  function ownerBadgeHTML(name) {
    const owner = getOwner(name);
    const color = OWNER_COLORS[owner];
    return `<span class="db-badge db-badge-owner" style="background:${color}22;color:${color};border:1px solid ${color}44">${owner}</span>`;
  }

  const formatBytes = (b) => window.AgentXUtils.formatBytes(b);

  function formatNumber(n) {
    if (n == null) return '-';
    return n.toLocaleString();
  }

  const fetchJSON = DataCommons.apiFetch;

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── JSON Syntax Highlighting ───────────────────────────

  function syntaxHighlight(obj) {
    const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    const json = escapeHTML(raw);
    return json.replace(
      /(&quot;(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\&]|&amp;|&lt;|&gt;|&#39;)*&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'db-json-number';
        if (/^&quot;/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'db-json-key';
            const key = match.slice(0, -1);
            return `<span class="${cls}">${key}</span>:`;
          } else {
            cls = 'db-json-string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'db-json-boolean';
        } else if (/null/.test(match)) {
          cls = 'db-json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  // ─── Load Collections ───────────────────────────────────

  async function loadCollections() {
    const listEl = document.getElementById('db-collection-list');
    listEl.innerHTML = '<div class="db-loading"><i class="fas fa-spinner"></i> Loading...</div>';

    try {
      const resp = await fetchJSON('/api/data/databases/collections');
      const data = resp.data || {};
      state.collections = (data.collections || []).sort((a, b) => a.name.localeCompare(b.name));

      // Update stat cards
      const totalDocs = state.collections.reduce((s, c) => s + (c.count || 0), 0);
      const totalSize = state.collections.reduce((s, c) => s + (c.size || c.storageSize || 0), 0);
      document.getElementById('db-stat-collections').textContent = formatNumber(state.collections.length);
      document.getElementById('db-stat-documents').textContent = formatNumber(totalDocs);
      document.getElementById('db-stat-size').textContent = formatBytes(totalSize);

      renderCollectionList();
    } catch (err) {
      listEl.innerHTML = `<div class="db-loading" style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> ${escapeHTML(err.message)}</div>`;
      if (typeof Toast !== 'undefined') Toast.error('Failed to load collections: ' + err.message);
    }
  }

  function renderCollectionList(filter) {
    const listEl = document.getElementById('db-collection-list');
    const search = (filter || '').toLowerCase().trim();
    const filtered = search
      ? state.collections.filter(c => c.name.toLowerCase().includes(search))
      : state.collections;

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="db-loading" style="padding:20px;"><span>No collections found</span></div>';
      return;
    }

    listEl.innerHTML = filtered.map(c => {
      const isSelected = state.selected && state.selected.name === c.name;
      return `
        <div class="db-coll-card ${isSelected ? 'selected' : ''}" data-collection="${escapeHTML(c.name)}">
          <div class="db-coll-top">
            <span class="db-coll-name" title="${escapeHTML(c.name)}">${escapeHTML(c.name)}</span>
            <div class="db-coll-badges">
              <span class="db-badge db-badge-count">${formatNumber(c.count)}</span>
            </div>
          </div>
          <div class="db-coll-badges">
            ${ownerBadgeHTML(c.name)}
            <span class="db-badge db-badge-size">${formatBytes(c.size || c.storageSize || 0)}</span>
          </div>
        </div>`;
    }).join('');
  }

  // ─── Select Collection ──────────────────────────────────

  async function selectCollection(name) {
    const coll = state.collections.find(c => c.name === name);
    if (!coll) return;

    state.selected = coll;
    state.skip = 0;
    state.filter = '{}';
    state.sort = 'desc';
    state.limit = 20;

    // Update sidebar selection
    renderCollectionList(document.getElementById('db-search').value);

    // Show detail panel
    document.getElementById('db-detail-empty').style.display = 'none';
    document.getElementById('db-detail-content').style.display = 'block';

    // Update header
    document.getElementById('db-detail-name').textContent = coll.name;
    const ownerEl = document.getElementById('db-detail-owner');
    const owner = getOwner(coll.name);
    ownerEl.textContent = owner;
    ownerEl.style.background = OWNER_COLORS[owner] + '22';
    ownerEl.style.color = OWNER_COLORS[owner];
    ownerEl.style.border = `1px solid ${OWNER_COLORS[owner]}44`;

    // Reset query inputs
    document.getElementById('db-filter').value = '{}';
    document.getElementById('db-filter').classList.remove('error');
    document.getElementById('db-skip').value = '0';
    document.getElementById('db-limit').value = '20';
    document.getElementById('db-sort').value = 'desc';

    // Load stats
    try {
      const stats = (await fetchJSON(`/api/data/databases/collections/${encodeURIComponent(name)}/stats`)).data;
      const meta = document.getElementById('db-detail-meta');
      meta.innerHTML = `
        <span><i class="fas fa-file-alt"></i> ${formatNumber(stats.count)} docs</span>
        <span><i class="fas fa-database"></i> ${formatBytes(stats.size)}</span>
        <span><i class="fas fa-hdd"></i> ${formatBytes(stats.storageSize)} storage</span>
        ${stats.avgObjSize ? `<span><i class="fas fa-ruler"></i> ${formatBytes(stats.avgObjSize)} avg</span>` : ''}
        ${stats.indexes ? `<span><i class="fas fa-list-ol"></i> ${stats.indexes} indexes</span>` : ''}
      `;
    } catch (_) {
      document.getElementById('db-detail-meta').innerHTML = `
        <span><i class="fas fa-file-alt"></i> ${formatNumber(coll.count)} docs</span>
        <span><i class="fas fa-database"></i> ${formatBytes(coll.size || coll.storageSize || 0)}</span>
      `;
    }

    // Fetch documents
    await queryDocs();
  }

  // ─── Query Documents ────────────────────────────────────

  async function queryDocs() {
    if (!state.selected) return;

    const filterInput = document.getElementById('db-filter');
    const filterVal = filterInput.value.trim() || '{}';
    const skipVal = parseInt(document.getElementById('db-skip').value) || 0;
    const limitVal = parseInt(document.getElementById('db-limit').value) || 20;
    const sortVal = document.getElementById('db-sort').value.trim() || 'desc';

    // Validate JSON filter
    try {
      JSON.parse(filterVal);
      filterInput.classList.remove('error');
    } catch (e) {
      filterInput.classList.add('error');
      if (typeof Toast !== 'undefined') Toast.error('Invalid JSON filter: ' + e.message);
      return;
    }

    state.filter = filterVal;
    state.skip = skipVal;
    state.limit = limitVal;
    state.sort = sortVal;

    const docList = document.getElementById('db-doc-list');
    docList.innerHTML = '<div class="db-loading"><i class="fas fa-spinner"></i> Fetching documents...</div>';
    document.getElementById('db-results-info').style.display = 'none';

    const fetchBtn = document.getElementById('db-fetch-btn');
    fetchBtn.disabled = true;

    try {
      const params = new URLSearchParams({
        q: state.filter,
        page: Math.floor(state.skip / state.limit) + 1,
        limit: state.limit,
        sort: state.sort
      });
      const url = `/api/data/databases/collections/${encodeURIComponent(state.selected.name)}?${params}`;
      const resp = await fetchJSON(url);

      const docs = resp.data;
      state.docs = Array.isArray(docs) ? docs : (docs.documents || []);
      state.total = (resp.pagination && resp.pagination.total != null) ? resp.pagination.total : (docs.total || 0);

      renderDocuments();
      renderPagination();
    } catch (err) {
      docList.innerHTML = `<div class="db-loading" style="color:var(--danger)"><i class="fas fa-exclamation-triangle"></i> ${escapeHTML(err.message)}</div>`;
      if (typeof Toast !== 'undefined') Toast.error('Query failed: ' + err.message);
    } finally {
      fetchBtn.disabled = false;
    }
  }

  // ─── Render Documents ───────────────────────────────────

  function renderDocuments() {
    const docList = document.getElementById('db-doc-list');

    if (state.docs.length === 0) {
      docList.innerHTML = '<div class="db-loading"><i class="fas fa-inbox"></i> No documents found</div>';
      return;
    }

    docList.innerHTML = state.docs.map((doc, i) => {
      const docId = doc._id || `doc-${i}`;
      const isOpen = i < 3; // First 3 expanded
      return `
        <div class="db-doc-card">
          <div class="db-doc-header" data-doc-toggle="${i}">
            <div class="db-doc-header-left">
              <i class="fas fa-chevron-right db-doc-chevron ${isOpen ? 'open' : ''}" id="db-chevron-${i}"></i>
              <span class="db-doc-id" title="${escapeHTML(String(docId))}">${escapeHTML(String(docId))}</span>
            </div>
            <div class="db-doc-actions">
              <button class="db-doc-action-btn" data-action="view" data-doc-index="${i}" title="View full document">
                <i class="fas fa-expand"></i>
              </button>
              <button class="db-doc-action-btn" data-action="copy" data-doc-index="${i}" title="Copy JSON">
                <i class="fas fa-copy"></i>
              </button>
            </div>
          </div>
          <div class="db-doc-body ${isOpen ? 'open' : ''}" id="db-doc-body-${i}">
            <div class="db-json-container">${syntaxHighlight(doc)}</div>
          </div>
        </div>`;
    }).join('');
  }

  function toggleDoc(index) {
    const body = document.getElementById(`db-doc-body-${index}`);
    const chevron = document.getElementById(`db-chevron-${index}`);
    if (!body) return;
    body.classList.toggle('open');
    chevron.classList.toggle('open');
  }

  // ─── Pagination ─────────────────────────────────────────

  function renderPagination() {
    const infoEl = document.getElementById('db-results-info');
    const countEl = document.getElementById('db-results-count');
    const pagEl = document.getElementById('db-pagination');

    infoEl.style.display = 'flex';

    const start = state.total === 0 ? 0 : state.skip + 1;
    const end = Math.min(state.skip + state.docs.length, state.total);
    countEl.textContent = `Showing ${formatNumber(start)}-${formatNumber(end)} of ${formatNumber(state.total)}`;

    const hasPrev = state.skip > 0;
    const hasNext = state.skip + state.limit < state.total;
    const currentPage = Math.floor(state.skip / state.limit) + 1;
    const totalPages = Math.ceil(state.total / state.limit);

    pagEl.innerHTML = `
      <button class="db-page-btn" data-page="first" ${!hasPrev ? 'disabled' : ''}>
        <i class="fas fa-angle-double-left"></i>
      </button>
      <button class="db-page-btn" data-page="prev" ${!hasPrev ? 'disabled' : ''}>
        <i class="fas fa-angle-left"></i>
      </button>
      <span style="font-size:12px;color:var(--muted);padding:0 4px;">${currentPage} / ${totalPages}</span>
      <button class="db-page-btn" data-page="next" ${!hasNext ? 'disabled' : ''}>
        <i class="fas fa-angle-right"></i>
      </button>
      <button class="db-page-btn" data-page="last" ${!hasNext ? 'disabled' : ''}>
        <i class="fas fa-angle-double-right"></i>
      </button>
    `;
  }

  function goPage(dir) {
    const totalPages = Math.ceil(state.total / state.limit);
    switch (dir) {
      case 'first': state.skip = 0; break;
      case 'prev': state.skip = Math.max(0, state.skip - state.limit); break;
      case 'next': state.skip = state.skip + state.limit; break;
      case 'last': state.skip = Math.max(0, (totalPages - 1) * state.limit); break;
    }
    document.getElementById('db-skip').value = state.skip;
    queryDocs();
  }

  // ─── Document Detail Modal ──────────────────────────────

  async function viewDocument(index) {
    const doc = state.docs[index];
    if (!doc) return;

    state.modalDoc = doc;
    const docId = doc._id || `doc-${index}`;

    // Try to fetch full document from API
    let fullDoc = doc;
    if (doc._id && state.selected) {
      try {
        fullDoc = (await fetchJSON(`/api/data/databases/collections/${encodeURIComponent(state.selected.name)}/${encodeURIComponent(doc._id)}`)).data;
      } catch (_) {
        // Fall back to inline doc
      }
    }
    state.modalDoc = fullDoc;

    document.getElementById('db-modal-doc-id').textContent = String(docId);
    document.getElementById('db-modal-json').innerHTML = syntaxHighlight(fullDoc);
    document.getElementById('db-modal').classList.add('open');

    // Close on Escape
    document.addEventListener('keydown', handleModalEscape);
  }

  function handleModalEscape(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    document.getElementById('db-modal').classList.remove('open');
    document.removeEventListener('keydown', handleModalEscape);
  }

  function copyDocument() {
    if (!state.modalDoc) return;
    const text = JSON.stringify(state.modalDoc, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      if (typeof Toast !== 'undefined') Toast.success('Document copied to clipboard');
    }).catch(() => {
      if (typeof Toast !== 'undefined') Toast.error('Failed to copy');
    });
  }

  function copyDocJSON(index) {
    const doc = state.docs[index];
    if (!doc) return;
    const text = JSON.stringify(doc, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      if (typeof Toast !== 'undefined') Toast.success('JSON copied to clipboard');
    }).catch(() => {
      if (typeof Toast !== 'undefined') Toast.error('Failed to copy');
    });
  }

  // ─── Event Bindings ─────────────────────────────────────

  function bindEvents() {
    // Search filter
    const searchEl = document.getElementById('db-search');
    searchEl.addEventListener('input', () => {
      renderCollectionList(searchEl.value);
    });

    // Enter key on filter input triggers fetch
    document.getElementById('db-filter').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') queryDocs();
    });

    // Close modal on overlay click
    document.getElementById('db-modal').addEventListener('click', (e) => {
      if (e.target.id === 'db-modal') closeModal();
    });

    // ─── Delegated click handlers (CSP-safe, no inline handlers) ───

    // Collection list: click on collection cards
    document.getElementById('db-collection-list').addEventListener('click', (e) => {
      const card = e.target.closest('[data-collection]');
      if (card) selectCollection(card.dataset.collection);
    });

    // Document list: toggle, view, copy actions
    document.getElementById('db-doc-list').addEventListener('click', (e) => {
      // Action buttons (view / copy) — check first so stopPropagation prevents toggle
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const idx = parseInt(actionBtn.dataset.docIndex);
        if (actionBtn.dataset.action === 'view') viewDocument(idx);
        else if (actionBtn.dataset.action === 'copy') copyDocJSON(idx);
        return;
      }

      // Document header toggle
      const header = e.target.closest('[data-doc-toggle]');
      if (header) toggleDoc(parseInt(header.dataset.docToggle));
    });

    // Pagination buttons
    document.getElementById('db-pagination').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (btn && !btn.disabled) goPage(btn.dataset.page);
    });

    // Fetch button
    document.getElementById('db-fetch-btn').addEventListener('click', queryDocs);

    // Modal copy + close
    document.getElementById('db-modal-copy').addEventListener('click', copyDocument);
    document.getElementById('db-modal-close-btn').addEventListener('click', closeModal);
  }

  // ─── Init ───────────────────────────────────────────────

  function init() {
    bindEvents();
    loadCollections();
  }

  // ─── Public API ─────────────────────────────────────────
  return {
    init,
    selectCollection,
    queryDocs,
    toggleDoc,
    viewDocument,
    closeModal,
    copyDocument,
    copyDocJSON,
    goPage
  };
})();

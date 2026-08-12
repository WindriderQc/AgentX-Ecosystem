/**
 * File Browser — browse, search, and inspect indexed NAS files
 */
const FileBrowser = (() => {
  const API = '/api/data/storage';

  const state = {
    page: 0,
    limit: 25,
    search: '',
    ext: '',
    sort: 'filename',
    dir: 'asc',
    total: 0,
    showDupes: false,
    loading: false
  };

  let searchTimer = null;

  // ── Helpers ──

  function $(id) { return document.getElementById(id); }

  const showToast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);

  const escapeHtml = (str) => window.AgentXUtils.escapeHtml(str);

  const formatBytes = (bytes) => window.AgentXUtils.formatBytes(bytes);

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '--';
    return Number(n).toLocaleString();
  }

  function formatDate(d) {
    if (!d) return '--';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '--';
    return dt.toLocaleDateString('en-CA') + ' ' + dt.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function getFileIcon(ext) {
    const map = {
      '.jpg': 'fa-file-image', '.jpeg': 'fa-file-image', '.png': 'fa-file-image',
      '.gif': 'fa-file-image', '.webp': 'fa-file-image', '.svg': 'fa-file-image',
      '.bmp': 'fa-file-image', '.ico': 'fa-file-image', '.tiff': 'fa-file-image',
      '.js': 'fa-file-code', '.ts': 'fa-file-code', '.py': 'fa-file-code',
      '.html': 'fa-file-code', '.css': 'fa-file-code', '.json': 'fa-file-code',
      '.xml': 'fa-file-code', '.yaml': 'fa-file-code', '.yml': 'fa-file-code',
      '.sh': 'fa-file-code', '.bash': 'fa-file-code', '.c': 'fa-file-code',
      '.cpp': 'fa-file-code', '.h': 'fa-file-code', '.java': 'fa-file-code',
      '.go': 'fa-file-code', '.rs': 'fa-file-code', '.rb': 'fa-file-code',
      '.php': 'fa-file-code', '.sql': 'fa-file-code', '.md': 'fa-file-code',
      '.pdf': 'fa-file-pdf',
      '.zip': 'fa-file-zipper', '.tar': 'fa-file-zipper', '.gz': 'fa-file-zipper',
      '.rar': 'fa-file-zipper', '.7z': 'fa-file-zipper', '.bz2': 'fa-file-zipper',
      '.mp4': 'fa-file-video', '.avi': 'fa-file-video', '.mkv': 'fa-file-video',
      '.mov': 'fa-file-video', '.wmv': 'fa-file-video', '.webm': 'fa-file-video',
      '.mp3': 'fa-file-audio', '.wav': 'fa-file-audio', '.flac': 'fa-file-audio',
      '.ogg': 'fa-file-audio', '.aac': 'fa-file-audio', '.m4a': 'fa-file-audio',
      '.doc': 'fa-file-word', '.docx': 'fa-file-word',
      '.xls': 'fa-file-excel', '.xlsx': 'fa-file-excel', '.csv': 'fa-file-excel',
      '.ppt': 'fa-file-powerpoint', '.pptx': 'fa-file-powerpoint',
      '.txt': 'fa-file-lines', '.log': 'fa-file-lines'
    };
    return map[ext?.toLowerCase()] || 'fa-file';
  }

  function getIconClass(ext) {
    const icon = getFileIcon(ext);
    if (icon === 'fa-file-image') return 'image';
    if (icon === 'fa-file-code') return 'code';
    if (icon === 'fa-file-pdf') return 'pdf';
    if (icon === 'fa-file-zipper') return 'archive';
    if (icon === 'fa-file-video') return 'video';
    if (icon === 'fa-file-audio') return 'audio';
    return '';
  }

  // ── API ──

  const apiFetch = DataCommons.apiFetch;

  // ── Stats ──

  async function loadStats() {
    try {
      const [statsRes, dirRes] = await Promise.all([
        apiFetch(`${API}/files/stats`),
        apiFetch(`/api/data/storage/directory-count`).catch(() => null)
      ]);
      const d = statsRes.data || {};
      $('statTotalFiles').textContent = formatNumber(d.total?.count);
      $('statTotalSize').textContent = formatBytes(d.total?.totalSize);
      $('statExtensions').textContent = formatNumber(
        Array.isArray(d.byExtension) ? d.byExtension.length : 0
      );

      // Directory count: prefer dedicated endpoint, fallback to stats
      const dirCount = dirRes?.data?.count ?? dirRes?.data?.directories ?? d.directories;
      $('statDirectories').textContent = formatNumber(dirCount);

      // Populate extension filter from byExtension
      if (Array.isArray(d.byExtension)) {
        populateExtFilter(d.byExtension
          .filter(e => e.extension && e.extension !== 'no extension')
          .map(e => ({ _id: e.extension, count: e.count })));
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
      showToast('Failed to load file stats', 'error');
    }
  }

  function populateExtFilter(extensions) {
    const sel = $('fbExtFilter');
    // Keep the "All" option
    sel.innerHTML = '<option value="">All Extensions</option>';
    const sorted = [...extensions].sort((a, b) => {
      const aExt = typeof a === 'string' ? a : a._id || a.ext;
      const bExt = typeof b === 'string' ? b : b._id || b.ext;
      return (aExt || '').localeCompare(bExt || '');
    });
    sorted.forEach(e => {
      const ext = typeof e === 'string' ? e : e._id || e.ext;
      if (!ext) return;
      const opt = document.createElement('option');
      opt.value = ext;
      opt.textContent = ext;
      sel.appendChild(opt);
    });
  }

  // ── Files ──

  async function loadFiles() {
    if (state.loading) return;
    state.loading = true;
    renderLoading();

    try {
      const params = new URLSearchParams({
        page: String(state.page + 1),
        limit: String(state.limit),
        sortBy: state.sort,
        sortOrder: state.dir
      });
      if (state.search) params.set('search', state.search);
      if (state.ext) params.set('ext', state.ext);

      const res = await apiFetch(`${API}/files/browse?${params}`);
      const d = res.data || {};
      const files = d.files || [];
      state.total = d.pagination?.total || d.total || 0;

      renderFiles(files);
      renderPagination();
    } catch (err) {
      console.error('Failed to load files:', err);
      showToast('Failed to load files', 'error');
      renderEmpty('Error loading files');
    } finally {
      state.loading = false;
    }
  }

  function renderLoading() {
    $('fbTableBody').innerHTML =
      '<tr class="fb-loading-row"><td colspan="6"><div class="fb-spinner"></div></td></tr>';
    $('fbPageInfo').textContent = 'Loading...';
    $('fbPageBtns').innerHTML = '';
  }

  function renderEmpty(msg) {
    $('fbTableBody').innerHTML =
      `<tr class="fb-empty-row"><td colspan="6"><i class="fas fa-folder-open" style="font-size:24px;margin-bottom:8px;display:block;color:var(--muted)"></i>${escapeHtml(msg || 'No files found')}</td></tr>`;
    $('fbPageInfo').textContent = '0 results';
    $('fbPageBtns').innerHTML = '';
  }

  function renderFiles(files) {
    if (!files.length) {
      renderEmpty(state.search || state.ext ? 'No files match your filters' : 'No files indexed yet');
      return;
    }
    const rows = files.map(f => {
      const ext = f.extension || '';
      const icon = getFileIcon(ext);
      const iconClass = getIconClass(ext);
      const name = f.name || f.filename || '--';
      const path = f.path || f.fullPath || '--';
      const size = f.size != null ? formatBytes(f.size) : '--';
      const modified = f.mtime ? formatDate(new Date(f.mtime * 1000)) : (f.mtimeFormatted || formatDate(f.modified) || '--');

      return `<tr>
        <td><i class="fas ${icon} fb-file-icon ${iconClass}"></i></td>
        <td><span class="fb-file-name" title="${escapeHtml(name)}">${escapeHtml(truncate(name, 50))}</span></td>
        <td><span class="fb-file-path" title="${escapeHtml(path)}">${escapeHtml(truncate(path, 60))}</span></td>
        <td class="fb-file-size">${size}</td>
        <td class="fb-file-date">${modified}</td>
        <td><button class="fb-detail-btn" data-file='${escapeHtml(JSON.stringify(f))}'><i class="fas fa-info-circle"></i> Details</button></td>
      </tr>`;
    }).join('');
    $('fbTableBody').innerHTML = rows;
  }

  // ── Pagination ──

  function renderPagination() {
    const total = state.total;
    const limit = state.limit;
    const page = state.page;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const from = total === 0 ? 0 : page * limit + 1;
    const to = Math.min((page + 1) * limit, total);

    $('fbPageInfo').textContent = `Showing ${from} to ${to} of ${formatNumber(total)} results`;

    // Build page buttons
    const btns = [];
    btns.push(`<button class="fb-page-btn" ${page === 0 ? 'disabled' : ''} data-page="${page - 1}"><i class="fas fa-chevron-left"></i></button>`);

    const maxVisible = 7;
    let startPage = Math.max(0, page - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible);
    if (endPage - startPage < maxVisible) {
      startPage = Math.max(0, endPage - maxVisible);
    }

    if (startPage > 0) {
      btns.push(`<button class="fb-page-btn" data-page="0">1</button>`);
      if (startPage > 1) btns.push(`<span style="color:var(--muted);padding:6px 4px">...</span>`);
    }

    for (let i = startPage; i < endPage; i++) {
      btns.push(`<button class="fb-page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i + 1}</button>`);
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) btns.push(`<span style="color:var(--muted);padding:6px 4px">...</span>`);
      btns.push(`<button class="fb-page-btn" data-page="${totalPages - 1}">${totalPages}</button>`);
    }

    btns.push(`<button class="fb-page-btn" ${page >= totalPages - 1 ? 'disabled' : ''} data-page="${page + 1}"><i class="fas fa-chevron-right"></i></button>`);

    $('fbPageBtns').innerHTML = btns.join('');
  }

  function goPage(p) {
    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    if (p < 0 || p >= totalPages) return;
    state.page = p;
    loadFiles();
    // Scroll to top of table
    document.querySelector('.fb-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Detail modal ──

  function showDetail(fileJson) {
    const f = typeof fileJson === 'string' ? JSON.parse(fileJson) : fileJson;
    const fields = [
      ['Name', f.name || f.filename || '--', false],
      ['Path', f.path || f.fullPath || '--', true],
      ['Size', f.size != null ? formatBytes(f.size) : '--', false],
      ['Extension', f.extension || '--', false],
      ['Modified', f.mtime ? formatDate(new Date(f.mtime * 1000)) : (f.mtimeFormatted || formatDate(f.modified) || '--'), false],
      ['Hash', f.hash || f.md5 || f.sha256 || '--', true],
    ];

    // Add any extra metadata
    const knownKeys = new Set(['name', 'filename', 'path', 'fullPath', 'size', 'extension', 'modified', 'modifiedAt', 'lastModified', 'hash', 'md5', 'sha256', '_id', '__v']);
    Object.keys(f).forEach(k => {
      if (!knownKeys.has(k) && f[k] != null && f[k] !== '') {
        const val = typeof f[k] === 'object' ? JSON.stringify(f[k]) : String(f[k]);
        fields.push([k.charAt(0).toUpperCase() + k.slice(1), val, false]);
      }
    });

    const html = fields.map(([key, val, mono]) =>
      `<div class="fb-modal-key">${escapeHtml(key)}</div>
       <div class="fb-modal-val${mono ? ' mono' : ''}">${escapeHtml(val)}</div>`
    ).join('');

    $('fbModalBody').innerHTML = html;

    const overlay = $('fbModal');
    overlay.classList.add('visible');
  }

  function closeModal() {
    $('fbModal').classList.remove('visible');
  }

  // ── Duplicates ──

  async function loadDuplicates() {
    $('fbDupesContent').innerHTML =
      '<div class="fb-dupes-empty"><div class="fb-spinner"></div><br>Loading duplicates...</div>';

    try {
      const res = await apiFetch(`${API}/files/duplicates`);
      const groups = res.data?.duplicates || [];

      if (!groups.length) {
        $('fbDupesContent').innerHTML =
          '<div class="fb-dupes-empty"><i class="fas fa-check-circle" style="font-size:24px;margin-bottom:8px;display:block;color:#4ade80"></i>No duplicate files found</div>';
        return;
      }

      const html = groups.map(g => {
        const locations = g.locations || [];
        const hash = g.sha256 || g.filename || '--';
        const count = g.count || locations.length;

        const items = locations.map(loc => {
          const locPath = loc.path || (loc.dirname && loc.filename ? loc.dirname + '/' + loc.filename : loc.dirname || '--');
          return `<li>
            <i class="fas fa-file fb-file-icon" style="font-size:13px"></i>
            <span title="${escapeHtml(locPath)}">${escapeHtml(truncate(locPath, 80))}</span>
          </li>`;
        }).join('');

        return `<div class="fb-dupe-group">
          <div class="fb-dupe-group-header">
            <i class="fas fa-clone" style="color:#f87171"></i>
            <span>${escapeHtml(g.filename || locations[0]?.filename || 'Unknown')}</span>
            <span class="fb-dupe-badge">${count} copies</span>
            <span class="fb-dupe-hash" title="${escapeHtml(hash)}">${truncate(hash, 16)}</span>
            ${g.wastedSpaceFormatted ? `<span class="fb-dupe-size">${g.wastedSpaceFormatted} wasted</span>` : ''}
          </div>
          <ul class="fb-dupe-list">${items}</ul>
        </div>`;
      }).join('');

      $('fbDupesContent').innerHTML = html;
    } catch (err) {
      console.error('Failed to load duplicates:', err);
      $('fbDupesContent').innerHTML =
        '<div class="fb-dupes-empty"><i class="fas fa-exclamation-triangle" style="font-size:24px;margin-bottom:8px;display:block;color:#fbbf24"></i>Failed to load duplicates</div>';
      showToast('Failed to load duplicates', 'error');
    }
  }

  function toggleDupes() {
    state.showDupes = !state.showDupes;
    const btn = $('fbDupesToggle');
    const browseSection = $('fbBrowseSection');
    const dupesSection = $('fbDupesSection');

    if (state.showDupes) {
      btn.classList.add('active');
      browseSection.classList.add('hidden');
      dupesSection.classList.add('visible');
      loadDuplicates();
    } else {
      btn.classList.remove('active');
      browseSection.classList.remove('hidden');
      dupesSection.classList.remove('visible');
    }
  }

  // ── Event binding ──

  function bindEvents() {
    // Search with debounce
    $('fbSearch').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        state.page = 0;
        loadFiles();
      }, 300);
    });

    // Extension filter
    $('fbExtFilter').addEventListener('change', e => {
      state.ext = e.target.value;
      state.page = 0;
      loadFiles();
    });

    // Sort
    $('fbSort').addEventListener('change', e => {
      state.sort = e.target.value;
      state.page = 0;
      loadFiles();
    });

    // Direction toggle
    $('fbDirToggle').addEventListener('click', () => {
      state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      state.page = 0;
      const btn = $('fbDirToggle');
      if (state.dir === 'asc') {
        btn.innerHTML = '<i class="fas fa-arrow-up-short-wide"></i> Asc';
      } else {
        btn.innerHTML = '<i class="fas fa-arrow-down-wide-short"></i> Desc';
      }
      loadFiles();
    });

    // Per page
    $('fbLimit').addEventListener('change', e => {
      state.limit = parseInt(e.target.value, 10);
      state.page = 0;
      loadFiles();
    });

    // Refresh
    $('fbRefresh').addEventListener('click', () => {
      loadStats();
      if (state.showDupes) {
        loadDuplicates();
      } else {
        loadFiles();
      }
    });

    // Clear
    $('fbClear').addEventListener('click', () => {
      state.search = '';
      state.ext = '';
      state.sort = 'filename';
      state.dir = 'asc';
      state.page = 0;
      state.limit = 25;

      $('fbSearch').value = '';
      $('fbExtFilter').value = '';
      $('fbSort').value = 'filename';
      $('fbLimit').value = '25';
      $('fbDirToggle').innerHTML = '<i class="fas fa-arrow-up-short-wide"></i> Asc';

      loadFiles();
    });

    // Duplicates toggle
    $('fbDupesToggle').addEventListener('click', toggleDupes);

    // Detail buttons (event delegation)
    $('fbTableBody').addEventListener('click', e => {
      const btn = e.target.closest('.fb-detail-btn');
      if (btn && btn.dataset.file) {
        try { showDetail(JSON.parse(btn.dataset.file)); } catch (_) {}
      }
    });

    // Pagination delegation
    $('fbPageBtns').addEventListener('click', e => {
      const btn = e.target.closest('.fb-page-btn');
      if (btn && !btn.disabled && btn.dataset.page != null) {
        goPage(parseInt(btn.dataset.page, 10));
      }
    });

    // Modal close
    $('fbModalClose').addEventListener('click', closeModal);
    $('fbModal').addEventListener('click', e => {
      if (e.target === $('fbModal')) closeModal();
    });

    // Escape key closes modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
  }

  // ── Init ──

  function init() {
    bindEvents();
    loadStats();
    loadFiles();
  }

  return { init, showDetail, goPage };
})();

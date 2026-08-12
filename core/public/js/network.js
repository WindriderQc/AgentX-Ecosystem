/**
 * Network Scanner Page — Frontend
 *
 * Discovers and manages devices on the local network via the data service proxy.
 */
const NetworkPage = (() => {
  let devices = [];
  let scanning = false;
  let filterText = '';

  // ─── API helpers ──────────────────────────────────────

  const apiFetch = DataCommons.apiFetch;

  const showToast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);

  // ─── Formatters ───────────────────────────────────────

  const timeAgo = DataCommons.timeAgo;

  function formatDate(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const escapeHtml = (str) => window.AgentXUtils.escapeHtml(str);

  // ─── Load Devices ─────────────────────────────────────

  async function loadDevices() {
    try {
      const json = await apiFetch('/api/data/network/devices');
      devices = json.data?.devices || json.data || [];
      updateStats();
      renderTable();
    } catch (err) {
      console.error('Failed to load devices:', err);
      showToast('Failed to load devices: ' + err.message, 'error');
      document.getElementById('ns-table-body').innerHTML =
        '<div class="ns-empty"><i class="fas fa-network-wired"></i><p>Could not load devices. Is the data service running?</p></div>';
    }
  }

  // ─── Stats ────────────────────────────────────────────

  function updateStats() {
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.length - online;
    document.getElementById('ns-total').textContent = devices.length;
    document.getElementById('ns-online').textContent = online;
    document.getElementById('ns-offline').textContent = offline;

    // Find most recent lastSeen across all devices
    let latest = null;
    for (const d of devices) {
      if (d.lastSeen) {
        const t = new Date(d.lastSeen).getTime();
        if (!latest || t > latest) latest = t;
      }
    }
    document.getElementById('ns-lastscan').textContent = latest ? timeAgo(new Date(latest).toISOString()) : '--';
  }

  // ─── Render Table ─────────────────────────────────────

  function renderTable() {
    const container = document.getElementById('ns-table-body');
    const filtered = getFilteredDevices();

    if (filtered.length === 0) {
      container.innerHTML = devices.length === 0
        ? '<div class="ns-empty"><i class="fas fa-network-wired"></i><p>No devices found. Run a scan to discover devices on your network.</p></div>'
        : '<div class="ns-empty"><i class="fas fa-filter"></i><p>No devices match your filter.</p></div>';
      return;
    }

    // Sort: online first, then by IP
    filtered.sort((a, b) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (a.status !== 'online' && b.status === 'online') return 1;
      return ipToNum(a.ip) - ipToNum(b.ip);
    });

    let html = `<table class="ns-table">
      <thead><tr>
        <th>Status</th>
        <th>IP Address</th>
        <th>MAC Address</th>
        <th>Hostname</th>
        <th>Vendor</th>
        <th>Source</th>
        <th>Alias</th>
        <th>Type</th>
        <th>Last Seen</th>
        <th>Actions</th>
      </tr></thead><tbody>`;

    for (const d of filtered) {
      const statusClass = d.status === 'online' ? 'online' : 'offline';
      const deviceType = d.hardware?.type || d.type || 'Unknown';
      const typeClass = deviceType.toLowerCase();
      const displayType = deviceType;
      html += `<tr>
        <td><span class="ns-status-dot ${statusClass}" title="${statusClass}"></span></td>
        <td>${escapeHtml(d.ip)}</td>
        <td class="ns-mac">${escapeHtml(d.mac || '--')}</td>
        <td>${escapeHtml(d.hostname || '--')}</td>
        <td>${escapeHtml(d.vendor || '--')}</td>
        <td class="ns-source">${escapeHtml(d.scanSource || '--')}</td>
        <td>${escapeHtml(d.alias || '--')}</td>
        <td><span class="ns-type-badge ${typeClass}">${escapeHtml(displayType)}</span></td>
        <td title="${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : ''}">${timeAgo(d.lastSeen)}</td>
        <td class="ns-actions">
          <button class="ns-action-btn" data-edit-device="${d._id}" title="Edit"><i class="fas fa-pen"></i> Edit</button>
          <button class="ns-action-btn" id="ns-enrich-${d._id}" data-enrich-device="${d._id}" title="Deep Scan"><i class="fas fa-search-plus"></i> Deep Scan</button>
        </td>
      </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function getFilteredDevices() {
    if (!filterText) return [...devices];
    const q = filterText.toLowerCase();
    return devices.filter(d =>
      (d.ip && d.ip.toLowerCase().includes(q)) ||
      (d.mac && d.mac.toLowerCase().includes(q)) ||
      (d.hostname && d.hostname.toLowerCase().includes(q)) ||
      (d.vendor && d.vendor.toLowerCase().includes(q)) ||
      (d.alias && d.alias.toLowerCase().includes(q)) ||
      ((d.hardware?.type || d.type) && (d.hardware?.type || d.type).toLowerCase().includes(q))
    );
  }

  function ipToNum(ip) {
    if (!ip) return 0;
    const parts = ip.split('.');
    return parts.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  }

  function filterDevices() {
    filterText = (document.getElementById('ns-filter').value || '').trim();
    renderTable();
  }

  // ─── Scanner status / live state ──────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reflect whether a native scanner agent is reporting (live), whether the
  // in-container nmap fallback exists, or neither (the 0258 disabled state).
  async function loadScannerStatus() {
    const btn = document.getElementById('ns-scan-btn');
    const notice = document.getElementById('ns-capability-notice');
    const statusEl = document.getElementById('ns-scanner-status');
    const label = document.getElementById('ns-scan-label');

    let agents = null, capability = null;
    try { agents = (await apiFetch('/api/data/network/agents')).data; } catch (_) { /* leave live */ }
    try { capability = (await apiFetch('/api/data/network/capability')).data; } catch (_) { /* leave live */ }

    const activeScanners = (agents?.scanners || []).filter((s) => s.active);
    const hasAgent = activeScanners.length > 0;
    const hasNmap = capability?.nmap === true;

    if (btn) { btn.disabled = false; btn.title = ''; }
    if (notice) notice.style.display = 'none';
    if (!statusEl) return;
    statusEl.style.display = '';

    if (hasAgent) {
      const names = activeScanners.map((s) => escapeHtml(s.scannerId)).join(', ');
      const newest = activeScanners.reduce((acc, s) => {
        const t = s.lastSeen ? new Date(s.lastSeen).getTime() : 0;
        return t > acc ? t : acc;
      }, 0);
      statusEl.innerHTML = `<span class="ns-status-dot online"></span> Live — agent reporting: <strong>${names}</strong>` +
        (newest ? ` &middot; last seen ${timeAgo(new Date(newest).toISOString())}` : '');
      if (label && !scanning) label.textContent = 'Live';
    } else if (hasNmap) {
      statusEl.innerHTML = '<span class="ns-status-dot"></span> In-container nmap available (no agent reporting)';
    } else {
      // 0258 fallback — no agent and no nmap in the container.
      if (btn) { btn.disabled = true; btn.title = 'No scanner agent is reporting and nmap is not in the data container'; }
      if (notice) notice.style.display = '';
      statusEl.innerHTML = '<span class="ns-status-dot offline"></span> No scanner reporting &middot; run the network agent on a host that can see the LAN';
      if (label && !scanning) label.textContent = 'Unavailable (no scanner)';
    }
  }

  // Poll a queued scan job until it completes (an agent posted) or we time out.
  async function pollScanJob(jobId, { timeoutMs = 45000, intervalMs = 1500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(intervalMs);
      try {
        const job = (await apiFetch(`/api/data/network/scan-requests/${jobId}`)).data;
        if (job?.results?.length) await loadDevices();   // stream devices in as vantages report
        if (job?.done) return job;
      } catch (_) { /* keep polling */ }
    }
    return null;
  }

  // ─── Scan ─────────────────────────────────────────────

  async function startScan() {
    if (scanning) return;
    const target = document.getElementById('ns-target').value.trim();
    if (!target) {
      showToast('Please enter a CIDR target', 'error');
      return;
    }

    scanning = true;
    const btn = document.getElementById('ns-scan-btn');
    const dot = document.getElementById('ns-scan-dot');
    const label = document.getElementById('ns-scan-label');

    btn.disabled = true;
    btn.classList.add('scanning');
    btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Scanning...';
    dot.className = 'ns-status-dot online';
    label.textContent = 'Scanning...';

    try {
      const result = await apiFetch('/api/data/network/scan', {
        method: 'POST',
        body: JSON.stringify({ target })
      });

      if (result.data?.mode === 'agent' && result.data?.jobId) {
        // Queued to a native scanner agent — poll the job until it reports.
        label.textContent = 'Queued to agent…';
        const job = await pollScanJob(result.data.jobId);
        if (job) {
          const reporters = job.results || [];
          const total = reporters.reduce((s, r) => s + (r.discovered || 0), 0);
          showToast(`Scan complete — ${reporters.length} scanner(s) reported ${total} device(s).`, 'success');
        } else {
          showToast('Scan queued, but no agent reported in time.', 'info');
        }
      } else {
        // In-container nmap fallback.
        showToast(`Scan complete. Found ${result.data?.discovered || 0} device(s).`, 'success');
      }
      await loadDevices();
    } catch (err) {
      console.error('Scan failed:', err);
      showToast('Scan failed: ' + err.message, 'error');
    } finally {
      scanning = false;
      btn.disabled = false;
      btn.classList.remove('scanning');
      btn.innerHTML = '<i class="fas fa-satellite-dish"></i> Scan Now';
      dot.className = 'ns-status-dot';
      label.textContent = 'Idle';
      loadScannerStatus();
    }
  }

  // ─── Edit Modal ───────────────────────────────────────

  function editDevice(id) {
    const device = devices.find(d => d._id === id);
    if (!device) return;

    document.getElementById('ns-edit-id').value = id;
    document.getElementById('ns-edit-mac').value = device.mac || '';
    document.getElementById('ns-edit-alias').value = device.alias || '';
    document.getElementById('ns-edit-location').value = device.location || '';
    document.getElementById('ns-edit-notes').value = device.notes || '';
    document.getElementById('ns-edit-type').value = device.hardware?.type || device.type || 'Unknown';

    openEditModal();
  }

  function openEditModal() {
    document.getElementById('ns-edit-overlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeEditModal() {
    document.getElementById('ns-edit-overlay').classList.remove('visible');
    document.body.style.overflow = '';
  }

  async function saveDevice() {
    const id = document.getElementById('ns-edit-id').value;
    if (!id) return;

    const saveBtn = document.getElementById('ns-save-btn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    const payload = {
      alias: document.getElementById('ns-edit-alias').value.trim(),
      location: document.getElementById('ns-edit-location').value.trim(),
      notes: document.getElementById('ns-edit-notes').value.trim(),
      type: document.getElementById('ns-edit-type').value
    };

    try {
      await apiFetch(`/api/data/network/devices/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      // Update local cache — mirror backend's nested structure
      const idx = devices.findIndex(d => d._id === id);
      if (idx !== -1) {
        const d = devices[idx];
        d.alias = payload.alias;
        d.location = payload.location;
        d.notes = payload.notes;
        if (!d.hardware) d.hardware = {};
        d.hardware.type = payload.type;
      }

      showToast('Device updated', 'success');
      closeEditModal();
      renderTable();
    } catch (err) {
      console.error('Save failed:', err);
      showToast('Failed to save: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-check"></i> Save';
    }
  }

  // ─── Deep Scan (Enrich) Drawer ────────────────────────

  async function enrichDevice(id) {
    const device = devices.find(d => d._id === id);
    if (!device) return;

    // Mark button as loading
    const btn = document.getElementById(`ns-enrich-${id}`);
    if (btn) {
      btn.classList.add('enriching');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner"></i> Scanning...';
    }

    openDrawer();
    const content = document.getElementById('ns-drawer-content');
    content.innerHTML = `<div class="ns-drawer-loading"><i class="fas fa-spinner"></i><p>Running deep scan on ${escapeHtml(device.ip)}...</p></div>`;

    try {
      const result = await apiFetch(`/api/data/network/devices/${id}/enrich`, {
        method: 'POST'
      });

      const enrichedDevice = result.data?.device || result.data || result;
      renderDrawerContent(device, enrichedDevice);
    } catch (err) {
      console.error('Enrich failed:', err);
      content.innerHTML = `<div class="ns-empty"><i class="fas fa-exclamation-triangle"></i><p>Deep scan failed: ${escapeHtml(err.message)}</p></div>`;
      showToast('Deep scan failed: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.classList.remove('enriching');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search-plus"></i> Deep Scan';
      }
    }
  }

  function renderDrawerContent(device, data) {
    const content = document.getElementById('ns-drawer-content');
    const ports = data.openPorts || [];
    const os = data.hardware?.os || 'Unknown';

    let portsHtml;
    if (ports.length === 0) {
      portsHtml = '<p style="color: var(--muted); font-size: 13px;">No open ports detected.</p>';
    } else {
      portsHtml = `<table class="ns-ports-table">
        <thead><tr><th>Port</th><th>Service</th><th>State</th></tr></thead>
        <tbody>`;
      for (const p of ports) {
        const stateClass = p.state === 'open' ? 'ns-port-open'
          : p.state === 'closed' ? 'ns-port-closed' : 'ns-port-filtered';
        portsHtml += `<tr>
          <td style="font-family: monospace;">${escapeHtml(String(p.port))}</td>
          <td>${escapeHtml(p.service || '--')}</td>
          <td class="${stateClass}">${escapeHtml(p.state || '--')}</td>
        </tr>`;
      }
      portsHtml += '</tbody></table>';
    }

    content.innerHTML = `
      <div class="ns-drawer-section">
        <h4>Device</h4>
        <div class="ns-drawer-info">
          <div style="margin-bottom: 8px;"><span class="label">IP: </span><span class="value">${escapeHtml(device.ip)}</span></div>
          <div style="margin-bottom: 8px;"><span class="label">MAC: </span><span class="value" style="font-family: monospace;">${escapeHtml(device.mac || '--')}</span></div>
          <div><span class="label">Hostname: </span><span class="value">${escapeHtml(device.hostname || '--')}</span></div>
        </div>
      </div>
      <div class="ns-drawer-section">
        <h4>OS Detection</h4>
        <div class="ns-drawer-info">
          <span class="value">${escapeHtml(typeof os === 'string' ? os : JSON.stringify(os))}</span>
        </div>
      </div>
      <div class="ns-drawer-section">
        <h4>Open Ports (${ports.length})</h4>
        ${portsHtml}
      </div>
    `;
  }

  function openDrawer() {
    document.getElementById('ns-drawer-overlay').classList.add('visible');
    document.getElementById('ns-drawer').classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    document.getElementById('ns-drawer-overlay').classList.remove('visible');
    document.getElementById('ns-drawer').classList.remove('visible');
    document.body.style.overflow = '';
  }

  // ─── Keyboard ─────────────────────────────────────────

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      const modal = document.getElementById('ns-edit-overlay');
      if (modal.classList.contains('visible')) {
        closeEditModal();
        return;
      }
      const drawer = document.getElementById('ns-drawer');
      if (drawer.classList.contains('visible')) {
        closeDrawer();
      }
    }
  }

  // ─── Init ─────────────────────────────────────────────

  function init() {
    document.addEventListener('keydown', handleKeydown);

    // Static element listeners (replace inline onclick/oninput)
    document.getElementById('ns-scan-btn').addEventListener('click', startScan);
    document.getElementById('ns-cancel-btn').addEventListener('click', closeEditModal);
    document.getElementById('ns-save-btn').addEventListener('click', saveDevice);
    document.getElementById('ns-drawer-overlay').addEventListener('click', closeDrawer);
    document.getElementById('ns-drawer-close').addEventListener('click', closeDrawer);
    document.getElementById('ns-filter').addEventListener('input', filterDevices);

    // Close modal on overlay click
    document.getElementById('ns-edit-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeEditModal();
    });

    // Event delegation for dynamically rendered device table buttons
    document.getElementById('ns-table-body').addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit-device]');
      if (editBtn) {
        editDevice(editBtn.dataset.editDevice);
        return;
      }
      const enrichBtn = e.target.closest('[data-enrich-device]');
      if (enrichBtn) {
        enrichDevice(enrichBtn.dataset.enrichDevice);
      }
    });

    loadDevices();
    loadScannerStatus();
  }

  // ─── Public API ───────────────────────────────────────

  return {
    init,
    startScan,
    loadScannerStatus,
    editDevice,
    saveDevice,
    closeEditModal,
    enrichDevice,
    closeDrawer,
    filterDevices
  };
})();

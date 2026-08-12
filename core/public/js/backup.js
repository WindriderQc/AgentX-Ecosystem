(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- utility ----------
  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, type = 'info') {
    const toast = $('toast');
    toast.textContent = msg;
    toast.style.background = type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 4500);
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  async function jsonFetch(url, opts = {}) {
    const resp = await fetch(url, opts);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.message || body.error || `HTTP ${resp.status}`);
    return body;
  }

  function locationCell(text) {
    return `<code style="font-size:11px; color:#94a3b8; word-break:break-all;">${escape(text || '—')}</code>`;
  }

  // ---------- MongoDB ----------
  async function loadMongoBackups() {
    const list = $('mongoBackupsList');
    list.innerHTML = '<tr><td colspan="5" style="padding:16px; text-align:center; color:#888;">Loading…</td></tr>';
    try {
      const { backups = [], root } = await jsonFetch('/api/operations/backups');
      $('mongoRoot').textContent = root || '—';
      $('mongoStatus').textContent = `${backups.length} backup${backups.length === 1 ? '' : 's'}`;
      if (!backups.length) {
        list.innerHTML = '<tr><td colspan="5" style="padding:16px; text-align:center; color:#888;">No backups yet.</td></tr>';
        return;
      }
      list.innerHTML = backups.map((b) => `
        <tr style="border-bottom:1px solid var(--border, #2a3145);">
          <td style="padding:8px 4px;"><code>${escape(b.name)}</code></td>
          <td style="padding:8px 4px;">${formatDate(b.date)}</td>
          <td style="padding:8px 4px; text-align:right;">${formatBytes(b.size)}</td>
          <td style="padding:8px 4px;">${locationCell(b.path)}</td>
          <td style="padding:8px 4px; text-align:right;">
            <button class="btn btn-sm" data-action="restore-mongo" data-name="${escape(b.name)}" style="padding:4px 10px; margin-right:4px;">Restore</button>
            <button class="btn btn-sm" data-action="delete-mongo" data-name="${escape(b.name)}" style="padding:4px 10px; background:#dc3545; color:#fff;">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      list.innerHTML = `<tr><td colspan="5" style="padding:16px; text-align:center; color:#dc3545;">Failed to load: ${escape(err.message)}</td></tr>`;
    }
  }

  async function createMongoBackup() {
    const btn = $('mongoBackupBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running…';
    try {
      const { backup } = await jsonFetch('/api/operations/backup', { method: 'POST' });
      showToast(`MongoDB backup created: ${backup.name}`, 'success');
      await loadMongoBackups();
    } catch (err) {
      showToast(`Backup failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plus"></i> Create backup';
    }
  }

  async function restoreMongoBackup(name) {
    if (!confirm(`Restore MongoDB from "${name}"?\n\nThis will REPLACE all data in the agentx database.`)) return;
    try {
      await jsonFetch(`/api/operations/restore/${encodeURIComponent(name)}?confirm=true`, { method: 'POST' });
      showToast(`Restored from ${name}`, 'success');
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, 'error');
    }
  }

  async function deleteMongoBackup(name) {
    if (!confirm(`Delete backup "${name}"?\nThis cannot be undone.`)) return;
    try {
      await jsonFetch(`/api/operations/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      showToast(`Deleted ${name}`, 'success');
      await loadMongoBackups();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- Qdrant ----------
  async function loadQdrantBackups() {
    const list = $('qdrantBackupsList');
    list.innerHTML = '<tr><td colspan="5" style="padding:16px; text-align:center; color:#888;">Loading…</td></tr>';
    try {
      const { snapshots = [], root, collection } = await jsonFetch('/api/operations/qdrant/backups');
      if (root) $('qdrantRoot').textContent = root;
      if (collection) $('qdrantCollection').textContent = collection;
      $('qdrantStatus').textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`;
      if (!snapshots.length) {
        list.innerHTML = '<tr><td colspan="5" style="padding:16px; text-align:center; color:#888;">No snapshots yet.</td></tr>';
        return;
      }
      list.innerHTML = snapshots.map((s) => {
        const loc = root ? `${root}/${s.name}` : s.name;
        return `
        <tr style="border-bottom:1px solid var(--border, #2a3145);">
          <td style="padding:8px 4px;"><code>${escape(s.name)}</code></td>
          <td style="padding:8px 4px;">${formatDate(s.creation_time)}</td>
          <td style="padding:8px 4px; text-align:right;">${formatBytes(s.size)}</td>
          <td style="padding:8px 4px;">${locationCell(loc)}</td>
          <td style="padding:8px 4px; text-align:right;">
            <button class="btn btn-sm" data-action="restore-qdrant" data-name="${escape(s.name)}" style="padding:4px 10px; margin-right:4px;">Restore</button>
            <button class="btn btn-sm" data-action="delete-qdrant" data-name="${escape(s.name)}" style="padding:4px 10px; background:#dc3545; color:#fff;">Delete</button>
          </td>
        </tr>
      `;
      }).join('');
    } catch (err) {
      list.innerHTML = `<tr><td colspan="5" style="padding:16px; text-align:center; color:#dc3545;">Failed to load: ${escape(err.message)}</td></tr>`;
      $('qdrantStatus').textContent = 'unavailable';
    }
  }

  async function createQdrantBackup() {
    const btn = $('qdrantBackupBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running…';
    try {
      const { snapshot } = await jsonFetch('/api/operations/qdrant/backup', { method: 'POST' });
      showToast(`Qdrant snapshot created: ${snapshot.name}`, 'success');
      await loadQdrantBackups();
    } catch (err) {
      showToast(`Snapshot failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plus"></i> Create snapshot';
    }
  }

  async function restoreQdrantBackup(name) {
    if (!confirm(`Restore Qdrant collection from "${name}"?\n\nThis will REPLACE all vectors in the collection.`)) return;
    try {
      await jsonFetch(`/api/operations/qdrant/restore/${encodeURIComponent(name)}?confirm=true`, { method: 'POST' });
      showToast(`Restored from ${name}`, 'success');
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, 'error');
    }
  }

  async function deleteQdrantBackup(name) {
    if (!confirm(`Delete snapshot "${name}"?\nThis cannot be undone.`)) return;
    try {
      await jsonFetch(`/api/operations/qdrant/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      showToast(`Deleted ${name}`, 'success');
      await loadQdrantBackups();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- Config ----------
  async function loadConfigBackups() {
    const list = $('configBackupsList');
    list.innerHTML = '<tr><td colspan="5" style="padding:16px; text-align:center; color:#888;">Loading…</td></tr>';
    try {
      const { backups = [], root } = await jsonFetch('/api/operations/config/backups');
      $('configRoot').textContent = root || '—';
      $('configStatus').textContent = `${backups.length} backup${backups.length === 1 ? '' : 's'}`;
      if (!backups.length) {
        list.innerHTML = '<tr><td colspan="5" style="padding:16px; text-align:center; color:#888;">No config backups yet.</td></tr>';
        return;
      }
      list.innerHTML = backups.map((b) => `
        <tr style="border-bottom:1px solid var(--border, #2a3145);">
          <td style="padding:8px 4px;"><code>${escape(b.name)}</code></td>
          <td style="padding:8px 4px;">${formatDate(b.date)}</td>
          <td style="padding:8px 4px; text-align:right;">${formatBytes(b.size)}</td>
          <td style="padding:8px 4px;">${locationCell(b.path)}</td>
          <td style="padding:8px 4px; text-align:right;">
            <button class="btn btn-sm" data-action="delete-config" data-name="${escape(b.name)}" style="padding:4px 10px; background:#dc3545; color:#fff;">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      list.innerHTML = `<tr><td colspan="5" style="padding:16px; text-align:center; color:#dc3545;">Failed to load: ${escape(err.message)}</td></tr>`;
    }
  }

  async function createConfigBackup() {
    const btn = $('configBackupBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running…';
    try {
      const { backup } = await jsonFetch('/api/operations/config/backup', { method: 'POST' });
      const includes = (backup.includes || []).join(', ');
      showToast(`Config backup created: ${backup.name} (${includes})`, 'success');
      await loadConfigBackups();
    } catch (err) {
      showToast(`Config backup failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plus"></i> Create backup';
    }
  }

  async function deleteConfigBackup(name) {
    if (!confirm(`Delete config backup "${name}"?\nThis cannot be undone.`)) return;
    try {
      await jsonFetch(`/api/operations/config/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      showToast(`Deleted ${name}`, 'success');
      await loadConfigBackups();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- Settings ----------
  function maskUri(uri) {
    if (!uri) return '—';
    // Hide credentials if present in URI (user:pass@host)
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
  }

  async function loadConfig() {
    try {
      const { config } = await jsonFetch('/api/operations/backup/config');
      $('cfgBackupDir').textContent = config.backupDir;
      $('cfgBackupDirSrc').textContent = `from ${config.backupDirSource}`;
      $('cfgQdrantDir').textContent = config.qdrantLocalDir;
      $('cfgRetentionDays').value = config.retentionDays;
      $('cfgRetentionSrc').textContent = `from ${config.retentionDaysSource}`;
      $('cfgMongoUri').textContent = maskUri(config.mongoUri);
      $('cfgRagUrl').textContent = config.ragUrl;
    } catch (err) {
      showToast(`Failed to load settings: ${err.message}`, 'error');
    }
  }

  async function saveConfig() {
    const btn = $('cfgSaveBtn');
    const retentionDays = Number($('cfgRetentionDays').value);
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      showToast('Retention must be a non-negative integer', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await jsonFetch('/api/operations/backup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays })
      });
      showToast('Settings saved', 'success');
      await loadConfig();
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  // ---------- bootstrap ----------
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    if (!action) return;
    const name = action.getAttribute('data-name');
    switch (action.getAttribute('data-action')) {
      case 'restore-mongo': return restoreMongoBackup(name);
      case 'delete-mongo': return deleteMongoBackup(name);
      case 'restore-qdrant': return restoreQdrantBackup(name);
      case 'delete-qdrant': return deleteQdrantBackup(name);
      case 'delete-config': return deleteConfigBackup(name);
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    $('mongoBackupBtn').addEventListener('click', createMongoBackup);
    $('mongoRefreshBtn').addEventListener('click', loadMongoBackups);
    $('qdrantBackupBtn').addEventListener('click', createQdrantBackup);
    $('qdrantRefreshBtn').addEventListener('click', loadQdrantBackups);
    $('configBackupBtn').addEventListener('click', createConfigBackup);
    $('configRefreshBtn').addEventListener('click', loadConfigBackups);
    $('cfgSaveBtn').addEventListener('click', saveConfig);
    loadConfig();
    loadMongoBackups();
    loadQdrantBackups();
    loadConfigBackups();
  });
})();

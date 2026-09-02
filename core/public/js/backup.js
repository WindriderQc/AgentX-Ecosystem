(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 25;
  const inventories = {
    mongo: { items: [], page: 1 },
    qdrant: { items: [], page: 1 },
    config: { items: [], page: 1 }
  };
  let confirmationResolve = null;

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
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-US');
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return 'unknown';
    if (value === 0) return 'immediately';
    const minutes = value / 60000;
    if (minutes < 60) return `${Math.round(minutes * 10) / 10} min`;
    const hours = minutes / 60;
    if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
    return `${Math.round((hours / 24) * 10) / 10} d`;
  }

  function renderInventoryEvidence(id, evidence) {
    const el = $(id);
    const inventory = evidence?.inventory;
    if (!el) return;
    if (!inventory) {
      el.textContent = 'Inventory evidence unavailable; the displayed count is not independently scoped.';
      el.style.color = '#f59e0b';
      return;
    }
    const size = inventory.knownSizeCount
      ? `${formatBytes(inventory.totalKnownBytes)} across ${inventory.knownSizeCount} sized record${inventory.knownSizeCount === 1 ? '' : 's'}`
      : 'artifact sizes unavailable from this source';
    const range = inventory.oldestAt
      ? `${formatDate(inventory.oldestAt)} to ${formatDate(inventory.newestAt)}`
      : 'no dated records';
    el.textContent = `${inventory.count} recognized record${inventory.count === 1 ? '' : 's'} · ${size} · ${range} · complete all-time inventory, paginated locally · observed ${formatDate(inventory.observedAt)}`;
    el.title = `${inventory.source}. ${inventory.scope}. ${inventory.countBasis}.`;
  }

  function renderPolicyEvidence(config) {
    const policy = config?.policyEvidence;
    if (!policy) {
      $('cfgScheduleStatus').textContent = 'Policy evidence unavailable';
      $('cfgGrowthRisk').textContent = 'Unknown — cadence and retention could not be reconciled';
      $('cfgPolicyPanel').style.borderColor = '#f59e0b';
      return;
    }
    const schedule = policy.schedule;
    const retention = policy.retention;
    const risk = policy.growthRisk;
    const source = schedule.enabledSource === 'unknown' ? '' : `, ${schedule.enabledSource}`;

    $('cfgScheduleStatus').textContent = schedule.enabled
      ? `Enabled${source} · normal cycle every ${formatDuration(schedule.normalEveryMs)} · 3 logical operations/cycle (${schedule.normalCyclesPerDay}/day at normal cadence)`
      : `Disabled${source} · only explicit manual backup requests create artifacts`;
    const reasonLabels = {
      startup: 'startup run',
      normal: 'normal cadence',
      retry: 'retry of the failed layer(s) only',
      'retry-exhausted': 'normal cadence (retry budget exhausted)',
      'non-retryable-failure': 'normal cadence (last failure is not retryable — operator action required)'
    };
    const nextRun = schedule.nextRunAt
      ? ` · next run ${formatDate(schedule.nextRunAt)}${schedule.nextRunReason && reasonLabels[schedule.nextRunReason] ? ` (${reasonLabels[schedule.nextRunReason]})` : ''}`
      : '';
    const retryBudget = Number.isFinite(Number(schedule.maxRetries))
      ? `, max ${schedule.maxRetries} consecutive`
      : '';
    const lastFailures = Array.isArray(schedule.lastFailures) ? schedule.lastFailures : [];
    const failureSummary = lastFailures.length
      ? ` · last cycle ${schedule.lastStatus}: ${lastFailures.map(entry => `${entry.name} — ${entry.error}${entry.retryable === false ? ' (not retryable)' : ''}`).join('; ')}`
      : '';
    $('cfgScheduleDetail').textContent = schedule.enabled
      ? `After partial/failed cycles only: retry the failed layer(s) every ${formatDuration(schedule.failureRetryEveryMs)}${retryBudget}${nextRun}${failureSummary}`
      : `Inactive while scheduler is disabled (configured retry: ${formatDuration(schedule.failureRetryEveryMs)})`;
    $('cfgRetentionPolicy').textContent = retention.mode === 'unbounded'
      ? `Forever (${retention.source}) · automatic pruning disabled`
      : `${retention.days} days (${retention.source}) · pruning after each successful backup operation`;
    $('cfgGrowthRisk').textContent = `${String(risk.level || 'unknown').toUpperCase()} · ${(risk.reasons || []).join(' ')}`;
    $('cfgPolicyWarnings').textContent = (risk.warnings || []).join(' ');

    const colors = { high: '#dc3545', watch: '#f59e0b', low: '#22c55e' };
    const color = colors[risk.level] || '#94a3b8';
    $('cfgGrowthRisk').style.color = color;
    $('cfgPolicyPanel').style.borderColor = color;
  }

  async function jsonFetch(url, opts = {}) {
    const resp = await fetch(url, opts);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.message || body.error || `HTTP ${resp.status}`);
    return body;
  }

  function rowFor(kind, item) {
    if (kind === 'mongo') return `
      <tr style="border-bottom:1px solid var(--border, #2a3145);">
        <td style="padding:8px 4px;"><code>${escape(item.name)}</code></td>
        <td style="padding:8px 4px;">${formatDate(item.date)}</td>
        <td style="padding:8px 4px; text-align:right;">${formatBytes(item.size)}</td>
        <td style="padding:8px 4px; text-align:right;">
          <button class="btn btn-sm" type="button" disabled title="Restore requires a controlled offline rehearsal" style="padding:4px 10px; margin-right:4px;">Restore unavailable</button>
          <button class="btn btn-sm" data-action="delete-mongo" data-name="${escape(item.name)}" style="padding:4px 10px; background:#dc3545; color:#fff;">Delete</button>
        </td>
      </tr>`;
    if (kind === 'qdrant') {
      return `
        <tr style="border-bottom:1px solid var(--border, #2a3145);">
          <td style="padding:8px 4px;"><code>${escape(item.name)}</code></td>
          <td style="padding:8px 4px;">${formatDate(item.creation_time)}</td>
          <td style="padding:8px 4px; text-align:right;">${formatBytes(item.size)}</td>
          <td style="padding:8px 4px; text-align:right;">
            <button class="btn btn-sm" type="button" disabled title="Restore requires a controlled offline rehearsal" style="padding:4px 10px; margin-right:4px;">Restore unavailable</button>
            <button class="btn btn-sm" data-action="delete-qdrant" data-name="${escape(item.name)}" style="padding:4px 10px; background:#dc3545; color:#fff;">Delete</button>
          </td>
        </tr>`;
    }
    return `
      <tr style="border-bottom:1px solid var(--border, #2a3145);">
        <td style="padding:8px 4px;"><code>${escape(item.name)}</code></td>
        <td style="padding:8px 4px;">${formatDate(item.date)}</td>
        <td style="padding:8px 4px; text-align:right;">${formatBytes(item.size)}</td>
        <td style="padding:8px 4px; text-align:right;">
          <button class="btn btn-sm" data-action="delete-config" data-name="${escape(item.name)}" style="padding:4px 10px; background:#dc3545; color:#fff;">Delete</button>
        </td>
      </tr>`;
  }

  function renderInventoryPage(kind) {
    const state = inventories[kind];
    const list = $(`${kind}BackupsList`);
    const pager = $(`${kind}Pager`);
    const empty = kind === 'qdrant' ? 'No snapshots yet.' : kind === 'config' ? 'No config backups yet.' : 'No backups yet.';
    const pageCount = Math.max(1, Math.ceil(state.items.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const start = (state.page - 1) * PAGE_SIZE;
    const visible = state.items.slice(start, start + PAGE_SIZE);

    list.innerHTML = visible.length
      ? visible.map((item) => rowFor(kind, item)).join('')
      : `<tr><td colspan="4" style="padding:16px; text-align:center; color:#888;">${empty}</td></tr>`;

    if (!pager) return;
    const first = state.items.length ? start + 1 : 0;
    const last = Math.min(start + PAGE_SIZE, state.items.length);
    pager.innerHTML = `
      <span>Showing ${first}–${last} of ${state.items.length}</span>
      <span>
        <button class="btn btn-sm" type="button" data-action="page-inventory" data-kind="${kind}" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''} aria-label="Previous ${kind} backup page">Previous</button>
        <span aria-current="page">Page ${state.page} of ${pageCount}</span>
        <button class="btn btn-sm" type="button" data-action="page-inventory" data-kind="${kind}" data-page="${state.page + 1}" ${state.page === pageCount ? 'disabled' : ''} aria-label="Next ${kind} backup page">Next</button>
      </span>`;
  }

  function typedConfirmation(action, name, description) {
    const expected = `${action} ${name}`;
    const dialog = $('backupConfirmDialog');
    if (!dialog?.showModal) {
      return Promise.resolve(window.prompt(`${description}\n\nType ${expected} to continue.`) === expected);
    }
    if (confirmationResolve) confirmationResolve(false);
    $('backupConfirmTitle').textContent = 'Confirm permanent deletion';
    $('backupConfirmDescription').textContent = description;
    $('backupConfirmExpected').textContent = expected;
    $('backupConfirmInput').value = '';
    $('backupConfirmError').textContent = '';
    $('backupConfirmSubmit').disabled = true;
    dialog.showModal();
    setTimeout(() => $('backupConfirmInput').focus(), 0);
    return new Promise((resolve) => { confirmationResolve = resolve; });
  }

  function finishConfirmation(confirmed) {
    const resolve = confirmationResolve;
    confirmationResolve = null;
    if ($('backupConfirmDialog')?.open) $('backupConfirmDialog').close();
    if (resolve) resolve(confirmed);
  }

  function confirmationHeaders(action, name) {
    return { 'X-AgentX-Confirm': `${action} ${name}` };
  }

  // ---------- MongoDB ----------
  async function loadMongoBackups() {
    const list = $('mongoBackupsList');
    list.innerHTML = '<tr><td colspan="4" style="padding:16px; text-align:center; color:#888;">Loading…</td></tr>';
    try {
      const { backups = [], evidence } = await jsonFetch('/api/operations/backups');
      $('mongoStatus').textContent = `${backups.length} backup${backups.length === 1 ? '' : 's'}`;
      renderInventoryEvidence('mongoEvidence', evidence);
      inventories.mongo = { items: backups, page: 1 };
      renderInventoryPage('mongo');
    } catch (err) {
      list.innerHTML = `<tr><td colspan="4" style="padding:16px; text-align:center; color:#dc3545;">Failed to load: ${escape(err.message)}</td></tr>`;
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

  async function deleteMongoBackup(name) {
    if (!await typedConfirmation('DELETE', name, `Delete MongoDB backup “${name}”? This cannot be undone.`)) return;
    try {
      await jsonFetch(`/api/operations/backups/${encodeURIComponent(name)}`, { method: 'DELETE', headers: confirmationHeaders('DELETE', name) });
      showToast(`Deleted ${name}`, 'success');
      await loadMongoBackups();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- Qdrant ----------
  async function loadQdrantBackups() {
    const list = $('qdrantBackupsList');
    list.innerHTML = '<tr><td colspan="4" style="padding:16px; text-align:center; color:#888;">Loading…</td></tr>';
    try {
      const { snapshots = [], evidence } = await jsonFetch('/api/operations/qdrant/backups');
      $('qdrantStatus').textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`;
      renderInventoryEvidence('qdrantEvidence', evidence);
      inventories.qdrant = { items: snapshots, page: 1 };
      renderInventoryPage('qdrant');
    } catch (err) {
      list.innerHTML = `<tr><td colspan="4" style="padding:16px; text-align:center; color:#dc3545;">Failed to load: ${escape(err.message)}</td></tr>`;
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

  async function deleteQdrantBackup(name) {
    if (!await typedConfirmation('DELETE', name, `Delete Qdrant snapshot “${name}”? This cannot be undone.`)) return;
    try {
      await jsonFetch(`/api/operations/qdrant/backups/${encodeURIComponent(name)}`, { method: 'DELETE', headers: confirmationHeaders('DELETE', name) });
      showToast(`Deleted ${name}`, 'success');
      await loadQdrantBackups();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- Config ----------
  async function loadConfigBackups() {
    const list = $('configBackupsList');
    list.innerHTML = '<tr><td colspan="4" style="padding:16px; text-align:center; color:#888;">Loading…</td></tr>';
    try {
      const { backups = [], evidence } = await jsonFetch('/api/operations/config/backups');
      $('configStatus').textContent = `${backups.length} backup${backups.length === 1 ? '' : 's'}`;
      renderInventoryEvidence('configEvidence', evidence);
      inventories.config = { items: backups, page: 1 };
      renderInventoryPage('config');
    } catch (err) {
      list.innerHTML = `<tr><td colspan="4" style="padding:16px; text-align:center; color:#dc3545;">Failed to load: ${escape(err.message)}</td></tr>`;
    }
  }

  async function createConfigBackup() {
    const btn = $('configBackupBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running…';
    try {
      const { backup } = await jsonFetch('/api/operations/config/backup', { method: 'POST' });
      showToast(`Config backup created: ${backup.name} (${backup.sourceCount || 0} supported sources)`, 'success');
      await loadConfigBackups();
    } catch (err) {
      showToast(`Config backup failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plus"></i> Create backup';
    }
  }

  async function deleteConfigBackup(name) {
    if (!await typedConfirmation('DELETE', name, `Delete configuration backup “${name}”? This cannot be undone.`)) return;
    try {
      await jsonFetch(`/api/operations/config/backups/${encodeURIComponent(name)}`, { method: 'DELETE', headers: confirmationHeaders('DELETE', name) });
      showToast(`Deleted ${name}`, 'success');
      await loadConfigBackups();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }

  // ---------- Settings ----------
  async function loadConfig() {
    try {
      const { config } = await jsonFetch('/api/operations/backup/config');
      $('cfgStorage').textContent = 'Persistent recovery storage';
      $('cfgStorageLifecycle').textContent = config.storage?.lifecycle === 'preserved-by-ordinary-down'
        ? 'Preserved by ordinary stop/down'
        : 'Lifecycle unavailable';
      $('cfgStorageExport').textContent = config.storage?.hostLossProtection === 'separate-export-required'
        ? 'Separate export required for host-loss protection'
        : 'Export policy unavailable';
      $('cfgRetentionDays').value = config.retentionDays;
      $('cfgRetentionSrc').textContent = `from ${config.retentionDaysSource}`;
      $('cfgConfigScope').textContent = `${config.configBackup?.sourceCount || 0} supported secret-free product sources`;
      $('cfgRestorePolicy').textContent = config.restorePolicy?.message || 'Restore policy unavailable';
      renderPolicyEvidence(config);
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
      case 'page-inventory':
        inventories[action.dataset.kind].page = Number(action.dataset.page);
        return renderInventoryPage(action.dataset.kind);
      case 'delete-mongo': return deleteMongoBackup(name);
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
    $('backupConfirmInput').addEventListener('input', (event) => {
      const expected = $('backupConfirmExpected').textContent;
      $('backupConfirmSubmit').disabled = event.target.value !== expected;
      $('backupConfirmError').textContent = event.target.value && event.target.value !== expected ? 'Confirmation does not match.' : '';
    });
    $('backupConfirmForm').addEventListener('submit', (event) => {
      event.preventDefault();
      finishConfirmation($('backupConfirmInput').value === $('backupConfirmExpected').textContent);
    });
    $('backupConfirmCancel').addEventListener('click', () => finishConfirmation(false));
    $('backupConfirmDialog').addEventListener('cancel', (event) => { event.preventDefault(); finishConfirmation(false); });
    loadConfig();
    loadMongoBackups();
    loadQdrantBackups();
    loadConfigBackups();
  });
})();

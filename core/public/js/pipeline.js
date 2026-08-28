/* global Toast */
(function () {
  'use strict';

  const STATUS_ORDER = ['queued', 'in_progress', 'review', 'blocked', 'done'];
  const OPEN_ORDER = { blocked: 0, review: 1, in_progress: 2, queued: 3, done: 4 };
  const STALE_HEARTBEAT_MS = 60 * 60 * 1000;
  const AUTO_REFRESH_MS = 60 * 1000;
  const STORAGE_AUTO = 'agentx.pipeline.autoRefresh';
  const STORAGE_REVIEWER = 'agentx.pipeline.reviewer';

  const STATUS_META = {
    queued: { label: 'Queued', icon: 'fa-inbox' },
    in_progress: { label: 'In progress', icon: 'fa-bolt' },
    review: { label: 'Review', icon: 'fa-magnifying-glass' },
    blocked: { label: 'Blocked', icon: 'fa-hand' },
    done: { label: 'Done', icon: 'fa-check' }
  };

  const state = {
    tasks: [],
    loading: false,
    context: readContext(),
    filters: { status: null, search: '', service: '' },
    sort: 'urgency',
    autoTimer: null,
    drawer: { open: false, pipelineId: null, opener: null, task: null }
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function toast(kind, message) {
    if (typeof Toast !== 'undefined' && Toast && typeof Toast[kind] === 'function') {
      Toast[kind](message);
    }
  }

  function readStorage(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
  }

  // ---------------------------------------------------------------------------
  // Agent Ops handoff context (bounded, read-only focus — never pipeline truth)
  // ---------------------------------------------------------------------------

  function boundedParam(params, key, pattern, maxLength = 160) {
    const value = String(params.get(key) || '').trim();
    if (!value || value.length > maxLength || (pattern && !pattern.test(value))) return '';
    return value;
  }

  function readContext() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('from') !== 'agent-ops') return null;
    const status = boundedParam(params, 'status', /^(queued|in_progress|review|blocked|done)$/);
    const task = boundedParam(params, 'task', /^[a-z0-9._-]+$/i, 64);
    const assignee = boundedParam(params, 'assignee', /^[a-z0-9][a-z0-9 ._@-]*$/i, 80);
    const alias = boundedParam(params, 'alias', /^[a-z0-9][a-z0-9 ._@-]*$/i, 80);
    return task || assignee || status ? { task, assignee, alias, status } : null;
  }

  function normalizedIdentity(value) {
    return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  function matchesContext(task) {
    const context = state.context;
    if (!context) return true;
    if (context.task && String(task.pipelineId) !== context.task) return false;
    if (context.assignee) {
      const acceptedOwners = new Set([context.assignee, context.alias].map(normalizedIdentity).filter(Boolean));
      if (!acceptedOwners.has(normalizedIdentity(task.assignee))) return false;
    }
    if (context.status && task.status !== context.status) return false;
    return true;
  }

  function contextDescription() {
    const context = state.context;
    if (!context) return '';
    const parts = [];
    if (context.task) parts.push(`task ${context.task}`);
    if (context.assignee) parts.push(`owner ${context.assignee}${context.alias && normalizedIdentity(context.alias) !== normalizedIdentity(context.assignee) ? ` / ${context.alias}` : ''}`);
    if (context.status) parts.push(`status ${formatStatus(context.status)}`);
    return parts.join(' · ');
  }

  function renderContext() {
    const banner = $('pipelineHandoffContext');
    if (!banner || !state.context) return;
    banner.hidden = false;
    $('pipelineContextTitle').textContent = `Focused from Agent Ops · ${contextDescription()}`;
    $('pipelineContextDetail').textContent = 'Counts remain global; the work table and attention list show only this bounded context.';
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function formatStatus(value) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

  function statusBadge(status) {
    const safeStatus = String(status || 'unknown');
    const meta = STATUS_META[safeStatus] || { label: formatStatus(safeStatus), icon: 'fa-circle-question' };
    return `<span class="pipeline-status pipeline-status-${escapeHtml(safeStatus)}"><i class="fas ${escapeHtml(meta.icon)}" aria-hidden="true"></i>${escapeHtml(meta.label)}</span>`;
  }

  function priorityChip(priority) {
    const value = Number(priority);
    if (!Number.isFinite(value) || value < 1 || value > 5) return '<span class="pipeline-subtle">--</span>';
    return `<span class="pipeline-priority pipeline-priority-${value}" title="Priority ${value} of 5 (1 is most urgent)">P${value}</span>`;
  }

  function riskChip(risk) {
    const value = String(risk || '').toLowerCase();
    if (!['low', 'medium', 'high', 'critical'].includes(value)) return '';
    return `<span class="pipeline-risk pipeline-risk-${value}" title="Declared risk"><i class="fas fa-shield-halved" aria-hidden="true"></i>${escapeHtml(value)}</span>`;
  }

  function formatDate(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString([], {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function relativeTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    const abs = Math.abs(minutes);
    const suffix = minutes >= 0 ? 'ago' : 'from now';
    if (abs < 1) return 'just now';
    if (abs < 60) return `${abs}m ${suffix}`;
    const hours = Math.floor(abs / 60);
    if (hours < 48) return `${hours}h ${suffix}`;
    return `${Math.floor(hours / 24)}d ${suffix}`;
  }

  function dueCell(task) {
    if (task.status === 'done' || !task.dueAt) return '<span class="pipeline-subtle">--</span>';
    const date = new Date(task.dueAt);
    if (Number.isNaN(date.getTime())) return '<span class="pipeline-subtle">--</span>';
    const days = Math.round((date.getTime() - Date.now()) / 86400000);
    const label = date.toLocaleDateString([], { month: 'short', day: '2-digit' });
    if (days < 0) return `<span class="pipeline-due overdue" title="Due ${escapeHtml(label)}"><i class="fas fa-circle-exclamation" aria-hidden="true"></i>${Math.abs(days)}d overdue</span>`;
    if (days === 0) return `<span class="pipeline-due today" title="Due ${escapeHtml(label)}"><i class="fas fa-hourglass-half" aria-hidden="true"></i>today</span>`;
    return `<span class="pipeline-due" title="Due ${escapeHtml(label)}">in ${days}d</span>`;
  }

  function heartbeatText(task) {
    if (task.status !== 'in_progress') return '';
    if (!task.heartbeatAt) return 'No heartbeat';
    const date = new Date(task.heartbeatAt);
    if (Number.isNaN(date.getTime())) return 'Invalid heartbeat';
    return `Heartbeat ${relativeTime(task.heartbeatAt)}`;
  }

  function isStale(task) {
    if (task.status !== 'in_progress') return false;
    if (!task.heartbeatAt) return true;
    const date = new Date(task.heartbeatAt);
    return Number.isNaN(date.getTime()) || Date.now() - date.getTime() > STALE_HEARTBEAT_MS;
  }

  function isOverdue(task) {
    if (task.status === 'done' || !task.dueAt) return false;
    const date = new Date(task.dueAt);
    return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
  }

  function activityCell(task) {
    if (task.status === 'in_progress') {
      const cls = isStale(task) ? 'pipeline-error' : 'pipeline-subtle';
      return `<span class="${cls}">${escapeHtml(heartbeatText(task))}</span>`;
    }
    const rel = relativeTime(task.updatedAt);
    return rel ? `<span class="pipeline-subtle">Updated ${escapeHtml(rel)}</span>` : '<span class="pipeline-subtle">--</span>';
  }

  function unmetDependencies(task, byId) {
    if (!Array.isArray(task.dependsOn) || !task.dependsOn.length) return [];
    return task.dependsOn.filter((dep) => {
      const found = byId.get(String(dep));
      return !found || found.status !== 'done';
    });
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  function normalizePayload(payload) {
    const data = payload && payload.data ? payload.data : payload;
    const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
    return tasks.map((task) => ({
      pipelineId: task.pipelineId || '',
      title: task.title || '',
      service: task.service || '',
      status: task.status || 'queued',
      assignee: task.assignee || '',
      heartbeatAt: task.heartbeatAt || null,
      epic: task.epic || '',
      source: task.source || '',
      priority: task.priority,
      risk: task.risk || '',
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      dueAt: task.dueAt || null,
      createdAt: task.createdAt || null,
      updatedAt: task.updatedAt || task.createdAt || null
    }));
  }

  async function fetchJson(url, options) {
    const init = Object.assign({ headers: { Accept: 'application/json' } }, options || {});
    if (init.body && !init.headers['Content-Type']) {
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return body;
  }

  // ---------------------------------------------------------------------------
  // Global state strip + counts
  // ---------------------------------------------------------------------------

  function setPageState(tone, icon, title, detail) {
    const stateEl = $('pipelineState');
    if (!stateEl) return;
    stateEl.dataset.tone = tone;
    const iconEl = $('pipelineStateIcon');
    if (iconEl) iconEl.className = `fas ${icon}`;
    const titleEl = $('pipelineStateTitle');
    if (titleEl) titleEl.textContent = title;
    const detailEl = $('pipelineStateDetail');
    if (detailEl) detailEl.textContent = detail;
    const updated = $('pipelineStateUpdated');
    if (updated) {
      updated.dateTime = new Date().toISOString();
      updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
  }

  function summarizeState() {
    const counts = countByStatus(state.tasks);
    const stale = state.tasks.filter(isStale).length;
    if (counts.blocked) {
      setPageState('blocked', 'fa-hand', `${counts.blocked} task${counts.blocked === 1 ? '' : 's'} blocked`, 'Blocked work needs an operator or upstream action before it can move.');
    } else if (counts.review || stale) {
      const parts = [];
      if (counts.review) parts.push(`${counts.review} awaiting review`);
      if (stale) parts.push(`${stale} stale heartbeat${stale === 1 ? '' : 's'}`);
      setPageState('attention', 'fa-triangle-exclamation', 'Attention suggested', `${parts.join(' · ')} — see Needs attention for the next step.`);
    } else {
      const open = state.tasks.filter((t) => t.status !== 'done').length;
      setPageState('ready', 'fa-circle-check', open ? 'Pipeline healthy' : 'Queue clear', open
        ? `${open} open task${open === 1 ? '' : 's'} moving without blockers.`
        : 'No open work in the loaded task window.');
    }
  }

  function countByStatus(tasks) {
    const counts = {};
    STATUS_ORDER.forEach((status) => { counts[status] = 0; });
    tasks.forEach((task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
    });
    return counts;
  }

  function renderCounts() {
    const counts = countByStatus(state.tasks);
    const map = {
      queued: 'pipelineCountQueued',
      in_progress: 'pipelineCountProgress',
      review: 'pipelineCountReview',
      blocked: 'pipelineCountBlocked',
      done: 'pipelineCountDone'
    };
    Object.entries(map).forEach(([status, id]) => {
      const el = $(id);
      if (el) el.textContent = String(counts[status] || 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Filters + work table
  // ---------------------------------------------------------------------------

  function matchesFilters(task) {
    const { status, search, service } = state.filters;
    if (status && task.status !== status) return false;
    if (service && task.service !== service) return false;
    if (search) {
      const haystack = [task.pipelineId, task.title, task.assignee, task.epic, task.service]
        .map((v) => String(v || '').toLowerCase()).join(' ');
      if (!haystack.includes(search)) return false;
    }
    return true;
  }

  function urgencyScore(task) {
    let score = (OPEN_ORDER[task.status] ?? 9) * 100;
    if (isOverdue(task)) score -= 55;
    if (isStale(task)) score -= 40;
    const priority = Number(task.priority);
    score += Number.isFinite(priority) ? priority : 3;
    return score;
  }

  function sortTasks(tasks) {
    const byId = (a, b) => String(a.pipelineId).localeCompare(String(b.pipelineId));
    const sorted = tasks.slice();
    if (state.sort === 'priority') {
      sorted.sort((a, b) => (Number(a.priority) || 3) - (Number(b.priority) || 3) || byId(a, b));
    } else if (state.sort === 'recent') {
      sorted.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0) || byId(a, b));
    } else if (state.sort === 'id') {
      sorted.sort(byId);
    } else {
      sorted.sort((a, b) => urgencyScore(a) - urgencyScore(b) || byId(a, b));
    }
    return sorted;
  }

  function hasActiveFilters() {
    return Boolean(state.filters.status || state.filters.search || state.filters.service);
  }

  function renderFilterControls() {
    document.querySelectorAll('.pipeline-metric[data-status-filter]').forEach((btn) => {
      const active = btn.dataset.statusFilter === state.filters.status;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const clear = $('pipelineClearFilters');
    if (clear) clear.hidden = !hasActiveFilters();
  }

  function renderServiceOptions() {
    const select = $('pipelineServiceFilter');
    if (!select) return;
    const current = state.filters.service;
    const services = [...new Set(state.tasks.map((t) => t.service).filter(Boolean))].sort();
    select.innerHTML = ['<option value="">All services</option>']
      .concat(services.map((s) => `<option value="${escapeHtml(s)}"${s === current ? ' selected' : ''}>${escapeHtml(s)}</option>`))
      .join('');
    if (current && !services.includes(current)) {
      state.filters.service = '';
    }
  }

  function visibleTasks() {
    // Without an explicit status filter the table shows open work only; a
    // status filter (including "done") widens or narrows it deliberately.
    return sortTasks(
      state.tasks.filter(matchesContext)
        .filter(matchesFilters)
        .filter((task) => (state.filters.status ? true : task.status !== 'done'))
    );
  }

  function renderOpenWork() {
    const rows = $('pipelineOpenRows');
    const meta = $('pipelineOpenMeta');
    if (!rows) return;

    const tasks = visibleTasks();
    const openTotal = state.tasks.filter((task) => task.status !== 'done').length;

    if (meta) {
      const scope = state.filters.status ? `${formatStatus(state.filters.status)} tasks` : 'open tasks';
      const filtered = hasActiveFilters() || state.context;
      meta.textContent = filtered
        ? `${tasks.length} matching ${scope} · ${openTotal} open overall`
        : `${tasks.length} open task${tasks.length === 1 ? '' : 's'} · ${state.tasks.length} loaded records`;
    }

    if (!tasks.length) {
      const reason = state.context
        ? `No work matches ${escapeHtml(contextDescription())}.`
        : hasActiveFilters()
          ? 'No tasks match the current filters.'
          : 'No open pipeline work in the loaded task window.';
      const action = hasActiveFilters()
        ? '<button type="button" class="pipeline-btn compact" data-clear-filters><i class="fas fa-filter-circle-xmark"></i><span>Clear filters</span></button>'
        : '';
      rows.innerHTML = `<tr><td colspan="8" class="pipeline-empty">${reason} ${action}</td></tr>`;
      return;
    }

    const byId = new Map(state.tasks.map((t) => [String(t.pipelineId), t]));
    rows.innerHTML = tasks.map((task) => {
      const deps = unmetDependencies(task, byId);
      const depsChip = deps.length && task.status !== 'done'
        ? `<span class="pipeline-deps" title="Waiting on ${escapeHtml(deps.join(', '))}"><i class="fas fa-link" aria-hidden="true"></i>waits on ${escapeHtml(deps.slice(0, 3).join(', '))}${deps.length > 3 ? '…' : ''}</span>`
        : '';
      return `
        <tr class="${state.context ? 'pipeline-row-context' : ''}" data-pipeline-task="${escapeHtml(task.pipelineId)}" tabindex="0"
            aria-label="Open task ${escapeHtml(task.pipelineId)} details">
          <td class="pipeline-id">${escapeHtml(task.pipelineId)}</td>
          <td>
            <div class="pipeline-title">${escapeHtml(task.title || 'Untitled task')}</div>
            <div class="pipeline-title-meta">
              ${task.epic ? `<span class="pipeline-subtle">${escapeHtml(task.epic)}</span>` : ''}
              ${riskChip(task.risk)}
              ${depsChip}
            </div>
          </td>
          <td>${priorityChip(task.priority)}</td>
          <td>${statusBadge(task.status)}</td>
          <td>${escapeHtml(task.assignee || 'unassigned')}</td>
          <td>${escapeHtml(task.service || '--')}</td>
          <td>${dueCell(task)}</td>
          <td>${activityCell(task)}</td>
        </tr>
      `;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Attention + recently done
  // ---------------------------------------------------------------------------

  function attentionItems() {
    const items = [];
    state.tasks.filter(matchesContext).forEach((task) => {
      if (task.status === 'blocked') {
        items.push({
          rank: 0,
          icon: 'fa-hand',
          tone: 'blocked',
          pipelineId: task.pipelineId,
          title: `${task.pipelineId} blocked`,
          detail: task.title || 'Blocked task needs attention.',
          action: 'Open the dossier for the blocking feedback.'
        });
      } else if (task.status === 'review') {
        items.push({
          rank: 1,
          icon: 'fa-magnifying-glass',
          tone: 'review',
          pipelineId: task.pipelineId,
          title: `${task.pipelineId} ready for review`,
          detail: task.title || 'Worker feedback is waiting for overseer review.',
          action: 'Confirm it done from the dossier — a different identity than the worker.'
        });
      } else if (task.status === 'in_progress' && !task.assignee) {
        items.push({
          rank: 2,
          icon: 'fa-user-slash',
          tone: 'attention',
          pipelineId: task.pipelineId,
          title: `${task.pipelineId} in progress without owner`,
          detail: task.title || 'Task state is in progress but has no assignee.',
          action: 'Re-queue it so a worker can claim it cleanly.'
        });
      } else if (isStale(task)) {
        items.push({
          rank: 3,
          icon: 'fa-heart-crack',
          tone: 'attention',
          pipelineId: task.pipelineId,
          title: `${task.pipelineId} stale heartbeat`,
          detail: `${heartbeatText(task)} — ${task.title || 'claimed task'}`,
          action: 'Check the worker, or re-queue to release the claim.'
        });
      } else if (isOverdue(task)) {
        items.push({
          rank: 4,
          icon: 'fa-hourglass-end',
          tone: 'attention',
          pipelineId: task.pipelineId,
          title: `${task.pipelineId} past due`,
          detail: task.title || 'Open task is past its due date.',
          action: 'Reprioritize or move the due date deliberately.'
        });
      }
    });
    return items.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).slice(0, 10);
  }

  function renderAttention() {
    const list = $('pipelineAttentionList');
    const meta = $('pipelineAttentionMeta');
    if (!list) return;
    const items = attentionItems();
    if (meta) meta.textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'} surfaced` : 'Nothing blocked, waiting, or stale';
    if (!items.length) {
      list.innerHTML = '<div class="pipeline-empty"><i class="fas fa-circle-check" aria-hidden="true"></i> All clear — no blocked, review, stale, or overdue work.</div>';
      return;
    }
    list.innerHTML = items.map((item) => `
      <button type="button" class="pipeline-attention-item tone-${escapeHtml(item.tone)}" data-pipeline-task="${escapeHtml(item.pipelineId)}">
        <i class="fas ${escapeHtml(item.icon)}" aria-hidden="true"></i>
        <span class="pipeline-attention-copy">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.detail)}</span>
          <em>${escapeHtml(item.action)}</em>
        </span>
        <i class="fas fa-arrow-right pipeline-attention-arrow" aria-hidden="true"></i>
      </button>
    `).join('');
  }

  function renderRecentlyDone() {
    const list = $('pipelineDoneList');
    const meta = $('pipelineDoneMeta');
    if (!list) return;
    const done = state.tasks
      .filter((task) => task.status === 'done')
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 8);
    if (meta) meta.textContent = done.length ? `Latest ${done.length} closed record${done.length === 1 ? '' : 's'}` : 'No closed tasks loaded';
    if (!done.length) {
      list.innerHTML = '<div class="pipeline-empty">No closed tasks in the loaded window yet.</div>';
      return;
    }
    list.innerHTML = done.map((task) => `
      <button type="button" class="pipeline-done-item" data-pipeline-task="${escapeHtml(task.pipelineId)}">
        <i class="fas fa-check" aria-hidden="true"></i>
        <span class="pipeline-done-copy">
          <strong>${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title || 'Untitled task')}</strong>
          <span>${escapeHtml([task.service, relativeTime(task.updatedAt) ? `closed ${relativeTime(task.updatedAt)}` : ''].filter(Boolean).join(' · ') || '--')}</span>
        </span>
      </button>
    `).join('');
  }

  // ---------------------------------------------------------------------------
  // Task dossier drawer
  // ---------------------------------------------------------------------------

  function drawerEls() {
    return {
      shell: $('pipelineDrawerShell'),
      title: $('pipelineDrawerTitle'),
      id: $('pipelineDrawerId'),
      body: $('pipelineDrawerBody')
    };
  }

  function closeDrawer() {
    const { shell } = drawerEls();
    if (!shell || shell.hidden) return;
    shell.hidden = true;
    document.body.classList.remove('pipeline-drawer-open');
    const opener = state.drawer.opener;
    state.drawer = { open: false, pipelineId: null, opener: null, task: null };
    if (opener && typeof opener.focus === 'function') opener.focus();
  }

  async function openDrawer(pipelineId, opener) {
    const { shell, title, id, body } = drawerEls();
    if (!shell || !body) return;
    state.drawer = { open: true, pipelineId, opener: opener || document.activeElement, task: null };
    shell.hidden = false;
    document.body.classList.add('pipeline-drawer-open');
    if (title) title.textContent = 'Loading task…';
    if (id) id.textContent = pipelineId;
    body.innerHTML = '<div class="pipeline-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading the full task record…</div>';
    const closeBtn = shell.querySelector('.pipeline-drawer-close');
    if (closeBtn) closeBtn.focus();
    try {
      const payload = await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      const task = payload && payload.data ? payload.data.task : null;
      if (!task || state.drawer.pipelineId !== pipelineId) return;
      state.drawer.task = task;
      renderDrawer(task);
    } catch (error) {
      body.innerHTML = `<div class="pipeline-error"><i class="fas fa-circle-exclamation" aria-hidden="true"></i> ${escapeHtml(error.message || error)}</div>`;
    }
  }

  function metaRow(label, value) {
    return `<div class="pipeline-drawer-meta-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  function renderDrawer(task) {
    const { title, id, body } = drawerEls();
    if (title) title.textContent = task.title || 'Untitled task';
    if (id) id.textContent = `#${task.pipelineId}`;
    if (!body) return;

    const feedback = Array.isArray(task.feedback) ? task.feedback.slice().reverse() : [];
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const reviewer = readStorage(STORAGE_REVIEWER) || '';

    const actions = [];
    if (task.status === 'review') {
      actions.push(`
        <form class="pipeline-drawer-action" data-drawer-action="confirm-done">
          <label>
            <span>Confirm done as (must differ from worker <code>${escapeHtml(task.assignee || 'unassigned')}</code>)</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. yanik" value="${escapeHtml(reviewer)}">
          </label>
          <button type="submit" class="pipeline-btn primary compact"><i class="fas fa-check-double"></i><span>Confirm done</span></button>
        </form>
      `);
    }
    if (['in_progress', 'blocked', 'review'].includes(task.status)) {
      actions.push(`
        <div class="pipeline-drawer-action">
          <p>Release the task back to the queue. The worker claim and heartbeat are cleared.</p>
          <button type="button" class="pipeline-btn compact" data-drawer-action="requeue"><i class="fas fa-rotate-left"></i><span>Re-queue task</span></button>
        </div>
      `);
    }
    if (task.status !== 'done') {
      actions.push(`
        <form class="pipeline-drawer-action" data-drawer-action="add-note">
          <label>
            <span>Add a note to the audit trail</span>
            <textarea name="text" rows="2" maxlength="5000" required placeholder="What should workers and overseers know?"></textarea>
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-pen"></i><span>Add note</span></button>
        </form>
      `);
    }

    body.innerHTML = `
      <div class="pipeline-drawer-status">${statusBadge(task.status)} ${priorityChip(task.priority)} ${riskChip(task.risk)}</div>
      <dl class="pipeline-drawer-meta">
        ${metaRow('Owner', escapeHtml(task.assignee || 'unassigned'))}
        ${metaRow('Service', escapeHtml(task.service || '--'))}
        ${task.epic ? metaRow('Epic', escapeHtml(task.epic)) : ''}
        ${metaRow('Source', escapeHtml(task.source || '--'))}
        ${deps.length ? metaRow('Depends on', deps.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')) : ''}
        ${task.dueAt ? metaRow('Due', escapeHtml(formatDate(task.dueAt))) : ''}
        ${task.notBefore ? metaRow('Not before', escapeHtml(formatDate(task.notBefore))) : ''}
        ${task.heartbeatAt ? metaRow('Heartbeat', escapeHtml(`${formatDate(task.heartbeatAt)} (${relativeTime(task.heartbeatAt)})`)) : ''}
        ${metaRow('Created', escapeHtml(formatDate(task.createdAt)))}
        ${metaRow('Updated', escapeHtml(`${formatDate(task.updatedAt)}${relativeTime(task.updatedAt) ? ` (${relativeTime(task.updatedAt)})` : ''}`))}
      </dl>
      ${actions.length ? `<section class="pipeline-drawer-section"><h3><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Actions</h3>${actions.join('')}</section>` : ''}
      ${task.spec ? `
        <section class="pipeline-drawer-section">
          <h3><i class="fas fa-file-lines" aria-hidden="true"></i> Specification</h3>
          <pre class="pipeline-drawer-spec">${escapeHtml(task.spec)}</pre>
        </section>` : ''}
      <section class="pipeline-drawer-section">
        <h3><i class="fas fa-timeline" aria-hidden="true"></i> Audit trail <span class="pipeline-drawer-count">${feedback.length}</span></h3>
        ${feedback.length ? `
          <ol class="pipeline-drawer-feedback">
            ${feedback.map((entry) => `
              <li>
                <header><strong>${escapeHtml(entry.by || 'agent')}</strong><time>${escapeHtml(formatDate(entry.at))}</time></header>
                <p>${escapeHtml(entry.text || '')}</p>
              </li>
            `).join('')}
          </ol>` : '<div class="pipeline-empty">No feedback recorded yet.</div>'}
      </section>
    `;
  }

  async function refreshDrawerTask() {
    const pipelineId = state.drawer.pipelineId;
    if (!pipelineId) return;
    try {
      const payload = await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      const task = payload && payload.data ? payload.data.task : null;
      if (task && state.drawer.pipelineId === pipelineId) {
        state.drawer.task = task;
        renderDrawer(task);
      }
    } catch { /* the list refresh below still reflects truth */ }
  }

  async function handleDrawerAction(action, form) {
    const pipelineId = state.drawer.pipelineId;
    if (!pipelineId) return;
    try {
      if (action === 'confirm-done') {
        const by = String(new FormData(form).get('by') || '').trim();
        if (!by) return;
        writeStorage(STORAGE_REVIEWER, by);
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'done', by })
        });
        toast('success', `Task ${pipelineId} confirmed done by ${by}.`);
      } else if (action === 'requeue') {
        const ok = window.confirm(`Release task ${pipelineId} back to the queue? Its worker claim and heartbeat will be cleared.`);
        if (!ok) return;
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'queued' })
        });
        toast('success', `Task ${pipelineId} released back to the queue.`);
      } else if (action === 'add-note') {
        const text = String(new FormData(form).get('text') || '').trim();
        if (!text) return;
        const by = readStorage(STORAGE_REVIEWER) || 'pipeline-ui';
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/feedback`, {
          method: 'POST',
          body: JSON.stringify({ text, by })
        });
        toast('success', `Note added to task ${pipelineId}.`);
      }
      await refreshDrawerTask();
      await loadTasks({ silent: true });
    } catch (error) {
      toast('error', error.message || String(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Loading + auto refresh
  // ---------------------------------------------------------------------------

  function setLoading(loading) {
    state.loading = loading;
    const btn = $('pipelineRefreshBtn');
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<i class="fas fa-spinner fa-spin"></i><span>Loading</span>'
      : '<i class="fas fa-rotate"></i><span>Refresh</span>';
  }

  function renderError(error) {
    setPageState('blocked', 'fa-circle-exclamation', 'Pipeline unreachable', String(error.message || error));
    const rows = $('pipelineOpenRows');
    if (rows) {
      rows.innerHTML = `<tr><td colspan="8" class="pipeline-error">${escapeHtml(error.message || error)} <button type="button" class="pipeline-btn compact" data-retry-load><i class="fas fa-rotate"></i><span>Retry</span></button></td></tr>`;
    }
    const list = $('pipelineAttentionList');
    if (list) {
      list.innerHTML = `<div class="pipeline-error">${escapeHtml(error.message || error)}</div>`;
    }
    const done = $('pipelineDoneList');
    if (done) {
      done.innerHTML = `<div class="pipeline-error">${escapeHtml(error.message || error)}</div>`;
    }
  }

  function renderAll() {
    renderContext();
    renderCounts();
    summarizeState();
    renderFilterControls();
    renderServiceOptions();
    renderOpenWork();
    renderAttention();
    renderRecentlyDone();
  }

  async function loadTasks(options) {
    const silent = options && options.silent;
    if (!silent) setLoading(true);
    try {
      const payload = await fetchJson('/api/pipeline/tasks?limit=1000&view=summary&includeDone=true');
      state.tasks = normalizePayload(payload);
      renderAll();
    } catch (error) {
      renderError(error);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  function setAutoRefresh(enabled) {
    const btn = $('pipelineAutoBtn');
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    if (enabled) {
      state.autoTimer = window.setInterval(() => loadTasks({ silent: true }), AUTO_REFRESH_MS);
    }
    if (btn) {
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.classList.toggle('active', enabled);
    }
    writeStorage(STORAGE_AUTO, enabled ? '1' : '0');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function clearFilters() {
    state.filters = { status: null, search: '', service: '' };
    const search = $('pipelineSearch');
    if (search) search.value = '';
    const service = $('pipelineServiceFilter');
    if (service) service.value = '';
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const refresh = $('pipelineRefreshBtn');
    if (refresh) refresh.addEventListener('click', () => loadTasks());

    const autoBtn = $('pipelineAutoBtn');
    if (autoBtn) {
      autoBtn.addEventListener('click', () => {
        setAutoRefresh(autoBtn.getAttribute('aria-pressed') !== 'true');
      });
    }

    document.querySelectorAll('.pipeline-metric[data-status-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.statusFilter;
        state.filters.status = state.filters.status === status ? null : status;
        renderAll();
      });
    });

    const search = $('pipelineSearch');
    if (search) {
      search.addEventListener('input', () => {
        state.filters.search = search.value.trim().toLowerCase();
        renderAll();
      });
    }

    const service = $('pipelineServiceFilter');
    if (service) {
      service.addEventListener('change', () => {
        state.filters.service = service.value;
        renderAll();
      });
    }

    const sort = $('pipelineSort');
    if (sort) {
      sort.addEventListener('change', () => {
        state.sort = sort.value;
        renderAll();
      });
    }

    const clear = $('pipelineClearFilters');
    if (clear) clear.addEventListener('click', clearFilters);

    document.addEventListener('click', (event) => {
      const retry = event.target.closest('[data-retry-load]');
      if (retry) { loadTasks(); return; }
      const clearBtn = event.target.closest('[data-clear-filters]');
      if (clearBtn) { clearFilters(); return; }
      const closer = event.target.closest('[data-close-pipeline-drawer]');
      if (closer) { closeDrawer(); return; }
      const requeue = event.target.closest('button[data-drawer-action="requeue"]');
      if (requeue) { handleDrawerAction('requeue', null); return; }
      const taskEl = event.target.closest('[data-pipeline-task]');
      if (taskEl) openDrawer(taskEl.dataset.pipelineTask, taskEl);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.drawer.open) {
        closeDrawer();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const row = event.target.closest && event.target.closest('tr[data-pipeline-task]');
        if (row) {
          event.preventDefault();
          openDrawer(row.dataset.pipelineTask, row);
        }
      }
    });

    document.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-drawer-action]');
      if (!form) return;
      event.preventDefault();
      handleDrawerAction(form.dataset.drawerAction, form);
    });

    if (readStorage(STORAGE_AUTO) === '1') setAutoRefresh(true);
    loadTasks();
  });
})();

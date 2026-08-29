(function () {
  'use strict';

  const STATUS_ORDER = ['queued', 'in_progress', 'review', 'blocked', 'done'];
  const OPEN_ORDER = { blocked: 0, review: 1, in_progress: 2, queued: 3, done: 4 };
  const STALE_HEARTBEAT_MS = 60 * 60 * 1000;

  const state = {
    tasks: [],
    summary: null,
    evidence: null,
    loading: false,
    filters: { service: 'all', lane: 'all', status: 'all' },
    context: readContext()
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

  function formatStatus(value) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

  function statusBadge(status) {
    const safeStatus = String(status || 'unknown');
    return `<span class="pipeline-status pipeline-status-${escapeHtml(safeStatus)}">${escapeHtml(formatStatus(safeStatus))}</span>`;
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

  function heartbeatText(task) {
    if (task.status !== 'in_progress') return '--';
    if (!task.heartbeatAt) return 'Missing';
    const date = new Date(task.heartbeatAt);
    if (Number.isNaN(date.getTime())) return 'Invalid';
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m ago` : `${hours}h ago`;
  }

  function isStale(task) {
    if (task.status !== 'in_progress') return false;
    if (!task.heartbeatAt) return true;
    const date = new Date(task.heartbeatAt);
    return Number.isNaN(date.getTime()) || Date.now() - date.getTime() > STALE_HEARTBEAT_MS;
  }

  function normalizePayload(payload) {
    const data = payload && payload.data ? payload.data : payload;
    const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
    return {
      tasks: tasks.map((task) => ({
        pipelineId: task.pipelineId || '',
        title: task.title || '',
        service: task.service || '',
        status: task.status || 'queued',
        assignee: task.assignee || '',
        heartbeatAt: task.heartbeatAt || null,
        epic: task.epic || '',
        source: task.source || '',
        updatedAt: task.updatedAt || task.createdAt || null
      })),
      summary: data?.summary || null,
      evidence: data?.evidence || null
    };
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return body;
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
    const counts = state.summary?.byStatus || countByStatus(state.tasks);
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

  function matchesFilters(task) {
    return (state.filters.service === 'all' || task.service === state.filters.service)
      && (state.filters.lane === 'all' || (task.source || 'unspecified') === state.filters.lane)
      && (state.filters.status === 'all' || task.status === state.filters.status);
  }

  function optionLabel(value) {
    return String(value || 'unspecified').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function populateFilter(id, values, current, allLabel) {
    const select = $(id);
    if (!select) return 'all';
    const available = [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const selected = current === 'all' || available.includes(current) ? current : 'all';
    select.innerHTML = `<option value="all">${escapeHtml(allLabel)}</option>${available.map((value) => (
      `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(optionLabel(value))}</option>`
    )).join('')}`;
    return selected;
  }

  function renderFilters() {
    const open = state.tasks.filter((task) => task.status !== 'done');
    state.filters.service = populateFilter(
      'pipelineServiceFilter', open.map((task) => task.service || 'unspecified'), state.filters.service, 'All services'
    );
    state.filters.lane = populateFilter(
      'pipelineLaneFilter', open.map((task) => task.source || 'unspecified'), state.filters.lane, 'All lanes'
    );
    const status = $('pipelineStatusFilter');
    if (status) status.value = state.filters.status;
  }

  function renderEvidence() {
    const el = $('pipelineCountEvidence');
    if (!el) return;
    const evidence = state.evidence;
    const summary = state.summary;
    if (!evidence || !summary) {
      el.textContent = 'Count evidence unavailable; cards reflect only the rows loaded in this browser.';
      el.classList.add('pipeline-evidence-warning');
      return;
    }
    const statusScope = evidence.scope?.includesDone ? 'all statuses, including done' : 'open statuses only';
    const returned = Number(evidence.rows?.returnedCount) || 0;
    const matched = Number(evidence.rows?.matchedCount) || 0;
    const rowWindow = evidence.rows?.truncated
      ? `rows show ${returned} of ${matched}`
      : `rows show all ${returned} matched records`;
    const observed = formatDate(evidence.observedAt);
    el.textContent = `MongoDB task authority · exact full-scope totals (${statusScope}) · all-time, no date filter · ${rowWindow} · sampled ${observed}`;
    el.classList.remove('pipeline-evidence-warning');
  }

  function renderOpenWork() {
    const rows = $('pipelineOpenRows');
    const meta = $('pipelineOpenMeta');
    if (!rows) return;

    const allOpenTasks = state.tasks.filter((task) => task.status !== 'done');
    const openTasks = allOpenTasks
      .filter(matchesContext)
      .filter(matchesFilters)
      .sort((a, b) => {
        const statusDiff = (OPEN_ORDER[a.status] ?? 99) - (OPEN_ORDER[b.status] ?? 99);
        if (statusDiff) return statusDiff;
        return String(a.pipelineId).localeCompare(String(b.pipelineId));
      });

    if (meta) {
      const exactOpen = Number.isFinite(Number(state.summary?.openCount))
        ? Number(state.summary.openCount)
        : allOpenTasks.length;
      const matched = Number.isFinite(Number(state.summary?.matchedCount))
        ? Number(state.summary.matchedCount)
        : state.tasks.length;
      meta.textContent = state.context
        ? `${openTasks.length} matching loaded open task${openTasks.length === 1 ? '' : 's'} · ${exactOpen} open overall in the API scope`
        : Object.values(state.filters).some((value) => value !== 'all')
          ? `Showing ${openTasks.length} of ${allOpenTasks.length} loaded open tasks · ${exactOpen} open overall in the API scope`
          : `${exactOpen} open task${exactOpen === 1 ? '' : 's'} across ${matched} all-time records`;
    }

    if (!openTasks.length) {
      rows.innerHTML = `<tr><td colspan="6" class="pipeline-empty">${state.context ? `No open work matches ${escapeHtml(contextDescription())}.` : 'No open pipeline work in the loaded task window.'}</td></tr>`;
      return;
    }

    rows.innerHTML = openTasks.map((task) => {
      const heartbeat = heartbeatText(task);
      const heartbeatClass = isStale(task) ? 'pipeline-error' : 'pipeline-subtle';
      return `
        <tr class="${state.context ? 'pipeline-row-context' : ''}" data-pipeline-task="${escapeHtml(task.pipelineId)}">
          <td class="pipeline-id">${escapeHtml(task.pipelineId)}</td>
          <td>
            <div class="pipeline-title" title="${escapeHtml(task.title || 'Untitled task')}">${escapeHtml(task.title || 'Untitled task')}</div>
            ${task.epic ? `<div class="pipeline-subtle">${escapeHtml(task.epic)}</div>` : ''}
          </td>
          <td>${statusBadge(task.status)}</td>
          <td>${escapeHtml(task.assignee || 'unassigned')}</td>
          <td>${escapeHtml(task.service || '--')}</td>
          <td class="${heartbeatClass}">${escapeHtml(heartbeat)}</td>
        </tr>
      `;
    }).join('');
  }

  function attentionItems() {
    const items = [];
    state.tasks.filter(matchesContext).filter(matchesFilters).forEach((task) => {
      if (task.status === 'blocked') {
        items.push({
          rank: 0,
          title: `${task.pipelineId} blocked`,
          detail: task.title || 'Blocked task needs attention.'
        });
      } else if (task.status === 'review') {
        items.push({
          rank: 1,
          title: `${task.pipelineId} ready for review`,
          detail: task.title || 'Worker feedback is waiting for overseer review.'
        });
      } else if (task.status === 'in_progress' && !task.assignee) {
        items.push({
          rank: 2,
          title: `${task.pipelineId} in progress without owner`,
          detail: task.title || 'Task state is in progress but has no assignee.'
        });
      } else if (isStale(task)) {
        items.push({
          rank: 3,
          title: `${task.pipelineId} stale heartbeat`,
          detail: `${heartbeatText(task)} - ${task.title || 'claimed task'}`
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
    if (meta) meta.textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'} surfaced` : 'No blocked, review, or stale items';
    if (!items.length) {
      list.innerHTML = '<div class="pipeline-empty">No attention items in the loaded task window.</div>';
      return;
    }
    list.innerHTML = items.map((item) => `
      <article class="pipeline-attention-item">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </article>
    `).join('');
  }

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
    const rows = $('pipelineOpenRows');
    if (rows) {
      rows.innerHTML = `<tr><td colspan="6" class="pipeline-error">${escapeHtml(error.message || error)}</td></tr>`;
    }
    const list = $('pipelineAttentionList');
    if (list) {
      list.innerHTML = `<div class="pipeline-error">${escapeHtml(error.message || error)}</div>`;
    }
  }

  function renderAll() {
    renderContext();
    renderCounts();
    renderEvidence();
    renderFilters();
    renderOpenWork();
    renderAttention();
  }

  async function loadTasks() {
    setLoading(true);
    try {
      const payload = await fetchJson('/api/pipeline/tasks?limit=1000&view=summary&includeDone=true');
      const normalized = normalizePayload(payload);
      state.tasks = normalized.tasks;
      state.summary = normalized.summary;
      state.evidence = normalized.evidence;
      renderAll();
    } catch (error) {
      renderError(error);
    } finally {
      setLoading(false);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const refresh = $('pipelineRefreshBtn');
    if (refresh) refresh.addEventListener('click', loadTasks);
    for (const [id, key] of [
      ['pipelineServiceFilter', 'service'],
      ['pipelineLaneFilter', 'lane'],
      ['pipelineStatusFilter', 'status'],
    ]) {
      $(id)?.addEventListener('change', (event) => {
        state.filters[key] = event.target.value;
        renderOpenWork();
        renderAttention();
      });
    }
    loadTasks();
  });
})();

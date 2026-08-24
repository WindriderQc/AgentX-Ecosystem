(function () {
  'use strict';

  const STATUS_ORDER = ['queued', 'in_progress', 'review', 'blocked', 'done'];
  const OPEN_ORDER = { blocked: 0, review: 1, in_progress: 2, queued: 3, done: 4 };
  const STALE_HEARTBEAT_MS = 60 * 60 * 1000;

  const state = {
    tasks: [],
    loading: false,
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
    return tasks.map((task) => ({
      pipelineId: task.pipelineId || '',
      title: task.title || '',
      service: task.service || '',
      status: task.status || 'queued',
      assignee: task.assignee || '',
      heartbeatAt: task.heartbeatAt || null,
      epic: task.epic || '',
      source: task.source || '',
      updatedAt: task.updatedAt || task.createdAt || null
    }));
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

  function renderOpenWork() {
    const rows = $('pipelineOpenRows');
    const meta = $('pipelineOpenMeta');
    if (!rows) return;

    const allOpenTasks = state.tasks.filter((task) => task.status !== 'done');
    const openTasks = allOpenTasks
      .filter(matchesContext)
      .sort((a, b) => {
        const statusDiff = (OPEN_ORDER[a.status] ?? 99) - (OPEN_ORDER[b.status] ?? 99);
        if (statusDiff) return statusDiff;
        return String(a.pipelineId).localeCompare(String(b.pipelineId));
      });

    if (meta) {
      meta.textContent = state.context
        ? `${openTasks.length} matching open task${openTasks.length === 1 ? '' : 's'} · ${allOpenTasks.length} open overall`
        : `${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} across ${state.tasks.length} loaded records`;
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
            <div class="pipeline-title">${escapeHtml(task.title || 'Untitled task')}</div>
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
    state.tasks.filter(matchesContext).forEach((task) => {
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
    renderOpenWork();
    renderAttention();
  }

  async function loadTasks() {
    setLoading(true);
    try {
      const payload = await fetchJson('/api/pipeline/tasks?limit=1000&view=summary&includeDone=true');
      state.tasks = normalizePayload(payload);
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
    loadTasks();
  });
})();

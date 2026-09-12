/* global Toast */
(function () {
  'use strict';

  const STATUS_ORDER = ['queued', 'in_progress', 'review', 'blocked', 'done'];
  const OPEN_ORDER = { blocked: 0, review: 1, in_progress: 2, queued: 3, done: 4 };
  const STALE_HEARTBEAT_MS = 60 * 60 * 1000;
  const AUTO_REFRESH_MS = 10 * 1000;
  const STORAGE_AUTO = 'agentx.pipeline.autoRefresh';
  const STORAGE_REVIEWER = 'agentx.pipeline.reviewer';

  const STATUS_META = {
    queued: { label: 'Queued', icon: 'fa-inbox' },
    in_progress: { label: 'In progress', icon: 'fa-bolt' },
    review: { label: 'Review', icon: 'fa-magnifying-glass' },
    blocked: { label: 'Blocked', icon: 'fa-hand' },
    done: { label: 'Done', icon: 'fa-check' }
  };

  const DELIVERY_STAGE_META = {
    review_ready: { label: 'Ready for review', icon: 'fa-magnifying-glass', tone: 'human' },
    correction_requested: { label: 'Correction requested', icon: 'fa-rotate-left', tone: 'running' },
    accepted_waiting_pr: { label: 'Accepted · waiting for PR', icon: 'fa-code-pull-request', tone: 'running' },
    delivery_unavailable: { label: 'Delivery evidence unavailable', icon: 'fa-link-slash', tone: 'failed' },
    receipt_mismatch: { label: 'Receipt mismatch', icon: 'fa-shield-halved', tone: 'failed' },
    ci_pending: { label: 'CI pending', icon: 'fa-hourglass-start', tone: 'running' },
    ci_running: { label: 'CI running', icon: 'fa-spinner fa-spin', tone: 'running' },
    ci_failed: { label: 'CI failed', icon: 'fa-circle-xmark', tone: 'failed' },
    merge_blocked: { label: 'Merge blocked', icon: 'fa-ban', tone: 'failed' },
    pr_ready_to_merge: { label: 'PR green · ready to merge', icon: 'fa-code-merge', tone: 'human' },
    deployment_pending: { label: 'Deployment pending', icon: 'fa-hourglass-start', tone: 'running' },
    deployment_in_progress: { label: 'Deployment in progress', icon: 'fa-rocket fa-beat-fade', tone: 'running' },
    deployed: { label: 'Deployed · production proven', icon: 'fa-circle-check', tone: 'success' },
    deployment_verification_failed: { label: 'Production proof failed', icon: 'fa-triangle-exclamation', tone: 'failed' },
    deployment_rolled_back: { label: 'Deployment rolled back', icon: 'fa-rotate-left', tone: 'failed' },
    deployment_failed: { label: 'Deployment failed', icon: 'fa-circle-xmark', tone: 'failed' }
  };

  const state = {
    tasks: [],
    summary: null,
    evidence: null,
    performance: null,
    performanceError: null,
    performanceWindow: '30d',
    launchController: null,
    taskReadVersion: 0,
    delivery: null,
    deliveryError: null,
    deliveryMerging: null,
    deliveryLoading: false,
    requests: {},
    taskError: null,
    view: 'board',
    includeDone: true,
    expandedStages: new Set(),
    timelineLimit: 60,
    loading: false,
    context: readContext(),
    deepLinkedTask: readDeepLinkedTask(),
    filters: { status: null, search: '', service: '', lane: '', epic: '' },
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

  // Fold accents and case for search without rewriting literal punctuation
  // through compatibility normalization. Display text remains unchanged.
  function foldDiacritics(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
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
    $('pipelineContextDetail').textContent = 'Counts remain global; the progression, work table and attention list show only this bounded context.';
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

  function durationLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unknown';
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  function percentLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const ratio = Number(value);
    return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : 'Unknown';
  }

  function costLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const nanodollars = Number(value);
    if (!Number.isFinite(nanodollars) || nanodollars < 0) return 'Unknown';
    const dollars = nanodollars / 1_000_000_000;
    return dollars < 0.01 && dollars > 0 ? '<$0.01' : `$${dollars.toFixed(2)}`;
  }

  function costEvidencePresentation(usage = {}) {
    const amount = costLabel(usage.costNanodollars);
    if (amount === 'Unknown') return { amount, detail: 'Monetary telemetry unavailable; execution is evaluated separately' };
    if (usage.costStatus === 'partial') return { amount: `${amount} observed so far`,
      detail: 'Partial session usage; this is not a complete cost total' };
    if (usage.costKind === 'provider-spend') {
      const local = usage.costSource === 'openclaw-local-provider-spend/v1';
      return {
        amount: `${amount} provider spend`,
        detail: local ? 'Local compute unpriced' : 'Provider spend receipt',
      };
    }
    if (usage.costKind === 'session-estimate') {
      return {
        amount: `${amount} session estimate`,
        detail: 'Billing unverified · OpenClaw session receipt',
      };
    }
    return { amount: 'Unknown', detail: 'Cost nature or provenance missing' };
  }

  function readDeepLinkedTask() {
    const value = String(new URLSearchParams(window.location.search).get('task') || '').trim();
    return /^\d{3,4}$/.test(value) ? value : null;
  }

  function energyLabel(value) {
    if (value == null || value === '') return 'Unknown';
    const millijoules = Number(value);
    if (!Number.isFinite(millijoules) || millijoules < 0) return 'Unknown';
    const wattHours = millijoules / 3_600_000;
    if (wattHours > 0 && wattHours < 0.01) return '<0.01 Wh';
    return `${wattHours.toFixed(2)} Wh`;
  }

  function nanoCurrencyLabel(value, currency) {
    if (value == null || value === '' || !/^[A-Z]{3}$/.test(String(currency || ''))) return 'Unknown';
    const nanoUnits = Number(value);
    if (!Number.isFinite(nanoUnits) || nanoUnits < 0) return 'Unknown';
    const amount = nanoUnits / 1_000_000_000;
    if (amount > 0 && amount < 0.01) return `<0.01 ${currency}`;
    return `${amount.toFixed(2)} ${currency}`;
  }

  function localEnergyPresentation(localEnergy) {
    if (!localEnergy || localEnergy.measurementScope !== 'gpu-incremental-lower-bound') {
      return { energy: 'Unknown', cost: 'Unknown', detail: 'No measured local-energy evidence' };
    }
    const tariff = localEnergy.tariff || null;
    return {
      energy: energyLabel(localEnergy.energyMillijoules),
      cost: nanoCurrencyLabel(tariff?.estimatedCostNanoCurrencyUnits, tariff?.currency),
      detail: tariff
        ? 'GPU incremental lower bound · operator-configured tariff'
        : 'GPU incremental lower bound · electricity tariff not configured',
    };
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
        priority: task.priority,
        risk: task.risk || '',
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
        notBefore: task.notBefore || null,
        automation: task.automation && typeof task.automation === 'object' ? task.automation : null,
        automationAttemptCount: Number(task.automationAttemptCount) || 0,
        dueAt: task.dueAt || null,
        createdAt: task.createdAt || null,
        updatedAt: task.updatedAt || task.createdAt || null,
        timeline: Array.isArray(task.timeline) ? task.timeline : [],
        resolution: task.resolution || null
      })),
      summary: data?.summary || null,
      evidence: data?.evidence || null
    };
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

  // Independent reads are cancellable and bounded. Mutations keep their existing
  // exact-identity contracts and are never silently retried.
  async function readProjection(key, url, timeoutMs = 15000) {
    state.requests[key]?.abort();
    const controller = new AbortController();
    state.requests[key] = controller;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload = await fetchJson(url, { signal: controller.signal });
      return state.requests[key] === controller ? payload : null;
    } catch (error) {
      if (state.requests[key] !== controller) return null;
      throw new Error(controller.signal.aborted ? 'Request timed out. Refresh to try again.' : error.message);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function safeGitHubUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : '';
    } catch {
      return '';
    }
  }

  function deliveryLink(value, label, icon) {
    const url = safeGitHubUrl(value);
    return url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><i class="fas ${escapeHtml(icon)}" aria-hidden="true"></i>${escapeHtml(label)}</a>`
      : '';
  }

  function deliveryGate(label, passed) {
    return `<span class="pipeline-delivery-gate ${passed ? 'pass' : 'fail'}"><i class="fas ${passed ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i>${escapeHtml(label)}</span>`;
  }

  function renderDeliveryInbox() {
    const statusEl = $('pipelineDeliveryState');
    const list = $('pipelineDeliveryList');
    const count = $('pipelineDeliveryHumanCount');
    const meta = $('pipelineDeliveryMeta');
    if (!statusEl || !list) return;

    if (state.deliveryError) {
      statusEl.dataset.tone = 'unavailable';
      statusEl.innerHTML = `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>Delivery inbox unavailable: ${escapeHtml(state.deliveryError)}</span>`;
      if (count) count.textContent = '--';
      if (!state.delivery) {
        list.innerHTML = '<div class="pipeline-empty">The task queue remains available. Delivery evidence is unavailable. <button type="button" class="pipeline-btn compact" data-retry-delivery>Retry evidence</button></div>';
        $('pipelineDeliveryHistoryMeta').textContent = 'Delivery history unavailable';
        $('pipelineDeliveryHistoryList').innerHTML = '<div class="pipeline-empty">No production conclusion can be drawn from this failed request.</div>';
        return;
      }
      statusEl.innerHTML += `<span>Last observation retained from ${escapeHtml(formatDate(state.delivery.observedAt))}; merge controls disabled.</span>`;
    }
    if (!state.delivery) {
      if (state.deliveryLoading) {
        statusEl.dataset.tone = 'loading';
        statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Loading delivery evidence independently…</span>';
      }
      return;
    }

    const items = Array.isArray(state.delivery.items) ? state.delivery.items : [];
    const humanActions = Number(state.delivery.counts?.humanActionRequired) || 0;
    const readyToMerge = Number(state.delivery.counts?.readyToMerge) || 0;
    if (!state.deliveryError) {
      statusEl.dataset.tone = humanActions ? 'attention' : 'ready';
      statusEl.innerHTML = humanActions
        ? `<i class="fas fa-bell" aria-hidden="true"></i><span><strong>${humanActions}</strong> human action${humanActions === 1 ? '' : 's'} pending · ${readyToMerge} exact PR${readyToMerge === 1 ? '' : 's'} ready to merge</span>`
        : '<i class="fas fa-circle-check" aria-hidden="true"></i><span>No human delivery decision is waiting. Active PR, CI, and deployment states remain visible below.</span>';
      if (count) count.textContent = state.deliveryLoading ? '…' : String(humanActions);
      if (state.deliveryLoading) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Refreshing delivery evidence · previous observation retained.</span>';
    }
    if (meta) {
      const observed = state.delivery.observedAt ? formatDate(state.delivery.observedAt) : 'unknown';
      meta.textContent = `Observed ${observed} · Merge always requires one explicit operator click. Deployment and live production proof remain separate.`;
    }


    const active = items.filter((item) => item.stage !== 'deployed');
    const completed = items.filter((item) => item.stage === 'deployed');
    list.innerHTML = active.length ? active.map(renderDeliveryCard).join('')
      : '<div class="pipeline-empty"><i class="fas fa-circle-check" aria-hidden="true"></i> No active delivery or human decision. Completed deliveries remain in History.</div>';
    const expanded = [...document.querySelectorAll('[data-delivery-record][open]')].map((el) => el.dataset.deliveryRecord);
    $('pipelineDeliveryHistoryMeta').textContent = `${state.deliveryError ? 'Stale observation · ' : ''}${completed.length} completed deliveries · observed ${formatDate(state.delivery.observedAt)} · independent of the attempt window and board filters`;
    $('pipelineDeliveryHistoryList').innerHTML = completed.length ? completed.map((item) => `
      <details class="pipeline-delivery-record" data-delivery-record="${escapeHtml(item.pipelineId)}">
        <summary><span>${escapeHtml(item.pipelineId)} · ${escapeHtml(item.title)}</span><span class="pipeline-status pipeline-status-done">Production proven <i class="fas fa-chevron-down"></i></span></summary>
        ${renderDeliveryCard(item)}
      </details>`).join('') : '<div class="pipeline-empty">No completed production delivery in this observation.</div>';
    document.querySelectorAll('[data-delivery-record]').forEach((el) => { el.open = expanded.includes(el.dataset.deliveryRecord); });
  }

  function renderDeliveryCard(item) {
    const stage = DELIVERY_STAGE_META[item.stage] || { label: String(item.stage || 'Unknown delivery state'), icon: 'fa-circle-question', tone: 'failed' };
    const summary = item.summary || {};
    const pr = item.pullRequest || null;
    const ci = item.ci || null;
    const deployment = item.deployment || null;
    const gate = item.gate || null;
    const headSha = String(pr?.headSha || '');
    const merging = state.deliveryMerging === item.pipelineId;
    const mergeReady = !state.deliveryError && !state.deliveryLoading && item.stage === 'pr_ready_to_merge' && gate?.ready === true && /^[a-f0-9]{40}$/.test(headSha);
    const gates = gate ? [
      deliveryGate('Accepted task', gate.taskAccepted === true),
      deliveryGate('Exact PR', gate.exactPullRequest === true),
      deliveryGate('Exact SHA', gate.exactHead === true),
      deliveryGate('Sealed receipt', gate.sealedReceipt === true),
      deliveryGate('Required CI green', gate.ciGreen === true),
      deliveryGate('GitHub mergeable', gate.mergeable === true)
    ].join('') : '';
    const productionGate = deployment?.production?.available
      ? deliveryGate('Live production parity', deployment.status === 'succeeded')
      : '';
    const links = [
      deliveryLink(pr?.url, pr?.number ? `PR #${pr.number}` : 'Pull request', 'fa-code-pull-request'),
      deliveryLink(ci?.url, 'Exact CI run', 'fa-list-check'),
      deliveryLink(deployment?.url, 'Deployment run', 'fa-rocket')
    ].filter(Boolean).join('');
    return `
      <article class="pipeline-delivery-card tone-${escapeHtml(stage.tone)}">
        <div class="pipeline-delivery-card-head">
          <div class="pipeline-delivery-identity">
            <strong>${escapeHtml(item.pipelineId)} · ${escapeHtml(item.title || 'Untitled task')}</strong>
            <span>Attempt ${escapeHtml(item.attempt || '--')}${pr?.number ? ` · PR #${escapeHtml(pr.number)}` : ''}${headSha ? ` · <code>${escapeHtml(headSha.slice(0, 12))}</code>` : ''}</span>
          </div>
          <span class="pipeline-delivery-stage"><i class="fas ${escapeHtml(stage.icon)}" aria-hidden="true"></i>${escapeHtml(stage.label)}</span>
        </div>
        <dl class="pipeline-delivery-summary">
          <div><dt>What changes</dt><dd>${escapeHtml(summary.change || 'Unknown')}</dd></div>
          <div><dt>Tests &amp; proof</dt><dd>${escapeHtml(summary.tests || 'Unknown')}</dd></div>
          <div><dt>Risks</dt><dd>${escapeHtml(summary.risks || 'Unknown')}</dd></div>
          <div class="${summary.recommendation === 'CORRECT' ? 'recommend-correct' : 'recommend-merge'}"><dt>Recommendation</dt><dd>${escapeHtml(summary.recommendation || 'CORRECT')}</dd></div>
          <div><dt>Exact next action</dt><dd>${escapeHtml(summary.nextAction || 'Refresh exact evidence.')}</dd></div>
        </dl>
        ${gates || productionGate ? `<div class="pipeline-delivery-gates" aria-label="Protected delivery gates">${gates}${productionGate}</div>` : ''}
        <div class="pipeline-delivery-actions">
          <div class="pipeline-delivery-links">
            <button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(item.pipelineId)}"><i class="fas fa-folder-open" aria-hidden="true"></i><span>Open dossier</span></button>
            ${links}
          </div>
          ${mergeReady ? `<button type="button" class="pipeline-btn primary compact" data-delivery-merge data-pipeline-id="${escapeHtml(item.pipelineId)}" data-pr-number="${escapeHtml(pr.number)}" data-head-sha="${escapeHtml(headSha)}" ${merging ? 'disabled' : ''} title="Merge exact PR #${escapeHtml(pr.number)} at ${escapeHtml(headSha)} after revalidating every gate"><i class="fas ${merging ? 'fa-spinner fa-spin' : 'fa-code-merge'}" aria-hidden="true"></i><span>${merging ? 'Revalidating exact gate' : `Merge PR #${escapeHtml(pr.number)} · ${escapeHtml(headSha.slice(0, 8))}`}</span></button>` : ''}
        </div>
      </article>`;

  }


  async function loadDeliveryStatus() {
    state.deliveryError = null;
    state.deliveryLoading = true;
    renderDeliveryInbox();
    try {
      const payload = await readProjection('delivery', '/api/runtime-bridges/coding-delivery/status', 45000);
      if (!payload) return;
      if (!payload.data) throw new Error('status response is missing data');
      state.delivery = payload.data;
    } catch (error) {
      state.deliveryError = String(error.message || error);
    }
    state.deliveryLoading = false;
    renderDeliveryInbox();
  }

  async function mergeDeliveryItem(button) {
    const pipelineId = String(button?.dataset?.pipelineId || '');
    const pullRequestNumber = Number(button?.dataset?.prNumber);
    const expectedHeadSha = String(button?.dataset?.headSha || '').toLowerCase();
    const item = state.delivery?.items?.find((candidate) => candidate.pipelineId === pipelineId);
    if (!/^\d{4}$/.test(pipelineId) || !Number.isInteger(pullRequestNumber) || !/^[a-f0-9]{40}$/.test(expectedHeadSha)) return;
    if (item?.stage !== 'pr_ready_to_merge' || item?.gate?.ready !== true) return;
    const confirmed = window.confirm(
      `Merge exact PR #${pullRequestNumber} at ${expectedHeadSha}?\n\n` +
      'Pipeline will revalidate the accepted task, exact PR and SHA, sealed receipt, required green CI jobs, and GitHub mergeability. After GitHub confirms the merge, the separate protected deployment workflow starts automatically.'
    );
    if (!confirmed) return;

    state.deliveryMerging = pipelineId;
    renderDeliveryInbox();
    try {
      const payload = await fetchJson('/api/runtime-bridges/coding-delivery/merge', {
        method: 'POST',
        body: JSON.stringify({
          pipelineId,
          pullRequestNumber,
          expectedHeadSha,
          confirmation: `MERGE PR #${pullRequestNumber} @ ${expectedHeadSha}`
        })
      });
      const mergeSha = payload?.data?.mergeCommitSha;
      toast('success', `PR #${pullRequestNumber} merged${mergeSha ? ` at ${String(mergeSha).slice(0, 12)}` : ''}; protected deployment dispatched.`);
    } catch (error) {
      toast('error', error.message || String(error));
    } finally {
      state.deliveryMerging = null;
      await loadTasks({ silent: true });
    }
  }

  function renderDispatchControl() {
    const stateEl = $('pipelineTeamLaunchState');
    const detail = $('pipelineTeamLaunchDetail');
    const select = $('pipelineTeamLaunchTask');
    const confirm = $('pipelineTeamLaunchConfirm');
    const button = $('pipelineTeamLaunchButton');
    const controller = state.launchController;
    if (!stateEl || !detail || !select || !confirm || !button) return;
    const control = controller?.control;
    const candidates = control?.candidates || [];
    const pending = controller?.pending;
    const selected = pending ? '' : select.value;
    select.innerHTML = '<option value="">' + (candidates.length ? 'Choose a task…' : 'No task is currently eligible') + '</option>'
      + candidates.map(task => `<option value="${escapeHtml(task.pipelineId)}">${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title)}</option>`).join('');
    if (candidates.some(task => task.pipelineId === selected)) select.value = selected;
    const ready = control?.available === true && !control.busy && !pending && !controller?.submitting && !controller?.checking && !controller?.error;
    select.disabled = !ready || !candidates.length;
    confirm.disabled = !ready || !select.value;
    if (confirm.disabled) confirm.checked = false;
    button.disabled = !ready || !select.value || !confirm.checked;
    button.innerHTML = controller?.submitting
      ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Submitting request</span>'
      : '<i class="fas fa-play" aria-hidden="true"></i><span>Run one task</span>';
    const run = pending && control?.run?.requestId !== pending.requestId ? null : control?.run;
    if (controller?.error) {
      stateEl.dataset.tone = 'unavailable';
      stateEl.textContent = controller.error;
    } else if (!control || controller.checking) {
      stateEl.dataset.tone = 'loading';
      stateEl.textContent = 'Checking current host admission and request status…';
    } else if (!control.available) {
      stateEl.dataset.tone = 'unavailable';
      stateEl.textContent = 'The one-shot host is unavailable.';
    } else if (pending || control.busy) {
      stateEl.dataset.tone = 'loading';
      stateEl.textContent = run ? `Request ${run.pipelineId || pending?.pipelineId || ''} · ${formatStatus(run.phase)}` : `Submitting request for ${pending?.pipelineId || 'one task'}…`;
    } else {
      stateEl.dataset.tone = 'ready';
      stateEl.textContent = 'Host observed · one local worker · provider spend ceiling $0';
    }
    const summary = control?.summary;
    detail.textContent = summary
      ? `${summary.eligibleTasks} of ${summary.queuedTasks} queued tasks eligible for this worker · ${summary.privateQueuedTasks} personal/household tasks outside its scope. Only unassigned, low-risk, review-only coding tasks with declared authority sources, permitted scope, available budgets and completed dependencies can start. Board filters do not change this list.`
      : 'Eligibility comes from the host dispatcher. Task status, dependencies, automation scope and budgets are rechecked before execution.';
    if (control?.inference && !controller?.error && !controller?.checking && control.available) {
      stateEl.textContent = `Task ${control.inference.pipelineId} · ${inferenceSummary(control.inference)}`;
      detail.textContent = `Task attempt ${control.inference.attempt} · ${control.inference.requestCount} model call(s). Inference retries keep this attempt and never replay worker tools.`;
    }
    const result = $('pipelineTeamLaunchResult');
    if (result) {
      result.hidden = !run && !pending;
      result.innerHTML = run
        ? `<strong>${escapeHtml(run.message || formatStatus(run.phase))}</strong>${run.task ? `<span>Task ${escapeHtml(run.task.pipelineId)}: ${escapeHtml(formatStatus(run.task.status))} · ${escapeHtml(run.task.automationAttemptCount || 0)} recorded attempt(s).</span>` : ''}${run.pipelineId ? `<button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(run.pipelineId)}">Open task dossier</button>` : ''}`
        : pending ? `<strong>Checking request for task ${escapeHtml(pending.pipelineId)}. Acknowledgement does not prove that the task has been claimed.</strong>` : '';
    }
    const retry = $('pipelineTeamLaunchRetry');
    if (retry) {
      retry.hidden = !pending || !(run?.phase === 'not_received' || run?.canRetry === true);
      retry.disabled = !controller?.canRetry();
    }
    const reasons = $('pipelineTeamEligibilityReasons');
    if (reasons) reasons.innerHTML = (control?.excluded || []).map(task => `<div class="pipeline-launch-exclusion"><button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(task.pipelineId)}">${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title)}</button><p>${(task.reasons || []).map(reason => escapeHtml(reason.detail || reason.code)).join(' · ')}</p></div>`).join('') || '<p>No additional non-private queue exclusions in the current observation.</p>';
  }

  async function loadDispatchControlStatus() {
    return state.launchController?.refresh();
  }

  async function launchOneTask() {
    const pipelineId = String($('pipelineTeamLaunchTask')?.value || '');
    if ($('pipelineTeamLaunchConfirm')?.checked !== true || !state.launchController?.canLaunch(pipelineId)) return;
    await state.launchController.launch(pipelineId);
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
    const counts = statusCounts();
    const stale = state.tasks.filter(isStale).length;
    if (counts.blocked) {
      setPageState('blocked', 'fa-hand', `${counts.blocked} task${counts.blocked === 1 ? '' : 's'} blocked`, 'Blocked work needs an operator or upstream action before it can move.');
    } else if (counts.review || stale) {
      const parts = [];
      if (counts.review) parts.push(`${counts.review} awaiting review`);
      if (stale) parts.push(`${stale} stale heartbeat${stale === 1 ? '' : 's'} in loaded rows`);
      setPageState('attention', 'fa-triangle-exclamation', 'Attention suggested', `${parts.join(' · ')} — see Needs attention for the next step.`);
    } else {
      const loadedOpen = state.tasks.filter((task) => task.status !== 'done').length;
      const open = summaryCount('openCount', loadedOpen);
      setPageState('ready', 'fa-circle-check', open ? 'Pipeline healthy' : 'Queue clear', open
        ? `${open} open task${open === 1 ? '' : 's'} in the exact API scope, with no reported blockers.`
        : 'No open work in the exact API scope.');
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

  function hasExactCountEvidence() {
    const summary = state.summary;
    const evidence = state.evidence;
    const byStatus = summary?.byStatus;
    if (!summary || !byStatus || evidence?.authority !== 'core.pipeline' || evidence?.source?.store !== 'mongodb') return false;
    if (evidence.scope?.includesDone !== true || evidence.scope?.timeWindow?.kind !== 'all_time') return false;
    const scopedStatuses = Array.isArray(evidence.scope?.statuses) ? evidence.scope.statuses : [];
    if (!STATUS_ORDER.every((status) => scopedStatuses.includes(status))) return false;
    const counts = STATUS_ORDER.map((status) => Number(byStatus[status]));
    if (counts.some((count) => !Number.isFinite(count) || count < 0)) return false;
    const matched = counts.reduce((sum, count) => sum + count, 0);
    const open = counts.slice(0, 4).reduce((sum, count) => sum + count, 0);
    return matched === Number(summary.matchedCount)
      && open === Number(summary.openCount)
      && counts[4] === Number(summary.doneCount)
      && matched === Number(evidence.rows?.matchedCount);
  }

  function summaryCount(key, fallback) {
    if (!hasExactCountEvidence()) return fallback;
    const value = Number(state.summary?.[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function statusCounts() {
    const loaded = countByStatus(state.tasks);
    if (!hasExactCountEvidence()) return loaded;
    const summary = state.summary?.byStatus;
    const counts = {};
    STATUS_ORDER.forEach((status) => {
      const value = Number(summary[status]);
      counts[status] = Number.isFinite(value) && value >= 0 ? value : loaded[status];
    });
    return counts;
  }

  function renderCounts() {
    const counts = statusCounts();
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
    const { status, search, service, lane, epic } = state.filters;
    if (epic && (task.epic || 'ungrouped') !== epic) return false;
    if (status && task.status !== status) return false;
    if (service && (task.service || 'unspecified') !== service) return false;
    if (lane && (task.source || 'unspecified') !== lane) return false;
    if (search) {
      const haystack = [task.pipelineId, task.title, task.assignee, task.epic, task.service, task.source]
        .map((v) => foldDiacritics(String(v || ''))).join(' ');
      if (!haystack.includes(foldDiacritics(search))) return false;
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
    return Boolean(state.filters.status || state.filters.search || state.filters.service || state.filters.lane || state.filters.epic);
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

  function optionLabel(value) {
    return String(value || 'unspecified').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function populateFilter(id, values, current, allLabel) {
    const select = $(id);
    if (!select) return '';
    const available = [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    if (current && !available.includes(current)) available.push(current);
    const selected = current;
    select.innerHTML = [`<option value="">${escapeHtml(allLabel)}</option>`]
      .concat(available.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(optionLabel(value))}</option>`))
      .join('');
    return selected;
  }

  function renderFilterOptions() {
    state.filters.epic = populateFilter('pipelineEpicFilter', state.tasks.map((task) => task.epic || 'ungrouped'), state.filters.epic, 'All groups');
    state.filters.service = populateFilter(
      'pipelineServiceFilter', state.tasks.map((task) => task.service || 'unspecified'), state.filters.service, 'All services'
    );
    state.filters.lane = populateFilter(
      'pipelineLaneFilter', state.tasks.map((task) => task.source || 'unspecified'), state.filters.lane, 'All lanes / sources'
    );
  }

  function renderEvidence() {
    const el = $('pipelineCountEvidence');
    if (!el) return;
    const evidence = state.evidence;
    const summary = state.summary;
    if (!hasExactCountEvidence()) {
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

  function visibleTasks() {
    // Without an explicit status filter the table shows open work only; a
    // status filter (including "done") widens or narrows it deliberately.
    return sortTasks(
      state.tasks.filter(matchesContext)
        .filter(matchesFilters)
        .filter((task) => (state.filters.status ? true : task.status !== 'done'))
    );
  }

  function renderProgression() {
    const target = $('pipelineProgression');
    if (!target) return;
    const scoped = state.tasks.filter(matchesContext).filter(matchesFilters);
    const tasks = sortTasks(scoped.filter((task) => state.filters.status || state.includeDone || task.status !== 'done'));
    const done = scoped.filter((task) => task.status === 'done').length;
    const superseded = scoped.filter((task) => task.resolution?.kind === 'superseded').length;
    const scope = state.filters.epic ? `Group: ${state.filters.epic}` : 'All groups';
    $('pipelineOverviewMeta').textContent = `${scope} · ${tasks.length} matching loaded tasks · ${done}/${scoped.length} closed${superseded ? ` (${superseded} superseded)` : ''}${state.filters.status ? ` · ${formatStatus(state.filters.status)}` : ''}. Counts above remain global.${state.evidence?.rows?.truncated ? ' Loaded sample is incomplete; see count scope above.' : ''}`;
    $('pipelineIncludeDone').disabled = Boolean(state.filters.status);
    document.querySelectorAll('[data-pipeline-view]').forEach((button) => {
      const selected = button.dataset.pipelineView === state.view;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (!tasks.length) {
      target.innerHTML = '<div class="pipeline-empty">No tasks match this view. <button type="button" class="pipeline-btn compact" data-clear-filters>Clear filters</button></div>';
      return;
    }
    if (state.view === 'timeline') {
      const events = tasks.flatMap((task) => task.timeline.map((entry) => ({ task, ...entry })))
        .filter((entry) => entry.at && Number.isFinite(new Date(entry.at).getTime()))
        .sort((a, b) => new Date(b.at) - new Date(a.at) || a.task.pipelineId.localeCompare(b.task.pipelineId));
      target.innerHTML = `<p class="pipeline-timeline-note">Recorded events · newest first. Status badges show current status. Unrecorded transitions and completion dates remain unknown; a record update does not prove delivery.</p>
        <ol class="pipeline-timeline">${events.slice(0, state.timelineLimit).map((entry) => `<li>
          <time datetime="${escapeHtml(entry.at)}">${escapeHtml(formatDate(entry.at))}</time>
          <button type="button" class="pipeline-task-card" data-pipeline-task="${escapeHtml(entry.task.pipelineId)}">
            <span class="pipeline-card-top"><strong>${escapeHtml(entry.task.pipelineId)}</strong>${statusBadge(entry.task.status)}</span>
            <span class="pipeline-card-title">${escapeHtml(entry.task.title)}</span>
            <span class="pipeline-card-event">${escapeHtml(entry.label)}${entry.attempt ? ` · attempt ${escapeHtml(entry.attempt)}` : ''}</span>
          </button></li>`).join('')}</ol>
        ${events.length > state.timelineLimit ? `<button type="button" class="pipeline-btn compact" data-more-events>Show more events (${events.length - state.timelineLimit} remaining)</button>` : ''}
        <p class="pipeline-timeline-note">${Math.min(events.length, state.timelineLimit)} of ${events.length} recorded events · ${tasks.filter((task) => !task.timeline.length).length} tasks without recorded event dates. Full feedback remains in each dossier.</p>`;
      return;
    }
    const stages = state.filters.status ? [state.filters.status] : STATUS_ORDER.filter((status) => state.includeDone || status !== 'done');
    target.innerHTML = `<div class="pipeline-board${stages.length === 1 ? ' pipeline-board-focused' : ''}">${stages.map((status) => {
      const items = tasks.filter((task) => task.status === status);
      if (status === 'done') items.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const shown = state.expandedStages.has(status) ? items : items.slice(0, 8);
      return `<section class="pipeline-board-column stage-${escapeHtml(status)}" aria-label="${escapeHtml(formatStatus(status))} tasks">
        <h3>${statusBadge(status)}<span>${items.length}</span></h3>
        <div class="pipeline-board-cards">${shown.map((task) => `<button type="button" class="pipeline-task-card" data-pipeline-task="${escapeHtml(task.pipelineId)}" aria-label="Open task ${escapeHtml(task.pipelineId)}: ${escapeHtml(task.title)}">
          <span class="pipeline-card-top"><strong>${escapeHtml(task.pipelineId)}</strong>${priorityChip(task.priority)}</span>
          <span class="pipeline-card-title">${escapeHtml(task.title || 'Untitled task')}</span>
          <span class="pipeline-card-meta">${escapeHtml(task.assignee || 'Unassigned')} · ${escapeHtml(task.service || 'No service')}</span>
          ${task.epic ? `<span class="pipeline-card-group">${escapeHtml(task.epic)}</span>` : ''}
          ${task.resolution?.kind === 'superseded' ? '<span class="pipeline-card-event">Closed by supersession</span>' : ''}
          ${isStale(task) ? '<span class="pipeline-card-alert">Stale heartbeat</span>' : ''}
          ${task.dependsOn.length ? `<span class="pipeline-card-meta">Depends on ${escapeHtml(task.dependsOn.join(', '))}</span>` : ''}
          ${task.dueAt ? `<span class="pipeline-card-meta">Due ${escapeHtml(formatDate(task.dueAt))}</span>` : ''}
        </button>`).join('') || '<p class="pipeline-column-empty">No matching tasks</p>'}</div>
        ${shown.length < items.length ? `<button class="pipeline-btn compact pipeline-more" type="button" data-more-stage="${escapeHtml(status)}">Show all ${items.length}</button>` : ''}
      </section>`;
    }).join('')}</div>`;
  }

  function renderOpenWork() {
    const rows = $('pipelineOpenRows');
    const meta = $('pipelineOpenMeta');
    if (!rows) return;

    const tasks = visibleTasks();
    const loadedOpen = state.tasks.filter((task) => task.status !== 'done').length;
    const exactOpen = summaryCount('openCount', loadedOpen);
    const exactMatched = summaryCount('matchedCount', state.tasks.length);

    if (meta) {
      const scope = state.filters.status ? `${formatStatus(state.filters.status)} tasks` : 'open tasks';
      const filtered = hasActiveFilters() || state.context;
      meta.textContent = filtered
        ? `${tasks.length} matching loaded ${scope} · ${exactOpen} open overall across ${exactMatched} exact records`
        : `${exactOpen} open task${exactOpen === 1 ? '' : 's'} across ${exactMatched} exact all-time record${exactMatched === 1 ? '' : 's'} · ${state.tasks.length} rows loaded`;
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
            <div class="pipeline-title" title="${escapeHtml(task.title || 'Untitled task')}">${escapeHtml(task.title || 'Untitled task')}</div>
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

  function reviewContext(task) {
    const attempts = Array.isArray(task.automationAttempts) ? task.automationAttempts : [];
    const deliveryItem = state.delivery?.items?.find((item) => item.pipelineId === task.pipelineId);
    const currentReceipt = deliveryItem?.stage === 'review_ready'
      || Boolean(deliveryItem?.receipt)
      || attempts.some((attempt) => attempt && attempt.evidence);
    if (!currentReceipt) {
      return {
        label: 'Human review required · interactive task',
        detail: 'This task has no automated attempt receipt. Review the recorded work and verification directly.',
        action: 'A human must inspect the existing evidence, then record a decision or re-queue it under the current reviewed automation.',
      };
    }
    return {
      label: 'Human review required · Coding Team receipt present',
      detail: 'A current guarded attempt receipt is ready for an independent human decision.',
      action: 'Accept it or request a correction from the dossier using an identity different from the worker.',
    };
  }

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
        const review = reviewContext(task);
        items.push({
          rank: 1,
          icon: 'fa-magnifying-glass',
          tone: 'review',
          pipelineId: task.pipelineId,
          title: `${task.pipelineId} ${review.label}`,
          detail: `${task.title || 'Untitled task'} · ${review.detail}`,
          action: review.action,
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
    if (meta) meta.textContent = done.length ? `Latest ${done.length} closed records by update time · all loaded tasks` : 'No closed tasks loaded';
    if (!done.length) {
      list.innerHTML = '<div class="pipeline-empty">No closed tasks in the loaded window yet.</div>';
      return;
    }
    list.innerHTML = done.map((task) => `
      <button type="button" class="pipeline-done-item" data-pipeline-task="${escapeHtml(task.pipelineId)}">
        <i class="fas fa-check" aria-hidden="true"></i>
        <span class="pipeline-done-copy">
          <strong>${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title || 'Untitled task')}</strong>
          <span>${escapeHtml([task.service, relativeTime(task.updatedAt) ? `updated ${relativeTime(task.updatedAt)}` : ''].filter(Boolean).join(' · ') || '--')}</span>
        </span>
      </button>
    `).join('');
  }

  function teamMetric(id, value, detailId, detail) {
    const valueEl = $(id);
    const detailEl = $(detailId);
    if (valueEl) valueEl.textContent = value;
    if (detailEl) detailEl.textContent = detail;
  }

  function attemptOutcome(attempt) {
    if (attempt.reviewOutcome && attempt.reviewOutcome !== 'pending') return attempt.reviewOutcome;
    return attempt.finalState || 'active';
  }

  function renderTeamPerformance() {
    const stateEl = $('pipelineTeamState');
    const rowsEl = $('pipelineTeamAttemptRows');
    const metaEl = $('pipelineTeamAttemptMeta');
    const performance = state.performance;
    if (state.performanceError) {
      if (stateEl) {
        stateEl.dataset.tone = 'unavailable';
        stateEl.innerHTML = `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>Performance unavailable: ${escapeHtml(state.performanceError)}</span>`;
      }
      if (rowsEl) rowsEl.innerHTML = '<tr><td colspan="7" class="pipeline-error">Attempt evidence could not be loaded.</td></tr>';
      return;
    }
    if (!performance) return;

    const total = Number(performance.coverage?.total) || 0;
    const evidence = Number(performance.coverage?.attemptEvidence) || 0;
    const costKnown = Number(performance.coverage?.cost) || 0;
    const accepted = Number(performance.counts?.accepted) || 0;
    const interventions = Number(performance.autonomy?.correctiveHumanInterventions) || 0;
    const attempts = Array.isArray(performance.attempts) ? performance.attempts : [];
    if (stateEl) {
      const tone = performance.state === 'observed' ? 'healthy' : (performance.state === 'no_data' ? 'empty' : 'partial');
      const label = performance.state === 'no_data'
        ? 'No autonomous attempts in this window.'
        : `${total} autonomous attempt${total === 1 ? '' : 's'} · ${evidence}/${total} structured receipt${evidence === 1 ? '' : 's'} · missing fields remain unknown.`;
      stateEl.dataset.tone = tone;
      stateEl.innerHTML = `<i class="fas ${tone === 'healthy' ? 'fa-circle-check' : tone === 'empty' ? 'fa-circle-minus' : 'fa-circle-half-stroke'}" aria-hidden="true"></i><span>${escapeHtml(label)}</span>`;
    }

    teamMetric(
      'pipelineTeamAccepted',
      String(accepted),
      'pipelineTeamAcceptedDetail',
      `${accepted}/${Number(performance.quality?.decided) || 0} decided attempts · ${percentLabel(performance.quality?.acceptanceRate)} acceptance · ${Number(performance.counts?.awaitingReview) || 0} awaiting review · ${Number(performance.counts?.blocked) || 0} blocked`
    );
    teamMetric(
      'pipelineTeamFirstPass',
      percentLabel(performance.quality?.firstPassShare),
      'pipelineTeamFirstPassDetail',
      performance.quality?.firstPassShare == null
        ? 'No accepted attempt to measure yet'
        : `${Number(performance.quality?.firstPassAccepted) || 0}/${accepted} accepted attempts were attempt 1`
    );
    teamMetric(
      'pipelineTeamCycle',
      durationLabel(performance.timing?.cycleMs?.p50),
      'pipelineTeamCycleDetail',
      `Task creation → human decision · ${Number(performance.timing?.cycleMs?.observed) || 0}/${total} observed · p95 ${durationLabel(performance.timing?.cycleMs?.p95)}`
    );
    teamMetric(
      'pipelineTeamInterventions',
      String(interventions),
      'pipelineTeamInterventionsDetail',
      `${Number(performance.counts?.requeued) || 0} requeued · ${Number(performance.counts?.rejected) || 0} rejected`
    );
    const providerSpend = performance.usage?.observedProviderSpendNanodollars;
    const sessionEstimate = performance.usage?.observedSessionEstimateNanodollars;
    const localEnergy = performance.usage?.observedEnergyMillijoules;
    const electricityByCurrency = Array.isArray(performance.usage?.electricityByCurrency)
      ? performance.usage.electricityByCurrency
      : [];
    const costHeadline = providerSpend != null && sessionEstimate != null
      ? 'Mixed evidence'
      : (providerSpend != null
        ? `${costLabel(providerSpend)} provider spend`
        : (sessionEstimate != null ? `${costLabel(sessionEstimate)} session est.` : 'Unknown'));
    const costDetails = [`${costKnown}/${total} evidenced`];
    if (providerSpend != null) costDetails.push(`${costLabel(providerSpend)} provider spend`);
    if (sessionEstimate != null) costDetails.push(`${costLabel(sessionEstimate)} session estimate, billing unverified`);
    if (localEnergy != null) costDetails.push(`${energyLabel(localEnergy)} measured local GPU energy`);
    for (const electricity of electricityByCurrency) {
      costDetails.push(`${nanoCurrencyLabel(electricity.costNanoCurrencyUnits, electricity.currency)} electricity estimate`);
    }
    if (localEnergy != null && electricityByCurrency.length === 0) {
      costDetails.push('electricity tariff not configured');
    }
    teamMetric(
      'pipelineTeamCost',
      costHeadline,
      'pipelineTeamCostDetail',
      total === 0 ? 'No attempt to measure yet' : costDetails.join(' · ')
    );
    teamMetric(
      'pipelineTeamCoverage',
      total ? `${Math.round((evidence / total) * 100)}%` : '--',
      'pipelineTeamCoverageDetail',
      `${evidence}/${total} receipts · verification ${Number(performance.coverage?.verification) || 0}/${total}`
    );

    if (metaEl) metaEl.textContent = `${attempts.length}/${total} attempts shown · ${Number(performance.counts?.tasks) || 0} tasks · started ${formatDate(performance.window?.from)} – ${formatDate(performance.window?.to)} (${performance.window?.days || '--'} days)`;
    if (!rowsEl) return;
    if (!attempts.length) {
      rowsEl.innerHTML = '<tr><td colspan="7" class="pipeline-empty">No autonomous attempt evidence in this window.</td></tr>';
      return;
    }
    rowsEl.innerHTML = attempts.map((attempt) => {
      const outcome = attemptOutcome(attempt);
      const verification = attempt.verification?.status || 'unknown';
      const files = attempt.changes?.filesChanged;
      const bytes = attempt.changes?.bytesChanged;
      const change = files == null || bytes == null
        ? 'Unknown'
        : `${files} file${files === 1 ? '' : 's'} · ${Number(bytes).toLocaleString()} B`;
      const costEvidence = costEvidencePresentation(attempt.usage);
      const energyEvidence = localEnergyPresentation(attempt.usage?.localEnergy);
      return `
        <tr data-pipeline-task="${escapeHtml(attempt.pipelineId)}" tabindex="0" aria-label="Open task ${escapeHtml(attempt.pipelineId)} attempt ${escapeHtml(attempt.attempt)}">
          <td><strong class="pipeline-id">${escapeHtml(attempt.pipelineId)}</strong><span class="pipeline-team-subtle">Attempt ${escapeHtml(attempt.attempt)}</span></td>
          <td>${escapeHtml(attempt.assignee || 'unknown')}</td>
          <td><span class="pipeline-team-outcome outcome-${escapeHtml(outcome)}">${escapeHtml(formatStatus(outcome))}</span></td>
          <td>${escapeHtml(formatStatus(verification))}</td>
          <td>${escapeHtml(change)}</td>
          <td>${escapeHtml(durationLabel(attempt.usage?.durationMs))}</td>
          <td>${escapeHtml(costEvidence.amount)}<span class="pipeline-team-subtle">${escapeHtml(costEvidence.detail)} · ${escapeHtml(energyEvidence.energy)} local energy · ${escapeHtml(energyEvidence.cost)} electricity</span></td>
        </tr>`;
    }).join('');
  }

  async function loadTeamPerformance() {
    state.performanceError = null;
    state.performance = null;
    ['Accepted', 'FirstPass', 'Cycle', 'Interventions', 'Cost', 'Coverage'].forEach((name) => {
      teamMetric(`pipelineTeam${name}`, '--', `pipelineTeam${name}Detail`, 'Loading selected period…');
    });
    $('pipelineTeamState').innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Loading selected attempt period…</span>';
    $('pipelineTeamAttemptRows').innerHTML = '<tr><td colspan="7" class="pipeline-empty">Loading selected attempt period…</td></tr>';
    $('pipelineTeamAttemptMeta').textContent = 'Loading selected period…';
    try {
      const payload = await readProjection('performance', `/api/pipeline/performance?window=${encodeURIComponent(state.performanceWindow)}`);
      if (!payload) return;
      state.performance = payload?.data?.performance || null;
      if (!state.performance) throw new Error('performance response is missing data.performance');
    } catch (error) {
      state.performance = null;
      state.performanceError = String(error.message || error);
    }
    renderTeamPerformance();
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
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
    else $('pipelineProgression')?.focus({ preventScroll: true });
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
      const payload = await readProjection('dossier', `/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      if (!payload) return;
      const task = payload && payload.data ? payload.data.task : null;
      if (!task || state.drawer.pipelineId !== pipelineId) return;
      state.drawer.task = task;
      renderDrawer(task);
    } catch (error) {
      if (!state.drawer.open || state.drawer.pipelineId !== pipelineId) return;
      body.innerHTML = `<div class="pipeline-error"><i class="fas fa-circle-exclamation" aria-hidden="true"></i> ${escapeHtml(error.message || error)}</div>`;
    }
  }

  function metaRow(label, value) {
    return `<div class="pipeline-drawer-meta-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  }

  function repositoryPathList(paths) {
    const values = Array.isArray(paths) ? paths.filter((value) => typeof value === 'string' && value) : [];
    return values.length
      ? `<ul class="pipeline-drawer-paths">${values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`
      : '<span class="pipeline-subtle">Not declared</span>';
  }

  function inferenceSummary(progress) {
    const causes = {
      workload_reserved: 'the host is reserved by another workload',
      maintenance_active: 'host maintenance is active',
      inference_active: 'another inference holds the host',
      inference_residency_active: 'another active inference uses incompatible model settings',
      inference_recovery_required: 'a previous inference has an unknown terminal state',
      maintenance_recovery_required: 'maintenance requires recovery',
      workload_proof_invalid: 'the workload reservation is invalid or expired',
      workload_recovery_required: 'the reserved workload requires recovery',
      admission_conflict_unclassified: 'the admission conflict could not be classified safely',
      connection_unavailable: 'the connection failed before the request was sent',
      provider_temporarily_unavailable: 'the local provider is temporarily unavailable',
      provider_rejected: 'the provider rejected the request',
      stream_interrupted: 'the response stream was interrupted',
      stream_completion_unverified: 'the response did not complete with a verified release',
    };
    const cause = causes[progress.cause] || progress.cause || '';
    const states = { waiting: 'Waiting to retry inference', streaming: 'Receiving model response',
      completed: 'Model call completed', exhausted: 'Inference retry limit reached',
      failed: 'Inference failed', cancelled: 'Inference cancelled', recovery_required: 'Explicit recovery required' };
    return `${states[progress.state] || 'Inference in progress'}${cause ? `: ${cause}` : ''}${progress.attempts ? ` (call attempt ${progress.attempts}/6)` : ''}${progress.nextRetryAt ? ` · next try ${formatDate(progress.nextRetryAt)}` : ''}`;
  }

  function attemptHumanSummary(attempt, evidence) {
    const codes = new Set(Array.isArray(evidence.failureCodes) ? evidence.failureCodes : []);
    const verification = evidence.verification || {};
    const happened = [];
    const next = [];
    const attributionFailed = codes.has('attribution_request_count_mismatch')
      || codes.has('attribution_session_model_mismatch');

    if (codes.has('worker_process_failed')) {
      happened.push(evidence.inference ? inferenceSummary(evidence.inference)
        : 'The worker stopped with an execution error before post-run verification.');
      next.push('Inspect the execution cause. No task or tool replay was performed automatically.');
    }

    if (codes.has('independent_verification_failed')) {
      happened.push('The exact changed checkout failed its independent verification profile.');
      next.push('Correct only the failing verification or implementation evidence, deploy the guard, then rerun this task.');
    }
    if (codes.has('attribution_request_count_mismatch')) {
      happened.push('The server request count and the OpenClaw session call count did not agree.');
    }
    if (codes.has('attribution_session_model_mismatch')) {
      happened.push('The OpenClaw session model did not match the model requested for the attested run.');
    }
    if (codes.has('cost_evidence_unavailable')) {
      happened.push('The provider-spend receipt was unavailable; the dossier does not treat unknown cost as zero.');
    }
    if (attributionFailed) {
      next.push('Inspect the session receipt and model binding before accepting another result.');
    }
    if (codes.size > 0 && happened.length === 0) {
      happened.push('One or more mandatory guarded-dispatch gates failed; the machine codes and audit trail identify the exact controls.');
      next.push('Resolve the recorded gate failure, then rerun under the same reviewed scope.');
    }

    if (codes.size > 0) {
      return {
        stage: codes.has('worker_process_failed') ? 'Worker execution'
          : codes.has('independent_verification_failed') && attributionFailed
          ? 'Independent verification and attribution'
          : codes.has('independent_verification_failed')
            ? 'Independent verification'
            : attributionFailed
              ? 'Session attribution'
              : 'Guarded dispatch',
        happened: happened.join(' '),
        impact: 'The attempt is blocked and cannot become completion evidence or a PR candidate.',
        next: Array.from(new Set(next)).join(' '),
      };
    }
    if (verification.status === 'passed') {
      return {
        stage: 'Human review handoff',
        happened: 'The worker stopped and the exact changed checkout passed its independent verification profile.',
        impact: 'The result is a review candidate only; it has not been approved, merged, or deployed.',
        next: attempt.reviewedAt ? 'Follow the recorded human review outcome.' : 'A human reviewer must accept or reject the result.',
      };
    }
    return {
      stage: 'Worker attempt',
      happened: attempt.completedAt ? 'The attempt ended without complete verification evidence.' : 'The bounded worker attempt is still active.',
      impact: 'No completion or promotion may be inferred from this state.',
      next: 'Wait for a terminal guarded result or inspect the audit trail if progress stops.',
    };
  }

  function renderAttemptDossier(task) {
    const attempts = Array.isArray(task.automationAttempts) ? task.automationAttempts.slice().reverse() : [];
    if (!task.automation && attempts.length === 0) return '';
    const automation = task.automation || {};
    const cards = attempts.map((attempt) => {
      const evidence = attempt.evidence || {};
      const verification = evidence.verification || {};
      const changes = evidence.changes || {};
      const usage = evidence.usage || {};
      const cost = costEvidencePresentation(usage);
      const energy = localEnergyPresentation(usage.localEnergy);
      const failureCodes = Array.isArray(evidence.failureCodes) ? evidence.failureCodes : [];
      const humanSummary = attemptHumanSummary(attempt, evidence);
      const tests = verification.testsPassed == null && verification.testsFailed == null
        ? 'Unknown'
        : `${verification.testsPassed ?? '?'} passed · ${verification.testsFailed ?? '?'} failed`;
      const changed = changes.filesChanged == null && changes.bytesChanged == null
        ? 'Unknown'
        : `${changes.filesChanged ?? '?'} files · ${changes.bytesChanged == null ? '?' : Number(changes.bytesChanged).toLocaleString()} B`;
      return `
        <article class="pipeline-attempt-dossier">
          <header>
            <strong>Attempt ${escapeHtml(attempt.attempt || '?')}</strong>
            <span class="pipeline-team-outcome">${escapeHtml(formatStatus(attemptOutcome(attempt)))}</span>
          </header>
          <dl class="pipeline-drawer-meta">
            ${metaRow('Worker', escapeHtml(attempt.assignee || 'unknown'))}
            ${metaRow('Lifecycle', escapeHtml(`${formatDate(attempt.acquiredAt)} → ${attempt.completedAt ? formatDate(attempt.completedAt) : 'active'}`))}
            ${metaRow('Review', escapeHtml(attempt.reviewedAt ? `${formatStatus(attempt.reviewOutcome)} · ${formatDate(attempt.reviewedAt)}` : formatStatus(attempt.reviewOutcome || 'pending')))}
            ${metaRow('Verification', escapeHtml(`${formatStatus(verification.status || 'unknown')} · ${durationLabel(verification.durationMs)}`))}
            ${metaRow('Tests', escapeHtml(tests))}
            ${metaRow('Change', escapeHtml(changed))}
            ${metaRow('Execution', escapeHtml(durationLabel(usage.durationMs)))}
            ${evidence.inference ? metaRow('Model call', escapeHtml(inferenceSummary(evidence.inference))) : ''}
            ${metaRow('Provider/session', `${escapeHtml(cost.amount)}<span class="pipeline-team-subtle">${escapeHtml(cost.detail)}</span>`)}
            ${metaRow('Local energy', `${escapeHtml(energy.energy)}<span class="pipeline-team-subtle">${escapeHtml(energy.detail)}</span>`)}
            ${metaRow('Electricity', escapeHtml(energy.cost))}
            ${metaRow('Step', escapeHtml(humanSummary.stage))}
            ${metaRow('What happened', escapeHtml(humanSummary.happened))}
            ${metaRow('Impact', escapeHtml(humanSummary.impact))}
            ${metaRow('Next action', escapeHtml(humanSummary.next))}
            ${failureCodes.length ? metaRow('Failure codes', failureCodes.map((code) => `<code>${escapeHtml(code)}</code>`).join(' ')) : ''}
          </dl>
        </article>`;
    }).join('');
    return `
      <section class="pipeline-drawer-section">
        <h3><i class="fas fa-magnifying-glass-chart" aria-hidden="true"></i> Operator attempt dossier <span class="pipeline-drawer-count">${attempts.length}</span></h3>
        <p class="pipeline-drawer-privacy">Prompts, inference transcripts, tool payloads, raw verifier output, secrets, hostnames, and absolute paths are intentionally not retained here.</p>
        <dl class="pipeline-drawer-meta">
          ${metaRow('Policy', escapeHtml(automation.policyRef || '--'))}
          ${metaRow('Profile', escapeHtml(automation.executionProfile || '--'))}
          ${metaRow('Editable scope', repositoryPathList(automation.scope))}
          ${metaRow('Authority sources', repositoryPathList(automation.sourceFiles))}
        </dl>
        ${cards || '<div class="pipeline-empty">No coding attempt recorded yet.</div>'}
      </section>`;
  }

  function preserveDrawerDraft(body) {
    const fields = Array.from(body.querySelectorAll('input[name], textarea[name], select[name]'));
    return {
      scrollTop: body.scrollTop,
      fields: fields.map(el => ({ key: `${el.closest('form')?.dataset.drawerAction}:${el.name}`, value: el.value,
        checked: el.checked, focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd })),
      details: Array.from(body.querySelectorAll('details')).map(el => el.open)
    };
  }

  function latestTeamUpdate(task) {
    const entries = Array.isArray(task.feedback) ? task.feedback : [];
    const latest = task.status === 'blocked'
      ? entries.slice().reverse().find(entry => ['coding-team', 'guarded-dispatch', task.assignee].includes(entry.by)) || entries.at(-1)
      : entries.at(-1);
    const text = String(latest?.text || '');
    const question = text.match(/Worker question or problem \(not verification evidence\):\s*([\s\S]*?)\n\nThe worker feedback/);
    const message = (question ? question[1] : text).trim();
    return message.length > 1600 ? `${message.slice(0, 1600)}… Full details are in the audit trail below.` : message;
  }

  function restoreDrawerDraft(body, draft) {
    for (const el of body.querySelectorAll('input[name], textarea[name], select[name]')) {
      const saved = draft.fields.find(item => item.key === `${el.closest('form')?.dataset.drawerAction}:${el.name}`);
      if (!saved) continue;
      el.value = saved.value;
      if (typeof saved.checked === 'boolean') el.checked = saved.checked;
      if (saved.focused) {
        el.focus({ preventScroll: true });
        if (typeof saved.start === 'number' && typeof el.setSelectionRange === 'function') el.setSelectionRange(saved.start, saved.end);
      }
    }
    Array.from(body.querySelectorAll('details')).forEach((el, index) => { el.open = draft.details[index] || false; });
    body.scrollTop = draft.scrollTop;
  }

  function renderDrawer(task, { preserveDraft = false } = {}) {
    const { title, id, body } = drawerEls();
    if (title) title.textContent = task.title || 'Untitled task';
    if (id) id.textContent = `#${task.pipelineId}`;
    if (!body) return;
    const draft = preserveDraft ? preserveDrawerDraft(body) : null;
    if (draft) {
      const currentKeys = new Set(draft.fields.map(field => field.key));
      draft.fields.push(...(state.drawer.draft?.fields || []).filter(field => !currentKeys.has(field.key)));
    }
    state.drawer.draft = draft;

    const feedback = Array.isArray(task.feedback) ? task.feedback.slice().reverse() : [];
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const reviewer = readStorage(STORAGE_REVIEWER) || '';
    const review = task.status === 'review' ? reviewContext(task) : null;
    const deliveryItem = Array.isArray(state.delivery?.items)
      ? state.delivery.items.find((item) => item?.pipelineId === task.pipelineId)
      : null;
    const closedUnmergedDelivery = task.status === 'done'
      && deliveryItem?.stage === 'merge_blocked'
      && String(deliveryItem?.pullRequest?.state || '').toLowerCase() === 'closed';

    const actions = [];
    const codingTask = !['personal', 'family', 'household', 'secretary'].includes(String(task.service).toLowerCase());
    if (task.status === 'queued' && !task.assignee && codingTask) {
      actions.push(`<form class="pipeline-drawer-action" data-drawer-action="give-to-team">
        <p>Describe the result in this ticket. The team prepares the work and returns any question here.</p>
        <button type="submit" class="pipeline-btn primary">Give to the team</button></form>`);
    }
    if (task.status === 'blocked' && codingTask && (!task.assignee || task.automation?.mode === 'review_only')) {
      actions.unshift(`<form class="pipeline-drawer-action" data-drawer-action="reply-resume">
        <label><span>Your answer or correction</span><textarea name="answer" rows="4" maxlength="3000" required placeholder="Answer the question or explain what should change."></textarea></label>
        <button type="submit" class="pipeline-btn primary">Reply and resume</button>
      </form>`);
    }
    if (task.status === 'review') {
      actions.push(`
        <form class="pipeline-drawer-action" data-drawer-action="confirm-done">
          <p><strong>${escapeHtml(review.label)}</strong><br>${escapeHtml(review.detail)} ${escapeHtml(review.action)}</p>
          <label>
            <span>Accept result as (must differ from worker <code>${escapeHtml(task.assignee || 'unassigned')}</code>)</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. yanik" value="${escapeHtml(reviewer)}">
          </label>
          <button type="submit" class="pipeline-btn primary compact"><i class="fas fa-check-double"></i><span>Accept result</span></button>
        </form>
      `);
    }
    if (task.status === 'review' || closedUnmergedDelivery) {
      const correctionDetail = closedUnmergedDelivery
        ? `PR #${deliveryItem.pullRequest.number} is closed without merge. Record the required replacement, release the accepted result, and return this exact task to the guarded queue.`
        : 'Record a precise reason, release the claim, and return this exact task to the guarded queue.';
      actions.push(`
        <form class="pipeline-drawer-action" data-drawer-action="request-correction">
          <p><strong>Request a correction</strong><br>${escapeHtml(correctionDetail)}</p>
          <label>
            <span>Reviewer identity</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. yanik" value="${escapeHtml(reviewer)}">
          </label>
          <label>
            <span>Correction required</span>
            <textarea name="reason" rows="3" maxlength="5000" required placeholder="What exact evidence or implementation must change?"></textarea>
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-rotate-left"></i><span>Request correction</span></button>
        </form>
      `);
    }
    if (['in_progress', 'blocked'].includes(task.status)) {
      actions.push(`
        <details><summary>Release worker claim</summary><div class="pipeline-drawer-action">
          <p>Release the task back to the queue. The worker claim and heartbeat are cleared.</p>
          <button type="button" class="pipeline-btn compact" data-drawer-action="requeue"><i class="fas fa-rotate-left"></i><span>Re-queue task</span></button>
        </div></details>
      `);
    }
    if (task.status !== 'done') {
      // Supersede is a two-step human decision: preview the exact transition
      // and its checks first (no mutation), then confirm or cancel.
      actions.push(`
        <details><summary>Replace this task</summary><form class="pipeline-drawer-action" data-drawer-action="supersede-preview">
          <p><strong>Mark superseded</strong><br>Close this task in favour of its replacement. Nothing is re-queued; the decision is written to both audit trails and the task can only be reopened deliberately.</p>
          <label>
            <span>Replaced by (pipeline id)</span>
            <input type="text" name="supersededBy" required maxlength="16" pattern="[0-9A-Za-z_-]+" placeholder="e.g. 0620" value="${escapeHtml(state.drawer.supersede?.supersededBy || '')}">
          </label>
          <label>
            <span>Reason</span>
            <textarea name="reason" rows="2" maxlength="2000" minlength="8" required placeholder="Why this task no longer applies and what replaces it">${escapeHtml(state.drawer.supersede?.reason || '')}</textarea>
          </label>
          <label>
            <span>Decided by</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. yanik" value="${escapeHtml(reviewer)}">
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-code-branch"></i><span>Preview supersede</span></button>
        </form>
        ${renderSupersedePreview(task)}</details>
      `);
    }
    if (task.status !== 'done') {
      actions.push(`
        <details><summary>Add a note</summary><form class="pipeline-drawer-action" data-drawer-action="add-note">
          <label>
            <span>Add a note to the audit trail</span>
            <textarea name="text" rows="2" maxlength="5000" required placeholder="What should workers and human reviewers know?"></textarea>
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-pen"></i><span>Add note</span></button>
        </form></details>
      `);
    }

    const resolution = task.resolution && task.resolution.kind === 'superseded' ? task.resolution : null;
    body.innerHTML = `
      <div class="pipeline-drawer-status">${statusBadge(task.status)} ${priorityChip(task.priority)} ${riskChip(task.risk)}${resolution ? ` <span class="pipeline-chip pipeline-chip-superseded" title="${escapeHtml(resolution.reason || '')}"><i class="fas fa-code-branch" aria-hidden="true"></i> Superseded by <a href="/pipeline?task=${encodeURIComponent(resolution.supersededBy)}">#${escapeHtml(resolution.supersededBy)}</a></span>` : ''}</div>
      ${feedback.length ? `<section class="pipeline-drawer-section"><h3>${task.status === 'blocked' ? 'Your team needs an answer' : 'Latest update'}</h3><p class="pipeline-drawer-spec">${escapeHtml(latestTeamUpdate(task))}</p></section>` : ''}
      ${task.spec ? `<section class="pipeline-drawer-section">${task.status === 'blocked' ? '<details><summary>Requested result</summary>' : '<h3>Requested result</h3>'}<pre class="pipeline-drawer-spec">${escapeHtml(task.spec)}</pre>${task.status === 'blocked' ? '</details>' : ''}</section>` : ''}
      ${actions.length ? `<section class="pipeline-drawer-section"><h3>Next action</h3>${actions.join('')}</section>` : ''}
      <button type="button" class="pipeline-btn" data-edit-pipeline-task="${escapeHtml(task.pipelineId)}"><i class="fas fa-pen" aria-hidden="true"></i><span>Edit task</span></button>
      ${resolution ? `<div class="pipeline-drawer-resolution"><strong>Superseded</strong> by <code>${escapeHtml(resolution.supersededBy)}</code> · ${escapeHtml(resolution.by || 'operator')} · ${escapeHtml(formatDate(resolution.at))}<br>${escapeHtml(resolution.reason || '')}<br><span class="pipeline-muted">Closed without delivery. Reopening requires an explicit decision; it never re-queues by itself.</span></div>` : ''}
      <details><summary>Task details</summary><dl class="pipeline-drawer-meta">
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
      </dl></details>
      ${renderAttemptDossier(task)}
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
    if (draft) restoreDrawerDraft(body, draft);
    const unsentAnswer = draft?.fields.find(field => field.key === 'reply-resume:answer' && field.value.trim());
    if (unsentAnswer && !body.querySelector('form[data-drawer-action="reply-resume"]')) {
      const saved = document.createElement('section');
      saved.className = 'pipeline-drawer-section';
      saved.innerHTML = '<h3>Unsent answer preserved</h3><p>The task changed while you were writing. Your text is kept here for copying or a later reply.</p><pre class="pipeline-drawer-spec"></pre>';
      saved.querySelector('pre').textContent = unsentAnswer.value;
      body.prepend(saved);
    }
  }

  async function refreshDrawerTask({ preserveDraft = false } = {}) {
    const pipelineId = state.drawer.pipelineId;
    if (!pipelineId || (preserveDraft && state.drawer.mutating)) return;
    try {
      const payload = await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      const task = payload && payload.data ? payload.data.task : null;
      if (task && state.drawer.pipelineId === pipelineId && !(preserveDraft && state.drawer.mutating)) {
        state.drawer.task = task;
        renderDrawer(task, { preserveDraft });
      }
    } catch { /* the list refresh below still reflects truth */ }
  }

  /**
   * Preview panel for a pending supersede decision: the exact transition,
   * every server-side check, and explicit confirm / cancel controls. Rendered
   * only while a preview is held in drawer state; nothing has been applied.
   */
  function renderSupersedePreview(task) {
    const preview = state.drawer.supersede?.preview;
    if (!preview || state.drawer.supersede.pipelineId !== task.pipelineId) return '';
    const t = preview.transition || {};
    const checks = Array.isArray(preview.checks) ? preview.checks : [];
    return `
      <div class="pipeline-drawer-action pipeline-supersede-preview" data-supersede-preview="${preview.ok ? 'ok' : 'blocked'}">
        <p><strong>Preview</strong> — nothing has changed yet.</p>
        <p><code>#${escapeHtml(t.pipelineId || task.pipelineId)}</code> ${escapeHtml(t.from || task.status)} → <strong>${escapeHtml(t.to || 'done')}</strong> · superseded by <code>#${escapeHtml(t.resolution?.supersededBy || '')}</code> · decided by ${escapeHtml(t.resolution?.by || '')}<br>
        ${t.keepsAssignee ? `Owner ${escapeHtml(t.keepsAssignee)} stays on record. ` : ''}${t.clearsHeartbeat ? 'The heartbeat is cleared. ' : ''}No re-queue. Reopen ${escapeHtml(t.reopen || 'only deliberately')}.</p>
        <ul class="pipeline-supersede-checks">
          ${checks.map((check) => `<li data-check="${escapeHtml(check.id)}" data-ok="${check.ok ? 'true' : 'false'}"><i class="fas ${check.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i> ${escapeHtml(check.id.replace(/_/g, ' '))}: ${escapeHtml(check.detail || '')}</li>`).join('')}
        </ul>
        <div class="pipeline-drawer-action-row">
          <form data-drawer-action="supersede-confirm" style="display:inline">
            <button type="submit" class="pipeline-btn primary compact" ${preview.ok ? '' : 'disabled'}><i class="fas fa-check"></i><span>Confirm supersede</span></button>
          </form>
          <button type="button" class="pipeline-btn compact" data-drawer-action="supersede-cancel"><i class="fas fa-xmark"></i><span>Cancel</span></button>
        </div>
      </div>`;
  }

  async function handleDrawerAction(action, form) {
    const pipelineId = state.drawer.pipelineId;
    if (!pipelineId || state.drawer.mutating) return;
    state.drawer.mutating = true;
    const submit = form?.querySelector('button[type="submit"]');
    const submitLabel = submit?.innerHTML;
    if (submit) submit.disabled = true;
    try {
      if (action === 'give-to-team' || action === 'reply-resume') {
        if (submit) submit.textContent = 'Handing task to the team…';
        const answer = action === 'reply-resume' ? String(new FormData(form).get('answer') || '').trim() : '';
        await giveTaskToTeam(pipelineId, answer);
      } else if (action === 'supersede-preview') {
        const data = new FormData(form);
        const supersededBy = String(data.get('supersededBy') || '').trim();
        const reason = String(data.get('reason') || '').trim();
        const by = String(data.get('by') || '').trim();
        if (!supersededBy || !reason || !by) return;
        writeStorage(STORAGE_REVIEWER, by);
        const payload = await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/supersede`, {
          method: 'POST',
          body: JSON.stringify({ supersededBy, reason, by })
        });
        const preview = payload && payload.data ? payload.data : null;
        state.drawer.supersede = { pipelineId, supersededBy, reason, by, preview };
        if (state.drawer.task) renderDrawer(state.drawer.task);
        toast(preview?.ok ? 'info' : 'error', preview?.ok
          ? `Preview ready for task ${pipelineId}; confirm or cancel.`
          : `Supersede blocked: ${(preview?.blocked || []).join(', ') || 'checks failed'}.`);
        return;
      } else if (action === 'supersede-cancel') {
        state.drawer.supersede = null;
        if (state.drawer.task) renderDrawer(state.drawer.task);
        return;
      } else if (action === 'supersede-confirm') {
        const pending = state.drawer.supersede;
        if (!pending || pending.pipelineId !== pipelineId || !pending.preview?.ok) return;
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/supersede`, {
          method: 'POST',
          body: JSON.stringify({ supersededBy: pending.supersededBy, reason: pending.reason, by: pending.by, confirm: true })
        });
        state.drawer.supersede = null;
        toast('success', `Task ${pipelineId} superseded by ${pending.supersededBy}.`);
      } else if (action === 'confirm-done') {
        const by = String(new FormData(form).get('by') || '').trim();
        if (!by) return;
        writeStorage(STORAGE_REVIEWER, by);
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'done', by })
        });
        toast('success', `Task ${pipelineId} confirmed done by ${by}.`);
      } else if (action === 'request-correction') {
        const data = new FormData(form);
        const by = String(data.get('by') || '').trim();
        const reason = String(data.get('reason') || '').trim();
        if (!by || !reason) return;
        if (normalizedIdentity(by) === normalizedIdentity(state.drawer.task?.assignee)) {
          throw new Error('The reviewer identity must differ from the worker.');
        }
        writeStorage(STORAGE_REVIEWER, by);
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/feedback`, {
          method: 'POST',
          body: JSON.stringify({ text: `Correction requested: ${reason}`, by })
        });
        await fetchJson(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'queued', by })
        });
        toast('success', `Correction requested for task ${pipelineId}; it is back in the guarded queue.`);
        if (state.drawer.task?.automation?.mode === 'review_only') await giveTaskToTeam(pipelineId);
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
    } finally {
      state.drawer.mutating = false;
      if (submit?.isConnected) { submit.disabled = false; submit.innerHTML = submitLabel; }
    }
  }

  async function giveTaskToTeam(pipelineId, answer = '') {
    toast('info', 'Preparing this task for the team…');
    const payload = await fetchJson('/api/runtime-bridges/coding-dispatch/prepare', {
      method: 'POST', body: JSON.stringify({ pipelineId, answer })
    });
    if (!payload?.data?.ready) {
      toast('info', payload?.data?.question || 'The team left an update on this ticket.');
      return;
    }
    await state.launchController.refresh();
    if (!await state.launchController.launch(pipelineId)) throw new Error('The task is prepared. The worker is busy or admission changed; use Run one task when available.');
    toast('success', `Task ${pipelineId} handed to the team.`);
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
    setPageState('blocked', 'fa-circle-exclamation', state.tasks.length ? 'Task refresh failed · last observation retained' : 'Pipeline unreachable', String(error.message || error));
    if (state.tasks.length) return;
    $('pipelineProgression').innerHTML = '<div class="pipeline-empty">Task evidence unavailable. <button class="pipeline-btn compact" data-retry-load>Retry tasks</button></div>';
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
    if (state.taskError) renderError(state.taskError); else summarizeState();
    renderEvidence();
    renderFilterOptions();
    renderFilterControls();
    renderOpenWork();
    renderProgression();
    renderAttention();
    renderRecentlyDone();
    renderDispatchControl();
  }

  async function loadTasks({ auxiliary = true } = {}) {
    const version = ++state.taskReadVersion;
    setLoading(true);
    if (auxiliary) {
      loadTeamPerformance();
      loadDeliveryStatus();
      loadDispatchControlStatus();
    }
    try {
      const payload = await readProjection('tasks', '/api/pipeline/tasks?limit=1000&view=summary&includeDone=true');
      if (!payload) return;
      const normalized = normalizePayload(payload);
      state.tasks = normalized.tasks;
      state.summary = normalized.summary;
      state.evidence = normalized.evidence;
      state.taskError = null;
      renderAll();
      await refreshDrawerTask({ preserveDraft: true });
      if (state.deepLinkedTask) {
        const pipelineId = state.deepLinkedTask;
        state.deepLinkedTask = null;
        openDrawer(pipelineId, null);
      }
    } catch (error) {
      if (version === state.taskReadVersion) { state.taskError = error; renderError(error); }
    } finally {
      if (version === state.taskReadVersion) setLoading(false);
    }
  }

  function setAutoRefresh(enabled) {
    const btn = $('pipelineAutoBtn');
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    if (enabled) {
      state.autoTimer = window.setInterval(() => { if (!document.hidden) loadTasks({ silent: true }); }, AUTO_REFRESH_MS);
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
    state.filters = { status: null, search: '', service: '', lane: '', epic: '' };
    if ($('pipelineEpicFilter')) $('pipelineEpicFilter').value = '';
    const search = $('pipelineSearch');
    if (search) search.value = '';
    const service = $('pipelineServiceFilter');
    if (service) service.value = '';
    const lane = $('pipelineLaneFilter');
    if (lane) lane.value = '';
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', () => {
    let storage;
    try { storage = window.localStorage; } catch { /* Host receipts support reload recovery without storage. */ }
    state.launchController = new window.PipelineLaunchController({
      request: fetchJson, storage, onChange: renderDispatchControl,
      refreshTasks: () => loadTasks({ auxiliary: false })
    });
    $('pipelineTeamLaunchRefresh')?.addEventListener('click', () => {
      loadDispatchControlStatus();
      loadTasks({ auxiliary: false });
    });
    $('pipelineTeamLaunchRetry')?.addEventListener('click', () => state.launchController.retry());
    window.addEventListener('pagehide', event => { if (!event.persisted) state.launchController.dispose(); });
    const refresh = $('pipelineRefreshBtn');
    if (refresh) refresh.addEventListener('click', () => loadTasks());

    const autoBtn = $('pipelineAutoBtn');
    if (autoBtn) {
      autoBtn.addEventListener('click', () => {
        setAutoRefresh(autoBtn.getAttribute('aria-pressed') !== 'true');
      });
    }

    const teamWindow = $('pipelineTeamWindow');
    if (teamWindow) {
      teamWindow.value = state.performanceWindow;
      teamWindow.addEventListener('change', () => {
        state.performanceWindow = teamWindow.value;
        loadTeamPerformance();
      });
    }

    const launchSelect = $('pipelineTeamLaunchTask');
    const launchConfirm = $('pipelineTeamLaunchConfirm');
    const launchForm = $('pipelineTeamLaunchForm');
    if (launchSelect) launchSelect.addEventListener('change', () => {
      if (launchConfirm) launchConfirm.checked = false;
      renderDispatchControl();
    });
    if (launchConfirm) launchConfirm.addEventListener('change', renderDispatchControl);
    if (launchForm) launchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      launchOneTask();
    });

    document.querySelectorAll('.pipeline-metric[data-status-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.statusFilter;
        state.filters.status = state.filters.status === status ? null : status;
        renderAll();
        $('pipelineOverview').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        $('pipelineProgression').focus({ preventScroll: true });
      });
    });

    const search = $('pipelineSearch');
    if (search) {
      search.addEventListener('input', () => {
        state.filters.search = search.value.trim();
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

    const lane = $('pipelineLaneFilter');
    if (lane) {
      lane.addEventListener('change', () => {
        state.filters.lane = lane.value;
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

    $('pipelineEpicFilter')?.addEventListener('change', (event) => { state.filters.epic = event.target.value; state.expandedStages.clear(); renderAll(); });
    $('pipelineIncludeDone')?.addEventListener('change', (event) => { state.includeDone = event.target.checked; renderProgression(); });
    document.querySelectorAll('[data-pipeline-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.pipelineView; renderProgression(); }));
    $('pipelineProgression')?.addEventListener('click', (event) => {
      const more = event.target.closest('[data-more-stage]');
      if (more) { state.expandedStages.add(more.dataset.moreStage); renderProgression(); }
      if (event.target.closest('[data-more-events]')) { state.timelineLimit += 60; renderProgression(); }
    });
    const clear = $('pipelineClearFilters');
    if (clear) clear.addEventListener('click', clearFilters);

    document.addEventListener('click', (event) => {
      const edit = event.target.closest('[data-edit-pipeline-task]');
      if (edit) { window.PipelineTaskEditor.open(edit.dataset.editPipelineTask, state.tasks); return; }
      if (event.target.closest('#pipelineNewTask, [data-pipeline-new-task]')) { window.PipelineTaskEditor.open(null, state.tasks); return; }
      if (event.target.closest('[data-retry-delivery]')) { loadDeliveryStatus(); return; }
      const retry = event.target.closest('[data-retry-load]');
      if (retry) { loadTasks(); return; }
      const clearBtn = event.target.closest('[data-clear-filters]');
      if (clearBtn) { clearFilters(); return; }
      const closer = event.target.closest('[data-close-pipeline-drawer]');
      if (closer) { closeDrawer(); return; }
      const requeue = event.target.closest('button[data-drawer-action="requeue"]');
      if (requeue) { handleDrawerAction('requeue', null); return; }
      const cancelSupersede = event.target.closest('button[data-drawer-action="supersede-cancel"]');
      if (cancelSupersede) { handleDrawerAction('supersede-cancel', null); return; }
      const merge = event.target.closest('button[data-delivery-merge]');
      if (merge) { mergeDeliveryItem(merge); return; }
      const taskEl = event.target.closest('[data-pipeline-task]');
      if (taskEl) openDrawer(taskEl.dataset.pipelineTask, taskEl);
    });

    document.addEventListener('keydown', (event) => {
      if ($('pipelineTaskEditor')?.open) return;
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

    document.addEventListener('pipeline-task-saved', async (event) => {
      await loadTasks();
      openDrawer(event.detail.pipelineId, $('pipelineNewTask'));
    });
    if (readStorage(STORAGE_AUTO) !== '0') setAutoRefresh(true);
    loadTasks();
  });
})();

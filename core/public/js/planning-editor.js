(function () {
  'use strict';

  const DEFAULT_STATUS = {
    workstream: 'draft',
    outcome: 'draft',
    milestone: 'draft',
    idea: 'inbox',
    decision: 'draft'
  };
  const TYPE_FORM_META = {
    workstream: {
      label: 'Workstream',
      icon: 'fa-diagram-project',
      subtitle: 'A durable strategic area that groups related goals and delivery.'
    },
    outcome: {
      label: 'Goal / outcome',
      icon: 'fa-bullseye',
      subtitle: 'A measurable definition of success, not a list of tasks.'
    },
    milestone: {
      label: 'Milestone',
      icon: 'fa-flag-checkered',
      subtitle: 'A concrete delivery checkpoint with a target horizon.'
    },
    idea: {
      label: 'Idea',
      icon: 'fa-lightbulb',
      subtitle: 'Capture a possibility without turning it into a commitment.'
    },
    decision: {
      label: 'Decision',
      icon: 'fa-scale-balanced',
      subtitle: 'Preserve the context, choice, rationale, and alternatives.'
    }
  };
  let pendingTask = null;
  let currentItemId = null;

  const $ = (id) => document.getElementById(id);
  const app = () => window.PlanningApp;
  const esc = (value) => app().esc(value);
  const formatStatus = (value) => app().formatStatus(value);

  function inputValue(id) {
    return $(id)?.value ?? '';
  }

  function numberOrNull(value) {
    return value === '' || value == null ? null : Number(value);
  }

  function isoDate(value) {
    if (!value) return '';
    const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  }

  function relationCandidates(type, currentId = '') {
    const allowed = {
      outcome: ['workstream'],
      milestone: ['workstream', 'outcome'],
      decision: ['workstream', 'outcome', 'milestone'],
      idea: []
    }[type] || [];
    return (app().state.dashboard?.items || []).filter((item) =>
      allowed.includes(item.type) && item.id !== currentId
    );
  }

  function populateRelations({
    selectedWorkstream = inputValue('planningFormWorkstream'),
    selectedParent = inputValue('planningFormParent'),
    type = inputValue('planningFormType'),
    currentId = inputValue('planningFormId')
  } = {}) {
    const workstreams = (app().state.dashboard?.items || []).filter((item) =>
      item.type === 'workstream' && item.id !== currentId
    );
    $('planningFormWorkstream').innerHTML = '<option value="">None</option>' + workstreams.map((item) =>
      `<option value="${esc(item.id)}"${item.id === selectedWorkstream ? ' selected' : ''}>${esc(item.title)}</option>`
    ).join('');

    const parents = relationCandidates(type, currentId).filter((item) => {
      if (!selectedWorkstream) return true;
      return item.id === selectedWorkstream || String(item.workstreamId || '') === selectedWorkstream;
    });
    $('planningFormParent').innerHTML = '<option value="">No direct parent</option>' + parents.map((item) =>
      `<option value="${esc(item.id)}"${item.id === selectedParent ? ' selected' : ''}>${esc(app().typeMeta[item.type]?.label || item.type)} · ${esc(item.title)}</option>`
    ).join('');
  }

  function syncConditionalFields() {
    const type = inputValue('planningFormType');
    const mode = inputValue('planningFormProgressMode');
    const meta = TYPE_FORM_META[type] || TYPE_FORM_META.workstream;
    $('planningModalTypeLabel').textContent = meta.label;
    $('planningModalSubtitle').textContent = meta.subtitle;
    $('planningModalTypeIcon').innerHTML = `<i class="fas ${meta.icon}"></i>`;
    $('planningWorkstreamField').hidden = type === 'workstream';
    $('planningParentField').hidden = ['workstream', 'idea'].includes(type);
    $('planningPriorityField').hidden = type === 'decision';
    $('planningProgressField').hidden = ['idea', 'decision'].includes(type);
    $('planningStartField').hidden = ['idea', 'decision'].includes(type);
    $('planningTargetField').hidden = ['idea', 'decision'].includes(type);
    $('planningMetricFields').hidden = type !== 'outcome' || mode !== 'metric';
    $('planningManualField').hidden = ['idea', 'decision'].includes(type) || mode !== 'manual';
    $('planningDecisionFields').hidden = type !== 'decision';
    if (!$('planningFormStatus').value) {
      $('planningFormStatus').value = DEFAULT_STATUS[type] || 'draft';
    }
  }

  function resetForm() {
    $('planningItemForm').reset();
    $('planningFormId').value = '';
    $('planningFormStatus').value = 'draft';
    $('planningFormPriority').value = 'normal';
    $('planningFormProgressMode').value = 'tasks';
    $('planningFormManual').value = '0';
    $('planningMetricDirection').value = 'increase';
    populateRelations({ selectedWorkstream: '', selectedParent: '' });
    syncConditionalFields();
  }

  function openModal() {
    $('planningModalBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('planningFormTitle').focus(), 0);
  }

  function closeModal() {
    $('planningModalBackdrop').hidden = true;
    if (!$('planningDrawer').classList.contains('open')) document.body.style.overflow = '';
    pendingTask = null;
  }

  function openCreate(options = {}) {
    resetForm();
    pendingTask = options.task || null;
    const requestedType = options.type || (pendingTask ? 'milestone' : 'workstream');
    $('planningFormType').value = requestedType;
    const defaultStatus = DEFAULT_STATUS[requestedType] || 'draft';
    $('planningFormStatus').value = defaultStatus;
    $('planningFormProgressMode').value = requestedType === 'workstream'
      ? 'children'
      : (requestedType === 'outcome' ? 'metric' : (requestedType === 'milestone' ? 'tasks' : 'manual'));
    $('planningModalTitle').textContent = pendingTask
      ? `Organize task ${pendingTask.pipelineId}`
      : `New ${TYPE_FORM_META[requestedType]?.label || requestedType}`;
    if (pendingTask) {
      $('planningFormTitle').value = pendingTask.title || '';
      $('planningFormSummary').value = `Pipeline task ${pendingTask.pipelineId}\n\n${pendingTask.epic || pendingTask.service || ''}`.trim();
      $('planningFormPriority').value = Number(pendingTask.priority) <= 2 ? 'high' : 'normal';
    }
    populateRelations({
      selectedWorkstream: options.workstreamId || '',
      selectedParent: options.parentId || '',
      type: requestedType
    });
    syncConditionalFields();
    openModal();
  }

  function fillForm(item) {
    resetForm();
    $('planningFormId').value = item.id;
    $('planningModalTitle').textContent = `Edit ${TYPE_FORM_META[item.type]?.label || item.type}`;
    $('planningFormType').value = item.type;
    $('planningFormStatus').value = item.status;
    $('planningFormTitle').value = item.title || '';
    $('planningFormSummary').value = item.summary || '';
    $('planningFormPriority').value = item.priority || 'normal';
    $('planningFormOwner').value = item.owner || '';
    populateRelations({
      selectedWorkstream: item.workstreamId ? String(item.workstreamId) : '',
      selectedParent: item.parentId ? String(item.parentId) : '',
      type: item.type,
      currentId: item.id
    });
    $('planningFormTags').value = (item.tags || []).join(', ');
    $('planningFormStartAt').value = isoDate(item.dates?.startAt);
    $('planningFormTargetAt').value = isoDate(item.dates?.targetAt);
    $('planningFormProgressMode').value = item.progress?.mode || 'tasks';
    $('planningFormManual').value = item.progress?.manual ?? 0;
    $('planningMetricLabel').value = item.progress?.metric?.label || '';
    $('planningMetricUnit').value = item.progress?.metric?.unit || '';
    $('planningMetricBaseline').value = item.progress?.metric?.baseline ?? '';
    $('planningMetricCurrent').value = item.progress?.metric?.current ?? '';
    $('planningMetricTarget').value = item.progress?.metric?.target ?? '';
    $('planningMetricDirection').value = item.progress?.metric?.direction || 'increase';
    $('planningMetricSource').value = item.progress?.metric?.sourceRef || '';
    $('planningDecisionContext').value = item.decision?.context || '';
    $('planningDecisionChoice').value = item.decision?.choice || '';
    $('planningDecisionRationale').value = item.decision?.rationale || '';
    $('planningDecisionAlternatives').value = (item.decision?.alternatives || []).join('\n');
    syncConditionalFields();
    if (app().isFrozenReference()) {
      $('planningModalSubtitle').textContent = 'Correct fields on this historical record. This does not create or change current Pipeline execution.';
    }
  }

  function formPayload() {
    const type = inputValue('planningFormType');
    return {
      type,
      title: inputValue('planningFormTitle'),
      summary: inputValue('planningFormSummary'),
      priority: inputValue('planningFormPriority'),
      owner: inputValue('planningFormOwner'),
      workstreamId: type === 'workstream' ? null : (inputValue('planningFormWorkstream') || null),
      parentId: ['workstream', 'idea'].includes(type) ? null : (inputValue('planningFormParent') || null),
      tags: inputValue('planningFormTags').split(',').map((tag) => tag.trim()).filter(Boolean),
      dates: {
        startAt: inputValue('planningFormStartAt') || null,
        targetAt: inputValue('planningFormTargetAt') || null
      },
      progress: {
        mode: inputValue('planningFormProgressMode'),
        manual: numberOrNull(inputValue('planningFormManual')) || 0,
        metric: {
          label: inputValue('planningMetricLabel'),
          unit: inputValue('planningMetricUnit'),
          baseline: numberOrNull(inputValue('planningMetricBaseline')),
          current: numberOrNull(inputValue('planningMetricCurrent')),
          target: numberOrNull(inputValue('planningMetricTarget')),
          direction: inputValue('planningMetricDirection'),
          sourceRef: inputValue('planningMetricSource')
        }
      },
      decision: {
        context: inputValue('planningDecisionContext'),
        choice: inputValue('planningDecisionChoice'),
        rationale: inputValue('planningDecisionRationale'),
        alternatives: inputValue('planningDecisionAlternatives').split('\n').map((line) => line.trim()).filter(Boolean)
      },
      by: 'operator'
    };
  }

  async function submitForm(event) {
    event.preventDefault();
    const id = inputValue('planningFormId');
    const button = $('planningFormSubmitBtn');
    button.disabled = true;
    try {
      const result = await app().api(id ? `/api/planning/items/${encodeURIComponent(id)}` : '/api/planning/items', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(formPayload())
      });
      const item = result.item;
      if (pendingTask && item?.id) {
        await app().api(`/api/planning/items/${encodeURIComponent(item.id)}/tasks/${encodeURIComponent(pendingTask.pipelineId)}`, {
          method: 'POST',
          body: JSON.stringify({ by: 'operator' })
        });
      }
      closeModal();
      await app().reload();
      if (item?.id) openItem(item.id);
    } catch (error) {
      window.Toast?.error?.(error.message);
      if (!window.Toast) alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function closeDrawer() {
    $('planningDrawer').classList.remove('open');
    $('planningDrawer').setAttribute('aria-hidden', 'true');
    $('planningDrawerBackdrop').hidden = true;
    document.body.style.overflow = '';
    currentItemId = null;
  }

  function linkedScheduleRows(item) {
    const schedules = app().state.dashboard?.schedules || [];
    const frozen = app().isFrozenReference();
    return (item.scheduleRefs || []).map((ref) => {
      const schedule = schedules.find((row) => row.sourceId === ref.sourceId);
      return `
        <div class="planning-link-row">
          <div><strong>${esc(schedule?.name || ref.label || ref.sourceId)}</strong><small>${esc(schedule?.source || ref.source || '')} · ${esc(schedule?.schedule?.cron || schedule?.schedule?.type || '')}</small></div>
          ${frozen ? '' : `<button type="button" data-unlink-schedule="${esc(ref.sourceId)}" title="Unlink"><i class="fas fa-xmark"></i></button>`}
        </div>`;
    }).join('');
  }

  function taskRows(item) {
    const frozen = app().isFrozenReference();
    return (item.linkedTasks || []).map((task) => `
      <div class="planning-link-row">
        <div><strong>[${esc(task.pipelineId)}] ${esc(task.title)}</strong><small>Current Pipeline state: ${esc(formatStatus(task.status))} · ${esc(task.service || task.epic || 'unclassified')}</small></div>
        ${frozen ? '' : `<button type="button" data-unlink-task="${esc(task.pipelineId)}" title="Unlink"><i class="fas fa-xmark"></i></button>`}
      </div>`).join('');
  }

  function evidenceRows(item) {
    const frozen = app().isFrozenReference();
    return (item.evidence || []).slice().reverse().map((evidence) => `
      <div class="planning-link-row">
        <div>
          <strong>${evidence.url ? `<a href="${esc(evidence.url)}" target="_blank" rel="noopener">${esc(evidence.label)}</a>` : esc(evidence.label)}</strong>
          <small>${esc(evidence.source || 'manual')} · ${esc(evidence.kind)}${evidence.occurredAt || evidence.addedAt ? ` · ${esc(isoDate(evidence.occurredAt || evidence.addedAt))}` : ''}${evidence.ref ? ` · ${esc(evidence.ref)}` : ''}${evidence.note ? ` · ${esc(evidence.note)}` : ''}</small>
        </div>
        ${frozen ? '' : `<button type="button" data-remove-evidence="${esc(evidence._id || evidence.id)}" title="Remove"><i class="fas fa-xmark"></i></button>`}
      </div>`).join('');
  }

  function historyRows(item) {
    return (item.history || []).slice().reverse().slice(0, 12).map((entry) => `
      <div class="planning-history-row">
        <div><strong>${esc(formatStatus(entry.action))}</strong><small>${esc(entry.note || entry.by || '')}</small></div>
        <small>${esc(app().dateOnly(entry.at))}</small>
      </div>`).join('');
  }

  function workflowActionButtons(item) {
    if (app().isFrozenReference()) return '';
    return (item.workflowActions || []).map((action) => `
      <button
        type="button"
        class="planning-btn planning-btn-${esc(action.tone || 'secondary')}"
        data-workflow-action="${esc(action.action)}"
      ><i class="fas ${esc(action.icon || 'fa-arrow-right')}"></i> ${esc(action.label)}</button>
    `).join('');
  }

  function healthReasonsHtml(item) {
    const reasons = item.health?.reasons || [];
    if (!reasons.length) return '';
    return `
      <div class="planning-health-reasons" aria-label="Planning health reasons">
        ${reasons.map((reason) => `
          <span class="planning-health-reason planning-health-${esc(reason.severity || 'warning')}">
            <i class="fas ${reason.severity === 'critical' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'}"></i>
            ${esc(reason.label)}
          </span>
        `).join('')}
      </div>`;
  }

  function drawerHtml(item) {
    const frozen = app().isFrozenReference();
    const schedules = app().state.dashboard?.schedules || [];
    const linkedScheduleIds = new Set((item.scheduleRefs || []).map((ref) => ref.sourceId));
    const availableSchedules = schedules.filter((row) => !linkedScheduleIds.has(row.sourceId));
    const linkedTaskIds = new Set((item.linkedTasks || []).map((task) => task.pipelineId));
    const availableTasks = (app().state.dashboard?.tasks || []).filter((task) => !linkedTaskIds.has(task.pipelineId));
    const metric = item.progress?.metric || {};
    const target = item.dates?.targetAt ? app().dateOnly(item.dates.targetAt) : 'No target';
    const parent = item.parentId ? app().getItem(String(item.parentId)) : null;
    const childActions = frozen ? '' : (item.type === 'workstream'
      ? `
        <button type="button" class="planning-btn planning-btn-secondary" data-add-child="outcome"><i class="fas fa-bullseye"></i> Add outcome</button>
        <button type="button" class="planning-btn planning-btn-secondary" data-add-child="milestone"><i class="fas fa-flag-checkered"></i> Add milestone</button>`
      : (item.type === 'outcome'
        ? '<button type="button" class="planning-btn planning-btn-secondary" data-add-child="milestone"><i class="fas fa-flag-checkered"></i> Add milestone</button>'
        : ''));
    return `
      <header class="planning-drawer-header planning-card-type-${esc(item.type)}">
        <div class="planning-drawer-title-row">
          <div class="planning-drawer-heading">
            <span class="planning-drawer-type-icon"><i class="fas ${app().typeMeta[item.type]?.icon || 'fa-circle'}"></i></span>
            <div>
              <span class="planning-type-badge"><i class="fas ${app().typeMeta[item.type]?.icon || 'fa-circle'}"></i>${esc(app().typeMeta[item.type]?.label || item.type)}</span>
              <h2>${esc(item.title)}</h2>
            </div>
          </div>
          <button type="button" class="planning-icon-btn" data-close-drawer aria-label="Close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="planning-drawer-command-row">
          <div class="planning-drawer-status-control">
            <span class="planning-status-badge planning-status-${esc(item.status)}" title="Saved historical Planning state">${esc(app().statusLabel(item.status))}</span>
            <span class="planning-health-badge planning-health-level-${esc(item.health?.level || 'unknown')}" title="Reference flag, not a live execution state">Reference ${esc(formatStatus(item.health?.level || 'unknown'))}</span>
            <span class="planning-priority-badge planning-priority-${esc(item.priority)}">${esc(item.priority)}</span>
          </div>
          <div class="planning-drawer-actions">
            ${workflowActionButtons(item)}
            <button type="button" class="planning-btn planning-btn-secondary" data-edit-item><i class="fas fa-pen"></i> ${frozen ? 'Correct record' : 'Edit'}</button>
            ${!frozen && item.type === 'idea' && item.status === 'triaged' ? `
              <select id="planningPromoteType" aria-label="Promotion target">
                <option value="workstream">Workstream</option>
                <option value="outcome">Outcome</option>
                <option value="milestone">Milestone</option>
                <option value="decision">Decision</option>
              </select>
              <button type="button" class="planning-btn planning-btn-primary" data-promote-idea><i class="fas fa-arrow-up"></i> Promote</button>` : ''}
          </div>
        </div>
      </header>
      <div class="planning-drawer-body">
        ${frozen ? `
          <div class="planning-reference-note" role="note">
            <i class="fas fa-snowflake" aria-hidden="true"></i>
            <span><strong>Historical Planning record.</strong> Status and percentage describe this saved record or its reference calculation. Even 100% is not current execution. Pipeline tasks and schedules below are references to their owning systems.</span>
          </div>` : ''}
        <section class="planning-detail-section planning-detail-overview">
          <div class="planning-progress-row" title="${esc(app().progressMeaning(item))}">
            <div class="planning-progress-track"><div class="planning-progress-fill" style="width:${Number(item.computedProgress) || 0}%"></div></div>
            <strong>${esc(app().progressLabel(item))}</strong>
          </div>
          ${healthReasonsHtml(item)}
          <p>${esc(item.summary || 'No summary yet.')}</p>
          <div class="planning-detail-grid">
            <div class="planning-detail-kv"><span>Owner</span><strong>${esc(item.owner || 'Unassigned')}</strong></div>
            <div class="planning-detail-kv"><span>Target</span><strong class="${item.isOverdue ? 'planning-card-overdue' : ''}">${esc(target)}</strong></div>
            <div class="planning-detail-kv"><span>Reference basis</span><strong>${esc(formatStatus(item.referenceSemantics?.progressBasis || item.progress?.mode || 'tasks'))}</strong></div>
            <div class="planning-detail-kv"><span>Workstream</span><strong>${esc(item.workstream?.title || (item.type === 'workstream' ? 'Self' : 'None'))}</strong></div>
            <div class="planning-detail-kv"><span>Parent</span><strong>${esc(parent?.title || 'None')}</strong></div>
            <div class="planning-detail-kv"><span>Updated</span><strong>${esc(app().dateOnly(item.updatedAt) || '--')}</strong></div>
          </div>
          ${childActions ? `<div class="planning-detail-actions">${childActions}</div>` : ''}
        </section>

        ${item.progress?.mode === 'metric' ? `
          <section class="planning-detail-section">
            <h3><i class="fas fa-chart-line"></i> Outcome Metric</h3>
            <div class="planning-detail-grid">
              <div class="planning-detail-kv"><span>Metric</span><strong>${esc(metric.label || '--')}</strong></div>
              <div class="planning-detail-kv"><span>Direction</span><strong>${esc(metric.direction || 'increase')}</strong></div>
              <div class="planning-detail-kv"><span>Baseline</span><strong>${esc(metric.baseline ?? '--')} ${esc(metric.unit || '')}</strong></div>
              <div class="planning-detail-kv"><span>Recorded / target</span><strong>${esc(metric.current ?? '--')} / ${esc(metric.target ?? '--')} ${esc(metric.unit || '')}</strong></div>
              <div class="planning-detail-kv"><span>Adapter</span><strong>${esc(metric.adapter || 'Manual source')}</strong></div>
              <div class="planning-detail-kv"><span>Observation</span><strong>${esc(formatStatus(metric.observation?.status || 'unconfigured'))}</strong></div>
              <div class="planning-detail-kv"><span>Observed</span><strong>${esc(app().dateOnly(metric.observation?.observedAt) || '--')}</strong></div>
            </div>
          </section>` : ''}

        ${item.type === 'decision' ? `
          <section class="planning-detail-section">
            <h3><i class="fas fa-scale-balanced"></i> Decision</h3>
            <p><strong>Context</strong><br>${esc(item.decision?.context || '--')}</p>
            <p><strong>Choice</strong><br>${esc(item.decision?.choice || '--')}</p>
            <p><strong>Rationale</strong><br>${esc(item.decision?.rationale || '--')}</p>
          </section>` : ''}

        <section class="planning-detail-section">
          <h3><i class="fas fa-list-check"></i> Pipeline references <a href="/pipeline" title="Open current execution source"><i class="fas fa-arrow-up-right"></i></a></h3>
          <div class="planning-link-list">${taskRows(item) || '<div class="planning-empty">No Pipeline task references.</div>'}</div>
          ${frozen ? '' : `<div class="planning-inline-form">
            <select id="planningLinkTaskSelect">
              <option value="">Link an open task...</option>
              ${availableTasks.slice(0, 100).map((task) => `<option value="${esc(task.pipelineId)}">[${esc(task.pipelineId)}] ${esc(task.title)}</option>`).join('')}
            </select>
            <button type="button" class="planning-btn planning-btn-secondary" data-link-task>Link</button>
          </div>`}
        </section>

        <section class="planning-detail-section">
          <h3><i class="fas fa-clock"></i> Runtime Schedule references <a href="/cluster-schedule" title="Open current schedule source"><i class="fas fa-arrow-up-right"></i></a></h3>
          <div class="planning-link-list">${linkedScheduleRows(item) || '<div class="planning-empty">No Runtime Schedule references.</div>'}</div>
          ${frozen ? '' : `<div class="planning-inline-form">
            <select id="planningLinkScheduleSelect">
              <option value="">Link a schedule...</option>
              ${availableSchedules.map((schedule) => `<option value="${esc(schedule.sourceId)}">${esc(schedule.name)} · ${esc(schedule.source)}</option>`).join('')}
            </select>
            <button type="button" class="planning-btn planning-btn-secondary" data-link-schedule>Link</button>
          </div>`}
        </section>

        <section class="planning-detail-section">
          <h3><i class="fas fa-link"></i> Recorded evidence &amp; artifacts</h3>
          <div class="planning-link-list">${evidenceRows(item) || '<div class="planning-empty">No evidence attached.</div>'}</div>
          ${frozen ? '' : `<form class="planning-evidence-form" id="planningEvidenceForm">
            <select id="planningEvidenceKind">
              <option value="note">Note</option><option value="artifact">RAG artifact</option>
              <option value="commit">Commit</option><option value="task_feedback">Task feedback</option>
              <option value="benchmark">Benchmark</option><option value="alert">Alert</option>
              <option value="document">Document</option><option value="url">URL</option>
              <option value="schedule_run">Schedule run</option>
            </select>
            <input id="planningEvidenceLabel" required placeholder="Evidence label">
            <input id="planningEvidenceRef" placeholder="Commit, batch, task, artifact, or alert id">
            <input id="planningEvidenceUrl" type="url" placeholder="Optional URL">
            <textarea id="planningEvidenceNote" rows="2" placeholder="Why this evidence matters"></textarea>
            <button type="submit" class="planning-btn planning-btn-secondary"><i class="fas fa-plus"></i> Add evidence</button>
          </form>`}
        </section>

        <section class="planning-detail-section">
          <h3><i class="fas fa-clock-rotate-left"></i> Activity</h3>
          <div class="planning-history">${historyRows(item) || '<div class="planning-empty">No activity recorded.</div>'}</div>
        </section>

        ${frozen ? '' : `<button type="button" class="planning-btn planning-btn-danger" data-archive-item>
          <i class="fas fa-box-archive"></i> Archive planning item
        </button>`}
      </div>`;
  }

  function renderDrawer(item) {
    $('planningDrawerContent').innerHTML = drawerHtml(item);
    $('planningDrawerBackdrop').hidden = false;
    $('planningDrawer').classList.add('open');
    $('planningDrawer').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  async function openItem(id) {
    currentItemId = id;
    const item = app().getItem(id);
    if (!item) return;
    renderDrawer(item);
  }

  async function refreshCurrent() {
    await app().reload();
    if (currentItemId) {
      const item = app().getItem(currentItemId);
      if (item) renderDrawer(item);
      else closeDrawer();
    }
  }

  async function mutate(path, options) {
    try {
      await app().api(path, options);
      await refreshCurrent();
    } catch (error) {
      window.Toast?.error?.(error.message);
      if (!window.Toast) alert(error.message);
    }
  }

  async function promoteIdea() {
    const targetType = inputValue('planningPromoteType') || 'workstream';
    await mutate(`/api/planning/ideas/${encodeURIComponent(currentItemId)}/promote`, {
      method: 'POST',
      body: JSON.stringify({ targetType, by: 'operator' })
    });
  }

  function bindDrawerEvents() {
    $('planningDrawerBackdrop').addEventListener('click', closeDrawer);
    $('planningDrawer').addEventListener('click', async (event) => {
      if (event.target.closest('[data-close-drawer]')) return closeDrawer();
      const workflowAction = event.target.closest('[data-workflow-action]');
      if (workflowAction) {
        workflowAction.disabled = true;
        await mutate(
          `/api/planning/items/${encodeURIComponent(currentItemId)}/actions/${encodeURIComponent(workflowAction.dataset.workflowAction)}`,
          {
            method: 'POST',
            body: JSON.stringify({ by: 'operator' })
          }
        );
        return;
      }
      if (event.target.closest('[data-edit-item]')) {
        const item = app().getItem(currentItemId);
        if (item) {
          fillForm(item);
          openModal();
        }
        return;
      }
      const addChild = event.target.closest('[data-add-child]');
      if (addChild) {
        const item = app().getItem(currentItemId);
        if (item) {
          openCreate({
            type: addChild.dataset.addChild,
            workstreamId: item.type === 'workstream' ? item.id : String(item.workstreamId || ''),
            parentId: item.id
          });
        }
        return;
      }
      if (event.target.closest('[data-promote-idea]')) return promoteIdea();
      if (event.target.closest('[data-archive-item]')) {
        const headers = await window.AgentXTypedConfirmation.confirm({
          action: 'ARCHIVE PLANNING ITEM',
          resource: currentItemId,
          title: 'Archive planning item',
          description: 'Archive this planning item? Links and history remain as evidence, but the item leaves the active plan.'
        });
        if (!headers) return;
        await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}`, {
          method: 'DELETE', headers, body: JSON.stringify({ by: 'operator' })
        });
        return;
      }
      const unlinkTask = event.target.closest('[data-unlink-task]');
      if (unlinkTask) {
        const pipelineId = unlinkTask.dataset.unlinkTask;
        const headers = await window.AgentXTypedConfirmation.confirm({
          action: 'UNLINK PLANNING TASK',
          resource: [currentItemId, pipelineId],
          title: 'Unlink pipeline task',
          description: 'Remove this task link from the planning item? The underlying pipeline task is preserved.'
        });
        if (!headers) return;
        await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}/tasks/${encodeURIComponent(unlinkTask.dataset.unlinkTask)}`, {
          method: 'DELETE', headers,
          body: JSON.stringify({ by: 'operator' })
        });
        return;
      }
      const unlinkSchedule = event.target.closest('[data-unlink-schedule]');
      if (unlinkSchedule) {
        const sourceId = unlinkSchedule.dataset.unlinkSchedule;
        const headers = await window.AgentXTypedConfirmation.confirm({
          action: 'UNLINK PLANNING SCHEDULE',
          resource: [currentItemId, sourceId],
          title: 'Unlink schedule',
          description: 'Remove this schedule link from the planning item? The source schedule itself is preserved.'
        });
        if (!headers) return;
        await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}/schedules/${encodeURIComponent(unlinkSchedule.dataset.unlinkSchedule)}`, {
          method: 'DELETE', headers,
          body: JSON.stringify({ by: 'operator' })
        });
        return;
      }
      const removeEvidence = event.target.closest('[data-remove-evidence]');
      if (removeEvidence) {
        const evidenceId = removeEvidence.dataset.removeEvidence;
        const headers = await window.AgentXTypedConfirmation.confirm({
          action: 'DELETE PLANNING EVIDENCE',
          resource: [currentItemId, evidenceId],
          title: 'Delete planning evidence',
          description: 'Permanently remove this evidence link from the planning record?'
        });
        if (!headers) return;
        await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}/evidence/${encodeURIComponent(removeEvidence.dataset.removeEvidence)}`, {
          method: 'DELETE', headers,
          body: JSON.stringify({ by: 'operator' })
        });
        return;
      }
      if (event.target.closest('[data-link-task]')) {
        const pipelineId = inputValue('planningLinkTaskSelect');
        if (pipelineId) {
          await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}/tasks/${encodeURIComponent(pipelineId)}`, {
            method: 'POST',
            body: JSON.stringify({ by: 'operator' })
          });
        }
        return;
      }
      if (event.target.closest('[data-link-schedule]')) {
        const sourceId = inputValue('planningLinkScheduleSelect');
        if (sourceId) {
          await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}/schedules`, {
            method: 'POST',
            body: JSON.stringify({ sourceId, by: 'operator' })
          });
        }
      }
    });
    $('planningDrawer').addEventListener('submit', async (event) => {
      if (event.target.id !== 'planningEvidenceForm') return;
      event.preventDefault();
      await mutate(`/api/planning/items/${encodeURIComponent(currentItemId)}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          kind: inputValue('planningEvidenceKind'),
          label: inputValue('planningEvidenceLabel'),
          ref: inputValue('planningEvidenceRef'),
          url: inputValue('planningEvidenceUrl'),
          note: inputValue('planningEvidenceNote'),
          by: 'operator'
        })
      });
    });
  }

  function bindModalEvents() {
    $('planningModalCloseBtn').addEventListener('click', closeModal);
    $('planningModalCancelBtn').addEventListener('click', closeModal);
    $('planningModalBackdrop').addEventListener('click', (event) => {
      if (event.target === $('planningModalBackdrop')) closeModal();
    });
    $('planningFormType').addEventListener('change', () => {
      const type = inputValue('planningFormType');
      $('planningFormStatus').value = DEFAULT_STATUS[type] || 'draft';
      if (type === 'outcome' && inputValue('planningFormProgressMode') === 'tasks') {
        $('planningFormProgressMode').value = 'metric';
      }
      populateRelations({
        selectedWorkstream: inputValue('planningFormWorkstream'),
        selectedParent: '',
        type,
        currentId: inputValue('planningFormId')
      });
      syncConditionalFields();
    });
    $('planningFormWorkstream').addEventListener('change', () => {
      populateRelations({
        selectedWorkstream: inputValue('planningFormWorkstream'),
        selectedParent: inputValue('planningFormParent'),
        type: inputValue('planningFormType'),
        currentId: inputValue('planningFormId')
      });
    });
    $('planningFormParent').addEventListener('change', () => {
      const parent = app().getItem(inputValue('planningFormParent'));
      if (!parent || inputValue('planningFormWorkstream')) return;
      const workstreamId = parent.type === 'workstream' ? parent.id : String(parent.workstreamId || '');
      if (workstreamId) {
        $('planningFormWorkstream').value = workstreamId;
        populateRelations({
          selectedWorkstream: workstreamId,
          selectedParent: parent.id,
          type: inputValue('planningFormType'),
          currentId: inputValue('planningFormId')
        });
      }
    });
    $('planningFormProgressMode').addEventListener('change', syncConditionalFields);
    $('planningItemForm').addEventListener('submit', submitForm);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!$('planningModalBackdrop').hidden) closeModal();
      else if ($('planningDrawer').classList.contains('open')) closeDrawer();
    });
  }

  window.PlanningEditor = { openCreate, openItem, closeDrawer };

  document.addEventListener('DOMContentLoaded', () => {
    $('planningFormStatus').value = 'draft';
    bindModalEvents();
    bindDrawerEvents();
  });
})();

(function () {
  'use strict';

  const TYPE_META = {
    workstream: { label: 'Workstream', icon: 'fa-diagram-project', color: '#67e8f9' },
    outcome: { label: 'Outcome', icon: 'fa-bullseye', color: '#c4b5fd' },
    milestone: { label: 'Milestone', icon: 'fa-flag-checkered', color: '#fcd34d' },
    idea: { label: 'Idea', icon: 'fa-lightbulb', color: '#f9a8d4' },
    decision: { label: 'Decision', icon: 'fa-scale-balanced', color: '#7dd3fc' }
  };

  const VIEW_META = {
    portfolio: {
      title: 'Home',
      description: 'A historical view of saved strategic records; Pipeline is the current delivery source.'
    },
    goals: {
      title: 'Goals',
      description: 'Recorded outcomes grouped by the historical workstream they referenced.'
    },
    roadmap: {
      title: 'Roadmap',
      description: 'Recorded outcomes and milestones ordered by their saved target horizon.'
    },
    board: {
      title: 'Delivery board',
      description: 'Historical Planning records organized by saved delivery state.'
    },
    ideas: {
      title: 'Idea lab',
      description: 'Historical idea states preserved for reference.'
    },
    decisions: {
      title: 'Decision log',
      description: 'Recorded context, choices, and rationale preserved for reference.'
    },
    evidence: {
      title: 'Evidence',
      description: 'Recorded artifacts, commits, benchmarks, alerts, documents, and runtime evidence.'
    }
  };

  const state = {
    dashboard: null,
    activeView: 'portfolio',
    attentionOnly: false,
    search: '',
    status: '',
    type: '',
    loading: false,
    organizingTask: null,
    taskCandidates: [],
    taskOrganizerTrigger: null
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function unwrap(payload) {
    return payload && payload.data ? payload.data : payload;
  }

  async function api(path, options = {}) {
    const { headers = {}, ...requestOptions } = options;
    const response = await fetch(path, {
      ...requestOptions,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return unwrap(body);
  }

  function formatStatus(value) {
    return String(value || 'unknown').replace(/_/g, ' ');
  }

  function isFrozenReference() {
    return $('planningRoot')?.dataset.lifecycle === 'frozen';
  }

  function statusLabel(status) {
    const label = formatStatus(status);
    return isFrozenReference() ? `Recorded ${label}` : label;
  }

  function progressLabel(item) {
    const progress = Math.max(0, Math.min(100, Number(item?.computedProgress) || 0));
    return isFrozenReference() ? `${progress}% recorded` : `${progress}%`;
  }

  function progressMeaning(item) {
    if (!isFrozenReference()) return `Calculated from ${item?.progress?.mode || 'tasks'}`;
    const basis = item?.referenceSemantics?.progressBasis || item?.progress?.mode || 'recorded planning state';
    return `Historical Planning reference (${formatStatus(basis)}). This percentage is not a current execution signal; open Pipeline for current delivery.`;
  }

  function dateOnly(value, options = {}) {
    if (!value) return '';
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString([], {
      year: options.short ? undefined : 'numeric',
      month: options.short ? 'short' : 'short',
      day: 'numeric'
    });
  }

  function relativeTime(value) {
    if (!value) return 'unscheduled';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    const delta = date.getTime() - Date.now();
    const abs = Math.abs(delta);
    const units = [['d', 86400000], ['h', 3600000], ['m', 60000]];
    for (const [label, size] of units) {
      if (abs >= size || label === 'm') {
        const amount = Math.max(1, Math.round(abs / size));
        return delta >= 0 ? `in ${amount}${label}` : `${amount}${label} ago`;
      }
    }
    return 'soon';
  }

  function typeBadge(item, { compact = false } = {}) {
    const meta = TYPE_META[item.type] || { label: item.type, icon: 'fa-circle' };
    return `<span class="planning-type-badge${compact ? ' planning-badge-compact' : ''}"><i class="fas ${meta.icon}"></i>${esc(meta.label)}</span>`;
  }

  function statusBadge(status) {
    const title = isFrozenReference()
      ? 'Saved historical Planning state; not a current execution signal.'
      : '';
    return `<span class="planning-status-badge planning-status-${esc(status)}"${title ? ` title="${esc(title)}"` : ''}>${esc(statusLabel(status))}</span>`;
  }

  function priorityBadge(priority) {
    return `<span class="planning-priority-badge planning-priority-${esc(priority || 'normal')}">${esc(priority || 'normal')}</span>`;
  }

  function progressBar(item, { compact = false } = {}) {
    const progress = Math.max(0, Math.min(100, Number(item.computedProgress) || 0));
    return `
      <div class="planning-progress-row${compact ? ' planning-progress-compact' : ''}" title="${esc(progressMeaning(item))}">
        <div class="planning-progress-track"><div class="planning-progress-fill" style="width:${progress}%"></div></div>
        <strong>${esc(progressLabel(item))}</strong>
      </div>`;
  }

  function itemSearchText(item) {
    return [
      item.title, item.summary, item.owner, item.status, item.priority,
      ...(item.tags || []), item.workstream?.title,
      item.decision?.choice, item.decision?.rationale
    ].join(' ').toLowerCase();
  }

  function itemMatches(item, { ignoreType = false, ignoreSearch = false } = {}) {
    if (!ignoreType && state.type && item.type !== state.type) return false;
    if (state.status && item.status !== state.status) return false;
    if (state.attentionOnly && !(item.isOverdue || ['at_risk', 'blocked'].includes(item.status))) return false;
    if (!ignoreSearch && state.search && !itemSearchText(item).includes(state.search.toLowerCase())) return false;
    return true;
  }

  function allItems() {
    return state.dashboard?.items || [];
  }

  function filteredItems(types) {
    const allowed = types ? new Set(types) : null;
    return allItems().filter((item) => (!allowed || allowed.has(item.type)) && itemMatches(item));
  }

  function averageProgress(items) {
    if (!items.length) return 0;
    return Math.round(items.reduce((sum, item) => sum + (Number(item.computedProgress) || 0), 0) / items.length);
  }

  function targetLabel(item) {
    if (!item.dates?.targetAt) return 'No target';
    return dateOnly(item.dates.targetAt, { short: true });
  }

  function itemMetaLine(item) {
    const bits = [];
    if (item.owner) bits.push(`<span><i class="fas fa-user"></i>${esc(item.owner)}</span>`);
    bits.push(`<span class="${item.isOverdue ? 'planning-card-overdue' : ''}"><i class="fas fa-calendar-day"></i>${esc(targetLabel(item))}</span>`);
    const taskCount = item.linkedTaskCount || 0;
    bits.push(`<span title="Historical references only; Pipeline owns execution"><i class="fas fa-list-check"></i>${taskCount} task ref${taskCount === 1 ? '' : 's'}</span>`);
    return bits.join('');
  }

  function renderPulse() {
    const dashboard = state.dashboard || {};
    const summary = dashboard.summary || {};
    const portfolioItems = (dashboard.items || []).filter((item) =>
      ['workstream', 'outcome'].includes(item.type) && !['completed', 'rejected'].includes(item.status)
    );
    const progress = averageProgress(portfolioItems);
    const activeTasks = Number(summary.activeTasks) || 0;
    const unlinkedTasks = Number(summary.unlinkedTasks) || 0;
    const coverage = activeTasks ? Math.round(((activeTasks - unlinkedTasks) / activeTasks) * 100) : null;

    $('planningPortfolioProgress').textContent = isFrozenReference() ? `${progress}% recorded` : `${progress}%`;
    $('planningPortfolioProgressMeta').textContent = portfolioItems.length
      ? `${portfolioItems.length} non-complete historical record${portfolioItems.length === 1 ? '' : 's'}`
      : 'No non-complete historical records';
    $('planningPortfolioRing').style.setProperty('--ring-progress', progress);
    $('planningCountAttention').textContent = summary.atRisk ?? 0;
    $('planningAttentionMetaTop').textContent = summary.atRisk
      ? `${summary.overdueMilestones || 0} overdue milestone${summary.overdueMilestones === 1 ? '' : 's'}`
      : 'No recorded attention flags';
    $('planningPipelineCoverage').textContent = coverage == null ? '—' : `${coverage}%`;
    $('planningCoverageMeta').textContent = activeTasks
      ? `${activeTasks - unlinkedTasks} of ${activeTasks} open Pipeline tasks carry a historical reference`
      : 'No open Pipeline tasks; coverage is not scored';
    $('planningCountIdeas').textContent = summary.ideaInbox ?? 0;
    $('planningIdeasMeta').textContent = summary.ideaInbox ? 'Waiting for triage' : 'Inbox is clear';
    $('planningNavGoalCount').textContent = summary.outcome ?? 0;
    $('planningNavIdeaCount').textContent = summary.ideaInbox ?? 0;
    $('planningNavDecisionCount').textContent = summary.decision ?? 0;
    $('planningNavEvidenceCount').textContent = (dashboard.items || [])
      .reduce((sum, item) => sum + (item.evidenceCount || 0), 0);
    $('planningBootstrapBtn').hidden = isFrozenReference() || !(summary.unlinkedTasks > 0);
    $('planningBootstrapBtn').innerHTML = `<i class="fas fa-inbox"></i> Review ${unlinkedTasks} task${unlinkedTasks === 1 ? '' : 's'}`;
  }

  function emptyState({ icon, eyebrow, title, copy, actions = '' }) {
    return `
      <div class="planning-empty-state">
        <span class="planning-empty-icon"><i class="fas ${esc(icon)}"></i></span>
        <span class="planning-section-kicker">${esc(eyebrow)}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(copy)}</p>
        ${actions ? `<div class="planning-empty-actions">${actions}</div>` : ''}
      </div>`;
  }

  function renderFirstRun() {
    if (isFrozenReference()) {
      return emptyState({
        icon: 'fa-box-archive',
        eyebrow: 'Historical reference',
        title: 'No Planning records were preserved',
        copy: 'This frozen surface does not create a current plan. Open Pipeline for live delivery state.',
        actions: '<a class="planning-btn planning-btn-primary" href="/pipeline"><i class="fas fa-list-check"></i> Open Pipeline</a>'
      });
    }
    const unlinked = state.dashboard?.summary?.unlinkedTasks || 0;
    const primaryAction = unlinked
      ? `<button type="button" class="planning-btn planning-btn-primary" data-planning-review-intake><i class="fas fa-inbox"></i> Review ${unlinked} pipeline task${unlinked === 1 ? '' : 's'}</button>`
      : '<button type="button" class="planning-btn planning-btn-primary" data-planning-starter><i class="fas fa-sparkles"></i> Create AgentX starter portfolio</button>';
    return `
      <section class="planning-first-run">
        <div class="planning-first-run-hero">
          <div>
            <span class="planning-section-kicker">Your planning spine is ready</span>
            <h3>Give AgentX a visible direction.</h3>
            <p>Planning sits above the execution pipeline. Workstreams explain where effort goes, outcomes define success, milestones make delivery concrete, and evidence proves the result.</p>
            <div class="planning-first-run-actions">
              ${primaryAction}
              <button type="button" class="planning-btn planning-btn-secondary" data-planning-create-type="workstream"><i class="fas fa-plus"></i> Start from scratch</button>
            </div>
          </div>
          <div class="planning-orbit-visual" aria-hidden="true">
            <span class="planning-orbit-center"><i class="fas fa-compass-drafting"></i></span>
            <span class="planning-orbit-node planning-orbit-node-one"><i class="fas fa-bullseye"></i></span>
            <span class="planning-orbit-node planning-orbit-node-two"><i class="fas fa-list-check"></i></span>
            <span class="planning-orbit-node planning-orbit-node-three"><i class="fas fa-link"></i></span>
          </div>
        </div>
        <div class="planning-first-run-grid">
          <article>
            <span>01</span><i class="fas fa-diagram-project"></i>
            <h4>Choose the bets</h4>
            <p>Use workstreams for durable strategic areas, not individual tasks.</p>
          </article>
          <article>
            <span>02</span><i class="fas fa-bullseye"></i>
            <h4>Define success</h4>
            <p>Attach measurable outcomes and dated milestones to each workstream.</p>
          </article>
          <article>
            <span>03</span><i class="fas fa-list-check"></i>
            <h4>Connect delivery</h4>
            <p>Link pipeline tasks and runtime schedules without replacing their source of truth.</p>
          </article>
          <article>
            <span>04</span><i class="fas fa-folder-open"></i>
            <h4>Keep the proof</h4>
            <p>Collect commits, benchmarks, alerts, artifacts, and decisions in the evidence room.</p>
          </article>
        </div>
      </section>`;
  }

  function relatedItems(workstreamId, type = '') {
    return allItems().filter((item) =>
      item.id !== workstreamId
      && String(item.workstreamId || '') === workstreamId
      && (!type || item.type === type)
    );
  }

  function renderWorkstreamTile(workstream) {
    const goals = relatedItems(workstream.id, 'outcome');
    const milestones = relatedItems(workstream.id, 'milestone');
    const recordedProgress = Number(workstream.computedProgress);
    const progress = Number.isFinite(recordedProgress)
      ? recordedProgress
      : averageProgress([...goals, ...milestones]);
    return `
      <article class="planning-workstream-tile planning-card-type-workstream" data-planning-item-id="${esc(workstream.id)}" tabindex="0">
        <header>
          <span class="planning-workstream-mark"><i class="fas fa-diagram-project"></i></span>
          <span>${statusBadge(workstream.status)}</span>
        </header>
        <h3>${esc(workstream.title)}</h3>
        <p>${esc(workstream.summary || 'Define the strategic intent for this workstream.')}</p>
        ${progressBar({ ...workstream, computedProgress: progress }, { compact: true })}
        <footer>
          <span><i class="fas fa-bullseye"></i>${goals.length} goals</span>
          <span><i class="fas fa-flag-checkered"></i>${milestones.length} milestones</span>
          <button type="button" data-planning-create-child="outcome" data-workstream-id="${esc(workstream.id)}" data-parent-id="${esc(workstream.id)}" title="Add goal"><i class="fas fa-plus"></i></button>
        </footer>
      </article>`;
  }

  function renderFocusRow(item) {
    return `
      <button type="button" class="planning-focus-row" data-planning-item-id="${esc(item.id)}">
        <span class="planning-focus-icon planning-card-type-${esc(item.type)}"><i class="fas ${TYPE_META[item.type]?.icon || 'fa-circle'}"></i></span>
        <span><strong>${esc(item.title)}</strong><small>${esc(item.workstream?.title || item.owner || 'Portfolio-wide')}</small></span>
        <span>${esc(progressLabel(item))}</span>
        ${statusBadge(item.status)}
      </button>`;
  }

  function renderPortfolio() {
    const items = allItems();
    if (!items.length) return renderFirstRun();
    const workstreams = items
      .filter((item) =>
        (!state.type || state.type === 'workstream')
        && item.type === 'workstream'
        && itemMatches(item, { ignoreType: true })
      )
      .sort((a, b) => (Number(a.priority === 'critical') ? -1 : 0) - (Number(b.priority === 'critical') ? -1 : 0));
    const goals = items.filter((item) => item.type === 'outcome' && itemMatches(item)).slice(0, 6);
    const milestones = items
      .filter((item) => item.type === 'milestone' && itemMatches(item))
      .sort((a, b) => new Date(a.dates?.targetAt || 8640000000000000) - new Date(b.dates?.targetAt || 8640000000000000))
      .slice(0, 6);

    if (!workstreams.length && !goals.length && !milestones.length) {
      return emptyState({
        icon: 'fa-filter-circle-xmark',
        eyebrow: 'No matches',
        title: 'Nothing fits the current filters',
        copy: 'Clear the search or filters to see the full planning home.',
        actions: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-clear-filters>Clear filters</button>'
      });
    }

    return `
      <section class="planning-home-section">
        <header>
          <div><span class="planning-section-kicker">Strategic map</span><h3>Workstreams</h3></div>
          <button type="button" class="planning-text-btn" data-planning-create-type="workstream"><i class="fas fa-plus"></i> Add workstream</button>
        </header>
        <div class="planning-workstream-grid">${workstreams.map(renderWorkstreamTile).join('')}</div>
      </section>
      <div class="planning-home-columns">
        <section class="planning-home-section">
          <header>
            <div><span class="planning-section-kicker">Historical outcomes</span><h3>Recorded goals</h3></div>
            <button type="button" class="planning-text-btn" data-planning-view-target="goals">See all</button>
          </header>
          <div class="planning-focus-list">
            ${goals.length ? goals.map(renderFocusRow).join('') : `
              <div class="planning-compact-empty">
                <i class="fas fa-bullseye"></i><span><strong>No goals yet</strong><small>Turn a workstream into a measurable result.</small></span>
                <button type="button" data-planning-create-type="outcome">Add goal</button>
              </div>`}
          </div>
        </section>
        <section class="planning-home-section">
          <header>
            <div><span class="planning-section-kicker">Delivery horizon</span><h3>Next milestones</h3></div>
            <button type="button" class="planning-text-btn" data-planning-view-target="roadmap">See roadmap</button>
          </header>
          <div class="planning-focus-list">
            ${milestones.length ? milestones.map(renderFocusRow).join('') : `
              <div class="planning-compact-empty">
                <i class="fas fa-flag-checkered"></i><span><strong>No milestones yet</strong><small>Give delivery a concrete checkpoint.</small></span>
                <button type="button" data-planning-create-type="milestone">Add milestone</button>
              </div>`}
          </div>
        </section>
      </div>`;
  }

  function renderGoalCard(item) {
    const metric = item.progress?.metric || {};
    const metricText = metric.label
      ? `${metric.current ?? '—'} → ${metric.target ?? '—'} ${metric.unit || ''}`.trim()
      : progressLabel(item);
    return `
      <article class="planning-goal-card planning-card-type-outcome" data-planning-item-id="${esc(item.id)}" tabindex="0">
        <div class="planning-card-top">${statusBadge(item.status)}${priorityBadge(item.priority)}</div>
        <h4>${esc(item.title)}</h4>
        <p>${esc(item.summary || 'No definition of success yet.')}</p>
        <div class="planning-goal-metric">
          <span><i class="fas fa-chart-line"></i>${esc(metric.label || 'Progress')}</span>
          <strong>${esc(metricText)}</strong>
        </div>
        ${progressBar(item)}
        <footer><span><i class="fas fa-user"></i>${esc(item.owner || 'Unassigned')}</span><span class="${item.isOverdue ? 'planning-card-overdue' : ''}"><i class="fas fa-calendar"></i>${esc(targetLabel(item))}</span></footer>
      </article>`;
  }

  function renderGoals() {
    const goals = filteredItems(['outcome']);
    if (!goals.length) {
      return emptyState({
        icon: 'fa-bullseye',
        eyebrow: 'Goals',
        title: 'Define what success looks like',
        copy: 'Goals turn broad workstreams into measurable outcomes. Give each one an owner, target, and source of progress.',
        actions: '<button type="button" class="planning-btn planning-btn-primary" data-planning-create-type="outcome"><i class="fas fa-plus"></i> Create first goal</button>'
      });
    }
    const workstreams = allItems().filter((item) => item.type === 'workstream');
    const groups = new Map();
    for (const goal of goals) {
      const id = String(goal.workstreamId || 'unassigned');
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(goal);
    }
    return `<div class="planning-goal-groups">${[...groups.entries()].map(([workstreamId, rows]) => {
      const workstream = workstreams.find((item) => item.id === workstreamId);
      return `
        <section class="planning-goal-group">
          <header>
            <div><span class="planning-section-kicker">${workstream ? 'Workstream' : 'Needs structure'}</span><h3>${esc(workstream?.title || 'Unassigned goals')}</h3></div>
            <button type="button" class="planning-text-btn" data-planning-create-child="outcome" data-workstream-id="${esc(workstream?.id || '')}" data-parent-id="${esc(workstream?.id || '')}"><i class="fas fa-plus"></i> Add goal</button>
          </header>
          <div class="planning-goal-grid">${rows.map(renderGoalCard).join('')}</div>
        </section>`;
    }).join('')}</div>`;
  }

  function monthBucket(value) {
    if (!value) return { key: 'undated', label: 'Undated horizon', sort: Number.MAX_SAFE_INTEGER };
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : new Date(value);
    if (Number.isNaN(date.getTime())) return { key: 'undated', label: 'Undated horizon', sort: Number.MAX_SAFE_INTEGER };
    return {
      key: `${date.getFullYear()}-${date.getMonth()}`,
      label: date.toLocaleDateString([], { month: 'long', year: 'numeric' }),
      sort: new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    };
  }

  function renderRoadmapItem(item) {
    const meta = TYPE_META[item.type] || TYPE_META.milestone;
    return `
      <article class="planning-roadmap-item planning-card-type-${esc(item.type)}" data-planning-item-id="${esc(item.id)}" tabindex="0">
        <span class="planning-roadmap-node"><i class="fas ${meta.icon}"></i></span>
        <div class="planning-roadmap-copy">
          <div>${typeBadge(item, { compact: true })} ${statusBadge(item.status)}</div>
          <h4>${esc(item.title)}</h4>
          <p>${esc(item.summary || 'No summary yet.')}</p>
          <div class="planning-card-meta">${itemMetaLine(item)}</div>
        </div>
        <div class="planning-roadmap-progress">${progressBar(item, { compact: true })}</div>
      </article>`;
  }

  function renderRoadmap() {
    const items = filteredItems(['outcome', 'milestone'])
      .sort((a, b) => {
        const aDate = a.dates?.targetAt ? new Date(a.dates.targetAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bDate = b.dates?.targetAt ? new Date(b.dates.targetAt).getTime() : Number.MAX_SAFE_INTEGER;
        return aDate - bDate;
      });
    if (!items.length) {
      return emptyState({
        icon: 'fa-road',
        eyebrow: 'Roadmap',
        title: 'No dated outcomes or milestones yet',
        copy: 'Add a target date to an outcome or milestone and it will appear on this delivery horizon.',
        actions: '<button type="button" class="planning-btn planning-btn-primary" data-planning-create-type="milestone"><i class="fas fa-plus"></i> Add milestone</button>'
      });
    }
    const buckets = new Map();
    for (const item of items) {
      const bucket = monthBucket(item.dates?.targetAt);
      if (!buckets.has(bucket.key)) buckets.set(bucket.key, { ...bucket, items: [] });
      buckets.get(bucket.key).items.push(item);
    }
    return `<div class="planning-roadmap">${[...buckets.values()]
      .sort((a, b) => a.sort - b.sort)
      .map((bucket) => `
        <section class="planning-roadmap-group">
          <header>
            <span>${esc(bucket.label)}</span>
            <small>${bucket.items.length} commitment${bucket.items.length === 1 ? '' : 's'}</small>
          </header>
          <div class="planning-roadmap-line">${bucket.items.map(renderRoadmapItem).join('')}</div>
        </section>`).join('')}</div>`;
  }

  function renderItemCard(item, { draggable = false } = {}) {
    const tags = (item.tags || []).slice(0, 3).map((tag) => `<span class="planning-tag">${esc(tag)}</span>`).join('');
    return `
      <article class="planning-card planning-card-type-${esc(item.type)}${draggable ? ' planning-draggable' : ''}" data-planning-item-id="${esc(item.id)}"${draggable ? ` data-planning-drag-id="${esc(item.id)}" draggable="true"` : ''} tabindex="0">
        <div class="planning-card-top"><div>${typeBadge(item, { compact: true })} ${priorityBadge(item.priority)}</div>${statusBadge(item.status)}</div>
        <h3>${esc(item.title)}</h3>
        ${item.summary ? `<p class="planning-card-summary">${esc(item.summary)}</p>` : ''}
        ${progressBar(item)}
        ${tags ? `<div class="planning-tags">${tags}</div>` : ''}
        <div class="planning-card-footer"><div class="planning-card-meta">${itemMetaLine(item)}</div></div>
      </article>`;
  }

  function renderBoard() {
    const items = filteredItems(['milestone']);
    const intake = state.attentionOnly ? '' : renderDeliveryIntake();
    const lanes = [
      { key: 'backlog', label: 'Recorded planned', icon: 'fa-circle-dot', statuses: ['draft', 'planned'] },
      { key: 'active', label: 'Recorded active', icon: 'fa-bolt', statuses: ['active'] },
      { key: 'risk', label: 'Recorded at risk', icon: 'fa-triangle-exclamation', statuses: ['at_risk'] },
      { key: 'blocked', label: 'Recorded blocked', icon: 'fa-ban', statuses: ['blocked'] },
      { key: 'done', label: 'Recorded complete', icon: 'fa-circle-check', statuses: ['completed'] }
    ];
    if (!items.length) {
      return `${intake}${emptyState({
        icon: 'fa-table-columns',
        eyebrow: 'Delivery board',
        title: state.attentionOnly ? 'Nothing currently needs attention' : 'No delivery commitments yet',
        copy: state.attentionOnly
          ? 'No planning item is blocked, at risk, or overdue.'
          : 'Create a milestone under a goal, then connect its pipeline tasks.',
        actions: '<button type="button" class="planning-btn planning-btn-primary" data-planning-create-type="milestone"><i class="fas fa-plus"></i> Add milestone</button>'
      })}`;
    }
    return `${intake}<div class="planning-kanban">${lanes.map((lane) => {
      const laneItems = items.filter((item) => lane.statuses.includes(item.status));
      return `
        <section class="planning-kanban-lane planning-lane-${lane.key}">
          <header><span><i class="fas ${lane.icon}"></i>${lane.label}</span><strong>${laneItems.length}</strong></header>
          <div>${laneItems.length ? laneItems.map((item) => renderItemCard(item)).join('') : '<p class="planning-lane-empty">Nothing here.</p>'}</div>
        </section>`;
    }).join('')}</div>`;
  }

  function taskSearchText(task) {
    return [
      task.pipelineId, task.title, task.service, task.epic, task.status,
      task.assignee, task.risk, ...(task.dependsOn || [])
    ].join(' ').toLowerCase();
  }

  function taskMeta(task) {
    const bits = [task.service || task.epic || 'Unclassified', formatStatus(task.status)];
    if (task.assignee) bits.push(task.assignee);
    if (task.dueAt) bits.push(`due ${dateOnly(task.dueAt, { short: true })}`);
    if (task.risk) bits.push(`${task.risk} risk`);
    return bits.join(' · ');
  }

  function renderDeliveryIntake() {
    const allTasks = state.dashboard?.unlinkedTasks || [];
    if (!allTasks.length) return '';
    const query = state.search.trim().toLowerCase();
    const tasks = allTasks.filter((task) => !query || taskSearchText(task).includes(query));
    const rows = tasks.length
      ? tasks.map((task) => `
        <article class="planning-intake-task">
          <div class="planning-intake-task-main">
            <span class="planning-task-id">${esc(task.pipelineId)}</span>
          <div>
              <h4>${esc(task.title)}</h4>
              <p>${esc(taskMeta(task))}</p>
            </div>
          </div>
          ${isFrozenReference() ? '' : `<button type="button" class="planning-btn planning-btn-secondary" data-planning-organize-task="${esc(task.pipelineId)}">
            Review <i class="fas fa-arrow-right"></i>
          </button>`}
        </article>`).join('')
      : '<div class="planning-intake-empty"><i class="fas fa-magnifying-glass"></i><span><strong>No intake tasks match this search</strong><small>Clear the search to review the full delivery intake.</small></span></div>';
    return `
      <section class="planning-delivery-intake">
        <header>
          <div>
            <span class="planning-section-kicker">Current Pipeline</span>
            <h3>Without a historical reference <strong>${allTasks.length}</strong></h3>
            <p>These open Pipeline tasks do not reference a preserved Planning record. No link is created here; Pipeline remains the current delivery source of truth.</p>
          </div>
          <a class="planning-btn planning-btn-secondary" href="/pipeline"><i class="fas fa-list-check"></i> Open pipeline</a>
        </header>
        <div class="planning-intake-list">${rows}</div>
      </section>`;
  }

  function renderIdeaCard(item) {
    const actions = isFrozenReference() ? '' : (item.status === 'inbox'
      ? `
        <button type="button" data-idea-action="triaged" data-idea-id="${esc(item.id)}">Triage</button>
        <button type="button" data-idea-action="parked" data-idea-id="${esc(item.id)}">Park</button>`
      : (item.status === 'triaged'
        ? `
          <button type="button" data-idea-promote="${esc(item.id)}">Promote</button>
          <button type="button" data-idea-action="parked" data-idea-id="${esc(item.id)}">Park</button>`
        : (['parked', 'rejected'].includes(item.status)
          ? `<button type="button" data-idea-action="inbox" data-idea-id="${esc(item.id)}">Reopen</button>`
          : '')));
    return `
      <article class="planning-idea-card" data-planning-item-id="${esc(item.id)}" tabindex="0">
        <div class="planning-card-top">${priorityBadge(item.priority)}${statusBadge(item.status)}</div>
        <span class="planning-idea-bulb"><i class="fas fa-lightbulb"></i></span>
        <h4>${esc(item.title)}</h4>
        <p>${esc(item.summary || 'No context captured yet.')}</p>
        <footer>
          <span><i class="fas fa-user"></i>${esc(item.owner || 'Unassigned')}</span>
          <span class="planning-idea-actions">${actions}</span>
        </footer>
      </article>`;
  }

  function renderIdeas() {
    const ideas = filteredItems(['idea']);
    const lanes = [
      { key: 'inbox', label: 'Inbox', statuses: ['inbox', 'draft'] },
      { key: 'triaged', label: 'Worth exploring', statuses: ['triaged', 'planned', 'active'] },
      { key: 'parked', label: 'Parked', statuses: ['parked', 'rejected'] },
      { key: 'promoted', label: 'Promoted', statuses: ['promoted', 'completed'] }
    ];
    if (!ideas.length && !allItems().some((item) => item.type === 'idea')) {
      return emptyState({
        icon: 'fa-lightbulb',
        eyebrow: 'Idea lab',
        title: 'A safe place for unfinished thoughts',
        copy: 'Capture possibilities here before they become commitments. Triage and promote only the ideas worth delivery attention.',
        actions: '<button type="button" class="planning-btn planning-btn-primary" data-planning-create-type="idea"><i class="fas fa-plus"></i> Capture first idea</button>'
      });
    }
    return `
      <div class="planning-idea-intro">
        <div><span class="planning-section-kicker">Idea discipline</span><h3>Explore without committing.</h3><p>Promotion creates a real workstream, outcome, milestone, or decision while preserving the original idea.</p></div>
        <button type="button" class="planning-btn planning-btn-primary" data-planning-create-type="idea"><i class="fas fa-plus"></i> Capture idea</button>
      </div>
      <div class="planning-idea-board">${lanes.map((lane) => {
        const laneItems = ideas.filter((item) => lane.statuses.includes(item.status));
        return `<section><header><span>${lane.label}</span><strong>${laneItems.length}</strong></header><div>${laneItems.length ? laneItems.map(renderIdeaCard).join('') : '<p class="planning-lane-empty">No ideas.</p>'}</div></section>`;
      }).join('')}</div>`;
  }

  function renderDecisions() {
    const decisions = filteredItems(['decision'])
      .sort((a, b) => new Date(b.decision?.decidedAt || b.updatedAt || 0) - new Date(a.decision?.decidedAt || a.updatedAt || 0));
    if (!decisions.length) {
      return emptyState({
        icon: 'fa-scale-balanced',
        eyebrow: 'Decision log',
        title: 'Record why AgentX chose a direction',
        copy: 'A decision record keeps context and rationale from disappearing into chat history or commit messages.',
        actions: '<button type="button" class="planning-btn planning-btn-primary" data-planning-create-type="decision"><i class="fas fa-plus"></i> Record decision</button>'
      });
    }
    return `
      <div class="planning-decision-ledger">
        <div class="planning-ledger-head"><span>Decision</span><span>Choice & rationale</span><span>Context</span></div>
        ${decisions.map((item) => `
          <article data-planning-item-id="${esc(item.id)}" tabindex="0">
            <div>
              ${statusBadge(item.status)}
              <h3>${esc(item.title)}</h3>
              <small>${esc(dateOnly(item.decision?.decidedAt || item.updatedAt))} · ${esc(item.owner || 'Unassigned')}</small>
            </div>
            <div>
              <strong>${esc(item.decision?.choice || 'Decision not finalized')}</strong>
              <p>${esc(item.decision?.rationale || item.summary || 'No rationale captured yet.')}</p>
            </div>
            <div>
              <span>${esc(item.workstream?.title || 'Portfolio-wide')}</span>
              <small><i class="fas fa-link"></i> ${item.evidenceCount || 0} evidence · <i class="fas fa-list-check"></i> ${item.linkedTaskCount || 0} task refs</small>
            </div>
          </article>`).join('')}
      </div>`;
  }

  function evidenceIcon(kind) {
    return ({
      artifact: 'fa-cube',
      commit: 'fa-code-commit',
      task_feedback: 'fa-message',
      benchmark: 'fa-trophy',
      alert: 'fa-bell',
      document: 'fa-file-lines',
      url: 'fa-link',
      note: 'fa-note-sticky',
      schedule_run: 'fa-clock-rotate-left'
    })[kind] || 'fa-paperclip';
  }

  function renderEvidence() {
    const evidenceSearch = state.search.toLowerCase();
    const evidence = allItems()
      .filter((item) => itemMatches(item, { ignoreSearch: true }))
      .flatMap((item) => (item.evidence || []).map((entry) => ({ ...entry, planningItem: item })))
      .filter((entry) => !evidenceSearch || [
        entry.label, entry.kind, entry.ref, entry.note, entry.addedBy,
        itemSearchText(entry.planningItem)
      ].join(' ').toLowerCase().includes(evidenceSearch))
      .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
    if (!evidence.length) {
      return emptyState({
        icon: 'fa-folder-open',
        eyebrow: 'Evidence room',
        title: 'Evidence is ready for proof',
        copy: 'Open any planning item to attach a commit, benchmark, alert, artifact, document, URL, note, or schedule run.',
        actions: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-view-target="portfolio"><i class="fas fa-layer-group"></i> Browse portfolio</button>'
      });
    }
    const counts = evidence.reduce((map, entry) => {
      map[entry.kind] = (map[entry.kind] || 0) + 1;
      return map;
    }, {});
    return `
      <div class="planning-evidence-summary">
        <div><span class="planning-section-kicker">Evidence</span><h3>${evidence.length} evidence record${evidence.length === 1 ? '' : 's'}</h3></div>
        <div>${Object.entries(counts).slice(0, 6).map(([kind, count]) => `<span><i class="fas ${evidenceIcon(kind)}"></i>${esc(formatStatus(kind))}<strong>${count}</strong></span>`).join('')}</div>
      </div>
      <div class="planning-evidence-grid">${evidence.map((entry) => `
        <article class="planning-evidence-card" data-planning-item-id="${esc(entry.planningItem.id)}" tabindex="0">
          <span class="planning-evidence-icon"><i class="fas ${evidenceIcon(entry.kind)}"></i></span>
          <div>
            <span class="planning-section-kicker">${esc(formatStatus(entry.kind))}</span>
            <h4>${entry.url ? `<a href="${esc(entry.url)}" target="_blank" rel="noopener" data-planning-link>${esc(entry.label)}</a>` : esc(entry.label)}</h4>
            <p>${esc(entry.note || entry.ref || 'No evidence note.')}</p>
            <footer><span><i class="fas ${TYPE_META[entry.planningItem.type]?.icon || 'fa-circle'}"></i>${esc(entry.planningItem.title)}</span><time>${esc(dateOnly(entry.addedAt))}</time></footer>
          </div>
        </article>`).join('')}</div>`;
  }

  function workspaceActions() {
    const actions = {
      portfolio: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-create-type="workstream"><i class="fas fa-plus"></i> Workstream</button>',
      goals: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-create-type="outcome"><i class="fas fa-plus"></i> Goal</button>',
      roadmap: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-create-type="milestone"><i class="fas fa-plus"></i> Milestone</button>',
      board: '<a class="planning-btn planning-btn-secondary" href="/pipeline"><i class="fas fa-list-check"></i> Open pipeline</a>',
      ideas: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-create-type="idea"><i class="fas fa-plus"></i> Idea</button>',
      decisions: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-create-type="decision"><i class="fas fa-plus"></i> Decision</button>',
      evidence: ''
    };
    return actions[state.activeView] || '';
  }

  function renderCurrentView() {
    const meta = VIEW_META[state.activeView] || VIEW_META.portfolio;
    $('planningWorkspaceTitle').textContent = state.attentionOnly ? 'Needs attention' : meta.title;
    $('planningWorkspaceMeta').textContent = state.attentionOnly
      ? 'Historical Planning flags shown beside current Pipeline blockers; they are not one execution state.'
      : meta.description;
    $('planningWorkspaceActions').innerHTML = workspaceActions();
    const renderers = {
      portfolio: renderPortfolio,
      goals: renderGoals,
      roadmap: renderRoadmap,
      board: renderBoard,
      ideas: renderIdeas,
      decisions: renderDecisions,
      evidence: renderEvidence
    };
    $('planningCanvas').innerHTML = (renderers[state.activeView] || renderPortfolio)();
  }

  function renderAttention() {
    const items = allItems()
      .filter((item) => item.isOverdue || ['at_risk', 'blocked'].includes(item.status))
      .sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue))
      .slice(0, 6);
    const blockedTasks = (state.dashboard?.tasks || []).filter((task) => task.status === 'blocked').slice(0, 4);
    const count = items.length + blockedTasks.length;
    $('planningAttentionCountRail').textContent = count;
    $('planningAttentionMeta').textContent = count
      ? `${count} historical-record or current-Pipeline signal${count === 1 ? '' : 's'}`
      : 'No recorded Planning flags or current Pipeline blockers';
    const rows = [
      ...items.map((item) => `
        <button type="button" class="planning-side-item planning-side-alert" data-planning-item-id="${esc(item.id)}">
          <span class="planning-side-icon"><i class="fas ${item.isOverdue ? 'fa-calendar-xmark' : 'fa-triangle-exclamation'}"></i></span>
          <span><strong>${esc(item.title)}</strong><small>${esc(item.isOverdue ? `Recorded target passed · ${dateOnly(item.dates?.targetAt)}` : `${TYPE_META[item.type]?.label || item.type} · ${statusLabel(item.status)}`)}</small></span>
          <i class="fas fa-chevron-right"></i>
        </button>`),
      ...blockedTasks.map((task) => `
        <a class="planning-side-item planning-side-alert" href="/pipeline">
          <span class="planning-side-icon"><i class="fas fa-ban"></i></span>
          <span><strong>[${esc(task.pipelineId)}] ${esc(task.title)}</strong><small>Pipeline blocker · ${esc(task.service || task.epic || 'unclassified')}</small></span>
          <i class="fas fa-chevron-right"></i>
        </a>`)
    ];
    $('planningAttentionList').innerHTML = rows.length
      ? rows.join('')
      : '<div class="planning-quiet-state"><i class="fas fa-shield-check"></i><span><strong>No flags</strong><small>No historical Planning flags or current Pipeline blockers.</small></span></div>';
  }

  function renderUnlinked() {
    const tasks = state.dashboard?.unlinkedTasks || [];
    $('planningUnlinkedMeta').textContent = tasks.length
      ? `${tasks.length} open Pipeline task${tasks.length === 1 ? '' : 's'} without a historical Planning reference`
      : 'Every open Pipeline task carries a historical Planning reference';
    $('planningUnlinkedList').innerHTML = tasks.length
      ? tasks.slice(0, 6).map((task) => `
        <article class="planning-side-task">
          <span class="planning-task-id">${esc(task.pipelineId)}</span>
          <div><strong>${esc(task.title)}</strong><small>${esc(task.service || task.epic || 'unclassified')} · ${esc(formatStatus(task.status))}</small></div>
          <button type="button" data-planning-organize-task="${esc(task.pipelineId)}" title="Create and link a planning item"><i class="fas fa-plus"></i></button>
        </article>`).join('')
      : '<div class="planning-quiet-state"><i class="fas fa-link"></i><span><strong>References present</strong><small>This does not change Pipeline execution ownership.</small></span></div>';
  }

  function renderSchedules() {
    const upcoming = state.dashboard?.upcoming || [];
    $('planningScheduleMeta').textContent = `${state.dashboard?.summary?.schedules || 0} enabled entr${state.dashboard?.summary?.schedules === 1 ? 'y' : 'ies'} · execution is owned by Runtime`;
    $('planningScheduleList').innerHTML = upcoming.length
      ? upcoming.slice(0, 6).map((job) => `
        <article class="planning-side-schedule">
          <span class="planning-schedule-time">${esc(relativeTime(job.nextRun))}</span>
          <div><strong>${esc(job.name)}</strong><small>${esc(job.agent || job.source || 'system')} · ${esc(job.host || 'unassigned')}</small></div>
          <i class="fas fa-clock"></i>
        </article>`).join('')
      : '<div class="planning-quiet-state"><i class="fas fa-moon"></i><span><strong>No upcoming jobs</strong><small>The runtime schedule is quiet.</small></span></div>';
  }

  function renderAll() {
    renderPulse();
    renderCurrentView();
    renderAttention();
    renderUnlinked();
    renderSchedules();
  }

  function setLoading(loading) {
    state.loading = loading;
    const button = $('planningRefreshBtn');
    button.disabled = loading;
    button.innerHTML = loading ? '<i class="fas fa-spinner fa-spin"></i>' : '<i class="fas fa-rotate"></i>';
  }

  async function loadDashboard() {
    setLoading(true);
    try {
      state.dashboard = await api('/api/planning/dashboard');
      renderAll();
      document.dispatchEvent(new CustomEvent('planning:data', { detail: state.dashboard }));
    } catch (error) {
      $('planningCanvas').innerHTML = emptyState({
        icon: 'fa-cloud-bolt',
        eyebrow: 'Planning unavailable',
        title: 'The planning data could not be loaded',
        copy: error.message,
        actions: '<button type="button" class="planning-btn planning-btn-secondary" data-planning-retry><i class="fas fa-rotate"></i> Retry</button>'
      });
    } finally {
      setLoading(false);
    }
  }

  async function bootstrapPipeline({ includeEmpty = false } = {}) {
    const count = state.dashboard?.summary?.unlinkedTasks || 0;
    const prompt = includeEmpty
      ? 'Create the six AgentX starter workstreams? You can rename or archive any of them.'
      : `Organize ${count} unlinked open task${count === 1 ? '' : 's'} into AgentX workstreams?`;
    if (!confirm(prompt)) return;
    const button = $('planningBootstrapBtn');
    button.disabled = true;
    try {
      const result = await api('/api/planning/bootstrap', {
        method: 'POST',
        body: JSON.stringify({ by: 'operator', includeEmpty })
      });
      window.Toast?.success?.(
        `Created ${result.workstreamsCreated} workstream(s), linked ${result.tasksLinked} task(s).`
      );
      await loadDashboard();
    } catch (error) {
      window.Toast?.error?.(error.message);
      if (!window.Toast) alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function quickUpdateItem(id, patch, successMessage = '') {
    try {
      await api(`/api/planning/items/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, by: 'operator' })
      });
      if (successMessage) window.Toast?.success?.(successMessage);
      await loadDashboard();
    } catch (error) {
      window.Toast?.error?.(error.message);
      if (!window.Toast) alert(error.message);
    }
  }

  function closeTaskOrganizer() {
    $('planningTaskModalBackdrop').hidden = true;
    state.organizingTask = null;
    state.taskCandidates = [];
    if (!$('planningDrawer').classList.contains('open') && $('planningModalBackdrop').hidden) {
      document.body.style.overflow = '';
    }
    state.taskOrganizerTrigger?.focus?.();
    state.taskOrganizerTrigger = null;
  }

  function renderTaskCandidates(query = '') {
    const normalized = query.trim().toLowerCase();
    const candidates = state.taskCandidates.filter((item) => !normalized || [
      item.title, item.type, item.workstream?.title, item.owner
    ].join(' ').toLowerCase().includes(normalized));
    $('planningTaskItemSelect').innerHTML = candidates.length
      ? candidates.map((item) =>
        `<option value="${esc(item.id)}">${esc(TYPE_META[item.type]?.label || item.type)} · ${esc(item.title)}${item.workstream?.title ? ` — ${esc(item.workstream.title)}` : ''}</option>`
      ).join('')
      : '<option value="">No planning items match</option>';
    $('planningTaskLinkBtn').disabled = !candidates.length;
    $('planningTaskItemHelp').textContent = candidates.length
      ? `${candidates.length} available · milestones are shown first.`
      : 'Try a broader search or create a new milestone for this task.';
  }

  function openTaskOrganizer(task, trigger = null) {
    if (!task) return;
    state.organizingTask = task;
    state.taskOrganizerTrigger = trigger || document.activeElement;
    state.taskCandidates = allItems()
      .filter((item) =>
        ['workstream', 'outcome', 'milestone'].includes(item.type)
        && !['completed', 'archived'].includes(item.status)
      )
      .sort((a, b) => {
        const order = { milestone: 0, outcome: 1, workstream: 2 };
        return (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.title.localeCompare(b.title);
      });
    $('planningTaskModalTitle').textContent = `[${task.pipelineId}] ${task.title}`;
    $('planningTaskModalMeta').textContent = 'Choose the intent this work advances.';
    $('planningTaskContext').innerHTML = `
      <span class="planning-task-id">${esc(task.pipelineId)}</span>
      <div><strong>${esc(task.title)}</strong><small>${esc(taskMeta(task))}</small></div>`;
    $('planningTaskItemSearch').value = '';
    renderTaskCandidates();
    $('planningTaskModalBackdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => $('planningTaskItemSearch').focus());
  }

  async function linkOrganizedTask() {
    const task = state.organizingTask;
    const itemId = $('planningTaskItemSelect').value;
    if (!task || !itemId) return;
    const button = $('planningTaskLinkBtn');
    button.disabled = true;
    try {
      await api(`/api/planning/items/${encodeURIComponent(itemId)}/tasks/${encodeURIComponent(task.pipelineId)}`, {
        method: 'POST',
        body: JSON.stringify({ by: 'operator' })
      });
      window.Toast?.success?.(`Linked task ${task.pipelineId}.`);
      closeTaskOrganizer();
      await loadDashboard();
    } catch (error) {
      window.Toast?.error?.(error.message);
      if (!window.Toast) alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function selectView(view, { attentionOnly = false } = {}) {
    state.activeView = VIEW_META[view] ? view : 'portfolio';
    state.attentionOnly = attentionOnly;
    document.querySelectorAll('[data-planning-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.planningView === state.activeView);
    });
    renderCurrentView();
  }

  function clearFilters() {
    state.search = '';
    state.status = '';
    state.type = '';
    state.attentionOnly = false;
    $('planningSearchInput').value = '';
    $('planningStatusFilter').value = '';
    $('planningTypeFilter').value = '';
    renderCurrentView();
  }

  function closeCreateMenu() {
    $('planningCreateMenu').hidden = true;
    $('planningCreateBtn').setAttribute('aria-expanded', 'false');
  }

  function openCreate(options = {}) {
    closeCreateMenu();
    window.PlanningEditor?.openCreate(options);
  }

  function bindEvents() {
    $('planningRefreshBtn').addEventListener('click', loadDashboard);
    $('planningBootstrapBtn').addEventListener('click', () => selectView('board'));
    $('planningCreateBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = $('planningCreateMenu').hidden;
      $('planningCreateMenu').hidden = !willOpen;
      $('planningCreateBtn').setAttribute('aria-expanded', String(willOpen));
    });
    $('planningSearchInput').addEventListener('input', (event) => {
      state.search = event.target.value || '';
      renderCurrentView();
    });
    $('planningStatusFilter').addEventListener('change', (event) => {
      state.status = event.target.value || '';
      renderCurrentView();
    });
    $('planningTypeFilter').addEventListener('change', (event) => {
      state.type = event.target.value || '';
      renderCurrentView();
    });
    document.querySelectorAll('[data-planning-view]').forEach((button) => {
      button.addEventListener('click', () => selectView(button.dataset.planningView));
    });
    $('planningTaskCloseBtn').addEventListener('click', closeTaskOrganizer);
    $('planningTaskCancelBtn').addEventListener('click', closeTaskOrganizer);
    $('planningTaskLinkBtn').addEventListener('click', linkOrganizedTask);
    $('planningTaskItemSearch').addEventListener('input', (event) => renderTaskCandidates(event.target.value));
    $('planningTaskCreateBtn').addEventListener('click', () => {
      const task = state.organizingTask;
      closeTaskOrganizer();
      if (task) openCreate({ task, type: 'milestone' });
    });
    $('planningTaskModalBackdrop').addEventListener('click', (event) => {
      if (event.target === $('planningTaskModalBackdrop')) closeTaskOrganizer();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.planning-create-wrap')) closeCreateMenu();

      const ideaAction = event.target.closest('[data-idea-action]');
      if (ideaAction) {
        return quickUpdateItem(
          ideaAction.dataset.ideaId,
          { status: ideaAction.dataset.ideaAction, note: `Idea moved to ${ideaAction.dataset.ideaAction}` },
          `Idea moved to ${formatStatus(ideaAction.dataset.ideaAction)}.`
        );
      }
      const ideaPromote = event.target.closest('[data-idea-promote]');
      if (ideaPromote) return window.PlanningEditor?.openItem(ideaPromote.dataset.ideaPromote);

      const create = event.target.closest('[data-planning-create-type]');
      if (create) {
        return openCreate({ type: create.dataset.planningCreateType });
      }
      const child = event.target.closest('[data-planning-create-child]');
      if (child) {
        return openCreate({
          type: child.dataset.planningCreateChild,
          workstreamId: child.dataset.workstreamId || '',
          parentId: child.dataset.parentId || ''
        });
      }
      const targetView = event.target.closest('[data-planning-view-target]');
      if (targetView) {
        return selectView(targetView.dataset.planningViewTarget, {
          attentionOnly: targetView.hasAttribute('data-planning-attention')
        });
      }
      if (event.target.closest('[data-planning-clear-filters]')) return clearFilters();
      if (event.target.closest('[data-planning-starter]')) return bootstrapPipeline({ includeEmpty: true });
      if (event.target.closest('[data-planning-review-intake]')) return selectView('board');
      if (event.target.closest('[data-planning-retry]')) return loadDashboard();

      const organize = event.target.closest('[data-planning-organize-task]');
      if (organize) {
        const task = (state.dashboard?.unlinkedTasks || [])
          .find((row) => row.pipelineId === organize.dataset.planningOrganizeTask);
        return openTaskOrganizer(task, organize);
      }

      if (event.target.closest('[data-planning-link]')) return;
      const item = event.target.closest('[data-planning-item-id]');
      if (item) window.PlanningEditor?.openItem(item.dataset.planningItemId);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('planningTaskModalBackdrop').hidden) {
        closeTaskOrganizer();
        return;
      }
      const card = event.target.closest?.('[data-planning-item-id]');
      if (card && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        window.PlanningEditor?.openItem(card.dataset.planningItemId);
      }
    });
  }

  window.PlanningApp = {
    state,
    api,
    esc,
    formatStatus,
    statusLabel,
    progressLabel,
    progressMeaning,
    isFrozenReference,
    dateOnly,
    relativeTime,
    typeMeta: TYPE_META,
    reload: loadDashboard,
    selectView,
    getItem(id) {
      return allItems().find((item) => item.id === id) || null;
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadDashboard();
  });
})();

// Dreaming Review — confidence-tiered, policy-automatic, and intentionally calm.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    runs: [], insights: null, selectedRunId: null, run: null,
    filter: 'all', runFilter: 'all', runSearch: '', applyEnabled: false, safeAutomationEnabled: false,
    pendingAction: null, returnFocus: null, focusAfter: null,
  };
  const labels = {
    ready_for_review: 'Ready for review', partially_reviewed: 'Partially reviewed', completed: 'Complete',
    failed: 'Needs attention', collecting: 'Collecting', synthesizing: 'Reflecting',
    proposed: 'Exception', approved: 'Approved', auto_approved: 'Policy approved', rejected: 'Ignored', deferred: 'Deferred',
    parked: 'Parked', shadowed: 'Shadowed', applied: 'Applied', apply_failed: 'Apply failed', applying: 'Applying',
    shared_fact: 'Shared memory', soft_memory: 'Working memory', artifact: 'Knowledge artifact', runtime_local: 'Runtime-local proposal',
    skill_draft: 'Skill draft', pipeline_task: 'Follow-up task', git_change: 'Source change', ignore: 'No action',
    agentx: 'AgentX', 'claude-code': 'Claude Code', codex: 'Codex', external: 'External',
  };
  const trustHelp = {
    explicit_memory_request: 'You explicitly asked an agent to remember this.',
    authenticated_owner_statement: 'This was observed in an authenticated owner turn; Core still decides whether it is fact, inference, or noise.',
    observed_project_event: 'This came from the configured accepted project history. It is event context, not a personal preference.',
    verified_runtime_evidence: 'The runtime directly verified this state.',
    verified_git_or_test_outcome: 'A repository or test result independently verified it.',
    explicit_owner_instruction: 'This came from a direct owner instruction.',
    repeated_owner_preference: 'The same owner preference appeared in independent sessions.',
  };
  const targetHelp = {
    shared_fact: ['AgentX shared memory', 'Becomes searchable shared knowledge after this one approved write.', 'Rollback removes the created memory document.'],
    soft_memory: ['AgentX working memory', 'Stores a provisional, confidence-tagged inference with expiry.', 'Rollback removes the working-memory document; recall never confirms it.'],
    artifact: ['AgentX knowledge artifact', 'Creates a concise durable artifact—never a transcript archive.', 'Rollback removes the created artifact document.'],
    pipeline_task: ['AgentX delivery pipeline', 'Creates one reviewable, unassigned follow-up task.', 'Rollback closes the task as cancelled.'],
    git_change: ['Governed source change', 'Creates a follow-up task or exact patch proposal; it does not edit git automatically.', 'No repository file is changed by this apply.'],
    skill_draft: ['Skill authoring lane', 'Creates a reviewed draft/task; it never installs a runtime skill.', 'No live skill is changed by this apply.'],
    runtime_local: ['Owning runtime', 'Produces a copyable pending proposal for the owning runtime; AgentX writes nothing there.', 'Nothing external is changed automatically.'],
    ignore: ['No destination', 'This classification is retained for audit only.', 'No semantic write is available.'],
  };

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* non-JSON error */ }
    if (!response.ok || payload.status === 'error') throw new Error(payload.message || `HTTP ${response.status}`);
    return payload.data !== undefined ? payload.data : payload;
  }

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function label(value) {
    return labels[value] || String(value || 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function shortDate(value) {
    if (!value) return 'Unknown time';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value).slice(0, 16) : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function friendlyRunTitle(run) {
    const date = new Date(run.completedAt || run.createdAt);
    if (Number.isNaN(date.valueOf())) return 'Dreaming review';
    const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${time} review`;
  }

  function relativeDate(value) {
    if (!value) return 'not seen yet';
    const delta = Date.now() - new Date(value).valueOf();
    if (!Number.isFinite(delta)) return shortDate(value);
    const minutes = Math.max(0, Math.round(delta / 60000));
    if (minutes < 2) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function evidenceWindow(windowValue) {
    const from = new Date(windowValue?.from);
    const to = new Date(windowValue?.to);
    const days = Math.round((to - from) / 86400000);
    if (Number.isFinite(days) && days > 0) return `${days}-day evidence window`;
    return `${shortDate(windowValue?.from)} → ${shortDate(windowValue?.to)}`;
  }

  function toast(message, type = 'info') {
    $('mrLiveStatus').textContent = message;
    if (window.AgentXUtils && typeof window.AgentXUtils.showToast === 'function') {
      window.AgentXUtils.showToast(message, type);
    }
  }

  async function copyText(text, success) {
    try {
      await navigator.clipboard.writeText(text);
      toast(success, 'success');
    } catch { toast('Could not copy to the clipboard.', 'error'); }
  }

  async function loadConfig() {
    try {
      const config = await apiJson('/api/memory-review/config');
      state.applyEnabled = !!config.applyEnabled;
      state.safeAutomationEnabled = !!config.safeAutomationEnabled;
      const badge = $('mrModeBadge');
      badge.textContent = config.safeAutomationEnabled
        ? `Safe automation · ${config.reviewExceptionBudget} exceptions max`
        : config.automationMode === 'shadow' ? 'Standing policy · shadow evaluation' : 'Manual compatibility mode';
      badge.classList.toggle('mr-mode-apply', config.mode === 'apply');
    } catch (error) {
      $('mrModeBadge').textContent = 'Configuration unavailable';
      toast(`Dreaming configuration unavailable: ${error.message}`, 'error');
    }
  }

  function renderOverview() {
    const insight = state.insights;
    if (!insight) {
      const latest = state.runs.find((run) => ['ready_for_review', 'partially_reviewed', 'completed'].includes(run.status)) || state.runs[0];
      const counts = state.runs.reduce((totals, run) => {
        const review = run.reviewCounts || {};
        totals.pending += (review.proposed || 0) + (review.deferred || 0);
        totals.applied += review.applied || 0;
        return totals;
      }, { pending: 0, applied: 0 });
      $('mrStatRuns').textContent = !latest ? 'Waiting' : counts.pending ? `${counts.pending} ready` : latest.summary?.noEligibleObservations ? 'Quiet' : label(latest.status);
      $('mrStatPending').textContent = counts.pending;
      $('mrStatApplied').textContent = counts.applied;
      const errors = latest?.collectorSummary?.errors || 0;
      const overdue = state.runs.filter((run) => run.reconciliation?.overdue).length;
      $('mrStatHealth').textContent = errors ? `${errors} issue${errors === 1 ? '' : 's'}` : overdue ? `${overdue} overdue` : latest ? 'Healthy' : 'Waiting';
      $('mrStatHealth').classList.toggle('mr-stat-warning', !!errors || !!overdue);
      $('mrStatHealth').title = errors ? 'Current collector errors' : overdue ? 'An unfinished cross-host reconciliation passed its recovery window' : 'Summary unavailable; derived from run history';
      return;
    }
    const latest = insight.latest;
    $('mrStatRuns').textContent = !latest ? 'Waiting' : latest.pending ? `${latest.pending} ready` : latest.quiet ? 'Quiet' : label(latest.status);
    $('mrStatPending').textContent = insight.totals.pending;
    $('mrStatApplied').textContent = insight.totals.applied;
    const healthLabel = insight.health.errors
      ? `${insight.health.errors} collector issue${insight.health.errors === 1 ? '' : 's'}`
      : insight.health.overdue
        ? `${insight.health.overdue} overdue`
        : insight.health.stale
          ? `${insight.health.stale} stale collector${insight.health.stale === 1 ? '' : 's'}`
          : insight.health.missing
            ? `${insight.health.missing} collector${insight.health.missing === 1 ? '' : 's'} not observed`
            : 'Healthy';
    $('mrStatHealth').textContent = !latest ? 'Waiting' : healthLabel;
    $('mrStatHealth').classList.toggle('mr-stat-warning', insight.health.state === 'attention');
    $('mrStatHealth').title = insight.health.errors ? 'Current collector errors'
      : insight.health.overdue ? 'An unfinished cross-host reconciliation passed its recovery window'
        : insight.health.stale ? `${insight.health.staleRuntimes.map(label).join(', ')} ${insight.health.stale === 1 ? 'has' : 'have'} not contributed within the freshness window`
        : insight.health.missing ? `${insight.health.missingRuntimes.map(label).join(', ')} ${insight.health.missing === 1 ? 'has' : 'have'} not supplied evidence in this window`
        : insight.health.advisories ? `${insight.health.advisories} non-blocking advisories` : 'No current collector errors';
  }

  function renderPulse() {
    const insight = state.insights;
    const pulse = $('mrPulse');
    if (!insight?.latest) {
      pulse.className = 'mr-pulse mr-pulse-quiet';
      $('mrPulseIcon').className = 'fas fa-moon';
      $('mrPulseTitle').textContent = 'The first dream is still ahead';
      $('mrPulseText').textContent = 'Scheduled collection will appear here without moving raw sessions off their hosts.';
      $('mrPulseFacts').innerHTML = '';
      return;
    }
    const { latest, totals, health } = insight;
    let tone = 'healthy';
    let icon = 'fa-sparkles';
    let title = 'The ecosystem is calm';
    let text = 'Recent evidence was reviewed safely and there is nothing requiring your attention.';
    if (health.errors) {
      tone = 'attention'; icon = 'fa-triangle-exclamation'; title = 'A collector needs attention';
      text = `${health.errors} current collector issue${health.errors === 1 ? '' : 's'} should be inspected before trusting coverage.`;
    } else if (health.overdue) {
      const missing = health.activeRun?.reconciliation?.missingRuntimes || [];
      tone = 'attention'; icon = 'fa-clock-rotate-left'; title = 'A Dreaming handoff is overdue';
      text = `${health.activeRun?.runId || 'The active run'} is safely holding accepted evidence${missing.length ? ` while waiting for ${missing.map(label).join(' and ')}` : ''}. The next reconciliation automatically recovers it.`;
    } else if (health.stale) {
      tone = 'attention'; icon = 'fa-clock'; title = `${health.stale} collector${health.stale === 1 ? '' : 's'} ${health.stale === 1 ? 'is' : 'are'} stale`;
      text = `${health.staleRuntimes.map(label).join(', ')} ${health.stale === 1 ? 'has' : 'have'} not supplied evidence within the expected freshness window.`;
    } else if (health.missing) {
      tone = 'attention'; icon = 'fa-circle-minus'; title = 'Collector coverage is incomplete';
      text = `${health.missingRuntimes.map(label).join(', ')} ${health.missing === 1 ? 'has' : 'have'} not supplied evidence, so quality metrics remain unknown.`;
    } else if (totals.pending) {
      tone = 'ready'; icon = 'fa-inbox'; title = `${totals.pending} memor${totals.pending === 1 ? 'y is' : 'ies are'} waiting for you`;
      text = 'Each proposal is evidence-backed and remains inert until you review it individually.';
    } else if (health.collecting) {
      tone = 'collecting'; icon = 'fa-satellite-dish'; title = 'Agents are gathering tonight’s signal';
      text = 'A partial host submission is open. The completed dream below remains the best current summary.';
    } else if (latest.quiet) {
      tone = 'quiet'; icon = 'fa-moon'; title = 'Quiet night—nothing trustworthy new';
      text = 'Noise was filtered locally, no proposal was needed, and the review model was not called.';
    } else if (latest.candidates) {
      title = `${latest.candidates} proposal${latest.candidates === 1 ? '' : 's'} processed safely`;
      text = 'The latest completed dream is fully reflected in the review history below.';
    }
    pulse.className = `mr-pulse mr-pulse-${tone}`;
    $('mrPulseIcon').className = `fas ${icon}`;
    $('mrPulseTitle').textContent = title;
    $('mrPulseText').textContent = text;
    $('mrPulseFacts').innerHTML = [
      `<span><i class="fas fa-clock"></i> ${esc(relativeDate(latest.completedAt || latest.createdAt))}</span>`,
      `<span><i class="fas fa-filter"></i> ${totals.filteredObservations} filtered</span>`,
      `<span><i class="fas fa-leaf"></i> ${totals.modelSkips} review-model call${totals.modelSkips === 1 ? '' : 's'} avoided</span>`,
      health.advisories ? `<span title="Non-blocking schema or identity drift"><i class="fas fa-circle-info"></i> ${health.advisories} ${health.advisories === 1 ? 'advisory' : 'advisories'}</span>` : '<span><i class="fas fa-shield"></i> No semantic automation</span>',
    ].join('');
  }

  function metric(metricEvidence, name, detail, { suffix = '', historicalValue = null } = {}) {
    const evidence = metricEvidence || {};
    const current = evidence.state === 'current' && evidence.value != null;
    const value = current ? `${evidence.value}${suffix}` : '—';
    const state = evidence.state || 'unavailable';
    let evidenceDetail = detail;
    if (!current) {
      const lastValue = evidence.lastValue == null ? historicalValue : evidence.lastValue;
      const measured = lastValue == null ? '' : ` Historical result: ${lastValue}${suffix}.`;
      const lastSeen = evidence.observedAt ? ` Last evidence ${relativeDate(evidence.observedAt)}.` : '';
      const reasons = {
        stale: 'Collector coverage is stale.',
        partial: 'Collector coverage is incomplete.',
        attention: 'Collector or reconciliation evidence needs attention.',
        insufficient: 'No measured denominator is available.',
        unavailable: 'Evidence is unavailable.',
      };
      evidenceDetail = `${reasons[state] || reasons.unavailable}${lastSeen}${measured}`;
    }
    return `<div class="mr-quality-metric mr-metric-${esc(state)}"><strong>${esc(value)}</strong><span>${esc(name)}</span><small>${esc(evidenceDetail)}</small></div>`;
  }

  function distributionBars(values, emptyText) {
    const entries = Object.entries(values || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!entries.length) return `<div class="mr-mini-empty">${esc(emptyText)}</div>`;
    const max = entries[0][1];
    return entries.map(([name, count]) => `<div class="mr-atlas-row"><span>${esc(label(name))}</span><i><i style="width:${Math.max(8, Math.round(count / max * 100))}%"></i></i><b>${count}</b></div>`).join('');
  }

  function renderInsights() {
    const insight = state.insights;
    if (!insight) return;
    $('mrInsightsState').hidden = true;
    $('mrInsightsGrid').hidden = false;
    $('mrRuntimeGrid').innerHTML = insight.runtimes.map((runtime) => `<div class="mr-runtime-tile mr-runtime-${esc(runtime.health)}">
      <div><i class="fas ${runtime.health === 'attention' ? 'fa-triangle-exclamation' : runtime.health === 'stale' ? 'fa-clock' : runtime.health === 'not_seen' ? 'fa-circle-minus' : 'fa-circle-check'}"></i><strong>${esc(label(runtime.runtime))}</strong></div>
      <span>${runtime.eligible} ${runtime.eligible === 1 ? 'signal' : 'signals'} · ${runtime.filtered} filtered</span>
      <small>${runtime.lastSeen ? `Seen ${esc(relativeDate(runtime.lastSeen))}` : 'No recent contribution'}${runtime.currentAdvisories ? ` · ${runtime.currentAdvisories} ${runtime.currentAdvisories === 1 ? 'advisory' : 'advisories'}` : ''}</small>
    </div>`).join('');
    const metrics = insight.quality.metrics || {};
    $('mrQualityGrid').innerHTML = [
      metric(metrics.filterRate, 'Noise filtered', `${insight.totals.filteredObservations} of ${metrics.filterRate?.denominator || 0} observations stopped before synthesis`, { suffix: '%', historicalValue: insight.quality.filterRate }),
      metric(metrics.approvalPrecision, 'Approval precision', `${metrics.approvalPrecision?.denominator || 0} approve/reject decisions measured`, { suffix: '%', historicalValue: insight.quality.approvalPrecision }),
      metric(metrics.modelSkips, 'Review-model calls saved', 'Empty evidence windows stay deterministic', { historicalValue: insight.totals.modelSkips }),
      metric(metrics.crossRuntime, 'Cross-agent consensus', 'Candidates confirmed by multiple runtimes', { historicalValue: insight.quality.crossRuntime }),
      metric(metrics.conflicts, 'Conflicts surfaced', 'Never resolved silently', { historicalValue: insight.quality.conflicts }),
      metric(metrics.riskFlags, 'Risk flags', 'Privacy, governance, staleness, or injection', { historicalValue: insight.quality.riskFlags }),
    ].join('');
    $('mrAtlas').innerHTML = `<div><h4>Candidate types</h4>${distributionBars(insight.distributions.candidateTypes, 'The atlas will grow with the first trustworthy proposal.')}</div>
      <div><h4>Destinations</h4>${distributionBars(insight.distributions.targets, 'No semantic destination has been proposed yet.')}</div>`;
  }

  async function loadInsights() {
    try {
      state.insights = await apiJson('/api/memory-review/insights?limit=30');
      renderOverview(); renderPulse(); renderInsights();
    } catch (error) {
      $('mrInsightsState').textContent = `Insight summary unavailable: ${error.message}`;
      $('mrPulse').className = 'mr-pulse mr-pulse-attention';
      $('mrPulseIcon').className = 'fas fa-triangle-exclamation';
      $('mrPulseTitle').textContent = 'Run history is still available';
      $('mrPulseText').textContent = 'The optional aggregate summary could not load. Candidate review remains unaffected.';
      renderOverview();
    }
  }

  function visibleRuns() {
    const search = state.runSearch.toLowerCase();
    return state.runs.filter((run) => {
      if (search && !`${run.runId} ${(run.collectorSummary?.runtimes || []).join(' ')}`.toLowerCase().includes(search)) return false;
      if (state.runFilter === 'attention') return run.status === 'failed' || (run.collectorSummary?.errors || 0) > 0 || run.reconciliation?.overdue;
      if (state.runFilter === 'active') return ['collecting', 'synthesizing'].includes(run.status);
      if (state.runFilter === 'completed') return run.status === 'completed';
      return true;
    });
  }

  function renderRuns() {
    const list = $('mrRunList');
    const visible = visibleRuns();
    $('mrRunsMeta').textContent = `${visible.length} of ${state.runs.length}`;
    if (!visible.length) {
      list.innerHTML = '<li class="mr-mini-empty">No runs match this view.</li>';
      return;
    }
    list.innerHTML = visible.map((run) => {
      const review = run.reviewCounts || {};
      const pending = (review.proposed || 0) + (review.deferred || 0);
      const runtimes = run.collectorSummary?.runtimes || [];
      const hasError = run.status === 'failed' || (run.collectorSummary?.errors || 0) > 0;
      const quiet = run.summary?.noEligibleObservations;
      const total = Object.values(review).reduce((sum, count) => sum + (Number(count) || 0), 0);
      const active = ['collecting', 'synthesizing'].includes(run.status);
      const overdue = !!run.reconciliation?.overdue;
      const outcome = pending ? `<b>${pending}</b> awaiting review`
        : overdue ? 'Handoff overdue'
          : active ? 'Collection in progress'
          : quiet ? 'Quiet · no reviewer call'
            : total ? 'Review complete' : 'No review candidates';
      return `<li><button type="button" class="mr-run-item ${run.runId === state.selectedRunId ? 'active' : ''}" data-run-id="${esc(run.runId)}">
        <span class="mr-run-title">${esc(friendlyRunTitle(run))}</span><span class="mr-chip mr-status-${esc(hasError || overdue ? 'failed' : run.status)}">${esc(label(hasError || overdue ? 'failed' : run.status))}</span>
        <small class="mr-run-id" title="${esc(run.runId)}">${esc(run.runId)}</small>
        <span class="mr-run-foot"><span>${outcome}</span><span>${esc(runtimes.map(label).join(' · ') || 'No collectors')}</span></span>
      </button></li>`;
    }).join('');
    list.querySelectorAll('[data-run-id]').forEach((button) => button.addEventListener('click', () => selectRun(button.dataset.runId)));
  }

  async function loadRuns({ select = true } = {}) {
    const message = $('mrRunsState');
    message.hidden = false;
    message.textContent = 'Loading dreams…';
    $('mrRunList').hidden = true;
    try {
      const data = await apiJson('/api/memory-review/runs?limit=30');
      state.runs = data.runs || [];
      renderOverview();
      if (!state.runs.length) {
        message.innerHTML = '<strong>No dreams yet.</strong><br>The first scheduled reconciliation will appear here.';
        return;
      }
      renderRuns();
      $('mrRunList').hidden = false;
      message.hidden = true;
      if (select) {
        const requested = new URLSearchParams(window.location.search).get('run');
        const target = state.runs.find((run) => run.runId === requested)?.runId
          || state.selectedRunId
          || state.runs.find((run) => run.status === 'ready_for_review' || run.status === 'partially_reviewed')?.runId
          || state.runs.find((run) => run.status === 'completed')?.runId
          || state.runs[0].runId;
        await selectRun(target);
      }
    } catch (error) {
      message.textContent = `Could not load Dreaming runs: ${error.message}`;
      toast(message.textContent, 'error');
    }
  }

  async function selectRun(runId) {
    state.selectedRunId = runId;
    $('mrDetailEmpty').hidden = true;
    $('mrDetail').hidden = false;
    $('mrCandidatesState').hidden = false;
    $('mrCandidatesState').textContent = 'Loading this dream…';
    $('mrCandidateList').innerHTML = '';
    renderRuns();
    try {
      state.run = await apiJson(`/api/memory-review/runs/${encodeURIComponent(runId)}`);
      const url = new URL(window.location.href);
      url.searchParams.set('run', runId);
      window.history.replaceState({}, '', url);
      renderRun();
      if (state.focusAfter) {
        document.querySelector(`[data-candidate-id="${CSS.escape(state.focusAfter)}"]`)?.focus();
        state.focusAfter = null;
      }
    } catch (error) {
      $('mrCandidatesState').textContent = `Could not load this run: ${error.message}`;
      toast($('mrCandidatesState').textContent, 'error');
    }
  }

  function runNarrative(run) {
    const collectors = run.collectors || [];
    const eligible = collectors.reduce((sum, item) => sum + (item.eligibleObservations || 0), 0);
    const filtered = collectors.reduce((sum, item) => sum + (item.rejectedObservations || 0), 0);
    if (['collecting', 'synthesizing'].includes(run.status)) {
      const missing = run.reconciliation?.missingRuntimes || ['agentx', 'claude-code', 'codex', 'external'].filter((runtime) => !collectors.some((item) => item.runtime === runtime));
      if (run.reconciliation?.overdue) {
        return `<i class="fas fa-clock-rotate-left"></i><div><strong>Reconciliation handoff overdue</strong><span>Accepted evidence is preserved safely${missing.length ? ` while waiting for ${missing.map(label).join(' and ')}` : ''}. The next reconciliation run will recover this automatically; no memory change can occur meanwhile.</span></div>`;
      }
      const reflecting = run.status === 'synthesizing';
      return `<i class="fas ${reflecting ? 'fa-wand-magic-sparkles' : 'fa-satellite-dish'}"></i><div><strong>${reflecting ? 'Review in progress' : 'Collection in progress'}</strong><span>${reflecting ? 'Sanitized evidence is being turned into bounded proposals.' : missing.length ? `Waiting for ${missing.map(label).join(' and ')}.` : 'All contributors have checked in; finalization is next.'} The most recent completed run remains selected by default.</span></div>`;
    }
    if (run.status === 'failed') return `<i class="fas fa-triangle-exclamation"></i><div><strong>This dream needs attention</strong><span>Accepted observations are preserved and the failure is retryable. No apply path is available.</span></div>`;
    if (!(run.candidates || []).length) return `<i class="fas fa-moon"></i><div><strong>Quiet, healthy reconciliation</strong><span>${filtered} noisy or ineligible item${filtered === 1 ? '' : 's'} filtered; ${eligible ? `${eligible} eligible observation${eligible === 1 ? '' : 's'} produced no durable proposal.` : 'the review model was not needed.'}</span></div>`;
    const auto = (run.candidates || []).filter((item) => item.apply?.automated && item.status === 'applied').length;
    const exceptions = (run.candidates || []).filter((item) => ['proposed', 'deferred', 'apply_failed'].includes(item.status)).length;
    return `<i class="fas fa-sparkles"></i><div><strong>${auto} automatic update${auto === 1 ? '' : 's'} · ${exceptions} exception${exceptions === 1 ? '' : 's'}</strong><span>Safe reversible context flows automatically; only exceptions ask for judgment.</span></div>`;
  }

  function renderRun() {
    const run = state.run;
    const model = run.model || {};
    const hasApproved = (run.candidates || []).some((candidate) => ['approved', 'apply_failed'].includes(candidate.status));
    $('mrRunTitle').textContent = friendlyRunTitle(run);
    $('mrRunNarrative').innerHTML = runNarrative(run);
    $('mrRunFacts').innerHTML = [
      `<span class="mr-chip mr-status-${esc(run.status)}">${esc(label(run.status))}</span>`,
      `<span class="mr-chip">${run.mode === 'apply' ? 'Human-authorized apply' : 'Proposal-only run'}</span>`,
      run.summary?.automation ? `<span class="mr-chip">Policy ${esc(run.summary.automation.mode)} · budget ${esc(run.summary.automation.exceptionBudget)}</span>` : '',
      `<span title="${esc(shortDate(run.window?.from))} → ${esc(shortDate(run.window?.to))}"><i class="fas fa-calendar"></i> ${esc(evidenceWindow(run.window))}</span>`,
      `<span class="mr-run-id" title="Technical run id"><i class="fas fa-fingerprint"></i> ${esc(run.runId)}</span>`,
      `<span><i class="fas fa-microchip"></i> ${run.summary?.modelCalled ? `Review model · ${esc(model.model || 'model recorded')}` : run.status === 'synthesizing' ? 'Review model reflecting' : run.status === 'collecting' ? 'Review model pending' : 'Review model not called'}</span>`,
      run.dedupContext?.degraded ? '<span class="mr-chip mr-warn">Duplicate search degraded</span>' : '',
      run.failure?.stage ? `<span class="mr-chip mr-warn">Failed at ${esc(label(run.failure.stage))}</span>` : '',
      state.applyEnabled && run.mode !== 'apply' && hasApproved ? '<button type="button" class="mr-btn mr-btn-apply" id="mrAuthorizeApply"><i class="fas fa-key"></i> Authorize reviewed writes</button>' : '',
    ].filter(Boolean).join(' ');
    $('mrAuthorizeApply')?.addEventListener('click', (event) => openAction('authorize', null, event.currentTarget));
    $('mrCollectors').innerHTML = (run.collectors || []).map(renderCollector).join('') || '<div class="mr-collector">No collector reports.</div>';
    updateFilterCounts(); renderCandidates(); renderAudit();
  }

  function renderCollector(collector) {
    const errors = (collector.errors || []).length;
    const advisories = (collector.drift || []).length;
    const eligible = collector.eligibleObservations || 0;
    const sources = collector.sourceFilesSeen || 0;
    return `<details class="mr-collector ${errors ? 'mr-collector-error' : ''}" ${errors ? 'open' : ''}><summary>
      <span class="mr-runtime-icon"><i class="fas ${errors ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i></span>
      <strong>${esc(label(collector.runtime))}</strong><span>${esc(collector.host)}${collector.agentOrProfile ? ` · ${esc(collector.agentOrProfile)}` : ''}</span>
      <span class="mr-collector-counts"><b>${eligible}</b> signal${eligible === 1 ? '' : 's'} · ${collector.rejectedObservations || 0} filtered${advisories ? ` · ${advisories} ${advisories === 1 ? 'advisory' : 'advisories'}` : ''}</span>
    </summary><div class="mr-collector-detail">${sources} source${sources === 1 ? '' : 's'} · ${collector.sourceEventsSeen || 0} new events
      ${(collector.errors || []).map((value) => `<p class="mr-warn-text"><b>Error:</b> ${esc(value)}</p>`).join('')}
      ${(collector.drift || []).map((value) => `<p class="mr-advisory-text"><b>Advisory:</b> ${esc(value)}</p>`).join('')}
    </div></details>`;
  }

  function updateFilterCounts() {
    const candidates = state.run?.candidates || [];
    $('mrCandidateFilters').hidden = !candidates.length;
    document.querySelectorAll('[data-filter-count]').forEach((badge) => {
      badge.textContent = badge.dataset.filterCount === 'all' ? candidates.length : candidates.filter((candidate) => candidate.status === badge.dataset.filterCount).length;
    });
  }

  function candidateActions(candidate) {
    if (['proposed', 'deferred'].includes(candidate.status)) return `<div class="mr-candidate-actions">
      <button type="button" class="mr-btn mr-btn-approve" data-action="approve" aria-keyshortcuts="A"><i class="fas fa-check"></i> Approve</button>
      <button type="button" class="mr-btn mr-btn-reject" data-action="reject" aria-keyshortcuts="R"><i class="fas fa-xmark"></i> Reject</button>
      <button type="button" class="mr-btn mr-btn-secondary" data-action="defer" aria-keyshortcuts="D"><i class="fas fa-clock"></i> Defer</button>
      <button type="button" class="mr-btn mr-btn-secondary" data-action="edit_approve" aria-keyshortcuts="E"><i class="fas fa-pen"></i> Edit & approve</button>
    </div>`;
    if (['approved', 'apply_failed'].includes(candidate.status)) {
      const allowed = state.applyEnabled && state.run?.mode === 'apply';
      const title = state.applyEnabled ? 'Authorize this reviewed run before applying' : 'Server is in proposal-only protection';
      return `<div class="mr-candidate-actions"><button type="button" class="mr-btn mr-btn-apply" data-action="apply" ${allowed ? '' : `disabled title="${title}"`}>
        <i class="fas fa-route"></i> ${candidate.status === 'apply_failed' ? 'Retry apply' : 'Apply to owner'}</button></div>`;
    }
    return '';
  }

  function renderCandidates() {
    const all = state.run?.candidates || [];
    const visible = all.map((candidate, index) => ({ candidate, number: index + 1 }))
      .filter(({ candidate }) => state.filter === 'all' || candidate.status === state.filter);
    const message = $('mrCandidatesState');
    if (!all.length) {
      message.hidden = false;
      message.innerHTML = ['collecting', 'synthesizing'].includes(state.run?.status)
        ? '<div class="mr-quiet-state mr-waiting-state"><i class="fas fa-hourglass-half"></i><strong>Waiting for reconciliation</strong><span>No candidate exists yet. Accepted evidence remains inert until collection and bounded review finish.</span></div>'
        : state.run?.summary?.noEligibleObservations
        ? '<div class="mr-quiet-state"><i class="fas fa-moon"></i><strong>Nothing new—and that is healthy.</strong><span>No trustworthy durable observation reached synthesis, so the review model was not called.</span></div>'
        : '<div class="mr-quiet-state"><i class="fas fa-circle-check"></i><strong>No candidate was needed.</strong><span>This run remains part of the audit history.</span></div>';
      $('mrCandidateList').innerHTML = '';
      return;
    }
    if (!visible.length) {
      message.hidden = false;
      message.textContent = `No ${label(state.filter).toLowerCase()} candidates in this run.`;
      $('mrCandidateList').innerHTML = '';
      return;
    }
    message.hidden = true;
    $('mrCandidateList').innerHTML = visible.map(({ candidate, number }) => renderCandidate(candidate, number)).join('');
    $('mrCandidateList').querySelectorAll('.mr-candidate').forEach((item) => {
      item.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => openAction(button.dataset.action, item.dataset.candidateId, button)));
      item.querySelector('[data-clarify]')?.addEventListener('click', () => copyClarification(item.dataset.candidateId));
    });
  }

  function targetPreview(candidate) {
    const target = candidate.target || {};
    const info = targetHelp[target.kind] || targetHelp.ignore;
    const prefix = candidate.apply?.automated ? 'Standing policy destination' : 'Exception destination';
    return `<div class="mr-destination"><i class="fas fa-route"></i><div><span>${prefix}</span><strong>${esc(info[0])}${target.runtime ? ` · ${esc(label(target.runtime))}` : ''}</strong><small>${esc(info[1])} ${esc(info[2])}</small></div></div>`;
  }

  function renderCandidate(candidate, number) {
    const target = candidate.target || {};
    const recurrence = candidate.recurrence || {};
    const risks = [];
    if (candidate.risk?.secret) risks.push('Secret risk');
    if (candidate.risk?.promptInjection) risks.push('Prompt injection');
    ['privacy', 'governance', 'staleness'].forEach((key) => {
      if (candidate.risk?.[key] && candidate.risk[key] !== 'none') risks.push(`${label(key)}: ${candidate.risk[key]}`);
    });
    const confidence = Math.round(Math.max(0, Math.min(1, Number(candidate.confidence) || 0)) * 100);
    const consensus = recurrence.independentRuntimes > 1
      ? `<span class="mr-chip mr-consensus"><i class="fas fa-people-arrows"></i> ${recurrence.independentRuntimes}-agent consensus</span>` : '';
    return `<li tabindex="-1" class="mr-candidate mr-candidate-${esc(candidate.status)}" data-candidate-id="${esc(candidate.candidateId)}">
      <span class="mr-candidate-number">${number}</span>
      <div class="mr-candidate-head"><span class="mr-chip">${esc(label(candidate.type))}</span><span class="mr-chip"><i class="fas fa-arrow-right"></i> ${esc(label(target.kind))}${target.runtime ? ` · ${esc(label(target.runtime))}` : ''}</span>
        <span class="mr-chip mr-status-${esc(candidate.status)}">${esc(label(candidate.status))}</span><span class="mr-chip">${esc(label(candidate.scope || 'project'))} · ${esc(label(candidate.sensitivity || 'normal'))}</span>${consensus}${risks.map((risk) => `<span class="mr-chip mr-warn">${esc(risk)}</span>`).join('')}</div>
      <p class="mr-statement">${esc(candidate.statement)}</p>
      ${candidate.review?.editedStatement ? `<p class="mr-edited"><i class="fas fa-pen"></i> Approved wording: ${esc(candidate.review.editedStatement)}</p>` : ''}
      ${candidate.rationale ? `<p class="mr-rationale">${esc(candidate.rationale)}</p>` : ''}
      ${candidate.automation?.reason ? `<p class="mr-rationale"><b>${esc(label(candidate.automation.disposition))}:</b> ${esc(candidate.automation.reason)}</p>` : ''}
      <div class="mr-signal-grid"><span><b>${(candidate.evidence || []).length}</b> evidence</span><span><b>${recurrence.independentSessions || 0}</b> ${recurrence.independentSessions === 1 ? 'session' : 'sessions'}</span><span><b>${recurrence.independentRuntimes || 0}</b> ${recurrence.independentRuntimes === 1 ? 'runtime' : 'runtimes'}</span>
        <span class="mr-confidence"><span>Confidence <b>${confidence}%</b></span><i><i style="width:${confidence}%"></i></i></span></div>
      ${targetPreview(candidate)}
      ${(candidate.conflicts || []).map((conflict) => `<div class="mr-conflict"><div><i class="fas fa-triangle-exclamation"></i> <b>${esc(label(conflict.authority))} disagrees</b><span>${esc(conflict.summary)}</span></div><button type="button" class="mr-btn mr-btn-secondary" data-clarify><i class="fas fa-comment-dots"></i> Copy clarification question</button></div>`).join('')}
      <details class="mr-evidence"><summary><i class="fas fa-magnifying-glass"></i> Why AgentX trusts this (${(candidate.evidence || []).length})</summary>
        ${(candidate.evidence || []).map((evidence) => `<div class="mr-evidence-item"><span class="mr-chip">${esc(label(evidence.runtime))}</span><span class="mr-chip">${esc(label(evidence.trust))}</span><time>${esc(shortDate(evidence.observedAt))}</time><p>${esc(trustHelp[evidence.trust] || 'This evidence passed the bounded provenance policy.')}</p><blockquote>${esc(evidence.redactedExcerpt || '(No excerpt retained)')}</blockquote></div>`).join('')}</details>
      ${candidate.apply?.attemptedAt ? `<div class="mr-apply-result"><b>Apply result:</b> ${esc(candidate.apply.result || 'Recorded')}${candidate.apply.rollbackRef ? ` · rollback ${esc(candidate.apply.rollbackRef)}` : ''}</div>` : ''}
      ${candidate.review?.by ? `<p class="mr-reviewed">Reviewed by ${esc(candidate.review.by)} · ${esc(shortDate(candidate.review.at))}</p>` : ''}
      ${candidateActions(candidate)}</li>`;
  }

  function copyClarification(candidateId) {
    const candidate = (state.run?.candidates || []).find((item) => item.candidateId === candidateId);
    const conflict = candidate?.conflicts?.[0];
    if (!candidate || !conflict) return;
    copyText(`Dreaming Review needs clarification: should our agents treat “${candidate.statement}” as current, or preserve the existing ${label(conflict.authority).toLowerCase()} evidence described as “${conflict.summary}”?`, 'Clarification question copied.');
  }

  function renderAudit() {
    $('mrAuditList').innerHTML = (state.run?.audit || []).slice().reverse().map((entry) => `<li class="mr-audit-${esc(entry.level)}"><time>${esc(shortDate(entry.at))}</time><strong>${esc(label(entry.event))}</strong><span>by ${esc(entry.by)}</span>${entry.detail ? `<em>${esc(entry.detail)}</em>` : ''}</li>`).join('') || '<li>No audit entries.</li>';
  }

  const actionCopy = {
    approve: ['Approve this candidate?', 'It becomes eligible for a separate apply action. Nothing is written yet.', 'Approve candidate', 'fa-check', 'mr-btn-approve'],
    reject: ['Reject this candidate?', 'The normalized claim stays suppressed until materially new evidence appears.', 'Reject candidate', 'fa-xmark', 'mr-btn-reject'],
    defer: ['Defer this candidate?', 'Keep it pending so future recurrence can strengthen or clarify it.', 'Defer candidate', 'fa-clock', 'mr-btn-secondary'],
    edit_approve: ['Edit and approve', 'Refine the wording while preserving the original proposal and evidence.', 'Save & approve', 'fa-pen', 'mr-btn-approve'],
    apply: ['Apply this approved candidate?', 'AgentX will route this single change through the target owner and record the result.', 'Apply to owner', 'fa-route', 'mr-btn-apply'],
    authorize: ['Authorize reviewed writes for this run?', 'This unlocks individual apply buttons. It does not apply anything by itself.', 'Authorize run', 'fa-key', 'mr-btn-apply'],
  };

  function openAction(action, candidateId, trigger) {
    const copy = actionCopy[action];
    if (!copy) return;
    const candidate = (state.run?.candidates || []).find((item) => item.candidateId === candidateId);
    state.pendingAction = { action, candidateId };
    state.returnFocus = trigger || document.activeElement;
    $('mrActionTitle').textContent = copy[0];
    $('mrActionDescription').textContent = copy[1];
    $('mrActionSubmit').textContent = copy[2];
    $('mrActionSubmit').className = `mr-btn ${copy[4]}`;
    $('mrActionIcon').className = `fas ${copy[3]}`;
    $('mrStatementField').hidden = action !== 'edit_approve';
    $('mrNoteField').hidden = !['approve', 'reject', 'defer', 'edit_approve'].includes(action);
    $('mrActionStatement').value = action === 'edit_approve' ? candidate?.statement || '' : '';
    $('mrActionNote').value = '';
    if (candidate && ['approve', 'edit_approve', 'apply'].includes(action)) {
      $('mrActionPreview').hidden = false;
      $('mrActionPreview').innerHTML = targetPreview(candidate);
    } else {
      $('mrActionPreview').hidden = true;
      $('mrActionPreview').innerHTML = '';
    }
    $('mrActionBackdrop').hidden = false;
    document.body.classList.add('mr-modal-open');
    setTimeout(() => (action === 'edit_approve' ? $('mrActionStatement') : $('mrActionSubmit')).focus(), 0);
  }

  function closeAction() {
    $('mrActionBackdrop').hidden = true;
    document.body.classList.remove('mr-modal-open');
    state.pendingAction = null;
    state.returnFocus?.focus();
  }

  async function submitAction(event) {
    event.preventDefault();
    const pending = state.pendingAction;
    if (!pending) return;
    const body = {};
    let url;
    if (pending.action === 'authorize') {
      url = `/api/memory-review/runs/${encodeURIComponent(state.run.runId)}/authorize-apply`;
    } else if (pending.action === 'apply') {
      url = `/api/memory-review/runs/${encodeURIComponent(state.run.runId)}/candidates/${encodeURIComponent(pending.candidateId)}/apply`;
    } else {
      url = `/api/memory-review/runs/${encodeURIComponent(state.run.runId)}/candidates/${encodeURIComponent(pending.candidateId)}/review`;
      body.action = pending.action;
      const note = $('mrActionNote').value.trim();
      if (note) body.note = note;
      if (pending.action === 'edit_approve') {
        body.editedStatement = $('mrActionStatement').value.trim();
        if (!body.editedStatement) return toast('Approved wording cannot be empty.', 'error');
      }
    }
    const pendingCandidates = (state.run.candidates || []).filter((item) => ['proposed', 'deferred'].includes(item.status));
    const index = pendingCandidates.findIndex((item) => item.candidateId === pending.candidateId);
    state.focusAfter = pendingCandidates[index + 1]?.candidateId || pendingCandidates[index - 1]?.candidateId || null;
    const submit = $('mrActionSubmit');
    submit.disabled = true;
    try {
      await apiJson(url, { method: 'POST', body });
      const actionLabel = pending.action === 'authorize' ? 'Run authorized' : pending.action === 'apply' ? 'Candidate applied' : 'Review saved';
      closeAction(); toast(actionLabel, 'success');
      await Promise.all([loadInsights(), loadRuns({ select: false })]);
      await selectRun(state.selectedRunId);
    } catch (error) {
      state.focusAfter = null;
      toast(`Action failed: ${error.message}`, 'error');
    } finally { submit.disabled = false; }
  }

  function focusedCandidate() {
    const items = [...document.querySelectorAll('.mr-candidate')];
    const active = document.activeElement?.closest?.('.mr-candidate');
    return { items, index: Math.max(0, items.indexOf(active)) };
  }

  document.querySelectorAll('[data-status-filter]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-status-filter]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active'); state.filter = button.dataset.statusFilter; renderCandidates();
  }));
  $('mrRunSearch').addEventListener('input', (event) => { state.runSearch = event.target.value.trim(); renderRuns(); });
  $('mrRunStatus').addEventListener('change', (event) => { state.runFilter = event.target.value; renderRuns(); });
  $('mrRefreshBtn').addEventListener('click', async () => { await Promise.all([loadConfig(), loadInsights(), loadRuns()]); toast('Dreaming Review refreshed.', 'success'); });
  $('mrShareBtn').addEventListener('click', () => copyText(state.insights?.safeDigest || 'Dreaming Review status is unavailable.', 'Statement-free digest copied.'));
  $('mrCopyLink').addEventListener('click', () => copyText(window.location.href, 'Link to this run copied.'));
  $('mrActionForm').addEventListener('submit', submitAction);
  $('mrActionClose').addEventListener('click', closeAction);
  $('mrActionCancel').addEventListener('click', closeAction);
  $('mrActionBackdrop').addEventListener('click', (event) => { if (event.target === $('mrActionBackdrop')) closeAction(); });
  document.addEventListener('keydown', (event) => {
    if (!$('mrActionBackdrop').hidden) {
      if (event.key === 'Escape') return closeAction();
      if (event.key !== 'Tab') return;
      const focusable = [...$('mrActionModal').querySelectorAll('button:not(:disabled), textarea:not([hidden])')]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (/INPUT|TEXTAREA|SELECT|SUMMARY/.test(document.activeElement?.tagName || '') || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const { items, index } = focusedCandidate();
    if (!items.length) return;
    if (key === 'j' || key === 'k') {
      event.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, index + (key === 'j' ? 1 : -1)))].focus();
      return;
    }
    const action = { a: 'approve', r: 'reject', d: 'defer', e: 'edit_approve' }[key];
    if (action) items[index].querySelector(`[data-action="${action}"]`)?.click();
  });

  (async () => { await Promise.all([loadConfig(), loadInsights(), loadRuns()]); })();
})();

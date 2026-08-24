(function () {
  'use strict';

  const root = document.getElementById('agentOpsRoot');
  if (!root) return;

  const state = {
    data: null,
    tab: 'overview',
    query: '',
    preset: null,
    lastFocus: null
  };
  let advanced = null;

  const ragBase = String(root.dataset.ragBase || '').replace(/\/+$/, '');
  const dataBase = String(root.dataset.dataBase || '').replace(/\/+$/, '');
  const hermesBase = String(root.dataset.hermesBase || '').replace(/\/+$/, '');
  const openclawControlDirect = String(root.dataset.openclawControlDirect || '').replace(/\/+$/, '');
  const openclawControlLaunch = String(root.dataset.openclawControlLaunch || '').replace(/\/+$/, '');
  const openclawControlMode = String(root.dataset.openclawControlMode || 'unconfigured');
  const openclawTunnelCommand = String(root.dataset.openclawControlTunnel || '').trim();

  const byId = (id) => document.getElementById(id);
  const asArray = (value) => Array.isArray(value) ? value : [];
  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char]));
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function percent(value, total) {
    const denominator = number(total);
    if (!denominator) return 0;
    return Math.max(0, Math.min(100, Math.round((number(value) / denominator) * 100)));
  }

  function humanize(value) {
    return String(value || 'unknown')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function timeAgo(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    const delta = date.getTime() - Date.now();
    const abs = Math.abs(delta);
    const future = delta > 0;
    if (abs < 60_000) return future ? 'in under a minute' : 'just now';
    const units = [
      ['day', 86_400_000],
      ['hour', 3_600_000],
      ['minute', 60_000]
    ];
    const [label, size] = units.find(([, unit]) => abs >= unit) || units[2];
    const count = Math.max(1, Math.round(abs / size));
    return future ? `in ${count} ${label}${count === 1 ? '' : 's'}` : `${count} ${label}${count === 1 ? '' : 's'} ago`;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  }

  function toneForStatus(value) {
    const status = String(value || '').toLowerCase();
    if (['ok', 'live', 'lead', 'healthy', 'success'].includes(status)) return 'good';
    if (['error', 'failed', 'blocked', 'critical'].includes(status)) return 'bad';
    if (['attention', 'warning', 'warn', 'degraded', 'unobserved', 'paused'].includes(status)) return 'warn';
    if (['observed', 'documented', 'configured', 'registered', 'info'].includes(status)) return 'info';
    return 'muted';
  }

  function iconForStatus(value) {
    const tone = toneForStatus(value);
    if (tone === 'good') return 'fa-circle-check';
    if (tone === 'bad') return 'fa-circle-xmark';
    if (tone === 'warn') return 'fa-triangle-exclamation';
    if (tone === 'info') return 'fa-circle-info';
    return 'fa-circle';
  }

  function badge(label, status, icon) {
    return `<span class="agent-ops-badge ${toneForStatus(status)}"><i class="fas ${icon || iconForStatus(status)}"></i>${esc(label)}</span>`;
  }

  function empty(message, icon = 'fa-inbox') {
    return `<div class="agent-ops-empty"><i class="fas ${icon}"></i>${esc(message)}</div>`;
  }

  function clipText(value, max = 260) {
    const text = String(value || '').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function normalizedNativePath(value) {
    const path = String(value || '/overview').trim();
    return /^\/[a-z0-9/_?=&.%-]*$/i.test(path) ? path : '/overview';
  }

  function openclawControlUrl(path = '/overview') {
    const base = openclawControlLaunch || openclawControlDirect;
    return base ? `${base}${normalizedNativePath(path)}` : '/nerve-center';
  }

  function nativeControlAttributes(path) {
    const safePath = normalizedNativePath(path);
    return `href="${esc(openclawControlUrl(safePath))}" data-openclaw-native="${esc(safePath)}" target="_blank" rel="noopener"`;
  }

  function surfaceLink(sourceId) {
    const links = {
      runtime: '/nerve-center',
      hostPreferences: '/nerve-center',
      hostCapacity: '/nerve-center',
      fastlane: '/nerve-center',
      prompts: '/nerve-center',
      alerts: '/alerts',
      pipeline: '/pipeline',
      schedules: '/cluster-schedule',
      openclaw: openclawControlUrl('/overview'),
      rag: ragBase || '/nerve-center',
      hermes: hermesBase || '/nerve-center',
      data: dataBase || '/data-toolbox'
    };
    return links[sourceId] || '/nerve-center';
  }

  function sourceIcon(sourceId) {
    const icons = {
      runtime: 'fa-diagram-project',
      hostPreferences: 'fa-sliders',
      hostCapacity: 'fa-microchip',
      openclaw: 'fa-satellite-dish',
      fastlane: 'fa-bolt',
      prompts: 'fa-message',
      pipeline: 'fa-list-check',
      schedules: 'fa-calendar-days',
      alerts: 'fa-triangle-exclamation',
      rag: 'fa-book-open',
      hermes: 'fa-brain'
    };
    return icons[sourceId] || 'fa-circle-nodes';
  }

  function sourceName(sourceId) {
    const names = {
      rag: 'RAG',
      openclaw: 'OpenClaw'
    };
    return names[sourceId] || humanize(sourceId);
  }

  const PRESET_LABELS = {
    'observed-agents': 'Observed now',
    'unobserved-agents': 'Runtime gaps',
    'documented-automations': 'Documentation only',
    'automation-errors': 'Runtime errors',
    'work:queued': 'Queued',
    'work:in_progress': 'In progress',
    'work:review': 'In review',
    'work:blocked': 'Blocked'
  };

  function matchesPreset(item, kind) {
    if (!state.preset) return true;
    if (kind === 'agent' && state.preset === 'observed-agents') {
      return ['lead', 'live', 'observed'].includes(item.status);
    }
    if (kind === 'agent' && state.preset === 'unobserved-agents') return item.status === 'unobserved';
    if (kind === 'automation' && state.preset === 'documented-automations') return item.confidence === 'documented';
    if (kind === 'automation' && state.preset === 'automation-errors') return item.health === 'error';
    if (kind === 'work' && state.preset.startsWith('work:')) return item.status === state.preset.slice(5);
    return true;
  }

  function updatePresetControl() {
    const clear = byId('agentOpsClearFilter');
    if (!clear) return;
    const label = PRESET_LABELS[state.preset];
    clear.hidden = !label && !state.query;
    const text = clear.querySelector('span');
    if (text) text.textContent = label ? `Clear · ${label}` : state.query ? 'Clear search' : 'Clear view';
  }

  function openPreset(tab, preset) {
    state.preset = String(preset || '').startsWith('all-') ? null : preset;
    activateTab(tab, true, false);
  }

  function spotlight(elementId) {
    const target = byId(elementId);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('agent-ops-spotlight');
    window.requestAnimationFrame(() => target.classList.add('agent-ops-spotlight'));
    window.setTimeout(() => target.classList.remove('agent-ops-spotlight'), 1600);
  }

  function setLoading(loading) {
    const button = byId('agentOpsRefresh');
    if (!button) return;
    button.disabled = loading;
    const icon = button.querySelector('i');
    if (icon) icon.classList.toggle('fa-spin', loading);
  }

  function setStatus(tone, title, detail, generatedAt) {
    const banner = byId('agentOpsState');
    const icon = byId('agentOpsStateIcon');
    banner.dataset.tone = tone;
    icon.className = `fas ${tone === 'loading' ? 'fa-spinner fa-spin' : iconForStatus(tone)}`;
    byId('agentOpsStateTitle').textContent = title;
    byId('agentOpsStateDetail').textContent = detail;
    byId('agentOpsUpdated').textContent = generatedAt ? `Updated ${timeAgo(generatedAt)}` : '';
    byId('agentOpsUpdated').dateTime = generatedAt || '';
  }

  function renderMetrics(data) {
    const summary = asObject(data.summary);
    const coverage = asObject(data.coverage);
    const agentCoverage = asObject(coverage.agents);
    const automationCoverage = asObject(coverage.automations);
    const attention = asArray(data.warnings).length;

    byId('agentOpsMetricAgents').textContent = number(summary.registeredAgents);
    byId('agentOpsMetricAgentsDetail').textContent = `${number(summary.activeAgents)} active roles · ${number(summary.runtimeAgents)} runtime`;
    byId('agentOpsMetricObserved').textContent = number(summary.observedAgents);
    byId('agentOpsMetricObservedDetail').textContent = agentCoverage.runtimeUnobserved
      ? `${agentCoverage.runtimeUnobserved} runtime gap${agentCoverage.runtimeUnobserved === 1 ? '' : 's'}`
      : 'Registry and runtime aligned';
    byId('agentOpsMetricAutomations').textContent = number(summary.automations);
    byId('agentOpsMetricAutomationsDetail').textContent = `${number(summary.observedAutomations)} observed · ${number(automationCoverage.documentedOnly)} docs only`;
    byId('agentOpsMetricWork').textContent = number(summary.openWork);
    byId('agentOpsMetricWorkDetail').textContent = `${number(summary.blockedWork)} blocked`;
    byId('agentOpsMetricAttention').textContent = attention;
    byId('agentOpsMetricAttentionDetail').textContent = attention ? 'Visibility or runtime attention' : 'No known gaps';

    byId('agentOpsTabAgentCount').textContent = asArray(data.agents).length;
    byId('agentOpsTabAutomationCount').textContent = asArray(data.automations).length;
    byId('agentOpsTabWorkCount').textContent = number(summary.openWork);
  }

  function renderRuntimeLayers(data) {
    const items = asArray(data.runtimeLayers);
    byId('agentOpsRuntimeLayers').innerHTML = items.length ? items.map((runtime) => {
      const agentCount = asArray(data.agents).filter((agent) => agent.runtime === runtime.id).length;
      return `
      <button class="agent-ops-runtime" type="button" data-runtime-inspect="${esc(runtime.id)}">
        <div class="agent-ops-runtime-icon"><i class="fas ${runtime.id === 'hermes' ? 'fa-brain' : 'fa-satellite-dish'}"></i></div>
        <div>
          <strong>${esc(runtime.name)}</strong>
          <small>${esc(runtime.host || 'host not declared')} · ${esc(humanize(runtime.type))}</small>
          <small>${agentCount} registered agent${agentCount === 1 ? '' : 's'}${runtime.model ? ` · ${esc(runtime.model)}` : ''}</small>
        </div>
        <span class="agent-ops-runtime-end">${badge(humanize(runtime.status), runtime.status)}<i class="fas fa-arrow-right"></i></span>
      </button>`;
    }).join('') : empty('No runtime layers registered.', 'fa-circle-nodes');
  }

  function renderWarnings(data) {
    const warnings = asArray(data.warnings);
    byId('agentOpsWarnings').innerHTML = warnings.length ? warnings.slice(0, 4).map((warning) => {
      const tone = warning.severity === 'warning' ? 'warn' : warning.severity === 'critical' || warning.severity === 'error' ? 'bad' : 'info';
      return `
        <button class="agent-ops-stack-item ${tone}" type="button" data-inbox-warning="${esc(warning.id)}">
          <i class="fas ${tone === 'bad' ? 'fa-circle-xmark' : tone === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i>
          <div><strong>${esc(warning.title)}</strong><small>${esc(warning.detail)}</small></div>
          <i class="fas fa-arrow-right agent-ops-stack-arrow"></i>
        </button>`;
    }).join('') : `
      <article class="agent-ops-stack-item good">
        <i class="fas fa-circle-check"></i>
        <div><strong>No known coverage gaps</strong><small>All projected sources are aligned.</small></div>
      </article>`;
  }

  function renderNextRuns(data) {
    const items = asArray(data.automations)
      .slice()
      .sort((a, b) => {
        const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime || a.name.localeCompare(b.name);
      })
      .slice(0, 5);

    byId('agentOpsNextRuns').innerHTML = items.length ? items.map((item) => `
      <button class="agent-ops-stack-item ${toneForStatus(item.health)}" type="button" data-automation-inspect="${esc(item.id)}">
        <i class="fas ${item.nextRunAt ? 'fa-forward-step' : 'fa-repeat'}"></i>
        <div>
          <strong>${esc(item.name)}</strong>
          <small>${item.nextRunAt ? `${esc(timeAgo(item.nextRunAt))} · ${esc(formatDate(item.nextRunAt))}` : esc(item.cadence)}</small>
          <em>${esc(item.ownerId || item.owner || 'Unassigned')} · ${esc(humanize(item.health))}</em>
        </div>
        <i class="fas fa-chevron-right agent-ops-stack-arrow"></i>
      </button>
    `).join('') : empty('No recurring work found.', 'fa-clock');
  }

  function renderCoverage(data) {
    const agents = asObject(data.coverage?.agents);
    const automations = asObject(data.coverage?.automations);
    const sources = Object.values(asObject(data.sources));
    const healthySources = sources.filter((source) => source?.status === 'ok').length;
    byId('agentOpsCoverage').innerHTML = `
      <button class="agent-ops-coverage-card" type="button" data-coverage-target="observed-agents">
        <strong>${number(agents.observed)} / ${number(agents.registered)}</strong>
        <span>Agents evidenced</span>
        <div class="agent-ops-coverage-meter"><i style="width:${percent(agents.observed, agents.registered)}%"></i></div>
        <p>Configured roles stay visible even when runtime inventory is unavailable.</p>
        <small>Inspect evidenced agents <i class="fas fa-arrow-right"></i></small>
      </button>
      <button class="agent-ops-coverage-card" type="button" data-coverage-target="documented-automations">
        <strong>${number(automations.observed)} / ${number(automations.documented)}</strong>
        <span>Observed vs documented schedules</span>
        <div class="agent-ops-coverage-meter violet"><i style="width:${percent(automations.observed, automations.documented)}%"></i></div>
        <p>${number(automations.documentedOnly)} documented only · ${number(automations.observedOnly)} observed without a receipt.</p>
        <small>Inspect documentation gaps <i class="fas fa-arrow-right"></i></small>
      </button>
      <button class="agent-ops-coverage-card" type="button" data-coverage-target="sources">
        <strong>${healthySources} / ${sources.length}</strong>
        <span>Healthy live sources</span>
        <div class="agent-ops-coverage-meter green"><i style="width:${percent(healthySources, sources.length)}%"></i></div>
        <p>Degraded sources remain visible instead of disappearing from the page.</p>
        <small>Inspect source telemetry <i class="fas fa-arrow-down"></i></small>
      </button>`;
  }

  function renderSources(data) {
    const sources = Object.entries(asObject(data.sources));
    byId('agentOpsSources').innerHTML = sources.length ? sources.map(([id, source]) => {
      const status = source?.status || 'unknown';
      const issues = asArray(source?.issues).length;
      const duration = Number(source?.durationMs);
      const durationLabel = Number.isFinite(duration)
        ? (duration <= 0 ? '<1 ms' : `${Math.round(duration).toLocaleString()} ms`)
        : 'Projection source';
      return `
        <a class="agent-ops-source ${toneForStatus(status)}" href="${esc(surfaceLink(id))}"${id === 'openclaw' ? ' data-openclaw-native="/overview" target="_blank" rel="noopener"' : ''}>
          <span class="agent-ops-source-icon"><i class="fas ${sourceIcon(id)}"></i></span>
          <span class="agent-ops-source-copy">
            <strong>${esc(sourceName(id))}</strong>
            <small>${durationLabel}${issues ? ` · ${issues} issue${issues === 1 ? '' : 's'}` : ' · readable'}</small>
          </span>
          <span class="agent-ops-source-state"><i class="fas ${iconForStatus(status)}"></i>${esc(humanize(status))}</span>
        </a>`;
    }).join('') : empty('No source telemetry available.', 'fa-tower-broadcast');
  }

  function renderRoster(data) {
    const rank = { lead: 0, live: 1, observed: 2, unobserved: 3, registered: 4, superseded: 5 };
    const agents = asArray(data.agents)
      .filter((agent) => agent.status !== 'superseded')
      .slice()
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.automationCount - a.automationCount)
      .slice(0, 6);
    byId('agentOpsRoster').innerHTML = agents.length ? agents.map((agent) => `
      <button class="agent-ops-roster-card" type="button" data-agent-inspect="${esc(agent.registryId)}">
        <span class="agent-ops-roster-avatar"><i class="fas ${agentIcon(agent)}"></i></span>
        <span class="agent-ops-roster-copy">
          <span class="agent-ops-roster-title"><strong>${esc(agent.name)}</strong>${badge(humanize(agent.status), agent.status)}</span>
          <code>${esc(agent.id)}</code>
          <small>${esc(agent.responsibility)}</small>
        </span>
        <span class="agent-ops-roster-signal">
          <strong>${number(agent.automationCount) + number(agent.workCount)}</strong>
          <small>owned signals</small>
          <i class="fas fa-arrow-right"></i>
        </span>
      </button>
    `).join('') : empty('No active agent roles registered.', 'fa-users');
  }

  function agentIcon(agent) {
    if (agent.isLead) return 'fa-crown';
    if (agent.runtime === 'openclaw') return 'fa-robot';
    if (agent.type === 'coding_agent') return 'fa-code';
    if (agent.type === 'operations_role') return 'fa-terminal';
    if (agent.type === 'pipeline_manager') return 'fa-shield-halved';
    return 'fa-user-gear';
  }

  function agentRuntimeLink(agent) {
    return agent.runtime === 'openclaw' ? openclawControlUrl('/agents') : '';
  }

  function matchesQuery(item, fields) {
    if (!state.query) return true;
    const haystack = fields.map((field) => item?.[field]).flat().filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(state.query);
  }

  function renderAgents(data) {
    const all = asArray(data.agents);
    const agents = all.filter((agent) => matchesPreset(agent, 'agent') && matchesQuery(agent, [
      'id', 'registryId', 'name', 'type', 'runtime', 'responsibility', 'status', 'acceptanceGate', 'owns', 'observedFrom'
    ]));
    byId('agentOpsFilterResult').textContent = `${agents.length} of ${all.length} agents${PRESET_LABELS[state.preset] ? ` · ${PRESET_LABELS[state.preset]}` : ''}`;
    updatePresetControl();
    byId('agentOpsAgents').innerHTML = agents.length ? agents.map((agent) => `
      <article class="agent-ops-agent-card">
        <header class="agent-ops-agent-top">
          <div class="agent-ops-agent-avatar"><i class="fas ${agentIcon(agent)}"></i></div>
          <div>
            <h3>${esc(agent.name)}</h3>
            <div class="agent-ops-agent-id">${esc(agent.id)}</div>
          </div>
          ${badge(humanize(agent.status), agent.status)}
        </header>
        <div class="agent-ops-agent-body">
          <p>${esc(agent.responsibility)}</p>
          <div class="agent-ops-meta-row">
            <span class="agent-ops-chip"><i class="fas fa-tag"></i>${esc(humanize(agent.type))}</span>
            ${agent.runtime ? `<span class="agent-ops-chip"><i class="fas fa-microchip"></i>${esc(agent.runtime)}</span>` : ''}
            ${agent.acceptanceGate ? `<span class="agent-ops-chip"><i class="fas fa-check-double"></i>${esc(humanize(agent.acceptanceGate))}</span>` : ''}
            ${agent.confidence ? `<span class="agent-ops-chip"><i class="fas fa-signal"></i>${esc(agent.confidence)}</span>` : ''}
          </div>
          <div class="agent-ops-model">
            <span>Primary model · ${esc(agent.model?.source || 'not declared')}</span>
            <code title="${esc(agent.model?.primary || 'No model declared')}">${esc(agent.model?.primary || 'No model declared')}</code>
          </div>
          <div class="agent-ops-agent-stats">
            <span><i class="fas fa-clock"></i>${number(agent.automationCount)} recurring</span>
            <span><i class="fas fa-list-check"></i>${number(agent.workCount)} work</span>
            ${agent.blockedWorkCount ? `<span><i class="fas fa-ban"></i>${number(agent.blockedWorkCount)} blocked</span>` : ''}
          </div>
          <div class="agent-ops-agent-actions">
            <button type="button" data-agent-inspect="${esc(agent.registryId)}"><i class="fas fa-id-card"></i>Inspect dossier</button>
            ${agentRuntimeLink(agent) ? `<a ${nativeControlAttributes('/agents')}><i class="fas fa-arrow-up-right"></i>Open native agent UI</a>` : ''}
          </div>
        </div>
      </article>
    `).join('') : empty('No agents match this filter.', 'fa-users-slash');
  }

  function renderAutomations(data) {
    const all = asArray(data.automations);
    const automations = all.filter((item) => matchesPreset(item, 'automation') && matchesQuery(item, [
      'name', 'ownerId', 'owner', 'cadence', 'health', 'confidence', 'purpose', 'trigger', 'source', 'lastStatus'
    ]));
    byId('agentOpsFilterResult').textContent = `${automations.length} of ${all.length} recurring items${PRESET_LABELS[state.preset] ? ` · ${PRESET_LABELS[state.preset]}` : ''}`;
    updatePresetControl();
    byId('agentOpsAutomations').innerHTML = automations.length ? automations.map((item) => `
      <article class="agent-ops-automation-row">
        <div class="agent-ops-automation-name">
          <strong>${esc(item.name)}</strong>
          <p>${esc(item.purpose || item.trigger || 'No purpose documented.')}</p>
        </div>
        <div class="agent-ops-automation-cell">
          <span>Owner</span>
          <strong>${esc(item.ownerId || item.owner || 'Unassigned')}</strong>
        </div>
        <div class="agent-ops-automation-cell">
          <span>Cadence</span>
          <code title="${esc(item.cadence)}">${esc(item.cadence)}</code>
        </div>
        <div class="agent-ops-automation-cell">
          <span>${item.nextRunAt ? 'Next run' : item.lastRun ? 'Last run' : 'Evidence'}</span>
          <strong title="${esc(item.nextRunAt || item.lastRun || item.source)}">${item.nextRunAt ? esc(timeAgo(item.nextRunAt)) : item.lastRun ? esc(timeAgo(item.lastRun)) : esc(humanize(item.confidence))}</strong>
        </div>
        <div class="agent-ops-row-end">
          <span class="agent-ops-row-badges">
            ${badge(humanize(item.health), item.health)}
            ${badge(humanize(item.confidence), item.confidence, 'fa-signal')}
          </span>
          <button type="button" data-automation-inspect="${esc(item.id)}"><i class="fas fa-circle-info"></i>Inspect</button>
          <a ${item.confidence === 'live' ? nativeControlAttributes('/cron') : 'href="/cluster-schedule"'}>
            ${item.confidence === 'live' ? 'Open live cron' : 'Open schedule'} <i class="fas fa-arrow-right"></i>
          </a>
        </div>
      </article>
    `).join('') : empty('No recurring items match this filter.', 'fa-calendar-xmark');
  }

  function renderWork(data) {
    const work = asObject(data.work);
    const counts = asObject(work.counts);
    const statuses = ['queued', 'in_progress', 'review', 'blocked', 'done'];
    byId('agentOpsWorkCounts').innerHTML = statuses.map((status) => status === 'done' ? `
      <article class="agent-ops-work-count static" title="Completed work is summarized here; open Pipeline for full history.">
        <span>${esc(humanize(status))}</span>
        <strong>${number(counts[status])}</strong>
        <small>History in Pipeline</small>
      </article>` : `
      <button class="agent-ops-work-count ${state.preset === `work:${status}` ? 'active' : ''}" type="button" data-work-status="${esc(status)}">
        <span>${esc(humanize(status))}</span>
        <strong>${number(counts[status])}</strong>
        <small>Filter work <i class="fas fa-arrow-down"></i></small>
      </button>
    `).join('');

    const all = asArray(work.active);
    const tasks = all.filter((task) => matchesPreset(task, 'work') && matchesQuery(task, [
      'pipelineId', 'title', 'service', 'status', 'assignee', 'epic'
    ]));
    byId('agentOpsFilterResult').textContent = `${tasks.length} of ${all.length} projected active tasks${PRESET_LABELS[state.preset] ? ` · ${PRESET_LABELS[state.preset]}` : ''}`;
    updatePresetControl();
    byId('agentOpsWork').innerHTML = tasks.length ? tasks.map((task) => `
      <article class="agent-ops-work-row">
        <div class="agent-ops-work-id">#${esc(task.pipelineId)}</div>
        <div class="agent-ops-work-title">
          <strong title="${esc(task.title)}">${esc(task.title)}</strong>
          <p>${esc(task.epic || task.service || 'No workstream')}</p>
        </div>
        <div>${badge(humanize(task.status), task.status)}</div>
        <div class="agent-ops-automation-cell"><span>Owner</span><strong>${esc(task.assignee || 'Unassigned')}</strong></div>
        <div class="agent-ops-automation-cell agent-ops-work-action"><span>Updated</span><strong>${esc(task.updatedAt ? timeAgo(task.updatedAt) : '—')}</strong><a href="/pipeline"><i class="fas fa-arrow-up-right"></i>Open Pipeline</a></div>
      </article>
    `).join('') : empty('No active work matches this filter.', 'fa-clipboard-check');
  }

  function agentKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  function compactSignalList(items, emptyLabel, renderItem) {
    if (!items.length) return `<div class="agent-ops-drawer-empty">${esc(emptyLabel)}</div>`;
    return items.slice(0, 5).map(renderItem).join('');
  }

  function showDrawer({ eyebrow, title, id, icon, body, trigger }) {
    const shell = byId('agentOpsDrawerShell');
    byId('agentOpsDrawerEyebrow').textContent = eyebrow;
    byId('agentOpsDrawerTitle').textContent = title;
    byId('agentOpsDrawerId').textContent = id;
    byId('agentOpsDrawerAvatar').innerHTML = `<i class="fas ${icon}"></i>`;
    byId('agentOpsDrawerBody').innerHTML = body;
    if (shell.hidden) state.lastFocus = trigger || document.activeElement;
    shell.hidden = false;
    document.body.classList.add('agent-ops-drawer-open');
    const closeButton = root.querySelector('.agent-ops-drawer-close');
    if (closeButton) closeButton.focus();
  }

  function openOpenClawHandoff(path, trigger) {
    const safePath = normalizedNativePath(path);
    const handoff = asObject(state.data?.handoffs?.openclaw);
    const capability = asArray(handoff.capabilities).find((item) => item.path === safePath);
    const command = handoff.tunnelCommand || openclawTunnelCommand;
    const destination = openclawControlUrl(safePath);
    const body = `
      <section class="agent-ops-drawer-lead">
        <div>${badge('Official authority', 'live', 'fa-shield-halved')}${badge('Secure context', 'warning', 'fa-lock')}</div>
        <p>This deployment is explicitly configured to open the official Control UI through a localhost SSH tunnel.</p>
      </section>
      <section class="agent-ops-drawer-facts">
        <article><span>Destination</span><strong>${esc(capability?.label || humanize(safePath.slice(1) || 'overview'))}</strong></article>
        <article><span>Authority</span><strong>OpenClaw Control UI</strong></article>
        <article><span>Launch mode</span><strong>SSH localhost tunnel</strong></article>
        <article><span>Gateway</span><strong>${esc(openclawControlDirect || 'Configured runtime')}</strong></article>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>1 · Start the configured handoff</span><small>Run this on the workstation</small></div>
        <div class="agent-ops-tunnel-command">
          <code>${esc(command || 'Tunnel command is not configured.')}</code>
          ${command ? '<button class="agent-ops-button compact" type="button" data-copy-openclaw-tunnel><i class="fas fa-copy"></i><span>Copy tunnel command</span></button>' : ''}
        </div>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>2 · Open the native surface</span><small>The tunnel must remain running</small></div>
        <p class="agent-ops-drawer-note">Agent Ops routes native runtime work to the official OpenClaw Control UI.</p>
      </section>
      <footer class="agent-ops-drawer-actions">
        <a class="agent-ops-button primary" href="${esc(destination)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right"></i>Open ${esc(capability?.label || 'Control UI')}</a>
        <a class="agent-ops-button" href="/nerve-center"><i class="fas fa-wave-square"></i>AgentX runtime evidence</a>
      </footer>`;

    showDrawer({
      eyebrow: 'Secure runtime handoff',
      title: 'OpenClaw Control 7.1',
      id: safePath,
      icon: 'fa-satellite-dish',
      body,
      trigger
    });
  }

  async function copyOpenClawTunnel(button) {
    const handoff = asObject(state.data?.handoffs?.openclaw);
    const command = handoff.tunnelCommand || openclawTunnelCommand;
    if (!command) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(command);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = command;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('copy unavailable');
        textarea.remove();
      }
      button.innerHTML = '<i class="fas fa-check"></i><span>Copied</span>';
    } catch {
      button.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>Copy failed</span>';
    }
  }

  function openAgentDrawer(registryId, trigger) {
    if (!state.data) return;
    const agent = asArray(state.data.agents).find((item) => item.registryId === registryId || item.id === registryId);
    if (!agent) return;

    const key = agentKey(agent.registryId || agent.id);
    const automations = asArray(state.data.automations).filter((item) => agentKey(item.ownerId) === key);
    const work = asArray(state.data.work?.active).filter((item) => agentKey(item.assignee) === key);
    const runtimeLink = agentRuntimeLink(agent);
    const fallbacks = asArray(agent.model?.fallbacks);
    const owns = asArray(agent.owns);
    const docs = asArray(agent.roleDocs);

    const body = `
      <section class="agent-ops-drawer-lead">
        <div>${badge(humanize(agent.status), agent.status)}${badge(humanize(agent.confidence), agent.confidence, 'fa-signal')}</div>
        <p>${esc(agent.responsibility)}</p>
      </section>
      <section class="agent-ops-drawer-facts">
        <article><span>Role type</span><strong>${esc(humanize(agent.type))}</strong></article>
        <article><span>Runtime</span><strong>${esc(agent.runtime || 'Registry only')}</strong></article>
        <article><span>Acceptance gate</span><strong>${esc(humanize(agent.acceptanceGate || 'independent tests plus review'))}</strong></article>
        <article><span>Owned signals</span><strong>${number(agent.automationCount) + number(agent.workCount)}</strong></article>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>Model chain</span><small>${esc(agent.model?.source || 'No declared source')}</small></div>
        <div class="agent-ops-model-chain">
          <article class="primary"><span>Primary</span><code>${esc(agent.model?.primary || 'No model declared')}</code></article>
          ${fallbacks.map((model, index) => `<article><span>Fallback ${index + 1}</span><code>${esc(model)}</code></article>`).join('')}
        </div>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>Scope &amp; role references</span><small>${owns.length || docs.length} declared references</small></div>
        <div class="agent-ops-drawer-chips">
          ${(owns.length ? owns : docs).map((item) => `<span><i class="fas fa-check"></i>${esc(item)}</span>`).join('') || '<span><i class="fas fa-circle-info"></i>No explicit scope list</span>'}
        </div>
      </section>
      <section class="agent-ops-drawer-columns">
        <div class="agent-ops-drawer-section">
          <div class="agent-ops-drawer-label"><span>Recurring work</span><small>${automations.length} owned</small></div>
          <div class="agent-ops-drawer-list">
            ${compactSignalList(automations, 'No recurring work attributed.', (item) => `
              <article><i class="fas fa-clock"></i><span><strong>${esc(item.name)}</strong><small>${esc(item.cadence)}</small></span>${badge(humanize(item.health), item.health)}</article>`)}
          </div>
        </div>
        <div class="agent-ops-drawer-section">
          <div class="agent-ops-drawer-label"><span>Active delivery</span><small>${work.length} owned</small></div>
          <div class="agent-ops-drawer-list">
            ${compactSignalList(work, 'No active pipeline work attributed.', (item) => `
              <article><i class="fas fa-list-check"></i><span><strong>#${esc(item.pipelineId)} · ${esc(item.title)}</strong><small>${esc(item.service || item.epic || 'Pipeline')}</small></span>${badge(humanize(item.status), item.status)}</article>`)}
          </div>
        </div>
      </section>
      <footer class="agent-ops-drawer-actions">
        ${runtimeLink ? `<a class="agent-ops-button primary" ${nativeControlAttributes('/agents')}><i class="fas fa-arrow-up-right"></i>Open native agent UI</a>` : ''}
        <a class="agent-ops-button" href="/cluster-schedule"><i class="fas fa-calendar-days"></i>Open schedule</a>
        <a class="agent-ops-button" href="/pipeline"><i class="fas fa-list-check"></i>Open pipeline</a>
        <a class="agent-ops-button" href="/nerve-center"><i class="fas fa-brain"></i>Trace evidence</a>
      </footer>`;

    showDrawer({
      eyebrow: 'Agent dossier',
      title: agent.name,
      id: agent.id,
      icon: agentIcon(agent),
      body,
      trigger
    });
  }

  function openRuntimeDrawer(runtimeId, trigger) {
    if (!state.data) return;
    const runtime = asArray(state.data.runtimeLayers).find((item) => item.id === runtimeId);
    if (!runtime) return;
    const agents = asArray(state.data.agents).filter((agent) => agent.runtime === runtime.id);
    const source = asObject(state.data.sources?.[runtime.id]);
    const duration = Number(source.durationMs);
    const runtimeLink = runtime.id === 'openclaw'
      ? openclawControlUrl('/overview')
      : runtime.id === 'hermes' && hermesBase ? hermesBase : '/nerve-center';
    const body = `
      <section class="agent-ops-drawer-lead">
        <div>${badge(humanize(runtime.status), runtime.status)}${badge(humanize(source.status || 'configured'), source.status || 'configured', 'fa-signal')}</div>
        <p>${esc(runtime.boundary || 'Registered AgentX runtime layer.')}</p>
      </section>
      <section class="agent-ops-drawer-facts">
        <article><span>Host</span><strong title="${esc(runtime.host || 'Not declared')}">${esc(runtime.host || 'Not declared')}</strong></article>
        <article><span>Runtime type</span><strong title="${esc(humanize(runtime.type))}">${esc(humanize(runtime.type))}</strong></article>
        <article><span>Registered agents</span><strong>${agents.length}</strong></article>
        <article><span>Source probe</span><strong>${Number.isFinite(duration) && duration > 0 ? `${Math.round(duration).toLocaleString()} ms` : 'Live projection'}</strong></article>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>Runtime model</span><small>${esc(runtime.status)}</small></div>
        <div class="agent-ops-model-chain">
          <article class="primary"><span>Primary</span><code>${esc(runtime.model || 'Resolved per agent')}</code></article>
        </div>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>Registered identities</span><small>${agents.length} mapped</small></div>
        <div class="agent-ops-drawer-agent-links">
          ${agents.length ? agents.map((agent) => `
            <button type="button" data-agent-inspect="${esc(agent.registryId)}">
              <span class="agent-ops-drawer-agent-icon"><i class="fas ${agentIcon(agent)}"></i></span>
              <span><strong>${esc(agent.name)}</strong><small>${esc(agent.model?.primary || agent.responsibility)}</small></span>
              ${badge(humanize(agent.status), agent.status)}
            </button>`).join('') : '<div class="agent-ops-drawer-empty">No agent identities are directly mapped to this runtime.</div>'}
        </div>
      </section>
      ${asArray(source.issues).length ? `
        <section class="agent-ops-drawer-section warning">
          <div class="agent-ops-drawer-label"><span>Current source issues</span><small>${source.issues.length} reported</small></div>
          <p class="agent-ops-drawer-note">${esc(clipText(source.issues[0]))}</p>
        </section>` : ''}
      <footer class="agent-ops-drawer-actions">
        <a class="agent-ops-button primary" ${runtime.id === 'openclaw' ? nativeControlAttributes('/overview') : `href="${esc(runtimeLink)}"`}><i class="fas fa-arrow-up-right"></i>${runtime.id === 'openclaw' ? 'Open official Control UI' : 'Open runtime'}</a>
        <a class="agent-ops-button" href="/nerve-center"><i class="fas fa-brain"></i>Trace topology</a>
        <a class="agent-ops-button" href="/cluster-schedule"><i class="fas fa-calendar-days"></i>Open schedule</a>
      </footer>`;

    showDrawer({
      eyebrow: 'Runtime dossier',
      title: runtime.name,
      id: runtime.host || runtime.id,
      icon: runtime.id === 'hermes' ? 'fa-brain' : 'fa-satellite-dish',
      body,
      trigger
    });
  }

  function openAutomationDrawer(automationId, trigger) {
    if (!state.data) return;
    const item = asArray(state.data.automations).find((automation) => automation.id === automationId);
    if (!item) return;
    const owner = asArray(state.data.agents).find((agent) => agentKey(agent.registryId || agent.id) === agentKey(item.ownerId));
    const liveLink = item.confidence === 'live' ? openclawControlUrl('/cron') : '/cluster-schedule';
    const recentHistory = asArray(item.history);
    const body = `
      <section class="agent-ops-drawer-lead">
        <div>${badge(humanize(item.health), item.health)}${badge(humanize(item.confidence), item.confidence, 'fa-signal')}</div>
        <p>${esc(item.purpose || item.trigger || 'Recurring work projected without a documented purpose.')}</p>
      </section>
      <section class="agent-ops-drawer-facts">
        <article><span>Cadence</span><strong title="${esc(item.cadence)}">${esc(item.cadence)}</strong></article>
        <article><span>Owner</span><strong>${esc(item.ownerId || item.owner || 'Unassigned')}</strong></article>
        <article><span>Enabled</span><strong>${item.enabled ? 'Yes' : 'No'}</strong></article>
        <article><span>Errors</span><strong>${number(item.consecutiveErrors)}</strong></article>
      </section>
      <section class="agent-ops-drawer-columns">
        <div class="agent-ops-drawer-section">
          <div class="agent-ops-drawer-label"><span>Next execution</span><small>${item.nextRunAt ? timeAgo(item.nextRunAt) : 'Not projected'}</small></div>
          <div class="agent-ops-drawer-time"><i class="fas fa-forward-step"></i><strong>${esc(item.nextRunAt ? formatDate(item.nextRunAt) : 'No live next-run timestamp')}</strong></div>
        </div>
        <div class="agent-ops-drawer-section">
          <div class="agent-ops-drawer-label"><span>Last evidence</span><small>${item.lastRun ? timeAgo(item.lastRun) : humanize(item.confidence)}</small></div>
          <div class="agent-ops-drawer-time"><i class="fas fa-clock-rotate-left"></i><strong>${esc(item.lastRun ? formatDate(item.lastRun) : item.source || 'Documentation only')}</strong></div>
        </div>
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>Execution evidence</span><small>${esc(item.source || 'Unknown source')}</small></div>
        <div class="agent-ops-drawer-chips">
          <span><i class="fas fa-bolt"></i>${esc(item.trigger || 'No trigger documented')}</span>
          ${item.lastStatus ? `<span><i class="fas ${iconForStatus(item.lastStatus)}"></i>${esc(humanize(item.lastStatus))}</span>` : ''}
          ${item.host ? `<span><i class="fas fa-server"></i>${esc(item.host)}</span>` : ''}
          ${item.model ? `<span><i class="fas fa-microchip"></i>${esc(item.model)}</span>` : ''}
        </div>
        ${item.diagnostic ? `<p class="agent-ops-drawer-note">${esc(item.diagnostic)}</p>` : ''}
      </section>
      <section class="agent-ops-drawer-section">
        <div class="agent-ops-drawer-label"><span>Recent history</span><small>${recentHistory.length ? `${recentHistory.length} bounded receipts` : 'Latest receipt only'}</small></div>
        <div class="agent-ops-drawer-list">
          ${compactSignalList(recentHistory, 'No run history was returned; open the native cron history for the authoritative log.', (run) => `
            <article>
              <i class="fas ${iconForStatus(run.status)}"></i>
              <span><strong>${esc(formatDate(run.at))}</strong><small>${esc(run.error || formatDuration(run.durationMs) || 'Execution receipt')}</small></span>
              ${badge(humanize(run.status || 'observed'), run.status || 'observed')}
            </article>`)}
        </div>
      </section>
      ${owner ? `
        <section class="agent-ops-drawer-section">
          <div class="agent-ops-drawer-label"><span>Responsible identity</span><small>Open the linked dossier</small></div>
          <div class="agent-ops-drawer-agent-links single">
            <button type="button" data-agent-inspect="${esc(owner.registryId)}">
              <span class="agent-ops-drawer-agent-icon"><i class="fas ${agentIcon(owner)}"></i></span>
              <span><strong>${esc(owner.name)}</strong><small>${esc(owner.responsibility)}</small></span>
              <i class="fas fa-arrow-right"></i>
            </button>
          </div>
        </section>` : ''}
      <footer class="agent-ops-drawer-actions">
        <a class="agent-ops-button primary" ${item.confidence === 'live' ? nativeControlAttributes('/cron') : `href="${esc(liveLink)}"`}><i class="fas fa-arrow-up-right"></i>${item.confidence === 'live' ? 'Open native cron history' : 'Open schedule'}</a>
        <a class="agent-ops-button" href="/nerve-center"><i class="fas fa-brain"></i>Trace evidence</a>
      </footer>`;

    showDrawer({
      eyebrow: 'Automation dossier',
      title: item.name,
      id: item.id,
      icon: item.nextRunAt ? 'fa-forward-step' : 'fa-repeat',
      body,
      trigger
    });
  }

  function closeAgentDrawer() {
    byId('agentOpsDrawerShell').hidden = true;
    document.body.classList.remove('agent-ops-drawer-open');
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') state.lastFocus.focus();
    state.lastFocus = null;
  }

  function renderAll(data) {
    renderMetrics(data);
    renderRuntimeLayers(data);
    renderWarnings(data);
    renderNextRuns(data);
    renderCoverage(data);
    renderSources(data);
    renderRoster(data);
    renderAgents(data);
    renderAutomations(data);
    renderWork(data);
    if (advanced) advanced.renderAll(data, state.query);
  }

  function renderCurrentFilteredView() {
    if (!state.data) return;
    if (state.tab === 'agents') renderAgents(state.data);
    if (state.tab === 'automations') renderAutomations(state.data);
    if (state.tab === 'work') renderWork(state.data);
    if (advanced) advanced.renderCurrent(state.tab, state.data, state.query);
  }

  function activateTab(tab, syncHash = true, resetPreset = true) {
    if (!['overview', 'inbox', 'responsibilities', 'activity', 'agents', 'automations', 'work'].includes(tab)) tab = 'overview';
    state.tab = tab;
    state.query = '';
    if (resetPreset) state.preset = null;
    byId('agentOpsSearch').value = '';
    document.querySelectorAll('[data-agent-ops-tab]').forEach((button) => {
      const active = button.dataset.agentOpsTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-agent-ops-pane]').forEach((pane) => {
      const active = pane.dataset.agentOpsPane === tab;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    });
    byId('agentOpsToolbar').hidden = tab === 'overview';
    updatePresetControl();
    if (syncHash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${tab}`);
    renderCurrentFilteredView();
  }

  function focusSearch(tab, query) {
    activateTab(tab, true, false);
    state.query = String(query || '').trim().toLowerCase();
    byId('agentOpsSearch').value = query || '';
    renderCurrentFilteredView();
  }

  async function load() {
    setLoading(true);
    if (!state.data) setStatus('loading', 'Building the control-plane view…', 'Checking registry and runtime sources.');
    try {
      const response = await fetch('/api/agent-ops', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
      state.data = body.data || body;
      renderAll(state.data);
      renderCurrentFilteredView();
      const warnings = asArray(state.data.warnings);
      setStatus(
        warnings.length ? 'attention' : 'good',
        warnings.length ? 'Projection complete with visibility gaps' : 'Control-plane view is aligned',
        warnings.length ? (warnings.length === 1 ? '1 item needs attention.' : `${warnings.length} items need attention.`) : 'Registry, schedules, and pipeline are readable.',
        state.data.generatedAt
      );
    } catch (error) {
      setStatus('error', 'Agent Ops could not refresh', error.message || 'Unknown error');
      if (!state.data) {
        ['agentOpsRuntimeLayers', 'agentOpsWarnings', 'agentOpsNextRuns', 'agentOpsCoverage', 'agentOpsSources', 'agentOpsRoster', 'agentOpsInbox', 'agentOpsResponsibilityLanes', 'agentOpsActivity', 'agentOpsAgents', 'agentOpsAutomations', 'agentOpsWork']
          .forEach((id) => { const element = byId(id); if (element) element.innerHTML = empty('Data unavailable.', 'fa-triangle-exclamation'); });
      }
    } finally {
      setLoading(false);
    }
  }

  document.querySelectorAll('[data-agent-ops-tab]').forEach((button) => {
    button.addEventListener('click', () => activateTab(button.dataset.agentOpsTab));
  });
  document.querySelectorAll('[data-open-agent-ops-tab]').forEach((button) => {
    button.addEventListener('click', () => activateTab(button.dataset.openAgentOpsTab));
  });
  byId('agentOpsSearch').addEventListener('input', (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderCurrentFilteredView();
  });
  byId('agentOpsClearFilter').addEventListener('click', () => {
    state.preset = null;
    state.query = '';
    byId('agentOpsSearch').value = '';
    renderCurrentFilteredView();
  });
  byId('agentOpsRefresh').addEventListener('click', load);
  root.addEventListener('click', (event) => {
    const nativeControl = event.target.closest('[data-openclaw-native]');
    if (nativeControl && openclawControlMode === 'ssh-tunnel') {
      event.preventDefault();
      openOpenClawHandoff(nativeControl.dataset.openclawNative, nativeControl);
      return;
    }
    const copyTunnel = event.target.closest('[data-copy-openclaw-tunnel]');
    if (copyTunnel) {
      event.preventDefault();
      copyOpenClawTunnel(copyTunnel);
      return;
    }
    if (advanced && advanced.handleClick(event)) return;
    const metric = event.target.closest('[data-metric-tab]');
    if (metric) {
      openPreset(metric.dataset.metricTab, metric.dataset.metricPreset);
      return;
    }
    const scrollTarget = event.target.closest('[data-scroll-target]');
    if (scrollTarget) {
      activateTab('overview');
      spotlight(scrollTarget.dataset.scrollTarget);
      return;
    }
    const attention = event.target.closest('[data-attention-type]');
    if (attention) {
      if (attention.dataset.attentionType === 'agents') openPreset('agents', 'unobserved-agents');
      else if (attention.dataset.attentionType === 'automations') openPreset('automations', 'documented-automations');
      else spotlight('agentOpsSources');
      return;
    }
    const runtimeInspect = event.target.closest('[data-runtime-inspect]');
    if (runtimeInspect) {
      openRuntimeDrawer(runtimeInspect.dataset.runtimeInspect, runtimeInspect);
      return;
    }
    const automationInspect = event.target.closest('[data-automation-inspect]');
    if (automationInspect) {
      openAutomationDrawer(automationInspect.dataset.automationInspect, automationInspect);
      return;
    }
    const coverage = event.target.closest('[data-coverage-target]');
    if (coverage) {
      if (coverage.dataset.coverageTarget === 'observed-agents') openPreset('agents', 'observed-agents');
      else if (coverage.dataset.coverageTarget === 'documented-automations') openPreset('automations', 'documented-automations');
      else spotlight('agentOpsSources');
      return;
    }
    const workStatus = event.target.closest('[data-work-status]');
    if (workStatus) {
      state.preset = `work:${workStatus.dataset.workStatus}`;
      renderWork(state.data);
      return;
    }
    const inspect = event.target.closest('[data-agent-inspect]');
    if (inspect) {
      openAgentDrawer(inspect.dataset.agentInspect, inspect);
      return;
    }
    if (event.target.closest('[data-close-agent-drawer]')) closeAgentDrawer();
  });
  document.addEventListener('keydown', (event) => {
    const drawerShell = byId('agentOpsDrawerShell');
    if (drawerShell.hidden) return;
    if (event.key === 'Escape') {
      closeAgentDrawer();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [...drawerShell.querySelectorAll('a[href], button:not([disabled])')]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  advanced = window.AgentOpsAdvanced?.create({
    root,
    byId,
    esc,
    humanize,
    timeAgo,
    badge,
    empty,
    activateTab,
    openPreset,
    focusSearch,
    spotlight,
    openAutomationDrawer,
    closeAgentDrawer,
    reload: load
  }) || null;

  activateTab(window.location.hash.replace('#', '') || 'overview', false);
  load();
  window.setInterval(load, 60_000);
})();

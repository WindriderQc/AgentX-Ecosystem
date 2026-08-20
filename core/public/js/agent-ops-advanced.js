(function () {
  'use strict';

  function create(context) {
    const {
      root, byId, esc, humanize, timeAgo, badge, empty,
      activateTab, openPreset, focusSearch, spotlight,
      openAutomationDrawer
    } = context;
    let data = null;
    let activityKind = 'all';

    const asArray = (value) => Array.isArray(value) ? value : [];
    const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

    function matches(item, query, fields) {
      if (!query) return true;
      return fields.some((field) => {
        const value = field.split('.').reduce((current, part) => current?.[part], item);
        return (Array.isArray(value) ? value.join(' ') : String(value || '')).toLowerCase().includes(query);
      });
    }

    function stat(label, value, detail, tone = '') {
      return `<article class="agent-ops-proof-stat ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
    }

    function warningIcon(type) {
      const icons = {
        source: 'fa-tower-broadcast',
        agents: 'fa-user-clock',
        automations: 'fa-calendar-xmark',
        'automation-error': 'fa-triangle-exclamation',
        'blocked-work': 'fa-ban',
        responsibility: 'fa-link-slash'
      };
      return icons[type] || 'fa-circle-exclamation';
    }

    function warningActionLabel(warning) {
      const kind = warning.action?.kind;
      if (kind === 'trace-sources') return 'Trace sources';
      if (kind === 'inspect-automation') return 'Inspect evidence';
      if (kind === 'open-tab') return 'Open map';
      return 'Open view';
    }

    function renderInbox(nextData, query = '') {
      data = nextData;
      const warnings = asArray(data.warnings);
      const filtered = warnings.filter((warning) => matches(warning, query, [
        'title', 'detail', 'impact', 'ownerId', 'source', 'type', 'severity'
      ]));
      const critical = warnings.filter((item) => item.severity === 'critical').length;
      const warningCount = warnings.filter((item) => item.severity === 'warning').length;
      const owned = warnings.filter((item) => item.ownerId).length;
      byId('agentOpsTabInboxCount').textContent = warnings.length;
      byId('agentOpsInboxSummary').innerHTML = [
        stat('Open signals', warnings.length, 'Current projection'),
        stat('Critical', critical, 'Delivery or execution', critical ? 'bad' : 'good'),
        stat('Visibility', warningCount, 'Coverage attention', warningCount ? 'warn' : 'good'),
        stat('Named owner', `${owned}/${warnings.length || 0}`, 'Direct accountability')
      ].join('');
      byId('agentOpsInbox').innerHTML = filtered.length ? filtered.map((warning) => `
        <article class="agent-ops-inbox-item ${esc(warning.severity)}">
          <span class="agent-ops-inbox-icon"><i class="fas ${warningIcon(warning.type)}"></i></span>
          <div class="agent-ops-inbox-copy">
            <strong>${esc(warning.title)}</strong>
            <p>${esc(warning.detail)}</p>
            <div class="agent-ops-meta-row">${badge(humanize(warning.severity), warning.severity)}${warning.ownerId ? badge(warning.ownerId, 'info', 'fa-user') : ''}${badge(warning.source || 'projected evidence', 'configured', 'fa-fingerprint')}</div>
          </div>
          <div class="agent-ops-inbox-impact"><span>Operational impact</span>${esc(warning.impact || 'Review the supporting evidence before acting.')}</div>
          <button class="agent-ops-button compact agent-ops-inbox-action" type="button" data-inbox-warning="${esc(warning.id)}">${warningActionLabel(warning)} <i class="fas fa-arrow-right"></i></button>
        </article>
      `).join('') : empty('No attention items match this filter.', 'fa-circle-check');
      byId('agentOpsFilterResult').textContent = `${filtered.length} of ${warnings.length} attention items`;
    }

    function signalButton(signal, kind) {
      const attribute = kind === 'automation'
        ? `data-automation-inspect="${esc(signal.id)}"`
        : `data-focus-work="${esc(signal.id)}"`;
      return `<button type="button" ${attribute}><i class="fas ${kind === 'automation' ? 'fa-clock' : 'fa-list-check'}"></i><span><strong>${esc(signal.name)}</strong><small>${esc(humanize(signal.status))}</small></span></button>`;
    }

    function renderResponsibilities(nextData, query = '') {
      data = nextData;
      const relationship = asObject(data.responsibilities);
      const summary = asObject(relationship.summary);
      const lanes = asArray(relationship.lanes).filter((lane) => matches(lane, query, [
        'agentId', 'name', 'status', 'responsibility', 'scopes', 'automations', 'work'
      ]) || [...asArray(lane.automations), ...asArray(lane.work)].some((signal) => matches(signal, query, ['name', 'status'])));
      const gaps = Number(summary.unassignedSignals || 0) + Number(summary.duplicateScopes || 0);
      byId('agentOpsTabResponsibilityCount').textContent = gaps;
      byId('agentOpsResponsibilitySummary').innerHTML = [
        stat('Ownership coverage', `${summary.coveragePct || 0}%`, `${summary.attributedSignals || 0}/${summary.totalSignals || 0} signals`, summary.coveragePct >= 90 ? 'good' : 'warn'),
        stat('Unmapped', summary.unassignedSignals || 0, 'Work + cadence gaps', summary.unassignedSignals ? 'bad' : 'good'),
        stat('Duplicate scopes', summary.duplicateScopes || 0, 'Registry declarations', summary.duplicateScopes ? 'warn' : 'good'),
        stat('Quiet identities', summary.agentsWithoutSignals || 0, 'No active owned signals')
      ].join('');
      byId('agentOpsResponsibilityLanes').innerHTML = lanes.length ? lanes.map((lane) => {
        const signals = [
          ...asArray(lane.automations).map((item) => signalButton(item, 'automation')),
          ...asArray(lane.work).map((item) => signalButton(item, 'work'))
        ];
        return `
          <article class="agent-ops-responsibility-lane">
            <div class="agent-ops-lane-owner">
              <button type="button" data-agent-inspect="${esc(lane.agentId)}" aria-label="Inspect ${esc(lane.name)}"><i class="fas fa-user-gear"></i></button>
              <div><strong>${esc(lane.name)}</strong><small>${esc(lane.agentId)} · ${esc(humanize(lane.status))}</small></div>
              <p>${esc(lane.responsibility)}</p>
            </div>
            <div class="agent-ops-lane-signals">${signals.join('') || '<div class="agent-ops-lane-empty">No active work or cadence attributed.</div>'}</div>
            <div class="agent-ops-lane-load ${esc(lane.load)}"><strong>${lane.signalCount}</strong><small>${esc(lane.load)} load</small>${lane.blockedCount ? `<span class="agent-ops-badge bad">${lane.blockedCount} blocked</span>` : ''}</div>
          </article>`;
      }).join('') : empty('No ownership lanes match this filter.', 'fa-diagram-project');

      const unassigned = asArray(relationship.unassigned);
      const duplicates = asArray(relationship.duplicateScopes);
      const capabilities = asArray(relationship.capabilities);
      byId('agentOpsResponsibilityGaps').innerHTML = `
        <span class="agent-ops-kicker">Ownership diagnostics</span><h3>Gaps &amp; boundaries</h3>
        <section class="agent-ops-gap-section"><div class="agent-ops-gap-list">${unassigned.map((item) => `<article class="agent-ops-gap-item"><strong>${esc(item.name)}</strong><small>${esc(humanize(item.kind))} · declared owner: ${esc(item.owner)}</small></article>`).join('') || '<div class="agent-ops-drawer-empty">No unassigned operating signals.</div>'}</div></section>
        ${duplicates.length ? `<section class="agent-ops-gap-section"><span class="agent-ops-kicker">Duplicate scopes</span><div class="agent-ops-gap-list">${duplicates.map((item) => `<article class="agent-ops-gap-item"><strong>${esc(item.scope)}</strong><small>${esc(item.agentIds.join(' · '))}</small></article>`).join('')}</div></section>` : ''}
        <section class="agent-ops-gap-section"><span class="agent-ops-kicker">Platform capabilities</span><div class="agent-ops-gap-list">${capabilities.slice(0, 8).map((item) => `<article class="agent-ops-gap-item"><strong>${esc(item.name)}</strong><small>${esc(item.service || 'core')} · not an autonomous agent</small></article>`).join('')}</div></section>`;
      byId('agentOpsFilterResult').textContent = `${lanes.length} of ${asArray(relationship.lanes).length} ownership lanes`;
    }

    function activityIcon(kind) {
      return { automation: 'fa-clock-rotate-left', work: 'fa-list-check', operator: 'fa-fingerprint', source: 'fa-tower-broadcast' }[kind] || 'fa-wave-square';
    }

    function activityAction(item) {
      if (item.kind === 'automation') return `<button class="agent-ops-button compact" type="button" data-automation-inspect="${esc(item.targetId)}">Inspect</button>`;
      if (item.kind === 'work') return `<button class="agent-ops-button compact" type="button" data-focus-work="${esc(item.targetId)}">Open</button>`;
      if (item.kind === 'source') return '<button class="agent-ops-button compact" type="button" data-trace-sources>Trace</button>';
      return badge(humanize(item.status), item.status);
    }

    function renderActivity(nextData, query = '') {
      data = nextData;
      const activity = asObject(data.activity);
      const all = asArray(activity.items);
      const items = all.filter((item) => (activityKind === 'all' || item.kind === activityKind) && matches(item, query, [
        'kind', 'title', 'detail', 'status', 'ownerId', 'targetId', 'evidence'
      ]));
      byId('agentOpsTabActivityCount').textContent = all.length;
      root.querySelectorAll('[data-activity-kind]').forEach((button) => button.classList.toggle('active', button.dataset.activityKind === activityKind));
      byId('agentOpsActivity').innerHTML = items.length ? items.map((item) => `
        <article class="agent-ops-activity-item">
          <span class="agent-ops-activity-icon"><i class="fas ${activityIcon(item.kind)}"></i></span>
          <div class="agent-ops-activity-copy"><strong>${esc(item.title)}</strong><small>${esc(item.detail || 'Evidence recorded')}</small><div class="agent-ops-meta-row">${badge(humanize(item.kind), 'info')}${item.ownerId ? badge(item.ownerId, 'configured', 'fa-user') : ''}</div></div>
          <div class="agent-ops-activity-evidence"><strong>${esc(item.evidence || 'projected')}</strong><br>${esc(humanize(item.status))}</div>
          <div class="agent-ops-activity-time">${esc(timeAgo(item.timestamp))}<br>${activityAction(item)}</div>
        </article>
      `).join('') : empty('No activity receipts match this filter.', 'fa-wave-square');
      byId('agentOpsFilterResult').textContent = `${items.length} of ${all.length} activity receipts${activityKind === 'all' ? '' : ` · ${humanize(activityKind)}`}`;
    }

    function renderAll(nextData, query = '') {
      data = nextData;
      renderInbox(data, query);
      renderResponsibilities(data, query);
      renderActivity(data, query);
    }

    function renderCurrent(tab, nextData, query = '') {
      if (tab === 'inbox') renderInbox(nextData, query);
      if (tab === 'responsibilities') renderResponsibilities(nextData, query);
      if (tab === 'activity') renderActivity(nextData, query);
    }

    function followWarning(warning, trigger) {
      const action = warning?.action || {};
      if (action.kind === 'trace-sources') {
        activateTab('overview');
        spotlight('agentOpsSources');
      } else if (action.kind === 'open-preset') openPreset(action.tab, action.preset);
      else if (action.kind === 'open-tab') activateTab(action.tab);
      else if (action.kind === 'inspect-automation') openAutomationDrawer(action.targetId, trigger);
    }

    function handleClick(event) {
      const activityFilter = event.target.closest('[data-activity-kind]');
      if (activityFilter) {
        activityKind = activityFilter.dataset.activityKind;
        renderActivity(data, String(byId('agentOpsSearch').value || '').trim().toLowerCase());
        return true;
      }
      const inbox = event.target.closest('[data-inbox-warning]');
      if (inbox) {
        followWarning(asArray(data?.warnings).find((item) => item.id === inbox.dataset.inboxWarning), inbox);
        return true;
      }
      const focusWork = event.target.closest('[data-focus-work]');
      if (focusWork) {
        focusSearch('work', focusWork.dataset.focusWork);
        return true;
      }
      if (event.target.closest('[data-trace-sources]')) {
        activateTab('overview');
        spotlight('agentOpsSources');
        return true;
      }
      return false;
    }

    return { renderAll, renderCurrent, handleClick };
  }

  window.AgentOpsAdvanced = { create };
})();

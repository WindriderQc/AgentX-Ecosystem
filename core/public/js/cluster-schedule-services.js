/**
 * Cluster Schedule — Persistent Services Strip
 *
 * Extracted from cluster-schedule.js for file-size discipline.
 * Depends on globals defined in cluster-schedule.js (loaded first):
 *   TASK_COLORS, liveHostsData, persistentServicesData,
 *   servicePopoverPinnedId, lastServiceHoverId, servicesCollapsed,
 *   esc, getCadenceLabel, formatDuration, getHostMeta, getSourceMeta
 */

// ── Persistent Services Strip ───────────────────────────────

function renderServicesStrip(persistent) {
  const strip = document.getElementById('servicesStrip');
  const grid = document.getElementById('servicesGrid');
  const count = document.getElementById('servicesCount');

  if (persistent.length === 0) {
    strip.style.display = 'none';
    hideServicePopover(true);
    return;
  }
  strip.style.display = 'block';
  count.textContent = `(${persistent.length})`;

  const serviceGroups = groupPersistentServices(persistent);
  grid.innerHTML = serviceGroups.map(group => `
    <div class="cs-service-group">
      <div class="cs-service-group-header">${esc(group.label)} <span style="color:#5f718d;font-weight:500">${group.entries.length}</span></div>
      <div class="cs-service-group-row">
        ${group.entries.map((p, index) => {
          const color = TASK_COLORS[p.taskType] || '#666';
          const cadence = getCadenceLabel(p);
          const liveHost = p.host ? liveHostsData.find(h => h.id === p.host) : null;
          const isHostOnline = !liveHost || liveHost.status === 'online';
          const dotClass = isHostOnline ? 'active' : 'stale';
          const dotColor = isHostOnline ? color : '#f59e0b';
          return `<div class="cs-service-chip" data-service-id="${esc(getServiceEntryId(p, index))}">
            <span class="cs-service-dot ${dotClass}" style="background:${dotColor}"></span>
            ${esc(p.name)}
            <span class="cs-service-cadence">${esc(cadence || (p.slots.length > 1 ? p.slots.length + '×/d' : '24/7'))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');

  attachServiceChipEvents();

  if (servicePopoverPinnedId) {
    const activeChip = grid.querySelector(`.cs-service-chip[data-service-id="${servicePopoverPinnedId}"]`);
    if (activeChip) showServicePopover(servicePopoverPinnedId, activeChip, true);
    else hideServicePopover(true);
  }
}

function groupPersistentServices(entries) {
  const groups = [
    { key: 'monitoring', label: 'Monitoring', entries: [] },
    { key: 'ops', label: 'Ops & Maintenance', entries: [] },
    { key: 'sync', label: 'Sync & Automation', entries: [] },
    { key: 'other', label: 'Other Services', entries: [] }
  ];

  for (const entry of (entries || [])) {
    if (entry.taskType === 'monitoring') groups[0].entries.push(entry);
    else if (entry.taskType === 'maintenance') groups[1].entries.push(entry);
    else if (entry.taskType === 'sync') groups[2].entries.push(entry);
    else groups[3].entries.push(entry);
  }

  return groups.filter(group => group.entries.length > 0);
}

function toggleServices() {
  servicesCollapsed = !servicesCollapsed;
  document.getElementById('servicesGrid').classList.toggle('collapsed', servicesCollapsed);
  document.getElementById('servicesToggle').classList.toggle('collapsed', servicesCollapsed);
}

function attachServiceChipEvents() {
  document.querySelectorAll('.cs-service-chip').forEach(chip => {
    chip.addEventListener('mouseenter', onServiceChipEnter);
    chip.addEventListener('mouseleave', onServiceChipLeave);
    chip.addEventListener('mousemove', onServiceChipMove);
    chip.addEventListener('click', onServiceChipClick);
  });
}

function onServiceChipEnter(e) {
  const serviceId = e.currentTarget.dataset.serviceId;
  lastServiceHoverId = serviceId;
  if (servicePopoverPinnedId && servicePopoverPinnedId !== serviceId) return;
  showServicePopover(serviceId, e.currentTarget, false);
}

function onServiceChipLeave(e) {
  const serviceId = e.currentTarget.dataset.serviceId;
  if (servicePopoverPinnedId === serviceId) return;
  lastServiceHoverId = null;
  hideServicePopover();
}

function onServiceChipMove(e) {
  const serviceId = e.currentTarget.dataset.serviceId;
  if (servicePopoverPinnedId === serviceId) return;
  positionServicePopover(e.currentTarget);
}

function onServiceChipClick(e) {
  const chip = e.currentTarget;
  const serviceId = chip.dataset.serviceId;
  if (servicePopoverPinnedId === serviceId) {
    hideServicePopover(true);
    return;
  }
  showServicePopover(serviceId, chip, true);
}

function showServicePopover(serviceId, anchorEl, pinned = false) {
  const popover = document.getElementById('servicePopover');
  const service = persistentServicesData.find((entry, index) => getServiceEntryId(entry, index) === serviceId);
  if (!popover || !service || !anchorEl) return;

  servicePopoverPinnedId = pinned ? serviceId : servicePopoverPinnedId;
  popover.innerHTML = renderServicePopover(service, serviceId, pinned);
  popover.classList.add('visible');
  positionServicePopover(anchorEl);

  document.querySelectorAll('.cs-service-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.serviceId === (servicePopoverPinnedId || serviceId));
  });

  const closeBtn = popover.querySelector('[data-close-service-popover]');
  if (closeBtn) closeBtn.addEventListener('click', () => hideServicePopover(true));
}

function hideServicePopover(force = false) {
  const popover = document.getElementById('servicePopover');
  if (!popover) return;
  if (!force && servicePopoverPinnedId) return;
  if (force) servicePopoverPinnedId = null;
  popover.classList.remove('visible');
  popover.innerHTML = '';
  document.querySelectorAll('.cs-service-chip').forEach(chip => chip.classList.remove('active'));
}

function positionServicePopover(anchorEl) {
  const popover = document.getElementById('servicePopover');
  if (!popover || !anchorEl || !popover.classList.contains('visible')) return;
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  let left = rect.left;
  let top = rect.bottom + 10;

  if (left + popRect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - popRect.width - margin);
  }
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - popRect.height - 10);
  }

  popover.style.left = `${Math.max(margin, left)}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
}

function renderServicePopover(service, serviceId, pinned) {
  const sourceMeta = getSourceMeta(service.source);
  const hostMeta = getHostMeta(service.host);
  const taskColor = TASK_COLORS[service.taskType] || '#666';
  const stats = [
    { label: 'Schedule', value: service.scheduleType === 'continuous' ? '24/7 continuous' : `${service.slots?.length || 0} runs/day` },
    { label: 'Source', value: sourceMeta.label },
    { label: 'Host', value: service.host ? hostMeta.label : (service.metadata?.runner || 'Shared infra') },
    { label: 'Task Type', value: service.taskType || 'service' },
    { label: 'Priority', value: service.priority ? `P${service.priority}` : 'n/a' },
    { label: 'Model', value: service.model || service.metadata?.role || 'No model bound' },
    { label: 'Agent', value: service.agent || service.metadata?.webhook || 'n/a' },
    { label: 'Capacity', value: formatServiceCapacity(service) }
  ];

  const note = buildServiceNote(service);
  return `
    <div class="cs-service-popover-header">
      <div>
        <div class="cs-service-popover-title">${esc(service.name)}</div>
        <div class="cs-service-popover-subtitle">${esc(service.sourceId || serviceId)}</div>
      </div>
      ${pinned ? '<button class="cs-service-popover-close" data-close-service-popover title="Close">×</button>' : ''}
    </div>
    <div class="cs-service-popover-badges">
      <span class="cs-service-popover-badge"><span class="cs-legend-color" style="background:${taskColor}"></span>${esc(service.taskType || 'service')}</span>
      <span class="cs-service-popover-badge">${esc(sourceMeta.label)}</span>
      <span class="cs-service-popover-badge">${esc(service.host ? hostMeta.label : 'Infra / Shared')}</span>
      ${pinned ? '<span class="cs-service-popover-badge">Pinned</span>' : '<span class="cs-service-popover-badge">Hover preview</span>'}
    </div>
    <div class="cs-service-popover-grid">
      ${stats.map(stat => `
        <div class="cs-service-popover-stat">
          <div class="cs-service-popover-stat-label">${esc(stat.label)}</div>
          <div class="cs-service-popover-stat-value">${esc(stat.value)}</div>
        </div>
      `).join('')}
    </div>
    <div class="cs-service-popover-note">${esc(note)}</div>
  `;
}

function getServiceEntryId(entry, index = 0) {
  return String(entry?.sourceId || entry?.id || `service-${index}`);
}

function formatServiceCapacity(service) {
  if (service.vramMb) return `${(service.vramMb / 1024).toFixed(0)} GB reserved`;
  if (service.metadata?.gpu) return service.metadata.gpu;
  if (service.estimatedDurationMs) return formatDuration(service.estimatedDurationMs);
  return 'Lightweight service';
}

function buildServiceNote(service) {
  const parts = [];
  if (service.metadata?.runner) parts.push(`Runs via ${service.metadata.runner}.`);
  if (service.metadata?.role) parts.push(`Role: ${service.metadata.role}.`);
  if (service.metadata?.ip) parts.push(`Host IP ${service.metadata.ip}.`);
  if (service.metadata?.webhook) parts.push(`Webhook ${service.metadata.webhook}.`);
  if (service.estimatedDurationMs && service.scheduleType !== 'continuous') {
    parts.push(`Estimated runtime ${formatDuration(service.estimatedDurationMs)} per cycle.`);
  }
  if (!parts.length) parts.push('Continuous background service shown outside the main timeline.');
  return parts.join(' ');
}

// ── Legend ───────────────────────────────────────────────────

function renderLegend(timeline) {
  const el = document.getElementById('legend');
  const hostCounts = countBy(timeline, entry => getHostMeta(entry.host).id);
  const sourceCounts = countBy(timeline, entry => entry.source || 'unknown');

  el.innerHTML = `
    ${renderLegendSection('Hosts', hostCounts, id => {
      const meta = getHostMeta(id);
      return {
        label: meta.label,
        className: `host-${meta.id}`,
        swatch: meta.color
      };
    })}
    ${renderLegendSection('Sources', sourceCounts, id => {
      const meta = getSourceMeta(id);
      return {
        label: meta.label,
        className: '',
        swatch: meta.color
      };
    })}
  `;
}
function renderLegendFromHosts(hosts) {
  const el = document.getElementById('legend');
  const types = new Set();
  for (const h of hosts) for (const t of h.tasks) types.add(t.taskType);
  el.innerHTML = renderLegendSection('Task Colors', Array.from(types).sort().map(type => ({
    key: type,
    count: null
  })), id => ({
    label: id,
    className: '',
    swatch: TASK_COLORS[id] || '#666'
  }), { showCount: false });
}

function renderLegendSection(title, items, getMeta, options = {}) {
  const showCount = options.showCount !== false;
  const normalized = Array.isArray(items)
    ? items
    : Array.from(items.entries()).map(([key, count]) => ({ key, count }));

  if (!normalized.length) {
    return `<div class="cs-legend-section"><span class="cs-legend-title">${esc(title)}</span><span class="cs-legend-empty">None</span></div>`;
  }

  return `<div class="cs-legend-section">
    <span class="cs-legend-title">${esc(title)}</span>
    ${normalized.map(({ key, count }) => {
      const meta = getMeta(key);
      const className = meta.className ? ` ${meta.className}` : '';
      return `<div class="cs-legend-item${className}">
        <div class="cs-legend-color" style="background:${meta.swatch}"></div>
        <span>${esc(meta.label)}</span>
        ${showCount && Number.isFinite(count) ? `<span class="cs-legend-count">${count}</span>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return String(a[0]).localeCompare(String(b[0]));
    })
    .map(([key, count]) => ({ key, count }));
}

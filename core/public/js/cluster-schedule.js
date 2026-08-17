/**
 * Cluster Schedule Dashboard — v2
 *
 * 1. Live host cards — VRAM bar, active model, next job, health badge
 * 2. Background services strip — persistent monitors collapsed out of timeline
 * 3. Grouped timeline — rows grouped by taskType, collapsible, with now line
 * 4. Upcoming + Alerts cards
 * 5. Conflict detection
 */

const API_BASE = '/api/cluster';
const LIVE_POLL_MS = 30000;
const COUNTDOWN_TICK_MS = 1000;

const TASK_COLORS = {
  benchmark: '#f59e0b', sync: '#3b82f6', cleanup: '#8b5cf6',
  monitoring: '#22c55e', inference: '#7cf0ff', maintenance: '#6b7280',
  ingestion: '#ec4899', backup: '#f97316', scanning: '#14b8a6',
  diagnostics: '#a78bfa'
};

const HOST_COLORS = ['#7cf0ff', '#f97316', '#22c55e', '#a78bfa', '#f59e0b'];

const SOURCE_META = {
  openclaw: { label: 'OpenClaw', color: '#7c3aed' },
  agentx: { label: 'AgentX', color: '#38bdf8' },
  'agentx-system': { label: 'System Cron', color: '#f59e0b' },
  'ollama-persistent': { label: 'Persistent GPU', color: '#22c55e' }
};

const CATEGORY_LABELS = {
  monitoring: 'MON', maintenance: 'MAINT', sync: 'SYNC', benchmark: 'BENCH',
  inference: 'AI', diagnostics: 'DIAG', cleanup: 'CLEAN', ingestion: 'INGEST',
  backup: 'BAK', scanning: 'SCAN'
};

let livePollTimer = null;
let countdownTimer = null;
let nextTasksData = [];
let conflictsData = [];
let claimsData = [];
let liveHostsData = [];
let currentDate = new Date().toISOString().slice(0, 10);
let viewMode = 'task';
let collapsedGroups = new Set();
let servicesCollapsed = false;
let actualView = 'heatmap';
let showHighFreqLightJobs = false;
let showNoGpuTasks = true;
let servicePopoverPinnedId = null;
let lastServiceHoverId = null;
let persistentServicesData = [];
let visibleTimelineEntries = [];
let upcomingTimelineEntries = [];

// ── API ─────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.error || 'API error');
  return json.data;
}

// ── Date Nav ────────────────────────────────────────────────

function updateDateLabel() {
  const el = document.getElementById('dateLabel');
  const d = new Date(currentDate + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  el.textContent = isToday() ? `${label} (Today)` : label;
}
function shiftDate(delta) {
  const d = new Date(currentDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  currentDate = d.toISOString().slice(0, 10);
  updateDateLabel(); loadTimeline(); loadConflicts();
}
function goToday() { currentDate = new Date().toISOString().slice(0, 10); updateDateLabel(); loadTimeline(); loadConflicts(); }
function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('viewTask').classList.toggle('active', mode === 'task');
  document.getElementById('viewHost').classList.toggle('active', mode === 'host');
  syncTimelineFilterUI();
  loadTimeline(); loadConflicts();
}
function isToday() { return currentDate === new Date().toISOString().slice(0, 10); }

// ── Live Host Cards (enriched) ──────────────────────────────

async function loadLiveState() {
  const container = document.getElementById('liveBar');
  try {
    const [liveData, nextData] = await Promise.all([
      fetchJSON(`${API_BASE}/schedule/live`),
      fetchJSON(`${API_BASE}/schedule/next?count=20`)
    ]);
    renderLiveBar(container, liveData.hosts, nextData.tasks || []);
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

function renderLiveBar(container, hosts, nextTasks) {
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }
  liveHostsData = hosts;

  container.innerHTML = hosts.map(h => {
    const isOnline = h.status === 'online';
    const statusClass = isOnline ? 'online' : 'unreachable';
    const models = h.models || [];
    const hasModels = models.length > 0;

    // VRAM
    const totalUsed = models.reduce((s, m) => s + (m.sizeVram || 0), 0);
    const capacityMb = h.vramMb || 0;
    const capacityGb = (capacityMb / 1024).toFixed(0);
    const usedGb = (totalUsed / 1073741824).toFixed(1);
    const freeBytes = Math.max(0, capacityMb * 1048576 - totalUsed);
    const freeGb = (freeBytes / 1073741824).toFixed(1);
    const usedPct = capacityMb > 0 ? Math.min(100, (totalUsed / (capacityMb * 1048576)) * 100) : 0;
    const vramFillClass = usedPct > 85 ? 'high' : usedPct > 50 ? 'mid' : 'low';
    const freeClass = usedPct > 85 ? 'critical' : usedPct > 50 ? 'tight' : '';
    const isIdle = !hasModels && isOnline;

    // Workload state — one badge that captures the meaningful state
    let stateBadgeClass, stateBadgeLabel;
    if (!isOnline)     { stateBadgeClass = 'down';    stateBadgeLabel = 'OFFLINE'; }
    else if (hasModels){ stateBadgeClass = 'ok';      stateBadgeLabel = 'ACTIVE'; }
    else               { stateBadgeClass = 'idle';    stateBadgeLabel = 'IDLE'; }

    const gpuLine = h.gpu?.model || h.gpuModel || '';

    // Optional IP from the explicitly configured runtime URL.
    const ipMatch = (h.url || '').match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    const hostIp = ipMatch ? ipMatch[0] : '';

    // Loaded model display
    const modelsHtml = hasModels
      ? `<div class="cs-host-model-summary">Loaded ${models.length} model${models.length !== 1 ? 's' : ''}</div>
         <div class="cs-host-models-loaded">${models.map(m => `<span class="cs-model-tag">${esc(m.name || m.model)}</span>`).join('')}</div>`
      : `<div class="cs-host-models-idle"><i class="fas fa-circle-notch" style="font-size:9px;margin-right:5px;opacity:0.4"></i>No model loaded</div>`;

    // Scheduled jobs for this host (non-service-tick)
    const allHostJobs = nextTasks.filter(t => t.host === h.id && !isServiceTick(t));
    const hostJobsSoon = allHostJobs.filter(t => t.msFromNow >= 0 && t.msFromNow < 3600000);
    const nextJob     = allHostJobs[0];                    // soonest scheduled job
    const nextGpuJob  = allHostJobs.find(t => t.model);   // soonest GPU-bound job

    // VRAM row: context-aware
    let vramLine = '';
    if (capacityMb > 0) {
      if (isIdle) {
        vramLine = `<div class="cs-host-vram-idle"><span style="color:#22c55e;font-size:10px">⬤</span> ${capacityGb} GB available</div>`;
      } else if (hasModels) {
        vramLine = `
          <div class="cs-vram-bar" style="margin-top:6px"><div class="cs-vram-fill ${vramFillClass}" style="width:${usedPct.toFixed(1)}%"></div></div>
          <div class="cs-host-detail">
            <span>${usedGb} / ${capacityGb} GB VRAM</span>
            <span class="cs-vram-free ${freeClass}">${freeGb} GB free</span>
          </div>`;
      }
    }

    // Footer: next job + queue
    let footerHtml = '';
    if (!isOnline) {
      footerHtml = `<div class="cs-host-footer-offline"><i class="fas fa-exclamation-triangle"></i> Host unreachable</div>`;
    } else if (nextJob) {
      const jobCount = hostJobsSoon.length;
      const countPart = jobCount > 1 ? `<span class="cs-host-queue-count">${jobCount} jobs in next hour</span>` : '';
      footerHtml = `<div class="cs-host-next"><i class="fas fa-clock"></i> Next scheduled: ${esc(nextJob.name)} <span class="cs-host-next-time">${formatCountdown(nextJob.msFromNow)}</span> ${countPart}</div>`;
      // If next job is light but there's an upcoming GPU job, surface it
      if (!nextJob.model && nextGpuJob && nextGpuJob !== nextJob) {
        footerHtml += `<div class="cs-host-next-gpu"><i class="fas fa-microchip"></i> Next GPU run: ${esc(nextGpuJob.model)} in ${formatCountdown(nextGpuJob.msFromNow)}</div>`;
      }
    } else {
      footerHtml = `<div class="cs-host-next" style="font-style:italic">No scheduled jobs today</div><div class="cs-host-standby-note">Host is online and ready for queued work.</div>`;
    }

    const cardClass = !isOnline ? ' down' : hasModels ? ' active' : '';

    return `
      <div class="cs-host-card${cardClass}">
        <div class="cs-host-header">
          <span class="cs-status-dot ${statusClass}"></span>
          <div class="cs-host-title">
            <span class="cs-host-name">${esc(h.name)}</span>
            <span class="cs-host-role">${gpuLine}${hostIp ? ` · <span class="cs-host-ip">${hostIp}</span>` : ''}</span>
          </div>
          <span class="cs-health-badge ${stateBadgeClass}">${stateBadgeLabel}</span>
        </div>
        ${modelsHtml}
        ${vramLine}
        <div class="cs-host-card-footer">${footerHtml}</div>
      </div>`;
  }).join('');

  // Inject global status summary into header
  updateHeaderStatus(hosts, nextTasks);
}

function updateHeaderStatus(hosts, nextTasks) {
  const el = document.getElementById('headerStatus');
  if (!el) return;
  const total = hosts.length;
  const online = hosts.filter(h => h.status === 'online').length;
  const offline = total - online;
  const loaded = hosts.filter(h => (h.models || []).length > 0).length;
  const scheduledNext = nextTasks.filter(t => !isServiceTick(t) && t.msFromNow >= 0 && t.msFromNow < 3600000);
  const gpuJobs = scheduledNext.filter(t => t.model).length;
  const lightJobs = scheduledNext.length - gpuJobs;

  const nextHourLabel = scheduledNext.length > 0
    ? `${scheduledNext.length} next hour`
    : '';

  el.innerHTML = [
    `<span class="cs-header-status-item">${total} hosts</span>`,
    online > 0 ? `<span class="cs-header-status-item ok"><i class="fas fa-circle" style="font-size:7px"></i> ${online} online</span>` : '',
    offline > 0 ? `<span class="cs-header-status-item err"><i class="fas fa-circle" style="font-size:7px"></i> ${offline} offline</span>` : '',
    `<span class="cs-header-status-item"><i class="fas fa-microchip" style="font-size:9px"></i> ${loaded} loaded</span>`,
    nextHourLabel ? `<span class="cs-header-status-item warn"><i class="fas fa-clock" style="font-size:9px"></i> ${nextHourLabel}${gpuJobs ? ` · ${gpuJobs} GPU` : ''}${lightJobs ? ` · ${lightJobs} light` : ''}</span>` : `<span class="cs-header-status-item"><i class="fas fa-clock" style="font-size:9px"></i> quiet next hour</span>`,
  ].filter(Boolean).join('<span style="color:#1e293b"> · </span>');
}

// ── Timeline ────────────────────────────────────────────────

async function loadTimeline() {
  const container = document.getElementById('heatmapContainer');
  try {
    if (viewMode === 'host') {
      const data = await fetchJSON(`${API_BASE}/schedule/timeline-by-host?date=${currentDate}`);
      document.getElementById('servicesStrip').style.display = 'none';
      upcomingTimelineEntries = data.hosts.flatMap(host => host.tasks || []);
      const hosts = data.hosts.map(host => ({
        ...host,
        tasks: filterTimelineEntries(host.tasks || [])
      }));
      visibleTimelineEntries = hosts.flatMap(host => host.tasks || []);
      renderHostHeatmap(container, hosts);
      renderLegendFromHosts(hosts);
    } else {
      const data = await fetchJSON(`${API_BASE}/schedule/timeline?date=${currentDate}`);
      const { persistent, scheduled } = splitTimeline(data.timeline);
      const continuousServices = persistent.filter(entry => entry.source !== 'ollama-persistent');
      persistentServicesData = persistent;
      upcomingTimelineEntries = scheduled;

      // Schedule filters should not change the separate continuous-services strip.
      const visibleServices = continuousServices;
      const visibleScheduled = filterTimelineEntries(scheduled);
      visibleTimelineEntries = visibleScheduled;

      renderServicesStrip(visibleServices);
      renderGroupedHeatmap(container, visibleScheduled);
      renderLegend(visibleScheduled);
    }
    loadNextTasks();
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

// Split timeline into 24/7 continuous services vs schedulable jobs.
function splitTimeline(timeline) {
  if (!timeline) return { persistent: [], scheduled: [] };
  const persistent = [];
  const scheduled = [];
  for (const entry of timeline) {
    const isContinuous = entry.slots.length === 1 && entry.slots[0].continuous;
    if (isContinuous) persistent.push(entry);
    else scheduled.push(entry);
  }
  return { persistent, scheduled };
}

function filterTimelineEntries(entries) {
  return (entries || []).filter(entry => {
    if (!showNoGpuTasks && isNoGpuTaskEntry(entry)) return false;
    if (!showHighFreqLightJobs && isHighFrequencyLightJob(entry)) return false;
    return true;
  });
}

function isNoGpuTaskEntry(entry) {
  return !entry?.model && entry?.source !== 'ollama-persistent';
}

function isHighFrequencyLightJob(entry) {
  if (!isNoGpuTaskEntry(entry)) return false;
  const slots = entry?.slots || [];
  const isContinuous = slots.length === 1 && slots[0]?.continuous;
  return isContinuous || slots.length > 12;
}

function setTimelineFilter(filterName, checked) {
  if (filterName === 'highFreq') showHighFreqLightJobs = checked;
  if (filterName === 'noGpu') showNoGpuTasks = checked;
  loadTimeline();
}

function syncTimelineFilterUI() {
  const filters = document.getElementById('timelineFilters');
  if (filters) filters.style.display = viewMode === 'task' ? 'flex' : 'none';
}

// ── Grouped Task Heatmap ────────────────────────────────────

function renderGroupedHeatmap(container, timeline) {
  if (!timeline || timeline.length === 0) {
    container.innerHTML = '<div class="cs-empty">No scheduled jobs for this day</div>';
    return;
  }

  const currentHour = isToday() ? new Date().getHours() : -1;
  const nowMinuteFrac = isToday() ? new Date().getMinutes() / 60 : -1;

  // Group by taskType
  const groups = {};
  for (const entry of timeline) {
    const g = entry.taskType || 'other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(entry);
  }

  // Sort groups: monitoring first, then alphabetical
  const groupOrder = ['monitoring', 'inference', 'benchmark', 'maintenance', 'sync', 'diagnostics', 'scanning', 'cleanup', 'ingestion', 'backup'];
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ia = groupOrder.indexOf(a), ib = groupOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  let html = '<div class="cs-heatmap-grid">';
  // Header
  html += '<div class="cs-hm-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="cs-hm-header">${String(h).padStart(2, '0')}</div>`;
  }

  for (const groupKey of sortedKeys) {
    const entries = groups[groupKey];
    const isCollapsed = collapsedGroups.has(groupKey);
    const toggleIcon = isCollapsed ? 'collapsed' : '';
    const color = TASK_COLORS[groupKey] || '#666';

    const gpuCount = entries.filter(e => e.model).length;
    const infraCount = entries.length - gpuCount;
    const countLabel = gpuCount > 0
      ? `${gpuCount} AI job${gpuCount !== 1 ? 's' : ''}${infraCount > 0 ? `, ${infraCount} sys` : ''}`
      : `${infraCount} sys job${infraCount !== 1 ? 's' : ''}`;
    html += `<div class="cs-group-header" onclick="toggleGroup('${groupKey}')">
      <i class="fas fa-caret-down toggle ${toggleIcon}"></i>
      <span style="color:${color}">${(groupKey).toUpperCase()}</span>
      <span class="cs-group-count">${countLabel}</span>
    </div>`;

    for (const entry of entries) {
      const hiddenClass = isCollapsed ? ' cs-group-hidden' : '';
      const isInfra = isNoGpuTaskEntry(entry);
      const infraClass = isInfra ? ' cs-hm-label-infra' : '';
      const hostMeta = getHostMeta(entry.host);
      const hostLabel = hostMeta ? hostMeta.label : '';

      const cadence = getCadenceLabel(entry);
      html += `<div class="cs-hm-label${hiddenClass}${infraClass}" title="${esc(entry.name)}${isInfra ? ' [no GPU — infra task]' : ''}${hostLabel ? ' · ' + hostLabel : ''}${cadence ? ' · ' + cadence : ''}">
        <span class="cs-label-name">${esc(entry.name)}</span>
        ${cadence ? `<span class="cs-cadence-pill">${cadence}</span>` : ''}
        ${hostLabel ? `<span class="cs-host-tag ${hostMeta.id}">${esc(hostLabel)}</span>` : ''}
        ${entry.source === 'openclaw' && entry.metadata ? `
          <div class="schedule-openclaw-meta" style="margin-top: 8px; font-size: 0.75rem; color: var(--muted, #888); line-height: 1.6;">
            ${entry.metadata.payloadPreview ? `<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px;" title="${esc(entry.metadata.payloadPreview)}"><i class="fas fa-quote-left" style="margin-right: 4px; opacity: 0.5;"></i>${esc(entry.metadata.payloadPreview)}</div>` : ''}
            ${entry.metadata.lastStatus ? `<div><i class="fas ${entry.metadata.lastStatus === 'ok' ? 'fa-check-circle' : 'fa-exclamation-triangle'}" style="margin-right: 4px; color: ${entry.metadata.lastStatus === 'ok' ? '#22c55e' : '#ef4444'};"></i>Last: ${esc(entry.metadata.lastStatus)}</div>` : ''}
            ${entry.metadata.consecutiveErrors > 0 ? `<div style="color: #ef4444;"><i class="fas fa-exclamation-circle" style="margin-right: 4px;"></i>${entry.metadata.consecutiveErrors} consecutive errors</div>` : ''}
            ${entry.metadata.nextRunAtMs ? `<div><i class="fas fa-clock" style="margin-right: 4px; opacity: 0.5;"></i>Next: ${new Date(entry.metadata.nextRunAtMs).toLocaleString()}</div>` : ''}
          </div>
        ` : ''}
      </div>`;

      for (let h = 0; h < 24; h++) {
        const pastClass = isToday() && h < currentHour ? ' past' : '';
        const slotsHtml = getSlotSegments(entry.slots, h, h + 1, entry.taskType, entry.name, isInfra, { host: entry.host, source: entry.source, model: entry.model, estimatedDurationMs: entry.estimatedDurationMs, vramMb: entry.vramMb });
        html += `<div class="cs-hm-cell${pastClass}${hiddenClass}" data-hour="${h}" data-name="${esc(entry.name)}" data-type="${entry.taskType}">${slotsHtml}</div>`;
      }
    }
  }

  html += '</div>';

  // Now line
  if (isToday() && currentHour >= 0) {
    const gridCols = 25; // 1 label + 24 hours
    const labelWidthPx = 230;
    const nowPct = ((currentHour + nowMinuteFrac) / 24) * 100;
    html += `<div class="cs-now-line" style="left:calc(${labelWidthPx}px + ${nowPct}% * (100% - ${labelWidthPx}px) / 100%)"></div>`;
  }

  container.innerHTML = html;

  // Position now line precisely using JS after render
  if (isToday()) positionNowLine(container);
  attachTooltipEvents(container);
}

function positionNowLine(container) {
  const grid = container.querySelector('.cs-heatmap-grid');
  if (!grid) return;
  const nowFrac = (new Date().getHours() + new Date().getMinutes() / 60) / 24;
  const gridRect = grid.getBoundingClientRect();
  // First column is the label column (200px)
  const firstCell = grid.querySelector('.cs-hm-cell');
  if (!firstCell) return;
  const cellsStart = firstCell.getBoundingClientRect().left - gridRect.left;
  const cellsWidth = gridRect.width - cellsStart;
  const lineLeft = cellsStart + cellsWidth * nowFrac;

  const now = new Date();
  const nowTimeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let line = container.querySelector('.cs-now-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'cs-now-line';
    container.appendChild(line);
  }
  line.innerHTML = `<span class="cs-now-label">${nowTimeStr}</span>`;
  line.style.left = lineLeft + 'px';
  line.style.top = '0';
  line.style.height = grid.offsetHeight + 'px';
}

function toggleGroup(groupKey) {
  if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
  else collapsedGroups.add(groupKey);
  loadTimeline();
}

// ── Host Gantt View ─────────────────────────────────────────

function renderHostHeatmap(container, hosts) {
  if (!hosts || hosts.length === 0) {
    container.innerHTML = '<div class="cs-empty">No hosts configured</div>';
    return;
  }
  const currentHour = isToday() ? new Date().getHours() : -1;

  let html = '<div class="cs-heatmap-grid">';
  html += '<div class="cs-hm-header"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="cs-hm-header">${String(h).padStart(2, '0')}</div>`;
  }

  for (const host of hosts) {
    const vramInfo = host.vramCapacityMb ? `${(host.vramCapacityMb / 1024).toFixed(0)} GB` : '';
    html += `<div class="cs-host-row-label"><i class="fas fa-server" style="color:#7cf0ff;font-size:10px"></i> ${esc(host.hostName)} ${vramInfo ? `<span class="cs-vram-info">${vramInfo}</span>` : ''}</div>`;

    for (let h = 0; h < 24; h++) {
      const pastClass = isToday() && h < currentHour ? ' past' : '';
      let slotsHtml = '';
      for (const task of host.tasks) {
        slotsHtml += getSlotSegments(task.slots, h, h + 1, task.taskType, task.name, false, { host: host.hostId || host.hostName, source: task.source, model: task.model, estimatedDurationMs: task.estimatedDurationMs, vramMb: task.vramMb });
      }
      html += `<div class="cs-hm-cell${pastClass}" data-hour="${h}" data-name="${esc(host.hostName)}" data-type="host">${slotsHtml}</div>`;
    }
  }

  html += '</div>';
  container.innerHTML = html;
  if (isToday()) positionNowLine(container);
  attachTooltipEvents(container);
}

// ── Slot Rendering ──────────────────────────────────────────

function getSlotSegments(slots, hourStart, hourEnd, taskType, taskName, isInfra = false, meta = {}) {
  if (!slots || slots.length === 0) return '';
  taskName = taskName || taskType;
  let html = '';
  for (const slot of slots) {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    const slotStartHour = slotStart.getHours() + slotStart.getMinutes() / 60;
    const slotEndHour = slotEnd.getHours() + slotEnd.getMinutes() / 60 + (slotEnd.getDate() !== slotStart.getDate() ? 24 : 0);
    if (slotEndHour <= hourStart || slotStartHour >= hourEnd) continue;
    const visStart = Math.max(slotStartHour - hourStart, 0);
    const visEnd = Math.min(slotEndHour - hourStart, 1);
    const left = (visStart * 100).toFixed(1);
    const width = ((visEnd - visStart) * 100).toFixed(1);
    const contClass = slot.continuous ? ' continuous' : '';
    const infraClass = isInfra ? ' infra' : '';
    html += `<div class="cs-hm-slot ${taskType}${contClass}${infraClass}"
      style="left:${left}%;width:${width}%"
      data-tt-name="${esc(taskName)}"
      data-tt-type="${esc(taskType)}"
      data-tt-time="${esc(formatTime(slotStart))}–${esc(formatTime(slotEnd))}"
      data-tt-host="${esc(meta.host || '')}"
      data-tt-source="${esc(meta.source || '')}"
      data-tt-model="${esc(meta.model || '')}"
      data-tt-duration="${meta.estimatedDurationMs || 0}"
      data-tt-vram="${meta.vramMb || 0}"
      data-tt-infra="${isInfra ? '1' : '0'}"></div>`;
  }
  return html;
}

function getHostMeta(hostId) {
  if (!hostId) return { id: 'unassigned', label: 'Infra / Shared', color: '#94a3b8' };
  const index = Math.abs([...String(hostId)].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % HOST_COLORS.length;
  const live = liveHostsData.find(host => host.id === hostId);
  return { id: hostId, label: live?.name || hostId, color: HOST_COLORS[index] };
}

function getSourceMeta(sourceId) {
  if (!sourceId) return { label: 'Unknown', color: '#64748b' };
  return SOURCE_META[sourceId] || { label: sourceId, color: '#64748b' };
}

// ── Conflicts ───────────────────────────────────────────────

async function loadConflicts() {
  const banner = document.getElementById('conflictBanner');
  const text = document.getElementById('conflictText');
  try {
    const data = await fetchJSON(`${API_BASE}/schedule/conflicts?date=${currentDate}`);
    conflictsData = data.conflicts || [];
    if (conflictsData.length > 0) {
      const summaries = conflictsData.map(c => `${c.taskA.name} + ${c.taskB.name} on ${c.hostId}`);
      const unique = [...new Set(summaries)];
      text.textContent = `${data.count} conflict${data.count > 1 ? 's' : ''}: ${unique.slice(0, 3).join('; ')}${unique.length > 3 ? ` (+${unique.length - 3} more)` : ''}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    renderAttention();
  } catch { banner.classList.add('hidden'); renderAttention(); }
}

async function loadClaims() {
  const container = document.getElementById('claimsList');
  if (!container) return;

  try {
    const data = await fetchJSON(`${API_BASE}/schedule/claims`);
    claimsData = data.claims || [];
    renderClaims(container);
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

// ── Attention Tab ───────────────────────────────────────────

function renderAttention() {
  const container = document.getElementById('attentionList');
  const items = [];

  // Conflicts
  for (const c of conflictsData) {
    items.push({ type: 'error', icon: 'fa-bolt', label: 'Schedule conflict',
      detail: `${c.taskA.name} overlaps ${c.taskB.name} on ${c.hostId}` });
  }

  // Down hosts (from live bar data)
  document.querySelectorAll('.cs-host-card.down').forEach(card => {
    const name = card.querySelector('.cs-host-name')?.textContent || 'Host';
    items.push({ type: 'error', icon: 'fa-server', label: `${name} unreachable`, detail: 'Host is not responding to Ollama API polling' });
  });

  // Tasks showing "Now" in next up = possibly overdue
  for (const t of nextTasksData) {
    if (t.msFromNow <= 0) {
      items.push({ type: 'warn', icon: 'fa-clock', label: `${t.name} overdue`, detail: `Was expected to run — may be stale or stuck` });
    }
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div style="padding:12px 4px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <i class="fas fa-check-circle" style="color:#22c55e;font-size:16px"></i>
          <span style="font-size:13px;font-weight:600;color:#22c55e">No issues detected</span>
        </div>
        <div style="font-size:11px;color:#374151;display:flex;flex-direction:column;gap:4px">
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>0 schedule conflicts</div>
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>0 overdue tasks</div>
          <div><i class="fas fa-check" style="color:#374151;margin-right:6px;font-size:9px"></i>All reachable hosts online</div>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = items.map(it => `
    <div class="cs-attn-item${it.type === 'warn' ? ' warn' : ''}">
      <span class="cs-attn-icon"><i class="fas ${it.icon}"></i></span>
      <span class="cs-attn-label">${esc(it.label)}</span>
      <div class="cs-attn-detail">${esc(it.detail)}</div>
    </div>
  `).join('');
}

function renderClaims(container) {
  if (!claimsData.length) {
    container.innerHTML = `
      <div class="cs-empty cs-claims-empty">
        <i class="fas fa-feather-pointed"></i>
        <div>No live soft claims</div>
        <div class="cs-claims-empty-note">Scheduler advisory reservations will appear here when consumers request placement.</div>
      </div>`;
    return;
  }

  const sortedClaims = [...claimsData].sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
  container.innerHTML = sortedClaims.map((claim) => {
    const hostMeta = getHostMeta(claim.host);
    const ttlMs = Math.max(new Date(claim.expiresAt).getTime() - Date.now(), 0);
    return `
      <div class="cs-claim-item">
        <div class="cs-claim-header">
          <span class="cs-host-tag ${hostMeta.id}">${esc(hostMeta.label)}</span>
          <span class="cs-claim-expiry">${formatCountdown(ttlMs)}</span>
        </div>
        <div class="cs-claim-model">${esc(claim.model || 'Unknown model')}</div>
        <div class="cs-claim-meta">
          <span><i class="fas fa-user-clock"></i> ${esc(claim.caller || 'unknown')}</span>
          <span><i class="fas fa-hourglass-half"></i> until ${esc(formatClockTime(claim.expiresAt))}</span>
        </div>
      </div>`;
  }).join('');
}

// ── Tooltip ─────────────────────────────────────────────────

function attachTooltipEvents(container) {
  container.querySelectorAll('.cs-hm-slot').forEach(el => {
    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('mousemove', moveTooltip);
  });
}
function showTooltip(e) {
  const d = e.target.dataset;
  const name    = d.ttName || '';
  const type    = d.ttType || '';
  const time    = d.ttTime || '';
  const host    = d.ttHost || '';
  const source  = d.ttSource || '';
  const model   = d.ttModel || '';
  const dur     = parseInt(d.ttDuration || '0');
  const vram    = parseInt(d.ttVram || '0');
  const isInfra = d.ttInfra === '1';

  const hostLabel  = host   ? (getHostMeta(host).label   || host)   : '';
  const sourceLabel = source ? (getSourceMeta(source).label || source) : '';

  const rows = [];
  if (time)        rows.push(row('fa-clock',      time,        ''));
  if (hostLabel)   rows.push(row('fa-server',     hostLabel,   ''));
  if (sourceLabel) rows.push(row('fa-tag',        sourceLabel, ''));
  if (model)       rows.push(row('fa-microchip',  model,       'hi'));
  if (dur > 0)     rows.push(row('fa-hourglass-half', '~' + formatDuration(dur), ''));
  if (vram > 0)    rows.push(row('fa-memory',     (vram / 1024).toFixed(1) + ' GB VRAM', 'warn'));
  if (isInfra)     rows.push(row('fa-cog',        'no GPU — infra task', 'dim'));

  const typeColor = TASK_COLORS[type] || '#64748b';
  document.getElementById('tooltipType').innerHTML =
    type ? `<span style="color:${typeColor}">${type.toUpperCase()}</span>` : '';
  document.getElementById('tooltipName').textContent = name;
  document.getElementById('tooltipRows').innerHTML = rows.join('');
  document.getElementById('tooltip').classList.add('visible');
}

function row(icon, text, cls) {
  return `<div class="cs-tooltip-row"><i class="fas ${icon}"></i><span class="${cls}">${esc(text)}</span></div>`;
}

function hideTooltip() { document.getElementById('tooltip').classList.remove('visible'); }
function moveTooltip(e) {
  const t = document.getElementById('tooltip');
  const margin = 12;
  let left = e.clientX + 14;
  let top  = e.clientY - 10;
  if (left + 310 > window.innerWidth) left = e.clientX - 320;
  if (top  + 200 > window.innerHeight) top = e.clientY - 160;
  t.style.left = left + 'px';
  t.style.top  = top  + 'px';
}

// ── Next Up ─────────────────────────────────────────────────

async function loadNextTasks() {
  const container = document.getElementById('nextList');
  nextTasksData = buildUpcomingTasksFromTimeline(upcomingTimelineEntries);
  renderNextTasks(container);
  startCountdown();
}

function renderNextTasks(container) {
  if (nextTasksData.length === 0) {
    container.innerHTML = '<div class="cs-empty">No upcoming tasks</div>';
    return;
  }

  // Split: system ticks (high-frequency interval pollers < 1h) vs scheduled jobs (cron or long interval)
  const sysTasks = nextTasksData.filter(t => isServiceTick(t));
  const scheduledTasks = nextTasksData.filter(t => !isServiceTick(t));

  let html = '';

  if (scheduledTasks.length > 0) {
    html += `<div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.06em;padding:2px 0 6px">Scheduled Jobs <span style="font-weight:400;color:#64748b">${scheduledTasks.length}</span></div>`;
    html += scheduledTasks.map((task, i) => renderNextItem(task, i)).join('');
  }

  if (sysTasks.length > 0) {
    const due = sysTasks.filter(t => t.msFromNow <= 0).length;
    const dueSoon = sysTasks.filter(t => t.msFromNow > 0 && t.msFromNow < 300000).length;
    html += `<div style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.06em;padding:8px 0 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.05)">
      System Ticks
      <span style="color:#64748b;font-weight:400;font-size:9px"> ${sysTasks.length}</span>
      ${due > 0 ? `<span style="color:#94a3b8;font-weight:400;font-size:9px"> · ${due} due now</span>` : ''}
      ${dueSoon > 0 ? `<span style="color:#94a3b8;font-weight:400;font-size:9px"> · ${dueSoon} in &lt;5m</span>` : ''}
    </div>`;
    html += sysTasks.map((task, i) => renderNextItem(task, scheduledTasks.length + i)).join('');
  }

  container.innerHTML = html || '<div class="cs-empty">No upcoming tasks</div>';
}

function renderNextItem(task, i) {
  const sourceMeta = getSourceMeta(task.source);
  const sourceClass = task.source || 'openclaw';
  const hostLabel = task.host ? getHostMeta(task.host).label : '';
  const cadenceLabel = isServiceTick(task) ? `every ${formatInterval(task.intervalMs)}` : '';
  return `
    <div class="cs-next-item">
      <div style="min-width:0;flex:1">
        <div class="cs-next-name">${esc(task.name)}</div>
        <div class="cs-next-meta">
          <span class="cs-task-badge ${task.taskType}">${task.taskType}</span>
          ${hostLabel ? `<span style="font-size:10px"><i class="fas fa-server" style="font-size:8px;margin-right:2px"></i>${esc(hostLabel)}</span>` : ''}
          <span class="cs-source-chip ${sourceClass}">${esc(sourceMeta.label)}</span>
          ${cadenceLabel ? `<span class="cs-source-chip cadence">${esc(cadenceLabel)}</span>` : ''}
        </div>
      </div>
      <div class="cs-next-countdown" id="countdown-${i}">${formatUpcomingDisplay(task)}</div>
    </div>`;
}

function formatClockTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const startedAt = Date.now();
  countdownTimer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    nextTasksData.forEach((task, i) => {
      const el = document.getElementById(`countdown-${i}`);
      if (!el) return;
      if (task.displayMode === 'time') {
        el.textContent = task.displayText || '';
        return;
      }
      el.textContent = formatCountdown(Math.max(0, task.msFromNow - elapsed));
    });
  }, COUNTDOWN_TICK_MS);
}

function buildUpcomingTasksFromTimeline(entries) {
  const now = Date.now();
  const todaySelected = isToday();
  const occurrences = [];

  for (const entry of (entries || [])) {
    const slots = entry.slots || [];
    for (const slot of slots) {
      const startMs = new Date(slot.start).getTime();
      const endMs = new Date(slot.end).getTime();
      if (todaySelected && endMs < now) continue;

      const dailyCount = slots.length;
      const msFromNow = todaySelected ? Math.max(0, startMs - now) : Math.max(0, startMs - now);
      occurrences.push({
        id: `${entry.id || entry.name}-${slot.start}`,
        name: entry.name,
        source: entry.source,
        taskType: entry.taskType,
        host: entry.host,
        model: entry.model,
        priority: entry.priority,
        scheduleType: entry.scheduleType || (dailyCount > 1 ? 'cron' : null),
        intervalMs: deriveIntervalMs(entry, slot),
        dailyCount,
        nextRun: slot.start,
        msFromNow,
        displayMode: todaySelected ? 'countdown' : 'time',
        displayText: formatTime(new Date(slot.start))
      });
    }
  }

  occurrences.sort((a, b) => {
    if (a.msFromNow !== b.msFromNow) return a.msFromNow - b.msFromNow;
    return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime();
  });

  return occurrences.slice(0, 25);
}

function deriveIntervalMs(entry, slot) {
  if (entry?.scheduleType === 'interval' && entry.intervalMs) return entry.intervalMs;
  const slots = entry?.slots || [];
  if (slots.length > 1) {
    const first = new Date(slots[0].start).getTime();
    const second = new Date(slots[1].start).getTime();
    const delta = second - first;
    if (delta > 0) return delta;
  }
  if (slot?.start && slot?.end) {
    const span = new Date(slot.end).getTime() - new Date(slot.start).getTime();
    if (span > 0) return span;
  }
  return null;
}

function formatUpcomingDisplay(task) {
  if (task.displayMode === 'time') return task.displayText || '';
  return formatCountdown(task.msFromNow);
}

// ── Utilities ───────────────────────────────────────────────

function esc(s) {
  return window.AgentXUtils.escapeHtml(s);
}
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatDuration(ms) {
  if (!ms || ms <= 0) return 'n/a';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m > 0 ? m + 'm' : ''}`.trim();
  if (m > 0) return `${m}m`;
  if (s > 0) return `${s}s`;
  return `${Math.round(ms / 60000)}m`;
}
function formatInterval(ms) {
  if (!ms || ms <= 0) return '?';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Derive a short cadence label from slot count for timeline row labels
function getCadenceLabel(entry) {
  const n = entry.slots?.length || 0;
  if (n === 0) return '';
  if (n === 1 && entry.slots[0]?.continuous) return '24/7';
  if (n >= 1000) return 'q1m';   // every minute or faster
  if (n >= 200)  return 'q5m';   // every ~5 min
  if (n >= 80)   return 'q10m';  // every ~10 min
  if (n >= 40)   return 'q15m';  // every ~15 min
  if (n >= 26)   return 'q30m';  // every ~30 min
  if (n >= 20)   return 'hrly';  // roughly hourly (20-25/day)
  if (n >= 11)   return 'q2h';   // every ~2 hours (12/day)
  if (n >= 6)    return 'q4h';   // every ~4 hours
  if (n >= 3)    return 'q8h';   // every ~8 hours
  if (n === 2)   return '2×/d';
  if (n === 1) {
    // Show start time for single daily jobs
    try {
      const t = new Date(entry.slots[0].start);
      return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    } catch { return 'daily'; }
  }
  return `${n}×/d`;
}

// Service tick = mirrors splitTimeline threshold: short interval OR >12 runs/day
// Consistent with what goes into the background services strip (slots.length > 12)
function isServiceTick(task) {
  if (!task) return false;
  if (task.scheduleType === 'interval' && task.intervalMs && task.intervalMs < 3600000) return true;
  if (task.dailyCount && task.dailyCount > 12) return true;
  return false;
}

// ── Actual Utilization ──────────────────────────────────────

function setActualView(mode) {
  actualView = mode;
  document.getElementById('btnHeatmap').classList.toggle('active', mode === 'heatmap');
  document.getElementById('btnAvp').classList.toggle('active', mode === 'avp');
  if (mode === 'heatmap') loadActualHeatmap();
  else loadActualVsPlanned();
}

function actualViewChanged() {
  if (actualView === 'heatmap') loadActualHeatmap();
  else loadActualVsPlanned();
}

// Utilization colour ramp: 0% → dim, 1-20% → green, 20-50% → lime, 50-75% → amber, 75-90% → orange, 90%+ → red
function utilColor(pct) {
  if (pct <= 0) return 'rgba(255,255,255,0.04)';
  if (pct < 20)  return '#22c55e';
  if (pct < 50)  return '#84cc16';
  if (pct < 75)  return '#f59e0b';
  if (pct < 90)  return '#f97316';
  return '#ef4444';
}

function renderUtilLegend() {
  const bar = document.getElementById('utilLegendBar');
  if (!bar) return;
  const legend = document.getElementById('utilLegend');
  legend.style.display = 'flex';
  const stops = [0, 10, 25, 45, 65, 80, 95];
  bar.innerHTML = stops.map(p => {
    const c = utilColor(p);
    const op = p === 0 ? 0.15 : 0.2 + (p / 100) * 0.8;
    return `<div class="cs-util-swatch" style="background:${c};opacity:${op.toFixed(2)}" title="${p}%"></div>`;
  }).join('');
}

async function loadActualHeatmap() {
  const days = parseInt(document.getElementById('heatmapDays')?.value || '7', 10);
  const container = document.getElementById('actualContent');
  container.innerHTML = '<div class="cs-loading"><i class="fas fa-spinner fa-spin"></i> Loading heatmap...</div>';
  try {
    const res = await fetch(`${API_BASE}/schedule/heatmap?days=${days}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error || 'API error');
    renderUtilHeatmap(container, json.data);
    renderUtilLegend();
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
    document.getElementById('utilLegend').style.display = 'none';
  }
}

function renderUtilHeatmap(container, data) {
  // data: { hosts: string[], days: string[], grid: { [host]: number[][] } }
  const { hosts = [], days = [], grid = {} } = data;
  if (!hosts.length || !days.length) {
    container.innerHTML = '<div class="cs-empty">No utilization data yet — inference calls will populate this automatically</div>';
    return;
  }

  let html = '';
  for (const host of hosts) {
    const rows = grid[host] || [];
    if (!rows.length) continue;

    // grid is days-major, hours-minor: rows[dayIdx][hourIdx]
    html += `<div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:600;color:#fff;margin-bottom:8px">
        <i class="fas fa-server" style="color:#7cf0ff;margin-right:6px;font-size:10px"></i>${esc(host)}
      </div>
      <div style="overflow-x:auto">
        <div class="cs-util-grid" style="grid-template-columns:70px repeat(24,1fr);min-width:640px;gap:2px">`;

    // Header: hour labels
    html += '<div class="cs-util-h-label"></div>';
    for (let h = 0; h < 24; h++) {
      html += `<div class="cs-util-h-label">${String(h).padStart(2, '0')}</div>`;
    }

    // Rows: one per day
    for (let di = 0; di < days.length; di++) {
      const dateLabel = new Date(days[di] + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      html += `<div class="cs-util-label-cell">${dateLabel}</div>`;
      const hourRow = rows[di] || new Array(24).fill(0);
      for (let h = 0; h < 24; h++) {
        const pct = hourRow[h] || 0;
        const color = utilColor(pct);
        const opacity = pct <= 0 ? 0.06 : Math.max(0.2, pct / 100);
        html += `<div class="cs-util-cell" style="background:${color};opacity:${opacity.toFixed(2)}"
          title="${dateLabel} ${String(h).padStart(2, '0')}:00 — ${pct.toFixed(0)}% utilization"></div>`;
      }
    }

    html += '</div></div></div>';
  }

  container.innerHTML = html || '<div class="cs-empty">No utilization data yet</div>';
}

async function loadActualVsPlanned() {
  const container = document.getElementById('actualContent');
  document.getElementById('utilLegend').style.display = 'none';
  container.innerHTML = '<div class="cs-loading"><i class="fas fa-spinner fa-spin"></i> Loading actual vs planned...</div>';
  try {
    const res = await fetch(`${API_BASE}/schedule/actual-vs-planned?date=${currentDate}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error || 'API error');
    renderActualVsPlanned(container, json.data);
  } catch (err) {
    container.innerHTML = `<div class="cs-empty"><i class="fas fa-exclamation-triangle"></i> ${esc(err.message)}</div>`;
  }
}

function renderActualVsPlanned(container, data) {
  const { planned = [], actualByHost = {} } = data;

  if (!planned.length && !Object.keys(actualByHost).length) {
    container.innerHTML = '<div class="cs-empty">No data for this date</div>';
    return;
  }

  let html = '';
  const HOUR_PCT = (1 / 24 * 100).toFixed(3);

  const renderTrack = (hostName, tasks, actualRows) => {
    const actualMap = {};
    for (const r of (actualRows || [])) actualMap[r.hour] = r;

    html += `<div class="cs-avp-host">
      <div class="cs-avp-host-label">
        <i class="fas fa-server" style="color:#7cf0ff;font-size:10px"></i>
        ${esc(hostName)}
        ${tasks.length ? `<span style="font-size:10px;color:#475569;font-weight:400">${tasks.length} planned task${tasks.length > 1 ? 's' : ''}</span>` : '<span style="font-size:10px;color:#f59e0b;font-weight:400">actual only</span>'}
      </div>
      <div class="cs-avp-track">`;

    // Grid lines at 0, 6, 12, 18, 24h
    for (let h = 0; h <= 24; h += 6) {
      const left = (h / 24 * 100).toFixed(2);
      html += `<div class="cs-avp-gridline" style="left:${left}%"></div>`;
      if (h < 24) html += `<div class="cs-avp-hour-label" style="left:calc(${left}% + 2px)">${String(h).padStart(2, '0')}</div>`;
    }

    // Actual utilization bars — bottom 50%, per-hour
    for (let h = 0; h < 24; h++) {
      const a = actualMap[h];
      if (!a || !a.utilizationPct) continue;
      const left = (h / 24 * 100).toFixed(3);
      const color = utilColor(a.utilizationPct);
      const heightPct = Math.max(5, a.utilizationPct / 2); // max 50% of track height
      html += `<div class="cs-avp-actual" style="left:${left}%;width:${HOUR_PCT}%;height:${heightPct.toFixed(1)}%;background:${color};opacity:0.4"
        title="${String(h).padStart(2, '0')}:00 actual ${a.utilizationPct.toFixed(0)}% (${a.totalCalls || 0} calls)"></div>`;
    }

    // Planned task slots — top area
    for (const task of tasks) {
      for (const slot of (task.slots || [])) {
        const s = new Date(slot.start);
        const e = new Date(slot.end);
        const startHour = s.getHours() + s.getMinutes() / 60;
        const endHour   = e.getHours() + e.getMinutes() / 60;
        const left  = (startHour / 24 * 100).toFixed(2);
        const width = Math.max((endHour - startHour) / 24 * 100, 0.4).toFixed(2);
        const color = TASK_COLORS[task.taskType] || '#666';
        html += `<div class="cs-avp-planned" style="left:${left}%;width:${width}%;top:6px;height:36%;background:${color}"
          title="${esc(task.name)} ${formatTime(s)}–${formatTime(e)}"></div>`;
      }
    }

    html += '</div></div>';
  };

  // Render planned hosts
  const plannedHostNames = new Set();
  for (const host of planned) {
    plannedHostNames.add(host.hostName);
    renderTrack(host.hostName, host.tasks || [], actualByHost[host.hostName] || []);
  }

  // Render actual-only hosts
  for (const [hostName, rows] of Object.entries(actualByHost)) {
    if (plannedHostNames.has(hostName)) continue;
    if (!rows.some(r => r.utilizationPct > 0)) continue;
    renderTrack(hostName, [], rows);
  }

  // Legend
  html += `<div class="cs-avp-legend">
    <div style="display:flex;align-items:center;gap:4px"><div class="cs-avp-legend-swatch" style="background:#7cf0ff;opacity:0.7"></div>Planned slot</div>
    <div style="display:flex;align-items:center;gap:4px"><div class="cs-avp-legend-swatch" style="background:#22c55e;opacity:0.5"></div>Actual utilization</div>
  </div>`;

  container.innerHTML = html || '<div class="cs-empty">No data for this date</div>';
}

// ── Init / Refresh ──────────────────────────────────────────

async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  const icon = btn.querySelector('i');
  icon.classList.add('spinning');
  try {
    await Promise.all([
      loadLiveState(), loadTimeline(), loadConflicts(), loadClaims(),
      actualView === 'heatmap' ? loadActualHeatmap() : loadActualVsPlanned()
    ]);
  } finally { icon.classList.remove('spinning'); }
}

function startLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(() => {
    loadLiveState();
    loadClaims();
  }, LIVE_POLL_MS);
}

document.addEventListener('DOMContentLoaded', () => {
  updateDateLabel();
  syncTimelineFilterUI();
  refreshAll();
  startLivePolling();
});

document.addEventListener('click', (e) => {
  const popover = document.getElementById('servicePopover');
  if (!popover || !popover.classList.contains('visible') || !servicePopoverPinnedId) return;
  if (e.target.closest('.cs-service-chip') || e.target.closest('#servicePopover')) return;
  hideServicePopover(true);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideServicePopover(true);
});

window.addEventListener('resize', () => {
  if (!servicePopoverPinnedId) return;
  const activeChip = document.querySelector(`.cs-service-chip[data-service-id="${servicePopoverPinnedId}"]`);
  if (activeChip) positionServicePopover(activeChip);
});

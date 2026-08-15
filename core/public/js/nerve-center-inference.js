(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    let _poller = null;
    let throughputChart = null;
    let latencyChart = null;

    const HOST_LABELS = {};
    const HOST_COLORS = {};

    function formatTaskLabel(task, metadata = {}) {
        return metadata.title || task.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
    }

    // ── Panel 1: Task Routing Table ────────────────────────────────────

    function isDefault(model, host, hosts) {
        const hostEntry = hosts?.[host];
        if (!hostEntry) return false;
        // hosts may be { key: urlString } or { key: { url, pinnedModels } }.
        // pinnedModels is a string[] of model names in this response shape
        // (see routes/nerve-center.js getInferenceRoutingConfig).
        const defaults = typeof hostEntry === 'object' ? (hostEntry.pinnedModels || []) : [];
        return defaults.includes(model);
    }

    function buildTaskRoutingTable(config) {
        const taskModels = config.taskModels || {};
        const hosts = config.hosts || {};
        const entries = Object.entries(taskModels);

        if (entries.length === 0) {
            return '<div class="nc-muted nc-td-p12">No task routing configured.</div>';
        }

        const rows = entries.map(([task, entry]) => {
            const model = entry.model || '--';
            const host = entry.host || '--';
            const metadata = config.taskMetadata?.[task] || {};
            const isDefaultModel = isDefault(model, host, hosts);
            const statusHtml = isDefaultModel
                ? '<span style="color:#4ade80">● default</span>'
                : '<span style="color:#f59e0b">● dynamic</span>';

            return `
                <tr data-task="${shared.escapeHtml(task)}">
                    <td style="padding:8px 10px;font-weight:600;" title="${shared.escapeHtml(metadata.description || '')}">${shared.escapeHtml(formatTaskLabel(task, metadata))}</td>
                    <td class="nc-td-md nc-inf-task-model">
                        <span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model))}</span>
                    </td>
                    <td class="nc-td-md nc-inf-task-host">
                        <span style="font-weight:600;text-transform:uppercase;">${shared.escapeHtml(host)}</span>
                    </td>
                    <td class="nc-td-md">${statusHtml}</td>
                    <td style="padding:8px 10px;text-align:center;">
                        <button class="nc-btn nc-inf-task-edit" data-task="${shared.escapeHtml(task)}" style="font-size:10px;padding:3px 10px;">
                            <i class="fas fa-pen"></i> Edit
                        </button>
                    </td>
                </tr>`;
        }).join('');

        return `
            <table class="nc-table" id="nc-inference-routing-table">
                <thead>
                    <tr>
                        <th>Task Type</th>
                        <th>Model</th>
                        <th>Host</th>
                        <th>Status</th>
                        <th style="text-align:center;width:80px;"></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    function attachTaskEditHandlers(config) {
        const hosts = config.hosts || {};
        const hostKeys = shared.sortHostKeys(Object.keys(hosts).filter(k => hosts[k]));
        const knownModels = getKnownModels(config);

        document.querySelectorAll('.nc-inf-task-edit').forEach(button => {
            button.addEventListener('click', () => {
                const task = button.dataset.task;
                const row = button.closest('tr');
                if (!row || row.dataset.editing === 'true') return;
                row.dataset.editing = 'true';

                const current = config.taskModels?.[task] || { model: '', host: '' };
                const modelCell = row.querySelector('.nc-inf-task-model');
                const hostCell = row.querySelector('.nc-inf-task-host');
                const actionCell = button.parentElement;

                let modelOptions = knownModels.map(m =>
                    `<option value="${shared.escapeHtml(m)}" ${m === current.model ? 'selected' : ''}>${shared.escapeHtml(shared.shortModel(m))}</option>`
                ).join('');
                if (current.model && !knownModels.includes(current.model)) {
                    modelOptions = `<option value="${shared.escapeHtml(current.model)}" selected>${shared.escapeHtml(shared.shortModel(current.model))}</option>${modelOptions}`;
                }

                modelCell.innerHTML = `<select class="nc-inline-select" data-field="model">${modelOptions}</select>`;
                hostCell.innerHTML = `
                    <select class="nc-inline-select" data-field="host">
                        ${hostKeys.map(k => `<option value="${k}" ${k === current.host ? 'selected' : ''}>${k.toUpperCase()}</option>`).join('')}
                    </select>`;
                actionCell.innerHTML = `
                    <button class="nc-btn nc-inf-task-save" data-task="${shared.escapeHtml(task)}" style="font-size:10px;padding:3px 8px;margin-right:4px;">
                        <i class="fas fa-check"></i>
                    </button>
                    <button class="nc-btn nc-inf-task-cancel" style="font-size:10px;padding:3px 8px;border-color:rgba(248,113,113,0.3);color:#f87171;background:rgba(248,113,113,0.08);">
                        <i class="fas fa-times"></i>
                    </button>`;

                actionCell.querySelector('.nc-inf-task-save').addEventListener('click', async () => {
                    const newModel = modelCell.querySelector('select').value;
                    const newHost = hostCell.querySelector('select').value;
                    try {
                        const data = await shared.fetchJson(`/api/nerve-center/inference/routing-config/${encodeURIComponent(task)}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model: newModel, host: newHost })
                        });
                        if (data.status === 'success') {
                            Toast.success(`Updated ${formatTaskLabel(task, config.taskMetadata?.[task] || {})} routing`);
                            await loadInference();
                        } else {
                            Toast.error(data.message || 'Update failed');
                        }
                    } catch (err) {
                        Toast.error(`Failed to save: ${err.message}`);
                    }
                });

                actionCell.querySelector('.nc-inf-task-cancel').addEventListener('click', () => {
                    loadInference();
                });
            });
        });
    }

    function getKnownModels(config) {
        const known = new Set();
        Object.values(config.taskModels || {}).forEach(entry => {
            if (entry?.model) known.add(entry.model);
        });
        return [...known].sort();
    }

    // ── Panel 2: Inference Activity Feed ───────────────────────────────

    function buildActivityStats(stats) {
        const total = stats?.total ?? '--';
        const latency = stats?.avgLatencyMs != null ? Math.round(stats.avgLatencyMs) : '--';
        const errorRate = stats?.errorRate != null ? stats.errorRate.toFixed(1) : '--';

        return `
            <div class="nc-inference-stats" style="display:flex;gap:24px;margin-bottom:12px">
                <div><span class="nc-muted">Last hour:</span> <strong id="nc-inf-total">${shared.escapeHtml(String(total))}</strong> calls</div>
                <div><span class="nc-muted">Avg latency:</span> <strong id="nc-inf-latency">${shared.escapeHtml(String(latency))}</strong>ms</div>
                <div><span class="nc-muted">Error rate:</span> <strong id="nc-inf-errors">${shared.escapeHtml(String(errorRate))}</strong>%</div>
            </div>`;
    }

    function buildActivityTable(logs) {
        const rows = (logs || []).length > 0
            ? logs.map(log => {
                const statusColor = log.error ? '#f87171'
                    : log.timeout ? '#f59e0b'
                    : '#4ade80';
                const latencyStr = log.durationMs != null ? `${Number(log.durationMs).toLocaleString('en-US')}ms` : '--';
                const caller = log.taskType || log.caller || '--';
                const hostLabel = log.hostName || shared.escapeHtml(log.hostKey || log.host || '--');

                return `
                    <tr>
                        <td style="padding:6px 10px;font-size:0.8rem;color:var(--muted);" title="${log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}">${shared.timeAgo(log.timestamp)}</td>
                        <td class="nc-td-sm"><span class="nc-model-tag">${shared.escapeHtml(caller.replace(/_/g, ' '))}</span></td>
                        <td class="nc-td-sm"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(log.model))}</span></td>
                        <td style="padding:6px 10px;font-weight:600;text-transform:uppercase;">${shared.escapeHtml(hostLabel)}</td>
                        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;">${latencyStr}</td>
                        <td style="padding:6px 10px;text-align:center;"><span style="color:${statusColor}">●</span></td>
                    </tr>`;
            }).join('')
            : '<tr><td colspan="6" class="nc-td-empty">No recent inference activity</td></tr>';

        return `
            <table class="nc-table" id="nc-inference-activity-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Caller</th>
                        <th>Model</th>
                        <th>Host</th>
                        <th class="nc-td-right">Latency</th>
                        <th style="text-align:center;width:60px;">Status</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    // ── Panel 4: Inference Trends ────────────────────────────────────

    async function renderTrends() {
        const container = document.getElementById('nc-inference-trends');
        if (!container) return;

        try {
            const [timeline, hostSummary, modelSummary] = await Promise.all([
                shared.fetchJson('/api/telemetry/timeline?hours=24&bucketMinutes=60'),
                shared.fetchJson('/api/telemetry/host-summary?hours=24'),
                shared.fetchJson('/api/telemetry/model-summary?hours=24'),
            ]);

            const buckets = timeline.data || timeline.buckets || timeline || [];
            const hostRows = hostSummary.data || hostSummary.hosts || hostSummary || [];
            const modelRows = modelSummary.data || modelSummary.models || modelSummary || [];

            if (!Array.isArray(buckets) || buckets.length === 0) {
                container.innerHTML = '<div class="nc-muted nc-td-p12">No telemetry data available yet.</div>';
                return;
            }

            // ── Hour labels ──
            const labels = buckets.map(b => {
                const d = new Date(b.bucket || b.time || b.timestamp);
                return `${String(d.getHours()).padStart(2, '0')}:00`;
            });

            // ── Throughput: stacked bar by host ──
            const hostKeys = new Set();
            buckets.forEach(b => {
                const byHost = b.byHost || b.hosts || {};
                Object.keys(byHost).forEach(h => hostKeys.add(h));
            });

            const throughputDatasets = [...hostKeys].map(host => {
                const color = HOST_COLORS[host] || '#93a0b5';
                const label = HOST_LABELS[host] || host;
                return {
                    label,
                    data: buckets.map(b => {
                        const entry = (b.byHost || b.hosts || {})[host];
                        return entry?.count || entry || 0;
                    }),
                    backgroundColor: color,
                    borderColor: color,
                    borderWidth: 1,
                };
            });

            // ── Latency: avg + p95 lines ──
            const avgLatencies = buckets.map(b => b.avgLatencyMs ?? b.avgLatency ?? null);
            const p95Latencies = buckets.map(b => b.p95LatencyMs ?? b.p95Latency ?? null);

            // ── Render HTML ──
            container.innerHTML = `
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
                    <div>
                        <h5 class="nc-section-heading">Throughput by Host</h5>
                        <div style="position:relative;height:200px;">
                            <canvas id="nc-throughput-chart" height="200"></canvas>
                        </div>
                    </div>
                    <div>
                        <h5 class="nc-section-heading">Latency (Avg / P95)</h5>
                        <div style="position:relative;height:200px;">
                            <canvas id="nc-latency-chart" height="200"></canvas>
                        </div>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
                    <div>
                        <h5 class="nc-section-heading">Host Summary</h5>
                        <table class="nc-table">
                            <thead><tr><th>Host</th><th>Calls</th><th>Avg Latency</th><th>Error Rate</th><th>Tokens Out</th></tr></thead>
                            <tbody>${buildHostSummaryRows(hostRows)}</tbody>
                        </table>
                    </div>
                    <div>
                        <h5 class="nc-section-heading">Model Summary</h5>
                        <table class="nc-table">
                            <thead><tr><th>Model</th><th>Calls</th><th>Avg Latency</th><th>Error Rate</th><th>Hosts</th></tr></thead>
                            <tbody>${buildModelSummaryRows(modelRows)}</tbody>
                        </table>
                    </div>
                </div>`;

            // ── Throughput chart ──
            const throughputCtx = document.getElementById('nc-throughput-chart').getContext('2d');
            if (throughputChart) throughputChart.destroy();
            throughputChart = new Chart(throughputCtx, {
                type: 'bar',
                data: { labels, datasets: throughputDatasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: '#93a0b5', font: { size: 11 } } },
                    },
                    scales: {
                        x: {
                            stacked: true,
                            ticks: { color: '#93a0b5' },
                            grid: { display: false },
                        },
                        y: {
                            stacked: true,
                            ticks: { color: '#93a0b5' },
                            grid: { color: 'rgba(255,255,255,0.05)' },
                        },
                    },
                },
            });

            // ── Latency chart ──
            const latencyCtx = document.getElementById('nc-latency-chart').getContext('2d');
            if (latencyChart) latencyChart.destroy();
            latencyChart = new Chart(latencyCtx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Avg Latency',
                            data: avgLatencies,
                            borderColor: '#7cf0ff',
                            backgroundColor: 'rgba(124,240,255,0.1)',
                            borderWidth: 2,
                            tension: 0.3,
                            pointRadius: 2,
                            fill: false,
                        },
                        {
                            label: 'P95 Latency',
                            data: p95Latencies,
                            borderColor: '#f59e0b',
                            backgroundColor: 'rgba(245,158,11,0.1)',
                            borderWidth: 2,
                            borderDash: [6, 3],
                            tension: 0.3,
                            pointRadius: 2,
                            fill: false,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: '#93a0b5', font: { size: 11 } } },
                    },
                    scales: {
                        x: { ticks: { color: '#93a0b5' }, grid: { display: false } },
                        y: {
                            ticks: {
                                color: '#93a0b5',
                                callback: v => `${v}ms`,
                            },
                            grid: { color: 'rgba(255,255,255,0.05)' },
                        },
                    },
                },
            });

        } catch (err) {
            console.warn('[NerveCenter] Trends data unavailable', err);
            container.innerHTML = '<div class="nc-muted nc-td-p12">No telemetry data available yet.</div>';
        }
    }

    function buildHostSummaryRows(rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
            return '<tr><td colspan="5" class="nc-muted" style="padding:12px;text-align:center;">No host data</td></tr>';
        }
        return rows.map(r => {
            const host = r.host || r._id || '--';
            const label = HOST_LABELS[host] || shared.escapeHtml(host);
            const calls = r.count ?? r.calls ?? '--';
            const avgLat = r.avgLatencyMs != null ? `${Math.round(r.avgLatencyMs)}ms` : '--';
            const errRate = r.errorRate != null ? `${r.errorRate.toFixed(1)}%` : '--';
            const tokens = r.tokensOut ?? r.totalTokensOut ?? '--';
            return `<tr>
                <td class="nc-td-sm">${label}</td>
                <td class="nc-td-sm">${shared.escapeHtml(String(calls))}</td>
                <td class="nc-td-sm">${shared.escapeHtml(avgLat)}</td>
                <td class="nc-td-sm">${shared.escapeHtml(String(errRate))}</td>
                <td class="nc-td-sm">${shared.escapeHtml(String(tokens))}</td>
            </tr>`;
        }).join('');
    }

    function buildModelSummaryRows(rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
            return '<tr><td colspan="5" class="nc-muted" style="padding:12px;text-align:center;">No model data</td></tr>';
        }
        return rows.map(r => {
            const model = r.model || r._id || '--';
            const calls = r.count ?? r.calls ?? '--';
            const avgLat = r.avgLatencyMs != null ? `${Math.round(r.avgLatencyMs)}ms` : '--';
            const errRate = r.errorRate != null ? `${r.errorRate.toFixed(1)}%` : '--';
            const hosts = Array.isArray(r.hosts) ? r.hosts.map(h => HOST_LABELS[h] || h).join(', ') : (r.hosts || '--');
            return `<tr>
                <td class="nc-td-sm"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model))}</span></td>
                <td class="nc-td-sm">${shared.escapeHtml(String(calls))}</td>
                <td class="nc-td-sm">${shared.escapeHtml(avgLat)}</td>
                <td class="nc-td-sm">${shared.escapeHtml(String(errRate))}</td>
                <td class="nc-td-sm">${shared.escapeHtml(String(hosts))}</td>
            </tr>`;
        }).join('');
    }

    function scheduleTrendsRefresh() {
        if (!_poller) {
            _poller = new window.PollingController();
            _poller.start();
        }
        _poller.removeTask('trends');
        _poller.addTask('trends', renderTrends, 60_000, { runOnStart: false });
    }

    // ── Panel 5: Utilization Heatmap ───────────────────────────────

    function heatmapColor(pct) {
        if (pct <= 25) return 'rgba(74,222,128,0.2)';
        if (pct <= 50) return 'rgba(74,222,128,0.5)';
        if (pct <= 75) return 'rgba(245,158,11,0.5)';
        return 'rgba(248,113,113,0.5)';
    }

    async function renderHeatmap() {
        const container = document.getElementById('nc-inference-heatmap');
        if (!container) return;

        try {
            const json = await shared.fetchJson('/api/nerve-center/inference/heatmap?days=7');
            const data = json.data || {};
            const hosts = data.hosts || [];
            const days = data.days || [];
            const grid = data.grid || {};

            if (hosts.length === 0) {
                container.innerHTML = '<div class="nc-muted nc-td-p12">No heatmap data available yet.</div>';
                return;
            }

            // Average across days for each host × hour
            const avgGrid = {};
            for (const host of hosts) {
                avgGrid[host] = new Array(24).fill(0);
                const matrix = grid[host] || [];
                if (matrix.length === 0) continue;
                for (let h = 0; h < 24; h++) {
                    let sum = 0;
                    for (let d = 0; d < matrix.length; d++) {
                        sum += (matrix[d] && matrix[d][h]) || 0;
                    }
                    avgGrid[host][h] = Math.round(sum / matrix.length);
                }
            }

            const hourHeaders = Array.from({ length: 24 }, (_, i) => `<th style="padding:4px 2px;font-size:0.7rem;text-align:center;min-width:28px;">${i}</th>`).join('');

            const rows = hosts.map(host => {
                const cells = avgGrid[host].map(pct => {
                    const bg = heatmapColor(pct);
                    return `<td style="background:${bg};text-align:center;padding:4px 2px;font-size:0.7rem;">${pct}%</td>`;
                }).join('');
                return `<tr><td style="padding:4px 8px;font-weight:600;white-space:nowrap;">${shared.escapeHtml(host)}</td>${cells}</tr>`;
            }).join('');

            container.innerHTML = `
                <table class="nc-table" id="nc-heatmap-table" style="font-variant-numeric:tabular-nums;">
                    <thead><tr><th style="padding:4px 8px;">Host</th>${hourHeaders}</tr></thead>
                    <tbody>${rows}</tbody>
                </table>`;
        } catch (err) {
            console.warn('[NerveCenter] Heatmap data unavailable', err);
            container.innerHTML = '<div class="nc-muted nc-td-p12">Heatmap data unavailable.</div>';
        }
    }

    // ── Main loader ────────────────────────────────────────────────────

    async function loadInference() {
        const body = document.getElementById('sectionInferenceBody');
        if (!body) return;

        body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading inference data…</div>';

        try {
            const [configJson, activityJson] = await Promise.all([
                shared.fetchJson('/api/nerve-center/inference/routing-config'),
                shared.fetchJson('/api/nerve-center/inference/activity?limit=30')
            ]);

            const config = configJson.data || {};
            const activity = activityJson.data || {};
            const routingHtml = buildTaskRoutingTable(config);
            const statsHtml = buildActivityStats(activity.stats);
            const activityHtml = buildActivityTable(activity.logs);

            body.innerHTML = `
                <h4 style="margin:24px 0 12px;color:var(--text-bright);">
                    <i class="fa-solid fa-chart-line nc-icon-accent"></i> Inference Trends (24h)
                </h4>
                <div id="nc-inference-trends">
                    <div class="nc-muted nc-td-p12"><i class="fas fa-spinner fa-spin"></i> Loading trends…</div>
                </div>
                <h4 style="margin:24px 0 12px;color:var(--text-bright);">
                    <i class="fa-solid fa-fire nc-icon-accent"></i> Utilization Heatmap (7d avg)
                </h4>
                <div id="nc-inference-heatmap">
                    <div class="nc-muted nc-td-p12"><i class="fas fa-spinner fa-spin"></i> Loading heatmap…</div>
                </div>
                <div class="nc-collapsible" style="margin-top:24px;margin-bottom:16px;">
                    <div class="nc-collapsible-header nc-row-click">
                        <i class="fas fa-chevron-right nc-collapse-icon nc-collapse-icon"></i>
                        <h4 class="nc-title"><i class="fas fa-microchip nc-icon-accent"></i>GPU Fleet Status &amp; Task Routing</h4>
                    </div>
                    <div class="nc-collapsible-body">
                        ${routingHtml}
                    </div>
                </div>
                <div class="nc-collapsible nc-mb-16">
                    <div class="nc-collapsible-header nc-row-click">
                        <i class="fas fa-chevron-right nc-collapse-icon nc-collapse-icon"></i>
                        <h4 class="nc-title"><i class="fas fa-wave-square nc-icon-accent"></i>Inference Activity</h4>
                    </div>
                    <div class="nc-collapsible-body">
                        ${statsHtml}
                        ${activityHtml}
                    </div>
                </div>`;

            shared.attachCollapsibleHandlers(body);
            attachTaskEditHandlers(config);
            scheduleActivityRefresh();
            renderTrends();
            scheduleTrendsRefresh();
            renderHeatmap();
        } catch (err) {
            console.error('[NerveCenter] loadInference failed', err);
            body.innerHTML = `<div class="nc-section-placeholder" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i> Failed to load inference data: ${shared.escapeHtml(err.message)}</div>`;
        }
    }

    function scheduleActivityRefresh() {
        if (!_poller) {
            _poller = new window.PollingController();
            _poller.start();
        }
        _poller.removeTask('activity');
        _poller.addTask('activity', refreshActivity, 30_000, { runOnStart: false });
    }

    async function refreshActivity() {
        try {
            const activityJson = await shared.fetchJson('/api/nerve-center/inference/activity?limit=30');
            const activity = activityJson.data || {};

            const totalEl = document.getElementById('nc-inf-total');
            const latencyEl = document.getElementById('nc-inf-latency');
            const errorsEl = document.getElementById('nc-inf-errors');
            if (totalEl) totalEl.textContent = activity.stats?.total ?? '--';
            if (latencyEl) latencyEl.textContent = activity.stats?.avgLatencyMs != null ? Math.round(activity.stats.avgLatencyMs) : '--';
            if (errorsEl) errorsEl.textContent = activity.stats?.errorRate != null ? activity.stats.errorRate.toFixed(1) : '--';

            const table = document.getElementById('nc-inference-activity-table');
            if (table) {
                const tbody = table.querySelector('tbody');
                if (tbody) tbody.innerHTML = buildActivityTable(activity.logs).match(/<tbody>([\s\S]*)<\/tbody>/)?.[1] || '';
            }
        } catch (err) {
            console.error('[NerveCenter] Activity refresh failed', err);
        }
    }

    window.NerveCenterInference = { loadInference };
})();

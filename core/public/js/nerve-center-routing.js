(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    let currentRoutingLogs = [];

    function getTaskTypes(config) {
        const known = new Set([
            ...Object.keys(config.taskMetadata || {}),
            ...Object.keys(config.taskModels || {}),
            ...Object.keys(config.taskConfigState || {}),
            ...Object.keys(config.defaults?.taskModels || {})
        ]);
        return [...known].sort((left, right) => left.localeCompare(right));
    }

    function formatTaskLabel(task, metadata = {}) {
        return metadata.title || task.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
    }

    function getKnownModels(config) {
        const known = new Set();
        Object.values(config.taskModels || {}).forEach(entry => {
            if (entry?.model) known.add(entry.model);
        });
        return [...known].sort();
    }

    function buildTaskRoutingTable(config) {
        const availableModels = Array.isArray(config.availableModels) && config.availableModels.length > 0
            ? config.availableModels
            : getKnownModels(config);
        const hostKeys = shared.sortHostKeys(Object.keys(config.hosts || {}).filter(key => config.hosts[key]));
        const taskTypes = getTaskTypes(config);
        let taskRows = '';
        taskTypes.forEach(task => {
            const state = config.taskConfigState?.[task] || {};
            const entry = state.effective || config.taskModels?.[task] || { model: '--', host: '--' };
            const defaultEntry = state.default || config.defaults?.taskModels?.[task] || { model: '--', host: '--' };
            const metadata = config.taskMetadata?.[task] || {};
            const taskLabel = formatTaskLabel(task, metadata);
            const stateBadge = state.isOverride
                ? '<span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;">Override</span>'
                : '<span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.28);color:#4ade80;font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;">Deployment default</span>';
            taskRows += `
                <tr data-task="${task}">
                    <td class="nc-td-md">
                        <div class="nc-row-flex-sb">
                            <div class="nc-fw6">${shared.escapeHtml(taskLabel)}</div>
                            ${stateBadge}
                        </div>
                        <div style="margin-top:4px;font-size:0.78rem;color:var(--muted);line-height:1.4;">
                            ${shared.escapeHtml(metadata.description || 'No description available.')}
                        </div>
                        <div style="margin-top:6px;font-size:0.72rem;color:var(--muted);">
                            Deployment default: ${shared.escapeHtml(shared.shortModel(defaultEntry.model || '--'))} on ${shared.escapeHtml((defaultEntry.host || '--').toUpperCase())}
                        </div>
                    </td>
                    <td class="nc-td-md nc-task-model">
                        <select class="nc-inline-select nc-task-model-select" data-task="${task}" style="min-width:210px;">
                            ${availableModels.map(model => (
                                `<option value="${shared.escapeHtml(model)}" ${model === entry.model ? 'selected' : ''}>${shared.escapeHtml(shared.shortModel(model))}</option>`
                            )).join('')}
                        </select>
                    </td>
                    <td class="nc-td-md nc-task-host">
                        <select class="nc-inline-select nc-task-host-select" data-task="${task}" style="min-width:120px;">
                            ${hostKeys.map(hostKey => (
                                `<option value="${hostKey}" ${hostKey === entry.host ? 'selected' : ''}>${hostKey.toUpperCase()}</option>`
                            )).join('')}
                        </select>
                    </td>
                    <td style="padding:8px 10px;text-align:center;white-space:nowrap;">
                        <button class="nc-btn nc-task-save" data-task="${task}" style="font-size:10px;padding:3px 10px;margin-right:4px;">
                            <i class="fas fa-check"></i> Save
                        </button>
                        <button class="nc-btn nc-task-reset" data-task="${task}" ${state.isOverride ? '' : 'disabled'} style="font-size:10px;padding:3px 10px;border-color:rgba(248,113,113,0.3);color:#f87171;background:rgba(248,113,113,0.08);">
                            <i class="fas fa-rotate-left"></i> Use default
                        </button>
                    </td>
                </tr>`;
        });

        return `
            <div class="nc-muted" style="margin-bottom:10px;font-size:0.78rem;line-height:1.45;">
                Saved overrides are live app configuration. “Use default” deletes that override and restores the deployment env/code value shown on the row.
            </div>
            <table class="nc-table">
                <thead>
                    <tr>
                        <th>Task Type</th>
                        <th>Model</th>
                        <th>Host</th>
                        <th style="text-align:center;width:180px;">Actions</th>
                    </tr>
                </thead>
                <tbody>${taskRows}</tbody>
            </table>`;
    }

    function buildRoutingExplainer(config) {
        const classification = config.classification || {};
        const steps = Array.isArray(config.explainerSteps) ? config.explainerSteps : [];
        const taskCards = getTaskTypes(config).map(task => {
            const metadata = config.taskMetadata?.[task] || {};
            const entry = config.taskModels?.[task] || {};
            return `
                <div class="nc-host-card nc-td-lg">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
                        <div>
                            <div style="font-size:0.9rem;font-weight:700;color:var(--text-bright);">${shared.escapeHtml(formatTaskLabel(task, metadata))}</div>
                            <div style="margin-top:6px;font-size:0.8rem;line-height:1.45;color:var(--muted);">${shared.escapeHtml(metadata.description || 'No description available.')}</div>
                        </div>
                        <span style="padding:4px 8px;border-radius:999px;background:rgba(124,240,255,0.08);border:1px solid rgba(124,240,255,0.16);font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:#7cf0ff;">
                            ${shared.escapeHtml((entry.host || '--').toUpperCase())}
                        </span>
                    </div>
                    <div style="margin-top:12px;">
                        <span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(entry.model || '--'))}</span>
                    </div>
                </div>`;
        }).join('');

        return `
            <div class="nc-host-card nc-mb-16">
                <div class="nc-grid-3col">
                    ${steps.map((step, index) => `
                        <div class="nc-card-sm">
                            <div style="font-size:0.72rem;letter-spacing:0.08em;text-transform:uppercase;color:#7cf0ff;">Step ${index + 1}</div>
                            <div style="margin-top:8px;font-size:0.82rem;line-height:1.5;color:var(--text);">${shared.escapeHtml(step)}</div>
                        </div>
                    `).join('')}
                </div>
                <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;">
                    <div>
                        <div style="font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Classifier Prompt</div>
                        <pre style="margin:0;padding:14px;border-radius:12px;white-space:pre-wrap;overflow:auto;background:rgba(2,6,23,0.75);border:1px solid var(--panel-border);font-size:0.78rem;line-height:1.5;color:#d7e3f4;">${shared.escapeHtml(classification.prompt || 'Unavailable')}</pre>
                    </div>
                    <div>
                        <div style="font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">Classifier Runtime</div>
                        <div style="display:grid;gap:10px;">
                            <div class="nc-card-sm">
                                <div class="nc-label">Model</div>
                                <div style="margin-top:6px;"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(classification.model || '--'))}</span></div>
                            </div>
                            <div class="nc-card-sm">
                                <div class="nc-label">Preferred Host</div>
                                <div style="margin-top:6px;font-weight:600;">${shared.escapeHtml((classification.host || '--').toUpperCase())}</div>
                                <div style="margin-top:6px;font-size:0.78rem;color:var(--muted);">${shared.escapeHtml(classification.hostUrl || 'No host configured')}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <h4 style="font-size:0.95rem;font-weight:700;margin:0 0 10px;color:var(--text-bright);">Task Categories</h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:18px;">
                ${taskCards}
            </div>`;
    }

    function valueOrDash(value) {
        return value == null || value === '' ? '--' : String(value);
    }

    function formatHostLabel(hostKey, hostUrl) {
        if (hostKey) return String(hostKey).toUpperCase();
        return hostUrl || '--';
    }

    function formatRouteCell(model, hostKey, hostUrl, subtext = '') {
        return `
            <div style="display:grid;gap:4px;">
                <div style="font-weight:700;text-transform:uppercase;">${shared.escapeHtml(formatHostLabel(hostKey, hostUrl))}</div>
                <div><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model || '--'))}</span></div>
                ${subtext ? `<div style="font-size:0.72rem;color:var(--muted);line-height:1.35;">${shared.escapeHtml(subtext)}</div>` : ''}
            </div>`;
    }

    function getRoutingTrace(log) {
        return log?.routingTrace && typeof log.routingTrace === 'object' ? log.routingTrace : null;
    }

    function getRecommendationSummary(log) {
        const trace = getRoutingTrace(log);
        if (!trace?.recommendation) return null;
        const rec = trace.recommendation;
        return {
            model: rec.model,
            host: rec.host,
            hostUrl: rec.hostUrl,
            source: rec.source || 'router',
            reason: rec.scheduler?.reason || rec.reason || ''
        };
    }

    function getUsedSummary(log) {
        const trace = getRoutingTrace(log);
        const selected = trace?.selected || {};
        return {
            model: selected.model || log.routedModel || log.model,
            host: selected.hostKey || log.routedHost || log.hostKey,
            hostUrl: selected.hostUrl || log.routedHostUrl || log.host,
            source: selected.routingSource || ''
        };
    }

    function getDifferenceSummary(log) {
        const trace = getRoutingTrace(log);
        if (!trace) {
            return {
                label: 'Legacy',
                color: '#94a3b8',
                reason: 'No routing trace was stored for this older row.'
            };
        }
        const diff = trace.difference || {};
        const reasons = Array.isArray(diff.reasons) ? diff.reasons : [];
        return {
            label: diff.differsFromRecommendation ? 'Diff' : 'Match',
            color: diff.differsFromRecommendation ? '#f59e0b' : '#4ade80',
            reason: reasons[0] || '--'
        };
    }

    function routingStateBadge(summary) {
        return `<span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:${summary.color}1f;border:1px solid ${summary.color}55;color:${summary.color};font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;">${shared.escapeHtml(summary.label)}</span>`;
    }

    function prettyJson(value) {
        return shared.escapeHtml(JSON.stringify(value ?? null, null, 2));
    }

    function buildKeyValueGrid(items) {
        return `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">
                ${items.map(item => `
                    <div class="nc-card-sm">
                        <div class="nc-label">${shared.escapeHtml(item.label)}</div>
                        <div style="margin-top:6px;font-size:0.86rem;color:var(--text);font-weight:${item.weight || 600};word-break:break-word;">${shared.escapeHtml(valueOrDash(item.value))}</div>
                    </div>
                `).join('')}
            </div>`;
    }

    function buildScoredCandidates(scored) {
        if (!Array.isArray(scored) || scored.length === 0) {
            return '<div class="nc-section-placeholder" style="padding:14px 10px;">No scheduler candidate scoring stored for this row</div>';
        }
        return scored.map(candidate => `
            <div class="nc-card-sm" style="margin-bottom:8px;">
                <div class="nc-row-flex-sb">
                    <strong style="text-transform:uppercase;">${shared.escapeHtml(candidate.host || '--')}</strong>
                    <span style="font-variant-numeric:tabular-nums;color:var(--text-bright);">${shared.escapeHtml(valueOrDash(candidate.score))}</span>
                </div>
                <div style="margin-top:6px;font-size:0.78rem;color:var(--muted);line-height:1.4;">
                    ${shared.escapeHtml(Array.isArray(candidate.reasons) ? candidate.reasons.join('; ') : '')}
                </div>
            </div>
        `).join('');
    }

    function buildRequestPreview(trace) {
        const preview = trace?.request?.preview || {};
        const messages = Array.isArray(preview.messages) ? preview.messages : [];
        return `
            ${buildKeyValueGrid([
                { label: 'Caller', value: trace?.request?.callerDetail || '--' },
                { label: 'Lane', value: trace?.lane?.name || trace?.request?.lane || '--' },
                { label: 'Mode', value: preview.mode || '--' },
                { label: 'Host Override', value: trace?.request?.hostOverride || '--' }
            ])}
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:10px;">
                <div class="nc-card-sm">
                    <div class="nc-label">Prompt Preview</div>
                    <pre style="margin:8px 0 0;white-space:pre-wrap;max-height:180px;overflow:auto;color:var(--text);font-size:0.76rem;">${shared.escapeHtml(preview.prompt?.preview || preview.system?.preview || '--')}</pre>
                </div>
                <div class="nc-card-sm">
                    <div class="nc-label">Messages</div>
                    <pre style="margin:8px 0 0;white-space:pre-wrap;max-height:180px;overflow:auto;color:var(--text);font-size:0.76rem;">${prettyJson(messages)}</pre>
                </div>
            </div>`;
    }

    function buildRoutingDetail(log) {
        const trace = getRoutingTrace(log);
        const used = getUsedSummary(log);
        const recommendation = getRecommendationSummary(log);
        const diff = getDifferenceSummary(log);

        if (!trace) {
            return `
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-row-flex-sb-mb">
                        <strong>Routing row detail</strong>
                        ${routingStateBadge(diff)}
                    </div>
                    <div style="font-size:0.82rem;color:var(--muted);line-height:1.5;margin-bottom:12px;">
                        This row was written before detailed route tracing was added. It still shows the actual persisted path.
                    </div>
                    ${buildKeyValueGrid([
                        { label: 'Actual Host', value: formatHostLabel(used.host, used.hostUrl) },
                        { label: 'Actual Model', value: used.model },
                        { label: 'Task Type', value: log.taskType || '--' },
                        { label: 'Caller', value: log.callerDetail || log.caller || '--' },
                        { label: 'Latency', value: log.durationMs != null ? `${log.durationMs}ms` : '--' },
                        { label: 'Status', value: log.status || '--' }
                    ])}
                </div>`;
        }

        const rec = trace.recommendation || {};
        const scheduler = rec.scheduler || {};
        const adaptation = trace.adaptation || {};
        const reasons = Array.isArray(trace.difference?.reasons) ? trace.difference.reasons : [];

        return `
            <div class="nc-host-card nc-td-lg">
                <div class="nc-row-flex-sb-mb">
                    <strong>Router Work</strong>
                    ${routingStateBadge(diff)}
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:12px;">
                    <div class="nc-card-sm">
                        <div class="nc-label">Recommendation</div>
                        <div style="margin-top:8px;">${recommendation ? formatRouteCell(recommendation.model, recommendation.host, recommendation.hostUrl, recommendation.source) : '--'}</div>
                    </div>
                    <div class="nc-card-sm">
                        <div class="nc-label">Real Path Used</div>
                        <div style="margin-top:8px;">${formatRouteCell(used.model, used.host, used.hostUrl, used.source)}</div>
                    </div>
                    <div class="nc-card-sm">
                        <div class="nc-label">Why</div>
                        <div style="margin-top:8px;font-size:0.82rem;line-height:1.5;color:var(--text);">
                            ${reasons.map(reason => `<div style="margin-bottom:5px;">${shared.escapeHtml(reason)}</div>`).join('') || '--'}
                        </div>
                    </div>
                </div>
                ${buildKeyValueGrid([
                    { label: 'Configured Task Host', value: trace.configured?.host || '--' },
                    { label: 'Configured Task Model', value: trace.configured?.model || '--' },
                    { label: 'Scheduler Source', value: rec.source || '--' },
                    { label: 'Scheduler Reason', value: scheduler.reason || rec.reason || '--', weight: 500 },
                    { label: 'Adapted Probe', value: adaptation.probe || '--' },
                    { label: 'Adapted Change', value: adaptation.applied ? `${adaptation.before} -> ${adaptation.after}` : 'No model-name change' },
                    { label: 'Ollama Endpoint', value: trace.ollama?.endpoint || '--' },
                    { label: 'keep_alive', value: trace.ollama?.keepAlive == null ? '--' : trace.ollama.keepAlive }
                ])}
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:12px;">
                    <div>
                        <div class="nc-label" style="margin-bottom:8px;">Scheduler Possibilities</div>
                        ${buildScoredCandidates(scheduler.scored)}
                    </div>
                    <div>
                        <div class="nc-label" style="margin-bottom:8px;">Inference Text / Params Preview</div>
                        ${buildRequestPreview(trace)}
                    </div>
                </div>
            </div>`;
    }

    function buildLogTable(logs) {
        currentRoutingLogs = Array.isArray(logs) ? logs : [];
        const rows = (logs || []).length > 0
            ? logs.map((log, index) => {
                const recommendation = getRecommendationSummary(log);
                const used = getUsedSummary(log);
                const diff = getDifferenceSummary(log);
                const rowId = shared.escapeHtml(String(log._id || index));
                return `
                <tr class="nc-routing-log-row" data-routing-log-id="${rowId}" style="cursor:pointer;">
                    <td style="padding:6px 10px;font-size:0.8rem;color:var(--muted);" title="${log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}">${shared.timeAgo(log.timestamp)}</td>
                    <td class="nc-td-sm">${shared.escapeHtml((log.taskType || '--').replace(/_/g, ' '))}</td>
                    <td class="nc-td-sm">${shared.escapeHtml(log.callerDetail || log.caller || '--')}</td>
                    <td class="nc-td-sm">${recommendation ? formatRouteCell(recommendation.model, recommendation.host, recommendation.hostUrl, recommendation.reason) : '<span style="color:var(--muted);">--</span>'}</td>
                    <td class="nc-td-sm">${formatRouteCell(used.model, used.host, used.hostUrl, used.source)}</td>
                    <td style="padding:6px 10px;min-width:180px;">
                        ${routingStateBadge(diff)}
                        <div style="margin-top:6px;font-size:0.74rem;color:var(--muted);line-height:1.35;">${shared.escapeHtml(diff.reason)}</div>
                    </td>
                    <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;">${log.durationMs != null ? `${log.durationMs}ms` : '--'}</td>
                </tr>
            `; }).join('')
            : '<tr><td colspan="7" class="nc-td-empty">No recent inference logs</td></tr>';

        return `
            <table class="nc-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Task Type</th>
                        <th>Caller</th>
                        <th>Router Recommendation</th>
                        <th>Real Path Used</th>
                        <th>Why</th>
                        <th class="nc-td-right">Latency</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div id="routingLogDetail" style="margin-top:12px;">
                <div class="nc-section-placeholder" style="padding:18px 12px;">Click a routing row to inspect the recommendation, final path, request preview, and scheduler candidates.</div>
            </div>`;
    }

    function formatMetricMs(value) {
        return Number.isFinite(value) && value > 0 ? `${Math.round(value)}ms` : '--';
    }

    function buildDistributionList(items, keyField, label) {
        if (!Array.isArray(items) || items.length === 0) {
            return `<div class="nc-section-placeholder" style="padding:18px 12px;">No ${shared.escapeHtml(label)} telemetry yet</div>`;
        }

        return items.slice(0, 5).map(item => `
            <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;margin-bottom:10px;">
                <div>
                    <div class="nc-row-flex-sb">
                        <strong style="font-size:0.86rem;">${shared.escapeHtml((item[keyField] || '--').replace?.(/_/g, ' ') || item[keyField] || '--')}</strong>
                        <span style="font-size:0.78rem;color:var(--muted);">${item.count} req</span>
                    </div>
                    <div style="margin-top:6px;height:8px;border-radius:999px;background:rgba(148,163,184,0.15);overflow:hidden;">
                        <div style="height:100%;width:${Math.min(item.percentage || 0, 100)}%;background:linear-gradient(90deg,#7cf0ff,#4ade80);"></div>
                    </div>
                    <div style="margin-top:6px;font-size:0.75rem;color:var(--muted);display:flex;justify-content:space-between;gap:10px;">
                        <span>${item.percentage || 0}% share</span>
                        <span>Avg ${formatMetricMs(item.avgDurationMs)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    }

    function buildRoutingAnalyticsSection(analytics) {
        const summary = analytics?.summary || {};
        const totalRequests = summary.totalRequests || 0;

        return `
            <h4 style="font-size:0.95rem;font-weight:700;margin:20px 0 10px;color:var(--text-bright);">Routing Analytics</h4>
            <div class="nc-grid-3col">
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-label">Window</div>
                    <div class="nc-value">${summary.windowHours || 24}h</div>
                    <div class="nc-value-sub">${totalRequests} routed chat requests</div>
                </div>
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-label">Auto Routed</div>
                    <div class="nc-value">${summary.autoRoutedPct || 0}%</div>
                    <div class="nc-value-sub">${summary.autoRoutedCount || 0} classifier-driven requests</div>
                </div>
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-label">Avg Response</div>
                    <div class="nc-value">${formatMetricMs(summary.avgDurationMs)}</div>
                    <div class="nc-value-sub">Across recent routed chat traffic</div>
                </div>
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-label">Avg Classification</div>
                    <div class="nc-value">${formatMetricMs(summary.avgClassificationMs)}</div>
                    <div class="nc-value-sub">LLM classification time when auto-routing</div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:20px;">
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-row-flex-sb-mb">
                        <strong style="font-size:0.9rem;">Task Type Distribution</strong>
                        <span style="font-size:0.75rem;color:var(--muted);">Last ${summary.windowHours || 24}h</span>
                    </div>
                    ${buildDistributionList(analytics?.taskDistribution, 'taskType', 'task routing')}
                </div>
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-row-flex-sb-mb">
                        <strong style="font-size:0.9rem;">Most Used Models</strong>
                        <span style="font-size:0.75rem;color:var(--muted);">By routed model</span>
                    </div>
                    ${buildDistributionList(analytics?.modelDistribution, 'model', 'model routing')}
                </div>
                <div class="nc-host-card nc-td-lg">
                    <div class="nc-row-flex-sb-mb">
                        <strong style="font-size:0.9rem;">Host Distribution</strong>
                        <span style="font-size:0.75rem;color:var(--muted);">By routed host</span>
                    </div>
                    ${buildDistributionList(analytics?.hostDistribution, 'host', 'host routing')}
                </div>
            </div>`;
    }

    function buildRoutingSection(config, logs, analytics, failover) {
        const hosts = config.hosts || {};
        const activeHostKey = shared.hostKeyFromUrl(failover.currentHost, {
            primary: failover.primaryHost,
            secondary: failover.secondaryHost,
            tertiary: failover.tertiaryHost
        });

        const failoverBadge = failover.isFailedOver
            ? '<span style="color:#f59e0b;font-weight:600;">ACTIVE</span>'
            : '<span style="color:#4ade80;">Nominal</span>';
        const failoverBar = `
            <div style="display:flex;align-items:center;gap:16px;padding:10px 14px;background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:8px;margin-bottom:16px;font-size:0.85rem;">
                <i class="fas fa-arrow-right-arrow-left" style="color:#7cf0ff;"></i>
                <span class="nc-fw6">Failover:</span> ${failoverBadge}
                <span class="nc-muted">·</span>
                <span class="nc-muted">Host:</span> <span class="nc-fw6">${shared.escapeHtml(activeHostKey.toUpperCase())}</span>
                <span class="nc-muted">·</span>
                <span class="nc-muted">Count:</span> ${failover.failoverCount || 0}
                <span class="nc-muted">· persisted actual routes</span>
                ${failover.reason && failover.reason !== '--' ? `<span class="nc-muted">· ${shared.escapeHtml(failover.reason)}</span>` : ''}
            </div>`;

        return `
            ${failoverBar}
            ${buildRoutingAnalyticsSection(analytics)}
            <div class="nc-collapsible nc-mb-16">
                <div class="nc-collapsible-header" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0;color:var(--muted);font-size:0.85rem;">
                    <i class="fas fa-chevron-right nc-collapse-icon nc-collapse-icon"></i>
                    <span>How Auto-Routing Works</span>
                </div>
                <div class="nc-collapsible-body">
                    ${buildRoutingExplainer(config)}
                </div>
            </div>
            <div class="nc-collapsible nc-mb-16">
                <div class="nc-collapsible-header nc-row-click">
                    <i class="fas fa-chevron-right nc-collapse-icon nc-collapse-icon"></i>
                    <h4 class="nc-title">Task &rarr; Model Routing</h4>
                    <span style="font-size:0.72rem;color:var(--muted);margin-left:auto;" title="Each task type routes to a model+host pair. Override defaults with the dropdowns. Task types are defined in server config and cannot be added from the UI."><i class="fas fa-circle-info"></i> What is this?</span>
                </div>
                <div class="nc-collapsible-body">
                    ${buildTaskRoutingTable(config)}
                </div>
            </div>
            <div class="nc-collapsible nc-mb-16">
                <div class="nc-collapsible-header nc-row-click">
                    <i class="fas fa-chevron-right nc-collapse-icon nc-collapse-icon"></i>
                    <h4 class="nc-title">Routing Decision Log</h4>
                    <span style="font-size:0.72rem;color:var(--muted);margin-left:auto;">Recommendation vs actual Ollama path</span>
                </div>
                <div class="nc-collapsible-body">
                    ${buildLogTable(logs)}
                </div>
            </div>`;
    }

    function attachTaskRoutingHandlers(config) {
        document.querySelectorAll('.nc-task-save').forEach(button => {
            button.addEventListener('click', async () => {
                const task = button.dataset.task;
                const model = document.querySelector(`.nc-task-model-select[data-task="${task}"]`)?.value;
                const host = document.querySelector(`.nc-task-host-select[data-task="${task}"]`)?.value;

                button.disabled = true;
                try {
                    const data = await shared.fetchJson(`/api/router/config/tasks/${encodeURIComponent(task)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, host })
                    });
                    if (data.status === 'success') {
                        Toast.success(`Saved routing for ${formatTaskLabel(task, config.taskMetadata?.[task] || {})}`);
                        await window.NerveCenter.loadRouting();
                    } else {
                        Toast.error(data.message || 'Save failed');
                    }
                } catch (err) {
                    Toast.error(`Failed to save: ${err.message}`);
                } finally {
                    button.disabled = false;
                }
            });
        });

        document.querySelectorAll('.nc-task-reset').forEach(button => {
            button.addEventListener('click', async () => {
                const task = button.dataset.task;
                button.disabled = true;
                try {
                    const data = await shared.fetchJson(`/api/router/config/tasks/${encodeURIComponent(task)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ resetToDefault: true })
                    });
                    if (data.status === 'success') {
                        Toast.success(`Using deployment default for ${formatTaskLabel(task, config.taskMetadata?.[task] || {})}`);
                        await window.NerveCenter.loadRouting();
                    } else {
                        Toast.error(data.message || 'Reset failed');
                    }
                } catch (err) {
                    Toast.error(`Failed to reset: ${err.message}`);
                } finally {
                    button.disabled = false;
                }
            });
        });
    }

    function attachRoutingLogHandlers() {
        const detail = document.getElementById('routingLogDetail');
        if (!detail) return;

        document.querySelectorAll('.nc-routing-log-row').forEach(row => {
            row.addEventListener('click', () => {
                const log = currentRoutingLogs.find(item => String(item._id) === row.dataset.routingLogId)
                    || currentRoutingLogs[Number(row.dataset.routingLogId)];
                if (!log) return;

                document.querySelectorAll('.nc-routing-log-row').forEach(existing => {
                    existing.style.outline = '';
                    existing.style.background = '';
                });
                row.style.outline = '1px solid rgba(124,240,255,0.35)';
                row.style.background = 'rgba(124,240,255,0.04)';
                detail.innerHTML = buildRoutingDetail(log);
            });
        });
    }

    async function loadRouting() {
        const body = document.getElementById('sectionRoutingBody');
        if (!body) return;

        body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading routing data...</div>';

        try {
            const [configJson, logJson, analyticsJson, intelligenceJson] = await Promise.all([
                shared.fetchJson('/api/nerve-center/routing/config'),
                shared.fetchJson('/api/nerve-center/routing/log?limit=20'),
                shared.fetchJson('/api/nerve-center/routing/analytics?hours=24'),
                shared.fetchJson('/api/nerve-center/intelligence')
            ]);

            const config = configJson.data || {};
            const logs = logJson.data || [];
            const analytics = analyticsJson.data || {};
            const failover = intelligenceJson.data?.routing || {};

            body.innerHTML = buildRoutingSection(config, logs, analytics, failover);
            shared.attachCollapsibleHandlers(body);
            attachTaskRoutingHandlers(config);
            attachRoutingLogHandlers();
        } catch (err) {
            console.error('[NerveCenter] loadRouting failed', err);
            body.innerHTML = `<div class="nc-section-placeholder" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i> Failed to load routing data: ${shared.escapeHtml(err.message)}</div>`;
        }
    }

    window.NerveCenterRouting = { loadRouting };
})();

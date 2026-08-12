(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    if (!shared) return;

    const REFRESH_MS = 60_000;
    let refreshTimer = null;

    function esc(value) {
        return shared.escapeHtml(value == null ? '' : String(value));
    }

    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function asObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function dash(value) {
        if (value == null || value === '') return '--';
        return String(value);
    }

    function number(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function getDrift(snapshot) {
        return asArray(snapshot.drift?.records || snapshot.drift);
    }

    function formatMiB(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '--';
        if (n >= 1024) return `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} GiB`;
        return `${Math.round(n)} MiB`;
    }

    function formatPct(value) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n.toFixed(n >= 10 ? 0 : 1)}%` : '--';
    }

    function toneForStatus(value) {
        const status = String(value || '').toLowerCase();
        if (['ok', 'success', 'healthy', 'online', 'ready', 'valid', 'running', 'balanced'].includes(status)) return 'good';
        if (['degraded', 'warn', 'warning', 'attention', 'dirty', 'idle', 'protected', 'vram_constrained', 'underused'].includes(status)) return 'warn';
        if (['error', 'failed', 'critical', 'offline', 'down', 'missing', 'unhealthy', 'saturated'].includes(status)) return 'bad';
        return 'neutral';
    }

    function toneForSeverity(value) {
        const severity = String(value || '').toLowerCase();
        if (severity === 'critical' || severity === 'high') return 'bad';
        if (severity === 'medium') return 'warn';
        return 'neutral';
    }

    function chip(label, tone = 'neutral', icon = '') {
        return `<span class="nc-ecosystem-chip ${tone}">${icon ? `<i class="fas ${icon}"></i>` : ''}${esc(label)}</span>`;
    }

    function modelPill(model, tone = 'neutral') {
        if (!model) return '<span class="nc-muted">--</span>';
        return `<span class="nc-ecosystem-model ${tone}" title="${esc(model)}">${esc(model)}</span>`;
    }

    function renderModelChain(model = {}) {
        const chain = [model.primary, ...asArray(model.fallbacks)].filter(Boolean);
        if (chain.length === 0) return '<span class="nc-muted">--</span>';
        return `<div class="nc-ecosystem-model-chain">${chain.map((item, index) => `
            ${modelPill(item, index === 0 ? 'primary' : 'fallback')}
            ${index < chain.length - 1 ? '<i class="fas fa-chevron-right nc-ecosystem-chain-icon"></i>' : ''}
        `).join('')}</div>`;
    }

    function renderMetric(label, value, tone = 'neutral', icon = 'fa-circle-info', detail = '') {
        return `
            <div class="nc-ecosystem-metric ${tone}">
                <div class="nc-ecosystem-metric-label"><i class="fas ${icon}"></i>${esc(label)}</div>
                <div class="nc-ecosystem-metric-value">${esc(value)}</div>
                ${detail ? `<div class="nc-ecosystem-metric-detail">${esc(detail)}</div>` : ''}
            </div>`;
    }

    function updateWidget(snapshot) {
        const widget = document.getElementById('widgetEcosystem');
        const value = document.getElementById('widgetEcosystemValue');
        if (!widget || !value) return;
        const drift = getDrift(snapshot);
        const degradedSources = Object.values(asObject(snapshot.sources)).filter(source => source?.status !== 'ok').length;
        const critical = drift.some(record => ['critical', 'high'].includes(String(record.severity || '').toLowerCase()));
        const state = critical ? 'critical' : (drift.length || degradedSources ? 'attention' : 'nominal');
        value.textContent = drift.length ? `${drift.length} drift` : 'Clean';
        widget.classList.remove('nominal', 'attention', 'critical');
        widget.classList.add(state);
    }

    function renderSummary(snapshot) {
        const sources = Object.values(asObject(snapshot.sources));
        const okSources = sources.filter(source => source?.status === 'ok').length;
        const drift = getDrift(snapshot);
        const agents = asArray(snapshot.agents?.openclaw);
        const memory = asObject(snapshot.memory?.classifications);
        const memoryText = Object.entries(memory).map(([key, count]) => `${count} ${key}`).join(' / ') || '--';
        const pipelineCounts = asObject(snapshot.pipeline?.counts);
        const pipelineText = `${number(pipelineCounts.in_progress)} active / ${number(pipelineCounts.review)} review`;
        const hostSummary = asObject(snapshot.hosts?.summary);
        const hostOnline = number(hostSummary.online);
        const hostConfigured = number(hostSummary.configured);
        const hostDegraded = number(hostSummary.degraded);
        const degradedSources = sources.length - okSources;

        return `
            <div class="nc-ecosystem-summary">
                ${renderMetric('Sources', `${okSources}/${sources.length || 0}`, degradedSources ? 'warn' : 'good', 'fa-signal', degradedSources ? `${degradedSources} degraded` : 'all ok')}
                ${renderMetric('Drift', String(drift.length), drift.length ? (drift.some(d => toneForSeverity(d.severity) === 'bad') ? 'bad' : 'warn') : 'good', 'fa-triangle-exclamation', drift.length ? 'grouped below' : 'none')}
                ${renderMetric('OpenClaw Agents', String(agents.length), agents.length ? 'good' : 'warn', 'fa-satellite', 'live inventory')}
                ${renderMetric('Memory', memoryText, memory.missing ? 'warn' : 'good', 'fa-database')}
                ${renderMetric('Pipeline', pipelineText, number(pipelineCounts.blocked) ? 'bad' : 'neutral', 'fa-list-check', snapshot.pipeline?.sourceOfTruth || '')}
                ${renderMetric('Hosts', `${hostOnline}/${hostConfigured || 0}`, hostDegraded ? 'warn' : (hostOnline ? 'good' : 'bad'), 'fa-server', hostDegraded ? `${hostDegraded} degraded` : 'reachable')}
            </div>`;
    }

    function renderTopology(snapshot) {
        const hermes = snapshot.runtimes?.hermes || {};
        const openclaw = snapshot.runtimes?.openclaw || {};
        const rag = snapshot.rag || {};
        const pipeline = snapshot.pipeline || {};
        const prompts = snapshot.prompts || {};
        const schedules = snapshot.schedules || {};
        const hermesAuthority = hermes.authority || {};
        const openclawPolicy = openclaw.registryPolicy || {};
        const sourceStatuses = asObject(snapshot.sources);

        const rows = [
            {
                icon: 'fa-brain',
                name: 'Core',
                status: snapshot.status || 'unknown',
                detail: snapshot.runtimes?.core?.baseUrl || '',
                href: '/nerve-center'
            },
            {
                icon: 'fa-heart-pulse',
                name: 'Hermes',
                status: hermesAuthority.status || hermes.liveStatus?.gateway?.state || 'unknown',
                detail: hermes.expected?.model || hermes.registryPolicy?.primaryModel || '',
                href: '#sectionHermes'
            },
            {
                icon: 'fa-satellite',
                name: 'OpenClaw',
                status: sourceStatuses.openclaw?.status || 'unknown',
                detail: `${openclawPolicy.provider || '--'} / ctx ${dash(openclawPolicy.context)}`,
                href: '#sectionOpenclaw'
            },
            {
                icon: 'fa-book-open',
                name: 'RAG',
                status: rag.healthy ? 'healthy' : 'unhealthy',
                detail: `${dash(rag.documents)} docs`,
                href: '#sectionRag'
            },
            {
                icon: 'fa-scroll',
                name: 'Prompts',
                status: prompts.activeCount ? 'ready' : 'missing',
                detail: `${dash(prompts.activeCount)} active / ${dash(prompts.count)} total`,
                href: '/prompts'
            },
            {
                icon: 'fa-calendar-check',
                name: 'Schedules',
                status: sourceStatuses.schedules?.status || 'unknown',
                detail: `${dash(schedules.openclawCron?.count)} OpenClaw cron jobs`,
                href: '/cluster-schedule'
            },
            {
                icon: 'fa-list-check',
                name: 'Pipeline',
                status: sourceStatuses.pipeline?.status || 'unknown',
                detail: pipeline.sourceOfTruth || '',
                href: '#sectionTasks'
            }
        ];

        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-diagram-project"></i> Runtime Topology</h3>
                    ${chip(`generated ${shared.timeAgo(snapshot.generatedAt)}`, 'neutral', 'fa-clock')}
                </div>
                <div class="nc-ecosystem-topology">
                    ${rows.map(row => `
                        <a class="nc-ecosystem-node ${toneForStatus(row.status)}" href="${esc(row.href)}">
                            <div class="nc-ecosystem-node-icon"><i class="fas ${row.icon}"></i></div>
                            <div class="nc-ecosystem-node-copy">
                                <div class="nc-ecosystem-node-title">${esc(row.name)}</div>
                                <div class="nc-ecosystem-node-detail">${esc(row.detail || '--')}</div>
                            </div>
                            ${chip(row.status || 'unknown', toneForStatus(row.status))}
                        </a>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderSources(snapshot) {
        const sources = Object.entries(asObject(snapshot.sources));
        if (!sources.length) return '';
        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-signal"></i> Source Status</h3>
                </div>
                <div class="nc-ecosystem-source-grid">
                    ${sources.map(([name, source]) => `
                        <div class="nc-ecosystem-source">
                            <span>${esc(name)}</span>
                            ${chip(source?.status || 'unknown', toneForStatus(source?.status))}
                        </div>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderHosts(snapshot) {
        const hosts = asArray(snapshot.hosts?.capacity);
        const summary = asObject(snapshot.hosts?.summary);
        if (!hosts.length) return '';

        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-server"></i> Host Status</h3>
                    ${chip(`${number(summary.online)}/${number(summary.configured)} online`, number(summary.degraded) ? 'warn' : 'good')}
                </div>
                <div class="nc-ecosystem-host-grid">
                    ${hosts.map(host => {
                        const verdict = host.verdict || host.status || 'unknown';
                        const topModel = asArray(host.inference?.topModels)[0]?.model || asArray(host.loadedModels)[0]?.name || '';
                        const loadedCount = asArray(host.loadedModels).length;
                        return `
                            <div class="nc-ecosystem-host ${toneForStatus(verdict)}">
                                <div class="nc-ecosystem-host-head">
                                    <div>
                                        <div class="nc-ecosystem-host-name">${esc(host.hostname || host.hostId || host.configId || 'host')}</div>
                                        <div class="nc-ecosystem-subline">${esc(host.configId || host.hostId || '--')}</div>
                                    </div>
                                    ${chip(host.online ? 'online' : 'offline', host.online ? 'good' : 'bad', host.online ? 'fa-check' : 'fa-triangle-exclamation')}
                                </div>
                                <div class="nc-ecosystem-host-meta">
                                    ${chip(verdict, toneForStatus(verdict), 'fa-gauge-high')}
                                    ${host.telemetryStale ? chip('stale telemetry', 'warn', 'fa-clock') : ''}
                                    ${host.hostIdentityDrift ? chip('identity drift', 'warn', 'fa-network-wired') : ''}
                                </div>
                                <div class="nc-ecosystem-host-metrics">
                                    <span><i class="fas fa-memory"></i>${esc(formatMiB(host.vram?.usedMiB))} / ${esc(formatMiB(host.vram?.totalMiB))}</span>
                                    <span><i class="fas fa-cubes-stacked"></i>${esc(String(loadedCount))} loaded</span>
                                    <span><i class="fas fa-chart-line"></i>${esc(formatPct(host.inference?.callSharePct))} calls</span>
                                </div>
                                <div class="nc-ecosystem-subline" title="${esc(topModel)}">${esc(topModel || 'No active model sample')}</div>
                            </div>`;
                    }).join('')}
                </div>
            </section>`;
    }

    function renderAgents(snapshot) {
        const agents = asArray(snapshot.agents?.openclaw);
        const liveModels = asObject(snapshot.models?.liveModels);
        const memory = asObject(snapshot.memory?.byAgent);
        if (!agents.length) {
            return '<section class="nc-ecosystem-panel"><div class="nc-section-placeholder">No OpenClaw agents found.</div></section>';
        }

        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-users-gear"></i> Agent Matrix</h3>
                    <a href="#sectionOpenclaw" class="nc-ecosystem-link">OpenClaw Ops</a>
                </div>
                <div class="nc-ecosystem-table-wrap">
                    <table class="nc-ecosystem-table">
                        <thead>
                            <tr>
                                <th>Agent</th>
                                <th>Primary / Fallbacks</th>
                                <th>Live Model</th>
                                <th>Memory</th>
                                <th>Runtime</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${agents.map(agent => {
                                const live = liveModels[agent.id] || {};
                                const mem = memory[agent.id] || {};
                                const liveLabel = live.provider && live.model ? `${live.provider}/${live.model}` : (live.fullModel || '--');
                                return `
                                    <tr>
                                        <td>
                                            <div class="nc-ecosystem-agent-name">${esc(agent.name || agent.id)}</div>
                                            <div class="nc-ecosystem-subline">${esc(agent.id)} ${agent.default ? '/ default' : ''}</div>
                                        </td>
                                        <td>${renderModelChain(agent.model || {})}</td>
                                        <td>${modelPill(liveLabel, live.provider ? 'primary' : 'neutral')}</td>
                                        <td>${chip(mem.classification || 'unknown', toneForStatus(mem.classification), 'fa-database')}</td>
                                        <td>${chip(agent.active ? 'active' : 'inactive', agent.active ? 'good' : 'warn', agent.active ? 'fa-check' : 'fa-pause')}</td>
                                    </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </section>`;
    }

    function renderModels(snapshot) {
        const lanes = Object.values(asObject(snapshot.models?.lanes));
        const defaults = snapshot.models?.openclawDefaults || {};
        const providers = asArray(snapshot.models?.openclawProviders);
        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-layer-group"></i> Model Authority</h3>
                    <a href="/models" class="nc-ecosystem-link">Models</a>
                </div>
                <div class="nc-ecosystem-model-grid">
                    <div>
                        <div class="nc-ecosystem-block-title">AgentX Lanes</div>
                        <div class="nc-ecosystem-lane-list">
                            ${lanes.length ? lanes.map(lane => `
                                <div class="nc-ecosystem-lane">
                                    <div>
                                        <strong>${esc(lane.role || lane.taskType || 'lane')}</strong>
                                        <div class="nc-ecosystem-subline">${esc(lane.hostKey || '--')} / ctx ${esc(dash(lane.contextSize))}</div>
                                    </div>
                                    ${modelPill(lane.model || lane.taskModel, lane.pinAligned === false ? 'warn' : 'primary')}
                                </div>
                            `).join('') : '<div class="nc-muted">No runtime lanes.</div>'}
                        </div>
                    </div>
                    <div>
                        <div class="nc-ecosystem-block-title">OpenClaw Runtime Defaults</div>
                        ${renderModelChain({ primary: defaults.primary, fallbacks: defaults.fallbacks })}
                        <div class="nc-ecosystem-provider-count">${esc(providers.length)} providers configured</div>
                    </div>
                </div>
            </section>`;
    }

    function renderPromptPersona(snapshot) {
        const prompts = snapshot.prompts || {};
        const activePrompts = asArray(prompts.configs).filter(prompt => prompt.isActive).slice(0, 8);
        const frontDoor = snapshot.agents?.frontDoor || {};
        const specialists = asArray(snapshot.agents?.specialists);
        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-id-badge"></i> Prompt & Role Surface</h3>
                    <a href="/prompts" class="nc-ecosystem-link">Prompts</a>
                </div>
                <div class="nc-ecosystem-two-col">
                    <div>
                        <div class="nc-ecosystem-block-title">Front Door</div>
                        <div class="nc-ecosystem-persona">
                            <strong>${esc(frontDoor.persona || frontDoor.id || '--')}</strong>
                            ${chip(frontDoor.runtime || 'unknown', toneForStatus(frontDoor.runtime === 'openclaw' ? 'ok' : 'unknown'))}
                            <div class="nc-ecosystem-subline">${esc(asArray(frontDoor.roleDocs).join(', ') || '--')}</div>
                        </div>
                        <div class="nc-ecosystem-chip-row">
                            ${specialists.slice(0, 8).map(agent => chip(agent.id, agent.available ? 'good' : 'warn', 'fa-user-gear')).join('')}
                        </div>
                    </div>
                    <div>
                        <div class="nc-ecosystem-block-title">${esc(prompts.activeCount || 0)} active prompts / ${esc(prompts.count || 0)} total</div>
                        <div class="nc-ecosystem-prompt-list">
                            ${activePrompts.map(prompt => `
                                <div class="nc-ecosystem-prompt">
                                    <span>${esc(prompt.name)}</span>
                                    <code>v${esc(prompt.version)}</code>
                                </div>
                            `).join('') || '<div class="nc-muted">No active prompts.</div>'}
                        </div>
                    </div>
                </div>
            </section>`;
    }

    function renderMemory(snapshot) {
        const classifications = asObject(snapshot.memory?.classifications);
        const byAgent = Object.entries(asObject(snapshot.memory?.byAgent));
        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-database"></i> Memory & Index State</h3>
                    <span class="nc-ecosystem-subline">${esc(snapshot.memory?.strategy?.provider || '--')} / ${esc(snapshot.memory?.strategy?.model || '--')}</span>
                </div>
                <div class="nc-ecosystem-chip-row nc-ecosystem-memory-summary">
                    ${Object.entries(classifications).map(([name, count]) => chip(`${count} ${name}`, toneForStatus(name), 'fa-database')).join('') || chip('unknown', 'neutral')}
                </div>
                <div class="nc-ecosystem-memory-grid">
                    ${byAgent.map(([agentId, mem]) => `
                        <div class="nc-ecosystem-memory-row">
                            <span>${esc(agentId)}</span>
                            ${chip(mem.classification || 'unknown', toneForStatus(mem.classification))}
                            <span class="nc-ecosystem-subline">${esc(dash(mem.files))} files / ${esc(dash(mem.chunks))} chunks</span>
                        </div>
                    `).join('')}
                </div>
            </section>`;
    }

    function renderSchedulesPipeline(snapshot) {
        const schedules = snapshot.schedules || {};
        const cronJobs = asArray(schedules.openclawCron?.jobs);
        const clusterEntries = asArray(schedules.cluster?.entries);
        const pipeline = snapshot.pipeline || {};
        const counts = asObject(pipeline.counts);
        const active = asArray(pipeline.active).slice(0, 8);

        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-clock-rotate-left"></i> Schedules & Pipeline</h3>
                    <a href="#sectionTasks" class="nc-ecosystem-link">Host Tasks</a>
                </div>
                <div class="nc-ecosystem-two-col">
                    <div>
                        <div class="nc-ecosystem-block-title">${esc(cronJobs.length)} OpenClaw cron / ${esc(clusterEntries.length)} cluster entries</div>
                        <div class="nc-ecosystem-job-list">
                            ${cronJobs.slice(0, 8).map(job => {
                                const status = job.lastRunStatus || job.lastStatus || job.state?.lastRunStatus || 'unknown';
                                const errors = number(job.consecutiveErrors || job.state?.consecutiveErrors);
                                return `
                                    <div class="nc-ecosystem-job">
                                        <span>${esc(job.name || job.id || 'job')}</span>
                                        ${chip(errors ? `${errors} errors` : status, errors ? 'bad' : toneForStatus(status))}
                                    </div>`;
                            }).join('') || '<div class="nc-muted">No OpenClaw cron jobs.</div>'}
                        </div>
                    </div>
                    <div>
                        <div class="nc-ecosystem-count-row">
                            ${['queued', 'in_progress', 'review', 'blocked', 'done'].map(key => `
                                <div>
                                    <span>${esc(key.replace('_', ' '))}</span>
                                    <strong>${esc(dash(counts[key] || 0))}</strong>
                                </div>
                            `).join('')}
                        </div>
                        <div class="nc-ecosystem-active-list">
                            ${active.map(task => `
                                <div class="nc-ecosystem-task">
                                    <span>${esc(task.pipelineId)} ${esc(task.title || '')}</span>
                                    ${chip(task.status || 'unknown', toneForStatus(task.status))}
                                </div>
                            `).join('') || '<div class="nc-muted">No active pipeline rows.</div>'}
                        </div>
                    </div>
                </div>
            </section>`;
    }

    function renderDrift(snapshot) {
        const drift = getDrift(snapshot);
        const grouped = drift.reduce((acc, record) => {
            const key = record.severity || 'medium';
            if (!acc[key]) acc[key] = [];
            acc[key].push(record);
            return acc;
        }, {});
        const order = ['critical', 'high', 'medium', 'low', ...Object.keys(grouped).filter(key => !['critical', 'high', 'medium', 'low'].includes(key))];

        return `
            <section class="nc-ecosystem-panel">
                <div class="nc-ecosystem-panel-head">
                    <h3><i class="fas fa-triangle-exclamation"></i> Drift Ledger</h3>
                    ${chip(`${drift.length} records`, drift.length ? 'warn' : 'good')}
                </div>
                ${drift.length ? `
                    <div class="nc-ecosystem-drift-groups">
                        ${order.filter(key => grouped[key]?.length).map(key => `
                            <div class="nc-ecosystem-drift-group ${toneForSeverity(key)}">
                                <div class="nc-ecosystem-drift-heading">${esc(key)} (${grouped[key].length})</div>
                                ${grouped[key].map(record => `
                                    <div class="nc-ecosystem-drift-record">
                                        <div>
                                            <strong>${esc(record.title || record.id)}</strong>
                                            <div class="nc-ecosystem-subline">${esc(record.id || '')}${record.owner ? ` / ${esc(record.owner)}` : ''}</div>
                                        </div>
                                        <div class="nc-ecosystem-drift-values">
                                            <span>${esc(dash(record.current))}</span>
                                            <i class="fas fa-arrow-right"></i>
                                            <span>${esc(dash(record.expected))}</span>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        `).join('')}
                    </div>
                ` : '<div class="nc-ecosystem-empty">No drift records.</div>'}
            </section>`;
    }

    function render(snapshot) {
        return `
            ${renderSummary(snapshot)}
            ${renderTopology(snapshot)}
            ${renderSources(snapshot)}
            ${renderHosts(snapshot)}
            ${renderAgents(snapshot)}
            <div class="nc-ecosystem-grid">
                ${renderModels(snapshot)}
                ${renderPromptPersona(snapshot)}
                ${renderMemory(snapshot)}
                ${renderSchedulesPipeline(snapshot)}
            </div>
            ${renderDrift(snapshot)}
        `;
    }

    async function loadEcosystem() {
        const body = document.getElementById('sectionEcosystemBody');
        if (!body) return;
        const hasRendered = body.dataset.ecosystemLoaded === 'true';
        if (!hasRendered) {
            body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading ecosystem map...</div>';
        }

        try {
            const response = await shared.fetchJson('/api/nerve-center/ecosystem');
            const snapshot = response.data || response;
            updateWidget(snapshot);
            body.innerHTML = render(snapshot);
            body.dataset.ecosystemLoaded = 'true';
            body.dataset.ecosystemError = '';
        } catch (err) {
            const widget = document.getElementById('widgetEcosystem');
            const value = document.getElementById('widgetEcosystemValue');
            if (widget && value) {
                value.textContent = hasRendered ? 'Stale' : 'Error';
                widget.classList.remove('nominal', 'attention', 'critical');
                widget.classList.add(hasRendered ? 'attention' : 'critical');
            }
            body.dataset.ecosystemError = err.message;
            if (!hasRendered) {
                body.innerHTML = `<div class="nc-section-placeholder" style="color:#f87171;"><i class="fas fa-triangle-exclamation"></i> ${esc(err.message)}</div>`;
            }
        }

        if (!refreshTimer) {
            refreshTimer = setInterval(loadEcosystem, REFRESH_MS);
        }
    }

    window.NerveCenterEcosystem = { loadEcosystem };
})();

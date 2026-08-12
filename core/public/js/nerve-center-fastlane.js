(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    if (!shared) return;

    const API = '/api/nerve-center/fastlane';

    function esc(value) {
        return shared.escapeHtml(value == null ? '' : String(value));
    }

    function valueOrDash(value) {
        if (value == null || value === '') return '--';
        return String(value);
    }

    async function apiGet(url) {
        const response = await fetch(url);
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(json.message || json.error || `Request failed (${response.status})`);
        }
        return json.data ?? json;
    }

    function badge(label, tone = 'neutral', icon = 'fa-circle') {
        return `<span class="nc-fastlane-badge ${tone}"><i class="fas ${icon}"></i>${esc(label)}</span>`;
    }

    function liveBudgetTone(budget) {
        const health = String(budget?.budget_health || '').toLowerCase();
        if (health === 'green') return 'good';
        if (health === 'yellow') return 'warn';
        if (health === 'red') return 'blocked';
        return 'neutral';
    }

    function boolTone(enabled) {
        return enabled ? 'good' : 'warn';
    }

    function stateIcon(tone) {
        if (tone === 'good') return 'fa-check';
        if (tone === 'warn') return 'fa-triangle-exclamation';
        if (tone === 'blocked') return 'fa-ban';
        return 'fa-circle-info';
    }

    function renderModelChain(model = {}) {
        const chain = [model.primary, ...(model.fallbacks || [])].filter(Boolean);
        if (chain.length === 0) return '<span class="nc-fastlane-muted">--</span>';
        return chain.map((item, index) => `
            <span class="nc-fastlane-model">${esc(shared.shortModel(item))}</span>
            ${index < chain.length - 1 ? '<i class="fas fa-chevron-right nc-fastlane-chain-icon"></i>' : ''}
        `).join('');
    }

    function renderFlow() {
        const steps = [
            { icon: 'fa-comment-dots', label: 'Turn', value: 'Playground / OpenClaw Main' },
            { icon: 'fa-user-tie', label: 'Front Door', value: 'Nestor' },
            { icon: 'fa-code-branch', label: 'Disposition', value: 'Answer/Do + Light/Heavy' },
            { icon: 'fa-shield-halved', label: 'Gates', value: 'RAG, MCP, budget, TODO' },
            { icon: 'fa-arrow-right-to-bracket', label: 'Path', value: 'Local answer, specialist, skill, or task' }
        ];

        return `
            <div class="nc-fastlane-flow">
                ${steps.map((step, index) => `
                    <div class="nc-fastlane-flow-node">
                        <div class="nc-fastlane-flow-icon"><i class="fas ${step.icon}"></i></div>
                        <div>
                            <div class="nc-fastlane-kicker">${esc(step.label)}</div>
                            <div class="nc-fastlane-flow-value">${esc(step.value)}</div>
                        </div>
                    </div>
                    ${index < steps.length - 1 ? '<div class="nc-fastlane-flow-arrow"><i class="fas fa-chevron-right"></i></div>' : ''}
                `).join('')}
            </div>`;
    }

    function renderDisposition(item) {
        const tone = item.state || 'neutral';
        return `
            <div class="nc-fastlane-disposition ${tone}">
                <div class="nc-fastlane-disposition-head">
                    <span class="nc-fastlane-axis">${esc(item.axis)} / ${esc(item.weight)}</span>
                    ${badge(item.status || '--', tone, stateIcon(tone))}
                </div>
                <div class="nc-fastlane-disposition-title">${esc(item.label)}</div>
                <div class="nc-fastlane-route">${esc(item.route)}</div>
                <div class="nc-fastlane-mode">${esc(item.mode || '')}</div>
                <div class="nc-fastlane-chip-row">
                    ${(item.sideFeatures || []).map(feature => `<span class="nc-fastlane-chip">${esc(feature)}</span>`).join('')}
                </div>
            </div>`;
    }

    function renderFeatureCards(config) {
        const controls = config.controls || {};
        const rag = controls.ragReflex || {};
        const mcp = controls.mcpSkillBus || {};
        const memory = controls.memory || {};
        const todo = controls.todoMembrane || {};
        const budget = controls.budgetGate || {};

        const features = [
            {
                icon: 'fa-magnifying-glass',
                title: 'RAG Reflex',
                tone: boolTone(rag.enabled),
                status: rag.enabled ? 'enabled' : 'flag off',
                primary: `topK ${valueOrDash(rag.topK)} / ${valueOrDash(rag.timeoutMs)}ms`,
                secondary: (rag.surfaces || []).join(', ') || '--'
            },
            {
                icon: 'fa-plug',
                title: 'MCP Skill Bus',
                tone: mcp.tokenConfigured ? 'good' : 'warn',
                status: mcp.tokenConfigured ? 'token set' : 'token missing',
                primary: mcp.endpoint || '--',
                secondary: (mcp.tools || []).join(', ') || '--'
            },
            {
                icon: 'fa-database',
                title: 'Memory Ingest',
                tone: 'good',
                status: 'available',
                primary: memory.writeEndpoint || '--',
                secondary: `RAG timeout ${valueOrDash(memory.ragTimeoutMs)}ms`
            },
            {
                icon: 'fa-list-check',
                title: 'Pipeline Membrane',
                tone: 'good',
                status: 'available',
                primary: todo.endpoint || '--',
                secondary: `${todo.sourceOfTruth || todo.collection || 'mongodb:pipelinetasks'} / ${todo.humanBoard || todo.board || 'Leantime AgentX Pipeline'}`
            },
            {
                icon: 'fa-cloud',
                title: 'Budget Gate',
                tone: 'neutral',
                status: 'policy gate',
                primary: budget.recommendationEndpoint || '--',
                secondary: Object.entries(budget.policy || {}).map(([key, val]) => `${key}: ${val}`).join(' / ')
            }
        ];

        return `
            <div class="nc-fastlane-feature-grid">
                ${features.map(feature => `
                    <div class="nc-fastlane-feature ${feature.tone}">
                        <div class="nc-fastlane-feature-head">
                            <i class="fas ${feature.icon}"></i>
                            <div>
                                <div class="nc-fastlane-feature-title">${esc(feature.title)}</div>
                                <div class="nc-fastlane-feature-status">${esc(feature.status)}</div>
                            </div>
                        </div>
                        <div class="nc-fastlane-feature-primary">${esc(feature.primary)}</div>
                        <div class="nc-fastlane-feature-secondary">${esc(feature.secondary)}</div>
                    </div>
                `).join('')}
            </div>`;
    }

    function renderSpecialists(config) {
        const specialists = config.specialists || [];
        if (specialists.length === 0) {
            return '<div class="nc-fastlane-empty">No Answer-Heavy specialists configured.</div>';
        }

        return `
            <div class="nc-fastlane-specialists">
                ${specialists.map(agent => `
                    <div class="nc-fastlane-specialist">
                        <div class="nc-fastlane-specialist-head">
                            <strong>${esc(agent.id)}</strong>
                            ${badge(agent.available ? 'registered' : 'missing', agent.available ? 'good' : 'warn', agent.available ? 'fa-check' : 'fa-triangle-exclamation')}
                        </div>
                        <div class="nc-fastlane-meta">${esc(agent.type)}${agent.runtime ? ` / ${esc(agent.runtime)}` : ''}</div>
                        <div class="nc-fastlane-model-row">${renderModelChain(agent.model || {})}</div>
                        ${agent.boundary ? `<div class="nc-fastlane-boundary">${esc(agent.boundary)}</div>` : ''}
                    </div>
                `).join('')}
            </div>`;
    }

    function renderConfigTable(config) {
        const rows = config.configRows || [];
        if (rows.length === 0) {
            return '<div class="nc-fastlane-empty">No Fastlane config rows available.</div>';
        }

        return `
            <div class="nc-fastlane-table-wrap">
                <table class="nc-fastlane-config-table">
                    <thead>
                        <tr>
                            <th>Group</th>
                            <th>Key</th>
                            <th>Value</th>
                            <th>Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(row => `
                            <tr>
                                <td>${esc(row.group)}</td>
                                <td>${esc(row.key)}</td>
                                <td>${esc(valueOrDash(row.value))}</td>
                                <td><code>${esc(row.source || '--')}</code></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function renderWarnings(config) {
        const warnings = config.warnings || [];
        if (warnings.length === 0) return '';
        return `
            <div class="nc-fastlane-warning">
                <i class="fas fa-triangle-exclamation"></i>
                <div>${warnings.map(warning => `<div>${esc(warning)}</div>`).join('')}</div>
            </div>`;
    }

    function renderLivePanel(config, budget, openclaw) {
        const controls = config.controls || {};
        const rag = controls.ragReflex || {};
        const mcp = controls.mcpSkillBus || {};
        const budgetTone = budget?.error ? 'warn' : liveBudgetTone(budget);
        const budgetLabel = budget?.error
            ? 'budget unavailable'
            : `${valueOrDash(budget?.budget_health).toUpperCase()} / ${valueOrDash(budget?.escalation?.recommendation)}`;
        const openclawTone = openclaw?.status === 'online' ? 'good' : 'warn';
        const openclawLabel = openclaw?.error ? 'OpenClaw unavailable' : `OpenClaw ${valueOrDash(openclaw?.status)}`;

        return `
            <div class="nc-fastlane-live-panel">
                <div class="nc-fastlane-panel-title">Live Gates</div>
                <div class="nc-fastlane-live-list">
                    ${badge(budgetLabel, budgetTone, stateIcon(budgetTone))}
                    ${badge(rag.enabled ? 'RAG reflex on' : 'RAG reflex off', boolTone(rag.enabled), 'fa-brain')}
                    ${badge(mcp.tokenConfigured ? 'MCP token set' : 'MCP token missing', mcp.tokenConfigured ? 'good' : 'warn', 'fa-key')}
                    ${badge(openclawLabel, openclawTone, openclawTone === 'good' ? 'fa-satellite-dish' : 'fa-triangle-exclamation')}
                    ${badge(config.uiPolicy?.mode === 'read_only' ? 'UI read-only' : config.uiPolicy?.mode || 'UI mode unknown', 'neutral', 'fa-lock')}
                </div>
                <div class="nc-fastlane-live-foot">${esc(config.uiPolicy?.reason || '')}</div>
            </div>`;
    }

    function updateFastlaneWidget(config, budget) {
        const widget = document.getElementById('widgetFastlane');
        const valueEl = document.getElementById('widgetFastlaneValue');
        if (!widget || !valueEl) return;

        const health = budget?.budget_health ? String(budget.budget_health).toUpperCase() : '';
        const ragEnabled = Boolean(config.controls?.ragReflex?.enabled);
        const nextValue = health || (ragEnabled ? 'READY' : 'GATED');
        const tone = budget?.budget_health === 'red' ? 'attention' : 'nominal';

        const oldValue = valueEl.textContent;
        valueEl.textContent = nextValue;
        widget.classList.remove('nominal', 'attention', 'critical');
        widget.classList.add(tone);
        if (oldValue !== nextValue && oldValue !== '--') {
            widget.classList.remove('pulse');
            void widget.offsetWidth;
            widget.classList.add('pulse');
        }
    }

    function renderFastlane(body, config, budget, openclaw) {
        const frontDoor = config.frontDoor || {};
        const dispositions = config.routingModel?.dispositions || [];
        const runtime = config.controls?.openclawRuntime || {};

        body.innerHTML = `
            <div class="nc-fastlane-shell">
                ${renderWarnings(config)}
                <div class="nc-fastlane-overview">
                    <div class="nc-fastlane-frontdoor">
                        <div class="nc-fastlane-frontdoor-main">
                            <div class="nc-fastlane-avatar"><i class="fas fa-user-tie"></i></div>
                            <div>
                                <div class="nc-fastlane-kicker">OpenClaw front door</div>
                                <div class="nc-fastlane-title">${esc(frontDoor.persona || 'Nestor')}</div>
                                <div class="nc-fastlane-subline">${esc(frontDoor.type || 'openclaw_front_door')} / ${esc(runtime.host || frontDoor.runtime || 'openclaw')}</div>
                            </div>
                        </div>
                        <div class="nc-fastlane-model-chain">${renderModelChain(frontDoor.model || {})}</div>
                        ${frontDoor.boundary ? `<div class="nc-fastlane-boundary">${esc(frontDoor.boundary)}</div>` : ''}
                    </div>
                    ${renderLivePanel(config, budget, openclaw)}
                </div>

                ${renderFlow()}

                <div>
                    <div class="nc-fastlane-panel-title">2-Level Routing Matrix</div>
                    <div class="nc-fastlane-matrix">
                        ${dispositions.map(renderDisposition).join('')}
                    </div>
                </div>

                <div class="nc-fastlane-two-col">
                    <div class="nc-fastlane-panel">
                        <div class="nc-fastlane-panel-title">Side Features</div>
                        ${renderFeatureCards(config)}
                    </div>
                    <div class="nc-fastlane-panel">
                        <div class="nc-fastlane-panel-title">Answer-Heavy Specialists</div>
                        ${renderSpecialists(config)}
                    </div>
                </div>

                <div class="nc-fastlane-panel">
                    <div class="nc-fastlane-panel-title">Config Surface</div>
                    ${renderConfigTable(config)}
                </div>
            </div>`;
    }

    async function loadFastlane() {
        const body = document.getElementById('sectionFastlaneBody');
        if (!body) return;

        body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading Nestor Fastlane config...</div>';

        try {
            const [config, budget, openclaw] = await Promise.all([
                apiGet(API),
                apiGet('/api/budget/escalation-recommendation').catch(err => ({ error: err.message })),
                apiGet('/api/openclaw/status').catch(err => ({ error: err.message }))
            ]);
            renderFastlane(body, config, budget, openclaw);
            updateFastlaneWidget(config, budget);
        } catch (err) {
            console.error('[NerveCenter] loadFastlane failed', err);
            body.innerHTML = `<div class="nc-section-placeholder" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i> Failed to load Fastlane config: ${esc(err.message)}</div>`;
        }
    }

    function bindControls() {
        const button = document.getElementById('btnRefreshFastlane');
        if (!button || button.dataset.fastlaneBound === 'true') return;
        button.dataset.fastlaneBound = 'true';
        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            button.disabled = true;
            try {
                await loadFastlane();
                if (window.Toast) window.Toast.success('Nestor Fastlane refreshed');
            } catch (err) {
                if (window.Toast) window.Toast.error(`Fastlane refresh failed: ${err.message}`);
            } finally {
                button.disabled = false;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindControls);
    } else {
        bindControls();
    }

    window.NerveCenterFastlane = { loadFastlane };
})();

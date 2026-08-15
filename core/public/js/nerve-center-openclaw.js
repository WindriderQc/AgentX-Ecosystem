(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    if (!shared) return;

    const API = '/api/openclaw';
    const REFRESH_MS = 15_000;

    let refreshTimer = null;
    let runtimeConfig = null;

    async function apiGet(path) {
        const response = await fetch(`${API}${path}`);
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(json.message || `Request failed (${response.status})`);
        }
        return json.data ?? json;
    }

    async function loadRuntimeConfig() {
        try {
            const response = await fetch('/api/config');
            if (!response.ok) {
                runtimeConfig = {};
                return runtimeConfig;
            }
            const json = await response.json();
            runtimeConfig = json?.features?.openclaw || {};
            return runtimeConfig;
        } catch (_err) {
            runtimeConfig = runtimeConfig || {};
            return runtimeConfig;
        }
    }

    function getControlUiUrl() {
        return runtimeConfig?.controlUi?.launchBaseUrl || '/agent-ops';
    }

    function getGatewayUrl() {
        return runtimeConfig?.gatewayUrl || '';
    }

    function countModels(models) {
        if (Array.isArray(models?.configuredModels)) return models.configuredModels.length;
        if (Array.isArray(models?.models)) return models.models.length;
        const providers = models?.providers || {};
        return Object.values(providers).reduce((count, provider) => count + (provider.models?.length || 0), 0);
    }

    function renderState(body, opts) {
        const {
            statusClass = 'offline',
            statusLabel,
            statusDetail,
            agents = '--',
            sessions = '--',
            channels = '--',
            models = '--',
            latency = '--',
            messageTitle,
            messageBody
        } = opts;

        body.innerHTML = `
            <div class="nc-openclaw-banner">
                <div class="nc-openclaw-status">
                    <span class="nc-status-dot ${statusClass}"></span>
                    <div class="nc-openclaw-status-copy">
                        <div class="nc-openclaw-status-label">${shared.escapeHtml(statusLabel)}</div>
                        <div class="nc-openclaw-status-detail">${shared.escapeHtml(statusDetail)}</div>
                    </div>
                </div>
                <div class="nc-openclaw-badges">
                    <span class="nc-openclaw-badge"><i class="fas fa-robot"></i> Agents <strong>${shared.escapeHtml(agents)}</strong></span>
                    <span class="nc-openclaw-badge"><i class="fas fa-bolt"></i> Sessions <strong>${shared.escapeHtml(sessions)}</strong></span>
                    <span class="nc-openclaw-badge"><i class="fas fa-clock"></i> Latency <strong>${shared.escapeHtml(latency)}</strong></span>
                </div>
            </div>

            <div class="nc-openclaw-stats">
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Agents</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(agents)}</div>
                </div>
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Active Sessions</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(sessions)}</div>
                </div>
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Channels</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(channels)}</div>
                </div>
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Models</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(models)}</div>
                </div>
            </div>

            <div class="nc-openclaw-note">
                <div class="nc-openclaw-note-title">${shared.escapeHtml(messageTitle)}</div>
                <p>${shared.escapeHtml(messageBody)}</p>
                <div class="nc-openclaw-actions">
                    <a href="${shared.escapeHtml(getControlUiUrl())}" target="_blank" rel="noopener" class="nc-btn nc-openclaw-link">
                        <i class="fas fa-arrow-up-right-from-square"></i> Open official Control UI
                    </a>
                </div>
            </div>
        `;
    }

    function renderDisabled(body) {
        renderState(body, {
            statusClass: 'offline',
            statusLabel: 'Integration Disabled',
            statusDetail: 'AgentX is not configured to expose OpenClaw operations.',
            messageTitle: 'OpenClaw integration is turned off for this AgentX instance.',
            messageBody: 'Enable AGENTX_OPENCLAW_ENABLED=1 or provide an OpenClaw gateway URL and token, then restart agentx-core.'
        });
    }

    function renderOffline(body, errorMessage = '') {
        const gatewayUrl = getGatewayUrl();
        const target = gatewayUrl || 'the configured OpenClaw gateway';
        const detail = errorMessage ? `${target} - ${errorMessage}` : `Checking ${target}`;
        renderState(body, {
            statusClass: 'offline',
            statusLabel: 'Gateway Offline',
            statusDetail: detail,
            messageTitle: 'OpenClaw Gateway is offline.',
            messageBody: 'Make sure the configured gateway and runtime are reachable from AgentX.'
        });
    }

    function renderOnline(body, status, counts) {
        const gatewayUrl = getGatewayUrl();
        const statusUrl = status.gateway?.url || '';
        const displayUrl = gatewayUrl || (statusUrl.includes('127.0.0.1') || statusUrl.includes('localhost') ? '' : statusUrl);
        renderState(body, {
            statusClass: 'online',
            statusLabel: 'Gateway Online',
            statusDetail: displayUrl
                ? `${displayUrl}${status.gateway?.latencyMs != null ? ` - ${status.gateway.latencyMs}ms` : ''}`
                : 'Gateway reachable',
            agents: String(counts.agents),
            sessions: String(counts.sessions),
            channels: String(counts.channels),
            models: String(counts.models),
            latency: status.gateway?.latencyMs != null ? `${status.gateway.latencyMs}ms` : '--',
            messageTitle: 'AgentX shows the runtime summary here.',
            messageBody: 'For sessions, skills, configuration, usage, logs and diagnostics, jump to the official OpenClaw Control UI.'
        });
    }

    async function loadOpenclaw() {
        const body = document.getElementById('sectionOpenclawBody');
        if (!body) return;

        if (runtimeConfig === null) {
            await loadRuntimeConfig();
        }

        if (runtimeConfig && runtimeConfig.enabled === false) {
            renderDisabled(body);
            return;
        }

        try {
            const status = await apiGet('/status');
            if (status.status !== 'online') {
                renderOffline(body, status.gateway?.error || '');
            } else {
                const [agents, sessions, channels, models] = await Promise.all([
                    apiGet('/agents').catch(() => []),
                    apiGet('/sessions').catch(() => []),
                    apiGet('/channels').catch(() => []),
                    apiGet('/models').catch(() => ({}))
                ]);

                renderOnline(body, status, {
                    agents: Array.isArray(agents) ? agents.length : 0,
                    sessions: Array.isArray(sessions) ? sessions.length : 0,
                    channels: Array.isArray(channels) ? channels.length : 0,
                    models: countModels(models)
                });
            }
        } catch (err) {
            renderOffline(body, err.message);
        }

        if (!refreshTimer) {
            refreshTimer = setInterval(loadOpenclaw, REFRESH_MS);
        }
    }

    window.NerveCenterOpenclaw = { loadOpenclaw };
})();

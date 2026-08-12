(function () {
    'use strict';

    const shared = window.NerveCenterShared;
    if (!shared) return;

    const API = '/api/hermes';
    const REFRESH_MS = 15_000;

    let refreshTimer = null;
    let dashboardUrl = '';

    async function loadRuntimeConfig() {
        try {
            const response = await fetch('/api/config');
            if (!response.ok) return;
            const json = await response.json();
            dashboardUrl = json?.publicUrls?.hermes || '';
        } catch (_err) {
            dashboardUrl = dashboardUrl || '';
        }
    }

    async function apiGet(path) {
        const response = await fetch(`${API}${path}`);
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(json.error || json.message || `Request failed (${response.status})`);
        }
        return json.data ?? json;
    }

    function render(body, opts) {
        const {
            statusClass,
            statusLabel,
            statusDetail,
            version = '--',
            sessions = '--',
            gateway = '--',
            latency = '--',
            messageTitle,
            messageBody
        } = opts;

        body.innerHTML = `
            <div class="nc-openclaw-banner nc-hermes-banner">
                <div class="nc-openclaw-status">
                    <span class="nc-status-dot ${statusClass}"></span>
                    <div class="nc-openclaw-status-copy">
                        <div class="nc-openclaw-status-label">${shared.escapeHtml(statusLabel)}</div>
                        <div class="nc-openclaw-status-detail">${shared.escapeHtml(statusDetail)}</div>
                    </div>
                </div>
                <div class="nc-openclaw-badges">
                    <span class="nc-openclaw-badge"><i class="fas fa-code-branch"></i> Version <strong>${shared.escapeHtml(version)}</strong></span>
                    <span class="nc-openclaw-badge"><i class="fas fa-bolt"></i> Sessions <strong>${shared.escapeHtml(sessions)}</strong></span>
                    <span class="nc-openclaw-badge"><i class="fas fa-clock"></i> Latency <strong>${shared.escapeHtml(latency)}</strong></span>
                </div>
            </div>

            <div class="nc-openclaw-stats">
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Dashboard</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(dashboardUrl ? 'Online' : 'Unset')}</div>
                </div>
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Gateway</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(gateway)}</div>
                </div>
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Sessions</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(sessions)}</div>
                </div>
                <div class="nc-host-card">
                    <div class="nc-muted nc-openclaw-stat-label">Version</div>
                    <div class="nc-openclaw-stat-value">${shared.escapeHtml(version)}</div>
                </div>
            </div>

            <div class="nc-openclaw-note">
                <div class="nc-openclaw-note-title">${shared.escapeHtml(messageTitle)}</div>
                <p>${shared.escapeHtml(messageBody)}</p>
                <div class="nc-openclaw-actions">
                    ${dashboardUrl ? `
                        <a href="${shared.escapeHtml(dashboardUrl)}" target="_blank" rel="noopener" class="nc-btn nc-openclaw-link">
                            <i class="fas fa-arrow-up-right-from-square"></i> Open Hermes Dashboard
                        </a>
                    ` : ''}
                </div>
            </div>
        `;
    }

    function renderOffline(body, detail) {
        render(body, {
            statusClass: 'offline',
            statusLabel: 'Dashboard Offline',
            statusDetail: detail || 'Hermes dashboard is not reachable from AgentX.',
            messageTitle: 'Hermes dashboard is not available.',
            messageBody: 'Start the Hermes dashboard on the runtime host and set HERMES_PUBLIC_URL for AgentX.'
        });
    }

    async function loadHermes() {
        const body = document.getElementById('sectionHermesBody');
        if (!body) return;

        if (!dashboardUrl) await loadRuntimeConfig();

        try {
            const status = await apiGet('/status');
            const gatewayRunning = Boolean(status.gateway?.running);
            render(body, {
                statusClass: status.ok ? (gatewayRunning ? 'online' : 'degraded') : 'offline',
                statusLabel: status.ok ? 'Dashboard Online' : 'Dashboard Offline',
                statusDetail: status.dashboard?.url || dashboardUrl || 'Hermes URL unavailable',
                version: status.hermes?.version || '--',
                sessions: String(status.hermes?.activeSessions ?? 0),
                gateway: gatewayRunning ? 'Running' : 'Stopped',
                latency: status.dashboard?.latencyMs != null ? `${status.dashboard.latencyMs}ms` : '--',
                messageTitle: gatewayRunning ? 'Hermes gateway is running.' : 'Hermes gateway is stopped.',
                messageBody: gatewayRunning
                    ? 'Hermes dashboard and messaging gateway are available from AgentX.'
                    : (status.gateway?.exitReason || 'Dashboard is up, but the messaging gateway is not running.')
            });
        } catch (err) {
            renderOffline(body, err.message);
        }

        if (!refreshTimer) {
            refreshTimer = setInterval(loadHermes, REFRESH_MS);
        }
    }

    window.NerveCenterHermes = { loadHermes };
})();

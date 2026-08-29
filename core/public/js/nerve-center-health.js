(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    async function loadHealth() {
        const body = document.getElementById('sectionHealthBody');
        if (!body) return;

        shared.renderSectionLoading(body, 'Loading health data...');

        try {
            const json = await shared.fetchJson('/api/nerve-center/health/feed?limit=30');
            const events = json.data || [];
            const feedMeta = json.meta || {};

            const pinned = events.filter(event => event.type === 'alert' && event.status === 'active');
            const rest = events.filter(event => !(event.type === 'alert' && event.status === 'active'));

            const renderEvent = (event, isPinned) => {
                const severity = event.severity || 'info';
                const pinStyle = ` style="display:block;${isPinned ? 'border-left:3px solid #f59e0b;' : ''}"`;
                const groupedCount = Number(event.groupedCount) || 1;
                const occurrenceCount = Number(event.occurrenceCount) || 1;
                const evidenceBits = [];
                if (occurrenceCount > 1) evidenceBits.push(`${occurrenceCount} occurrences`);
                if (groupedCount > 1) evidenceBits.push(`${groupedCount} persisted rows grouped`);
                const descBits = [event.description, event.ruleName ? `rule: ${event.ruleName}` : '']
                    .concat(evidenceBits)
                    .filter(Boolean).join(' · ');
                const descLine = descBits
                    ? `<div style="font-size:0.72rem;color:var(--muted);margin:2px 0 0 20px;">${shared.escapeHtml(descBits)}</div>`
                    : '';
                const statusLabel = isPinned
                    ? 'ACTIVE'
                    : (event.type === 'alert' ? (event.status || 'history') : (event.outcome || event.status || 'history'));
                return `<div class="nc-event-item"${pinStyle}>
                    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                        <span class="nc-event-severity ${severity}"></span>
                        <span class="nc-event-time">${shared.timeAgo(event.timestamp)}</span>
                        <span style="flex:1;">${shared.escapeHtml(event.title || '--')}</span>
                        <span style="font-size:0.7rem;color:${isPinned ? '#f59e0b' : 'var(--muted)'};background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;white-space:nowrap;">${shared.escapeHtml(String(statusLabel).toUpperCase())}</span>
                        <span style="font-size:0.7rem;color:var(--muted);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;white-space:nowrap;">${shared.escapeHtml(event.source || '')}</span>
                    </div>${descLine}
                </div>`;
            };

            const feedRows = pinned.map(event => renderEvent(event, true)).concat(rest.map(event => renderEvent(event, false)));
            const activeAlertCount = Number.isFinite(Number(feedMeta.activeAlertCount))
                ? Number(feedMeta.activeAlertCount)
                : pinned.length;
            const groupedRows = Number(feedMeta.groupedRows) || 0;
            const feedContext = `<div class="nc-host-card" role="status" style="margin-bottom:10px;padding:10px;border-left:3px solid ${activeAlertCount > 0 ? '#f59e0b' : '#4ade80'}">
                <strong style="color:${activeAlertCount > 0 ? '#f59e0b' : '#4ade80'}">${activeAlertCount} ACTIVE ${activeAlertCount === 1 ? 'ALERT' : 'ALERTS'}</strong>
                <span class="nc-muted" style="margin-left:8px">The feed below includes labelled history${groupedRows > 0 ? ` · ${groupedRows} repeated persisted rows grouped` : ''}.</span>
            </div>`;
            const feedHtml = feedRows.length > 0
                ? `${feedContext}<div class="nc-event-list" style="max-height:400px;overflow-y:auto;">${feedRows.join('')}</div>`
                : `${feedContext}<div class="nc-section-placeholder" style="padding:20px;text-align:center;color:var(--muted);">No health events</div>`;

            const column = (accent, title, icon, items) => `
                <div style="background:rgba(255,255,255,0.02);border:1px solid var(--panel-border);border-radius:8px;padding:14px;border-top:3px solid ${accent};">
                    <div style="font-size:0.8rem;font-weight:700;margin-bottom:8px;"><i class="fas ${icon}" style="color:${accent};margin-right:6px;"></i>${title}</div>
                    <ul style="list-style:none;padding:0;margin:0;font-size:0.8rem;color:var(--muted);">${items.map(item => `<li style="margin:4px 0;">${shared.escapeHtml(item)}</li>`).join('')}</ul>
                </div>`;

            const healingHtml = `
                <div style="margin-top:20px;">
                    <h4 style="font-size:0.9rem;margin-bottom:12px;">Self-Healing Capabilities</h4>
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
                        ${column('#4ade80', 'Automated', 'fa-check-circle', ['Host failover', 'GPU pin reload', 'Notifications'])}
                        ${column('#f59e0b', 'Detection Only', 'fa-eye', ['Host health monitoring', 'Benchmark anomaly detection', 'VRAM tracking'])}
                        ${column('#f87171', 'Manual', 'fa-hand-paper', ['Service restart', 'Cluster rebalance', 'Model reload'])}
                    </div>
                </div>`;

            body.innerHTML = `${feedHtml}${healingHtml}`;
        } catch (err) {
            console.error('[NerveCenter] loadHealth error:', err);
            shared.renderSectionError(body, 'Failed to load health data');
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterHealth = { loadHealth };
})();

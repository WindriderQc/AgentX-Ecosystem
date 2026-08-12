(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    async function loadHealth() {
        const body = document.getElementById('sectionHealthBody');
        if (!body) return;

        body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading health data...</div>';

        try {
            const json = await shared.fetchJson('/api/nerve-center/health/feed?limit=30');
            const events = json.data || [];

            const pinned = events.filter(event => event.type === 'alert' && event.status === 'active');
            const rest = events.filter(event => !(event.type === 'alert' && event.status === 'active'));

            const renderEvent = (event, isPinned) => {
                const severity = event.severity || 'info';
                const pinStyle = ` style="display:block;${isPinned ? 'border-left:3px solid #f59e0b;' : ''}"`;
                const descBits = [event.description, event.ruleName ? `rule: ${event.ruleName}` : '']
                    .filter(Boolean).join(' · ');
                const descLine = descBits
                    ? `<div style="font-size:0.72rem;color:var(--muted);margin:2px 0 0 20px;">${shared.escapeHtml(descBits)}</div>`
                    : '';
                return `<div class="nc-event-item"${pinStyle}>
                    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                        <span class="nc-event-severity ${severity}"></span>
                        <span class="nc-event-time">${shared.timeAgo(event.timestamp)}</span>
                        <span style="flex:1;">${shared.escapeHtml(event.title || '--')}</span>
                        <span style="font-size:0.7rem;color:var(--muted);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;white-space:nowrap;">${shared.escapeHtml(event.source || '')}</span>
                    </div>${descLine}
                </div>`;
            };

            const feedRows = pinned.map(event => renderEvent(event, true)).concat(rest.map(event => renderEvent(event, false)));
            const feedHtml = feedRows.length > 0
                ? `<div class="nc-event-list" style="max-height:400px;overflow-y:auto;">${feedRows.join('')}</div>`
                : '<div class="nc-section-placeholder" style="padding:20px;text-align:center;color:var(--muted);">No health events</div>';

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
            body.innerHTML = '<div class="nc-section-placeholder" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i> Failed to load health data</div>';
        }
    }

    window.NerveCenterHealth = { loadHealth };
})();

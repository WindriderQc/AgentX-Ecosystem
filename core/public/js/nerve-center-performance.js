(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    async function loadPerformance() {
        const body = document.getElementById('sectionPerformanceBody');
        if (!body) return;

        body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading performance data...</div>';

        let html = '';

        try {
            const baselineJson = await shared.fetchJson('/api/performance/baselines');
            const baselines = baselineJson.data?.baselines || [];
            if (baselines.length > 0) {
                html += '<div><h4 style="margin:0 0 6px;color:var(--text-primary)"><i class="fas fa-ruler-horizontal"></i> Latency Baselines</h4>';
                html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem"><thead><tr style="border-bottom:1px solid var(--border)">';
                html += '<th style="text-align:left;padding:4px 8px">Name</th><th>Avg (ms)</th><th>P95 (ms)</th><th>RPS</th><th>Err%</th><th>Status</th></tr></thead><tbody>';
                baselines.forEach(baseline => {
                    const metrics = baseline.metrics || {};
                    const active = baseline.active
                        ? '<span style="color:var(--success)" title="Active baseline"><i class="fas fa-circle"></i></span>'
                        : '<span style="color:var(--muted)"><i class="far fa-circle"></i></span>';
                    html += `<tr style="border-bottom:1px solid var(--border-subtle)"><td style="padding:4px 8px">${shared.escapeHtml(baseline.name)}</td>`;
                    html += `<td style="text-align:center">${metrics.avg_response_time ?? '--'}</td>`;
                    html += `<td style="text-align:center">${metrics.p95_latency ?? '--'}</td>`;
                    html += `<td style="text-align:center">${metrics.throughput_rps ?? '--'}</td>`;
                    html += `<td style="text-align:center">${metrics.error_rate ?? '--'}</td>`;
                    html += `<td style="text-align:center">${active} ${baseline.active ? '→' : ''}</td></tr>`;
                });
                html += '</tbody></table></div>';
            } else {
                html += '<p style="color:#585f73;font-style:italic">No baseline data available</p>';
            }
        } catch (_) {
            html += '<p style="color:#585f73;font-style:italic">No baseline data available</p>';
        }

        body.innerHTML = html || '<div class="nc-section-placeholder" style="color:var(--muted)"><i class="fas fa-chart-line"></i> No performance data available</div>';
    }

    window.NerveCenterPerformance = { loadPerformance };
})();

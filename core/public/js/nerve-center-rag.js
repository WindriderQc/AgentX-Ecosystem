(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    if (!shared) return;

    let refreshTimer = null;

    async function loadRag() {
        const body = document.getElementById('nc-rag-body');
        if (!body) return;

        try {
            const [statusRes, docsRes] = await Promise.all([
                shared.fetchJson('/api/nerve-center/rag/status'),
                shared.fetchJson('/api/nerve-center/rag/documents?limit=15'),
            ]);

            const status = statusRes.data || {};
            const docs = docsRes.data || {};
            const deps = status.dependencies || {};
            const cache = status.cache || {};

            // Health strip
            let html = `
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
                    <div class="nc-host-card" style="padding:12px">
                        <div class="nc-muted" style="font-size:0.8em;text-transform:uppercase">Documents</div>
                        <div style="font-size:1.4em;font-weight:700;color:var(--text-bright)">${status.documentCount ?? '—'}</div>
                    </div>
                    <div class="nc-host-card" style="padding:12px">
                        <div class="nc-muted" style="font-size:0.8em;text-transform:uppercase">Chunks</div>
                        <div style="font-size:1.4em;font-weight:700;color:var(--text-bright)">${status.chunkCount ?? '—'}</div>
                    </div>
                    <div class="nc-host-card" style="padding:12px">
                        <div class="nc-muted" style="font-size:0.8em;text-transform:uppercase">Vector Store</div>
                        <div style="font-size:1.4em;font-weight:700;color:${status.healthy ? '#4ade80' : '#f87171'}">${status.healthy ? 'Healthy' : 'Unhealthy'}</div>
                    </div>
                </div>`;

            // Dependencies
            html += `<h4 style="color:var(--text-bright);margin:0 0 8px"><i class="fa-solid fa-plug"></i> Dependencies</h4>`;
            html += `<table class="nc-table"><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>`;
            for (const [name, dep] of Object.entries(deps)) {
                const healthy = dep.healthy !== false;
                html += `<tr>
                    <td>${shared.escapeHtml(name)}</td>
                    <td><span style="color:${healthy ? '#4ade80' : '#f87171'}">&bull; ${healthy ? 'healthy' : 'down'}</span></td>
                    <td class="nc-muted">${shared.escapeHtml(dep.provider || dep.url || dep.error || '—')}</td>
                </tr>`;
            }
            html += `</tbody></table>`;

            // Cache stats
            const hitRate = ((cache.hitRate || 0) * 100).toFixed(1);
            html += `<h4 style="color:var(--text-bright);margin:16px 0 8px"><i class="fa-solid fa-database"></i> Embedding Cache</h4>`;
            html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
                <div><span class="nc-muted">Hit Rate</span><br><strong>${hitRate}%</strong></div>
                <div><span class="nc-muted">Size</span><br><strong>${cache.size ?? 0} / ${cache.maxSize ?? '—'}</strong></div>
                <div><span class="nc-muted">Hits / Misses</span><br><strong>${cache.hits ?? 0} / ${cache.misses ?? 0}</strong></div>
                <div><span class="nc-muted">Evictions</span><br><strong>${cache.evictions ?? 0}</strong></div>
            </div>`;

            // Recent documents
            const docList = Array.isArray(docs) ? docs : (docs.documents || []);
            if (docList.length > 0) {
                html += `<h4 style="color:var(--text-bright);margin:0 0 8px"><i class="fa-solid fa-file-lines"></i> Recent Documents</h4>`;
                html += `<table class="nc-table"><thead><tr><th>Source</th><th>Document ID</th><th>Chunks</th><th>Ingested</th></tr></thead><tbody>`;
                for (const d of docList.slice(0, 15)) {
                    html += `<tr>
                        <td><span class="nc-model-tag">${shared.escapeHtml(d.source || '—')}</span></td>
                        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${shared.escapeHtml(d.documentId || d._id || '—')}</td>
                        <td>${d.chunkCount ?? '—'}</td>
                        <td>${d.createdAt ? shared.timeAgo(d.createdAt) : '—'}</td>
                    </tr>`;
                }
                html += `</tbody></table>`;
            } else {
                html += `<p class="nc-muted" style="text-align:center;padding:8px">No documents ingested</p>`;
            }

            body.innerHTML = html;
        } catch (err) {
            body.innerHTML = `<p class="nc-muted" style="text-align:center;padding:16px">RAG service unavailable</p>`;
        }

        if (!refreshTimer) refreshTimer = setInterval(loadRag, 60000);
    }

    window.NerveCenterRag = { loadRag };
})();

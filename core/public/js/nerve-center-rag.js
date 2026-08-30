(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    if (!shared) return;

    let refreshTimer = null;
    let lastObservedAt = null;

    const metricText = value => value === null || value === undefined ? '—' : value;

    async function loadRag() {
        const body = document.getElementById('nc-rag-body');
        if (!body) return;
        shared.setSectionBusy(body, true);

        try {
            const [statusRes, docsRes] = await Promise.all([
                shared.fetchJson('/api/nerve-center/rag/status'),
                shared.fetchJson('/api/nerve-center/rag/documents?limit=15'),
            ]);

            const status = statusRes.data || {};
            const docs = docsRes.data || {};
            const deps = status.dependencies || {};
            const cache = status.cache || {};
            const qdrant = deps.qdrant || status.vectorStore || null;
            const qdrantKnown = typeof qdrant?.healthy === 'boolean';
            const qdrantHealthy = qdrant?.healthy === true;
            const queryKnown = typeof status.queryReady === 'boolean'
                || typeof status.healthy === 'boolean';
            const queryReady = status.queryReady === true || (status.queryReady == null && status.healthy === true);
            const observedAt = status.observedAt || statusRes.meta?.proxiedAt || null;
            if (observedAt) lastObservedAt = observedAt;
            const stateText = (known, healthy, ready = 'Ready') => known ? (healthy ? ready : 'Blocked') : 'Unknown';
            const stateColor = (known, healthy) => !known ? '#fbbf24' : (healthy ? '#4ade80' : '#f87171');

            // Health strip
            let html = `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:8px">
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
                        <div style="font-size:1.4em;font-weight:700;color:${stateColor(qdrantKnown, qdrantHealthy)}">${stateText(qdrantKnown, qdrantHealthy, 'Healthy')}</div>
                    </div>
                    <div class="nc-host-card" style="padding:12px">
                        <div class="nc-muted" style="font-size:0.8em;text-transform:uppercase">Query Readiness</div>
                        <div style="font-size:1.4em;font-weight:700;color:${stateColor(queryKnown, queryReady)}">${stateText(queryKnown, queryReady)}</div>
                    </div>
                </div>
                <div class="nc-muted" style="font-size:0.75em;margin-bottom:16px">${observedAt ? `Live RAG evidence observed ${shared.timeAgo(observedAt)}` : 'Observation time unavailable — do not treat this as current evidence.'}</div>`;

            if (!queryReady) {
                html += `<div class="nc-error" role="alert" style="margin-bottom:16px">RAG query readiness is ${queryKnown ? 'blocked' : 'unknown'}. Dependency details below are authoritative for this observation.</div>`;
            }

            // Dependencies
            html += `<h4 style="color:var(--text-bright);margin:0 0 8px"><i class="fa-solid fa-plug"></i> Dependencies</h4>`;
            html += `<table class="nc-table"><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>`;
            for (const [name, dep] of Object.entries(deps)) {
                const known = typeof dep?.healthy === 'boolean';
                const healthy = dep?.healthy === true;
                const label = known ? (healthy ? 'healthy' : 'down') : 'unknown';
                html += `<tr>
                    <td>${shared.escapeHtml(name)}</td>
                    <td><span style="color:${stateColor(known, healthy)}">&bull; ${label}${dep?.stale ? ' · stale' : ''}</span></td>
                    <td class="nc-muted">${shared.escapeHtml(dep?.provider || dep?.error || '—')}</td>
                </tr>`;
            }
            html += `</tbody></table>`;

            // Cache stats
            const cacheEvidenceKnown = ['requests', 'hits', 'misses']
                .some(key => Object.prototype.hasOwnProperty.call(cache, key));
            const cacheRequests = cacheEvidenceKnown
                ? Number(cache.requests ?? (Number(cache.hits || 0) + Number(cache.misses || 0)))
                : null;
            const hitRate = cacheRequests === null
                ? '—'
                : cacheRequests > 0
                    ? `${((cache.hitRate || 0) * 100).toFixed(1)}%`
                    : 'No requests';
            const cacheWindow = cache.observedSince ? ` since ${shared.timeAgo(cache.observedSince)}` : '';
            html += `<h4 style="color:var(--text-bright);margin:16px 0 8px"><i class="fa-solid fa-database"></i> Embedding Cache</h4>`;
            html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
                <div><span class="nc-muted">Hit Rate${cacheWindow}</span><br><strong>${hitRate}</strong></div>
                <div><span class="nc-muted">Size</span><br><strong>${metricText(cache.size)} / ${metricText(cache.maxSize)}</strong></div>
                <div><span class="nc-muted">Hits / Misses</span><br><strong>${metricText(cache.hits)} / ${metricText(cache.misses)}</strong></div>
                <div><span class="nc-muted">Evictions</span><br><strong>${metricText(cache.evictions)}</strong></div>
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
            const lastSeen = lastObservedAt ? ` · last seen ${shared.timeAgo(lastObservedAt)}` : '';
            shared.renderSectionError(body, `RAG service unavailable${lastSeen}`);
        } finally {
            shared.finishSectionLoad(body);
        }

        if (!refreshTimer) refreshTimer = setInterval(loadRag, 60000);
    }

    window.NerveCenterRag = { loadRag };
})();

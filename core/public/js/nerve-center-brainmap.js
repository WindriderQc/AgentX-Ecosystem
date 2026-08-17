(function () {
    'use strict';

    // Fleet Brain Map (task 0509) — the user-visible answer to "which brain
    // runs where, and why". Presentation-only over three existing endpoints:
    // /api/nerve-center/host-preferences (pins + live residency),
    // /api/hosts (GPU truth), /api/nerve-center/routing/config (lanes).
    // Runtime narrative is derived from current product evidence.

    const shared = window.NerveCenterShared;

    // Role labels come from the operator-approved fleet brain map. Keyed by
    // hostKey so a future host re-IP does not silently break the story.
    const HOST_ROLES = {
        primary: {
            role: 'Talks & Thinks',
            icon: 'fa-comments',
            tagline: 'GPU0 talks (family voice, sub-second) · GPU1 thinks (deep reasoning, Council)'
        },
        secondary: {
            role: 'Listens & Speaks',
            icon: 'fa-microphone',
            tagline: 'VoiX ears/mouth (STT + TTS) · local coder lane · family failover'
        },
        tertiary: {
            role: 'Remembers',
            icon: 'fa-database',
            tagline: 'RAG embeddings + retrieval · production platform host'
        }
    };

    // Lane grouping keeps the table readable for a non-operator.
    const LANE_GROUPS = [
        { title: 'Family voice', icon: 'fa-house', lanes: ['nestor_answer_light', 'voice_persona_reader', 'voice_persona_chat', 'quick_chat'] },
        { title: 'Thinking', icon: 'fa-brain', lanes: ['deep_reasoning', 'master_brain', 'analysis'] },
        { title: 'Coding', icon: 'fa-code', lanes: ['code_generation', 'code_review'] },
        { title: 'Memory & utility', icon: 'fa-database', lanes: ['embeddings', 'rag_query_expansion', 'rag_reranking', 'rag_compression', 'summarization', 'translation', 'general_chat'] }
    ];

    function isForeverKeepAlive(expiresAt) {
        if (!expiresAt) return false;
        const year = new Date(expiresAt).getFullYear();
        return Number.isFinite(year) && year > 2100;
    }

    function fmtGiB(mib) {
        if (!Number.isFinite(mib)) return '--';
        return (mib / 1024).toFixed(1);
    }

    function gpuBar(gpu) {
        const used = Number(gpu.vramUsed) || 0;
        const total = Number(gpu.vramTotal) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
        const accent = pct > 90 ? '#f87171' : pct > 5 ? '#4ade80' : 'var(--muted)';
        return `<div style="margin:6px 0;">
            <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--muted);">
                <span>GPU${gpu.index} · ${shared.escapeHtml(gpu.name || '')}</span>
                <span>${fmtGiB(used)} / ${fmtGiB(total)} GiB</span>
            </div>
            <div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.06);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${accent};"></div>
            </div>
        </div>`;
    }

    function residentChips(pref) {
        const running = (pref.live && pref.live.runningModels) || [];
        if (!running.length) {
            return '<span style="font-size:0.72rem;color:var(--muted);">no resident model (loads on demand)</span>';
        }
        return running.map((m) => {
            const pinned = !!m.matchedPinned;
            const forever = isForeverKeepAlive(m.expiresAt);
            const badge = pinned ? (forever ? '∞' : 'pin') : 'transient';
            const accent = pinned ? '#4ade80' : 'var(--muted)';
            return `<span class="nc-brainmap-chip" style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border-radius:10px;border:1px solid ${accent};font-size:0.72rem;">
                ${shared.escapeHtml(m.name)} <span style="color:${accent};font-weight:700;">${badge}</span>
            </span>`;
        }).join('');
    }

    function hostCard(pref, hostInfo) {
        const roles = HOST_ROLES[pref.hostKey] || { role: pref.hostKey || 'host', icon: 'fa-server', tagline: '' };
        const online = pref.live && pref.live.online;
        const claimed = pref.status === 'benchmarking';
        const statusBadge = claimed
            ? '<span style="color:#f59e0b;font-weight:700;font-size:0.72rem;">DEEP-WORK WINDOW</span>'
            : online
                ? '<span style="color:#4ade80;font-weight:700;font-size:0.72rem;">ONLINE</span>'
                : '<span style="color:#f87171;font-weight:700;font-size:0.72rem;">OFFLINE</span>';
        const gpus = (hostInfo && hostInfo.gpus) || [];
        return `<div class="nc-brainmap-card" style="background:rgba(255,255,255,0.02);border:1px solid var(--panel-border);border-radius:8px;padding:14px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
                <div style="font-weight:700;"><i class="fas ${roles.icon}" style="margin-right:6px;color:var(--accent,#7dd3fc);"></i>${shared.escapeHtml(pref.displayName || pref.hostUrl)}</div>
                ${statusBadge}
            </div>
            <div style="font-size:0.78rem;color:var(--accent,#7dd3fc);margin:2px 0 4px;">${shared.escapeHtml(roles.role)}</div>
            <div style="font-size:0.72rem;color:var(--muted);margin-bottom:8px;">${shared.escapeHtml(roles.tagline)}</div>
            ${gpus.map(gpuBar).join('')}
            <div style="margin-top:8px;">${residentChips(pref)}</div>
        </div>`;
    }

    function laneRows(taskModels, defaults, hostNamesByKey) {
        const defaultMap = (defaults && defaults.taskModels) || {};
        return LANE_GROUPS.map((group) => {
            const rows = group.lanes
                .filter((lane) => taskModels[lane])
                .map((lane) => {
                    const cfg = taskModels[lane];
                    const def = defaultMap[lane];
                    const overridden = def && (def.model !== cfg.model || def.host !== cfg.host);
                    const hostName = hostNamesByKey[cfg.host] || cfg.host;
                    return `<tr>
                        <td style="padding:4px 8px;color:var(--muted);">${shared.escapeHtml(lane)}</td>
                        <td style="padding:4px 8px;">${shared.escapeHtml(cfg.model || '--')}</td>
                        <td style="padding:4px 8px;color:var(--muted);">${shared.escapeHtml(hostName)}</td>
                        <td style="padding:4px 8px;">${overridden ? '<span style="color:#f59e0b;font-size:0.7rem;border:1px solid #f59e0b;border-radius:8px;padding:1px 6px;">override</span>' : ''}</td>
                    </tr>`;
                }).join('');
            if (!rows) return '';
            return `<tr><td colspan="4" style="padding:8px 8px 2px;font-weight:700;font-size:0.78rem;"><i class="fas ${group.icon}" style="margin-right:6px;color:var(--accent,#7dd3fc);"></i>${group.title}</td></tr>${rows}`;
        }).join('');
    }

    async function loadBrainMap() {
        const body = document.getElementById('sectionBrainMapBody');
        if (!body) return;
        body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading fleet brain map...</div>';

        try {
            const [prefsJson, hostsJson, routingJson] = await Promise.all([
                shared.fetchJson('/api/nerve-center/host-preferences'),
                shared.fetchJson('/api/hosts'),
                shared.fetchJson('/api/nerve-center/routing/config')
            ]);

            const prefs = prefsJson.data || [];
            const hosts = hostsJson.data || [];
            const routing = routingJson.data || {};
            const taskModels = routing.taskModels || {};
            const hostUrls = routing.hosts || {};

            const hostNamesByKey = {};
            const hostInfoByUrl = {};
            for (const pref of prefs) hostNamesByKey[pref.hostKey] = pref.displayName || pref.hostKey;
            for (const h of hosts) {
                if (h.ollamaUrl) hostInfoByUrl[h.ollamaUrl] = h;
            }

            const anyWindow = prefs.some((p) => p.status === 'benchmarking');
            const modeBadge = anyWindow
                ? '<span id="brainMapMode" style="color:#f59e0b;font-weight:700;"><i class="fas fa-moon"></i> Deep-work window active — a host is claimed for fused/benchmark work; family lanes ride their fallback.</span>'
                : '<span id="brainMapMode" style="color:#4ade80;font-weight:700;"><i class="fas fa-sun"></i> Day mode — split brains: every lane on its own warm model.</span>';

            const orderedPrefs = ['primary', 'secondary', 'tertiary']
                .map((key) => prefs.find((p) => p.hostKey === key))
                .filter(Boolean)
                .concat(prefs.filter((p) => !['primary', 'secondary', 'tertiary'].includes(p.hostKey)));

            const cards = orderedPrefs
                .map((pref) => hostCard(pref, hostInfoByUrl[pref.hostUrl]))
                .join('');

            body.innerHTML = `
                <div style="font-size:0.82rem;margin-bottom:12px;">${modeBadge}</div>
                <div id="brainMapCards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;">${cards}</div>
                <div style="margin-top:16px;">
                    <h4 style="font-size:0.9rem;margin-bottom:6px;"><i class="fas fa-route" style="margin-right:6px;"></i>Lanes — which brain answers what</h4>
                    <table id="brainMapLanes" style="width:100%;border-collapse:collapse;font-size:0.78rem;">${laneRows(taskModels, routing.defaults, hostNamesByKey)}</table>
                </div>
                <div style="margin-top:10px;font-size:0.7rem;color:var(--muted);">
                        Assignments are derived from current runtime host preferences and routing data.
                </div>`;
        } catch (err) {
            console.error('[NerveCenter] loadBrainMap error:', err);
            body.innerHTML = '<div class="nc-section-placeholder" style="color:var(--danger);"><i class="fas fa-exclamation-triangle"></i> Failed to load the fleet brain map</div>';
        }
    }

    function init() {
        if (!document.getElementById('sectionBrainMapBody')) return;
        const refresh = document.getElementById('btnRefreshBrainMap');
        if (refresh) refresh.addEventListener('click', (e) => { e.stopPropagation(); loadBrainMap(); });
        loadBrainMap();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.NerveCenterBrainMap = { loadBrainMap };
})();

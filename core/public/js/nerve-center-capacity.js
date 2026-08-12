(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    if (!shared) return;

    let _poller = null;

    const VERDICT = {
        UNDERUSED:         { color: '#7cf0ff', icon: 'fa-arrow-down-wide-short', label: 'Underused' },
        BALANCED:          { color: '#4ade80', icon: 'fa-scale-balanced',        label: 'Balanced' },
        VRAM_CONSTRAINED:  { color: '#fb923c', icon: 'fa-memory',                label: 'VRAM constrained' },
        COMPUTE_SATURATED: { color: '#f87171', icon: 'fa-fire',                  label: 'Compute saturated' },
    };

    function fmtGiB(miB) { return (Number(miB || 0) / 1024).toFixed(1); }
    function n(v, suffix) { return (v == null ? '—' : v + (suffix || '')); }

    function buildLaneMap(taskModels) {
        const laneMap = {};
        Object.entries(taskModels || {}).forEach(([taskType, route]) => {
            if (!route?.host) return;
            if (!laneMap[route.host]) laneMap[route.host] = [];
            laneMap[route.host].push({ taskType, model: route.model || 'unknown model' });
        });
        Object.values(laneMap).forEach(lanes => lanes.sort((a, b) => a.taskType.localeCompare(b.taskType)));
        return laneMap;
    }

    function inventoryMap(hosts) {
        const byKey = {};
        (hosts || []).forEach(host => {
            if (host?.id) byKey[host.id] = host;
            if (host?.url) byKey[host.url] = host;
        });
        return byKey;
    }

    function chip(label, color) {
        const c = color || '#93a0b5';
        return `<span style="display:inline-flex;align-items:center;padding:2px 7px;border:1px solid ${c}44;background:${c}10;border-radius:999px;color:${c};font-size:0.72em">${shared.escapeHtml(String(label))}</span>`;
    }

    function verdictBadge(v) {
        const m = VERDICT[v] || { color: '#93a0b5', icon: 'fa-circle-question', label: v || 'unknown' };
        return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:${m.color}1a;color:${m.color};border:1px solid ${m.color}55;font-weight:700;font-size:0.74em;letter-spacing:0.04em;white-space:nowrap">
            <i class="fa-solid ${m.icon}"></i> ${m.label.toUpperCase()}</span>`;
    }

    function hostCard(r, inventoryByKey, lanesByHost) {
        if (!r || r.error) {
            return `<div class="nc-host-card" style="padding:14px">
                <div style="font-weight:700;color:var(--text-bright)">${shared.escapeHtml(String(r?.input || 'host'))}</div>
                <div class="nc-muted nc-fs-sm" style="margin-top:6px">${shared.escapeHtml(r?.message || r?.error || 'unavailable')}</div></div>`;
        }
        const v = VERDICT[r.verdict] || { color: '#93a0b5' };
        const usedPct = r.vram?.usedPct ?? 0;
        const barColor = usedPct >= 90 ? '#f87171' : usedPct >= 70 ? '#fb923c' : '#4ade80';
        const name = r.host?.hostId || r.host?.hostname || r.input || '?';
        const role = r.host?.configId ? ` <span class="nc-muted" style="font-size:0.75em">(${shared.escapeHtml(r.host.configId)})</span>` : '';
        const offline = r.host && r.host.online === false;
        const hostKey = r.host?.configId || r.host?.ollamaUrl || r.input;
        const inventory = inventoryByKey[hostKey] || inventoryByKey[r.host?.ollamaUrl] || null;
        const installedModels = inventory?.installedModels || [];
        const loadedModels = r.loadedModels || [];
        const lanes = lanesByHost[hostKey] || [];
        const loaded = loadedModels.map(m => `${shared.escapeHtml(m.name)} ${fmtGiB(m.sizeVramMiB)}G`).join(', ') || '<span class="nc-muted">none resident</span>';
        const installed = installedModels.length
            ? installedModels.map(model => chip(model)).join(' ')
            : '<span class="nc-muted">inventory unavailable</span>';
        const lanePreview = lanes.slice(0, 4).map(lane => chip(`${lane.taskType} → ${lane.model}`, '#7cf0ff')).join(' ');
        const hiddenLaneCount = Math.max(0, lanes.length - 4);
        const reason = (r.verdictReasons || [])[0] || '';
        const c = r.compute || {};
        const inf = r.inference || {};
        const latP95 = inf.latencyP95Ms != null ? (inf.latencyP95Ms / 1000).toFixed(1) + 's' : '—';
        return `<div class="nc-host-card" style="padding:14px;border-left:3px solid ${v.color}">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
                <div style="font-weight:700;color:var(--text-bright)">
                    ${offline ? '<i class="fa-solid fa-plug-circle-xmark" style="color:#f87171" title="offline"></i> ' : ''}${shared.escapeHtml(String(name))}${role}
                </div>
                ${verdictBadge(r.verdict)}
            </div>
            <div class="nc-muted" style="font-size:0.76em;margin:-5px 0 9px">
                Ollama ${shared.escapeHtml(inventory?.ollamaVersion || 'version unknown')} · ${installedModels.length || '—'} installed · ${loadedModels.length} resident
            </div>
            <div style="margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;font-size:0.82em;margin-bottom:3px">
                    <span class="nc-muted">VRAM</span>
                    <span>${fmtGiB(r.vram?.usedMiB)} / ${fmtGiB(r.vram?.totalMiB)} GiB · ${n(usedPct, '%')}</span>
                </div>
                <div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden">
                    <div style="height:100%;width:${Math.min(100, Math.max(0, usedPct))}%;background:${barColor}"></div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;font-size:0.82em">
                <div><span class="nc-muted">GPU util</span> p95 ${n(c.utilP95, '%')} · p50 ${n(c.utilP50, '%')}</div>
                <div><span class="nc-muted">util cov</span> ${n(c.utilCoveragePct, '%')}</div>
                <div><span class="nc-muted">calls 24h</span> ${n(inf.callCount)} · ${n(inf.callSharePct, '%')}</div>
                <div><span class="nc-muted">errors</span> ${n(inf.errorRate, '%')} · p95 ${latP95}</div>
            </div>
            <div style="margin-top:8px;font-size:0.8em"><span class="nc-muted">resident</span> ${loaded}</div>
            <div style="margin-top:8px;font-size:0.8em">
                <span class="nc-muted">effective lanes (${lanes.length})</span>
                ${lanes.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px">${lanePreview}${hiddenLaneCount ? chip(`+${hiddenLaneCount} more`, '#7cf0ff') : ''}</div>` : '<div style="margin-top:5px;color:#fb923c"><i class="fa-solid fa-triangle-exclamation"></i> No effective task lane assigned</div>'}
            </div>
            <details style="margin-top:8px;font-size:0.8em">
                <summary class="nc-muted" style="cursor:pointer">Installed model inventory (${installedModels.length})</summary>
                <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px">${installed}</div>
            </details>
            ${reason ? `<div class="nc-muted" style="margin-top:6px;font-size:0.76em;font-style:italic">${shared.escapeHtml(reason)}</div>` : ''}
        </div>`;
    }

    async function loadCapacity() {
        const body = document.getElementById('sectionCapacityBody');
        if (!body) return;

        // Wire the header refresh button once (clicks on buttons don't toggle the section).
        const btn = document.getElementById('btnRefreshCapacity');
        if (btn && btn.dataset.bound !== 'true') {
            btn.dataset.bound = 'true';
            btn.addEventListener('click', () => loadCapacity());
        }

        try {
            const [capacityResult, inventoryResult, routingResult] = await Promise.allSettled([
                shared.fetchJson('/api/host-capacity'),
                shared.fetchJson('/api/ollama-hosts'),
                shared.fetchJson('/api/nerve-center/routing/config')
            ]);

            if (capacityResult.status === 'rejected') throw capacityResult.reason;

            const reports = (capacityResult.value.data || []).filter(Boolean);
            const inventoryByKey = inventoryMap(inventoryResult.status === 'fulfilled' ? inventoryResult.value.data?.hosts : []);
            const lanesByHost = buildLaneMap(routingResult.status === 'fulfilled' ? routingResult.value.data?.taskModels : {});
            const degradedSources = [];
            if (inventoryResult.status === 'rejected') degradedSources.push('model inventory');
            if (routingResult.status === 'rejected') degradedSources.push('lane config');
            if (!reports.length) {
                body.innerHTML = `<p class="nc-muted" style="text-align:center;padding:16px">No configured hosts</p>`;
            } else {
                const counts = {};
                reports.forEach(r => { if (r.verdict) counts[r.verdict] = (counts[r.verdict] || 0) + 1; });
                const summary = Object.entries(counts).map(([k, c]) => `${c} ${(VERDICT[k]?.label || k).toLowerCase()}`).join(' · ');
                let html = `<div class="nc-muted nc-fs-sm" style="margin-bottom:12px">${reports.length} host${reports.length > 1 ? 's' : ''}${summary ? ' · ' + summary : ''} · 24h window${degradedSources.length ? ` · unavailable: ${degradedSources.join(', ')}` : ''}</div>`;
                html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">`;
                html += reports.map(report => hostCard(report, inventoryByKey, lanesByHost)).join('');
                html += `</div>`;
                body.innerHTML = html;
            }
        } catch (err) {
            body.innerHTML = `<p class="nc-muted" style="text-align:center;padding:16px">Capacity service unavailable</p>`;
        }

        if (!_poller) {
            _poller = new window.PollingController();
            _poller.addTask('capacity', loadCapacity, 60000, { runOnStart: false });
            _poller.start();
        }
    }

    window.NerveCenterCapacity = { loadCapacity, buildLaneMap, inventoryMap };
})();

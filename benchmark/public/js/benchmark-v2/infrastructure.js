// infrastructure.js — Section ① Execution Host selection cards.
// Renders host cards from profiler data. Radio-select, one host at a time.
// Emits 'host-selected' CustomEvent on the container with { detail: { host } }.
// If no HostProfile docs exist, triggers discovery from configured hosts.

import { fetchProfilerHosts } from './api.js';
import { fetchActiveProfilingState, findProfilingForHost, formatProfilingLockout } from './profiling-lockout.js';
import { save, load, esc } from './helpers.js';
import { showToast } from '../components/toast.js';

const SK_HOST = 'bv2_execHost';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render host selection cards into the container.
 * @param {HTMLElement} container — #host-cards
 * @param {Array} [hosts] — pre-fetched HostProfile[], or null to fetch
 * @returns {object|null} — the initially selected host, or null
 */
export async function renderHostSelection(container, hosts) {
    container.innerHTML = '<div class="r-loading">Loading hosts\u2026</div>';

    try {
        let data = hosts || await _fetchHosts();

        // If profiler has no hosts, trigger discovery from env config
        if (!data?.length) {
            data = await _discoverHosts();
        }

        if (!data?.length) {
            container.innerHTML = `<div class="r-empty" style="text-align:center;padding:2rem;">
                <div style="font-size:1.1rem;color:var(--r-text,#e6edf3);margin-bottom:0.5rem;">No hosts configured</div>
                <div style="color:var(--r-text-muted,#8b949e);font-size:0.85rem;">
                    Set <code>OLLAMA_HOST</code> environment variables and restart, or
                    <a href="/profiler#hosts" style="color:var(--r-active,#58a6ff);">add hosts in the Profiler</a>.
                </div>
            </div>`;
            return null;
        }

        const activeProfilingState = await fetchActiveProfilingState();
        data.forEach((h) => {
            h._activeProfiling = findProfilingForHost(h, activeProfilingState);
        });

        // Reconcile stored profiler state with live runtime state. A newly
        // discovered host legitimately starts as "unknown" until this probe;
        // treating that as offline contradicts the live Ollama status shown in
        // the simple surface and hides the actual next step (run a baseline).
        await Promise.all(data.map(async (h) => {
            try {
                const statusRes = await fetch(`/api/profiler/hosts/${encodeURIComponent(h.hostId)}/status/refresh`, {
                    method: 'POST'
                });
                if (!statusRes.ok) return;
                const status = await statusRes.json();
                const d = status.data || status;
                h.status = d.status || h.status;
                h.error = d.error || null;
                h.models = (d.models || []).map(m => m.replace(/:latest$/i, ''));
                h.modelDetails = d.modelDetails || [];
                h._modelCount = h.models.length;
            } catch (_) {}
        }));

        _render(container, data);

        // Update infra count badge
        const countEl = document.getElementById('infra-count');
        if (countEl) {
            const online = data.filter(h => _isOnline(h)).length;
            countEl.textContent = `${online}/${data.length}`;
        }

        return _autoSelect(container, data);
    } catch (err) {
        container.innerHTML = `<div class="r-empty" style="color:var(--r-error)">Failed to load hosts: ${err.message}</div>`;
        return null;
    }
}

/** Get the currently selected host object from the container */
export function getSelectedHost(container) {
    const card = container.querySelector('.hs-card.hs-selected');
    return card ? JSON.parse(card.dataset.hostJson || 'null') : null;
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _fetchHosts() {
    const res = await fetchProfilerHosts();
    return res?.data || res || [];
}

/** Discover hosts from env config and seed HostProfile docs */
async function _discoverHosts() {
    try {
        const res = await fetch('/api/profiler/hosts/discover', { method: 'POST' });
        if (!res.ok) return [];
        return await res.json();
    } catch (_) {
        return [];
    }
}

function _isTested(host) {
    return !!host.baseline?.testedAt;
}

function _isOnline(host) {
    return host.status === 'online';
}

function _render(container, hosts) {
    if (!hosts?.length) {
        container.innerHTML = '<div class="r-empty">No hosts configured.</div>';
        return;
    }
    container.innerHTML = '';
    hosts.forEach(host => container.appendChild(_buildCard(host)));
}

function _buildCard(host) {
    const name = host.displayName || host.name || host.hostname || 'Unknown';
    const url = host.hostUrl || host.url || '';
    const online = _isOnline(host);
    const tested = _isTested(host);
    const activeProfiling = Array.isArray(host._activeProfiling) ? host._activeProfiling : [];
    const isProfiling = activeProfiling.length > 0;
    const selectable = online && tested && !isProfiling;
    const dedicatedModels = host.dedicated?.models || (host.dedicated?.model ? [host.dedicated.model] : []);
    const dedicated = dedicatedModels.length > 0 ? dedicatedModels[0] : null;

    const card = document.createElement('div');
    card.className = 'hs-card' + (!selectable ? ' hs-disabled' : '') + (isProfiling ? ' hs-profiling' : '');
    card.dataset.hostUrl = url;
    card.dataset.hostName = name;
    card.dataset.hostJson = JSON.stringify(host);

    // ── Checkbox ──
    const cb = document.createElement('div');
    cb.className = 'hs-checkbox';
    card.appendChild(cb);

    // ── Header: dot + name ──
    const header = document.createElement('div');
    header.className = 'hs-header';
    header.innerHTML = `<span class="hs-dot ${online ? 'hs-online' : 'hs-offline'}"></span>`
        + `<span class="hs-name">${esc(name)}</span>`;
    card.appendChild(header);

    if (dedicated) {
        const badge = document.createElement('span');
        badge.className = 'hs-pill';
        badge.style.cssText = 'background:rgba(255,152,0,0.12);color:#ff9800;border:1px solid rgba(255,152,0,0.3);';
        badge.textContent = 'DEDICATED';
        header.appendChild(badge);
    }

    if (isProfiling) {
        const badge = document.createElement('span');
        badge.className = 'hs-pill hs-pill-profile';
        badge.textContent = 'PROFILING';
        header.appendChild(badge);
    }

    // ── IP ──
    const ipEl = document.createElement('div');
    ipEl.className = 'hs-ip';
    ipEl.textContent = url.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    card.appendChild(ipEl);

    // ── Pill row: GPU, VRAM, model count ──
    const pills = document.createElement('div');
    pills.className = 'hs-pills';
    const gpuLabel = host.gpu?.model || _vramLabel(host.gpu?.vramTotalMiB) || '';
    if (gpuLabel) pills.appendChild(_pill(gpuLabel));
    const vramMiB = host.gpu?.vramTotalMiB;
    if (vramMiB) pills.appendChild(_pill(`${Math.round(vramMiB / 1024)} GB`));
    const modelCount = host._modelCount || host.modelCount || host.models?.length || 0;
    pills.appendChild(_pill(`${modelCount} models`));
    for (const dm of dedicatedModels) {
        const dedPill = document.createElement('span');
        dedPill.className = 'hs-pill';
        dedPill.style.cssText = 'background:rgba(255,152,0,0.06);color:#ff9800;font-size:0.65rem;';
        dedPill.textContent = `Default: ${dm.replace(/:latest$/i, '')}`;
        pills.appendChild(dedPill);
    }
    card.appendChild(pills);

    if (isProfiling) {
        const banner = document.createElement('div');
        banner.className = 'hs-profile-lock';
        banner.textContent = formatProfilingLockout(activeProfiling);
        card.appendChild(banner);
    }

    // ── Perf row ──
    const perf = document.createElement('div');
    perf.className = 'hs-perf';
    const b = host.baseline;
    if (b?.tokensPerSec) {
        perf.appendChild(_perfCell(Number(b.tokensPerSec).toFixed(1), 'tok/s'));
        perf.appendChild(_perfCell(b.latencyMs ? `${Math.round(b.latencyMs)}ms` : '\u2014', 'latency'));
        perf.appendChild(_perfCell('Tested', _reltime(b.testedAt), 'good'));
    } else if (online) {
        perf.appendChild(_perfCell('\u2014', 'tok/s', 'dashed'));
        perf.appendChild(_perfCell('\u2014', 'latency', 'dashed'));
        perf.appendChild(_perfCell('Not Tested', '\u2014', 'warn'));
    } else {
        perf.appendChild(_perfCell('Offline', host.error || 'Unreachable', 'error'));
    }
    card.appendChild(perf);

    // ── Click handler ──
    card.addEventListener('click', () => {
        if (!selectable) {
            const reason = isProfiling ? 'Profiling is active on this host' : (online ? 'Run host test first' : 'Host is offline');
            showToast(reason, 'warn');
            return;
        }
        if (dedicated) {
            showToast(`Only ${dedicated.replace(/:latest$/i, '')} can run here \u2014 release in Profiler for other models`, 'warn');
        }
        _selectCard(card);
    });

    return card;
}

function _selectCard(card) {
    const container = card.parentElement;
    if (!container) return;

    // Deselect all
    container.querySelectorAll('.hs-card').forEach(c => {
        c.classList.remove('hs-selected');
        const cb = c.querySelector('.hs-checkbox');
        if (cb) cb.textContent = '';
    });

    // Select this one
    card.classList.add('hs-selected');
    const cb = card.querySelector('.hs-checkbox');
    if (cb) cb.textContent = '\u2713';

    save(SK_HOST, card.dataset.hostUrl);

    const host = JSON.parse(card.dataset.hostJson || 'null');
    container.dispatchEvent(new CustomEvent('host-selected', {
        detail: { host },
        bubbles: true,
    }));
}

function _autoSelect(container, hosts) {
    const savedUrl = load(SK_HOST);

    // Only auto-select if the saved host is tested + online
    // NO default selection — user must explicitly choose
    if (savedUrl) {
        const target = hosts.find(h => (h.hostUrl || h.url) === savedUrl && _isOnline(h) && _isTested(h) && !(h._activeProfiling?.length));
        if (target) {
            const card = container.querySelector(`.hs-card[data-host-url="${CSS.escape(savedUrl)}"]`);
            if (card) _selectCard(card);
            return target;
        }
    }

    return null;
}

// ── Host helpers ────────────────────────────────────────────────────────────

function _vramLabel(vramMiB) {
    return vramMiB ? `${Math.round(vramMiB / 1024)} GB VRAM` : '';
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function _pill(text) {
    const el = document.createElement('span');
    el.className = 'hs-pill';
    el.textContent = text;
    return el;
}

function _perfCell(value, label, variant) {
    const cell = document.createElement('div');
    cell.className = 'hs-perf-cell' + (variant ? ` hs-${variant}` : '');
    cell.innerHTML = `<div class="hs-perf-val">${esc(String(value))}</div>`
        + `<div class="hs-perf-label">${esc(String(label))}</div>`;
    return cell;
}

function _reltime(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '\u2014';
    const diff = Math.round((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

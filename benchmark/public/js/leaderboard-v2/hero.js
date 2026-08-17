// hero.js — renders the "The Trophy Case" hero section
// Stat cards use dashboard data; host strip fetched separately.

import { fetchHosts } from './api.js';

function gpuLabel(host) {
    if (host.gpu?.model) return host.gpu.model;
    if (host.vramMb) return `${Math.round(host.vramMb / 1024)}GB VRAM`;
    return '';
}

function statCard(icon, label, value, hint, accent = 'var(--r-active)') {
    return `<div class="r-stat-card" style="--stat-accent:${accent}" title="${hint}">
        <div class="r-stat-val">${value}</div>
        <div class="r-stat-label"><i class="fas ${icon}" aria-hidden="true"></i>${label}</div>
    </div>`;
}

function normalizeHosts(hostsRes) {
    if (Array.isArray(hostsRes)) return hostsRes;
    if (Array.isArray(hostsRes?.hosts)) return hostsRes.hosts;
    return [];
}

// Host pills are now purely informational fleet status — reachability dot, GPU
// and model count. All leaderboard host filtering lives in the #filter-bar
// Hosts selector (see leaderboard-v2/index.js), so these pills are not
// interactive and there is no second client-side filter to keep in sync.
function hostPill(host) {
    const online = host.available;
    const dot = online
        ? '<span class="r-hp-dot r-dot-online"></span>'
        : '<span class="r-hp-dot r-dot-offline"></span>';
    const modelCount = Array.isArray(host.models) ? host.models.length : 0;
    const gpu = gpuLabel(host);
    const styleAttr = online ? '' : ' style="opacity:0.45"';
    const status = online ? 'reachable' : 'unreachable';
    return `<div class="r-host-pill r-host-pill-status" title="${host.name || host.id} — ${status}"${styleAttr}>
        ${dot}
        <span class="r-hp-name">${host.name || host.id}</span>
        ${gpu ? `<span class="r-hp-gpu">${gpu}</span>` : ''}
        <span class="r-hp-models">${modelCount} model${modelCount !== 1 ? 's' : ''}</span>
    </div>`;
}

/**
 * Render the hero section into container.
 *
 * @param {HTMLElement} container
 * @param {object} dashboard - full response from fetchDashboard() ({ status, data })
 */
export async function renderHero(container, dashboard, opts = {}) {
    const d = dashboard?.data || {};
    const overview = d.overview || {};
    const modelStats = Array.isArray(d.model_stats) ? d.model_stats : [];
    const rankings = Array.isArray(opts.rankings) ? opts.rankings.filter(r => !r.filtered) : [];
    const currentScope = opts.hostScope === 'current';
    const challengeScope = opts.challengeScope || 'all';
    const hosts = normalizeHosts(opts.hostsRes);

    // Derive counts from available dashboard data
    const modelCount = currentScope && rankings.length
        ? new Set(rankings.map(s => s.model)).size
        : new Set(modelStats.map(s => s.model)).size;
    const resultCount = currentScope && rankings.length
        ? rankings.reduce((acc, s) => acc + (s.totalTests || 0), 0)
        : overview.total_tests ?? modelStats.reduce((acc, s) => acc + (s.total_tests || 0), 0);
    // Batch and prompt counts not in dashboard; use total_tests as proxy for results,
    // and quality_tests sum for scored results.
    const scoredCount = currentScope && rankings.length
        ? resultCount
        : modelStats.reduce((acc, s) => acc + (s.quality_tests || 0), 0);
    const hostCount = currentScope
        ? new Set(rankings.map(s => s.host).filter(Boolean)).size || hosts.length
        : new Set(modelStats.map(s => s.host).filter(Boolean)).size;
    const scopeText = currentScope
        ? 'Current configured-host rankings'
        : 'Historical rankings across every evaluated host';
    const challengeText = challengeScope === 'advanced'
        ? 'hard L4-L5 challenge cohort'
        : challengeScope === 'foundation'
            ? 'foundation L1-L3 cohort'
            : 'all prompt levels with hard-level coverage penalty';
    const subtitle = `${scopeText}, ${challengeText}. Switch controls to inspect archived or foundation-only rows.`;

    container.innerHTML = `
        <div class="r-hero r-hero-cyan">
            <div class="r-hero-top">
                <div class="r-hero-id">
                    <div class="r-hero-badge" aria-hidden="true"><i class="fas fa-trophy"></i></div>
                    <div class="r-hero-id-text">
                        <div class="r-hero-headline">The Trophy Case</div>
                        <div class="r-hero-sub">${subtitle}</div>
                    </div>
                </div>
                <div class="r-hero-stats" id="hero-stats">
                    ${statCard('fa-cubes', 'Models ranked', modelCount, 'Distinct models in the current view', 'var(--r-active)')}
                    ${statCard('fa-flask', 'Benchmark runs', resultCount.toLocaleString(), 'Total prompt executions recorded', 'var(--r-good)')}
                    ${statCard('fa-gavel', 'Judge-scored', scoredCount.toLocaleString(), 'Runs graded by the judge model', 'var(--r-judge)')}
                    ${statCard('fa-server', 'GPU hosts', hostCount, 'Machines these results were evaluated on', '#ffa726')}
                </div>
            </div>
            <div class="r-host-strip" id="host-strip">
                <span class="r-host-strip-label"><i class="fas fa-server" aria-hidden="true"></i> Live fleet status</span>
                <div id="host-pills">
                    <span class="r-host-pill-loading">Loading hosts…</span>
                </div>
            </div>
        </div>`;

    // Fetch hosts asynchronously and fill the strip
    try {
        const hostPayload = opts.hostsRes || await fetchHosts();
        const hosts = normalizeHosts(hostPayload);
        const pillsEl = container.querySelector('#host-pills');
        if (pillsEl) {
            if (hosts.length === 0) {
                pillsEl.innerHTML = '<span class="host-pill-empty">No hosts configured</span>';
            } else {
                pillsEl.innerHTML = hosts.map(hostPill).join('');
            }
        }
    } catch (err) {
        const pillsEl = container.querySelector('#host-pills');
        if (pillsEl) {
            pillsEl.innerHTML = '<span class="host-pill-error">Could not reach hosts</span>';
        }
        console.warn('[hero] fetchHosts failed:', err.message);
    }
}

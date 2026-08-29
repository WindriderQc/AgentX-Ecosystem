// public/js/efficiency-map/index.js
import { fetchEfficiencyMap } from './api.js';
import { renderHeroPicks } from './hero-picks.js';
import { renderScatterPlot } from './scatter-plot.js';
import { renderRankedTable } from './ranked-table.js';
import { rankableEfficiencyEntries } from './evidence.js';

function showLoading(main) {
    main.innerHTML = '<div style="text-align:center;padding:4rem;color:var(--r-text-muted)"><i class="fas fa-spinner fa-spin"></i> Loading efficiency data\u2026</div>';
}

function showError(main, err) {
    main.innerHTML = `<div style="text-align:center;padding:4rem;color:var(--r-error)"><i class="fas fa-exclamation-triangle"></i> ${err.message}</div>`;
}

async function init() {
    const main = document.querySelector('main');
    showLoading(main);

    let data;
    try {
        const res = await fetchEfficiencyMap();
        data = res.data;
    } catch (err) {
        console.error('[efficiency-map] fetch failed:', err);
        showError(main, err);
        return;
    }

    const sourceEntries = Array.isArray(data?.entries) ? data.entries : [];
    const entries = rankableEfficiencyEntries(sourceEntries);
    const serverUnranked = Array.isArray(data?.unranked) ? data.unranked.length : 0;
    const clientRejected = sourceEntries.length - entries.length;
    const unrankedCount = serverUnranked + clientRejected;
    const optimalCount = entries.filter(entry => entry.paretoOptimal).length;

    // Restore shell
    main.innerHTML = `
        <section id="hero"></section>
        ${unrankedCount > 0 ? `
            <div class="eff-evidence-note" role="status">
                <i class="fas fa-circle-info"></i>
                ${unrankedCount} model/host ${unrankedCount === 1 ? 'combination is' : 'combinations are'} excluded because ${unrankedCount === 1 ? 'it does' : 'they do'} not have complete finite quality and positive throughput evidence.
            </div>
        ` : ''}
        <div id="scatter" class="r-section">
            <div class="r-sec-head">
                <span class="r-sec-icon"><i class="fas fa-chart-scatter-bubble"></i></span>
                <span class="r-sec-title r-t-cyan">Frontier</span>
                <span class="r-sec-count">${optimalCount} optimal</span>
            </div>
            <div id="scatter-body"></div>
        </div>
        <div id="rankings" class="r-section">
            <div class="r-sec-head">
                <span class="r-sec-icon"><i class="fas fa-ranking-star"></i></span>
                <span class="r-sec-title r-t-green">Rankings</span>
                <span class="r-sec-count">${entries.length} measured combos</span>
            </div>
            <div id="rankings-body"></div>
        </div>
    `;

    const heroEl = document.getElementById('hero');
    const scatterEl = document.getElementById('scatter-body');
    const rankingsEl = document.getElementById('rankings-body');

    // Render hero picks
    try {
        renderHeroPicks(heroEl, entries);
    } catch (err) {
        console.warn('[efficiency-map] hero render failed:', err);
    }

    // Render ranked table first (so scatter can reference it)
    let tableApi;
    try {
        tableApi = renderRankedTable(rankingsEl, entries);
    } catch (err) {
        console.warn('[efficiency-map] table render failed:', err);
    }

    // Render scatter plot with click -> scroll-to-row
    try {
        renderScatterPlot(scatterEl, entries, {
            onPointClick: key => {
                if (tableApi) tableApi.highlightRow(key);
            }
        });
    } catch (err) {
        console.warn('[efficiency-map] scatter render failed:', err);
    }
}

document.addEventListener('DOMContentLoaded', init);

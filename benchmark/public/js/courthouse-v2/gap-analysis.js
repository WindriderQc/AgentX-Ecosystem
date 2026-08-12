// gap-analysis.js — Ground Truth Gap Analysis section for courthouse-v2
// Renders a coverage grid (category × difficulty) showing GT entry counts.
// Export: renderGapAnalysis(container, gapData)

import { escHtml } from '../utils/format.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DIFFICULTIES = [1, 2, 3, 4, 5];

// ─── Count colour coding ──────────────────────────────────────────────────────

/**
 * Return background + text colour based on entry count.
 * 0 → red, 1–2 → amber, 3–4 → lime, 5+ → green
 * @param {number} count
 * @returns {{ bg: string, fg: string }}
 */
function countColors(count) {
    if (count === 0) return { bg: 'rgba(239,83,80,0.18)',  fg: 'var(--r-error)' };
    if (count <= 2)  return { bg: 'rgba(255,167,38,0.18)', fg: 'var(--r-anomaly)' };
    if (count <= 4)  return { bg: 'rgba(132,204,22,0.18)', fg: '#84cc16' };
    return             { bg: 'rgba(102,187,106,0.18)',     fg: 'var(--r-good)' };
}

// ─── Grid helpers ─────────────────────────────────────────────────────────────

/**
 * Build a lookup map: `${category}:${difficulty}` → count
 * @param {object[]} grid - [{category, difficulty, count}]
 * @returns {Map<string, number>}
 */
function buildLookup(grid) {
    const map = new Map();
    (grid || []).forEach(entry => {
        const key = `${entry.category || ''}:${entry.difficulty ?? ''}`;
        map.set(key, entry.count ?? 0);
    });
    return map;
}

/**
 * Extract sorted unique category names from the grid.
 * @param {object[]} grid
 * @returns {string[]}
 */
function extractCategories(grid) {
    const seen = new Set();
    (grid || []).forEach(e => {
        if (e.category) seen.add(e.category);
    });
    return [...seen].sort();
}

/**
 * Render one heatmap cell for a given count.
 * @param {number} count
 * @returns {string}
 */
function renderCell(count) {
    const { bg, fg } = countColors(count);
    const title = count === 1 ? '1 entry' : `${count} entries`;
    return `<td class="ga-cell" style="background:${bg};color:${fg};" title="${title}">${count}</td>`;
}

/**
 * Render the full coverage heatmap table.
 * @param {object[]} grid
 * @returns {string}
 */
function renderGrid(grid) {
    const categories = extractCategories(grid);
    const lookup = buildLookup(grid);

    if (!categories.length) {
        return `<div class="ga-empty" style="color:var(--r-text-dim);font-size:0.68rem;padding:0.5rem 0;">No ground truth entries found.</div>`;
    }

    const headerCells = DIFFICULTIES.map(d => `<th class="ga-th">L${d}</th>`).join('');

    const bodyRows = categories.map(cat => {
        const cells = DIFFICULTIES.map(d => {
            const count = lookup.get(`${cat}:${d}`) ?? 0;
            return renderCell(count);
        }).join('');
        return `<tr><td class="ga-cat">${escHtml(cat)}</td>${cells}</tr>`;
    }).join('');

    return `
        <div class="ga-table-wrap">
            <table class="ga-table">
                <thead>
                    <tr>
                        <th class="ga-th ga-th--cat">Category</th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>`;
}

// ─── Summary stat cards ───────────────────────────────────────────────────────

function statCard(label, value, valCls = '') {
    return `<div class="r-stat-card ch-stat-card">
        <div class="r-stat-val ${valCls}">${value}</div>
        <div class="r-stat-label">${label}</div>
    </div>`;
}

/**
 * Render summary stat cards from gapData.
 * @param {object} gapData
 * @returns {string}
 */
function renderStats(gapData) {
    const total    = gapData.total_entries ?? 0;
    const empty    = gapData.empty_cells   ?? 0;
    const coverage = gapData.coverage_pct  ?? 0;

    return `
        <div class="ga-stats">
            ${statCard('Total Entries',  total.toLocaleString(),           'v-total')}
            ${statCard('Empty Cells',    empty.toLocaleString(),            empty === 0 ? 'v-approved' : 'v-review')}
            ${statCard('Coverage',       Math.round(coverage) + '%',        coverage >= 80 ? 'v-approved' : coverage >= 50 ? 'v-override' : 'v-review')}
        </div>`;
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function renderLegend() {
    return `
        <div class="ga-legend">
            <span class="ga-legend-item" style="color:var(--r-error);">■ 0 — missing</span>
            <span class="ga-legend-item" style="color:var(--r-anomaly);">■ 1–2 — sparse</span>
            <span class="ga-legend-item" style="color:#84cc16;">■ 3–4 — ok</span>
            <span class="ga-legend-item" style="color:var(--r-good);">■ 5+ — good</span>
        </div>`;
}

// ─── Public export ────────────────────────────────────────────────────────────

/**
 * Render the Ground Truth Gap Analysis section into container.
 *
 * gapData shape (from GET /api/benchmark/judge/ground-truth/gaps):
 * {
 *   grid:          [{ category, difficulty, count }],
 *   total_entries: number,
 *   total_cells:   number,
 *   empty_cells:   number,
 *   coverage_pct:  number,
 * }
 *
 * @param {HTMLElement} container - the #gap-analysis element
 * @param {object}      gapData   - response .data from the gaps endpoint
 */
export function renderGapAnalysis(container, gapData = {}) {
    const grid = gapData.grid ?? [];

    container.innerHTML = `
        <div class="r-sec-head">
            <span class="r-sec-icon">🗺️</span>
            <span class="r-sec-title r-t-orange">Ground Truth Coverage</span>
            <span class="r-sec-count">${(gapData.total_entries ?? 0).toLocaleString()} entries</span>
            <span class="r-sec-toggle">▼</span>
        </div>
        <div class="r-sec-body ga-body">
            ${renderStats(gapData)}
            ${renderGrid(grid)}
            ${renderLegend()}
        </div>`;
}

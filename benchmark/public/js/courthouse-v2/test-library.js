// test-library.js — Test Library (Prompt Matrix) section for courthouse-v2
// Renders a category × difficulty table showing prompt counts.

const CATEGORIES = [
    'coding',
    'reasoning',
    'math',
    'knowledge',
    'instruction',
    'creative',
    'translation',
];

const LEVELS = [1, 2, 3, 4, 5];

// Level badge colours from spec
const LEVEL_STYLES = {
    1: { bg: '#166534', color: '#22c55e' },
    2: { bg: '#3f6212', color: '#84cc16' },
    3: { bg: '#854d0e', color: '#eab308' },
    4: { bg: '#9a3412', color: '#f97316' },
    5: { bg: '#7f1d1d', color: '#ef4444' },
};

/**
 * Build level header badge HTML.
 */
function levelBadge(n) {
    const s = LEVEL_STYLES[n];
    return `<span class="tm-lbadge" style="background:${s.bg};color:${s.color};">L${n}</span>`;
}

/**
 * Build a data cell for a given count.
 */
function cell(count) {
    if (count > 0) {
        return `<span class="tm-cell has">${count}</span>`;
    }
    return `<span class="tm-cell empty">—</span>`;
}

/**
 * Render the Test Library section into container.
 *
 * Each prompt entry expected to have:
 *   category        - string (one of CATEGORIES or arbitrary)
 *   difficulty_level - number 1–5
 *
 * @param {HTMLElement} container
 * @param {Array} prompts - array of prompt objects from fetchPrompts()
 */
export function renderTestLibrary(container, prompts) {
    if (!Array.isArray(prompts) || prompts.length === 0) {
        container.innerHTML = `
            <div class="r-sec-head">
                <span class="r-sec-icon">📚</span>
                <span class="r-sec-title r-t-cyan">Test Library</span>
                <span class="r-sec-count">0</span>
            </div>
            <div class="r-empty">No prompts available.</div>`;
        return;
    }

    // Build matrix: matrix[category][level] = count
    const matrix = {};
    const levelTotals = {};  // levelTotals[level] = count across all categories
    const catTotals = {};    // catTotals[category] = total across all levels
    let grandTotal = 0;

    // Collect all categories present in data (may extend beyond CATEGORIES list)
    const categoriesInData = new Set(CATEGORIES);

    for (const p of prompts) {
        const cat = (p.category || 'unknown').toLowerCase();
        const lvl = Number(p.difficulty_level) || 0;

        categoriesInData.add(cat);

        if (!matrix[cat]) matrix[cat] = {};
        matrix[cat][lvl] = (matrix[cat][lvl] || 0) + 1;

        catTotals[cat] = (catTotals[cat] || 0) + 1;
        levelTotals[lvl] = (levelTotals[lvl] || 0) + 1;
        grandTotal++;
    }

    // Ordered category list: known ones first, then any extras
    const orderedCats = [
        ...CATEGORIES.filter(c => categoriesInData.has(c)),
        ...[...categoriesInData].filter(c => !CATEGORIES.includes(c)).sort(),
    ];

    // Header row
    const headerCells = LEVELS.map(l =>
        `<th>${levelBadge(l)}</th>`
    ).join('');

    // Data rows
    const dataRows = orderedCats.map(cat => {
        const row = matrix[cat] || {};
        const levelCells = LEVELS.map(l =>
            `<td>${cell(row[l] || 0)}</td>`
        ).join('');
        const total = catTotals[cat] || 0;
        return `
            <tr>
                <td>${cat}</td>
                ${levelCells}
                <td><span class="tm-total">${total}</span></td>
            </tr>`;
    }).join('');

    // Total row
    const totalLevelCells = LEVELS.map(l =>
        `<td><span class="tm-total">${levelTotals[l] || 0}</span></td>`
    ).join('');

    const totalRow = `
        <tr class="tm-total-row">
            <td>Total</td>
            ${totalLevelCells}
            <td>${grandTotal}</td>
        </tr>`;

    container.innerHTML = `
        <div class="r-sec-head">
            <span class="r-sec-icon">📚</span>
            <span class="r-sec-title r-t-cyan">Test Library</span>
            <span class="r-sec-count">${prompts.length}</span>
        </div>
        <table class="tm-table">
            <thead>
                <tr>
                    <th>Category</th>
                    ${headerCells}
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>
                ${dataRows}
                ${totalRow}
            </tbody>
        </table>`;
}

// results-ledger.js — Compact paginated results ledger for courthouse-v2
// Exports renderResultsLedger(container, initialPage) and refreshLedger(container).

import { fetchResults } from './api.js';
import { escHtml } from '../utils/format.js';

const PAGE_LIMIT = 25;

// ─── Status badge helpers ─────────────────────────────────────────────────────

/**
 * Determine status key for a result row.
 * @param {object} r
 * @returns {'scored' | 'review' | 'approved' | 'override' | 'rejected'}
 */
function statusKey(r) {
    if (r.human_review_status === 'approved') return 'approved';
    if (r.human_review_status === 'overridden') return 'override';
    if (r.human_review_status === 'rejected') return 'rejected';
    if (r.human_score !== null && r.human_score !== undefined) return 'override';
    if (r.needs_review) return 'review';
    return 'scored';
}

const STATUS_META = {
    scored:   { cls: 'ls-scored',   label: 'scored' },
    review:   { cls: 'ls-review',   label: 'review' },
    approved: { cls: 'ls-scored',   label: 'approved' },
    override: { cls: 'ls-override', label: 'override' },
    rejected: { cls: 'ls-review',   label: 'rejected' },
};

function statusBadge(r) {
    const { cls, label } = STATUS_META[statusKey(r)];
    return `<span class="ls-status ${cls}">${label}</span>`;
}

// ─── Score coloring ───────────────────────────────────────────────────────────

function scoreClass(score) {
    if (score === null || score === undefined) return '';
    if (score >= 8) return 'h';
    if (score >= 5) return 'm';
    return 'l';
}

// ─── Table row ────────────────────────────────────────────────────────────────

function renderRow(r) {
    const id = r._id || r.id || '';
    const model = escHtml((r.model || '').replace(/:latest$/, ''));
    const prompt = escHtml((r.prompt_name || r.prompt || '').slice(0, 60));
    const level = r.prompt_level ?? r.level ?? '—';
    const category = escHtml(r.category || r.prompt_category || '—');
    const score = r.quality_score ?? r.composite_score;
    const scoreDisplay = score !== null && score !== undefined ? score.toFixed(1) : '—';
    const sc = scoreClass(score);
    const method = escHtml(r.judging_method || r.scoring_method || '—');

    return `<tr class="ledger-row" data-id="${escHtml(id)}" style="cursor:pointer;">
        <td class="ls-model">${model}</td>
        <td class="ls-prompt" title="${escHtml(r.prompt_name || r.prompt || '')}">${prompt}</td>
        <td>${level}</td>
        <td>${category}</td>
        <td class="ls-score ${sc}">${scoreDisplay}</td>
        <td>${method}</td>
        <td>${statusBadge(r)}</td>
    </tr>`;
}

// ─── Section header ───────────────────────────────────────────────────────────

function sectionHeader(total) {
    const countDisplay = total !== null && total !== undefined ? total.toLocaleString() : '…';
    return `<div class="r-sec-head">
        <span class="r-sec-icon">📋</span>
        <span class="r-sec-title r-t-cyan">Results Ledger</span>
        <span class="r-sec-count">${countDisplay}</span>
        <span class="r-sec-toggle">▼</span>
    </div>`;
}

// ─── Pagination controls ──────────────────────────────────────────────────────

function paginationHTML(page, totalPages) {
    const prevDisabled = page <= 1 ? ' disabled' : '';
    const nextDisabled = page >= totalPages ? ' disabled' : '';
    return `<div class="ledger-pagination" style="display:flex;align-items:center;gap:0.5rem;margin-top:0.4rem;font-size:0.62rem;">
        <button class="rq-chip ledger-prev"${prevDisabled}>← Prev</button>
        <span style="color:#555;">Page ${page} of ${totalPages || 1}</span>
        <button class="rq-chip ledger-next"${nextDisabled}>Next →</button>
    </div>`;
}

// ─── Internal state storage via DOM data attribute ────────────────────────────

function getState(container) {
    return container.__ledgerState || { page: 1, total: null, totalPages: 1, results: [], onSelect: null };
}

function setState(container, state) {
    container.__ledgerState = { ...(container.__ledgerState || {}), ...state };
}

// ─── Core render ─────────────────────────────────────────────────────────────

async function loadAndRender(container, page) {
    // Show loading indicator in body area without clobbering the header
    let bodyEl = container.querySelector('.ledger-body');
    if (bodyEl) {
        bodyEl.innerHTML = `<div style="padding:1rem;text-align:center;color:#444;font-size:0.7rem;">Loading…</div>`;
    }

    let results, total, totalPages;

    try {
        const data = await fetchResults({ page, limit: PAGE_LIMIT });

        // Normalise response shape
        if (Array.isArray(data)) {
            results = data;
            total = data.length;
            totalPages = 1;
        } else {
            const inner = data?.data || data || {};
            results = inner.results ?? (Array.isArray(inner) ? inner : []);
            total = inner.total ?? data.total ?? results.length;
            totalPages = inner.totalPages ?? inner.total_pages ?? Math.max(1, Math.ceil(total / PAGE_LIMIT));
        }
    } catch (err) {
        console.error('[results-ledger] fetchResults error:', err);
        if (bodyEl) {
            bodyEl.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--r-error);font-size:0.7rem;">Failed to load results: ${escHtml(err.message)}</div>`;
        }
        return;
    }

    setState(container, { page, total, totalPages, results });

    // Re-render the full container (header + body) to update count in header
    const rows = results.length > 0
        ? results.map(renderRow).join('')
        : `<tr><td colspan="7" style="text-align:center;color:#444;padding:1rem;">No results found.</td></tr>`;

    container.innerHTML = `
        ${sectionHeader(total)}
        <div class="ledger-body">
            <table class="ledger-table">
                <thead>
                    <tr>
                        <th>Model</th>
                        <th>Prompt</th>
                        <th>Level</th>
                        <th>Category</th>
                        <th>Score</th>
                        <th>Method</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            ${paginationHTML(page, totalPages)}
        </div>`;

    wirePagination(container);
    wireRowClicks(container);
}

// ─── Wire pagination buttons ─────────────────────────────────────────────────

function wirePagination(container) {
    container.querySelector('.ledger-prev')?.addEventListener('click', () => {
        const { page } = getState(container);
        if (page > 1) loadAndRender(container, page - 1);
    });

    container.querySelector('.ledger-next')?.addEventListener('click', () => {
        const { page, totalPages } = getState(container);
        if (page < totalPages) loadAndRender(container, page + 1);
    });
}

// ─── Wire row click → detail panel ──────────────────────────────────────────

function wireRowClicks(container) {
    const state = getState(container);
    const onSelect = state.onSelect;
    if (!onSelect) return;

    container.querySelectorAll('.ledger-row[data-id]').forEach(row => {
        row.addEventListener('click', () => {
            const id = row.dataset.id;
            const results = getState(container).results || [];
            const result = results.find(r => (r._id || r.id) === id);
            if (result) {
                // Highlight active row
                container.querySelectorAll('.ledger-row').forEach(el => el.classList.remove('is-active'));
                row.classList.add('is-active');
                onSelect(result);
            }
        });
    });
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Render the Results Ledger section into container.
 *
 * @param {HTMLElement} container   - #results-ledger element
 * @param {number}      initialPage - first page to load (default 1)
 * @param {Function}    onSelect    - callback(result) when a row is clicked
 */
export async function renderResultsLedger(container, initialPage = 1, onSelect = null) {
    setState(container, { onSelect });
    // Render header with placeholder count while fetching
    container.innerHTML = `
        ${sectionHeader(null)}
        <div class="ledger-body">
            <div style="padding:1rem;text-align:center;color:#444;font-size:0.7rem;">Loading…</div>
        </div>`;

    await loadAndRender(container, initialPage);
}

/**
 * Refresh the ledger back to page 1 (e.g. after a review action).
 *
 * @param {HTMLElement} container - #results-ledger element
 */
export async function refreshLedger(container) {
    await loadAndRender(container, 1);
}

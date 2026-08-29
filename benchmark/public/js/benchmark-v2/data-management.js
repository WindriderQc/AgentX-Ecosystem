// data-management.js — Data Management section for benchmark-v2
// Shows retention stats and provides purge / archive / reset controls.
// Export: renderDataManagement(container)

import { escHtml } from '../utils/format.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function statCard(label, value) {
    return `<div class="r-stat-card">
        <div class="r-stat-val">${escHtml(String(value))}</div>
        <div class="r-stat-label">${escHtml(label)}</div>
    </div>`;
}

/**
 * Update a status element with a message and colour.
 * @param {HTMLElement} el
 * @param {string} msg
 * @param {'running'|'ok'|'error'} type
 */
function setStatus(el, msg, type) {
    if (!el) return;
    const colorMap = {
        running: 'var(--r-text-muted)',
        ok:      'var(--r-good)',
        error:   'var(--r-error)',
    };
    el.textContent = msg;
    el.style.color = colorMap[type] ?? 'var(--r-text-muted)';
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function fetchStats() {
    const res = await fetch('/api/benchmark/retention/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.data ?? json;
}

async function postAction(path, body) {
    const res = await fetch(`/api/benchmark/retention/${path}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data ?? json;
}

// ── Stats rendering ───────────────────────────────────────────────────────────

function renderStats(stats) {
    return `<div class="dm-stats">
        ${statCard('Total Results',  stats.totalResults  ?? '—')}
        ${statCard('Total Batches',  stats.totalBatches  ?? '—')}
        ${statCard('Dead Models',    stats.deadModels    ?? '—')}
        ${statCard('Stale Batches',  stats.staleBatches  ?? '—')}
    </div>`;
}

// ── HTML skeleton ─────────────────────────────────────────────────────────────

function buildHtml(stats) {
    return `
        <div class="r-sec-head">
            <span class="r-sec-icon">&#128465;</span>
            <span class="r-sec-title r-t-orange">Data Management</span>
            <span class="r-sec-toggle">&#9660;</span>
        </div>
        <div class="r-sec-body dm-body">
            <div id="dm-stats-wrap">
                ${stats ? renderStats(stats) : '<div class="r-loading">Loading stats…</div>'}
            </div>
            <div class="dm-actions">
                <button class="ha-btn" id="dm-btn-purge">Purge Dead Models</button>
                <button class="ha-btn" id="dm-btn-archive">
                    Archive &gt;
                    <input id="dm-archive-days" type="number" value="90" min="1" max="3650"
                        style="width:3.5rem;margin:0 0.25rem;padding:0.1rem 0.2rem;
                               background:var(--r-bg-card);border:1px solid var(--r-border);
                               color:var(--r-text);border-radius:3px;font-size:0.7rem;"
                        title="Retention days"
                        onclick="event.stopPropagation()"
                    > days
                </button>
                <button class="ha-btn dm-danger" id="dm-btn-reset">Reset All</button>
            </div>
            <div class="dm-status" id="dm-status"></div>
        </div>`;
}

// ── Button wiring ─────────────────────────────────────────────────────────────

function wireButtons(container) {
    const statusEl  = container.querySelector('#dm-status');
    const statsWrap = container.querySelector('#dm-stats-wrap');

    /** Refresh stats panel in-place */
    async function refreshStats() {
        try {
            const stats = await fetchStats();
            if (statsWrap) statsWrap.innerHTML = renderStats(stats);
        } catch (err) {
            console.warn('[data-management] refreshStats failed:', err);
        }
    }

    // ── Purge Dead Models ──
    const btnPurge = container.querySelector('#dm-btn-purge');
    btnPurge?.addEventListener('click', async () => {
        btnPurge.disabled = true;
        setStatus(statusEl, 'Checking dead models…', 'running');

        try {
            // Dry run first to show count
            const dry = await postAction('purge-dead', { dry_run: true });
            const count = dry.would_delete ?? dry.deleted ?? 0;

            if (count === 0) {
                setStatus(statusEl, 'No dead model results found.', 'ok');
                btnPurge.disabled = false;
                return;
            }

            const expectedConfirmation = 'PURGE DEAD MODEL RESULTS';
            const confirmation = window.prompt(
                `This permanently deletes ${count} result(s) from models with at least 95% empty responses.\n\n`
                + `Type ${expectedConfirmation} to confirm:`
            );
            if (confirmation !== expectedConfirmation) {
                setStatus(statusEl, 'Purge cancelled — the exact phrase was not entered.', 'error');
                btnPurge.disabled = false;
                return;
            }

            setStatus(statusEl, `Found ${count} dead-model results — purging…`, 'running');
            const result = await postAction('purge-dead', {
                dry_run: false,
                confirm: confirmation
            });
            const deleted = result.deleted ?? result.results_deleted ?? count;
            setStatus(statusEl, `Purged ${deleted} dead-model results.`, 'ok');
            await refreshStats();
        } catch (err) {
            setStatus(statusEl, `Purge failed: ${err.message}`, 'error');
        }

        btnPurge.disabled = false;
    });

    // ── Archive Old Results ──
    const btnArchive = container.querySelector('#dm-btn-archive');
    btnArchive?.addEventListener('click', async () => {
        const daysInput = container.querySelector('#dm-archive-days');
        const days = parseInt(daysInput?.value, 10) || 90;
        const expectedConfirmation = `DELETE RESULTS OLDER THAN ${days} DAYS`;
        const confirmation = window.prompt(
            'Archiving removes stored result details and timelines while keeping batch metadata.\n\n'
            + `Type ${expectedConfirmation} to confirm:`
        );
        if (confirmation !== expectedConfirmation) {
            setStatus(statusEl, 'Archive cancelled — the exact phrase was not entered.', 'error');
            return;
        }

        btnArchive.disabled = true;
        setStatus(statusEl, `Archiving results older than ${days} days…`, 'running');

        try {
            const result = await postAction('archive', {
                retention_days: days,
                dry_run: false,
                confirm: confirmation
            });
            const archived = result.archived ?? result.results_archived ?? 0;
            setStatus(statusEl, `Archived ${archived} result(s) older than ${days} days.`, 'ok');
            await refreshStats();
        } catch (err) {
            setStatus(statusEl, `Archive failed: ${err.message}`, 'error');
        }

        btnArchive.disabled = false;
    });

    // ── Reset All ──
    const btnReset = container.querySelector('#dm-btn-reset');
    btnReset?.addEventListener('click', async () => {
        const input = window.prompt(
            'This deletes ALL benchmark results and batches.\n\nType RESET to confirm:'
        );
        if (input !== 'RESET') {
            setStatus(statusEl, 'Reset cancelled.', 'error');
            return;
        }

        btnReset.disabled = true;
        setStatus(statusEl, 'Resetting all benchmark data…', 'running');

        try {
            const result = await postAction('reset-all', { confirm: 'RESET' });
            const rDel = result.results_deleted ?? 0;
            const bDel = result.batches_deleted ?? 0;
            setStatus(statusEl, `Reset complete — ${rDel} results and ${bDel} batches deleted.`, 'ok');
            await refreshStats();
        } catch (err) {
            setStatus(statusEl, `Reset failed: ${err.message}`, 'error');
        }

        btnReset.disabled = false;
    });
}

// ── Public export ─────────────────────────────────────────────────────────────

/**
 * Render the Data Management section into container.
 * Fetches retention stats from the API, then wires action buttons.
 *
 * @param {HTMLElement} container - the #data-management element
 */
export async function renderDataManagement(container) {
    // Render skeleton immediately so the section is visible
    container.innerHTML = buildHtml(null);

    // Fetch real stats then patch in
    let stats = null;
    try {
        stats = await fetchStats();
        const statsWrap = container.querySelector('#dm-stats-wrap');
        if (statsWrap) statsWrap.innerHTML = renderStats(stats);
    } catch (err) {
        console.warn('[data-management] fetchStats failed:', err);
        const statsWrap = container.querySelector('#dm-stats-wrap');
        if (statsWrap) {
            statsWrap.innerHTML = `<div class="r-section-error ch-recoverable" role="alert">
                <span>Retention evidence is unavailable. No zero-count conclusion was inferred.</span>
                <button type="button" class="ch-retry-section dm-retry-stats">Retry</button>
            </div>`;
            statsWrap.querySelector('.dm-retry-stats')?.addEventListener('click', () => {
                renderDataManagement(container);
            });
        }
    }

    wireButtons(container);
}

// calibration.js — Judge Agreement section for courthouse-v2
// Renders an agreement heatmap (category × difficulty) + explicit run form.

import { isJudgeReady, judgeBlockedReason } from './readiness-state.js';
// Export: renderCalibration(container, { matrices, hosts })

// ─── Constants ────────────────────────────────────────────────────────────────

const DIFFICULTIES = [1, 2, 3, 4, 5];

// ─── Deviation colour coding ──────────────────────────────────────────────────

/**
 * Return background + text colour based on deviation magnitude.
 * ≤0.5 → green, ≤1.0 → lime, ≤1.5 → amber, >1.5 → red
 * @param {number|null} deviation
 * @returns {{ bg: string, fg: string }}
 */
function deviationColors(deviation) {
    if (deviation == null) return { bg: 'rgba(255,255,255,0.03)', fg: 'var(--r-text-dim)' };
    if (deviation <= 0.5) return { bg: 'rgba(102,187,106,0.18)', fg: 'var(--r-good)' };
    if (deviation <= 1.0) return { bg: 'rgba(132,204,22,0.18)',  fg: '#84cc16' };
    if (deviation <= 1.5) return { bg: 'rgba(255,167,38,0.18)',  fg: 'var(--r-anomaly)' };
    return { bg: 'rgba(239,83,80,0.18)', fg: 'var(--r-error)' };
}

// ─── Heatmap helpers ──────────────────────────────────────────────────────────

/**
 * Build all unique category names from a matrix's entries.
 * @param {object} matrix - latest calibration matrix
 * @returns {string[]}
 */
function extractCategories(matrix) {
    const entries = matrix?.cells ?? matrix?.entries ?? matrix?.accuracy_by_category ?? [];
    const seen = new Set();
    entries.forEach(e => {
        const cat = e.category || e.cat || '';
        if (cat) seen.add(cat);
    });
    return [...seen].sort();
}

/**
 * Build a lookup map: `${category}:${difficulty}` → entry object
 * @param {object} matrix
 * @returns {Map<string, object>}
 */
function buildLookup(matrix) {
    const entries = matrix?.cells ?? matrix?.entries ?? matrix?.accuracy_by_category ?? [];
    const map = new Map();
    entries.forEach(e => {
        const key = `${e.category || ''}:${e.difficulty ?? ''}`;
        map.set(key, e);
    });
    return map;
}

/**
 * Render a single heatmap cell.
 * @param {object|null} entry
 * @returns {string}
 */
function renderCell(entry) {
    if (!entry) {
        return `<td class="cal-cell cal-cell--empty" title="No corpus entries were scored for this category/level combination in this agreement run.">—</td>`;
    }
    const dev = entry.deviation ?? entry.avg_deviation ?? null;
    const acc = entry.accuracy ?? entry.avg_accuracy ?? null;
    const { bg, fg } = deviationColors(dev);
    const devStr = dev != null ? dev.toFixed(2) : '—';
    const accStr = acc != null ? Math.round(acc * 100) + '%' : '—';
    const qualityLabel = dev != null
        ? (dev <= 0.5 ? 'Reliable' : dev <= 1.0 ? 'Acceptable' : dev <= 1.5 ? 'Watch' : 'Drifting')
        : 'Unknown';
    const title = `Reference-judge agreement: ${accStr} | Score deviation: ${devStr} — ${qualityLabel}. This does not measure direct agreement with human scores.`;
    return `<td class="cal-cell" style="background:${bg};color:${fg};" title="${escHtml(title)}">${devStr}</td>`;
}

/**
 * Onboarding panel shown when there is no calibration data yet.
 * Explains the calibration → Trusted-leaderboard loop and links to the review
 * queue where ground truth is built. Honest empty state — no fabricated data.
 * The CTA carries `data-jump="review"`; wired in renderCalibration().
 * @returns {string}
 */
function calibrationOnboarding() {
    const step = (n, html) => `<div style="display:flex;gap:0.55rem;align-items:flex-start;margin:0.3rem 0;">
        <span style="flex:0 0 auto;width:1.25rem;height:1.25rem;border-radius:999px;background:rgba(255,167,38,0.18);color:var(--r-anomaly);font-weight:800;font-size:0.72rem;display:inline-flex;align-items:center;justify-content:center;">${n}</span>
        <span style="color:#bbb;font-size:0.8rem;line-height:1.4;">${html}</span>
    </div>`;
    return `
        <div class="cal-onboard" style="background:var(--r-bg-inner);border:1px solid var(--r-border);border-radius:8px;padding:0.7rem 0.85rem;margin:0.4rem 0;">
            <div style="font-weight:700;color:var(--r-text);font-size:0.9rem;margin-bottom:0.3rem;">No judge-agreement data yet</div>
            <p style="color:#bbb;font-size:0.8rem;line-height:1.45;margin:0 0 0.5rem;">This matrix measures how closely a judge agrees with a distinct reference judge on reviewed corpus entries. It is not a direct human-score accuracy measurement and is not used to admit rows into the Leaderboard's <strong>Trusted</strong> evidence cohort.</p>
            ${step(1, 'Open the <strong>Review</strong> queue and curate representative corpus entries.')}
            ${step(2, 'Run the <strong>agreement check</strong> below with two distinct judge targets.')}
            ${step(3, 'Inspect coverage and disagreement before using the judge operationally.')}
            <div style="margin-top:0.6rem;">
                <button class="ha-btn primary" data-jump="review" title="Switch to the Review tab and jump to the review queue">→ Go to Review queue</button>
            </div>
        </div>`;
}

/**
 * Render the heatmap table for one matrix.
 * @param {object} matrix
 * @returns {string}
 */
function renderHeatmap(matrix) {
    const categories = extractCategories(matrix);
    const lookup = buildLookup(matrix);

    if (!categories.length) {
        return calibrationOnboarding();
    }

    const headerCells = DIFFICULTIES.map(d => `<th class="cal-th" title="Difficulty Level ${d} — average score deviation between candidate and reference judge">L${d}</th>`).join('');

    const bodyRows = categories.map(cat => {
        const cells = DIFFICULTIES.map(d => {
            const entry = lookup.get(`${cat}:${d}`) ?? null;
            return renderCell(entry);
        }).join('');
        return `<tr><td class="cal-cat">${escHtml(cat)}</td>${cells}</tr>`;
    }).join('');

    return `
        <div class="cal-table-wrap">
            <table class="cal-table">
                <thead>
                    <tr>
                        <th class="cal-th cal-th--cat">Category</th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
            <div class="cal-legend">
                <span class="cal-legend-item" style="color:var(--r-good);">● ≤0.5 good</span>
                <span class="cal-legend-item" style="color:#84cc16;">● ≤1.0 ok</span>
                <span class="cal-legend-item" style="color:var(--r-anomaly);">● ≤1.5 warn</span>
                <span class="cal-legend-item" style="color:var(--r-error);">● &gt;1.5 bad</span>
                <span class="cal-legend-note">Values = avg candidate/reference-judge deviation</span>
            </div>
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
 * Render summary stats from the latest matrix.
 * @param {object} matrix
 * @returns {string}
 */
function renderStats(matrix) {
    const rawPassRate = matrix?.pass_rate ?? matrix?.overall_accuracy ?? null;
    const passRate = rawPassRate == null
        ? null
        : (rawPassRate <= 1 ? rawPassRate * 100 : rawPassRate);
    const avgDev   = matrix?.overall_avg_deviation ?? matrix?.avg_deviation ?? null;
    const gtCount  = matrix?.ground_truth_count ?? matrix?.entry_count ?? null;
    const lastCal  = matrix?.calibrated_at ?? matrix?.created_at ?? null;

    const passStr  = passRate != null ? Math.round(passRate) + '%' : '—';
    const devStr   = avgDev   != null ? Number(avgDev).toFixed(2)         : '—';
    const gtStr    = gtCount  != null ? Number(gtCount).toLocaleString()  : '—';
    const dateStr  = lastCal  ? new Date(lastCal).toLocaleDateString()    : 'Never';

    return `
        <div class="cal-stats">
            ${statCard('Entry Pass Rate', passStr,  'v-approved')}
            ${statCard('Avg Judge Δ',     devStr,   'v-calib')}
            ${statCard('Corpus Entries',  gtStr,    'v-total')}
            ${statCard('Last Checked',    dateStr,  'v-review')}
        </div>`;
}

// ─── Run Calibration form ─────────────────────────────────────────────────────

/**
 * Build option elements for a host <select>.
 * @param {Array<{url:string, name:string}>} hosts
 * @returns {string}
 */
function hostOptions(hosts) {
    if (!hosts.length) return '<option value="">No configured hosts available</option>';
    return '<option value="">Select a configured host…</option>'
        + hosts.map(h => `<option value="${escHtml(h.url)}">${escHtml(h.name)}</option>`).join('');
}

function renderMatrixProvenance(matrix) {
    if (!matrix) return '';
    const judge = matrix.judge_model || 'unknown judge';
    const judgeHost = matrix.judge_host || 'unknown host';
    const reference = matrix.reference_model || 'unknown reference judge';
    const referenceHost = matrix.reference_host || 'unknown host';
    return `<p class="cal-run-safety" role="note">
        Agreement evidence: <strong>${escHtml(judge)}</strong> on ${escHtml(judgeHost)}
        versus <strong>${escHtml(reference)}</strong> on ${escHtml(referenceHost)}.
        This matrix is not a direct comparison with human scores.
    </p>`;
}

function readinessCopy() {
    return isJudgeReady()
        ? 'Readiness is confirmed for at least one configured judge. Select two distinct targets for this agreement run.'
        : `${judgeBlockedReason()} You may choose installed models explicitly below; the server will probe them again before starting.`;
}

function refreshReadinessCopy(root = document) {
    const note = root?.querySelector?.('[data-cal-readiness-note]');
    if (note) {
        note.textContent = `${readinessCopy()} Agent X will not download or auto-select a model.`;
    }
}

/**
 * Render the "Run Calibration" form.
 * @param {Array<{url:string, name:string}>} hosts
 * @returns {string}
 */
function renderRunForm(hosts) {
    const opts = hostOptions(hosts);
    return `
        <div class="cal-run-form" id="cal-run-form">
            <div class="cal-run-title">Run Judge Agreement Check</div>
            <p class="cal-run-safety" role="note" data-cal-readiness-note>${escHtml(readinessCopy())} Agent X will not download or auto-select a model.</p>
            <div class="cal-run-fields">
                <label class="cal-field">
                    <span class="cal-field-label">Judge Host</span>
                    <select class="cal-select" id="cal-judge-host">${opts}</select>
                </label>
                <label class="cal-field">
                    <span class="cal-field-label">Judge Model</span>
                    <select class="cal-select" id="cal-judge" disabled><option value="">Choose a host first</option></select>
                </label>
                <label class="cal-field">
                    <span class="cal-field-label">Reference Host</span>
                    <select class="cal-select" id="cal-ref-host">${opts}</select>
                </label>
                <label class="cal-field">
                    <span class="cal-field-label">Reference Judge Model</span>
                    <select class="cal-select" id="cal-ref" disabled><option value="">Choose a host first</option></select>
                </label>
            </div>
            <div class="cal-run-actions">
                <button class="ha-btn primary" id="cal-run-btn">▶ Run Agreement Check</button>
                <span class="cal-run-status" id="cal-run-status"></span>
            </div>
        </div>`;
}

// ─── Wire run button ──────────────────────────────────────────────────────────

/**
 * Attach click handler for the Run Calibration button.
 * On success, re-fetches calibration status and re-renders.
 * @param {HTMLElement} container
 * @param {Array} hosts
 */
function wireRunButton(container, hosts) {
    const btn    = container.querySelector('#cal-run-btn');
    const status = container.querySelector('#cal-run-status');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const judgeModel = container.querySelector('#cal-judge')?.value?.trim();
        const judgeHost  = container.querySelector('#cal-judge-host')?.value;
        const refModel   = container.querySelector('#cal-ref')?.value?.trim();
        const refHost    = container.querySelector('#cal-ref-host')?.value;

        if (!judgeHost || !judgeModel || !refHost || !refModel) {
            setStatus(status, 'Choose judge and reference host/model pairs explicitly.', 'error');
            return;
        }

        btn.disabled = true;
        setStatus(status, 'Running…', 'running');

        try {
            const res = await fetch('/api/benchmark/judge/matrix-calibrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    judge_model:     judgeModel,
                    judge_host:      judgeHost  || undefined,
                    reference_model: refModel   || undefined,
                    reference_host:  refHost    || undefined,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setStatus(status, err.error || `Error ${res.status}`, 'error');
                btn.disabled = false;
                return;
            }

            setStatus(status, 'Agreement check complete — refreshing…', 'ok');

            // Refresh section
            try {
                const calRes = await fetch('/api/benchmark/judge/calibration-status').then(r => r.json());
                const matrices = calRes.data?.matrices || [];
                renderCalibration(container, { matrices, hosts });
            } catch (fetchErr) {
                console.warn('[calibration] refresh after run failed:', fetchErr);
                btn.disabled = false;
            }

        } catch (err) {
            console.error('[calibration] run error:', err);
            setStatus(status, 'Network error — check console.', 'error');
            btn.disabled = false;
        }
    });
}

/**
 * Update a status span with a message and colour.
 * @param {HTMLElement} el
 * @param {string} msg
 * @param {'running'|'ok'|'error'} type
 */
function setStatus(el, msg, type) {
    if (!el) return;
    const colorMap = { running: 'var(--r-text-muted)', ok: 'var(--r-good)', error: 'var(--r-error)' };
    el.textContent = msg;
    el.style.color = colorMap[type] ?? 'var(--r-text-muted)';
}

// ─── Model dropdown loader ────────────────────────────────────────────────────

/**
 * Fetch the model list for a given host URL and populate a <select> element.
 * @param {string}      hostUrl  - the host URL to match in hosts-status response
 * @param {HTMLElement} selectEl - the <select> to populate
 */
async function loadModelsForHost(hostUrl, selectEl) {
    if (!selectEl) return;
    if (!hostUrl) {
        selectEl.disabled = true;
        selectEl.innerHTML = '<option value="">Choose a host first</option>';
        return;
    }
    selectEl.disabled = true;
    selectEl.innerHTML = '<option value="">Checking installed models…</option>';
    try {
        const res  = await fetch('/api/profiler/hosts/test/hosts-status');
        const data = await res.json();
        const hosts    = data.data?.hosts || data.data || [];
        const hostData = hosts.find(h => (h.url || h.host) === hostUrl);
        const models   = hostData?.models || [];
        selectEl.innerHTML = models.length
            ? '<option value="">Select an installed model…</option>'
                + models.map(m => `<option value="${escHtml(m.name || m)}">${escHtml(m.name || m)}</option>`).join('')
            : '<option value="">No models found</option>';
        selectEl.disabled = models.length === 0;
    } catch (err) {
        console.warn('[calibration] loadModelsForHost error:', err);
        selectEl.innerHTML = '<option value="">Failed to load</option>';
        selectEl.disabled = true;
    }
}

// ─── Public export ────────────────────────────────────────────────────────────

/**
 * Render the Calibration section into container.
 *
 * @param {HTMLElement} container - the #calibration element
 * @param {object}      opts
 * @param {object[]}    opts.matrices - calibration matrix objects (newest first)
 * @param {object[]}    opts.hosts    - [{url, name}] array from hosts-status
 */
export function renderCalibration(container, { matrices = [], hosts = [] } = {}) {
    const latest = matrices[0] ?? null;

    container.innerHTML = `
        <div class="r-sec-head">
            <span class="r-sec-icon">🎯</span>
            <span class="r-sec-title r-t-orange">Judge Agreement Matrix</span>
            <span class="r-sec-count">${matrices.length} matrix${matrices.length !== 1 ? 'es' : ''}</span>
            <span class="r-sec-toggle">▼</span>
        </div>
        <div class="r-sec-body cal-body">
            ${renderStats(latest)}
            ${renderMatrixProvenance(latest)}
            ${renderHeatmap(latest)}
            ${renderRunForm(hosts)}
        </div>`;

    wireRunButton(container, hosts);

    // ── Onboarding CTA: jump to the Review tab + queue ──
    const jumpBtn = container.querySelector('[data-jump="review"]');
    if (jumpBtn) {
        jumpBtn.addEventListener('click', () => {
            const reviewTab = document.querySelector('.ch-tab[data-tab="review"]');
            if (reviewTab) reviewTab.click();
            const queue = document.getElementById('review-queue');
            if (queue) queue.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // ── Model dropdowns ──
    const judgeHostSel = container.querySelector('#cal-judge-host');
    const refHostSel   = container.querySelector('#cal-ref-host');
    const judgeSel     = container.querySelector('#cal-judge');
    const refSel       = container.querySelector('#cal-ref');

    // Reload when host selection changes
    judgeHostSel?.addEventListener('change', () => loadModelsForHost(judgeHostSel.value, judgeSel));
    refHostSel?.addEventListener('change',   () => loadModelsForHost(refHostSel.value,   refSel));
}

if (typeof document !== 'undefined') {
    // The Bench and this panel load concurrently. Refresh the note whenever the
    // authoritative server readiness arrives so the form cannot retain the
    // bootstrap "no judge ready" placeholder beside a READY host card.
    document.addEventListener('judge-readiness-changed', () => refreshReadinessCopy(document));
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

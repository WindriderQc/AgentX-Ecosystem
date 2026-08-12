// the-bench.js — Courthouse v2 top zone: host-grouped judge selector.
// Replaces the legacy hero + judge-roster sections. One column per host;
// each column shows its active (default) judge + promote-able candidates.
//
// Endpoints:
//   GET /api/benchmark/judge-roster               — host panels + candidates
//   GET /api/benchmark/judge/calibration-status   — pass rate, avg deviation
//   GET /api/benchmark/dashboard                  — global stat strip
//   PUT /api/benchmark/judge-defaults             — promote a judge

import { escHtml } from '../utils/format.js';
import { apiFetch } from '../utils/api.js';

const EMOJI = { clawdx: 'Cx', brutal: 'Br', frank: 'Fk' };

function hostKey(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('clawd')) return 'clawdx';
    if (n.includes('brutal')) return 'brutal';
    if (n.includes('frank')) return 'frank';
    return 'host';
}

function calBadge(cal) {
    if (!cal) return `<span class="tb-cal tb-cal-none">uncalibrated</span>`;
    const pr = cal.pass_rate ?? 0;
    const dv = cal.avg_deviation ?? 0;
    const tone = pr >= 80 ? 'ok' : pr >= 50 ? 'warn' : 'bad';
    return `<span class="tb-cal tb-cal-${tone}" title="pass ${pr.toFixed(0)}% · dev ${dv.toFixed(2)} · ${cal.ground_truth_count || 0} GT">
              ${pr.toFixed(0)}% · Δ${dv.toFixed(2)}
            </span>`;
}

function candidateRow(host, judge, isActive, cal) {
    const name = escHtml(judge.modelName);
    const evals = (judge.evalCount || 0).toLocaleString();
    const success = judge.successRate != null ? judge.successRate.toFixed(0) + '%' : '—';
    const btn = isActive
        ? `<span class="tb-active-pill">ACTIVE</span>`
        : `<button class="tb-promote"
                   data-host-url="${escHtml(host.hostUrl)}"
                   data-judge="${name}">promote</button>`;
    return `
        <div class="tb-cand ${isActive ? 'tb-cand-active' : ''}">
            <div class="tb-cand-top">
                <span class="tb-cand-name">${name}</span>
                ${calBadge(cal)}
            </div>
            <div class="tb-cand-meta">
                <span>${evals} evals</span>
                <span class="tb-dot">·</span>
                <span>${success} success</span>
            </div>
            <div class="tb-cand-action">${btn}</div>
        </div>`;
}

function hostColumn(host, calMap) {
    const key = hostKey(host.hostName);
    const active = host.defaultJudgeModel || null;
    const candidates = (host.judges || []).slice(0, 6);

    // Keep the active judge on top even if it's not in the top-N
    const ordered = active
        ? [
            ...candidates.filter(j => j.modelName === active),
            ...candidates.filter(j => j.modelName !== active)
          ]
        : candidates;

    const rows = ordered.length
        ? ordered.map(j => candidateRow(host, j, j.modelName === active, calMap[j.modelName])).join('')
        : `<div class="tb-empty">No judge-capable models discovered on this host.</div>`;

    const header = active
        ? `<div class="tb-host-active">⚖ ${escHtml(active)}</div>`
        : `<div class="tb-host-idle">no judge assigned</div>`;

    return `
        <div class="tb-host tb-host-${key}">
            <div class="tb-host-head">
                <span class="tb-host-ring">${EMOJI[key] || 'H'}</span>
                <div class="tb-host-ident">
                    <div class="tb-host-name">${escHtml(host.hostName)}</div>
                    <div class="tb-host-url">${escHtml(host.hostUrl)}</div>
                </div>
                ${header}
            </div>
            <div class="tb-cand-list">${rows}</div>
        </div>`;
}

function statChip(label, value, tone = '', icon = '') {
    return `
        <div class="tb-stat tb-stat-${tone}">
            ${icon ? `<div class="tb-stat-icon">${icon}</div>` : ''}
            <div class="tb-stat-val">${value}</div>
            <div class="tb-stat-lbl">${label}</div>
        </div>`;
}

function deriveDashboardCounts(dashboard) {
    const d = dashboard?.data || {};
    const o = d.overview || {};
    const ms = Array.isArray(d.model_stats) ? d.model_stats : [];
    return {
        total:     o.total_tests          ?? ms.reduce((s, m) => s + (m.total_tests || 0), 0),
        review:    o.needs_review_count   ?? ms.reduce((s, m) => s + (m.needs_review || 0), 0),
        approved:  o.human_reviewed_count ?? ms.reduce((s, m) => s + (m.human_reviewed || 0), 0),
        overrides: o.override_count       ?? ms.reduce((s, m) => s + (m.overrides || 0), 0),
        gt:        o.ground_truth_count   ?? 0,
    };
}

function attachPromoteHandlers(root) {
    root.querySelectorAll('.tb-promote').forEach(btn => {
        btn.addEventListener('click', async () => {
            const hostUrl = btn.dataset.hostUrl;
            const judgeModel = btn.dataset.judge;
            btn.disabled = true;
            btn.textContent = 'promoting…';
            try {
                await apiFetch('/api/benchmark/judge-defaults', {
                    method: 'PUT',
                    body: { hostUrl, judgeModel }
                });
                // Re-render the bench after a successful promotion.
                document.dispatchEvent(new CustomEvent('bench-refresh'));
            } catch (err) {
                console.error('[the-bench] promote failed', err);
                btn.disabled = false;
                btn.textContent = 'promote';
                btn.classList.add('tb-promote-err');
                setTimeout(() => btn.classList.remove('tb-promote-err'), 1800);
            }
        });
    });
}

export async function renderBench(container, { dashboard } = {}) {
    if (!container) return;

    container.innerHTML = `<div class="tb-loading">Loading the bench…</div>`;

    let rosterRes, calRes;
    try {
        [rosterRes, calRes] = await Promise.all([
            apiFetch('/api/benchmark/judge-roster'),
            apiFetch('/api/benchmark/judge/calibration-status').catch(() => ({ data: { matrices: [] } })),
        ]);
    } catch (err) {
        console.error('[the-bench] fetch error', err);
        container.innerHTML = `<div class="tb-error">Could not load the bench. ${escHtml(err.message || '')}</div>`;
        return;
    }

    const hostPanels = rosterRes?.data?.hostPanels || [];
    const calMap = {};
    for (const m of (calRes?.data?.matrices || [])) {
        calMap[m.judge_model] = {
            pass_rate:           m.pass_rate,
            avg_deviation:       m.overall_avg_deviation,
            calibrated_at:       m.calibrated_at,
            ground_truth_count:  m.ground_truth_count,
        };
    }

    const columns = hostPanels.map(h => hostColumn(h, calMap)).join('');
    const counts = deriveDashboardCounts(dashboard);
    const assigned = hostPanels.filter(h => h.defaultJudgeModel).length;
    const totalHosts = hostPanels.length;

    container.innerHTML = `
        <div class="tb-frame">
            <div class="tb-head">
                <div class="tb-title">
                    <span class="tb-gavel">⚖</span>
                    <div>
                        <div class="tb-title-main">The Bench</div>
                        <div class="tb-title-sub">${assigned}/${totalHosts} hosts have an active judge — set who scores on each host before running a benchmark.</div>
                    </div>
                </div>
                <div class="tb-stat-strip">
                    ${statChip('Results',      counts.total.toLocaleString(),     'total',    '▣')}
                    ${statChip('Need Review',  counts.review.toLocaleString(),    'review',   '⚑')}
                    ${statChip('Approved',     counts.approved.toLocaleString(),  'approved', '✓')}
                    ${statChip('Overrides',    counts.overrides.toLocaleString(), 'override', '⇄')}
                    ${statChip('Ground Truth', counts.gt.toLocaleString(),        'gt',       '◎')}
                </div>
            </div>
            <div class="tb-columns">${columns}</div>
            <div class="tb-quick-links">
                <a href="/leaderboard"       class="tb-link">Leaderboard →</a>
                <a href="/benchmark"         class="tb-link">Benchmark →</a>
                <a href="/results-explorer"  class="tb-link">Results Explorer →</a>
            </div>
        </div>`;

    attachPromoteHandlers(container);

    // Expose review count for the tab badge
    const badge = document.getElementById('ch-tab-review-badge');
    if (badge && counts.review > 0) badge.textContent = String(counts.review);
}

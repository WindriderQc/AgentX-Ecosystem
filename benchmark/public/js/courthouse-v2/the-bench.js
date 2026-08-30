// the-bench.js — Courthouse v2 top zone: host-grouped judge selector.
// Replaces the legacy hero + judge-roster sections. One column per host;
// each column shows its active (default) judge + selectable candidates.
//
// Endpoints:
//   GET /api/benchmark/judge-roster               — host panels + candidates
//   GET /api/benchmark/judge/calibration-status   — pass rate, avg deviation
//   GET /api/benchmark/dashboard                  — global stat strip
//   PUT /api/benchmark/judge-defaults             — select one active judge target

import { escHtml } from '../utils/format.js';
import { apiFetch } from '../utils/api.js';
import { settleEvidence, withRecoverableJudgeSetup } from './settled-evidence.js';

function hostBadge(name) {
    const parts = String(name || 'Host').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'H';
}

function calBadge(cal) {
    if (!cal) return `<span class="tb-cal tb-cal-none">uncalibrated</span>`;
    const passKnown = cal.pass_rate !== null && cal.pass_rate !== undefined
        && Number.isFinite(Number(cal.pass_rate));
    const deviationKnown = cal.avg_deviation !== null && cal.avg_deviation !== undefined
        && Number.isFinite(Number(cal.avg_deviation));
    if (!passKnown || !deviationKnown) {
        return `<span class="tb-cal tb-cal-none" title="A calibration record exists, but its agreement measurements are unavailable">unknown agreement</span>`;
    }
    const pr = Number(cal.pass_rate);
    const dv = Number(cal.avg_deviation);
    const corpusCount = cal.ground_truth_count !== null && cal.ground_truth_count !== undefined
        && Number.isFinite(Number(cal.ground_truth_count))
        ? Number(cal.ground_truth_count).toLocaleString()
        : 'unknown';
    const tone = pr >= 80 ? 'ok' : pr >= 50 ? 'warn' : 'bad';
    return `<span class="tb-cal tb-cal-${tone}" title="reference-judge agreement · entry pass ${pr.toFixed(0)}% · dev ${dv.toFixed(2)} · ${corpusCount} corpus entries">
              ${pr.toFixed(0)}% · Δ${dv.toFixed(2)}
            </span>`;
}

function calibrationKey(host, model) {
    const normalizedHost = String(host || '').trim().replace(/\/+$/, '').toLowerCase();
    const normalizedModel = String(model || '').trim().toLowerCase();
    return `${normalizedHost}@@${normalizedModel}`;
}

function candidateRow(host, judge, isActive, cal) {
    const name = escHtml(judge.modelName);
    const evals = (judge.evalCount || 0).toLocaleString();
    const success = judge.successRate != null ? judge.successRate.toFixed(0) + '%' : '—';
    const btn = isActive
        ? `<span class="tb-active-pill">ACTIVE</span>`
        : `<button class="tb-promote"
                   title="Set this model as the selected judge target for this host. Batches still use one selected judge target; this does not add load balancing or capacity."
                   data-host-url="${escHtml(host.hostUrl)}"
                   data-judge="${name}">set active</button>`;
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

function hostColumn(host, calMap, index) {
    const tone = index % 3;
    const active = host.selectedJudgeModel || host.defaultJudgeModel || null;
    const candidates = (host.judges || []).slice(0, 6);

    // Keep the active judge on top even if it's not in the top-N
    const ordered = active
        ? [
            ...candidates.filter(j => j.modelName === active),
            ...candidates.filter(j => j.modelName !== active)
          ]
        : candidates;

    const rows = host.evidenceUnavailable
        ? `<div class="tb-empty">Judge roster evidence is unavailable. Use Retry check to try again.</div>`
        : ordered.length
        ? ordered.map(j => candidateRow(
            host,
            j,
            j.modelName === active,
            calMap[calibrationKey(host.hostUrl, j.modelName)]
        )).join('')
        : `<div class="tb-empty">No judge-capable models discovered on this host.</div>`;

    const header = host.judgeReady
        ? `<div class="tb-host-active" title="Selected model is installed and the host answered the readiness probe">READY · ⚖ ${escHtml(active)}</div>`
        : active
        ? `<div class="tb-host-idle" title="${escHtml(host.readinessReason || 'Judge unavailable')}">configured · unavailable</div>`
        : `<div class="tb-host-idle">no judge assigned</div>`;

    return `
        <div class="tb-host tb-host-tone-${tone}">
            <div class="tb-host-head">
                <span class="tb-host-ring">${escHtml(hostBadge(host.hostName))}</span>
                <div class="tb-host-ident">
                    <div class="tb-host-name">${escHtml(host.hostName)}</div>
                    <div class="tb-host-url">${escHtml(host.hostUrl)}</div>
                </div>
                ${header}
            </div>
            <div class="tb-cand-list">${rows}</div>
        </div>`;
}

function readinessBanner(readiness) {
    const ready = readiness?.ready === true;
    const mode = ready ? (readiness.status === 'degraded' ? 'degraded' : 'ready') : 'blocked';
    const title = ready
        ? (mode === 'degraded' ? 'Judge scoring is partially ready' : 'Judge scoring is ready')
        : 'Judge scoring is unavailable';
    const summary = readiness?.summary || 'Judge readiness could not be confirmed.';
    const judgeCopy = readiness?.evidence_modes?.judge_scored?.description
        || 'Judge-dependent actions require a selected, reachable model.';
    const setupHref = readiness?.setup?.href || '#the-bench';
    const setupLabel = readiness?.setup?.label || 'Choose an installed model below';

    return `<div class="tb-readiness tb-readiness-${mode}" role="${ready ? 'status' : 'alert'}" data-judge-ready="${ready ? 'true' : 'false'}">
        <div class="tb-readiness-main">
            <span class="tb-readiness-dot" aria-hidden="true"></span>
            <div>
                <strong>${escHtml(title)}</strong>
                <span>${escHtml(summary)} ${escHtml(judgeCopy)}</span>
            </div>
        </div>
        <div class="tb-readiness-actions">
            <button type="button" class="tb-retry-readiness">Retry check</button>
            ${ready ? '' : `<a href="${escHtml(setupHref)}" class="tb-choose-judge">${escHtml(setupLabel)}</a>`}
        </div>
        <div class="tb-evidence-modes" aria-label="Evidence availability">
            <span class="tb-evidence tb-evidence-ok"><strong>Deterministic evidence</strong> available</span>
            <span class="tb-evidence ${ready ? 'tb-evidence-ok' : 'tb-evidence-blocked'}"><strong>Judge-scored evidence</strong> ${ready ? 'available' : 'blocked'}</span>
            <span class="tb-no-implicit">No model is downloaded or selected automatically.</span>
        </div>
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
    if (!dashboard) {
        return { total: null, review: null, approved: null, overrides: null, gt: null };
    }
    const d = dashboard?.data || {};
    const o = d.overview || {};
    return {
        total:     o.total_tests          ?? null,
        review:    o.needs_review_count   ?? null,
        approved:  o.human_reviewed_count ?? null,
        overrides: o.override_count       ?? null,
        gt:        o.ground_truth_count   ?? null,
    };
}

function countDisplay(value) {
    return value == null ? '—' : Number(value).toLocaleString();
}

function fallbackReadiness(hostPanels = []) {
    return {
        ready: false,
        status: 'blocked',
        code: 'readiness_unavailable',
        ready_host_count: 0,
        configured_host_count: hostPanels.length,
        summary: 'Judge readiness could not be confirmed. Retry the check or open setup.',
        evidence_modes: {
            deterministic: { status: 'available' },
            judge_scored: {
                status: 'blocked',
                description: 'Judge-dependent actions remain blocked until readiness can be confirmed.'
            }
        },
        setup: {
            href: '/setup?focus=judge',
            label: 'Open judge setup'
        },
        retry: {
            method: 'GET',
            href: '/api/benchmark/judge/readiness?refresh=1',
            label: 'Retry readiness check'
        }
    };
}

function panelsFromReadiness(readiness) {
    return (readiness?.hosts || []).map((host) => ({
        hostUrl: host.hostUrl,
        hostName: host.hostName,
        defaultJudgeModel: null,
        selectedJudgeModel: host.selectedModel || null,
        selectionSource: host.selectionSource || null,
        judgeReady: host.ready === true,
        readinessReason: host.reason || 'readiness_unavailable',
        reachable: host.reachable === true,
        judges: [],
        evidenceUnavailable: true
    }));
}

function unavailableEvidenceBanner(labels) {
    if (!labels.length) return '';
    return `<div class="tb-evidence-unavailable" role="alert">
        <strong>Some Courthouse evidence is unavailable.</strong>
        <span>${escHtml(labels.join(', '))}. Ready data remains visible; use Retry check to reload these sources.</span>
    </div>`;
}

function calibrationEvidenceBanner(matrices = [], hostPanels = [], now = Date.now()) {
    if (!matrices.length) return '';
    const currentHosts = new Set(hostPanels.map(host => calibrationKey(host.hostUrl, '').split('@@')[0]));
    const stale = matrices.filter(matrix => {
        const calibratedAt = new Date(matrix.calibrated_at).getTime();
        return Number.isFinite(calibratedAt) && now - calibratedAt > 30 * 24 * 60 * 60 * 1000;
    });
    const retiredHosts = [...new Set(matrices
        .map(matrix => String(matrix.judge_host || '').trim().replace(/\/+$/, '').toLowerCase())
        .filter(host => host && !currentHosts.has(host)))];
    if (!stale.length && !retiredHosts.length) return '';

    const details = [];
    if (stale.length) {
        const latest = stale
            .map(matrix => new Date(matrix.calibrated_at))
            .filter(date => Number.isFinite(date.getTime()))
            .sort((left, right) => right - left)[0];
        details.push(`agreement evidence is older than 30 days${latest ? ` (latest stale check: ${latest.toLocaleDateString()})` : ''}`);
    }
    if (retiredHosts.length) details.push(`it references retired or unconfigured host${retiredHosts.length === 1 ? '' : 's'}: ${retiredHosts.join(', ')}`);
    return `<div class="tb-evidence-unavailable" role="note">
        <strong>Calibration evidence is historical.</strong>
        <span>${escHtml(details.join('; '))}. Re-run the agreement check on the current model+host target before relying on it.</span>
    </div>`;
}

function attachPromoteHandlers(root) {
    root.querySelectorAll('.tb-promote').forEach(btn => {
        btn.addEventListener('click', async () => {
            const hostUrl = btn.dataset.hostUrl;
            const judgeModel = btn.dataset.judge;
            btn.disabled = true;
            btn.textContent = 'setting…';
            try {
                await apiFetch('/api/benchmark/judge-defaults', {
                    method: 'PUT',
                    body: { hostUrl, judgeModel }
                });
                // Re-render the bench after the selected target changes.
                document.dispatchEvent(new CustomEvent('bench-refresh'));
            } catch (err) {
                console.error('[the-bench] judge target selection failed', err);
                btn.disabled = false;
                btn.textContent = 'set active';
                btn.classList.add('tb-promote-err');
                setTimeout(() => btn.classList.remove('tb-promote-err'), 1800);
            }
        });
    });
}

function attachReadinessHandlers(root, rerender) {
    root.querySelector('.tb-retry-readiness')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Checking…';
        await rerender();
    });
}

export async function renderBench(container, { dashboard } = {}) {
    if (!container) return;

    container.innerHTML = `<div class="tb-loading">Loading the bench…</div>`;

    const evidence = await settleEvidence({
        dashboard: () => dashboard === undefined
            ? apiFetch('/api/benchmark/dashboard')
            : dashboard,
        readiness: () => apiFetch('/api/benchmark/judge/readiness'),
        roster: () => apiFetch('/api/benchmark/judge-roster'),
        calibration: () => apiFetch('/api/benchmark/judge/calibration-status')
    });

    const rosterData = evidence.roster.ok ? evidence.roster.value?.data : null;
    const authoritativeReadiness = evidence.readiness.ok
        ? (evidence.readiness.value?.data || evidence.readiness.value)
        : (rosterData?.readiness || fallbackReadiness(rosterData?.hostPanels || []));
    const hostPanels = rosterData?.hostPanels || panelsFromReadiness(authoritativeReadiness);
    const readiness = withRecoverableJudgeSetup(authoritativeReadiness, {
        rosterAvailable: evidence.roster.ok,
        hostPanels
    });
    const calRes = evidence.calibration.ok ? evidence.calibration.value : null;
    const calMap = {};
    const matrices = calRes?.data?.matrices || [];
    for (const m of matrices) {
        calMap[calibrationKey(m.judge_host, m.judge_model)] = {
            pass_rate:           m.pass_rate,
            avg_deviation:       m.overall_avg_deviation,
            calibrated_at:       m.calibrated_at,
            ground_truth_count:  m.ground_truth_count,
        };
    }

    const columns = hostPanels.length
        ? hostPanels.map((host, index) => hostColumn(host, calMap, index)).join('')
        : `<div class="tb-hosts-unavailable">No configured judge hosts are available. Open setup to configure one, or retry readiness.</div>`;
    const dashboardData = evidence.dashboard.ok ? evidence.dashboard.value : null;
    const counts = deriveDashboardCounts(dashboardData);
    const readyHosts = readiness.ready_host_count || 0;
    const totalHosts = readiness.configured_host_count ?? hostPanels.length;
    const unavailable = [];
    if (!evidence.dashboard.ok) unavailable.push('dashboard counts');
    if (!evidence.roster.ok) unavailable.push('judge roster history');
    if (!evidence.calibration.ok) unavailable.push('calibration history');
    if (!evidence.readiness.ok && !rosterData?.readiness) unavailable.push('live judge readiness');

    container.innerHTML = `
        <div class="tb-frame">
            <div class="tb-head">
                <div class="tb-title">
                    <span class="tb-gavel">⚖</span>
                    <div>
                        <div class="tb-title-main">The Bench</div>
                        <div class="tb-title-sub">${readyHosts}/${totalHosts} hosts ready for judge scoring — readiness requires an explicit selection, a reachable host, and an installed model.</div>
                    </div>
                </div>
                <div class="tb-stat-strip">
                    ${statChip('Results',      countDisplay(counts.total),     'total',    '▣')}
                    ${statChip('Need Review',  countDisplay(counts.review),    'review',   '⚑')}
                    ${statChip('Approved',     countDisplay(counts.approved),  'approved', '✓')}
                    ${statChip('Overrides',    countDisplay(counts.overrides), 'override', '⇄')}
                    ${statChip('Ground Truth', countDisplay(counts.gt),        'gt',       '◎')}
                </div>
            </div>
            ${readinessBanner(readiness)}
            ${unavailableEvidenceBanner(unavailable)}
            ${calibrationEvidenceBanner(matrices, hostPanels)}
            <div class="tb-columns">${columns}</div>
            <div class="tb-quick-links">
                <a href="/leaderboard"       class="tb-link">Leaderboard →</a>
                <a href="/benchmark"         class="tb-link">Benchmark →</a>
                <a href="/results-explorer"  class="tb-link">Results Explorer →</a>
            </div>
        </div>`;

    attachPromoteHandlers(container);
    // A retry starts fresh for every source, including dashboard evidence that
    // may have been unavailable during the initial page bootstrap.
    attachReadinessHandlers(container, () => renderBench(container));
    document.dispatchEvent(new CustomEvent('judge-readiness-changed', { detail: readiness }));

    // Expose review count for the tab badge
    const badge = document.getElementById('ch-tab-review-badge');
    if (badge) badge.textContent = counts.review == null ? '—' : String(counts.review);

    return readiness;
}

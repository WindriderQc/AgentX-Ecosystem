// index.js — Courthouse v2 entry point.
//
// Layout (post-restructure):
//   [ The Bench ]           — host-grouped judge selector (top, always visible)
//   [ Tabs ]                — Review · Calibration · Tests · Ledger · Config
//     └ Review       → review-queue + detail-panel
//     └ Calibration  → calibration + gap-analysis + discrimination
//     └ Tests        → test-library
//     └ Ledger       → results-ledger
//     └ Config       → judging-config + data-management
//
// Deep-link support: `?result=<id>` and `?model=<name>` auto-switch to Review.

import { renderBench }            from './the-bench.js';
import { renderReviewQueue }      from './review-queue.js';
import { renderDetailPanel }      from './detail-panel.js';
import { renderTestLibrary }      from './test-library.js';
import { renderJudgingConfig }    from './judging-config.js';
import { renderCalibration }      from './calibration.js';
import { renderGapAnalysis }      from './gap-analysis.js';
import { renderDiscrimination }   from './discrimination.js';
import { renderResultsLedger }    from './results-ledger.js';
import { renderDataManagement }   from '../benchmark-v2/data-management.js';
import { escHtml }                from '../utils/format.js';
import { showSectionError }       from '../components/error-banner.js';

import {
    fetchDashboard,
    fetchConfig,
    fetchPrompts,
    fetchResult,
    fetchNeedsReview,
    fetchDiscrimination,
    fetchFastHostList,
} from './api.js';

function $(id) { return document.getElementById(id); }

function showLoading(el, label = 'Loading…') {
    if (!el) return;
    el.innerHTML = `<div style="padding:1rem;color:#444;font-size:0.75rem;text-align:center;">${label}</div>`;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function activateTab(name) {
    document.querySelectorAll('.ch-tab').forEach(btn => {
        const active = btn.dataset.tab === name;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.ch-tab-panel').forEach(panel => {
        const active = panel.dataset.panel === name;
        panel.classList.toggle('is-active', active);
        if (active) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
    });
    try {
        const url = new URL(window.location.href);
        if (name === 'review') url.searchParams.delete('tab');
        else url.searchParams.set('tab', name);
        window.history.replaceState({}, '', url);
    } catch (_) {}
}

function initTabs() {
    document.querySelectorAll('.ch-tab').forEach(btn => {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('tab');
    // Deep-link to a specific result/model implies Review tab.
    if (params.get('result') || params.get('model')) activateTab('review');
    else if (wanted) activateTab(wanted);
}

// ── Deep-link (result id) ─────────────────────────────────────────────────────

async function handleDeepLink(allResults, detailContainer) {
    const params = new URLSearchParams(window.location.search);
    const resultId = params.get('result');
    if (!resultId) return;

    let result = allResults.find(r => String(r._id) === resultId);
    if (!result) {
        try {
            const res = await fetchResult(resultId);
            result = res?.data || res || null;
        } catch (err) {
            console.warn('[courthouse-v2] deep-link fetchResult failed:', err);
            return;
        }
    }

    if (result) {
        const queueItem = document.querySelector(`.rq-item[data-id="${CSS.escape(resultId)}"]`);
        if (queueItem) {
            document.querySelectorAll('.rq-item').forEach(el => el.classList.remove('is-active'));
            queueItem.classList.add('is-active');
            queueItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        await renderDetailPanel(detailContainer, result, allResults);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // Container refs
    const benchEl          = $('the-bench');
    const reviewQueueEl    = $('review-queue');
    const detailEl         = $('detail-panel-container');
    const testLibraryEl    = $('test-library');
    const judgingCfgEl     = $('judging-config');
    const calibrationEl    = $('calibration');
    const gapAnalysisEl    = $('gap-analysis');
    const discriminationEl = $('discrimination');
    const ledgerEl         = $('results-ledger');
    const dataMgmtEl       = $('data-management');

    // Loading indicators
    showLoading(reviewQueueEl,    'Loading review queue…');
    showLoading(testLibraryEl,    'Loading test library…');
    showLoading(judgingCfgEl,     'Loading config…');
    showLoading(calibrationEl,    'Loading calibration…');
    showLoading(gapAnalysisEl,    'Loading gap analysis…');
    showLoading(discriminationEl, 'Loading discrimination data…');
    showLoading(ledgerEl,         'Loading results ledger…');

    // Tabs up front so deep-links can flip immediately
    initTabs();

    // ── Parallel primary fetch ───────────────────────────────────────────────
    let dashboard, config, prompts;
    try {
        [dashboard, config, prompts] = await Promise.all([
            fetchDashboard(),
            fetchConfig(),
            fetchPrompts(),
        ]);
    } catch (err) {
        console.error('[courthouse-v2] initial fetch error:', err);
    }

    // ── The Bench ────────────────────────────────────────────────────────────
    if (benchEl) {
        try {
            await renderBench(benchEl, { dashboard });
        } catch (err) {
            console.error('[courthouse-v2] renderBench error:', err);
        }
    }

    // Re-render the bench whenever a judge is promoted
    document.addEventListener('bench-refresh', async () => {
        try {
            const fresh = await fetchDashboard();
            await renderBench(benchEl, { dashboard: fresh });
        } catch (err) {
            console.warn('[courthouse-v2] bench refresh failed:', err);
        }
    });

    // ── Review queue (with review flags) ─────────────────────────────────────
    let reviewResults = [];
    try {
        const data = await fetchNeedsReview({ limit: 50 });
        const inner = data?.data || data;
        reviewResults = inner?.results ?? (Array.isArray(inner) ? inner : []);
    } catch (err) {
        console.error('[courthouse-v2] fetchNeedsReview error:', err);
    }

    const modelParam = new URLSearchParams(window.location.search).get('model');
    let displayResults = reviewResults;
    if (modelParam) displayResults = reviewResults.filter(r => r.model === modelParam);

    if (reviewQueueEl) {
        if (modelParam) {
            const banner = document.createElement('div');
            banner.className = 'ch-model-filter';
            banner.innerHTML = `Filtered to <strong>${escHtml(modelParam)}</strong> — <a href="/courthouse">show all</a>`;
            banner.style.cssText = 'font-size:0.8rem;color:var(--r-anomaly,#d29922);padding:6px 12px;margin-bottom:8px;background:rgba(210,153,34,0.08);border-radius:6px;border:1px solid rgba(210,153,34,0.2);';
            reviewQueueEl.appendChild(banner);
        }
        try {
            await renderReviewQueue(reviewQueueEl, displayResults, (result) => {
                if (detailEl) {
                    renderDetailPanel(detailEl, result, reviewResults).catch(err => {
                        console.error('[courthouse-v2] renderDetailPanel error:', err);
                    });
                }
            });
        } catch (err) {
            console.error('[courthouse-v2] renderReviewQueue error:', err);
            showSectionError(reviewQueueEl, 'Failed to load review queue.');
        }
    }

    // ── Test library (Tests tab) ─────────────────────────────────────────────
    if (testLibraryEl && prompts) {
        try {
            const promptList = Array.isArray(prompts)
                ? prompts
                : (prompts?.data?.prompts ?? prompts?.data ?? prompts?.prompts ?? []);
            renderTestLibrary(testLibraryEl, promptList);
        } catch (err) {
            console.error('[courthouse-v2] renderTestLibrary error:', err);
        }
    }

    // ── Judging config (Config tab) ──────────────────────────────────────────
    if (judgingCfgEl && config) {
        try { renderJudgingConfig(judgingCfgEl, config); }
        catch (err) { console.error('[courthouse-v2] renderJudgingConfig error:', err); }
    }

    // ── Calibration (Calibration tab) ────────────────────────────────────────
    if (calibrationEl) {
        try {
            const [calRes, hostsRes] = await Promise.all([
                fetch('/api/benchmark/judge/calibration-status').then(r => r.json()),
                fetchFastHostList().catch(() => [])
            ]);
            const matrices = calRes.data?.matrices || [];
            const hosts = Array.isArray(hostsRes) ? hostsRes : [];
            renderCalibration(calibrationEl, { matrices, hosts });
        } catch (err) {
            console.error('[courthouse-v2] calibration render error:', err);
        }
    }

    // ── Gap analysis (Calibration tab) ───────────────────────────────────────
    if (gapAnalysisEl) {
        try {
            const gapRes = await fetch('/api/benchmark/judge/ground-truth/gaps').then(r => r.json());
            if (gapRes.data) renderGapAnalysis(gapAnalysisEl, gapRes.data);
        } catch (err) {
            console.error('[courthouse-v2] gap analysis render error:', err);
        }
    }

    // ── Discrimination (Calibration tab) ─────────────────────────────────────
    if (discriminationEl) {
        try {
            const discRes = await fetchDiscrimination({ flagged_only: false });
            const discData = discRes?.data?.questions ?? discRes?.data ?? discRes ?? [];
            renderDiscrimination(discriminationEl, discData);
        } catch (err) {
            console.error('[courthouse-v2] discrimination error:', err);
            showSectionError(discriminationEl, 'Failed to load discrimination data.');
        }
    }

    // ── Results ledger (Ledger tab) ──────────────────────────────────────────
    if (ledgerEl) {
        try {
            await renderResultsLedger(ledgerEl, 1, (result) => {
                if (detailEl) {
                    activateTab('review');
                    renderDetailPanel(detailEl, result, []).catch(err => {
                        console.error('[courthouse-v2] renderDetailPanel (ledger) error:', err);
                    });
                }
            });
        } catch (err) {
            console.error('[courthouse-v2] renderResultsLedger error:', err);
            showSectionError(ledgerEl, 'Failed to load results ledger.');
        }
    }

    // ── Data management (Config tab) ─────────────────────────────────────────
    if (dataMgmtEl) {
        try { await renderDataManagement(dataMgmtEl); }
        catch (err) { console.error('[courthouse-v2] data management error:', err); }
    }

    // ── Deep-link resolution ─────────────────────────────────────────────────
    if (detailEl) {
        try { await handleDeepLink(reviewResults, detailEl); }
        catch (err) { console.warn('[courthouse-v2] deep-link error:', err); }
    }

    // ── Refresh hook fired by the detail panel after Approve/Override/etc. ──
    document.addEventListener('detail-action-complete', async () => {
        try {
            const fresh = await fetchDashboard();
            if (benchEl) await renderBench(benchEl, { dashboard: fresh });
        } catch (err) {
            console.warn('[courthouse-v2] bench refresh (post-review) failed:', err);
        }
        try {
            const data = await fetchNeedsReview({ limit: 50 });
            const inner = data?.data || data;
            const freshResults = inner?.results ?? (Array.isArray(inner) ? inner : []);
            if (reviewQueueEl) {
                await renderReviewQueue(reviewQueueEl, freshResults, (result) => {
                    if (detailEl) {
                        renderDetailPanel(detailEl, result, freshResults).catch(err => {
                            console.error('[courthouse-v2] renderDetailPanel error:', err);
                        });
                    }
                });
            }
        } catch (err) {
            console.warn('[courthouse-v2] review queue refresh error:', err);
        }
    });
});

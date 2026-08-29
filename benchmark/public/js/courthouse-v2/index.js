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
import { setJudgeReadiness }      from './readiness-state.js';
import { settleEvidence }         from './settled-evidence.js';

import {
    fetchConfig,
    fetchPrompts,
    fetchResult,
    fetchNeedsReview,
    fetchDiscrimination,
    fetchFastHostList,
    fetchCalibrationStatus,
    fetchGroundTruthGaps,
} from './api.js';

function $(id) { return document.getElementById(id); }

function showLoading(el, label = 'Loading…') {
    if (!el) return;
    el.innerHTML = `<div class="ch-muted-state">${escHtml(label)}</div>`;
}

function showRecoverableState(container, message, retry, {
    setupHref = null,
    setupLabel = 'Open setup'
} = {}) {
    if (!container) return;
    container.innerHTML = `<div class="r-section-error ch-recoverable" role="alert">
        <span>${escHtml(message)}</span>
        ${setupHref ? `<a href="${escHtml(setupHref)}" class="ch-recovery-link">${escHtml(setupLabel)}</a>` : ''}
        <button type="button" class="ch-retry-section">Retry</button>
    </div>`;
    container.querySelector('.ch-retry-section')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Retrying…';
        try {
            await retry();
        } catch (err) {
            console.warn('[courthouse-v2] section retry failed:', err);
            showRecoverableState(container, message, retry, { setupHref, setupLabel });
        }
    });
}

function prependPartialUnavailable(container, message, retry) {
    if (!container) return;
    const banner = document.createElement('div');
    banner.className = 'r-section-error ch-recoverable ch-partial-unavailable';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `<span>${escHtml(message)}</span>
        <button type="button" class="ch-retry-section">Retry</button>`;
    banner.querySelector('.ch-retry-section')?.addEventListener('click', retry);
    container.prepend(banner);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function activateTab(name, { focus = false } = {}) {
    const tabs = Array.from(document.querySelectorAll('.ch-tab'));
    const target = tabs.find(btn => btn.dataset.tab === name);
    if (!target) return false;

    tabs.forEach(btn => {
        const active = btn.dataset.tab === name;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        btn.tabIndex = active ? 0 : -1;
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
    if (focus) {
        target.focus();
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return true;
}

function initTabs() {
    const tabs = Array.from(document.querySelectorAll('.ch-tab'));
    tabs.forEach((btn, index) => {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
        btn.addEventListener('keydown', event => {
            let nextIndex = null;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            activateTab(tabs[nextIndex].dataset.tab, { focus: true });
        });
    });
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('tab');
    // Deep-link to a specific result/model implies Review tab.
    if (params.get('result') || params.get('model')) activateTab('review');
    else if (wanted) activateTab(wanted);
}

document.addEventListener('courthouse-activate-tab', event => {
    const name = event.detail?.name;
    if (name) activateTab(name);
});

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
            document.querySelectorAll('.rq-item').forEach(el => {
                el.classList.remove('is-active');
                el.setAttribute('aria-expanded', 'false');
            });
            queueItem.classList.add('is-active');
            queueItem.setAttribute('aria-expanded', 'true');
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

    // Config and prompt evidence settle independently. Judge readiness and its
    // Mongo-backed supporting evidence are loaded independently by The Bench.
    const primaryEvidencePromise = settleEvidence({
        config: fetchConfig,
        prompts: fetchPrompts
    });

    // ── The Bench ────────────────────────────────────────────────────────────
    async function loadBench() {
        if (!benchEl) return;
        try {
            setJudgeReadiness(await renderBench(benchEl));
        } catch (err) {
            console.error('[courthouse-v2] renderBench error:', err);
            showRecoverableState(
                benchEl,
                'Judge readiness could not be rendered. Open setup or retry the independent readiness check.',
                async () => setJudgeReadiness(await renderBench(benchEl)),
                { setupHref: '/setup?focus=judge', setupLabel: 'Judge setup' }
            );
        }
    }
    const benchTask = loadBench();

    // Re-render the bench whenever a judge is promoted
    document.addEventListener('bench-refresh', async () => {
        await loadBench();
    });

    // ── Review queue (with review flags) ─────────────────────────────────────
    const modelParam = new URLSearchParams(window.location.search).get('model');
    let reviewResults = [];

    async function loadReviewQueue() {
        if (!reviewQueueEl) return [];
        showLoading(reviewQueueEl, 'Loading review queue…');
        try {
            const data = await fetchNeedsReview({ limit: 50 });
            const inner = data?.data || data;
            reviewResults = inner?.results ?? (Array.isArray(inner) ? inner : []);
            const displayResults = modelParam
                ? reviewResults.filter(r => r.model === modelParam)
                : reviewResults;
            await renderReviewQueue(reviewQueueEl, displayResults, (result) => {
                if (detailEl) {
                    renderDetailPanel(detailEl, result, reviewResults).catch(err => {
                        console.error('[courthouse-v2] renderDetailPanel error:', err);
                    });
                }
            });
            if (modelParam) {
                const banner = document.createElement('div');
                banner.className = 'ch-model-filter';
                banner.innerHTML = `Filtered to <strong>${escHtml(modelParam)}</strong> — <a href="/courthouse">show all</a>`;
                reviewQueueEl.prepend(banner);
            }
            return reviewResults;
        } catch (err) {
            console.error('[courthouse-v2] review queue unavailable:', err);
            showRecoverableState(
                reviewQueueEl,
                'Review evidence is unavailable. No empty-queue conclusion was inferred.',
                loadReviewQueue
            );
            return [];
        }
    }

    // ── Test library (Tests tab) ─────────────────────────────────────────────
    async function loadTestLibrary(seed) {
        if (!testLibraryEl) return;
        try {
            showLoading(testLibraryEl, 'Loading test library…');
            const prompts = seed !== undefined ? seed : await fetchPrompts();
            const promptList = Array.isArray(prompts)
                ? prompts
                : (prompts?.data?.prompts ?? prompts?.data ?? prompts?.prompts ?? []);
            renderTestLibrary(testLibraryEl, promptList);
        } catch (err) {
            console.error('[courthouse-v2] test library unavailable:', err);
            showRecoverableState(
                testLibraryEl,
                'Test-library evidence is unavailable. Retry without leaving this page.',
                () => loadTestLibrary()
            );
        }
    }
    // ── Judging config (Config tab) ──────────────────────────────────────────
    async function loadJudgingConfig(seed) {
        if (!judgingCfgEl) return;
        try {
            showLoading(judgingCfgEl, 'Loading config…');
            const config = seed !== undefined ? seed : await fetchConfig();
            renderJudgingConfig(judgingCfgEl, config);
        } catch (err) {
            console.error('[courthouse-v2] judging config unavailable:', err);
            showRecoverableState(
                judgingCfgEl,
                'Judging configuration is unavailable. Retry without changing saved settings.',
                () => loadJudgingConfig()
            );
        }
    }
    async function loadPrimaryPanels() {
        const primaryEvidence = await primaryEvidencePromise;
        if (primaryEvidence.prompts.ok) await loadTestLibrary(primaryEvidence.prompts.value);
        else showRecoverableState(
            testLibraryEl,
            'Test-library evidence is unavailable. Retry without leaving this page.',
            () => loadTestLibrary()
        );

        if (primaryEvidence.config.ok) await loadJudgingConfig(primaryEvidence.config.value);
        else showRecoverableState(
            judgingCfgEl,
            'Judging configuration is unavailable. Retry without changing saved settings.',
            () => loadJudgingConfig()
        );
    }

    // ── Calibration (Calibration tab) ────────────────────────────────────────
    async function loadCalibration() {
        if (!calibrationEl) return;
        showLoading(calibrationEl, 'Loading calibration…');
        const evidence = await settleEvidence({
            matrices: fetchCalibrationStatus,
            hosts: fetchFastHostList
        });
        const calRes = evidence.matrices.ok ? evidence.matrices.value : null;
        const hostsRes = evidence.hosts.ok ? evidence.hosts.value : [];
        const matrices = calRes?.data?.matrices || [];
        const hosts = Array.isArray(hostsRes) ? hostsRes : [];
        try {
            renderCalibration(calibrationEl, { matrices, hosts });
            const unavailable = [];
            if (!evidence.matrices.ok) unavailable.push('calibration history');
            if (!evidence.hosts.ok) unavailable.push('configured host inventory');
            if (unavailable.length) {
                prependPartialUnavailable(
                    calibrationEl,
                    `${unavailable.join(' and ')} unavailable; no missing data was treated as empty evidence.`,
                    loadCalibration
                );
            }
        } catch (err) {
            console.error('[courthouse-v2] calibration render error:', err);
            showRecoverableState(
                calibrationEl,
                'Calibration evidence could not be rendered. Retry the independent evidence requests.',
                loadCalibration
            );
        }
    }
    // ── Gap analysis (Calibration tab) ───────────────────────────────────────
    async function loadGapAnalysis() {
        if (!gapAnalysisEl) return;
        showLoading(gapAnalysisEl, 'Loading gap analysis…');
        try {
            const gapRes = await fetchGroundTruthGaps();
            if (!gapRes?.data) throw new Error('Gap evidence missing');
            renderGapAnalysis(gapAnalysisEl, gapRes.data);
        } catch (err) {
            console.error('[courthouse-v2] gap analysis render error:', err);
            showRecoverableState(
                gapAnalysisEl,
                'Ground-truth gap evidence is unavailable. Retry without inferring zero gaps.',
                loadGapAnalysis
            );
        }
    }
    // ── Discrimination (Calibration tab) ─────────────────────────────────────
    async function loadDiscrimination() {
        if (!discriminationEl) return;
        showLoading(discriminationEl, 'Loading discrimination data…');
        try {
            const discRes = await fetchDiscrimination({ flagged_only: false });
            const discData = discRes?.data?.questions ?? discRes?.data ?? discRes ?? [];
            renderDiscrimination(discriminationEl, discData);
        } catch (err) {
            console.error('[courthouse-v2] discrimination error:', err);
            showRecoverableState(
                discriminationEl,
                'Question-discrimination evidence is unavailable. Retry without inferring an empty set.',
                loadDiscrimination
            );
        }
    }
    // ── Results ledger (Ledger tab) ──────────────────────────────────────────
    async function loadLedger() {
        if (!ledgerEl) return;
        showLoading(ledgerEl, 'Loading results ledger…');
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
            showRecoverableState(
                ledgerEl,
                'Results-ledger evidence is unavailable. Retry without inferring an empty ledger.',
                loadLedger
            );
        }
    }
    // ── Data management (Config tab) ─────────────────────────────────────────
    async function loadDataManagement() {
        if (!dataMgmtEl) return;
        showLoading(dataMgmtEl, 'Loading data management…');
        try {
            await renderDataManagement(dataMgmtEl);
        } catch (err) {
            console.error('[courthouse-v2] data management error:', err);
            showRecoverableState(
                dataMgmtEl,
                'Data-management evidence is unavailable. No retention action was run.',
                loadDataManagement
            );
        }
    }
    // ── Refresh hook fired by the detail panel after Approve/Override/etc. ──
    document.addEventListener('detail-action-complete', async () => {
        await Promise.allSettled([loadBench(), loadReviewQueue()]);
    });

    // All panels start together. In an outage, independent 10-second API
    // timeouts overlap instead of serializing into a minute-long bootstrap.
    const reviewTask = loadReviewQueue();
    const deepLinkTask = reviewTask.then(async () => {
        if (!detailEl) return;
        try { await handleDeepLink(reviewResults, detailEl); }
        catch (err) { console.warn('[courthouse-v2] deep-link error:', err); }
    });
    await Promise.allSettled([
        benchTask,
        reviewTask,
        loadPrimaryPanels(),
        loadCalibration(),
        loadGapAnalysis(),
        loadDiscrimination(),
        loadLedger(),
        loadDataManagement(),
        deepLinkTask
    ]);
});

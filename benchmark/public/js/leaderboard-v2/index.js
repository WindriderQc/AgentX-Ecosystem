// index.js — Leaderboard v2 entry point
// Wires all sections together: hero, podium, generalist board, quality board,
// category map, performance board.

import {
    fetchDashboard,
    fetchGeneralistLeaderboard,
    fetchGroundTruthGaps,
    fetchResults,
    fetchHosts
} from './api.js';

import { renderHero }             from './hero.js';
import { renderPodium }           from './podium.js';
import { renderCombinedBoard }    from './combined-board.js';
import { renderCategoryMap }       from './category-map.js';
import { renderScoringSystem }     from './scoring-system.js';
import { initSectionCollapse }    from '../components/section-collapse.js';
import { showFatalError, showSectionError } from '../components/error-banner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert generalist leaderboard entry to the shape expected by the boards. */
function toGeneralistBoardEntry(entry, scoreAxis = 'composite') {
    // generalistScore is 0-100 scale; board expects 0-10
    const score = entry.generalistScore != null ? entry.generalistScore / 10 : 0;
    const categoryScores = buildCategoryScores(entry.categoryAverages || {});
    return {
        model:           entry.model,
        host:            entry.host || null,
        score,
        qualityScore:    score,        // best proxy available at this stage
        performanceCoeff: null,        // enriched later by performance pass
        testCount:       entry.totalTests || 0,
        promptLevelCounts: entry.promptLevelCounts || {},
        minPromptLevel:  entry.minPromptLevel ?? null,
        maxPromptLevel:  entry.maxPromptLevel ?? null,
        contextCounts:   entry.contextCounts || {},
        judgeTargets:    entry.judgeTargets || [],
        difficultyPenalty: entry.difficultyPenalty ?? 0,
        difficultyCoverage: entry.difficultyCoverage ?? null,
        host_available: entry.host_available !== false,
        fullScopeMinLevel: entry.fullScopeMinLevel ?? null,
        requiredPromptLevels: entry.requiredPromptLevels || [],
        missingRequiredLevelsByCategory: entry.missingRequiredLevelsByCategory || {},
        fullScopeEligible: entry.fullScopeEligible === true,
        evidenceStatus: entry.evidenceStatus || null,
        evidenceConfidence: entry.evidenceConfidence ?? null,
        evidenceConfidenceCoverage: entry.evidenceConfidenceCoverage ?? null,
        evidenceConfidenceTarget: entry.evidenceConfidenceTarget ?? null,
        evidenceConfidencePenalty: entry.evidenceConfidencePenalty ?? 0,
        minConsistencyResults: entry.minConsistencyResults ?? 0,
        needsReviewCount: entry.needsReviewCount || 0,
        lowConfidenceCount: entry.lowConfidenceCount || 0,
        categoryScores,
        categoryEvidence: entry.categoryEvidence || {},
        dimensions: buildCategoryDimensions(categoryScores),
        scoreAxis,
        // API margins are on the normalized 0-100 axis; every visible score on
        // this board is 0-10, so the detailed row must use the same conversion
        // as the podium.
        confidence:      entry.confidenceMargin != null ? Number(entry.confidenceMargin) / 10 : null,
        confidenceMethod: entry.confidenceMethod || null,
        confidenceSampleSize: entry.confidenceSampleSize || 0,
        confidenceRepeatCount: entry.confidenceRepeatCount || 0,
        evidenceCompatibility: entry.evidenceCompatibility || 'exploratory',
        evidenceCohortId: entry.evidenceCohortId || null,
        reviewCount:     entry.needsReviewCount || 0,
        trend:           null,
        filtered:        entry.filtered || false
    };
}

/** Convert categoryAverages (0-100) to categoryScores (0-10) for category-map */
function buildCategoryScores(categoryAverages) {
    if (!categoryAverages || typeof categoryAverages !== 'object') return {};
    const scores = {};
    for (const [cat, val] of Object.entries(categoryAverages)) {
        scores[cat] = val != null ? Number(val) / 10 : null;
    }
    return scores;
}

/** Use the exact filtered leaderboard cohort for category bars and map cells. */
function buildCategoryDimensions(categoryScores) {
    return Object.entries(categoryScores || {})
        .filter(([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value)))
        .map(([name, value]) => ({
            name,
            yesRate: Math.min(1, Math.max(0, Number(value) / 10))
        }));
}

/** Render the initial loading skeleton in <main> */
function showLoadingState(main) {
    main.innerHTML = `<div class="r-loading" style="padding:3rem;text-align:center;color:var(--r-text-dim,#888);">
        <div style="font-size:1.5rem;margin-bottom:0.5rem;">⏳</div>
        <div>Loading leaderboard data…</div>
    </div>`;
}

/** Replace <main> contents with a fatal error state + retry button */
function showErrorState(main, err) {
    main.innerHTML = `<button class="r-nav-btn r-primary" id="retry-btn" style="display:block;margin:1rem auto;">Retry</button>`;
    showFatalError(`Failed to load leaderboard: ${err.message}`, main);
    const retryBtn = main.querySelector('#retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => init());
}

function hideInactiveSurface(element) {
    if (!element) return;
    element.hidden = true;
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
}

/** Short host label from a URL (strip scheme + :11434) — fallback display name. */
function shortHostName(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

/**
 * Build the Hosts selector — one coherent control that replaces BOTH the old
 * host/current/all scope buttons AND the hero's click-to-filter
 * pills. Every host option is data-driven from the configured-host list, so
 * there are no hard-coded host names. Reads left→right as:
 *   [ All hosts ]  ● host gpu  ● host gpu  …  ┊  [ All history ]
 */
function hostSelectOptionsHtml(hosts) {
    const chips = (Array.isArray(hosts) ? hosts : []).map(h => {
        const url = h.url || h.host || '';
        if (!url) return '';
        const name = h.name || h.id || shortHostName(url);
        const online = h.available !== false;
        return `<button type="button" class="r-host-opt" data-host-url="${url}" title="Show only results from ${name}">
            <span class="r-host-opt-dot ${online ? 'on' : 'off'}"></span>
            <span class="r-host-opt-name">${name}</span>
        </button>`;
    }).join('');
    return `<button type="button" class="r-host-opt r-host-all" data-host-scope="current" title="Every host in the current configured fleet">All hosts</button>
        ${chips}
        <span class="r-fb-div" aria-hidden="true"></span>
        <button type="button" class="r-host-opt r-host-arch" data-host-scope="all" title="Every host ever benchmarked, including retired hardware">
            <i class="fas fa-clock-rotate-left" aria-hidden="true"></i> All history
        </button>`;
}

/** Restore the section containers after a successful initial fetch */
function restoreShell(main, hosts = []) {
    main.innerHTML = `
        <section id="hero"></section>
        <section id="filter-bar" class="r-filterbar" aria-label="Leaderboard filters">
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-arrow-down-wide-short" aria-hidden="true"></i> Rank by</span>
                <div class="r-seg">
                    <button type="button" class="r-seg-btn" data-axis="composite" title="Blended deterministic + judge score">Composite</button>
                    <button type="button" class="r-seg-btn" data-axis="deterministic" title="Rule-based deterministic scoring only">Deterministic</button>
                    <button type="button" class="r-seg-btn" data-axis="subjective" title="Judge-model scoring only">Judge</button>
                </div>
            </div>
            <div class="r-fgroup r-fgroup-hosts">
                <span class="r-fgroup-label"><i class="fas fa-server" aria-hidden="true"></i> Hosts</span>
                <div class="r-host-select">${hostSelectOptionsHtml(hosts)}</div>
            </div>
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-gauge-high" aria-hidden="true"></i> Difficulty</span>
                <div class="r-seg">
                    <button type="button" class="r-seg-btn" data-challenge-scope="foundation" title="Only L1-L3 foundation prompts">Foundation</button>
                    <button type="button" class="r-seg-btn" data-challenge-scope="advanced" title="Only L4-L5 hard prompts">Hard L4-L5</button>
                    <button type="button" class="r-seg-btn" data-challenge-scope="all" title="All prompt levels, with a hard-level coverage penalty">All levels</button>
                </div>
            </div>
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-shield-halved" aria-hidden="true"></i> Trust</span>
                <div class="r-fgroup-row">
                    <div class="r-seg">
                        <button type="button" class="r-seg-btn" data-trust-scope="exploratory">Exploratory</button>
                        <button type="button" class="r-seg-btn" data-trust-scope="trusted">Trusted</button>
                    </div>
                    <span id="trust-badge" class="r-trust-badge trusted">Trusted view</span>
                </div>
            </div>
            <div class="r-fgroup">
                <span class="r-fgroup-label"><i class="fas fa-box-archive" aria-hidden="true"></i> Archive</span>
                <label class="r-archive-toggle" title="Show registered benchmark rows for models no longer present on their Ollama host">
                    <input type="checkbox" id="include-unavailable-models">
                    <span>Show deleted</span>
                </label>
            </div>
            <p class="r-view-summary" id="view-summary" aria-live="polite"></p>
        </section>
        <section id="podium"></section>
        <div id="scoring-system" class="r-section"></div>
        <div id="leaderboard" class="r-section"></div>
        <div id="category-map" class="r-section"></div>`;
}

/**
 * When the Trusted view is selected but the board is empty or thin, the table
 * alone reads as "broken". Render an explanatory banner above the leaderboard
 * that explains the actual confidence weighting and links to the Courthouse
 * evidence view. UI/guidance only — does not change what data is shown.
 *
 * @param {HTMLElement} leaderboardEl - the #leaderboard section
 * @param {object} opts - { trusted:boolean, visibleCount:number, excluded:number }
 */
function renderTrustBanner(leaderboardEl, { trusted, visibleCount, trustedFilters } = {}) {
    if (!leaderboardEl) return;
    // Remove any banner from a previous render so toggling is clean.
    const prior = document.getElementById('trust-onboard-banner');
    if (prior) prior.remove();

    const THIN = 2; // a Trusted board with ≤2 models is effectively empty/thin
    if (!trusted || visibleCount > THIN) return;

    const cohort = trustedFilters?.cohort || {};
    const selected = cohort.selected || null;
    const excluded = Number(cohort.excludedBatchCount || 0);
    const lead = visibleCount === 0
        ? 'No compatible evidence cohort is available for <strong>Trusted</strong> ranking.'
        : `The <strong>Trusted</strong> view is showing ${visibleCount} model${visibleCount === 1 ? '' : 's'} from one compatible evidence cohort.`;
    const excludedNote = excluded > 0
        ? ` ${excluded} legacy, stale, or incompatible batch${excluded === 1 ? ' was' : 'es were'} excluded.`
        : '';

    const banner = document.createElement('div');
    banner.id = 'trust-onboard-banner';
    banner.className = 'r-trust-banner';
    banner.style.cssText = 'display:flex;gap:0.75rem;align-items:flex-start;background:rgba(255,183,77,0.06);border:1px solid rgba(255,183,77,0.4);border-radius:10px;padding:0.85rem 1rem;margin-bottom:0.75rem;';
    banner.innerHTML = `
        <div style="font-size:1.3rem;line-height:1;">🎯</div>
        <div style="flex:1;min-width:0;">
            <div style="font-weight:700;color:var(--r-text,#eee);font-size:0.92rem;margin-bottom:0.25rem;">${lead}</div>
            <p style="color:#bbb;font-size:0.82rem;line-height:1.45;margin:0 0 0.55rem;">Trusted compares only one recent completed campaign with an exact fixture digest, scorer identity, and per-candidate artifact/runtime fingerprints.${excludedNote} ${selected ? 'Judge confidence is known for every ranked row.' : 'Run a new exact-identity comparison to populate this view.'} Switch to <strong>Exploratory</strong> to inspect historical evidence without treating it as comparable.</p>
            <a class="r-nav-btn r-primary" href="/" style="text-decoration:none;display:inline-block;">Run compatible evidence →</a>
        </div>`;
    leaderboardEl.parentNode?.insertBefore(banner, leaderboardEl);
}

function renderHardCoverageBanner(main, coverageResponse) {
    if (!main || _challengeScope !== 'advanced' || _currentAxis === 'deterministic') return;
    const filterBar = main.querySelector('#filter-bar');
    if (!filterBar) return;
    const coverage = coverageResponse?.data || coverageResponse || null;
    const hard = coverage?.hard_scope || null;
    if (hard?.ready === true) return;

    const banner = document.createElement('div');
    banner.id = 'hard-coverage-banner';
    banner.className = 'r-trust-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'background:rgba(239,83,80,0.07);border:1px solid rgba(239,83,80,0.45);border-radius:10px;padding:0.8rem 1rem;margin:0.75rem 0;';
    const evidence = hard
        ? `${hard.cells_meeting_target || 0}/${hard.total_cells || 14} category/level cells meet the ${hard.target_per_cell || 5}-entry human target.`
        : 'Current L4–L5 human coverage could not be verified.';
    banner.innerHTML = `<strong>Hard L4–L5 judge evidence is exploratory.</strong> ${evidence} The ranking remains visible, but its judge-scored component is not human-calibrated for this scope. <a href="/courthouse?tab=calibration">Inspect coverage →</a>`;
    filterBar.insertAdjacentElement('afterend', banner);
}

// Module-level state — survives re-init() calls so chip clicks pick the right axis
let _currentAxis = 'composite';
// Host filtering is now a single coherent control. _hostScope is the configured
// fleet ('current') or the full archive ('all'); _selectedHost narrows to one
// host URL and always implies 'current' scope. Default to the full archive so
// the board is never empty just because the current primary host has no
// benchmark coverage yet.
let _hostScope = 'all';
let _selectedHost = null;
let _challengeScope = 'advanced';
let _trustScope = 'trusted';
let _includeUnavailableModels = false;

try {
    _includeUnavailableModels = localStorage.getItem('leaderboardIncludeUnavailableModels') === 'true';
    _trustScope = localStorage.getItem('leaderboardTrustScope') === 'exploratory' ? 'exploratory' : 'trusted';
    const savedHostScope = localStorage.getItem('leaderboardHostScope');
    if (savedHostScope === 'current' || savedHostScope === 'all') _hostScope = savedHostScope;
    const savedHost = localStorage.getItem('leaderboardSelectedHost');
    if (savedHost) { _selectedHost = savedHost; _hostScope = 'current'; }
} catch (_) {}

function wireAxisChip(main, leaderboardMeta = {}) {
    const bar = main.querySelector('#filter-bar');
    if (!bar) return;

    // Rank-by (score axis)
    bar.querySelectorAll('[data-axis]').forEach(btn => {
        if (btn.dataset.axis === _currentAxis) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (btn.dataset.axis === _currentAxis) return;
            _currentAxis = btn.dataset.axis;
            init();
        });
    });

    // Hosts — one selector: All hosts / a single host / All history.
    const applyHostChoice = (scope, host) => {
        _hostScope = scope;
        _selectedHost = host;
        try {
            localStorage.setItem('leaderboardHostScope', scope);
            if (host) localStorage.setItem('leaderboardSelectedHost', host);
            else localStorage.removeItem('leaderboardSelectedHost');
        } catch (_) {}
        init();
    };
    bar.querySelectorAll('.r-host-opt').forEach(btn => {
        const url = btn.dataset.hostUrl || null;
        const scopeAttr = btn.dataset.hostScope || null; // 'current' (All hosts) | 'all' (All history)
        const isActive = scopeAttr === 'all'
            ? _hostScope === 'all'
            : scopeAttr === 'current'
                ? (_hostScope === 'current' && !_selectedHost)
                : (_hostScope === 'current' && _selectedHost === url);
        if (isActive) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (scopeAttr === 'all') applyHostChoice('all', null);
            else if (scopeAttr === 'current') applyHostChoice('current', null);
            else if (url) applyHostChoice('current', _selectedHost === url ? null : url); // click again to clear
        });
    });

    // Difficulty (challenge cohort)
    bar.querySelectorAll('[data-challenge-scope]').forEach(btn => {
        const scope = btn.dataset.challengeScope;
        if (scope === _challengeScope) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (scope === _challengeScope) return;
            _challengeScope = ['all', 'foundation'].includes(scope) ? scope : 'advanced';
            init();
        });
    });

    // Trust view
    bar.querySelectorAll('[data-trust-scope]').forEach(btn => {
        const scope = btn.dataset.trustScope;
        if (scope === _trustScope) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
            if (scope === _trustScope) return;
            _trustScope = scope === 'trusted' ? 'trusted' : 'exploratory';
            try {
                localStorage.setItem('leaderboardTrustScope', _trustScope);
            } catch (_) {}
            init();
        });
    });

    const badge = bar.querySelector('#trust-badge');
    if (badge) {
        const trusted = _trustScope === 'trusted';
        const excluded = Number(leaderboardMeta?.trustedFilters?.excludedIncompleteBatches || 0);
        badge.textContent = trusted ? 'Trusted view' : 'Exploratory view';
        badge.className = `r-trust-badge ${trusted ? 'trusted' : 'exploratory'}`;
        badge.title = trusted
            ? `Exact compatible evidence cohort; ${excluded} failed incomplete batch${excluded === 1 ? '' : 'es'} excluded.`
            : 'Historical leaderboard without trusted-view filtering.';
    }

    const unavailableToggle = bar.querySelector('#include-unavailable-models');
    if (unavailableToggle) {
        unavailableToggle.checked = _includeUnavailableModels;
        unavailableToggle.addEventListener('change', () => {
            _includeUnavailableModels = unavailableToggle.checked;
            try {
                localStorage.setItem('leaderboardIncludeUnavailableModels', String(_includeUnavailableModels));
            } catch (_) {}
            init();
        });
    }

    // Plain-language summary of the active view — turns the control states into
    // one readable sentence so users always know what the board is showing.
    const summaryEl = bar.querySelector('#view-summary');
    if (summaryEl) {
        const axisLabel = { composite: 'Composite', deterministic: 'Deterministic', subjective: 'Judge' }[_currentAxis] || 'Composite';
        const hostLabel = _hostScope === 'all'
            ? 'all hosts ever benchmarked'
            : _selectedHost
                ? (bar.querySelector('.r-host-opt.is-active .r-host-opt-name')?.textContent?.trim() || 'one host')
                : 'every configured host';
        const diffLabel = _challengeScope === 'foundation'
            ? 'foundation prompts (L1–L3)'
            : _challengeScope === 'all'
                ? 'all difficulty levels'
                : 'hard prompts (L4–L5)';
        const trustLabel = _trustScope === 'trusted' ? 'Trusted' : 'Exploratory';
        const archiveNote = _includeUnavailableModels
            ? ' <span class="r-vs-dot">·</span> including deleted models'
            : '';
        summaryEl.innerHTML = `<i class="fas fa-eye" aria-hidden="true"></i> <span class="r-vs-text">Showing the <b>${axisLabel}</b> ranking across <b>${hostLabel}</b>, scored on <b>${diffLabel}</b>, in <b>${trustLabel}</b> trust mode${archiveNote}.</span>`;
    }
}

// ---------------------------------------------------------------------------
// Data enrichment — performance board
// ---------------------------------------------------------------------------

/**
 * For each ranking entry, fetch a sample of results to compute:
 *   tokPerSec   — average tokens/sec
 *   successRate — % successful results (0-100)
 *   avgLatency  — mean latency in ms
 *   p95Latency  — 95th-percentile latency in ms
 *   ttft        — benchmark time-to-first-token (ms); null if unavailable
 *   hostTtft    — warmed host baseline TTFT (ms); null if unavailable
 *   perfCoeff   — composite perf coefficient (tokPerSec normalised, 0-1 cap 1)
 *
 * Mutates entries in place; returns enriched array.
 */
async function enrichWithPerfData(rankings) {
    const FETCH_LIMIT = 200;

    const fetches = rankings.map(entry =>
        fetchResults({ models: entry.model, host: entry.host || undefined, limit: FETCH_LIMIT, success: 'true' })
    );

    const results = await Promise.allSettled(fetches);

    results.forEach((result, i) => {
        const entry = rankings[i];
        if (result.status === 'rejected') {
            console.warn(`[perf] fetch failed for ${entry.model}:`, result.reason?.message);
            return;
        }

        const rows = result.value?.data?.results || [];
        if (rows.length === 0) return;

        const latestBaseline = rows.find(r => r?.performance_baseline?.timeToFirstTokenMs != null)?.performance_baseline || null;
        entry.hostTtft = latestBaseline?.timeToFirstTokenMs ?? null;

        // Derive most frequently used judge model for this entry
        const judgeFreq = {};
        for (const r of rows) {
            if (r.judge_model) judgeFreq[r.judge_model] = (judgeFreq[r.judge_model] || 0) + 1;
        }
        const topJudge = Object.entries(judgeFreq).sort((a, b) => b[1] - a[1])[0];
        if (topJudge) entry.judgeModel = topJudge[0];

        // Filter to successful rows with latency data
        const valid = rows.filter(r => r.success && r.latency != null && r.latency > 0);
        if (valid.length === 0) return;

        // successRate
        const totalRows = rows.length;
        const successRows = rows.filter(r => r.success).length;
        entry.successRate = Math.round((successRows / totalRows) * 100);

        // latency stats (latency field is in ms)
        const latencies = valid.map(r => r.latency).sort((a, b) => a - b);
        const sum = latencies.reduce((s, v) => s + v, 0);
        entry.avgLatency = Math.round(sum / latencies.length);
        const p95Idx = Math.floor(latencies.length * 0.95);
        entry.p95Latency = latencies[Math.min(p95Idx, latencies.length - 1)];

        // tokens/sec
        const tpsRows = valid.filter(r => r.tokens_per_sec != null);
        if (tpsRows.length > 0) {
            const tpsSum = tpsRows.reduce((s, r) => s + parseFloat(r.tokens_per_sec || 0), 0);
            entry.tokPerSec = parseFloat((tpsSum / tpsRows.length).toFixed(1));
        }

        // Benchmark TTFT comes from actual prompt runs, not the host baseline.
        const ttftRows = valid.filter(r => r.time_to_first_token_ms != null && r.time_to_first_token_ms > 0);
        if (ttftRows.length > 0) {
            const ttftSum = ttftRows.reduce((s, r) => s + Number(r.time_to_first_token_ms || 0), 0);
            entry.benchmarkTtft = Number((ttftSum / ttftRows.length).toFixed(1));
            entry.ttft = entry.benchmarkTtft;
        } else {
            entry.benchmarkTtft = null;
            entry.ttft = null;
        }

        // perfCoeff: normalised tok/s (40 tok/s = 1.0) * success factor
        if (entry.tokPerSec != null) {
            const tokNorm = Math.min(1, entry.tokPerSec / 40);
            const succFactor = entry.successRate != null ? entry.successRate / 100 : 1;
            entry.perfCoeff = parseFloat((tokNorm * succFactor).toFixed(3));
            // Back-fill performanceCoeff on generalist-board entries
            entry.performanceCoeff = entry.perfCoeff;
        }
    });

    return rankings;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function buildCsvFromRankings(rankings) {
    const CATS = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
    const headers = [
        'rank', 'model', 'host', 'score', 'qualityScore', 'performanceCoeff',
        'testCount', 'confidence', 'needsReviewCount', 'lowConfidenceCount', 'successRate', 'tokPerSec', 'avgLatency', 'p95Latency', 'benchmarkTtft', 'hostTtft',
        ...CATS
    ];

    const escape = v => {
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
            ? `"${s.replace(/"/g, '""')}"`
            : s;
    };

    const rows = rankings
        .filter(e => !e.filtered)
        .map((e, i) => [
            i + 1,
            e.model || '',
            e.host || '',
            e.score != null       ? e.score.toFixed(3)       : '',
            e.qualityScore != null ? e.qualityScore.toFixed(3) : '',
            e.performanceCoeff != null ? e.performanceCoeff.toFixed(3) : '',
            e.testCount  ?? '',
            e.confidence != null  ? e.confidence.toFixed(3)  : '',
            e.needsReviewCount ?? e.reviewCount ?? '',
            e.lowConfidenceCount ?? '',
            e.successRate != null ? e.successRate             : '',
            e.tokPerSec  != null  ? e.tokPerSec               : '',
            e.avgLatency != null  ? e.avgLatency              : '',
            e.p95Latency != null  ? e.p95Latency              : '',
            e.benchmarkTtft != null ? e.benchmarkTtft         : '',
            e.hostTtft != null ? e.hostTtft                   : '',
            ...CATS.map(c => e.categoryScores?.[c] != null ? e.categoryScores[c].toFixed(2) : '')
        ].map(escape).join(','));

    return [headers.join(','), ...rows].join('\n');
}

function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

async function init() {
    const main = document.querySelector('main');
    if (!main) return;

    showLoadingState(main);

    // --- Step 1: critical parallel fetch ---
    let dashboardRes, generalistRes, hostsRes, coverageRes;
    try {
        [dashboardRes, generalistRes, hostsRes, coverageRes] = await Promise.all([
            fetchDashboard(_includeUnavailableModels),
            fetchGeneralistLeaderboard(_currentAxis, _hostScope, _challengeScope, _includeUnavailableModels, _trustScope),
            fetchHosts().catch(() => ({ hosts: [] })),
            fetchGroundTruthGaps().catch(() => null)
        ]);
    } catch (err) {
        console.error('[leaderboard] initial fetch failed:', err);
        showErrorState(main, err);
        return;
    }

    // Build host list + URL→friendly-name map; the list also feeds the Hosts selector.
    const hostsList = hostsRes?.hosts || hostsRes || [];
    const hostNameMap = {};
    if (Array.isArray(hostsList)) {
        for (const h of hostsList) {
            const url = h.url || h.host || '';
            const name = h.name || h.hostname || '';
            if (url && name) hostNameMap[url] = name;
        }
    }

    // Drop a stale single-host selection if that host is no longer configured,
    // so we never show an unexplained empty board from a removed host.
    if (_selectedHost && Array.isArray(hostsList)
        && !hostsList.some(h => (h.url || h.host) === _selectedHost)) {
        _selectedHost = null;
        try { localStorage.removeItem('leaderboardSelectedHost'); } catch (_) {}
    }

    // Restore section containers (the Hosts selector renders from hostsList)
    restoreShell(main, Array.isArray(hostsList) ? hostsList : []);
    wireAxisChip(main, generalistRes?.data || {});
    renderHardCoverageBanner(main, coverageRes);

    // Extract leaderboard array; when a single host is selected, narrow to it
    // (the server returns the whole configured fleet under 'current' scope).
    let rawRankings = generalistRes?.data?.leaderboard || [];
    if (_selectedHost) {
        rawRankings = rawRankings.filter(e => (e.host || '') === _selectedHost);
    }

    // Build working copy enriched for generalist-board / category-map
    const rankings = rawRankings.map(entry => toGeneralistBoardEntry(entry, _currentAxis));

    // Resolve host IPs to friendly names
    for (const entry of rankings) {
        if (entry.host && hostNameMap[entry.host]) {
            entry.hostName = hostNameMap[entry.host];
        }
    }
    for (const entry of rawRankings) {
        if (entry.host && hostNameMap[entry.host]) {
            entry.hostName = hostNameMap[entry.host];
        }
    }

    // --- Step 2: hero (async, handles its own host fetch internally) ---
    const heroEl = main.querySelector('#hero');
    if (heroEl) {
        try {
            await renderHero(heroEl, dashboardRes, {
                hostScope: _hostScope,
                challengeScope: _challengeScope,
                trustScope: _trustScope,
                challengeLevelRange: generalistRes?.data?.challengeLevelRange || null,
                rankings: rawRankings,
                hostsRes
            });
        } catch (err) {
            console.warn('[hero] render failed:', err);
            showSectionError(heroEl, 'Could not render hero section.');
        }
    }

    const historicalCount = Number(dashboardRes?.data?.overview?.total_tests || 0);
    const hasHistoricalEvidence = historicalCount > 0
        || (Array.isArray(dashboardRes?.data?.model_stats) && dashboardRes.data.model_stats.length > 0);
    if (!hasHistoricalEvidence) {
        const filterBar = main.querySelector('#filter-bar');
        hideInactiveSurface(filterBar);
        const podiumEl = main.querySelector('#podium');
        if (podiumEl) {
            podiumEl.innerHTML = `
                <section class="results-empty-experience" role="status">
                    <span class="results-empty-icon" aria-hidden="true"><i class="fas fa-trophy"></i></span>
                    <h1>No ranked models yet</h1>
                    <p>Run one focused comparison to create the first evidence-backed ranking.</p>
                    <div class="results-empty-actions">
                        <a href="/"><i class="fas fa-play" aria-hidden="true"></i> Run a comparison</a>
                        <a href="/profiler"><i class="fas fa-microchip" aria-hidden="true"></i> Prepare a host</a>
                    </div>
                </section>`;
        }
        ['scoring-system', 'leaderboard', 'category-map'].forEach(id => {
            const section = main.querySelector('#' + id);
            hideInactiveSurface(section);
        });
        return;
    }

    // --- Step 3: podium (enrich top-3 with perf data, pass category weights) ---
    const podiumEl = main.querySelector('#podium');
    const categoryWeights = generalistRes?.data?.categoryWeights || null;
    if (podiumEl) {
        try {
            // Render podium immediately with score data (perf loads async below)
            renderPodium(podiumEl, rawRankings, { categoryWeights });

            // Enrich top-3 with performance metrics, then re-render
            const top3 = rawRankings.filter(r => !r.filtered).slice(0, 3);
            if (top3.length > 0) {
                enrichWithPerfData(top3).then(() => {
                    renderPodium(podiumEl, rawRankings, { categoryWeights });
                }).catch(err => {
                    console.warn('[podium] perf enrichment failed:', err);
                });
            }
        } catch (err) {
            console.warn('[podium] render failed:', err);
            showSectionError(podiumEl, 'Could not render podium.');
        }
    }

    // --- Step 3b: scoring system (How Scoring Works + Shared Weights + Customize) ---
    const scoringEl = main.querySelector('#scoring-system');
    if (scoringEl) {
        try {
            renderScoringSystem(scoringEl, { categoryWeights });
        } catch (err) {
            console.warn('[scoring-system] render failed:', err);
        }
    }

    // --- Step 4: combined Model Leaderboard (merged quality ranking + model stats) ---
    const leaderboardEl = main.querySelector('#leaderboard');
    if (leaderboardEl) {
        const visibleRankings = rankings.filter(e => !e.filtered);

        // Render quickly with the data we already have (no perf/dims yet)
        try {
            await renderCombinedBoard(leaderboardEl, visibleRankings);
        } catch (err) {
            console.warn('[leaderboard] initial render failed:', err);
            showSectionError(leaderboardEl, 'Could not render Model Leaderboard.');
        }

        // Onboarding: explain an empty/thin Trusted board instead of a silent table.
        renderTrustBanner(leaderboardEl, {
            trusted: _trustScope === 'trusted',
            visibleCount: visibleRankings.length,
            trustedFilters: generalistRes?.data?.trustedFilters || null
        });

        // Enrich with performance metrics and judge calibration, then re-render.
        // Category values already come from the exact filtered leaderboard
        // cohort; a broader quality-breakdown query must not overwrite them.
        (async () => {
            try {
                await enrichWithPerfData(visibleRankings);

                try {
                    const calRes = await fetch('/api/benchmark/judge/calibration-status').then(r => r.json());
                    const targetKey = (host, model) => `${String(host || '').trim().replace(/\/+$/, '').toLowerCase()}@@${String(model || '').trim().toLowerCase()}`;
                    const calibratedJudges = new Set(
                        (calRes.data?.matrices || []).map(m => targetKey(m.judge_host, m.judge_model))
                    );
                    for (const entry of visibleRankings) {
                        entry.judgeCalibrated = (entry.judgeTargets || [])
                            .some(target => calibratedJudges.has(targetKey(target.host, target.model)));
                    }
                } catch (_) {}

                await renderCombinedBoard(leaderboardEl, visibleRankings);
                // Re-bind collapse handlers for the re-rendered section header
                initSectionCollapse(leaderboardEl);
            } catch (err) {
                console.warn('[leaderboard] enrichment failed:', err);
            }
        })();
    }

    // --- Step 7: category map (categoryScores already on each entry) ---
    const categoryMapEl = main.querySelector('#category-map');
    if (categoryMapEl) {
        try {
            renderCategoryMap(categoryMapEl, rankings.filter(e => !e.filtered));
        } catch (err) {
            console.warn('[category-map] render failed:', err);
            showSectionError(categoryMapEl, 'Could not render category map.');
        }
    }

    // Host filtering now lives entirely in the #filter-bar Hosts selector
    // (single host narrowing is applied to rawRankings above), so the old
    // hero-pill `host-filter-change` listener has been removed.

    // --- Step 8: section collapse ---
    initSectionCollapse(main);

    // --- Step 9: export CSV button ---
    const exportBtn = document.getElementById('export-csv');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            try {
                const csv = buildCsvFromRankings(rankings);
                const date = new Date().toISOString().slice(0, 10);
                downloadCsv(csv, `leaderboard-${date}.csv`);
            } catch (err) {
                console.error('[export-csv] failed:', err);
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

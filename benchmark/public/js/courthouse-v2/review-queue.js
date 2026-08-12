// review-queue.js — compact clickable review queue for courthouse-v2
// Exports renderReviewQueue(container, results, onItemClick).

import { levelBadge } from '../components/level-badge.js';
import { getReadinessMap, getBadgeHtml } from '../model-profiler/components/readiness-cache.js';

// ─── Filter definitions ──────────────────────────────────────────────────────

const FILTERS = [
    { id: 'all',       label: 'All' },
    { id: 'anomaly',   label: 'Anomalies' },
    { id: 'low-conf',  label: 'Low Confidence' },
    { id: 'diverge',   label: 'Judge Divergence' },
    { id: 'high',      label: 'Unusually High' },
];

// ─── Flag classification helpers ─────────────────────────────────────────────

/**
 * Classify a result into a review flag type.
 * Returns one of: 'anomaly' | 'low-conf' | 'diverge' | 'high' | null
 */
function classifyFlag(r) {
    // Judge divergence: multi-judge disagreement flag
    if (r.judge_divergence || r.multi_judge_divergence) return 'diverge';

    // Low confidence: judge_confidence below threshold (0.6 is the common cutoff)
    const conf = r.judge_confidence ?? r.confidence;
    if (conf !== undefined && conf !== null && conf < 0.6) return 'low-conf';

    // Anomaly flag: explicit anomaly field or needs_review with review_reason containing anomaly/outlier
    if (r.is_anomaly || r.anomaly_flag) return 'anomaly';
    const reason = (r.review_reason || '').toLowerCase();
    if (reason.includes('anomaly') || reason.includes('outlier') || reason.includes('z-score')) {
        return 'anomaly';
    }

    // Unusually high: quality_score > 9.0 on a hard prompt (L4+)
    const score = r.quality_score ?? r.composite_score;
    if (score !== null && score !== undefined && score >= 9.0 && (r.prompt_level || 0) >= 4) {
        return 'high';
    }

    // Fallback for any needs_review with a review_reason
    if (r.needs_review) return 'anomaly';

    return null;
}

const FLAG_LABELS = {
    anomaly:  'Anomaly',
    'low-conf': 'Low Conf',
    diverge:  'Diverge',
    high:     'High Score',
};

function flagChip(type) {
    const label = FLAG_LABELS[type] || type;
    return `<span class="rq-flag ${type}">${label}</span>`;
}

// ─── Score coloring ───────────────────────────────────────────────────────────

function scoreClass(score) {
    if (score === null || score === undefined) return 's-f';
    if (score >= 8) return 's-h';
    if (score >= 5) return 's-m';
    return 's-l';
}

// ─── Determine which results need review ─────────────────────────────────────

/**
 * Filter the full results array down to those that warrant review.
 * Includes: needs_review === true, anomaly flags, low confidence, divergence, unusually high.
 */
function getReviewCandidates(results) {
    return results.filter(r => {
        if (r.needs_review) return true;
        if (r.is_anomaly || r.anomaly_flag || r.judge_divergence || r.multi_judge_divergence) return true;
        const conf = r.judge_confidence ?? r.confidence;
        if (conf !== undefined && conf !== null && conf < 0.6) return true;
        const score = r.quality_score ?? r.composite_score;
        if (score !== null && score !== undefined && score >= 9.0 && (r.prompt_level || 0) >= 4) return true;
        return false;
    });
}

// ─── Apply filter chip selection ─────────────────────────────────────────────

function applyFilter(candidates, filterId) {
    if (filterId === 'all') return candidates;
    return candidates.filter(r => classifyFlag(r) === filterId);
}

// ─── Single item row ─────────────────────────────────────────────────────────

function renderItem(r, readinessMap) {
    const level = r.prompt_level || 1;
    const flag = classifyFlag(r) || 'anomaly';
    const promptText = (r.prompt_name || r.prompt || '').slice(0, 90);
    const model = (r.model || '').replace(/:latest$/, '');
    const score = r.quality_score ?? r.composite_score;
    const scoreDisplay = score !== null && score !== undefined
        ? score.toFixed(1)
        : '—';
    const sc = scoreClass(score);
    const readinessBadge = readinessMap ? getBadgeHtml(model, readinessMap) : '';

    // Confidence
    const conf = r.judge_confidence ?? r.confidence;
    const confDisplay = conf !== null && conf !== undefined
        ? Math.round(conf * 100) + '%'
        : '—';
    const confClass = conf == null
        ? 'conf-none'
        : conf >= 0.8 ? 'conf-high'
        : conf >= 0.6 ? 'conf-mid'
        : conf >= 0.4 ? 'conf-low'
        : 'conf-crit';

    const promptTitle = (r.prompt_name || r.prompt || '').replace(/"/g, '&quot;');

    return `<div class="rq-item rq-flag-${flag}" data-id="${r._id}">
        ${levelBadge(level)}
        ${flagChip(flag)}
        <span class="rq-prompt" title="${promptTitle}">${promptText}</span>
        <span class="rq-model" title="${model}">${model}${readinessBadge}</span>
        <span class="rq-conf ${confClass}">${confDisplay}</span>
        <span class="rq-score ${sc}">${scoreDisplay}</span>
        <span class="rq-arrow">›</span>
    </div>`;
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function renderEmpty(filterId) {
    const msg = filterId === 'all'
        ? 'No results need review'
        : `No results match "${FILTERS.find(f => f.id === filterId)?.label || filterId}"`;
    return `<div style="padding:1.5rem;text-align:center;color:#444;font-size:0.7rem;">${msg}</div>`;
}

// ─── Public export ────────────────────────────────────────────────────────────

/**
 * Render the review queue section into container.
 *
 * @param {HTMLElement} container   - #review-queue element
 * @param {Array}       results     - array of BenchmarkResult objects
 * @param {Function}    onItemClick - called with the result object when an item is clicked
 */
export async function renderReviewQueue(container, results, onItemClick) {
    const candidates = getReviewCandidates(results);
    let activeFilter = 'all';
    const readinessMap = await getReadinessMap().catch(() => ({}));

    function buildHTML(filterId) {
        const filtered = applyFilter(candidates, filterId);
        const chips = FILTERS.map(f => {
            const count = f.id === 'all' ? candidates.length : applyFilter(candidates, f.id).length;
            const active = f.id === filterId ? ' active' : '';
            return `<button class="rq-chip${active}" data-filter="${f.id}">${f.label} <span style="opacity:0.6">(${count})</span></button>`;
        }).join('');

        const items = filtered.length > 0
            ? filtered.map(r => renderItem(r, readinessMap)).join('')
            : renderEmpty(filterId);

        return `
            <div class="r-sec-head">
                <span class="r-sec-icon">📋</span>
                <span class="r-sec-title">Review Queue</span>
                <span class="r-sec-count rq-count-badge">${candidates.length}</span>
                <span class="rq-filtered-count${filtered.length === candidates.length ? ' hidden' : ''}">showing ${filtered.length}</span>
            </div>
            <div class="rq-filters">${chips}</div>
            <div class="rq-table">
                <div class="rq-header">
                    <span class="rqh-lvl">Lvl</span>
                    <span class="rqh-flag">Type</span>
                    <span class="rqh-prompt">Prompt</span>
                    <span class="rqh-model">Model</span>
                    <span class="rqh-conf">Conf</span>
                    <span class="rqh-score">Score</span>
                    <span class="rqh-arrow"></span>
                </div>
                <div class="rq-list">${items}</div>
            </div>`;
    }

    container.innerHTML = buildHTML(activeFilter);

    // Event delegation: filter chips + item clicks
    container.addEventListener('click', e => {
        const chip = e.target.closest('[data-filter]');
        if (chip) {
            activeFilter = chip.dataset.filter;
            container.innerHTML = buildHTML(activeFilter);
            // Re-attach (event delegation means no rebinding needed — same container)
            return;
        }

        const item = e.target.closest('.rq-item');
        if (item && typeof onItemClick === 'function') {
            const id = item.dataset.id;
            const result = candidates.find(r => String(r._id) === id);
            if (result) {
                // Mark item active
                container.querySelectorAll('.rq-item').forEach(el => el.classList.remove('is-active'));
                item.classList.add('is-active');
                onItemClick(result);
            }
        }
    });
}

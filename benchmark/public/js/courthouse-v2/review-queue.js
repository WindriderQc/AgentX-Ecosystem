// review-queue.js — compact clickable review queue for courthouse-v2
// Exports renderReviewQueue(container, results, onItemClick).

import { levelBadge } from '../components/level-badge.js';
import { getReadinessMap, getBadgeHtml } from '../model-profiler/components/readiness-cache.js';
import { evidenceBadge } from './evidence-provenance.js';
import { escHtml } from '../utils/format.js';

// ─── Filter definitions ──────────────────────────────────────────────────────

const FILTERS = [
    { id: 'all',       label: 'All' },
    { id: 'low-conf',  label: 'Low Confidence' },
    { id: 'diverge',   label: 'Divergence Flags' },
    { id: 'high',      label: 'L4–L5 Score ≥9' },
    { id: 'other',     label: 'Other Review' },
];

// ─── Flag classification helpers ─────────────────────────────────────────────

/**
 * Return every review signal carried by a result. Signals are deliberately
 * non-exclusive: one row may be both low-confidence and divergent.
 */
function classifyFlags(r) {
    const flags = [];

    // Authoritative server-side verdict based on the multi-judge threshold.
    if (r.judge_divergent === true) flags.push('diverge');

    // Low confidence: judge_confidence below threshold (0.6 is the common cutoff)
    const conf = r.judge_confidence ?? r.confidence;
    if (conf !== undefined && conf !== null && conf < 0.6) flags.push('low-conf');

    // Unusually high: quality_score > 9.0 on a hard prompt (L4+)
    const score = r.quality_score ?? r.composite_score;
    if (score !== null && score !== undefined && score >= 9.0 && (r.prompt_level || 0) >= 4) {
        flags.push('high');
    }

    if (flags.length === 0 && r.needs_review) flags.push('other');

    return flags;
}

const FLAG_LABELS = {
    'low-conf': 'Low Conf',
    diverge:  'Diverge',
    high:     'High Score',
    other:    'Review',
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
        return classifyFlags(r).some(flag => flag !== 'other');
    });
}

// ─── Apply filter chip selection ─────────────────────────────────────────────

function applyFilter(candidates, filterId) {
    if (filterId === 'all') return candidates;
    return candidates.filter(r => classifyFlags(r).includes(filterId));
}

function hasSignalCoverage(candidates, filterId) {
    if (filterId === 'all' || filterId === 'other') return true;
    if (candidates.length === 0) return true;
    const has = (row, key) => Object.prototype.hasOwnProperty.call(row, key);
    if (filterId === 'diverge') return candidates.every(row => typeof row.judge_divergent === 'boolean');
    if (filterId === 'low-conf') return candidates.every(row => has(row, 'judge_confidence') || has(row, 'confidence'));
    if (filterId === 'high') {
        return candidates.every(row =>
            (has(row, 'quality_score') || has(row, 'composite_score')) && has(row, 'prompt_level')
        );
    }
    return false;
}

// ─── Single item row ─────────────────────────────────────────────────────────

function renderItem(r, readinessMap, activeFilter = 'all') {
    const id = String(r._id || r.id || '');
    const level = r.prompt_level || 1;
    const flags = classifyFlags(r);
    const flag = activeFilter !== 'all' && flags.includes(activeFilter)
        ? activeFilter
        : (flags[0] || 'other');
    const rawPrompt = r.prompt_name || r.prompt || '';
    const promptText = rawPrompt.slice(0, 90);
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

    const accessibleLabel = [
        `Open review details for ${promptText || 'unnamed prompt'}`,
        model ? `model ${model}` : '',
        flags.length ? `signals ${flags.map(item => FLAG_LABELS[item] || item).join(', ')}` : '',
        `confidence ${confDisplay}`,
        `score ${scoreDisplay}`
    ].filter(Boolean).join(', ');

    return `<button type="button" class="rq-item rq-flag-${flag}" data-id="${escHtml(id)}" aria-expanded="false" aria-controls="courthouse-detail-panel" aria-label="${escHtml(accessibleLabel)}">
        ${levelBadge(level)}
        ${flagChip(flag)}
        <span class="rq-prompt" title="${escHtml(rawPrompt)}">${escHtml(promptText)}</span>
        <span class="rq-model" title="${escHtml(model)}">${escHtml(model)}${readinessBadge}${evidenceBadge(r, { compact: true })}</span>
        <span class="rq-conf ${confClass}">${confDisplay}</span>
        <span class="rq-score ${sc}">${scoreDisplay}</span>
        <span class="rq-arrow" aria-hidden="true">›</span>
    </button>`;
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function renderEmpty(filterId) {
    const msg = filterId === 'all'
        ? 'No results need review'
        : `No results match "${FILTERS.find(f => f.id === filterId)?.label || filterId}"`;
    return `<div class="ch-muted-state">${msg}</div>`;
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
            const covered = hasSignalCoverage(candidates, f.id);
            const count = covered
                ? (f.id === 'all' ? candidates.length : applyFilter(candidates, f.id).length)
                : '—';
            const active = f.id === filterId ? ' active' : '';
            const unavailable = covered ? '' : ' disabled aria-disabled="true" title="Signal unavailable in the returned evidence"';
            return `<button type="button" class="rq-chip${active}" data-filter="${f.id}"${unavailable}>${f.label} <span class="rq-chip-count">(${count})</span></button>`;
        }).join('');

        const items = filtered.length > 0
            ? filtered.map(r => renderItem(r, readinessMap, filterId)).join('')
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
            const result = candidates.find(r => String(r._id || r.id || '') === id);
            if (result) {
                document.querySelectorAll('.rq-item').forEach(el => {
                    el.classList.remove('is-active');
                    el.setAttribute('aria-expanded', 'false');
                });
                document.querySelectorAll('.ledger-row').forEach(el => el.classList.remove('is-active'));
                document.querySelectorAll('.ledger-open').forEach(el => el.setAttribute('aria-expanded', 'false'));
                item.classList.add('is-active');
                item.setAttribute('aria-expanded', 'true');
                onItemClick(result);
            }
        }
    });
}

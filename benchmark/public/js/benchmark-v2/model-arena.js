// model-arena.js — Model Arena / Live Rankings (section 2.8)
// One row per model sorted by running score (highest at top).
// Exported API: renderModelArena(container, batch), updateModelArena(container, batch)

import { scoreColor }  from '../components/score-color.js';
import { miniBars }    from '../components/mini-bars.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isExcluded(result) {
    return result?.excluded_from_leaderboard === true
        || result?.truncation?.truncation_invalidates_score === true
        || result?.truncation?.hidden_response_cap === true;
}

function resultBadges(result) {
    const badges = [];
    if (result?.truncation?.hidden_response_cap) {
        badges.push({ cls: 'se-badge-invalid', text: 'hidden cap' });
    } else if (result?.truncation?.response_truncated) {
        badges.push({ cls: 'se-badge-trunc', text: 'truncated' });
    }
    if (result?.truncation?.input_truncated) badges.push({ cls: 'se-badge-invalid', text: 'input clipped' });
    if (result?.excluded_from_leaderboard) badges.push({ cls: 'se-badge-invalid', text: 'excluded' });
    if (result?.needs_review) badges.push({ cls: 'se-badge-review', text: 'review' });
    return badges;
}

/**
 * Compute per-model aggregate data from batch.results.
 * Returns a map: modelKey → { model, score, results, categoryScores, toksPerSec,
 *                              done, total, dimensions }
 */
function aggregateModels(batch) {
    // Sort results by timestamp ascending so timeline bars render oldest→newest (L1→L5)
    const results  = (batch.results || []).slice().sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
    });
    const models   = batch.models  || [];
    const modelCount = models.length || 1;
    const total = batch.total_prompts_per_model || batch.prompts_per_model
        || (batch.total_tests ? Math.ceil(batch.total_tests / modelCount) : 0);

    // Build model entries seeded from batch.models list
    const map = new Map();
    for (const m of models) {
        const key = typeof m === 'string' ? m : (m.model || m.name || String(m));
        map.set(key, {
            model:          key,
            score:          0,
            scoreSum:       0,
            scoreCount:     0,
            results:        [],
            categoryScores: {},
            catSums:        {},
            catCounts:      {},
            toksPerSec:     0,
            tpsSum:         0,
            tpsCount:       0,
            done:           0,    // generated count (any non-empty result)
            scored:         0,    // judged count (quality_score != null)
            total:          total,
            dimensions:     {},   // dim → { yes, total }
        });
    }

    for (const r of results) {
        const key = r.model;
        if (!key) continue;
        if (!map.has(key)) {
            map.set(key, {
                model: key, score: 0, scoreSum: 0, scoreCount: 0,
                results: [], categoryScores: {}, catSums: {}, catCounts: {},
                toksPerSec: 0, tpsSum: 0, tpsCount: 0, done: 0, scored: 0, total,
                dimensions: {},
            });
        }
        const entry = map.get(key);
        entry.results.push(r);

        // Count any persisted result toward generation progress (whether judged or not).
        // A result lands in the DB only after its generation completed (success or fail).
        entry.done += 1;

        const validForScore = !isExcluded(r);

        if (r.quality_score != null) {
            entry.scored += 1;
        }

        if (r.quality_score != null && validForScore) {
            entry.scoreSum   += Number(r.quality_score);
            entry.scoreCount += 1;
        }

        if (r.tokens_per_sec != null) {
            entry.tpsSum   += Number(r.tokens_per_sec);
            entry.tpsCount += 1;
        }

        // Category rollup
        const cat = r.prompt_category;
        if (cat && r.quality_score != null && validForScore) {
            entry.catSums[cat]   = (entry.catSums[cat]   || 0) + Number(r.quality_score);
            entry.catCounts[cat] = (entry.catCounts[cat] || 0) + 1;
        }

        // Dimension verdict rollup
        const bd = r.judge_breakdown || r.quality_breakdown;
        if (bd && typeof bd === 'object' && validForScore) {
            for (const [dim, verdict] of Object.entries(bd)) {
                if (!entry.dimensions[dim]) entry.dimensions[dim] = { yes: 0, total: 0 };
                entry.dimensions[dim].total += 1;
                if (verdict) entry.dimensions[dim].yes += 1;
            }
        }
    }

    // Finalise averages
    for (const entry of map.values()) {
        entry.score = entry.scoreCount > 0
            ? entry.scoreSum / entry.scoreCount
            : 0;
        entry.toksPerSec = entry.tpsCount > 0
            ? entry.tpsSum / entry.tpsCount
            : 0;
        for (const cat of Object.keys(entry.catSums)) {
            entry.categoryScores[cat] = entry.catSums[cat] / (entry.catCounts[cat] || 1);
        }
    }

    // Stamp early-stop info from batch.model_timings onto matching entries.
    const timings = Array.isArray(batch.model_timings) ? batch.model_timings : [];
    for (const t of timings) {
        if (!t?.early_stopped) continue;
        const entry = map.get(t.model);
        if (!entry) continue;
        entry.earlyStopped = true;
        entry.earlyStopReason = t.early_stop_reason || null;
        entry.earlyStopAvgScore = t.early_stop_avg_score ?? null;
        entry.earlyStopJudgedCount = t.early_stop_judged_count ?? null;
    }

    return map;
}

/**
 * Determine latency scale across all results for proportional segment widths.
 * Returns max latency in ms (or 1 to avoid division by zero).
 */
function maxLatency(results) {
    let mx = 0;
    for (const r of results) {
        if (r.latency != null && Number(r.latency) > mx) mx = Number(r.latency);
    }
    return mx || 1;
}

/**
 * Map segment width proportionally.
 * min 4px, max 40px, scale relative to slowest result.
 */
function segWidth(latency, maxLat) {
    const MIN = 4, MAX = 40;
    if (!latency) return MIN;
    const pct = Math.min(Number(latency) / maxLat, 1);
    return Math.round(MIN + pct * (MAX - MIN));
}

/**
 * Build CSS classes for a timeline segment.
 * level 1–5 → sl1–sl5; special states: sg-gen, sg-jdg, sg-err, sg-w
 */
function segClasses(result) {
    const stage = result.stage || result.status || '';
    const levelCls = 'sl' + (result.prompt_level || 1);
    if (isExcluded(result)) return `seg ${levelCls} sg-excluded`;
    if (stage === 'warmup')   return 'seg sg-w';
    if (stage === 'error' || (result.error && !result.success))   return `seg ${levelCls} sg-err`;
    if (stage === 'executing') return `seg ${levelCls} sg-gen`;
    if (stage === 'judging')   return `seg ${levelCls} sg-jdg`;
    // Results with pending scoring method are being judged
    if (result.scoring_method === 'pending') return `seg ${levelCls} sg-jdg`;
    // Completed results: mark judged vs unjudged
    const judged = result.quality_score != null && result.scoring_method && result.scoring_method !== 'pending';
    return `seg ${levelCls}${judged ? ' sg-scored' : ' sg-unscored'}`;
}

/**
 * Build hover tooltip HTML (compact) for a segment.
 */
function segTooltip(result) {
    const name  = esc(result.prompt_name || result.prompt || result.prompt_id || '');
    const score = result.quality_score != null ? Number(result.quality_score).toFixed(1) : '—';
    const lat   = result.latency != null ? Number(result.latency).toFixed(0) + 'ms' : '—';
    const stage = esc(result.stage || result.status || '');
    const badges = resultBadges(result);
    return `<div class="seg-tip">
      <div class="th">${name}</div>
      <div class="tr"><span class="td">score</span><span class="tv">${score}</span></div>
      <div class="tr"><span class="td">latency</span><span class="tv">${lat}</span></div>
      ${stage ? `<div class="tr"><span class="td">stage</span><span class="tv">${stage}</span></div>` : ''}
      ${badges.length ? `<div class="tr"><span class="td">flags</span><span class="tv">${badges.map(b => esc(b.text)).join(', ')}</span></div>` : ''}
    </div>`;
}

/**
 * Build expanded tooltip HTML (click) with full details + courthouse button.
 */
function segExpandedTooltip(result) {
    const name     = esc(result.prompt_name || result.prompt || result.prompt_id || '');
    const model    = esc(result.model || '');
    const category = esc(result.prompt_category || '');
    const level    = result.prompt_level || '—';
    const score    = result.quality_score != null ? Number(result.quality_score).toFixed(1) : '—';
    const lat      = result.latency != null ? Number(result.latency).toFixed(0) + 'ms' : '—';
    const tps      = result.tokens_per_sec != null ? Number(result.tokens_per_sec).toFixed(1) + ' tok/s' : '—';
    const tokens   = result.tokens != null ? String(result.tokens) : '—';
    const method   = esc(result.scoring_method || '');
    const resultId = result._id || result.id || '';
    const badges = resultBadges(result);
    const contract = result.execution_settings || {};
    const contractParts = [];
    if (contract.answer_contract_applied) {
        if (contract.answer_contract_target_tokens != null) contractParts.push(`target ${contract.answer_contract_target_tokens}`);
        if (contract.answer_contract_max_tokens != null) contractParts.push(`max ${contract.answer_contract_max_tokens}`);
    }
    const limit = result.truncation?.response_limit ?? contract.num_predict;

    // Score color
    const sv = result.quality_score;
    const scoreColor = sv != null
        ? (sv >= 8 ? 'var(--r-good)' : sv >= 5 ? '#eab308' : '#f97316')
        : '#666';

    return `<div class="seg-expanded" data-result-id="${esc(resultId)}">
      <div class="se-header">
        <span class="se-name">${name}</span>
        <span class="se-score" style="color:${scoreColor}">${score}<span class="se-max">/10</span></span>
      </div>
      <div class="se-model">${model}</div>
      ${badges.length ? `<div class="se-badges">${badges.map(b => `<span class="se-badge ${b.cls}">${esc(b.text)}</span>`).join('')}</div>` : ''}
      <div class="se-grid">
        <div class="se-row"><span class="se-label">category</span><span class="se-val">${category || '—'}</span></div>
        <div class="se-row"><span class="se-label">level</span><span class="se-val">${level}</span></div>
        <div class="se-row"><span class="se-label">latency</span><span class="se-val">${lat}</span></div>
        <div class="se-row"><span class="se-label">tokens/s</span><span class="se-val">${tps}</span></div>
        <div class="se-row"><span class="se-label">tokens</span><span class="se-val">${tokens}</span></div>
        ${limit != null ? `<div class="se-row"><span class="se-label">runtime cap</span><span class="se-val">${esc(limit)}</span></div>` : ''}
        ${contractParts.length ? `<div class="se-row"><span class="se-label">answer contract</span><span class="se-val">${esc(contractParts.join(', '))}</span></div>` : ''}
        ${method ? `<div class="se-row"><span class="se-label">method</span><span class="se-val">${method}</span></div>` : ''}
      </div>
      ${result.review_reason ? `<div class="se-note">${esc(result.review_reason)}</div>` : ''}
      ${resultId ? `<a class="se-courthouse-btn" href="/courthouse?result=${esc(resultId)}" title="Review in Courthouse">⚖️ Review in Courthouse</a>` : ''}
    </div>`;
}

/**
 * Build the timeline track HTML for one model.
 * Includes in-progress segment for the currently generating test if applicable.
 */
function timelineHTML(entry, currentTest, maxLat) {
    const segs = [];

    // Completed/in-flight segments from results
    for (const r of entry.results) {
        const w   = segWidth(r.latency, maxLat);
        const cls = segClasses(r);
        const tip = segTooltip(r);
        const rid = r._id || r.id || '';
        segs.push(`<div class="${cls}" style="width:${w}px;" data-result-id="${esc(rid)}" title="${esc(r.prompt_name || r.prompt_id || '')}">${tip}</div>`);
    }

    // Active segment for a real in-flight test only. The backend keeps the last
    // responded test in current_test while it warms/baselines the next model;
    // rendering that as active creates a phantom extra bar on model switches.
    const activeStages = new Set(['executing', 'judging']);
    if (currentTest && currentTest.model === entry.model && activeStages.has(currentTest.stage)) {
        const stage = currentTest.stage || 'executing';
        const cls   = stage === 'judging'
            ? `seg sl${currentTest.prompt_level || 1} sg-jdg`
            : `seg sl${currentTest.prompt_level || 1} sg-gen`;
        const tip = segTooltip({
            prompt_name: currentTest.prompt_name || '',
            quality_score: null,
            latency: null,
            stage,
        });
        segs.push(`<div class="${cls}" style="width:12px;" title="${esc(currentTest.prompt_name || '')}">${tip}</div>`);
    }

    if (segs.length === 0) {
        return `<div class="tl-track" data-model="${esc(entry.model)}">
          <span style="color:var(--r-text-dim);font-size:0.6rem;padding:0 0.25rem;">no results yet</span>
        </div>`;
    }

    return `<div class="tl-track" data-model="${esc(entry.model)}">${segs.join('')}</div>`;
}

/**
 * Build scorecard column HTML.
 */
function scorecardHTML(entry) {
    const score = entry.score;
    const cls   = score >= 8 ? 'vh' : score >= 6 ? 'vm' : 'vl';
    const color = scoreColor(score);

    // 4 most-scored categories
    const catEntries = Object.entries(entry.categoryScores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);

    const catBars = catEntries.map(([cat, val]) => {
        const pct   = Math.min((val / 10) * 100, 100).toFixed(1);
        const clr   = scoreColor(val);
        const abbr  = cat.slice(0, 3).toUpperCase();
        return `<div class="cb-i">
          <span class="cl">${abbr}</span>
          <div class="ct"><div class="cf" style="width:${pct}%;background:${clr};"></div></div>
        </div>`;
    }).join('');

    // Top dimension verdicts (up to 4)
    const dimChips = Object.entries(entry.dimensions)
        .sort((a, b) => (b[1].yes / (b[1].total || 1)) - (a[1].yes / (a[1].total || 1)))
        .slice(0, 4)
        .map(([dim, d]) => {
            const rate = d.yes / (d.total || 1);
            const cls2 = rate >= 0.5 ? 'dy' : 'dn';
            return `<span class="dc ${cls2}">${esc(dim.slice(0, 4))}</span>`;
        })
        .join('');

    return `
      <div class="sc">
        <div class="sc-main">
          <span class="sc-v ${cls}" style="color:${color};">${score > 0 ? score.toFixed(1) : '—'}</span>
          <span class="sc-x">/10</span>
        </div>
        ${catBars ? `<div class="cb">${catBars}</div>` : ''}
        ${dimChips ? `<div class="dr">${dimChips}</div>` : ''}
      </div>`;
}

/**
 * Build left label column HTML.
 * Progress only shown for in-progress models; completed models show tok/s only.
 */
function labelHTML(entry, isLeader, isActive, currentTest = null) {
    const isDone = entry.total > 0 && entry.done >= entry.total;
    const tps    = entry.toksPerSec > 0 ? entry.toksPerSec.toFixed(0) + ' t/s' : '';
    const invalid = entry.results.filter(isExcluded).length;
    const activeStages = new Set(['executing', 'judging']);
    const activeInFlight = currentTest
        && currentTest.model === entry.model
        && activeStages.has(currentTest.stage);
    const trendBadge = isLeader
        ? `<span class="md up">▲</span>`
        : '';

    // Show progress only for active or in-progress models.
    // `done` = generated, `scored` = judged. When they diverge (judging lagging
    // generation, or deferred judge phase), show both so the UI doesn't appear stuck.
    let progressHTML = '';
    if (!isDone || isActive) {
        const total = entry.total || '?';
        if (entry.scored < entry.done || activeInFlight) {
            const activeText = activeInFlight ? ` · ${currentTest.stage}` : '';
            progressHTML = `<span class="ms-t" title="${entry.done} generated, ${entry.scored} scored${activeText}">`
                + `${entry.done}/${total}<span class="ms-scored"> · ${entry.scored} scored</span>`
                + `${activeInFlight ? `<span class="ms-scored">${activeText}</span>` : ''}`
                + '</span>';
        } else {
            progressHTML = `<span class="ms-t">${entry.done}/${total}</span>`;
        }
    }

    const esBadge = entry.earlyStopped
        ? `<span class="es-badge" title="Early-stopped: ${esc(entry.earlyStopReason || 'quality below threshold')}">⏹ stopped</span>`
        : '';

    return `
      <div class="ml">
        <div class="mn-row">
          <span class="mn">${esc(entry.model)}</span>
          ${trendBadge}
          ${esBadge}
        </div>
        <div class="msub">
          ${progressHTML}
          ${tps ? `<span>${tps}</span>` : ''}
          ${invalid ? `<span class="ms-invalid" title="${invalid} excluded from leaderboard">${invalid} invalid</span>` : ''}
        </div>
      </div>`;
}

/**
 * Build one model row HTML.
 */
function modelRowHTML(entry, isLeader, isActive, currentTest, maxLat) {
    const rowClasses = ['model-row',
        isLeader ? 'leader'      : '',
        isActive ? 'active-test' : '',
        entry.earlyStopped ? 'early-stopped' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${rowClasses}" data-model="${esc(entry.model)}">
        ${labelHTML(entry, isLeader, isActive, currentTest)}
        ${timelineHTML(entry, currentTest, maxLat)}
        ${scorecardHTML(entry)}
      </div>`;
}

/**
 * Rebuild the arena rows HTML from batch data.
 */
function buildArenaHTML(batch) {
    const modelMap  = aggregateModels(batch);
    const ct        = batch.current_test || null;
    const allResults = batch.results || [];
    const mxLat     = maxLatency(allResults);

    // Sort by score descending
    const sorted = [...modelMap.values()].sort((a, b) => b.score - a.score);
    if (sorted.length === 0) {
        return '<div style="color:var(--r-text-dim);font-size:0.72rem;padding:0.5rem;">No models yet.</div>';
    }

    const hasScoredLeader = sorted.some(entry => entry.scored > 0 && entry.score > 0);

    return sorted.map((entry, i) => {
        const isLeader = hasScoredLeader && i === 0;
        const isActive = ct != null && ct.model === entry.model;
        return modelRowHTML(entry, isLeader, isActive, ct, mxLat);
    }).join('');
}

// ── Hover tooltip (fixed-position, escapes overflow clipping) ────────────────

let _hoverTipEl = null;

function showHoverTip(seg) {
    const tip = seg.querySelector('.seg-tip');
    if (!tip) return;
    dismissHoverTip();
    const clone = tip.cloneNode(true);
    clone.classList.add('seg-tip-fixed');
    document.body.appendChild(clone);
    _hoverTipEl = clone;

    const rect = seg.getBoundingClientRect();
    clone.style.left = `${rect.left + rect.width / 2}px`;
    clone.style.top = `${rect.top - 8}px`;
}

function dismissHoverTip() {
    if (_hoverTipEl) {
        _hoverTipEl.remove();
        _hoverTipEl = null;
    }
}

function initHoverHandlers(container) {
    container.addEventListener('mouseenter', (e) => {
        const seg = e.target.closest('.seg');
        if (seg) showHoverTip(seg);
    }, true);

    container.addEventListener('mouseleave', (e) => {
        const seg = e.target.closest('.seg');
        if (seg) dismissHoverTip();
    }, true);
}

// ── Expanded tooltip (click) ─────────────────────────────────────────────────

let _resultMap = new Map();    // result._id → result object
let _expandedEl = null;        // currently open expanded tooltip

function buildResultMap(batch) {
    _resultMap.clear();
    for (const r of (batch.results || [])) {
        const rid = r._id || r.id;
        if (rid) _resultMap.set(String(rid), r);
    }
}

function dismissExpanded() {
    if (_expandedEl) {
        _expandedEl.remove();
        _expandedEl = null;
    }
}

function showExpanded(seg, result) {
    dismissExpanded();
    dismissHoverTip();
    const html = segExpandedTooltip(result);
    const el = document.createElement('div');
    el.innerHTML = html;
    _expandedEl = el.firstElementChild;

    // Position above the segment
    document.body.appendChild(_expandedEl);
    const rect = seg.getBoundingClientRect();
    _expandedEl.style.position = 'fixed';
    _expandedEl.style.left = `${rect.left + rect.width / 2}px`;
    _expandedEl.style.top = `${rect.top - 8}px`;
    _expandedEl.style.transform = 'translate(-50%, -100%)';
    _expandedEl.style.zIndex = '300';
}

function initClickHandler(container) {
    container.addEventListener('click', (e) => {
        const seg = e.target.closest('.seg[data-result-id]');
        if (!seg) {
            dismissExpanded();
            return;
        }

        const rid = seg.dataset.resultId;
        if (!rid) return;

        const result = _resultMap.get(rid);
        if (!result) return;

        e.stopPropagation();
        showExpanded(seg, result);
    });
}

// Dismiss on outside click
document.addEventListener('click', (e) => {
    if (_expandedEl && !_expandedEl.contains(e.target)) {
        dismissExpanded();
    }
});

let _clickHandlerBound = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initial render of the model arena.
 * @param {HTMLElement} container — the #arena-rows div
 * @param {object}      batch     — batch status object from API
 */
export function renderModelArena(container, batch) {
    buildResultMap(batch);
    container.innerHTML = buildArenaHTML(batch);
    if (!_clickHandlerBound) {
        initClickHandler(container);
        initHoverHandlers(container);
        _clickHandlerBound = true;
    }

    // Update arena count badge if present in parent
    const countEl = document.getElementById('arena-count');
    if (countEl) {
        const n = (batch.models || []).length;
        countEl.textContent = n > 0 ? `${n} model${n !== 1 ? 's' : ''}` : '';
    }
}

/**
 * Incremental update — rebuilds arena rows in place.
 * Uses data-model attributes to update existing rows instead of full innerHTML
 * replacement when possible, preserving scroll position of timeline tracks.
 * Falls back to full rebuild when model list changes.
 * @param {HTMLElement} container
 * @param {object}      batch
 */
export function updateModelArena(container, batch) {
    buildResultMap(batch);
    const modelMap  = aggregateModels(batch);
    const ct        = batch.current_test || null;
    const allResults = batch.results || [];
    const mxLat     = maxLatency(allResults);
    const sorted    = [...modelMap.values()].sort((a, b) => b.score - a.score);

    if (sorted.length === 0) {
        container.innerHTML = '<div style="color:var(--r-text-dim);font-size:0.72rem;padding:0.5rem;">No models yet.</div>';
        return;
    }

    // Check if row set matches existing DOM (same order + same models)
    const existing = [...container.querySelectorAll('.model-row[data-model]')];
    const sameOrder = existing.length === sorted.length &&
        existing.every((el, i) => el.dataset.model === sorted[i].model);

    if (!sameOrder) {
        // Full rebuild
        renderModelArena(container, batch);
        return;
    }

    // Incremental: update each row in place
    existing.forEach((row, i) => {
        const entry    = sorted[i];
        const isLeader = i === 0;
        const isActive = ct != null && ct.model === entry.model;

        // Update row classes
        row.className = ['model-row',
            isLeader ? 'leader'      : '',
            isActive ? 'active-test' : '',
        ].filter(Boolean).join(' ');

        // Update label column
        const ml = row.querySelector('.ml');
        if (ml) ml.outerHTML = labelHTML(entry, isLeader, isActive, ct);

        // Update timeline track (preserve scroll x if possible)
        const track = row.querySelector('.tl-track');
        const scrollLeft = track ? track.scrollLeft : 0;
        const newTrackHTML = timelineHTML(entry, ct, mxLat);
        const tmp = document.createElement('div');
        tmp.innerHTML = newTrackHTML;
        const newTrack = tmp.firstElementChild;
        if (track && newTrack) {
            row.replaceChild(newTrack, track);
            newTrack.scrollLeft = scrollLeft;
        }

        // Update scorecard
        const sc = row.querySelector('.sc');
        if (sc) {
            const tmp2 = document.createElement('div');
            tmp2.innerHTML = scorecardHTML(entry);
            const newSc = tmp2.firstElementChild;
            if (newSc) row.replaceChild(newSc, sc);
        }
    });

    // Update count badge
    const countEl = document.getElementById('arena-count');
    if (countEl) {
        const n = sorted.length;
        countEl.textContent = n > 0 ? `${n} model${n !== 1 ? 's' : ''}` : '';
    }
}
